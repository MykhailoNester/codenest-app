"""Tests for the 22-event hook registry and its generic recorder (#168).

`hooks_service.HOOK_EVENTS` froze a public shape the rest of P2 builds on, so
these tests are mostly assertions *about the registry itself* rather than about
one code path: the four things below each cost a real defect if they drift, and
three of them are invisible at the call site that would cause them.

1. Every one of the 22 generated commands carries `--max-time` and ends in
   `|| true`. Not a sample — the whole point is that no event can be added
   without both, since either omission puts a stalled or absent sidecar on the
   critical path of a live Claude Code session.
2. The payload allowlist (`agent_service._PAYLOAD_TOP_LEVEL`) covers every
   top-level field the new events carry. An event missing from it still
   ingests, still produces a row, and still passes any "did it record"
   assertion — with its content gone. Only a test that reads the stored
   payload back catches it.
3. The generic recorder never resurrects an `ended` session. `status` is the
   column `cleanup_stale_sessions` sweeps on; an event arriving after
   `SessionEnd` (which `TaskCompleted`, `SubagentStop`, `StopFailure`,
   `Notification` and `PostCompact` routinely do) must be recorded without
   touching it.
4. Widening the registry does not change the verdict `classify_settings_hooks`
   reaches on an existing user's settings.json.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid

import aiosqlite
import httpx
import pytest
from fastapi import FastAPI

import app.database as db_module
from app.routers import agents as agents_router
from app.services import agent_service, event_retention_service, hooks_service

_BASE = "http://127.0.0.1:8002"


def _gen_uuid() -> str:
    return str(uuid.uuid4())


async def _insert_session(
    db: aiosqlite.Connection, session_id: str, status: str = "active"
) -> None:
    await db.execute(
        """INSERT INTO agent_sessions (session_id, profile, cwd, status)
           VALUES (?, 'work', '/tmp/does-not-matter', ?)""",
        (session_id, status),
    )
    await db.commit()


async def _latest_event(
    db: aiosqlite.Connection, session_id: str
) -> aiosqlite.Row | None:
    cur = await db.execute(
        "SELECT * FROM agent_events WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        (session_id,),
    )
    return await cur.fetchone()


# ─── registry shape ──────────────────────────────────────────────────────────


def test_registry_holds_exactly_the_twenty_two_events() -> None:
    names = [spec.event for spec in hooks_service.HOOK_EVENTS]
    assert len(names) == 22
    assert len(set(names)) == 22, "duplicate event name in HOOK_EVENTS"
    assert set(names) == {
        # core — already wired, paths frozen
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
        # extended — #168
        "Notification",
        "Elicitation",
        "PermissionRequest",
        "PermissionDenied",
        "PostToolUseFailure",
        "SubagentStart",
        "SubagentStop",
        "TaskCreated",
        "TaskCompleted",
        "StopFailure",
        "PreCompact",
        "PostCompact",
        "CwdChanged",
        "DirectoryAdded",
        "PreModelSwitch",
        "PostModelSwitch",
    }


def test_events_the_design_triaged_out_are_absent() -> None:
    """The epic's P2 paragraph names these four; the design's triage does not."""
    names = {spec.event for spec in hooks_service.HOOK_EVENTS}
    assert names.isdisjoint(
        {"InstructionsLoaded", "ConfigChange", "WorktreeCreate", "WorktreeRemove"}
    )


def test_core_tier_is_the_original_six_at_their_original_paths() -> None:
    """These six paths sit in real users' settings.json and can never move."""
    core = {spec.event: spec.path for spec in hooks_service.core_events()}
    assert core == {
        "SessionStart": "/api/v1/hooks/session-start",
        "UserPromptSubmit": "/api/v1/hooks/user-prompt",
        "PreToolUse": "/api/v1/hooks/pre-tool",
        "PostToolUse": "/api/v1/hooks/post-tool",
        "Stop": "/api/v1/hooks/stop",
        "SessionEnd": "/api/v1/hooks/session-end",
    }


def test_extended_tier_is_sixteen_events_under_the_event_namespace() -> None:
    extended = hooks_service.extended_events()
    assert len(extended) == 16
    for spec in extended:
        assert spec.path.startswith("/api/v1/hooks/event/"), spec.event
        assert spec.tier == hooks_service.TIER_EXTENDED


def test_every_path_is_distinct() -> None:
    paths = [spec.path for spec in hooks_service.HOOK_EVENTS]
    assert len(set(paths)) == len(paths)


