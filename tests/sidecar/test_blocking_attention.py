"""Blocking attention items and pre-authorisation (#172).

Three things landed together here and they fail in different directions, so
these pin the seams rather than the happy path:

  * **The ingested kinds must survive a refresh.** `_sweep_cleared` closes a
    producer's live rows that the pass did not re-produce. The hook-sourced
    kinds have no producer, so a sweep that ran over them would resolve every
    blocking item the moment anyone opened the page — which is the one bug
    that would look exactly like the feature working and then quietly not.
  * **Dedup and expiry interact.** The partial unique index covers live rows
    only. Expiry has to be a *resolution* rather than a read filter, because
    an expired row that stays live keeps owning its `dedup_key` and the next
    genuine prompt for the same tool would vanish into its `seen_count`.
  * **The `PreToolUse` command cannot leak.** Its stdout is a decision channel
    now. A sidecar that is offline, slow or throwing must produce no output at
    all, which is what `--fail` buys and what the registry test asserts; here
    the route itself is pinned to stay silent when evaluation blows up.
  * **Rule matching is textual and narrow.** First match wins, `allow` and
    `deny` only, one condition, no regex. The dangerous half of that is
    documented in `preauth_service`; the tests keep it from widening by
    accident.

Hook payload timestamps are irrelevant to this file — everything written here
uses `attention_service`'s own space-separated spelling, which is the point of
`test_hook_items_use_the_services_timestamp_spelling`.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import aiosqlite
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import agents as agents_router
from app.routers import attention as attention_router
from app.routers import workspace as workspace_router
from app.services import agent_service, preauth_service
from app.services import attention_service as svc

pytestmark = pytest.mark.asyncio

NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)


async def _session(db: aiosqlite.Connection, session_id: str, **kw) -> None:
    await db.execute(
        "INSERT INTO agent_sessions (session_id, profile, status, started_at, "
        "last_event_at, project_id) VALUES (?, 'test', 'active', ?, ?, ?)",
        (
            session_id,
            NOW.isoformat(timespec="seconds"),
            NOW.isoformat(timespec="seconds"),
            kw.get("project_id"),
        ),
    )


async def _live(db: aiosqlite.Connection) -> list[dict]:
    cur = await db.execute(
        "SELECT * FROM attention_items WHERE state <> 'resolved' ORDER BY id"
    )
    return [dict(r) for r in await cur.fetchall()]


async def _all(db: aiosqlite.Connection) -> list[dict]:
    cur = await db.execute("SELECT * FROM attention_items ORDER BY id")
    return [dict(r) for r in await cur.fetchall()]


# ─── A. Hook-sourced blocking items ──────────────────────────────────────────


@pytest.mark.parametrize(
    ("event", "kind", "requires_response"),
    [
        ("PermissionRequest", "permission_request", 1),
        ("Elicitation", "elicitation", 1),
        ("Notification", "notification", 0),
    ],
)
async def test_each_hook_event_writes_one_blocking_item(
    migrated_db, event: str, kind: str, requires_response: int
) -> None:
    """The three events the design named, each at `blocking`, each with the
    P2-forward columns 013 added for exactly this and P1 never filled.

    `requires_response` separates the two events that are literally holding a
    turn open from the one that is an announcement. It is not "can this app
    answer it" — it cannot answer any of the three.
    """
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db,
        event,
        {"session_id": "s1", "tool_name": "Bash", "message": "may I run this?"},
        now=NOW,
    )
    await db.commit()

    rows = await _live(db)
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == kind
    assert row["severity"] == "blocking"
    assert row["hook_event"] == event
    assert row["requires_response"] == requires_response
    assert row["session_id"] == "s1"
    assert row["expires_at"] is not None
    assert row["seen_count"] == 1


async def test_severity_blocking_finally_has_a_producer(migrated_db) -> None:
    """013 shipped `blocking` with no source and P1 counted it as honestly 0.
    This is the first thing that makes the count non-zero."""
    db = migrated_db
    await _session(db, "s1")
    assert (await svc.counts(db, now=NOW))["blocking"] == 0

    await svc.record_hook_item(
        db, "PermissionRequest", {"session_id": "s1", "tool_name": "Bash"}, now=NOW
    )
    await db.commit()
    counts = await svc.counts(db, now=NOW)
    assert counts["blocking"] == 1
    assert counts["open"] == 1


async def test_redelivery_of_the_same_prompt_bumps_one_row(migrated_db) -> None:
    """Claude Code re-firing a hook for the prompt still on screen must not
    mint a second row — the whole discipline of the partial unique index."""
    db = migrated_db
    await _session(db, "s1")
    payload = {"session_id": "s1", "tool_name": "Bash", "tool_use_id": "tu-1"}
    for _ in range(3):
        await svc.record_hook_item(db, "PermissionRequest", payload, now=NOW)
    await db.commit()

    rows = await _live(db)
    assert len(rows) == 1
    assert rows[0]["seen_count"] == 3


async def test_redelivery_pushes_the_expiry_out(migrated_db) -> None:
    """A prompt that is *still* waiting has not been waiting since the first
    delivery — its clock restarts, or a long wait times itself out mid-wait."""
    db = migrated_db
    await _session(db, "s1")
    payload = {"session_id": "s1", "tool_name": "Bash", "tool_use_id": "tu-1"}
    await svc.record_hook_item(db, "PermissionRequest", payload, now=NOW)
    first = (await _live(db))[0]["expires_at"]
    await svc.record_hook_item(
        db, "PermissionRequest", payload, now=NOW + timedelta(minutes=10)
    )
    await db.commit()
    assert (await _live(db))[0]["expires_at"] > first


async def test_two_different_prompts_in_one_session_are_two_rows(
    migrated_db,
) -> None:
    """The dedup key names a prompt, not a session: two tool calls awaiting
    two decisions are two things a human has to deal with."""
    db = migrated_db
    await _session(db, "s1")
    for tool_use_id in ("tu-1", "tu-2"):
        await svc.record_hook_item(
            db,
            "PermissionRequest",
            {"session_id": "s1", "tool_name": "Bash", "tool_use_id": tool_use_id},
            now=NOW,
        )
    await db.commit()
    assert len(await _live(db)) == 2


async def test_repeated_notification_text_without_an_id_is_still_one_row(
    migrated_db,
) -> None:
    """`Notification` carries no `tool_use_id`, and "Claude is waiting for your
    input" arrives over and over. The fingerprint falls back to a hash of the
    text so that is one row seen many times, not many rows of one sentence."""
    db = migrated_db
    await _session(db, "s1")
    payload = {
        "session_id": "s1",
        "message": "Claude is waiting for your input",
        "notification_type": "idle",
    }
    for _ in range(4):
        await svc.record_hook_item(db, "Notification", payload, now=NOW)
    await db.commit()
    rows = await _live(db)
    assert len(rows) == 1
    assert rows[0]["seen_count"] == 4


async def test_a_payload_with_no_session_is_no_row_and_no_error(
    migrated_db,
) -> None:
    """This runs inside a hook handler. A payload it cannot place costs the
    queue a row and must cost the session nothing."""
    db = migrated_db
    assert await svc.record_hook_item(db, "Notification", {}, now=NOW) is None
    assert await svc.record_hook_item(db, "PostToolUse", {"session_id": "s"}) is None
    assert await _all(db) == []


async def test_the_title_never_carries_a_two_kilobyte_message(
    migrated_db,
) -> None:
    """`agent_service` caps a retained string at 2 KB, which is still a page
    with one row on it if it lands in a title."""
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db,
        "Elicitation",
        {"session_id": "s1", "message": "x" * 2048},
        now=NOW,
    )
    await db.commit()
    row = (await _live(db))[0]
    assert len(row["title"]) <= svc._MAX_TITLE
    assert len(row["detail"]) <= svc._MAX_DETAIL


async def test_hook_items_use_the_services_timestamp_spelling(
    migrated_db,
) -> None:
    """The caller is `agent_service`, whose `_now()` is T-separated. Every
    bound `attention_items` compares against assumes the space-separated one,
    and a table with two spellings is the module header's cautionary tale."""
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db, "PermissionRequest", {"session_id": "s1", "tool_name": "Bash"}, now=NOW
    )
    await db.commit()
    row = (await _live(db))[0]
    for column in ("first_seen_at", "last_seen_at", "expires_at"):
        assert "T" not in row[column], column


