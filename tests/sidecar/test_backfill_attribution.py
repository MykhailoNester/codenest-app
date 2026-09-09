"""Tests for `session_backfill_service` and `POST /agents/sessions/backfill-attribution`
(epic #153 / #158).

Attribution is written once, at hook time, under
`project_id=COALESCE(project_id, ?)`, so nothing ever revisits a row that was
`NULL` when it was first recorded. The backfill is the second look, and these
tests pin the five ways it could be worse than no backfill at all:

  * **It could guess.** `match_project` is a path-prefix test, so a session
    recorded in a directory that has since been deleted would be attributed to
    whichever surviving ancestor a project happens to own — a confident,
    unverifiable answer about a directory nobody can inspect. The
    `missing_cwd` fixture is deliberately a path *under* an imported project's
    repo for exactly that reason: string matching would attribute it, and the
    pass must not.
  * **It could write during a dry run.** `?dry_run=1` is what the human runs
    against the live 128-session database before letting it write, so the
    assertion here is row-level equality of every `agent_sessions` row (and of
    `projects`, since resolution can mint one) before and after — not merely
    that the counts agreed.
  * **It could not be re-runnable.** A second real pass must find nothing:
    `attributed=0`, `created_projects=0`, and every row byte-identical, which
    is what makes the endpoint safe to leave in the product.
  * **It could re-file work a human filed.** An already-set `project_id` is
    only moved under an explicit `?force=1`, and even then never cleared.
  * **It could stop half-way and leave the wreckage on the connection.** The
    sidecar shares one SQLite connection across every request, so a pass that
    raised part-way through would hand its applied UPDATEs — and any project
    row the resolver had just discovered — to the next hook's `commit()`. A
    failure has to roll back and re-raise, and the one path most likely to
    raise is the cwd column itself, which holds whatever string a hook
    recorded months ago.

The world every test builds is the four directory kinds the ticket names: a
root-with-repos (an enabled `project_roots` row whose repos have no projects
yet, so resolution *creates* them), a plain repo already imported as a
project, a temp directory that classifies as ephemeral, and a directory that
no longer exists on disk.
"""

from __future__ import annotations

import os
import pathlib
from dataclasses import dataclass

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import agents as agents_router
from app.services import cwd_resolver_service, session_backfill_service

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _real(path: pathlib.Path | str) -> str:
    return os.path.realpath(str(path)).rstrip("/")


def _mk_repo(path: pathlib.Path, head: str = "ref: refs/heads/main\n") -> pathlib.Path:
    """Create `path` as a git repo: a `.git/` directory holding `head`."""
    path.mkdir(parents=True, exist_ok=True)
    git_dir = path / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text(head, encoding="utf-8")
    return path


async def _insert_project(db: aiosqlite.Connection, name: str, root_path: str) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace, is_active) "
        "VALUES (?, 'active', ?, ?, 0, 1)",
        (name, root_path, root_path),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return int(cur.lastrowid)


async def _add_root(db: aiosqlite.Connection, path: str) -> None:
    await db.execute(
        "INSERT INTO project_roots (path, label, source, enabled) "
        "VALUES (?, NULL, 'manual', 1)",
        (path,),
    )
    await db.commit()


async def _insert_session(
    db: aiosqlite.Connection,
    session_id: str,
    cwd: str | None,
    *,
    project_id: int | None = None,
    git_branch: str | None = None,
    session_kind: str = "project",
) -> None:
    await db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, profile, cwd, status, project_id, git_branch, session_kind) "
        "VALUES (?, 'work', ?, 'ended', ?, ?, ?)",
        (session_id, cwd, project_id, git_branch, session_kind),
    )
    await db.commit()


async def _session_rows(db: aiosqlite.Connection) -> list[tuple]:
    """Every session row as plain tuples — the byte-identical comparison."""
    async with db.execute("SELECT * FROM agent_sessions ORDER BY session_id") as cur:
        return [tuple(row) for row in await cur.fetchall()]


async def _project_rows(db: aiosqlite.Connection) -> list[tuple]:
    async with db.execute("SELECT * FROM projects ORDER BY id") as cur:
        return [tuple(row) for row in await cur.fetchall()]


async def _session(db: aiosqlite.Connection, session_id: str) -> aiosqlite.Row:
    async with db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    return row


# ─── The world ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _World:
    """The four directory kinds, plus the ids the seed created."""

    acme_project_id: int
    beta_project_id: int
    plain_cwd: str
    beta_cwd: str
    root_repo_cwd: str
    root_repo_sibling_cwd: str
    scratch_cwd: str
    missing_cwd: str


