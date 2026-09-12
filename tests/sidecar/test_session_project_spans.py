"""Tests for `app/services/session_project_spans_service.py` (epic #153 / #173).

The case the whole ticket exists for is the first test here: a session opened
at a directory that parents five repos, which today keeps the one project id
guessed at SessionStart for its entire life. Everything else in this file is
either a way that split could be got wrong (a move inside one repo, a return
to a repo already visited, an event that names no directory) or the promise
that getting it wrong must not cost the hook its event.

Fixtures are real directory trees under `tmp_path`, as in
`tests/sidecar/test_cwd_resolver.py`: a `.git` directory holding a `HEAD` file
is everything the resolver reads, so nothing here is mocked and no `git`
subprocess is ever run. `tmp_path` reaches a test through macOS's symlinked
`/var`, so every expected path goes through `_real`.

`agent_service._now` is replaced with a one-second-per-call counter. The real
clock truncates to seconds, so a whole test's worth of hooks would otherwise
land on one timestamp and every assertion about a span *boundary* would pass
for the wrong reason.
"""

from __future__ import annotations

import itertools
import os
import pathlib
from datetime import UTC, datetime, timedelta

import aiosqlite
import pytest

from app.services import agent_service, session_project_spans_service

# ─── Fixtures / helpers ──────────────────────────────────────────────────────


def _real(path: pathlib.Path | str) -> str:
    return os.path.realpath(str(path)).rstrip("/")


def _mk_repo(path: pathlib.Path) -> pathlib.Path:
    """Create `path` as a git repo: a `.git/` directory holding a `HEAD`."""
    path.mkdir(parents=True, exist_ok=True)
    git_dir = path / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def _monotonic_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """One second per `_now()` call, so timestamps order and compare."""
    counter = itertools.count()
    base = datetime(2026, 1, 1, 9, 0, 0, tzinfo=UTC).replace(tzinfo=None)

    def _now() -> str:
        return (base + timedelta(seconds=next(counter))).isoformat(timespec="seconds")

    monkeypatch.setattr(agent_service, "_now", _now)


async def _insert_project(db: aiosqlite.Connection, name: str, root_path: str) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace, is_active) "
        "VALUES (?, 'active', ?, ?, 0, 1)",
        (name, root_path, root_path),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return int(cur.lastrowid)


async def _start_session(
    db: aiosqlite.Connection, session_id: str, cwd: pathlib.Path | str
) -> None:
    await agent_service.record_session_start(
        db, {"session_id": session_id, "cwd": str(cwd)}
    )


async def _move(
    db: aiosqlite.Connection,
    session_id: str,
    cwd: pathlib.Path | str,
    event: str = "CwdChanged",
) -> None:
    """Feed one directory change through the real generic hook recorder."""
    await agent_service.record_hook_event(
        db,
        event,
        {
            "session_id": session_id,
            "hook_event_name": event,
            "new_cwd": str(cwd),
        },
    )


async def _spans(db: aiosqlite.Connection, session_id: str) -> list[aiosqlite.Row]:
    async with db.execute(
        "SELECT * FROM session_project_spans WHERE session_id = ? ORDER BY seq",
        (session_id,),
    ) as cur:
        return list(await cur.fetchall())