async def test_the_item_inherits_the_sessions_project(migrated_db) -> None:
    """Enrichment, never a precondition — but when the session has a project
    the row must carry it, or "Needs You" cannot filter by project."""
    db = migrated_db
    await db.execute("INSERT INTO projects (id, name) VALUES (2, 'codenest-app')")
    await _session(db, "s1", project_id=2)
    await svc.record_hook_item(
        db, "Elicitation", {"session_id": "s1", "message": "which branch?"}, now=NOW
    )
    await db.commit()
    row = (await _live(db))[0]
    assert row["project_id"] == 2
    assert "codenest-app" in row["detail"]


async def test_the_generic_recorder_writes_the_item_in_one_transaction(
    migrated_db,
) -> None:
    """The wiring itself: #168's recorder is what actually runs in production,
    and the attention row has to land beside the `agent_events` row it was read
    from rather than in some later pass."""
    db = migrated_db
    await agent_service.record_hook_event(
        db,
        "PermissionRequest",
        {"session_id": "s-live", "tool_name": "Bash", "tool_use_id": "tu-9"},
    )
    cur = await db.execute(
        "SELECT COUNT(*) AS n FROM agent_events WHERE event_type = 'PermissionRequest'"
    )
    assert (await cur.fetchone())["n"] == 1
    rows = await _live(db)
    assert len(rows) == 1
    assert rows[0]["kind"] == "permission_request"