def test_hook_endpoint_path_resolves_both_tiers_and_rejects_unknowns() -> None:
    assert hooks_service.hook_endpoint_path("Stop") == "/api/v1/hooks/stop"
    assert (
        hooks_service.hook_endpoint_path("PermissionDenied")
        == "/api/v1/hooks/event/permission-denied"
    )
    assert hooks_service.hook_endpoint_path("ConfigChange") is None


# ─── the non-blocking discipline, on all 22 ──────────────────────────────────


def test_all_twenty_two_commands_carry_max_time_and_end_in_or_true() -> None:
    """Asserted on every event, not a sample.

    `|| true` is what makes curl exit 0 when the desktop app is offline, so a
    missing sidecar is a silent no-op instead of a hook error in every session;
    `--max-time` is what stops a wedged sidecar from holding the session open
    until the harness kills the command. An event added without either is a
    live-session regression, which is why this iterates the registry rather
    than spot-checking.
    """
    hooks = hooks_service.build_hook_settings(_BASE)["hooks"]
    assert len(hooks) == 22

    for spec in hooks_service.HOOK_EVENTS:
        entries = hooks[spec.event]
        assert len(entries) == 1, spec.event
        entry = entries[0]
        assert entry["matcher"] == "*", spec.event
        assert len(entry["hooks"]) == 1, spec.event
        hook = entry["hooks"][0]

        command = hook["command"]
        assert command.strip().endswith("|| true"), spec.event
        assert f"--max-time {hooks_service._CURL_MAX_TIME}" in command, spec.event
        assert hook["type"] == "command", spec.event
        assert "--data-binary @-" in command, spec.event
        assert f"{_BASE}{spec.path}" in command, spec.event
        # curl must abort before the harness force-kills the command.
        assert hook["timeout"] == hooks_service._HOOK_TIMEOUT, spec.event
        assert hooks_service._CURL_MAX_TIME < hooks_service._HOOK_TIMEOUT


def test_pre_tool_use_is_the_only_event_that_keeps_its_stdout() -> None:
    """21 of 22 discard; `PreToolUse` is the one return channel (#172).

    Claude Code feeds a `SessionStart` / `UserPromptSubmit` hook's stdout back
    into the session as context, so an unredirected response body would land in
    the user's conversation. It reads a `PreToolUse` hook's stdout for a
    permission decision instead, and that protocol is bound to `PreToolUse`
    alone — `PermissionRequest` looks like the event that should carry it and
    does not — so this asserts the exact membership rather than a count.
    """
    undiscarding = {
        spec.event for spec in hooks_service.HOOK_EVENTS if not spec.discards_stdout
    }
    assert undiscarding == {"PreToolUse"}

    hooks = hooks_service.build_hook_settings(_BASE)["hooks"]
    for spec in hooks_service.HOOK_EVENTS:
        command = hooks[spec.event][0]["hooks"][0]["command"]
        if spec.discards_stdout:
            assert ">/dev/null 2>&1" in command, spec.event
        else:
            # stderr is still silenced; it is stdout that must stay open.
            assert ">/dev/null 2>&1" not in command, spec.event
            assert "2>/dev/null" in command, spec.event


def test_the_undiscarded_command_cannot_leak_an_error_body_as_a_decision() -> None:
    """The safety property that makes an open return channel survivable.

    Whatever the undiscarded command prints is read by Claude Code as a hook
    decision, and a FastAPI 500 answers with a JSON error body. `--fail` makes
    curl print nothing at all on an HTTP status >= 400 and exit non-zero, which
    the existing `|| true` swallows; stderr goes to `/dev/null` so a transport
    failure does not paint the terminal either. Offline, slow and throwing all
    have to look identical from the session's side: no output, exit 0.
    """
    undiscarded = hooks_service._curl_command_for_url(f"{_BASE}/x", False)
    assert "--fail" in undiscarded
    assert "2>/dev/null" in undiscarded
    assert ">/dev/null 2>&1" not in undiscarded
    # Dropping the redirect must not cost the command either half of the
    # non-blocking discipline.
    assert undiscarded.strip().endswith("|| true")
    assert "--max-time" in undiscarded


# ─── routes ──────────────────────────────────────────────────────────────────


def test_each_extended_event_has_its_own_post_route() -> None:
    """A literal path per event, not one `{slug}` catch-all."""
    mounted = {
        route.path: route
        for route in agents_router.router.routes
        if "/api/v1/hooks/" in getattr(route, "path", "")
    }
    assert len(mounted) == 22
    for spec in hooks_service.HOOK_EVENTS:
        assert spec.path in mounted, spec.event
        assert "POST" in mounted[spec.path].methods  # type: ignore[attr-defined]
    # No path parameter anywhere in the namespace — an unknown slug must 404.
    assert not any("{" in path for path in mounted)