async def _five_repo_session(
    db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> tuple[str, list[int]]:
    """The epic's motivating case: one session, five repos under one root.

    Returns the session id and the five project ids in visit order.
    """
    session_id = "sess-173-five"
    root = tmp_path / "work"
    repos = [_mk_repo(root / name) for name in ("api", "web", "infra", "ml", "docs")]
    project_ids = [await _insert_project(db, repo.name, _real(repo)) for repo in repos]

    await _start_session(db, session_id, repos[0])
    for repo in repos[1:]:
        await _move(db, session_id, repo)
    return session_id, project_ids


# ─── the case the ticket was opened for ──────────────────────────────────────


@pytest.mark.asyncio
async def test_five_repos_become_five_attributed_spans(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """One session, five repos, five spans — each on its own project.

    The session row keeps the single project it was given at SessionStart;
    that is deliberate (spans are additive) and is asserted here so a later
    change cannot quietly repurpose the column.
    """
    session_id, project_ids = await _five_repo_session(migrated_db, tmp_path)

    spans = await _spans(migrated_db, session_id)
    assert [row["seq"] for row in spans] == [0, 1, 2, 3, 4]
    assert [row["project_id"] for row in spans] == project_ids

    async with migrated_db.execute(
        "SELECT project_id FROM agent_sessions WHERE session_id = ?", (session_id,)
    ) as cur:
        session_row = await cur.fetchone()
    assert session_row is not None
    assert session_row["project_id"] == project_ids[0]


@pytest.mark.asyncio
async def test_span_boundaries_chain_and_only_the_last_stays_open(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Each span ends exactly where the next begins, and the last is open.

    A gap or an overlap between consecutive spans would mean a session's time
    is lost or counted twice, which is the arithmetic the table exists for.
    """
    session_id, _ = await _five_repo_session(migrated_db, tmp_path)
    spans = await _spans(migrated_db, session_id)

    for earlier, later in itertools.pairwise(spans):
        assert earlier["ended_at"] == later["started_at"]
        assert earlier["started_at"] < earlier["ended_at"]

    assert spans[-1]["ended_at"] is None
    assert spans[-1]["last_seen_at"] == spans[-1]["started_at"]


@pytest.mark.asyncio
async def test_first_span_starts_at_the_session_not_at_the_first_move(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Span 0 is seeded from the session's own cwd, which emits no event.

    `CwdChanged` fires on a *change*, so without the seed the repo a session
    opened in would never appear and five repos would read as four.
    """
    session_id, project_ids = await _five_repo_session(migrated_db, tmp_path)
    spans = await _spans(migrated_db, session_id)

    async with migrated_db.execute(
        "SELECT cwd, started_at FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    ) as cur:
        session_row = await cur.fetchone()
    assert session_row is not None

    assert spans[0]["project_id"] == project_ids[0]
    assert spans[0]["started_at"] == session_row["started_at"]
    assert spans[0]["cwd"] == session_row["cwd"]
    # The seeded span comes from the session row, not from an event.
    assert spans[0]["source_event_id"] is None
    assert spans[1]["source_event_id"] is not None


# ─── the single-repo baseline: no split ──────────────────────────────────────


@pytest.mark.asyncio
async def test_moving_within_one_repo_is_a_single_span(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Three cwd changes inside one repo must not become three spans.

    The baseline the five-repo case is only meaningful against: a span is a
    stretch in one *repo*, not one directory, so subdirectory hops extend it
    and advance the evidence rather than splitting it.
    """
    session_id = "sess-173-one"
    repo = _mk_repo(tmp_path / "work" / "api")
    (repo / "src" / "deep").mkdir(parents=True)
    project_id = await _insert_project(migrated_db, "api", _real(repo))

    await _start_session(migrated_db, session_id, repo)
    await _move(migrated_db, session_id, repo / "src")
    await _move(migrated_db, session_id, repo / "src" / "deep")
    await _move(migrated_db, session_id, repo)

    spans = await _spans(migrated_db, session_id)
    assert len(spans) == 1
    assert spans[0]["project_id"] == project_id
    assert spans[0]["ended_at"] is None
    # Evidence advanced even though the boundary did not.
    assert spans[0]["last_seen_at"] > spans[0]["started_at"]


@pytest.mark.asyncio
async def test_a_session_that_never_moves_has_no_spans(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """No move, no split — the session row already says where it was."""
    repo = _mk_repo(tmp_path / "work" / "api")
    await _insert_project(migrated_db, "api", _real(repo))

    await _start_session(migrated_db, "sess-173-still", repo)

    assert await _spans(migrated_db, "sess-173-still") == []


# ─── boundary derivation ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_returning_to_an_earlier_repo_opens_a_new_span(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A → B → A is three spans, not two: a repo can be visited twice."""
    session_id = "sess-173-return"
    api = _mk_repo(tmp_path / "work" / "api")
    web = _mk_repo(tmp_path / "work" / "web")
    api_id = await _insert_project(migrated_db, "api", _real(api))
    web_id = await _insert_project(migrated_db, "web", _real(web))

    await _start_session(migrated_db, session_id, api)
    await _move(migrated_db, session_id, web)
    await _move(migrated_db, session_id, api)

    spans = await _spans(migrated_db, session_id)
    assert [row["project_id"] for row in spans] == [api_id, web_id, api_id]


@pytest.mark.asyncio
async def test_an_unattributed_detour_is_its_own_span(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A stretch in a directory that belongs to no project is recorded as one.

    Dropping it would silently extend the previous span across time the
    session demonstrably spent elsewhere — attributing work to a repo it had
    already left.
    """
    session_id = "sess-173-detour"
    api = _mk_repo(tmp_path / "work" / "api")
    elsewhere = _mk_repo(tmp_path / "outside" / "unimported")
    api_id = await _insert_project(migrated_db, "api", _real(api))

    await _start_session(migrated_db, session_id, api)
    await _move(migrated_db, session_id, elsewhere)
    await _move(migrated_db, session_id, api)

    spans = await _spans(migrated_db, session_id)
    assert [row["project_id"] for row in spans] == [api_id, None, api_id]
    assert spans[1]["repo_path"] == _real(elsewhere)


@pytest.mark.asyncio
async def test_directory_added_feeds_the_same_spans(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """`DirectoryAdded` is the other half of T1's stream and splits equally."""
    session_id = "sess-173-added"
    api = _mk_repo(tmp_path / "work" / "api")
    web = _mk_repo(tmp_path / "work" / "web")
    api_id = await _insert_project(migrated_db, "api", _real(api))
    web_id = await _insert_project(migrated_db, "web", _real(web))

    await _start_session(migrated_db, session_id, api)
    await _move(migrated_db, session_id, web, event="DirectoryAdded")

    spans = await _spans(migrated_db, session_id)
    assert [row["project_id"] for row in spans] == [api_id, web_id]


# ─── derived, therefore rebuildable ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_spans_rebuild_from_the_events_already_recorded(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """The backfill's unit: the same spans, derived from `agent_events` alone.

    Running a backfill is not this ticket's job, but a shape that could not
    support one would be the wrong shape — so the five-repo session's spans
    are thrown away and recomputed from the stored events, and must come back
    identical.
    """
    session_id, project_ids = await _five_repo_session(migrated_db, tmp_path)
    before = [dict(row) for row in await _spans(migrated_db, session_id)]

    await migrated_db.execute("DELETE FROM session_project_spans")
    await migrated_db.commit()

    rebuilt = await session_project_spans_service.rebuild_session_spans(
        migrated_db, session_id
    )
    await migrated_db.commit()
    assert rebuilt == len(project_ids)

    after = [dict(row) for row in await _spans(migrated_db, session_id)]
    fields = (
        "seq",
        "project_id",
        "repo_path",
        "cwd",
        "started_at",
        "ended_at",
        "last_seen_at",
        "source_event_id",
    )
    assert [{f: row[f] for f in fields} for row in after] == [
        {f: row[f] for f in fields} for row in before
    ]


@pytest.mark.asyncio
async def test_rebuilding_twice_changes_nothing(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A backfill must be safe to re-run: spans replace, they never accumulate."""
    session_id, project_ids = await _five_repo_session(migrated_db, tmp_path)

    first = await session_project_spans_service.rebuild_session_spans(
        migrated_db, session_id
    )
    second = await session_project_spans_service.rebuild_session_spans(
        migrated_db, session_id
    )
    await migrated_db.commit()

    assert first == second == len(project_ids)
    assert [row["project_id"] for row in await _spans(migrated_db, session_id)] == (
        project_ids
    )


# ─── nothing may reach a hook handler ────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_event_naming_no_directory_records_no_span(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """An event that names no directory is not evidence that a session moved."""
    session_id = "sess-173-nodir"
    repo = _mk_repo(tmp_path / "work" / "api")
    await _insert_project(migrated_db, "api", _real(repo))

    await _start_session(migrated_db, session_id, repo)
    await agent_service.record_hook_event(
        migrated_db,
        "CwdChanged",
        {"session_id": session_id, "hook_event_name": "CwdChanged"},
    )

    assert await _spans(migrated_db, session_id) == []
    async with migrated_db.execute(
        "SELECT COUNT(*) AS n FROM agent_events "
        "WHERE session_id = ? AND event_type = 'CwdChanged'",
        (session_id,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None and row["n"] == 1


@pytest.mark.asyncio
async def test_a_failing_span_write_still_leaves_the_event_ingested(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hook ingest is non-blocking: a broken span writer costs only the span."""
    session_id = "sess-173-boom"
    api = _mk_repo(tmp_path / "work" / "api")
    web = _mk_repo(tmp_path / "work" / "web")
    await _insert_project(migrated_db, "api", _real(api))
    await _insert_project(migrated_db, "web", _real(web))

    await _start_session(migrated_db, session_id, api)

    async def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("span writer exploded")

    monkeypatch.setattr(session_project_spans_service, "_apply_observation", _boom)

    await _move(migrated_db, session_id, web)

    assert await _spans(migrated_db, session_id) == []
    async with migrated_db.execute(
        "SELECT summary FROM agent_events "
        "WHERE session_id = ? AND event_type = 'CwdChanged'",
        (session_id,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert str(web) in row["summary"]


# ─── what a rebuild must refuse to destroy ───────────────────────────────────


@pytest.mark.asyncio
async def test_rebuild_leaves_spans_alone_when_the_evidence_has_been_pruned(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """ "No observations" is ambiguous, and the destructive reading is wrong.

    `agent_events` is pruned on a far shorter clock than spans are meant to
    live on — tool-grain rows go at 30 days, and this module's own migration
    header says a span outlives the events it was derived from. So a rebuild
    finding nothing means *either* the session never moved *or* its evidence
    has already been swept.

    An earlier version deleted first and read second, which collapsed those two
    cases into the destructive one: a backfill run any time after a retention
    sweep would erase correct attribution and return 0, with nothing left to
    notice it by. This pins the safe reading.
    """
    session_id, _ = await _five_repo_session(migrated_db, tmp_path)
    before = await _spans(migrated_db, session_id)
    assert len(before) == 5, "precondition: the five-repo session has five spans"

    # Exactly what retention does, and nothing else.
    await migrated_db.execute(
        "DELETE FROM agent_events WHERE session_id = ?", (session_id,)
    )
    await migrated_db.commit()

    returned = await session_project_spans_service.rebuild_session_spans(
        migrated_db, session_id
    )
    after = await _spans(migrated_db, session_id)

    assert len(after) == 5, "a rebuild must not destroy what it cannot rebuild"
    assert returned == 5, "and must report what the session actually has"
    assert [r["project_id"] for r in after] == [r["project_id"] for r in before]


@pytest.mark.asyncio
async def test_an_unusable_cwd_does_not_truncate_the_open_span(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A cwd we cannot resolve is not evidence that the session moved.

    An absent cwd is already skipped on exactly that reasoning. A
    present-but-unusable one — a relative path, an empty string — proves just
    as little, but an earlier version treated it as a move: it closed the live
    span and opened an unattributed one, so a single malformed payload
    truncated a real span and ended attribution for the rest of the session.
    """
    session_id = "sess-173-unusable"
    repo = _mk_repo(tmp_path / "work" / "api")
    project_id = await _insert_project(migrated_db, "api", _real(repo))
    await _start_session(migrated_db, session_id, repo)
    await _move(migrated_db, session_id, tmp_path / "work" / "api" / "src")

    baseline = await _spans(migrated_db, session_id)

    # The malformed payloads a hook can actually emit.
    await _move(migrated_db, session_id, "src/relative")
    await _move(migrated_db, session_id, "   ")

    after = await _spans(migrated_db, session_id)

    assert len(after) == len(baseline), (
        "an unusable cwd must not open a span — it says nothing about where we are"
    )
    assert after[-1]["ended_at"] is None, "the live span must stay open"
    assert after[-1]["project_id"] == project_id, (
        "and must keep its attribution rather than falling to unattributed"
    )