async def test_an_ordinary_event_writes_no_attention_item(migrated_db) -> None:
    """Only three of the 22 raise items. A recorder that raised one per event
    would put every tool call on the Needs You page."""
    db = migrated_db
    await agent_service.record_hook_event(
        db, "PostToolUse", {"session_id": "s-live", "tool_name": "Read"}
    )
    assert await _all(db) == []


async def test_refresh_does_not_sweep_away_hook_items(migrated_db) -> None:
    """The bug this whole split exists to prevent.

    `_sweep_cleared` resolves a kind's live rows that the pass did not
    re-produce. The ingested kinds have no producer and so produce no keys; a
    sweep over `KINDS` rather than `DERIVED_KINDS` would resolve every blocking
    item on the first refresh — which is to say, the moment anyone opened the
    page that item was written for.
    """
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db, "PermissionRequest", {"session_id": "s1", "tool_name": "Bash"}, now=NOW
    )
    await db.commit()

    result = await svc.refresh(db, now=NOW)
    assert result["blocking"] == 1
    assert result["auto_resolved"] == 0
    rows = await _live(db)
    assert len(rows) == 1
    assert rows[0]["resolution"] is None


# ─── B. Expiry ───────────────────────────────────────────────────────────────


async def test_an_expired_item_is_resolved_not_hidden(migrated_db) -> None:
    """Expiry is a resolution with its own verb, not a read-path filter.

    013's header draws the line it follows: `resolved` is "the condition went
    away", `muted` is "still true, deliberately not shown". A prompt whose
    session has moved on is the first of those, so it leaves a row saying how
    it ended and "resolved today" counts it.
    """
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db, "PermissionRequest", {"session_id": "s1", "tool_name": "Bash"}, now=NOW
    )
    await db.commit()

    later = NOW + timedelta(
        minutes=svc._HOOK_ITEM_TTL_MINUTES["permission_request"] + 1
    )
    result = await svc.refresh(db, now=later)
    assert result["expired"] == 1
    assert result["blocking"] == 0
    rows = await _all(db)
    assert rows[0]["state"] == "resolved"
    assert rows[0]["resolution"] == svc.RESOLUTION_EXPIRED
    assert rows[0]["responded_at"] is None
    assert await svc.list_items(db, state="open") == []


