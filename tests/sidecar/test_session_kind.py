"""Tests for `agent_sessions.session_kind` (epic #153 / #157).

Attribution used to have one failure value: `project_id IS NULL` meant both
"not matched yet" and "this directory will never be a project". These tests
pin the second reading into its own column — a scratch run under a temp root
is `ephemeral`, keeps `project_id NULL` deliberately, and creates nothing.

Three things are asserted deliberately and repeatedly, because each is a way
the classification could be quietly wrong:

  * **Boundary, not substring.** `/tmpfoo` is not under `/tmp`. That is the
    same bug the deleted `agent_service._match_project` shipped (`if path in
    cwd`), and a `startswith` with no separator would bring it back for temp
    roots instead of project paths.
  * **Resolved, not literal.** On macOS `/tmp` *is* `/private/tmp` through a
    symlink, and `$TMPDIR` is a `/var/folders/...` path reached through
    another one. A session reports whichever spelling its shell had.
  * **No writes.** An ephemeral cwd must skip `cwd_resolver_service`'s
    discovered-project creation path entirely, not merely fail to match — a
    scratch run inside an enabled `project_roots` directory is exactly the
    case that would otherwise mint a junk project row per temp directory.

`tests/sidecar/conftest.py` narrows the ephemeral root set for every test in
this package, because pytest hands each test a `tmp_path` under `$TMPDIR` and
nothing else could exercise project matching at all. The
`real_ephemeral_roots` fixture below hands the genuine function back to the
tests that want the temp tree to read as temp — which is also what covers the
`$TMPDIR` branch of detection, since `tmp_path` is reached through one.
"""

from __future__ import annotations

import os
import pathlib
import tempfile

import aiosqlite
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.config import settings
from app.database import apply_migration_file
from app.routers import agents as agents_router
from app.services import agent_service, cwd_resolver_service

_M011 = "011_agent_sessions_kind"
_MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


# ─── Fixtures / helpers ──────────────────────────────────────────────────────


# Captured at import (collection) time, before any autouse fixture has had a
# chance to narrow it.
_GENUINE_EPHEMERAL_ROOTS = cwd_resolver_service._ephemeral_roots


@pytest.fixture
def real_ephemeral_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    """Undo `conftest._pytest_tmp_is_not_ephemeral` for one test.

    Autouse fixtures are set up before explicitly requested ones, so this
    re-patch lands last and wins; `monkeypatch` undoes both in reverse at
    teardown. With the genuine function restored, pytest's `tmp_path` sits
    under `$TMPDIR` and therefore *is* ephemeral — which is the point: it
    gives a writable, isolated directory the classifier reads as a real
    scratch root, so the "creates nothing" assertions run against genuine
    fixtures rather than a hand-patched root list.
    """
    monkeypatch.setattr(
        cwd_resolver_service, "_ephemeral_roots", _GENUINE_EPHEMERAL_ROOTS
    )


def _real(path: pathlib.Path | str) -> str:
    return os.path.realpath(str(path)).rstrip("/")


def _mk_repo(
    path: pathlib.Path, head: str | None = "ref: refs/heads/main\n"
) -> pathlib.Path:
    """Create `path` as a git repo: a `.git/` directory holding `head`."""
    path.mkdir(parents=True, exist_ok=True)
    git_dir = path / ".git"
    git_dir.mkdir()
    if head is not None:
        (git_dir / "HEAD").write_text(head, encoding="utf-8")
    return path


async def _add_root(db: aiosqlite.Connection, path: str) -> None:
    await db.execute(
        "INSERT INTO project_roots (path, label, source, enabled) "
        "VALUES (?, NULL, 'manual', 1)",
        (path,),
    )
    await db.commit()


async def _project_rows(db: aiosqlite.Connection) -> list[dict]:
    async with db.execute(
        "SELECT id, name, status, path, root_path FROM projects ORDER BY id"
    ) as cur:
        return [dict(row) for row in await cur.fetchall()]


async def _session_row(db: aiosqlite.Connection, session_id: str) -> dict:
    async with db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    return dict(row)


