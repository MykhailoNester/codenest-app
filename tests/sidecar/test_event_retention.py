"""Tests for per-source `agent_events` retention (epic #153 / #160).

Retention is the one feature whose bugs are unrecoverable: a window that is
too wide only wastes disk, but a window applied to the wrong rows destroys
data nobody can get back. So these tests pin the parts that could be quietly
wrong rather than the happy path:

  * **Each class gets its own cutoff.** A tool event and a prompt event of
    the same age must not share a fate — at 45 days the tool event is gone
    and the prompt event is still there.
  * **Ephemeral wins over event type.** A scratch session's `PreToolUse` must
    age out on the 7-day clock, not the 30-day one, and its `SessionStart`
    must not survive 90 days just because it is not a tool event. This is the
    precedence the three classes only have a point in encoding.
  * **Batching is real, not decorative.** More than `_BATCH_ROWS` expired
    rows must all go, across multiple statements — an implementation that
    ran one `LIMIT 5000` DELETE and returned would silently leave a backlog
    that grows faster than the daily tick clears it.
  * **Sessions survive.** The invariant the ticket states in capitals: a
    session that loses every event keeps its row, its counters and its
    provenance.
  * **Idempotency.** The prune runs from a background tick; running twice in
    a row must be indistinguishable from running once.

Timestamps in the fixtures are written in `agent_service._now()`'s
`T`-separated spelling on purpose — that is what the live table actually
holds, and a raw string comparison against a space-separated cutoff would
mis-sort it. `test_cutoff_handles_both_timestamp_spellings` pins that.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import aiosqlite
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import agents as agents_router
from app.services import event_retention_service as svc

pytestmark = pytest.mark.asyncio


# ─── Fixtures / helpers ──────────────────────────────────────────────────────


def _ts(age_days: float, *, sep: str = "T") -> str:
    """A timestamp `age_days` in the past, in `agent_events`' own spelling."""
    moment = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=age_days)
    return moment.isoformat(sep=sep, timespec="seconds")


async def _make_session(
    db: aiosqlite.Connection,
    session_id: str,
    *,
    kind: str = "project",
    total_tool_calls: int = 0,
    project_id: int | None = None,
) -> None:
    await db.execute(
        """INSERT INTO agent_sessions
           (session_id, profile, cwd, status, session_kind, total_tool_calls, project_id)
           VALUES (?, 'test', '/tmp/x', 'ended', ?, ?, ?)""",
        (session_id, kind, total_tool_calls, project_id),
    )
    await db.commit()


async def _make_event(
    db: aiosqlite.Connection,
    session_id: str,
    event_type: str,
    *,
    age_days: float,
    sep: str = "T",
) -> int:
    cursor = await db.execute(
        """INSERT INTO agent_events
           (session_id, event_type, tool_name, summary, payload_json, created_at)
           VALUES (?, ?, NULL, '', '{}', ?)""",
        (session_id, event_type, _ts(age_days, sep=sep)),
    )
    await db.commit()
    event_id = cursor.lastrowid
    assert event_id is not None
    return event_id


async def _event_ids(db: aiosqlite.Connection) -> set[int]:
    async with db.execute("SELECT id FROM agent_events") as cur:
        return {int(row["id"]) for row in await cur.fetchall()}


async def _count(db: aiosqlite.Connection, table: str) -> int:
    async with db.execute(f"SELECT COUNT(*) AS n FROM {table}") as cur:
        row = await cur.fetchone()
    assert row is not None
    return int(row["n"])


# ─── Defaults live in exactly one place ──────────────────────────────────────


async def test_documented_defaults(migrated_db: aiosqlite.Connection) -> None:
    """The documented windows, read from their single definition.

    Four since #175: the three `agent_events` classes plus Lane B's
    `otlp_metric_series`, which shares this mechanism rather than growing a
    second one. Asserted as an exact dict on purpose — a class added without a
    documented default should fail here and be thought about.
    """
    assert svc.default_retention_days() == {
        "session": 90,
        "tool": 30,
        "ephemeral": 7,
        "otlp": 90,
    }
    # And with no app_settings row written, those are what takes effect: a
    # fresh install prunes from the defaults (the choice recorded in
    # `resolve_retention_days`' docstring), it does not wait for a write.
    assert await svc.resolve_retention_days(migrated_db) == svc.default_retention_days()