async def test_expiry_releases_the_dedup_key(migrated_db) -> None:
    """The reason it cannot be a read filter.

    The unique index covers live rows only. An expired row left `open` would
    keep owning its key, and the next genuine prompt for the same tool in the
    same session would collide with the invisible corpse and disappear into its
    `seen_count`. Resolving frees the key, so the recurrence is a NEW row with
    `seen_count = 1` — 013's upsert-then-recur, working as designed.
    """
    db = migrated_db
    await _session(db, "s1")
    payload = {"session_id": "s1", "tool_name": "Bash", "tool_use_id": "tu-1"}
    await svc.record_hook_item(db, "PermissionRequest", payload, now=NOW)
    await db.commit()

    later = NOW + timedelta(hours=1)
    await svc.refresh(db, now=later)
    await svc.record_hook_item(db, "PermissionRequest", payload, now=later)
    await db.commit()

    # Scoped to this kind: the refresh above also notices that the fixture's
    # session has been quiet for an hour and raises its own stalled item.
    rows = [r for r in await _all(db) if r["kind"] == "permission_request"]
    assert len(rows) == 2
    assert rows[0]["state"] == "resolved"
    assert rows[0]["dedup_key"] == rows[1]["dedup_key"]
    assert rows[1]["state"] == "open"
    assert rows[1]["seen_count"] == 1


async def test_expiry_leaves_derived_items_alone(migrated_db) -> None:
    """Every P1 item has a NULL `expires_at` and must stay untouched — a task
    does not stop being blocked because a day went by."""
    db = migrated_db
    await db.execute("INSERT INTO projects (id, name) VALUES (2, 'p')")
    await db.execute(
        "INSERT INTO tasks (id, title, status, project_id) "
        "VALUES (1, 't', 'blocked', 2)"
    )
    await db.commit()
    await svc.refresh(db, now=NOW)
    result = await svc.refresh(db, now=NOW + timedelta(days=30))
    assert result["expired"] == 0
    assert result["queued"] == 1


# ─── D. Answering ────────────────────────────────────────────────────────────


async def test_responding_records_the_answer_and_closes_the_row(
    migrated_db,
) -> None:
    """013: P1 writes only `condition_cleared`; P2 adds the human verbs. This
    is the human verb, with the answer and the moment it was given."""
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db, "Elicitation", {"session_id": "s1", "message": "which branch?"}, now=NOW
    )
    await db.commit()
    item_id = (await _live(db))[0]["id"]

    row = await svc.respond(
        db, item_id, response={"answer": "main"}, resolution="answered", now=NOW
    )
    assert row is not None
    assert row["state"] == "resolved"
    assert row["resolution"] == svc.RESOLUTION_ANSWERED
    assert json.loads(row["response_json"]) == {"answer": "main"}
    assert row["responded_at"] is not None
    assert row["resolved_at"] is not None


async def test_dismissing_is_a_different_verb_from_answering(migrated_db) -> None:
    """ "How many of these did anyone actually answer" is the question that
    says whether this queue earns its place, so the two must not merge."""
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db, "Notification", {"session_id": "s1", "message": "hi"}, now=NOW
    )
    await db.commit()
    item_id = (await _live(db))[0]["id"]

    row = await svc.respond(db, item_id, resolution="dismissed", now=NOW)
    assert row is not None
    assert row["resolution"] == svc.RESOLUTION_DISMISSED
    assert row["response_json"] is None
    assert row["responded_at"] is not None


async def test_a_second_answer_to_a_closed_question_is_refused(
    migrated_db,
) -> None:
    """Re-resolving would overwrite the first answer and rewrite when it was
    given. The row is a ledger, not a mutable field."""
    db = migrated_db
    await _session(db, "s1")
    await svc.record_hook_item(
        db, "Elicitation", {"session_id": "s1", "message": "?"}, now=NOW
    )
    await db.commit()
    item_id = (await _live(db))[0]["id"]

    assert await svc.respond(db, item_id, response="first", now=NOW) is not None
    assert await svc.respond(db, item_id, response="second", now=NOW) is None
    rows = await _all(db)
    assert json.loads(rows[0]["response_json"]) == "first"