# ─── payload allowlist ───────────────────────────────────────────────────────


def test_allowlist_covers_every_field_the_new_events_carry() -> None:
    assert {
        "message",
        "notification_type",
        "reason",
        "error",
        "agent_id",
        "agent_type",
        "trigger",
        "new_cwd",
        "to_model",
        "task_id",
        "duration_ms",
    } <= agent_service._PAYLOAD_TOP_LEVEL
    # The original ten are untouched.
    assert {
        "session_id",
        "cwd",
        "hook_event_name",
        "permission_mode",
        "effort",
        "source_kind",
        "source_id",
        "tool_name",
        "tool_use_id",
        "prompt_id",
    } <= agent_service._PAYLOAD_TOP_LEVEL


@pytest.mark.asyncio
async def test_notification_payload_survives_the_trim(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The blocker this allowlist caused: a row that exists and holds nothing."""
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id)
    await agent_service.record_hook_event(
        migrated_db,
        "Notification",
        {
            "session_id": session_id,
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash",
            "notification_type": "permission_request",
        },
    )
    row = await _latest_event(migrated_db, session_id)
    assert row is not None
    stored = json.loads(row["payload_json"])
    assert stored["message"] == "Claude needs your permission to use Bash"
    assert stored["notification_type"] == "permission_request"
    assert row["summary"] == ("Notification: Claude needs your permission to use Bash")


@pytest.mark.asyncio
async def test_post_tool_duration_ms_is_no_longer_dropped(
    migrated_db: aiosqlite.Connection,
) -> None:
    """`PostToolUse` has always emitted it; the allowlist has always eaten it."""
    session_id = _gen_uuid()
    await agent_service.record_post_tool(
        migrated_db,
        {
            "session_id": session_id,
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_use_id": "tu_1",
            "duration_ms": 1234,
        },
    )
    row = await _latest_event(migrated_db, session_id)
    assert row is not None
    assert json.loads(row["payload_json"])["duration_ms"] == 1234


@pytest.mark.asyncio
async def test_every_extended_event_stores_its_own_distinguishing_field(
    migrated_db: aiosqlite.Connection,
) -> None:
    """One round trip per event: does its content actually reach the row."""
    cases: dict[str, tuple[str, object]] = {
        "Notification": ("message", "needs you"),
        "Elicitation": ("message", "pick one"),
        "PermissionRequest": ("tool_name", "Bash"),
        "PermissionDenied": ("reason", "denied by rule"),
        "PostToolUseFailure": ("error", "exit 1"),
        "SubagentStart": ("agent_type", "code-reviewer"),
        "SubagentStop": ("agent_id", "sub_42"),
        "TaskCreated": ("task_id", "t_1"),
        "TaskCompleted": ("task_id", "t_2"),
        "StopFailure": ("error", "stream closed"),
        "PreCompact": ("trigger", "auto"),
        "PostCompact": ("trigger", "manual"),
        "CwdChanged": ("new_cwd", "/repo/sub"),
        "DirectoryAdded": ("new_cwd", "/repo/other"),
        "PreModelSwitch": ("to_model", "claude-opus-5"),
        "PostModelSwitch": ("to_model", "claude-sonnet-4"),
    }
    assert set(cases) == {spec.event for spec in hooks_service.extended_events()}

    for event, (field, value) in cases.items():
        session_id = _gen_uuid()
        await _insert_session(migrated_db, session_id)
        await agent_service.record_hook_event(
            migrated_db,
            event,
            {"session_id": session_id, "hook_event_name": event, field: value},
        )
        row = await _latest_event(migrated_db, session_id)
        assert row is not None, event
        assert row["event_type"] == event
        assert json.loads(row["payload_json"])[field] == value, event
        # The summary is the FTS-indexed, timeline-rendered column: an event
        # whose summary is only its own name is unfindable.
        assert row["summary"].startswith(event), event
        assert str(value) in row["summary"], event


# ─── the recorder must not resurrect an ended session ────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    ["TaskCompleted", "SubagentStop", "StopFailure", "Notification", "PostCompact"],
)
async def test_generic_recorder_never_reopens_an_ended_session(
    migrated_db: aiosqlite.Connection, event: str
) -> None:
    """All five routinely arrive after `SessionEnd`.

    Routed through `_upsert_session_start` — whose UPDATE branch sets
    `status='active'` unconditionally — each would flip a finished session back
    to live, in the exact column `cleanup_stale_sessions` sweeps and the
    Needs-You stalled producer reads.
    """
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, status="ended")
    await migrated_db.execute(
        "UPDATE agent_sessions SET ended_at = '2026-01-01T00:00:00' "
        "WHERE session_id = ?",
        (session_id,),
    )
    await migrated_db.commit()

    await agent_service.record_hook_event(
        migrated_db, event, {"session_id": session_id, "hook_event_name": event}
    )

    cur = await migrated_db.execute(
        "SELECT status, ended_at FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "ended"
    assert row["ended_at"] == "2026-01-01T00:00:00"
    # …and the event is still recorded. Not resurrecting the session must not
    # mean dropping the observation.
    stored = await _latest_event(migrated_db, session_id)
    assert stored is not None and stored["event_type"] == event


@pytest.mark.asyncio
async def test_generic_recorder_advances_last_event_at_on_a_live_session(
    migrated_db: aiosqlite.Connection,
) -> None:
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id)
    await migrated_db.execute(
        "UPDATE agent_sessions SET last_event_at = '2020-01-01T00:00:00' "
        "WHERE session_id = ?",
        (session_id,),
    )
    await migrated_db.commit()

    await agent_service.record_hook_event(
        migrated_db,
        "PreCompact",
        {"session_id": session_id, "hook_event_name": "PreCompact"},
    )

    cur = await migrated_db.execute(
        "SELECT status, last_event_at FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["last_event_at"] > "2020-01-01T00:00:00"
    assert row["status"] == "active"  # unchanged, not re-asserted


@pytest.mark.asyncio
async def test_last_event_at_claim_is_recorded_against_lane_a(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The column write goes through the reconciler, as its docstring asks."""
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id)
    await agent_service.record_hook_event(
        migrated_db,
        "CwdChanged",
        {"session_id": session_id, "hook_event_name": "CwdChanged"},
    )
    cur = await migrated_db.execute(
        "SELECT lane FROM session_field_provenance "
        "WHERE session_id = ? AND field = 'last_event_at'",
        (session_id,),
    )
    row = await cur.fetchone()
    assert row is not None and row["lane"] == "A"