@pytest_asyncio.fixture
async def world(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
    monkeypatch: pytest.MonkeyPatch,
) -> _World:
    """Seed the four directory kinds and one session for each.

    The scratch directory is made ephemeral by *extending* the root set
    `conftest._pytest_tmp_is_not_ephemeral` narrowed rather than restoring the
    genuine one: every other fixture here also lives under pytest's
    `$TMPDIR`-rooted temp tree, and restoring the real classifier would make
    the whole world read as throwaway. Extending it gives exactly one
    directory that is ephemeral and leaves the repos as project work.
    """
    scratch = tmp_path / "scratch"
    (scratch / "run-1").mkdir(parents=True)
    narrowed = cwd_resolver_service._ephemeral_roots()
    monkeypatch.setattr(
        cwd_resolver_service,
        "_ephemeral_roots",
        lambda: (*narrowed, _real(scratch)),
    )

    # A plain repo, already imported as a project, with a session sitting deep
    # inside it.
    acme = _mk_repo(tmp_path / "plain" / "acme")
    (acme / "src" / "http").mkdir(parents=True)
    acme_id = await _insert_project(migrated_db, "acme", _real(acme))

    # A second imported project, only ever reached by the `force` tests.
    beta = _mk_repo(tmp_path / "plain" / "beta", head="ref: refs/heads/release\n")
    beta_id = await _insert_project(migrated_db, "beta", _real(beta))

    # A root holding repos no project claims yet: resolution creates them.
    roots = tmp_path / "roots"
    orders = _mk_repo(roots / "orders", head="ref: refs/heads/feat/orders\n")
    (orders / "api").mkdir()
    await _add_root(migrated_db, _real(roots))

    return _World(
        acme_project_id=acme_id,
        beta_project_id=beta_id,
        plain_cwd=str(acme / "src" / "http"),
        beta_cwd=str(beta),
        root_repo_cwd=str(orders),
        root_repo_sibling_cwd=str(orders / "api"),
        scratch_cwd=str(scratch / "run-1"),
        # Under `acme`'s repo, and gone: a string match would attribute it.
        missing_cwd=str(acme / "services" / "api"),
    )


async def _seed_six_sessions(db: aiosqlite.Connection, world: _World) -> None:
    """One session per directory kind, plus the two that share a repo."""
    await _insert_session(db, "sess-1-plain", world.plain_cwd)
    await _insert_session(db, "sess-2-root", world.root_repo_cwd)
    await _insert_session(db, "sess-3-root-sibling", world.root_repo_sibling_cwd)
    await _insert_session(db, "sess-4-scratch", world.scratch_cwd)
    await _insert_session(db, "sess-5-missing", world.missing_cwd)
    await _insert_session(
        db, "sess-6-already-set", world.beta_cwd, project_id=world.acme_project_id
    )


# ─── Counts ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_counts_split_the_four_directory_kinds(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    await _seed_six_sessions(migrated_db, world)

    result = await session_backfill_service.backfill_session_attribution(migrated_db)

    assert result == {
        "scanned": 6,
        # The plain repo's session plus the two in the discovered repo.
        "attributed": 3,
        "ephemeral": 1,
        "still_unattributed": 1,
        # One repo, two sessions, one project row.
        "created_projects": 1,
    }