async def test_respond_rejects_a_resolution_that_is_not_a_human_verb(
    migrated_db,
) -> None:
    """`condition_cleared` and `expired` are the producers' and the sweep's;
    a human writing either would lie about what happened."""
    db = migrated_db
    with pytest.raises(ValueError):
        await svc.respond(db, 1, resolution=svc.RESOLUTION_CONDITION_CLEARED)


async def test_answered_items_do_not_come_back_on_the_next_hook_delivery(
    migrated_db,
) -> None:
    """Answering frees the dedup key the same way expiry does, so a genuinely
    new prompt reappears — which is right — but as a new row rather than by
    resurrecting the answered one and destroying its record."""
    db = migrated_db
    await _session(db, "s1")
    payload = {"session_id": "s1", "tool_name": "Bash", "tool_use_id": "tu-1"}
    await svc.record_hook_item(db, "PermissionRequest", payload, now=NOW)
    await db.commit()
    await svc.respond(db, (await _live(db))[0]["id"], response="yes", now=NOW)

    await svc.record_hook_item(db, "PermissionRequest", payload, now=NOW)
    await db.commit()
    rows = await _all(db)
    assert len(rows) == 2
    assert rows[0]["resolution"] == svc.RESOLUTION_ANSWERED
    assert rows[1]["seen_count"] == 1


# ─── C. Pre-authorisation: the rule vocabulary ───────────────────────────────


async def test_a_tool_only_rule_matches_every_call_to_that_tool() -> None:
    rules = preauth_service.validate_rules(
        [{"tool": "Read", "decision": "allow", "note": "reads are free"}]
    )
    assert preauth_service.decide(rules, "Read", {"file_path": "/x"}) == (
        "allow",
        "Codenest pre-authorisation rule 1: reads are free",
    )
    assert preauth_service.decide(rules, "Bash", {"command": "ls"}) is None


async def test_tool_matching_is_case_insensitive_and_never_a_glob() -> None:
    """Case folding is a convenience; a glob would be a trap — `Bash*` would
    silently never match and read to its author as though it did."""
    rules = preauth_service.validate_rules([{"tool": "bash", "decision": "deny"}])
    assert preauth_service.decide(rules, "Bash", {}) == (
        "deny",
        "Codenest pre-authorisation rule 1: bash",
    )
    with pytest.raises(HTTPException):
        preauth_service.validate_rules([{"tool": "Bash*", "decision": "allow"}])


@pytest.mark.parametrize(
    ("operator", "value", "command", "matches"),
    [
        ("equals", "git status", "git status", True),
        ("equals", "git status", "git status -s", False),
        ("prefix", "git status", "git status -s", True),
        ("prefix", "git status", "cd x && git status", False),
        ("contains", "pytest", "cd x && pytest -q", True),
        ("contains", "pytest", "cd x && ruff check", False),
    ],
)
async def test_the_three_operators_are_plain_string_operations(
    operator: str, value: str, command: str, matches: bool
) -> None:
    """No regex, ever: this runs on the critical path of every tool call in
    every session, and a user-supplied pattern there is a stall waiting to be
    written."""
    rules = preauth_service.validate_rules(
        [
            {
                "tool": "Bash",
                "decision": "allow",
                "field": "command",
                "operator": operator,
                "value": value,
            }
        ]
    )
    verdict = preauth_service.decide(rules, "Bash", {"command": command})
    assert (verdict is not None) is matches


async def test_first_match_wins_so_a_narrow_deny_can_qualify_a_broad_allow() -> None:
    """Order is the only way to express an exception, which is why the rule
    set is written whole rather than per-rule."""
    rules = preauth_service.validate_rules(
        [
            {
                "tool": "Bash",
                "decision": "deny",
                "field": "command",
                "operator": "contains",
                "value": "push --force",
            },
            {
                "tool": "Bash",
                "decision": "allow",
                "field": "command",
                "operator": "prefix",
                "value": "git ",
            },
        ]
    )
    assert (
        preauth_service.decide(rules, "Bash", {"command": "git status"})[0] == "allow"
    )
    assert (
        preauth_service.decide(rules, "Bash", {"command": "git push --force"})[0]
        == "deny"
    )