@pytest.mark.asyncio
async def test_unknown_session_gets_a_row_rather_than_losing_the_event(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Hooks pasted mid-session, or a sidecar that was offline at SessionStart.

    `agent_events.session_id` carries an enforced foreign key, so without the
    insert-if-absent the event could not be stored at all.
    """
    session_id = _gen_uuid()
    await agent_service.record_hook_event(
        migrated_db,
        "SubagentStart",
        {
            "session_id": session_id,
            "hook_event_name": "SubagentStart",
            "agent_type": "test-engineer",
        },
    )
    cur = await migrated_db.execute(
        "SELECT status FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    row = await cur.fetchone()
    assert row is not None and row["status"] == "active"
    stored = await _latest_event(migrated_db, session_id)
    assert stored is not None and stored["event_type"] == "SubagentStart"


@pytest.mark.asyncio
async def test_payload_without_session_id_is_ignored(
    migrated_db: aiosqlite.Connection,
) -> None:
    await agent_service.record_hook_event(
        migrated_db, "Notification", {"message": "orphan"}
    )
    cur = await migrated_db.execute("SELECT COUNT(*) AS n FROM agent_events")
    row = await cur.fetchone()
    assert row is not None and row["n"] == 0


# ─── retention class ─────────────────────────────────────────────────────────


def test_reclassified_events_join_the_tool_window() -> None:
    assert set(event_retention_service._TOOL_EVENT_TYPES) == {
        "PreToolUse",
        "PostToolUse",
        "PermissionRequest",
        "PermissionDenied",
        "PostToolUseFailure",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event", "expected_class"),
    [
        ("PermissionRequest", "tool"),
        ("PermissionDenied", "tool"),
        ("PostToolUseFailure", "tool"),
        # Left on the 90-day default by exclusion, correctly — these are
        # session-grain, a few rows per session.
        ("Notification", "session"),
        ("SubagentStop", "session"),
        ("PostCompact", "session"),
    ],
)
async def test_retention_class_assignment_for_new_events(
    migrated_db: aiosqlite.Connection, event: str, expected_class: str
) -> None:
    """Which window a row actually falls in, run through the real prune SQL.

    Asserting on `_TOOL_EVENT_TYPES` alone would not catch a class whose
    `where_sql` stopped reading it, so this drives the prune: an old row of
    this type must be swept by its own class's window and by no other.
    """
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id)
    await migrated_db.execute(
        """INSERT INTO agent_events
           (session_id, event_type, summary, payload_json, created_at)
           VALUES (?, ?, 'x', '{}', '2020-01-01T00:00:00')""",
        (session_id, event),
    )
    await migrated_db.commit()

    summary = await event_retention_service.prune_agent_events(migrated_db)
    by_class = {key: entry["rows_deleted"] for key, entry in summary["classes"].items()}
    assert by_class[expected_class] == 1, summary
    for key, deleted in by_class.items():
        if key != expected_class:
            assert deleted == 0, (key, summary)


# ─── widening must not degrade an existing settings.json verdict ─────────────


def test_a_pre_p2_settings_file_still_grades_ok() -> None:
    """The blocker: every existing install has exactly the core six.

    Grading all 22 would turn every one of them from 'ok' to 'partial' on
    upgrade and light sixteen red chips describing nothing that ever broke.
    That is what `HookEvent.tier` is for.
    """
    six_only = {
        "hooks": {
            spec.event: [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"curl -s {_BASE}{spec.path} || true",
                        }
                    ],
                }
            ]
            for spec in hooks_service.core_events()
        }
    }
    file_status, verdicts, detail = hooks_service.classify_settings_hooks(
        six_only, _BASE
    )
    assert file_status == "ok", (verdicts, detail)
    assert len(verdicts) == 6
    assert {v["event"] for v in verdicts} == {
        spec.event for spec in hooks_service.core_events()
    }
    assert all(v["status"] == "ok" for v in verdicts)


def test_a_missing_core_event_still_reads_partial() -> None:
    """The core tier is still graded — widening loosened nothing."""
    five_only = {
        "hooks": {
            spec.event: [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"curl -s {_BASE}{spec.path} || true",
                        }
                    ],
                }
            ]
            for spec in hooks_service.core_events()
            if spec.event != "Stop"
        }
    }
    file_status, verdicts, _ = hooks_service.classify_settings_hooks(five_only, _BASE)
    assert file_status == "partial"
    assert [v["status"] for v in verdicts if v["event"] == "Stop"] == ["missing"]


def test_stop_and_stop_failure_paths_do_not_match_each_other() -> None:
    """`_endpoint_pattern`'s boundary, against the slugs #168 introduced."""
    stop_only = {
        "hooks": {
            "Stop": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": (
                                f"curl -s {_BASE}/api/v1/hooks/event/stop-failure"
                                " || true"
                            ),
                        }
                    ],
                }
            ]
        }
    }
    _, verdicts, _ = hooks_service.classify_settings_hooks(stop_only, _BASE)
    assert [v["status"] for v in verdicts if v["event"] == "Stop"] == ["missing"]