async def test_ephemeral_window_is_shortest(migrated_db: aiosqlite.Connection) -> None:
    """Ephemeral < tool < session, by default and as an ordering invariant."""
    days = svc.default_retention_days()
    assert days["ephemeral"] < days["tool"] < days["session"]


# ─── Per-class cutoffs ───────────────────────────────────────────────────────


async def test_each_class_uses_its_own_cutoff(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Same-age rows in different classes get different fates."""
    await _make_session(migrated_db, "s-project", kind="project")
    await _make_session(migrated_db, "s-temp", kind="ephemeral")

    # 45 days: past the 30-day tool window, inside the 90-day session window.
    tool_old = await _make_event(migrated_db, "s-project", "PreToolUse", age_days=45)
    prompt_old = await _make_event(
        migrated_db, "s-project", "UserPromptSubmit", age_days=45
    )
    # 10 days: inside every non-ephemeral window, past the 7-day ephemeral one.
    tool_recent = await _make_event(
        migrated_db, "s-project", "PostToolUse", age_days=10
    )
    ephemeral_old = await _make_event(
        migrated_db, "s-temp", "UserPromptSubmit", age_days=10
    )

    result = await svc.prune_agent_events(migrated_db)

    assert result["classes"]["tool"]["rows_deleted"] == 1
    assert result["classes"]["session"]["rows_deleted"] == 0
    assert result["classes"]["ephemeral"]["rows_deleted"] == 1
    assert result["rows_deleted"] == 2

    surviving = await _event_ids(migrated_db)
    assert tool_old not in surviving
    assert ephemeral_old not in surviving
    assert prompt_old in surviving
    assert tool_recent in surviving


async def test_session_class_keeps_events_inside_its_window(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A prompt event only goes once it is past 90 days."""
    await _make_session(migrated_db, "s1")
    inside = await _make_event(migrated_db, "s1", "SessionStart", age_days=89)
    outside = await _make_event(migrated_db, "s1", "SessionEnd", age_days=91)

    result = await svc.prune_agent_events(migrated_db)

    assert result["classes"]["session"]["rows_deleted"] == 1
    surviving = await _event_ids(migrated_db)
    assert inside in surviving
    assert outside not in surviving


async def test_unknown_event_type_falls_into_session_class(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A hook type added later inherits the longest window, not the shortest."""
    await _make_session(migrated_db, "s1")
    newish = await _make_event(migrated_db, "s1", "PreCompact", age_days=45)

    result = await svc.prune_agent_events(migrated_db)

    assert result["rows_deleted"] == 0
    assert newish in await _event_ids(migrated_db)


# ─── Ephemeral precedence ────────────────────────────────────────────────────


async def test_ephemeral_beats_tool_class(migrated_db: aiosqlite.Connection) -> None:
    """A scratch session's tool events age out on 7 days, not 30."""
    await _make_session(migrated_db, "s-temp", kind="ephemeral")
    await _make_session(migrated_db, "s-real", kind="project")

    temp_tool = await _make_event(migrated_db, "s-temp", "PreToolUse", age_days=9)
    real_tool = await _make_event(migrated_db, "s-real", "PreToolUse", age_days=9)

    result = await svc.prune_agent_events(migrated_db)

    # Counted once, in the ephemeral class only — the classes are disjoint.
    assert result["classes"]["ephemeral"]["rows_deleted"] == 1
    assert result["classes"]["tool"]["rows_deleted"] == 0
    assert result["rows_deleted"] == 1

    surviving = await _event_ids(migrated_db)
    assert temp_tool not in surviving
    assert real_tool in surviving


async def test_ephemeral_beats_session_class(migrated_db: aiosqlite.Connection) -> None:
    """A scratch session's non-tool events do not get the 90-day window."""
    await _make_session(migrated_db, "s-temp", kind="ephemeral")
    started = await _make_event(migrated_db, "s-temp", "SessionStart", age_days=30)

    result = await svc.prune_agent_events(migrated_db)

    assert result["classes"]["ephemeral"]["rows_deleted"] == 1
    assert result["classes"]["session"]["rows_deleted"] == 0
    assert started not in await _event_ids(migrated_db)


# ─── Batching ────────────────────────────────────────────────────────────────


async def test_batching_clears_more_than_one_batch(
    migrated_db: aiosqlite.Connection,
) -> None:
    """> `_BATCH_ROWS` expired rows are all removed, across several statements.

    The failure this guards is an implementation that issues one bounded
    DELETE and returns: it would look correct on any small fixture and leave
    a permanent backlog on the live table.
    """
    await _make_session(migrated_db, "s1")

    total = svc._BATCH_ROWS + 137
    created = _ts(45)
    await migrated_db.executemany(
        """INSERT INTO agent_events
           (session_id, event_type, tool_name, summary, payload_json, created_at)
           VALUES ('s1', 'PreToolUse', NULL, '', '{}', ?)""",
        [(created,) for _ in range(total)],
    )
    # One row inside the window, to prove batching does not overrun the cutoff.
    keeper = await _make_event(migrated_db, "s1", "PreToolUse", age_days=1)

    result = await svc.prune_agent_events(migrated_db)

    assert result["classes"]["tool"]["rows_deleted"] == total
    assert result["classes"]["tool"]["batches"] == 2
    assert await _event_ids(migrated_db) == {keeper}


async def test_batch_size_is_bounded(migrated_db: aiosqlite.Connection) -> None:
    """The policy constant the ticket fixes: at most 5,000 rows per statement."""
    assert svc._BATCH_ROWS <= 5000


# ─── Idempotency ─────────────────────────────────────────────────────────────


async def test_prune_is_idempotent(migrated_db: aiosqlite.Connection) -> None:
    """A second immediate run deletes nothing and reports nothing."""
    await _make_session(migrated_db, "s-temp", kind="ephemeral")
    await _make_session(migrated_db, "s1")
    await _make_event(migrated_db, "s-temp", "PreToolUse", age_days=30)
    await _make_event(migrated_db, "s1", "PreToolUse", age_days=45)
    await _make_event(migrated_db, "s1", "SessionEnd", age_days=120)
    keeper = await _make_event(migrated_db, "s1", "UserPromptSubmit", age_days=2)

    first = await svc.prune_agent_events(migrated_db)
    assert first["rows_deleted"] == 3

    second = await svc.prune_agent_events(migrated_db)
    assert second["rows_deleted"] == 0
    for entry in second["classes"].values():
        assert entry["rows_deleted"] == 0
        assert entry["batches"] == 0

    assert await _event_ids(migrated_db) == {keeper}


async def test_prune_on_empty_table(migrated_db: aiosqlite.Connection) -> None:
    """Nothing to do is not an error, and still reports every class."""
    result = await svc.prune_agent_events(migrated_db)
    assert result["rows_deleted"] == 0
    assert set(result["classes"]) == {c.key for c in svc.RETENTION_CLASSES}
    # …which is the three `agent_events` classes plus Lane B's (#175). Derived
    # from the registry rather than relisted, so a new class shows up in the
    # summary automatically — that is the property being asserted here, not
    # the membership, which `test_documented_defaults` pins exactly.
    assert {"session", "tool", "ephemeral", "otlp"} <= set(result["classes"])


# ─── Sessions are never deleted ──────────────────────────────────────────────


async def test_session_rows_survive_losing_every_event(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A session stripped of all events keeps its row, counters and provenance."""
    projects_before = await _count(migrated_db, "projects")
    await migrated_db.execute(
        "INSERT INTO projects (id, name) VALUES (7, 'proj')",
    )
    await _make_session(
        migrated_db, "s1", kind="project", total_tool_calls=42, project_id=7
    )
    await migrated_db.execute(
        "UPDATE agent_sessions SET tokens_in = 100, tokens_out = 200, cost_usd = 1.5"
        " WHERE session_id = 's1'"
    )
    await migrated_db.commit()

    await _make_event(migrated_db, "s1", "PreToolUse", age_days=200)
    await _make_event(migrated_db, "s1", "SessionEnd", age_days=200)

    result = await svc.prune_agent_events(migrated_db)
    assert result["rows_deleted"] == 2
    assert await _count(migrated_db, "agent_events") == 0

    # The session row is untouched in every respect.
    assert await _count(migrated_db, "agent_sessions") == 1
    projects_after = await _count(migrated_db, "projects")
    async with migrated_db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = 's1'"
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["total_tool_calls"] == 42
    assert row["tokens_in"] == 100
    assert row["tokens_out"] == 200
    assert row["cost_usd"] == 1.5
    assert row["project_id"] == 7
    assert row["session_kind"] == "project"

    # And the project it was attributed to is still there.
    assert projects_after == projects_before + 1


async def test_orphaned_event_reads_as_non_ephemeral(
    migrated_db: aiosqlite.Connection,
) -> None:
    """An event whose session is missing ages out on a long window, not 7 days.

    `NOT EXISTS` is what makes this true; `session_id NOT IN (SELECT …)` would
    behave the same here but the point is that a missing session must never be
    treated as scratch, because the shortest window is the destructive one.
    """
    await migrated_db.execute("PRAGMA foreign_keys=OFF")
    orphan = await _make_event(migrated_db, "s-gone", "PreToolUse", age_days=10)
    await migrated_db.execute("PRAGMA foreign_keys=ON")

    result = await svc.prune_agent_events(migrated_db)

    assert result["classes"]["ephemeral"]["rows_deleted"] == 0
    assert result["rows_deleted"] == 0
    assert orphan in await _event_ids(migrated_db)


# ─── Timestamp spellings ─────────────────────────────────────────────────────


async def test_cutoff_handles_both_timestamp_spellings(
    migrated_db: aiosqlite.Connection,
) -> None:
    """`2026-01-01T00:00:00` and `2026-01-01 00:00:00` compare identically.

    `agent_service._now()` writes the `T` form on every hook; the column's
    `DEFAULT CURRENT_TIMESTAMP` writes the space form. `'T'` sorts above
    `' '`, so a raw comparison would keep or delete same-day rows depending
    on which writer produced them.
    """
    await _make_session(migrated_db, "s1")
    t_form = await _make_event(migrated_db, "s1", "PreToolUse", age_days=45, sep="T")
    space_form = await _make_event(
        migrated_db, "s1", "PreToolUse", age_days=45, sep=" "
    )
    t_keep = await _make_event(migrated_db, "s1", "PreToolUse", age_days=1, sep="T")
    space_keep = await _make_event(migrated_db, "s1", "PreToolUse", age_days=1, sep=" ")

    result = await svc.prune_agent_events(migrated_db)

    assert result["classes"]["tool"]["rows_deleted"] == 2
    surviving = await _event_ids(migrated_db)
    assert t_form not in surviving
    assert space_form not in surviving
    assert {t_keep, space_keep} == surviving


# ─── Settings resolution and overrides ───────────────────────────────────────


async def test_stored_setting_overrides_default(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A written window takes effect on the next prune."""
    await _make_session(migrated_db, "s1")
    old_prompt = await _make_event(migrated_db, "s1", "UserPromptSubmit", age_days=20)

    # Default 90 days keeps it.
    assert (await svc.prune_agent_events(migrated_db))["rows_deleted"] == 0

    await svc.set_retention_days(migrated_db, {"session": 10})
    assert (await svc.resolve_retention_days(migrated_db))["session"] == 10

    result = await svc.prune_agent_events(migrated_db)
    assert result["classes"]["session"]["rows_deleted"] == 1
    assert old_prompt not in await _event_ids(migrated_db)


async def test_corrupt_setting_falls_back_to_default(
    migrated_db: aiosqlite.Connection,
) -> None:
    """An unparseable stored value must not crash a background tick."""
    await migrated_db.execute(
        """INSERT INTO app_settings (key, value_json) VALUES
           ('agent_event_tool_retention_days', '"not-a-number"')""",
    )
    await migrated_db.commit()

    assert (await svc.resolve_retention_days(migrated_db))["tool"] == 30


async def test_explicit_override_beats_stored_setting(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The `retention_days=` kwarg wins, so tests and CLI callers can pin it."""
    await _make_session(migrated_db, "s1")
    await svc.set_retention_days(migrated_db, {"tool": 365})
    await _make_event(migrated_db, "s1", "PreToolUse", age_days=100)

    result = await svc.prune_agent_events(migrated_db, retention_days={"tool": 1})

    assert result["classes"]["tool"]["retention_days"] == 1
    assert result["classes"]["tool"]["rows_deleted"] == 1


# ─── CODENEST_DISABLE_SCHEDULE_TICK ──────────────────────────────────────────


async def test_tick_entry_point_respects_disable_flag(
    migrated_db: aiosqlite.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the flag set, the tick entry point deletes nothing and returns None."""
    monkeypatch.setenv("CODENEST_DISABLE_SCHEDULE_TICK", "1")
    await _make_session(migrated_db, "s1")
    stale = await _make_event(migrated_db, "s1", "PreToolUse", age_days=200)

    assert await svc.prune_agent_events_if_enabled(migrated_db) is None
    assert stale in await _event_ids(migrated_db)

    # Direct calls are never gated — that is how these tests reach the prune.
    monkeypatch.delenv("CODENEST_DISABLE_SCHEDULE_TICK")
    result = await svc.prune_agent_events_if_enabled(migrated_db)
    assert result is not None
    assert result["rows_deleted"] == 1


# ─── HTTP API ────────────────────────────────────────────────────────────────


@pytest.fixture
def client(migrated_db: aiosqlite.Connection):
    """A TestClient whose handlers see the migrated test connection.

    The router imports `get_db` by value, so the seam is `database._db` — the
    process-wide connection `get_db` returns when one already exists. Same
    approach `test_session_kind` uses for its hook-ingest tests.
    """
    original = db_module._db
    db_module._db = migrated_db
    try:
        application = FastAPI()
        application.include_router(agents_router.router)
        yield TestClient(application, raise_server_exceptions=True)
    finally:
        db_module._db = original


async def test_get_retention_returns_defaults_and_note(client: TestClient) -> None:
    """GET mirrors the schedules endpoint's shape, one field per class."""
    resp = client.get("/api/v1/agents/retention")
    assert resp.status_code == 200
    body = resp.json()
    assert body["session_retention_days"] == 90
    assert body["tool_retention_days"] == 30
    assert body["ephemeral_retention_days"] == 7
    # The acceptance criterion the response itself has to carry.
    assert "does not shrink" in body["note"]
    assert "VACUUM" in body["note"]


async def test_put_retention_persists_and_echoes_full_policy(
    client: TestClient, migrated_db: aiosqlite.Connection
) -> None:
    """A partial write stores one class and echoes all three."""
    resp = client.put("/api/v1/agents/retention", json={"tool_retention_days": 14})
    assert resp.status_code == 200
    body = resp.json()
    assert body["tool_retention_days"] == 14
    assert body["session_retention_days"] == 90
    assert body["ephemeral_retention_days"] == 7

    async with migrated_db.execute(
        "SELECT value_json FROM app_settings WHERE key = 'agent_event_tool_retention_days'"
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert json.loads(row["value_json"]) == 14

    assert client.get("/api/v1/agents/retention").json()["tool_retention_days"] == 14


@pytest.mark.parametrize("bad", [0, -1, 366, 1000])
async def test_put_retention_rejects_out_of_range(client: TestClient, bad: int) -> None:
    """0 and 366 are both outside the 1–365 range the schedules endpoint uses."""
    resp = client.put("/api/v1/agents/retention", json={"tool_retention_days": bad})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "'tool_retention_days' must be 1–365"


async def test_put_retention_rejects_non_integer(client: TestClient) -> None:
    resp = client.put(
        "/api/v1/agents/retention", json={"session_retention_days": "ninety"}
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "'session_retention_days' must be an integer"


async def test_put_retention_requires_a_field(client: TestClient) -> None:
    resp = client.put("/api/v1/agents/retention", json={"nonsense": 5})
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail.startswith("one of ")
    assert "'tool_retention_days'" in detail
    assert detail.endswith("is required")


async def test_put_retention_rejects_bad_value_before_writing_anything(
    client: TestClient, migrated_db: aiosqlite.Connection
) -> None:
    """A body with one good and one bad field writes neither.

    Validation runs over every class before the first upsert, so a rejected
    body cannot leave the policy half-applied.
    """
    resp = client.put(
        "/api/v1/agents/retention",
        json={"session_retention_days": 30, "tool_retention_days": 999},
    )
    assert resp.status_code == 400

    keys = tuple(c.setting_key for c in svc.RETENTION_CLASSES)
    placeholders = ", ".join("?" * len(keys))
    async with migrated_db.execute(
        f"SELECT COUNT(*) AS n FROM app_settings WHERE key IN ({placeholders})",
        keys,
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["n"] == 0