async def test_a_conditioned_rule_does_not_match_a_call_with_no_such_field() -> None:
    """The safe direction for `allow` and the honest one for `deny`: a rule
    that asks a question about the input has not been answered by a call that
    has no input."""
    rules = preauth_service.validate_rules(
        [
            {
                "tool": "*",
                "decision": "allow",
                "field": "command",
                "operator": "prefix",
                "value": "ls",
            }
        ]
    )
    assert preauth_service.decide(rules, "Read", {"file_path": "/x"}) is None
    assert preauth_service.decide(rules, "Bash", None) is None
    assert preauth_service.decide(rules, "Bash", {"command": "ls -la"}) is not None


async def test_ask_is_not_a_decision_and_a_partial_condition_is_rejected() -> None:
    """`ask` is what already happens when nothing matches. A half-written
    condition is rejected rather than dropped, because a rule meant to be
    narrow and stored broad is an `allow` that grants more than its author
    read it as granting."""
    with pytest.raises(HTTPException):
        preauth_service.validate_rules([{"tool": "Bash", "decision": "ask"}])
    with pytest.raises(HTTPException):
        preauth_service.validate_rules(
            [{"tool": "Bash", "decision": "allow", "field": "command"}]
        )
    with pytest.raises(HTTPException):
        preauth_service.validate_rules(
            [
                {
                    "tool": "Bash",
                    "decision": "allow",
                    "field": "command",
                    "operator": "regex",
                    "value": "^git",
                }
            ]
        )


async def test_the_rule_set_is_capped() -> None:
    """Not a limit anyone meets by hand; a guard so a bad import cannot turn
    the tool-call path into a scan of thousands of comparisons."""
    too_many = [{"tool": "Read", "decision": "allow"}] * (
        preauth_service._MAX_RULES + 1
    )
    with pytest.raises(HTTPException):
        preauth_service.validate_rules(too_many)


async def test_hook_response_names_the_event_it_decides_for() -> None:
    """`hookEventName` is part of the protocol, not decoration — the decision
    is only honoured for the event it names. And `continue` stays true for a
    `deny`: refusing one tool call is not stopping the session."""
    body = preauth_service.hook_response("deny", "because")
    assert body["continue"] is True
    assert body["hookSpecificOutput"] == {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "because",
    }


# ─── C. Pre-authorisation: storage and the hook path ─────────────────────────


@pytest.fixture(autouse=True)
def _clean_rule_cache():
    """The cache is process-global by design (one uvicorn process, no
    workers), which makes it shared state between tests."""
    preauth_service.invalidate_cache()
    yield
    preauth_service.invalidate_cache()


async def test_saving_rules_normalises_and_invalidates_the_cache(
    migrated_db,
) -> None:
    db = migrated_db
    assert await preauth_service.load_rules(db) == []
    saved = await preauth_service.save_rules(
        db, [{"tool": "  Read  ", "decision": "allow"}]
    )
    assert saved == [{"tool": "read", "decision": "allow"}]
    # Without the invalidation the empty read above would still be in force,
    # and a user who saved a rule would watch it not apply.
    assert await preauth_service.load_rules(db) == saved


async def test_an_unreadable_stored_rule_set_disables_rules_not_tool_calls(
    migrated_db,
) -> None:
    """A hand-edited database must not be able to break every tool call. A
    rule the loader cannot read is a rule it does not apply."""
    db = migrated_db
    await db.execute(
        "INSERT INTO app_settings (key, value_json) VALUES (?, ?)",
        (preauth_service.SETTING_KEY, "{not json"),
    )
    await db.commit()
    assert await preauth_service.load_rules(db, use_cache=False) == []

    await db.execute(
        "UPDATE app_settings SET value_json = ? WHERE key = ?",
        (
            json.dumps([{"tool": "Read", "decision": "maybe"}, {"nope": 1}]),
            preauth_service.SETTING_KEY,
        ),
    )
    await db.commit()
    assert await preauth_service.load_rules(db, use_cache=False) == []