async def _insert_session(
    db: aiosqlite.Connection,
    session_id: str,
    *,
    session_kind: str | None = None,
    status: str = "active",
) -> None:
    """Insert a session row, leaving `session_kind` at its default when unset."""
    if session_kind is None:
        await db.execute(
            "INSERT INTO agent_sessions (session_id, profile, status, last_event_at) "
            "VALUES (?, 'work', ?, '2026-01-01T00:00:00')",
            (session_id, status),
        )
    else:
        await db.execute(
            "INSERT INTO agent_sessions "
            "(session_id, profile, status, last_event_at, session_kind) "
            "VALUES (?, 'work', ?, '2026-01-01T00:00:00', ?)",
            (session_id, status, session_kind),
        )
    await db.commit()


# ─── Migration 011 shape ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_session_kind_column_is_not_null_text_defaulting_to_project(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The AC's exact DDL: `session_kind TEXT NOT NULL DEFAULT 'project'`."""
    async with migrated_db.execute("PRAGMA table_info(agent_sessions)") as cur:
        by_name = {row["name"]: row for row in await cur.fetchall()}

    assert "session_kind" in by_name, "session_kind missing from agent_sessions"
    col = by_name["session_kind"]
    assert col["type"] == "TEXT"
    assert col["notnull"] == 1
    assert col["dflt_value"] == "'project'"