# ─── concurrency budget ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_twenty_two_concurrent_posts_all_return_inside_the_budget(
    migrated_db: aiosqlite.Connection,
) -> None:
    """One POST per event, all in flight at once, inside the curl `--max-time`.

    This is not a micro-benchmark. The sidecar is a single uvicorn process with
    no `--workers` and one shared `aiosqlite` connection, so these 22 requests
    do not run in parallel — they queue on that connection, and the last one
    served has waited behind all 21 others. A real session fires several of
    these back to back, and every one of them is holding a Claude Code hook
    open while it waits: the budget being asserted here is exactly the
    `--max-time` curl gives up at, per request, measured on the whole batch so
    that serialisation counts against it.
    """
    app = FastAPI()
    app.include_router(agents_router.router)

    original_db = db_module._db
    db_module._db = migrated_db
    try:
        session_id = _gen_uuid()
        await _insert_session(migrated_db, session_id)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            started = time.monotonic()
            responses = await asyncio.gather(
                *(
                    client.post(
                        spec.path,
                        json={
                            "session_id": session_id,
                            "hook_event_name": spec.event,
                        },
                    )
                    for spec in hooks_service.HOOK_EVENTS
                )
            )
            elapsed = time.monotonic() - started

        assert len(responses) == 22
        for response in responses:
            assert response.status_code == 200
            # A hook must never be told to stop, whatever the sidecar did.
            assert response.json()["continue"] is True
        assert elapsed < hooks_service._CURL_MAX_TIME, (
            f"22 concurrent hook POSTs took {elapsed:.2f}s, over the "
            f"{hooks_service._CURL_MAX_TIME}s curl budget"
        )

        cur = await migrated_db.execute(
            "SELECT COUNT(DISTINCT event_type) AS n FROM agent_events "
            "WHERE session_id = ?",
            (session_id,),
        )
        row = await cur.fetchone()
        assert row is not None and row["n"] == 22
    finally:
        db_module._db = original_db