async def test_evaluate_says_nothing_when_there_are_no_rules(migrated_db) -> None:
    """The case every install is in until someone writes a rule, and the one
    that has to cost nothing."""
    db = migrated_db
    assert await preauth_service.evaluate(db, {"tool_name": "Bash"}) is None
    assert await preauth_service.evaluate(db, {}) is None


# ─── C. Pre-authorisation: the route ─────────────────────────────────────────


@pytest.fixture
def client(migrated_db: aiosqlite.Connection):
    """A TestClient over the three routers this ticket touches, wired to the
    migrated connection the same way `test_attention` does it."""
    original = db_module._db
    db_module._db = migrated_db
    try:
        application = FastAPI()
        application.include_router(agents_router.router)
        application.include_router(attention_router.router)
        application.include_router(workspace_router.router)
        yield TestClient(application, raise_server_exceptions=False)
    finally:
        db_module._db = original


async def test_pre_tool_says_nothing_when_no_rule_matches(client: TestClient) -> None:
    """This body is now the hook's stdout for every tool call on the machine.
    With no rule it must be the plain continue it has always been — no
    `hookSpecificOutput`, so Claude Code asks the human as it would have."""
    body = client.post(
        "/api/v1/hooks/pre-tool",
        json={"session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "ls"}},
    ).json()
    assert body == {"continue": True}


async def test_pre_tool_returns_the_decision_when_a_rule_matches(
    client: TestClient,
) -> None:
    saved = client.put(
        "/api/v1/workspace/hooks/preauth",
        json={
            "rules": [
                {
                    "tool": "Bash",
                    "decision": "allow",
                    "field": "command",
                    "operator": "prefix",
                    "value": "git status",
                    "note": "read-only git",
                }
            ]
        },
    )
    assert saved.status_code == 200

    body = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": "s1",
            "tool_name": "Bash",
            "tool_input": {"command": "git status -s"},
        },
    ).json()
    assert body["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert "read-only git" in body["hookSpecificOutput"]["permissionDecisionReason"]


async def test_pre_tool_decides_nothing_when_evaluation_blows_up(
    client: TestClient, monkeypatch
) -> None:
    """The safety rule that outranks the feature. Whatever this route returns
    is fed to Claude Code as a decision, so a broken evaluator must produce a
    plain continue — never a partial or invented decision."""

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("rules table is on fire")

    monkeypatch.setattr(preauth_service, "evaluate", _boom)
    response = client.post(
        "/api/v1/hooks/pre-tool", json={"session_id": "s1", "tool_name": "Bash"}
    )
    assert response.status_code == 200
    assert response.json() == {"continue": True}


async def test_the_preauth_endpoint_rejects_a_rule_the_evaluator_could_not_run(
    client: TestClient,
) -> None:
    response = client.put(
        "/api/v1/workspace/hooks/preauth",
        json={"rules": [{"tool": "Bash", "decision": "sure"}]},
    )
    assert response.status_code == 422
    assert client.get("/api/v1/workspace/hooks/preauth").json()["rules"] == []


async def test_respond_route_closes_the_item_and_404s_the_second_time(
    client: TestClient, migrated_db: aiosqlite.Connection
) -> None:
    await _session(migrated_db, "s1")
    await svc.record_hook_item(
        migrated_db,
        "Elicitation",
        {"session_id": "s1", "message": "which branch?"},
        now=NOW,
    )
    await migrated_db.commit()
    item_id = (await _live(migrated_db))[0]["id"]

    ok = client.post(
        f"/api/v1/attention/{item_id}/respond",
        json={"response": {"answer": "main"}, "resolution": "answered"},
    )
    assert ok.status_code == 200
    assert ok.json()["item"]["resolution"] == "answered"

    again = client.post(
        f"/api/v1/attention/{item_id}/respond", json={"resolution": "answered"}
    )
    assert again.status_code == 404


async def test_respond_route_rejects_a_non_human_resolution(client: TestClient) -> None:
    response = client.post(
        "/api/v1/attention/1/respond", json={"resolution": "condition_cleared"}
    )
    assert response.status_code == 422