@pytest.mark.asyncio
async def test_a_row_inserted_without_a_kind_reads_project(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _insert_session(migrated_db, "sess-default-kind")

    row = await _session_row(migrated_db, "sess-default-kind")

    assert row["session_kind"] == "project"


@pytest.mark.asyncio
async def test_session_kind_has_no_check_constraint(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Behavioural pin of the ADR: the vocabulary is the service's to enforce,
    not the schema's, so a third kind can arrive in P1 without a table
    rebuild. An out-of-vocabulary value round-trips at the SQL level."""
    await _insert_session(
        migrated_db, "sess-no-check", session_kind="not-a-real-kind-xyz"
    )

    row = await _session_row(migrated_db, "sess-no-check")

    assert row["session_kind"] == "not-a-real-kind-xyz"


@pytest.mark.asyncio
async def test_migration_011_leaves_existing_rows_as_project(
    tmp_path: pathlib.Path,
) -> None:
    """The dozen temp-dir sessions already on the board keep `project` — this
    ticket changes the write path only, and reclassifying them is #158. The
    row is also checked for its prior values, since the whole point of a
    defaulted `ADD COLUMN` is that no data moves."""
    conn = await aiosqlite.connect(str(tmp_path / "pre-011.db"))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    try:
        for migration_file in sorted(
            f for f in _MIGRATIONS_DIR.glob("*.sql") if f.stem < _M011
        ):
            await apply_migration_file(conn, migration_file)
        await conn.execute(
            "INSERT INTO agent_sessions (session_id, profile, cwd, total_tool_calls) "
            "VALUES (?, ?, ?, ?)",
            ("pre-011-session", "work", "/private/tmp/cn-wire-capture", 3),
        )
        await conn.commit()

        await apply_migration_file(conn, _MIGRATIONS_DIR / f"{_M011}.sql")

        async with conn.execute(
            "SELECT * FROM agent_sessions WHERE session_id = ?", ("pre-011-session",)
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["session_kind"] == "project"
        assert row["profile"] == "work"
        assert row["cwd"] == "/private/tmp/cn-wire-capture"
        assert row["total_tool_calls"] == 3
    finally:
        await conn.close()


# ─── Detection: which directories are ephemeral ──────────────────────────────


def test_private_tmp_is_ephemeral() -> None:
    """The live board's actual case: `/private/tmp/cn-wire-capture`."""
    assert cwd_resolver_service.is_ephemeral_cwd("/private/tmp/cn-wire-capture") is True


def test_tmp_is_ephemeral_through_the_symlink() -> None:
    """On macOS `/tmp` is a symlink to `/private/tmp`; a session reports
    whichever spelling its shell had, and both must classify the same."""
    assert cwd_resolver_service.is_ephemeral_cwd("/tmp/cn-wire-task/work") is True


def test_the_temp_root_itself_is_ephemeral() -> None:
    assert cwd_resolver_service.is_ephemeral_cwd("/private/tmp") is True
    assert cwd_resolver_service.is_ephemeral_cwd("/tmp/") is True


def test_tmpfoo_is_not_ephemeral() -> None:
    """The path-boundary requirement, stated as its own test: a bare prefix
    compare would call this temp and misclassify a real project."""
    assert cwd_resolver_service.is_ephemeral_cwd("/tmpfoo") is False
    assert cwd_resolver_service.is_ephemeral_cwd("/tmpfoo/api/src") is False


def test_a_repo_under_home_is_not_ephemeral() -> None:
    home_repo = str(pathlib.Path.home() / "Projects" / "api")

    assert cwd_resolver_service.is_ephemeral_cwd(home_repo) is False


def test_tmpdir_is_ephemeral(
    real_ephemeral_roots: None, tmp_path: pathlib.Path
) -> None:
    """`$TMPDIR` — the third root the AC names, and the one that is neither
    `/tmp` nor `/private/tmp`.

    pytest's own `tmp_path` lives under it, which is what makes this test
    self-checking: the first assertion states the precondition (and only
    holds through `realpath`, since macOS reaches `$TMPDIR` via a symlinked
    `/var`), and the last one uses the unresolved spelling a shell would
    actually report.
    """
    tmpdir = os.environ.get("TMPDIR") or tempfile.gettempdir()
    assert _real(tmp_path).startswith(_real(tmpdir) + "/")

    assert cwd_resolver_service.is_ephemeral_cwd(str(tmp_path / "cn-x")) is True
    assert cwd_resolver_service.is_ephemeral_cwd(os.path.join(tmpdir, "cn-x")) is True


def test_the_worktree_root_is_ephemeral(
    real_ephemeral_roots: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A `/ship` pipeline worktree (and its `_artifacts` sibling) is scratch
    by construction. Pointed at a directory under `$HOME` on purpose, so the
    only reason it can classify as ephemeral is the worktree root itself."""
    root = pathlib.Path.home() / ".codenest-worktrees-test-157"
    monkeypatch.setenv("CODENEST_WORKTREE_ROOT", str(root))

    assert cwd_resolver_service.is_ephemeral_cwd(str(root / "some-slug")) is True
    assert (
        cwd_resolver_service.is_ephemeral_cwd(str(root / "_artifacts" / "some-slug"))
        is True
    )
    # Boundary again: a sibling directory whose name merely starts with the
    # root's is ordinary work.
    assert cwd_resolver_service.is_ephemeral_cwd(f"{root}-elsewhere/api") is False


def test_the_worktree_root_defaults_beside_the_repo(
    real_ephemeral_roots: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no override the root is `<parent of repo>/.codenest-worktrees` —
    the same default `.claude/commands/ship.md` computes. The two must agree
    or a pipeline run's sessions read as project work."""
    monkeypatch.delenv("CODENEST_WORKTREE_ROOT", raising=False)
    fake_repo = pathlib.Path.home() / "w" / "codenest-app"
    monkeypatch.setattr(settings, "PROJECT_ROOT", fake_repo)

    under_root = fake_repo.parent / ".codenest-worktrees" / "slug" / "src"

    assert cwd_resolver_service.is_ephemeral_cwd(str(under_root)) is True
    assert cwd_resolver_service.is_ephemeral_cwd(str(fake_repo / "app")) is False


def test_an_unusable_cwd_is_not_ephemeral() -> None:
    """A session with no usable cwd is an ordinary attribution miss. Calling
    it ephemeral would forgive exactly the misses this phase counts, and a
    relative path must never be resolved against the sidecar's own cwd."""
    for cwd in (None, "", "   ", "relative/path", "tmp/x"):
        assert cwd_resolver_service.is_ephemeral_cwd(cwd) is False


# ─── The resolver: ephemeral skips matching and creation entirely ────────────


@pytest.mark.asyncio
async def test_resolve_classifies_an_ephemeral_cwd_and_creates_nothing(
    real_ephemeral_roots: None,
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
) -> None:
    """The load-bearing case: a git repo under a temp root that is *also*
    inside an enabled `project_roots` row. Without the gate this mints a
    `status='discovered'` project; with it, nothing is written and the row
    keeps `project_id NULL` with the kind saying why."""
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "cn-wire-capture")
    await _add_root(migrated_db, _real(root))
    before = await _project_rows(migrated_db)

    result = await cwd_resolver_service.resolve(migrated_db, str(repo / "src"))

    assert result.session_kind == "ephemeral"
    assert result.project_id is None
    assert await _project_rows(migrated_db) == before


@pytest.mark.asyncio
async def test_resolve_does_not_match_an_existing_project_under_a_temp_root(
    real_ephemeral_roots: None,
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
) -> None:
    """Ephemeral wins over matching, not just over creation: the AC is
    "ephemeral sessions keep `project_id NULL`", full stop."""
    repo = _mk_repo(tmp_path / "api")
    await migrated_db.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace, is_active) "
        "VALUES ('api', 'active', ?, ?, 0, 1)",
        (_real(repo), _real(repo)),
    )
    await migrated_db.commit()

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.session_kind == "ephemeral"
    assert result.project_id is None