@pytest.mark.asyncio
async def test_a_matched_project_and_its_branch_are_written(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    await _seed_six_sessions(migrated_db, world)

    await session_backfill_service.backfill_session_attribution(migrated_db)

    row = await _session(migrated_db, "sess-1-plain")
    assert row["project_id"] == world.acme_project_id
    assert row["git_branch"] == "main"
    assert row["session_kind"] == "project"


@pytest.mark.asyncio
async def test_a_repo_under_an_enabled_root_gets_one_discovered_project(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """Both sessions in the repo land on the *same* new row — the resolver
    keys a discovered project on the repo directory, and `created_projects`
    counts rows, not sessions."""
    await _seed_six_sessions(migrated_db, world)

    await session_backfill_service.backfill_session_attribution(migrated_db)

    first = await _session(migrated_db, "sess-2-root")
    second = await _session(migrated_db, "sess-3-root-sibling")
    assert first["project_id"] is not None
    assert first["project_id"] == second["project_id"]
    assert first["git_branch"] == "feat/orders"

    async with migrated_db.execute(
        "SELECT name, status FROM projects WHERE id = ?", (first["project_id"],)
    ) as cur:
        project = await cur.fetchone()
    assert project is not None
    assert (project["name"], project["status"]) == ("orders", "discovered")


@pytest.mark.asyncio
async def test_an_ephemeral_cwd_is_classified_and_never_attributed(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    await _seed_six_sessions(migrated_db, world)

    await session_backfill_service.backfill_session_attribution(migrated_db)

    row = await _session(migrated_db, "sess-4-scratch")
    assert row["project_id"] is None
    assert row["session_kind"] == "ephemeral"


# ─── A cwd that no longer exists ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_vanished_cwd_is_never_guessed_from_the_string(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """`missing_cwd` sits under `acme`'s repo. Prefix matching would hand it
    that project; the pass must leave it untouched — project, branch and kind
    all exactly as recorded."""
    await _seed_six_sessions(migrated_db, world)
    before = await _session(migrated_db, "sess-5-missing")

    result = await session_backfill_service.backfill_session_attribution(migrated_db)

    after = await _session(migrated_db, "sess-5-missing")
    assert after["project_id"] is None
    assert after["git_branch"] is None
    assert tuple(before) == tuple(after)
    assert result["still_unattributed"] == 1


@pytest.mark.asyncio
async def test_a_session_with_no_cwd_at_all_stays_unattributed(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """A NULL cwd is the same refusal as a vanished one, and must not raise."""
    await _insert_session(migrated_db, "sess-null-cwd", None)
    await _insert_session(migrated_db, "sess-relative-cwd", "acme/src")

    result = await session_backfill_service.backfill_session_attribution(migrated_db)

    assert result["scanned"] == 2
    assert result["attributed"] == 0
    assert result["still_unattributed"] == 2
    for session_id in ("sess-null-cwd", "sess-relative-cwd"):
        row = await _session(migrated_db, session_id)
        assert row["project_id"] is None
        assert row["git_branch"] is None


@pytest.mark.asyncio
async def test_a_branch_already_recorded_is_left_alone(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """The branch a session actually ran on is history; today's `HEAD` is not
    it. `git_branch` is fill-only, so the pass adds the branch it can read and
    never revises one it already has."""
    await _insert_session(
        migrated_db, "sess-branched", world.plain_cwd, git_branch="hotfix/old"
    )

    await session_backfill_service.backfill_session_attribution(migrated_db)

    row = await _session(migrated_db, "sess-branched")
    assert row["git_branch"] == "hotfix/old"
    assert row["project_id"] == world.acme_project_id


# ─── A failure mid-sweep ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_unacceptable_cwd_does_not_abort_the_pass(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """A NUL byte in a stored cwd makes `realpath` raise `ValueError` rather
    than `OSError`. The pass calls `is_ephemeral_cwd` and `cwd_exists` on the
    raw column, so one odd row used to take the whole sweep down with it — and
    the rows already updated with it. It is an ordinary attribution miss."""
    await _insert_session(migrated_db, "sess-1-plain", world.plain_cwd)
    await _insert_session(migrated_db, "sess-2-nul", "/tmp/acme\x00api")

    result = await session_backfill_service.backfill_session_attribution(migrated_db)

    assert result["scanned"] == 2
    assert result["attributed"] == 1
    assert result["still_unattributed"] == 1
    assert (await _session(migrated_db, "sess-1-plain"))[
        "project_id"
    ] == world.acme_project_id
    odd = await _session(migrated_db, "sess-2-nul")
    assert odd["project_id"] is None
    assert odd["git_branch"] is None


@pytest.mark.asyncio
async def test_a_raise_mid_sweep_leaves_the_table_as_it_was(
    migrated_db: aiosqlite.Connection,
    world: _World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The sidecar shares one SQLite connection across every request, so a
    half-applied sweep left pending on it would be committed by the next
    hook's own `commit()` — the hazard `agents._safe_handle` guards on the
    ingest path. A pass that raises must roll back and re-raise, not report
    counts for work it only partly did.

    The second row is the one in the root's repo, so the pending work rolled
    back here includes the `status='discovered'` project `resolve` inserted:
    `_create_discovered_project` deliberately does not commit, and a project
    row nothing references is exactly the litter the rollback exists to stop.
    """
    await _insert_session(migrated_db, "sess-1-plain", world.plain_cwd)
    await _insert_session(migrated_db, "sess-2-root", world.root_repo_cwd)
    sessions_before = await _session_rows(migrated_db)
    projects_before = await _project_rows(migrated_db)

    calls = 0
    real_apply = session_backfill_service._apply_updates

    async def _fail_on_second(db, session_id, updates):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        if calls == 2:
            raise aiosqlite.OperationalError("database is locked")
        await real_apply(db, session_id, updates)

    monkeypatch.setattr(session_backfill_service, "_apply_updates", _fail_on_second)

    with pytest.raises(aiosqlite.OperationalError):
        await session_backfill_service.backfill_session_attribution(migrated_db)

    assert calls == 2
    assert await _session_rows(migrated_db) == sessions_before
    assert await _project_rows(migrated_db) == projects_before

    # What the next hook on this connection does. Nothing of the abandoned
    # pass may ride along with it.
    await migrated_db.commit()
    assert await _session_rows(migrated_db) == sessions_before
    assert await _project_rows(migrated_db) == projects_before


@pytest.mark.asyncio
async def test_a_raise_at_the_final_commit_is_rolled_back(
    migrated_db: aiosqlite.Connection,
    world: _World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The commit itself is inside the guard: a `database is locked` raised
    there leaves every UPDATE of the pass pending, which is the largest
    version of the same leak."""
    await _insert_session(migrated_db, "sess-1-plain", world.plain_cwd)
    sessions_before = await _session_rows(migrated_db)

    async def _boom() -> None:
        raise aiosqlite.OperationalError("database is locked")

    monkeypatch.setattr(migrated_db, "commit", _boom)

    with pytest.raises(aiosqlite.OperationalError):
        await session_backfill_service.backfill_session_attribution(migrated_db)

    monkeypatch.undo()
    assert await _session_rows(migrated_db) == sessions_before
    await migrated_db.commit()
    assert await _session_rows(migrated_db) == sessions_before


# ─── Dry run ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dry_run_reports_the_same_counts_and_changes_no_row(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    await _seed_six_sessions(migrated_db, world)
    sessions_before = await _session_rows(migrated_db)
    projects_before = await _project_rows(migrated_db)

    dry = await session_backfill_service.backfill_session_attribution(
        migrated_db, dry_run=True
    )

    assert await _session_rows(migrated_db) == sessions_before
    assert await _project_rows(migrated_db) == projects_before

    real = await session_backfill_service.backfill_session_attribution(migrated_db)
    assert dry == real


@pytest.mark.asyncio
async def test_dry_run_counts_the_project_it_would_create(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """The probe is the whole point: a dry run that reported
    `created_projects=0` because it declined to write would be useless as the
    pre-flight check the human actually runs."""
    await _insert_session(migrated_db, "sess-would-create", world.root_repo_cwd)
    projects_before = await _project_rows(migrated_db)

    dry = await session_backfill_service.backfill_session_attribution(
        migrated_db, dry_run=True
    )

    assert dry["created_projects"] == 1
    assert dry["attributed"] == 1
    assert dry["still_unattributed"] == 0
    assert await _project_rows(migrated_db) == projects_before


@pytest.mark.asyncio
async def test_dry_run_does_not_double_count_a_repo_nested_in_another(
    migrated_db: aiosqlite.Connection,
    world: _World,
    tmp_path: pathlib.Path,
) -> None:
    """A submodule-shaped repo inside another repo the same pass discovers is
    one project row, not two.

    The probe (`would_discover`) only ever sees the project table as it was
    before the pass, where neither repo is claimed, so it answers "yes" for
    both. A real run does not: the first row mints a project at `outer`, and
    the second row's `match_project` — a path-*prefix* test against the
    project set as it grows — hands `outer/vendor/inner` that brand-new
    project instead of discovering it. De-duplicating the probe by repo-path
    equality therefore over-reports `created_projects`, which is precisely
    the lie the dry-run pre-flight exists to prevent.

    Both rows still count as `attributed`: the nested session does get a
    project, just not a new one.
    """
    outer = _mk_repo(tmp_path / "roots" / "outer", head="ref: refs/heads/main\n")
    inner = _mk_repo(outer / "vendor" / "inner", head="ref: refs/heads/vendored\n")
    await _insert_session(migrated_db, "sess-1-outer", str(outer))
    await _insert_session(migrated_db, "sess-2-inner", str(inner))
    projects_before = await _project_rows(migrated_db)

    dry = await session_backfill_service.backfill_session_attribution(
        migrated_db, dry_run=True
    )

    assert await _project_rows(migrated_db) == projects_before
    assert dry["created_projects"] == 1
    assert dry["attributed"] == 2

    real = await session_backfill_service.backfill_session_attribution(migrated_db)
    assert dry == real

    # One row, for the outer repo; the nested session shares it.
    async with migrated_db.execute(
        "SELECT id, name, root_path FROM projects WHERE status = 'discovered'"
    ) as cur:
        discovered = [tuple(row) for row in await cur.fetchall()]
    assert [(name, root) for _id, name, root in discovered] == [("outer", _real(outer))]
    first = await _session(migrated_db, "sess-1-outer")
    second = await _session(migrated_db, "sess-2-inner")
    assert first["project_id"] == discovered[0][0]
    assert second["project_id"] == discovered[0][0]


# ─── Idempotence ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_second_real_run_changes_nothing(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    await _seed_six_sessions(migrated_db, world)

    first = await session_backfill_service.backfill_session_attribution(migrated_db)
    assert first["attributed"] == 3
    assert first["created_projects"] == 1
    sessions_after_first = await _session_rows(migrated_db)
    projects_after_first = await _project_rows(migrated_db)

    second = await session_backfill_service.backfill_session_attribution(migrated_db)

    assert second["attributed"] == 0
    assert second["created_projects"] == 0
    assert second["scanned"] == first["scanned"]
    assert second["ephemeral"] == first["ephemeral"]
    assert second["still_unattributed"] == first["still_unattributed"]
    assert await _session_rows(migrated_db) == sessions_after_first
    assert await _project_rows(migrated_db) == projects_after_first


# ─── force ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_set_project_id_is_not_moved_without_force(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    await _seed_six_sessions(migrated_db, world)

    result = await session_backfill_service.backfill_session_attribution(migrated_db)

    row = await _session(migrated_db, "sess-6-already-set")
    assert row["project_id"] == world.acme_project_id
    # Neither changed nor unattributed — it is simply none of the pass's
    # business, so it appears in no bucket but `scanned`.
    assert result["attributed"] == 3


@pytest.mark.asyncio
async def test_force_moves_a_set_project_id(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    await _seed_six_sessions(migrated_db, world)

    result = await session_backfill_service.backfill_session_attribution(
        migrated_db, force=True
    )

    row = await _session(migrated_db, "sess-6-already-set")
    assert row["project_id"] == world.beta_project_id
    assert row["git_branch"] == "release"
    assert result["attributed"] == 4


@pytest.mark.asyncio
async def test_force_never_clears_an_attribution_it_cannot_replace(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """A forced run replaces attribution; it does not destroy it. The cwd here
    is gone, so the resolver has no answer — and `NULL` is not an answer worth
    overwriting a human's with."""
    await _insert_session(
        migrated_db,
        "sess-forced-missing",
        world.missing_cwd,
        project_id=world.acme_project_id,
    )

    result = await session_backfill_service.backfill_session_attribution(
        migrated_db, force=True
    )

    row = await _session(migrated_db, "sess-forced-missing")
    assert row["project_id"] == world.acme_project_id
    assert result["attributed"] == 0


@pytest.mark.asyncio
async def test_force_is_a_no_op_when_the_resolver_agrees(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """`attributed` counts changes, not rows re-resolved, so a forced run over
    correct data is still `0` and still byte-identical."""
    await _insert_session(
        migrated_db,
        "sess-already-correct",
        world.plain_cwd,
        project_id=world.acme_project_id,
        git_branch="main",
    )
    before = await _session_rows(migrated_db)

    result = await session_backfill_service.backfill_session_attribution(
        migrated_db, force=True
    )

    assert result["attributed"] == 0
    assert await _session_rows(migrated_db) == before


# ─── The endpoint ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_endpoint_returns_the_counts_and_honours_dry_run(
    migrated_db: aiosqlite.Connection, world: _World
) -> None:
    """curl is the interface for P0, so the query parsing is part of the
    deliverable: `?dry_run=1` must be inert end to end."""
    await _seed_six_sessions(migrated_db, world)
    sessions_before = await _session_rows(migrated_db)

    application = FastAPI()
    application.include_router(agents_router.router)
    original_db = db_module._db
    db_module._db = migrated_db
    try:
        client = TestClient(application, raise_server_exceptions=True)

        dry = client.post("/api/v1/agents/sessions/backfill-attribution?dry_run=1")
        assert dry.status_code == 200
        assert dry.json() == {
            "scanned": 6,
            "attributed": 3,
            "ephemeral": 1,
            "still_unattributed": 1,
            "created_projects": 1,
        }
        assert await _session_rows(migrated_db) == sessions_before

        real = client.post("/api/v1/agents/sessions/backfill-attribution")
        assert real.status_code == 200
        assert real.json() == dry.json()
        assert await _session_rows(migrated_db) != sessions_before
    finally:
        db_module._db = original_db