@pytest.mark.asyncio
async def test_resolve_keeps_the_branch_for_an_ephemeral_cwd(
    real_ephemeral_roots: None,
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
) -> None:
    """`git_branch` was never the field that made these rows misleading, and
    a pipeline worktree's branch is worth showing, so the walk still runs."""
    repo = _mk_repo(tmp_path / "wt", head="ref: refs/heads/fix/157-classify\n")

    result = await cwd_resolver_service.resolve(migrated_db, str(repo / "app"))

    assert result.session_kind == "ephemeral"
    assert result.git_branch == "fix/157-classify"
    assert result.repo_path == _real(repo)


@pytest.mark.asyncio
async def test_resolve_classifies_ordinary_work_as_project(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "api")

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.session_kind == "project"


@pytest.mark.asyncio
async def test_resolve_reports_no_kind_for_an_unusable_cwd(
    migrated_db: aiosqlite.Connection,
) -> None:
    """`None`, not `'project'`: the column is `NOT NULL DEFAULT 'project'`, so
    a resolver that claimed `'project'` here would be indistinguishable from
    one that had actually looked — and `_record_session_kind` would then flip
    a known-ephemeral session back on the first hook that carried no cwd."""
    for cwd in (None, "", "relative/path"):
        result = await cwd_resolver_service.resolve(migrated_db, cwd)
        assert result.session_kind is None


# ─── The write path: hooks stamp the kind ────────────────────────────────────


@pytest.mark.asyncio
async def test_session_start_stamps_ephemeral_and_leaves_project_id_null(
    migrated_db: aiosqlite.Connection,
) -> None:
    await agent_service.record_session_start(
        migrated_db,
        {"session_id": "sess-157-ephemeral", "cwd": "/private/tmp/cn-wire-capture"},
    )

    row = await _session_row(migrated_db, "sess-157-ephemeral")

    assert row["session_kind"] == "ephemeral"
    assert row["project_id"] is None


@pytest.mark.asyncio
async def test_session_start_stamps_project_for_ordinary_work(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "api")

    await agent_service.record_session_start(
        migrated_db, {"session_id": "sess-157-project", "cwd": str(repo)}
    )

    row = await _session_row(migrated_db, "sess-157-project")

    assert row["session_kind"] == "project"


@pytest.mark.asyncio
async def test_a_hook_with_no_cwd_does_not_clobber_a_known_kind(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The reason `session_kind` is `None`-able on the resolution: a later
    hook that proves nothing must leave the stored classification alone."""
    await agent_service.record_session_start(
        migrated_db, {"session_id": "sess-157-nocwd", "cwd": "/private/tmp/cn-wf"}
    )

    await agent_service.record_session_start(
        migrated_db, {"session_id": "sess-157-nocwd"}
    )

    row = await _session_row(migrated_db, "sess-157-nocwd")
    assert row["session_kind"] == "ephemeral"


@pytest.mark.asyncio
async def test_a_moved_cwd_reclassifies_last_known_wins(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A kind is a statement about the current directory, so a session that
    genuinely moves out of a temp directory is reclassified — the opposite of
    `project_id`, whose first write is a *match* and never becomes wrong."""
    repo = _mk_repo(tmp_path / "api")
    await agent_service.record_session_start(
        migrated_db, {"session_id": "sess-157-moved", "cwd": "/private/tmp/cn-wf"}
    )

    await agent_service.record_session_start(
        migrated_db, {"session_id": "sess-157-moved", "cwd": str(repo)}
    )

    row = await _session_row(migrated_db, "sess-157-moved")
    assert row["session_kind"] == "project"


@pytest.mark.asyncio
async def test_an_unknown_kind_is_never_written(
    migrated_db: aiosqlite.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no CHECK in the schema, this membership test *is* the constraint:
    a resolver that invented a third kind before the DB knew about it would
    otherwise write it straight through."""
    monkeypatch.setattr(
        cwd_resolver_service,
        "resolve",
        _resolution_stub(session_kind="cloud"),
    )

    await agent_service.record_session_start(
        migrated_db, {"session_id": "sess-157-unknown", "cwd": "/private/tmp/cn-x"}
    )

    row = await _session_row(migrated_db, "sess-157-unknown")
    assert row["session_kind"] == "project"


def _resolution_stub(*, session_kind: str):
    async def _stub(db, cwd, *, allow_discovery: bool = True):
        return cwd_resolver_service.CwdResolution(session_kind=session_kind)

    return _stub


@pytest.mark.asyncio
async def test_ingest_survives_a_db_without_migration_011(
    tmp_path: pathlib.Path,
) -> None:
    """A hook POSTed to a DB that has not run 011 still responds
    `{"continue": true}` *and* commits the rest of its work — the guard lives
    inside `_record_session_kind`, not in `_safe_handle`'s rollback, so the
    `agent_events` row survives. Hook ingest must never raise."""
    conn = await aiosqlite.connect(str(tmp_path / "pre-011.db"))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    for migration_file in sorted(
        f for f in _MIGRATIONS_DIR.glob("*.sql") if f.stem < _M011
    ):
        await apply_migration_file(conn, migration_file)

    original_db = db_module._db
    db_module._db = conn
    try:
        application = FastAPI()
        application.include_router(agents_router.router)
        client = TestClient(application, raise_server_exceptions=True)

        resp = client.post(
            "/api/v1/hooks/pre-tool",
            json={
                "session_id": "sess-pre-011",
                "cwd": "/private/tmp/cn-wire-capture",
                "tool_name": "Bash",
                "tool_input": {"command": "ls"},
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {"continue": True}

        async with conn.execute(
            "SELECT current_tool FROM agent_sessions WHERE session_id = ?",
            ("sess-pre-011",),
        ) as cur:
            session_row = await cur.fetchone()
        assert session_row is not None
        assert session_row["current_tool"] == "Bash"

        async with conn.execute(
            "SELECT COUNT(*) AS cnt FROM agent_events WHERE session_id = ?",
            ("sess-pre-011",),
        ) as cur:
            events = await cur.fetchone()
        assert events is not None
        assert events["cnt"] == 1
    finally:
        db_module._db = original_db
        await conn.close()


# ─── The read path: exposure and the optional filter ─────────────────────────


@pytest.mark.asyncio
async def test_list_sessions_exposes_session_kind_for_every_row(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _insert_session(migrated_db, "sess-list-project")
    await _insert_session(migrated_db, "sess-list-ephemeral", session_kind="ephemeral")

    rows = [dict(r) for r in await agent_service.list_sessions(migrated_db)]

    by_id = {r["session_id"]: r for r in rows}
    assert by_id["sess-list-project"]["session_kind"] == "project"
    assert by_id["sess-list-ephemeral"]["session_kind"] == "ephemeral"


@pytest.mark.asyncio
async def test_list_sessions_is_unfiltered_by_default(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Every existing caller keeps the rows it always got: the classification
    makes a scratch run identifiable, it does not hide it."""
    await _insert_session(migrated_db, "sess-default-a")
    await _insert_session(migrated_db, "sess-default-b", session_kind="ephemeral")

    rows = await agent_service.list_sessions(migrated_db)

    assert {r["session_id"] for r in rows} == {"sess-default-a", "sess-default-b"}


@pytest.mark.asyncio
async def test_list_sessions_filters_by_kind(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _insert_session(migrated_db, "sess-filter-project")
    await _insert_session(
        migrated_db, "sess-filter-ephemeral", session_kind="ephemeral"
    )

    only_project = await agent_service.list_sessions(
        migrated_db, session_kind="project"
    )
    only_ephemeral = await agent_service.list_sessions(
        migrated_db, session_kind="ephemeral"
    )

    assert [r["session_id"] for r in only_project] == ["sess-filter-project"]
    assert [r["session_id"] for r in only_ephemeral] == ["sess-filter-ephemeral"]


@pytest.mark.asyncio
async def test_count_sessions_filters_by_kind(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The count "unattributed sessions" should always have been measured
    against: the temp-dir scratch runs excluded, not inflating the miss."""
    await _insert_session(migrated_db, "sess-count-a", status="ended")
    await _insert_session(migrated_db, "sess-count-b", status="ended")
    await _insert_session(
        migrated_db, "sess-count-c", session_kind="ephemeral", status="ended"
    )

    assert await agent_service.count_sessions(migrated_db, status="ended") == 3
    assert (
        await agent_service.count_sessions(
            migrated_db, status="ended", session_kind="project"
        )
        == 2
    )
    assert (
        await agent_service.count_sessions(
            migrated_db, status="ended", session_kind="ephemeral"
        )
        == 1
    )


@pytest.mark.asyncio
async def test_a_blank_kind_filter_means_all_kinds(
    migrated_db: aiosqlite.Connection,
) -> None:
    """So a router may pass an empty query param straight through, the way it
    already does for `profile` and `status`."""
    await _insert_session(migrated_db, "sess-blank-a")
    await _insert_session(migrated_db, "sess-blank-b", session_kind="ephemeral")

    assert len(await agent_service.list_sessions(migrated_db, session_kind="")) == 2
    assert await agent_service.count_sessions(migrated_db, session_kind="  ") == 2


@pytest.mark.asyncio
async def test_an_unknown_kind_filter_raises(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A typo must not read as a confident zero. With no CHECK constraint in
    the schema, SQLite would happily match no row and say nothing."""
    with pytest.raises(ValueError, match="unknown session_kind"):
        await agent_service.list_sessions(migrated_db, session_kind="cloud")
    with pytest.raises(ValueError, match="unknown session_kind"):
        await agent_service.count_sessions(migrated_db, session_kind="cloud")


@pytest.mark.asyncio
async def test_a_session_first_seen_through_an_extended_hook_gets_its_kind(
    migrated_db: aiosqlite.Connection,
    real_ephemeral_roots: None,
    tmp_path: pathlib.Path,
) -> None:
    """#168's generic recorder must classify, not just attribute.

    `cwd_resolver_service.resolve` returns `project_id`, `git_branch` and
    `session_kind` in one object. `_ensure_session_row` — the path that creates
    a session whose FIRST event is an extended hook, now the common case for a
    subagent or task event — originally used only `project_id` and dropped the
    other two.

    That is not cosmetic. `event_retention_service` files an ephemeral
    session's events under a 7-day window and a project session's under 90, so
    a session mis-classified here keeps its rows for nearly three months past
    the class #157 created for them. The resolver had already done the work;
    this pins that the answer is used.
    """
    scratch = tmp_path / "cn-scratch"
    scratch.mkdir()

    await agent_service.record_hook_event(
        migrated_db,
        "SubagentStart",
        {"session_id": "s-ext-first", "cwd": str(scratch)},
    )
    await migrated_db.commit()

    row = await (
        await migrated_db.execute(
            "SELECT session_kind, status FROM agent_sessions WHERE session_id = ?",
            ("s-ext-first",),
        )
    ).fetchone()

    assert row is not None, "the extended hook must create the session row"
    assert row["session_kind"] == "ephemeral"
    assert row["status"] == "active"
