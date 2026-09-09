"""Agent Command Center service.

Ingests Claude Code (and compatible) hook payloads, persists session/event state,
and broadcasts changes to in-process subscribers (used by the SSE endpoint).
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import HTTPException

from app.models.session_end_reason import EndCategory, classify

from . import attribution_service, budget_service, notification_service

# ─── Pub/sub ────────────────────────────────────────────────────────────────

_subscribers: set[asyncio.Queue[dict]] = set()


def subscribe() -> asyncio.Queue[dict]:
    q: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue[dict]) -> None:
    _subscribers.discard(q)


def _publish(message: dict) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            # Drop the slowest subscriber rather than block the hook
            _subscribers.discard(q)


# ─── Helpers ────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")


_profile_cache: dict[str, str] = {}


def invalidate_profile_cache() -> None:
    """Drop the per-transcript-path → profile-name cache.

    Called by `profile_service` whenever a profile row is created,
    updated, or deleted so a stale cached match (especially after a
    `claude_config_dir` change) cannot leak into newly recorded
    sessions.
    """
    _profile_cache.clear()


async def _derive_profile(db: aiosqlite.Connection, transcript_path: str | None) -> str:
    if not transcript_path:
        return "unknown"
    cached = _profile_cache.get(transcript_path)
    if cached is not None:
        return cached
    try:
        rows = await db.execute(
            "SELECT name, claude_config_dir FROM profiles "
            "WHERE claude_config_dir IS NOT NULL AND claude_config_dir != '' "
            "ORDER BY created_at ASC, id ASC"
        )
        profiles = await rows.fetchall()
    except Exception:  # noqa: BLE001
        # DB unavailable (e.g. mid-migration) — never block hook ingest.
        return "unknown"
    for profile in profiles:
        if profile["claude_config_dir"] in transcript_path:
            _profile_cache[transcript_path] = profile["name"]
            return profile["name"]
    _profile_cache[transcript_path] = "unknown"
    return "unknown"


async def _match_project(db: aiosqlite.Connection, cwd: str | None) -> int | None:
    if not cwd:
        return None
    # ORDER BY LENGTH(path) DESC so first match is the most specific (longest) path
    rows = await db.execute(
        "SELECT id, path FROM projects WHERE path IS NOT NULL AND path != '' ORDER BY LENGTH(path) DESC"
    )
    projects = await rows.fetchall()
    for proj in projects:
        path = proj["path"].rstrip("/")
        if not path or path == ".":
            continue
        if path in cwd:
            return proj["id"]
    # Fallback to Codenest root project if cwd is somewhere under it
    if "/Codenest" in cwd:
        row = await db.execute("SELECT id FROM projects WHERE name = 'Codenest'")
        codenest = await row.fetchone()
        if codenest:
            return codenest["id"]
    return None


def _truncate(text: str | None, n: int = 140) -> str:
    if not text:
        return ""
    text = text.replace("\n", " ").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def _summarize_tool_input(tool_name: str, tool_input: Any) -> str:
    if not isinstance(tool_input, dict):
        return _truncate(str(tool_input))
    name = (tool_name or "").lower()
    if name == "bash":
        return _truncate(tool_input.get("command"))
    if name in ("read", "edit", "write", "notebookedit"):
        return _truncate(tool_input.get("file_path"))
    if name == "grep":
        pat = tool_input.get("pattern") or ""
        path = tool_input.get("path") or ""
        return _truncate(f"{pat}  in  {path}".strip())
    if name == "glob":
        return _truncate(tool_input.get("pattern"))
    if name == "agent":
        return _truncate(tool_input.get("description") or tool_input.get("prompt"))
    if name == "webfetch":
        return _truncate(tool_input.get("url"))
    if name == "websearch":
        return _truncate(tool_input.get("query"))
    if name == "task":
        return _truncate(tool_input.get("description") or tool_input.get("subject"))
    if name == "skill":
        return _truncate(tool_input.get("skill"))
    # Generic fallback — first string value
    for v in tool_input.values():
        if isinstance(v, str) and v.strip():
            return _truncate(v)
    return ""


# ─── Persistence ────────────────────────────────────────────────────────────


async def _get_session(db: aiosqlite.Connection, session_id: str):
    row = await db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    return await row.fetchone()


async def _upsert_session_start(
    db: aiosqlite.Connection,
    session_id: str,
    cwd: str | None,
    transcript_path: str | None,
) -> None:
    from . import provider_service  # local import to avoid circular dep

    profile = await _derive_profile(db, transcript_path)
    project_id = await _match_project(db, cwd)
    provider_id = await provider_service.resolve_profile_to_provider(db, profile)
    now = _now()
    existing = await _get_session(db, session_id)
    if existing:
        # Only overwrite provider_id when the existing row has none — we never
        # want to clobber a value that was already correctly set (e.g. by an
        # earlier upsert or by the Stop hook for a model-only provider).
        # Profile resolution is authoritative for work/personal; leave others
        # (provider_id already set by model lookup) untouched.
        await db.execute(
            """UPDATE agent_sessions
               SET status='active', last_event_at=?,
                   cwd=COALESCE(?, cwd),
                   transcript_path=COALESCE(?, transcript_path),
                   profile=CASE WHEN profile='unknown' THEN ? ELSE profile END,
                   provider_id=COALESCE(provider_id, ?),
                   project_id=COALESCE(project_id, ?)
               WHERE session_id=?""",
            (now, cwd, transcript_path, profile, provider_id, project_id, session_id),
        )
    else:
        await db.execute(
            """INSERT INTO agent_sessions
               (session_id, profile, cwd, transcript_path, status,
                started_at, last_event_at, project_id, provider_id)
               VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)""",
            (
                session_id,
                profile,
                cwd,
                transcript_path,
                now,
                now,
                project_id,
                provider_id,
            ),
        )


def _provenance_value(payload: dict, key: str) -> str | None:
    """Return `payload[key]` stored verbatim, or None when the hook proves nothing.

    A non-`str` value (missing key, `None`, a number, a nested object — see the
    UserPromptSubmit/PreToolUse/Stop payload shapes) and a string that is blank
    after `.strip()` both normalise to `None`. This never returns the literal
    `"unknown"`: unlike `profile`, which defaults to that string elsewhere in
    this table, provenance must keep "we were not told" (`None`) distinguishable
    from "the client said unknown" (a stored `"unknown"` string, which this
    function passes through unchanged if that is genuinely what the hook sent).
    """
    value = payload.get(key)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


async def _record_provenance(
    db: aiosqlite.Connection, session_id: str, payload: dict
) -> None:
    """Store last-known `permission_mode` / `effort` from a hook payload.

    Called from `record_user_prompt`, `record_pre_tool` and `record_stop` —
    the three hooks whose payloads the live-DB sample shows actually carrying
    either field. Uses `COALESCE(?, column)` so a hook that omits a field
    leaves the stored value alone (a later hook cannot erase what an earlier
    one set), while a hook that carries a *different* value overwrites: both
    permission mode and effort genuinely change mid-session (permission mode
    has a live switch — see `frontend/src/lib/ipc.ts`), so last-known is the
    useful reading for a live session, not first-write.

    The `try`/`except` here — not left to the router's `_safe_handle` — is
    deliberate: `_safe_handle` reaches its `{"continue": true}` response by
    rolling back the *shared* connection, which would discard the whole
    hook's uncommitted work (the `agent_events` row, the `current_tool`
    transition, `last_event_at`). Guarding only this single UPDATE lets a
    database that has not yet run `009_agent_sessions_provenance` still
    commit everything else via the caller's own `db.commit()`. No commit
    happens in here — this statement rides inside the caller's transaction.
    """
    permission_mode = _provenance_value(payload, "permission_mode")
    effort = _provenance_value(payload, "effort")
    if permission_mode is None and effort is None:
        return
    try:
        await db.execute(
            """UPDATE agent_sessions
               SET permission_mode = COALESCE(?, permission_mode),
                   effort          = COALESCE(?, effort)
             WHERE session_id = ?""",
            (permission_mode, effort, session_id),
        )
    except Exception:  # noqa: BLE001, S110
        # Column not yet present (009_agent_sessions_provenance pending) — non-fatal.
        pass


# ─── Payload trim ───────────────────────────────────────────────────────────
#
# `agent_events.payload_json` used to store the hook payload verbatim, which
# means every `tool_response` (command output, file contents, search results)
# and every future field a Claude Code hook version adds landed on disk
# forever. The functions below are the single allowlist that decides what
# survives; `_append_event` is the single call site (#159).

# Top-level hook-payload keys kept verbatim. Allowlist, not denylist: an
# unknown field a future Claude Code version adds is dropped by default.
_PAYLOAD_TOP_LEVEL: frozenset[str] = frozenset(
    {
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
    }
)
# Per-tool tool_input allowlist, keyed by lowercased tool_name.
_TOOL_INPUT_KEEP: dict[str, frozenset[str]] = {
    "todowrite": frozenset({"todos"}),
    "task": frozenset({"subagent_type", "name", "description"}),
    "agent": frozenset({"subagent_type", "name", "description"}),
}
_MAX_PAYLOAD_STR = 2048  # characters (~2 KB ASCII), per retained string


def _cap_value(value: Any) -> tuple[Any, bool]:
    """Recursively cap every string at _MAX_PAYLOAD_STR.

    Returns (capped value, cut) where `cut` is True if any string was sliced.
    dicts and lists are rebuilt (never mutated); other scalars pass through.
    """
    if isinstance(value, str):
        if len(value) > _MAX_PAYLOAD_STR:
            return value[:_MAX_PAYLOAD_STR], True
        return value, False
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        cut = False
        for k, v in value.items():
            capped, child_cut = _cap_value(v)
            out[k] = capped
            cut = cut or child_cut
        return out, cut
    if isinstance(value, (list, tuple)):
        items: list[Any] = []
        cut = False
        for item in value:
            capped, child_cut = _cap_value(item)
            items.append(capped)
            cut = cut or child_cut
        return items, cut
    return value, False


def _trim_event_payload(tool_name: str | None, payload: Any) -> dict[str, Any]:
    """Return the storable projection of a hook payload.

    Called from _append_event immediately before json.dumps so no caller can
    bypass it. NOTE: `_summarize_tool_input` and
    `attribution_service.extract_touched_path` read the UNTRIMMED payload and
    run before the insert — do not move this into the record_* recorders.
    """
    if not isinstance(payload, dict):
        return {}

    dropped = False
    out: dict[str, Any] = {}
    for key, value in payload.items():
        if key in _PAYLOAD_TOP_LEVEL:
            capped, cut = _cap_value(value)
            out[key] = capped
            dropped = dropped or cut
        else:
            dropped = True

    name = tool_name or payload.get("tool_name") or ""
    name = name.lower() if isinstance(name, str) else ""
    keep_set = _TOOL_INPUT_KEEP.get(name)
    tool_input = payload.get("tool_input")
    if keep_set is not None and isinstance(tool_input, dict):
        kept: dict[str, Any] = {}
        for k, v in tool_input.items():
            if k in keep_set:
                capped, cut = _cap_value(v)
                kept[k] = capped
                dropped = dropped or cut
            else:
                dropped = True
        if kept:
            out["tool_input"] = kept

    if dropped:
        out["truncated"] = True
    return out


async def _append_event(
    db: aiosqlite.Connection,
    session_id: str,
    event_type: str,
    tool_name: str | None,
    tool_use_id: str | None,
    summary: str,
    payload: dict,
    project_id: int | None = None,
) -> int:
    trimmed = _trim_event_payload(tool_name, payload)
    cursor = await db.execute(
        """INSERT INTO agent_events
           (session_id, event_type, tool_name, tool_use_id, summary, payload_json, created_at, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session_id,
            event_type,
            tool_name,
            tool_use_id,
            summary,
            json.dumps(trimmed, default=str),
            _now(),
            project_id,
        ),
    )
    event_id = cursor.lastrowid
    assert event_id is not None
    return event_id


async def _broadcast(
    db: aiosqlite.Connection, session_id: str, event_id: int | None, kind: str
) -> None:
    session = await _get_session(db, session_id)
    if not session:
        return
    msg: dict[str, Any] = {"kind": kind, "session": dict(session)}
    if event_id is not None:
        row = await db.execute("SELECT * FROM agent_events WHERE id = ?", (event_id,))
        ev = await row.fetchone()
        if ev:
            msg["event"] = dict(ev)
    # Per-pane session-state strip (C2). Only computed when someone is
    # listening — _publish drops the message otherwise anyway, and this runs
    # on the hook request path that Claude Code blocks on (D4). The key is
    # omitted entirely (not set to `null`) when the session resolves to no
    # pane — e.g. a `claude` started by hand, or a headless scheduled run —
    # so consumers can treat "no hud key" as "no update" (C2).
    if _subscribers:
        from . import session_hud_service  # local import: avoids a module-level cycle

        try:
            hud = await session_hud_service.build_hud_for_session(db, session_id)
        except Exception:  # noqa: BLE001 — the strip must never break ingest
            hud = None
        if hud is not None:
            msg["hud"] = hud
    _publish(msg)


# ─── Hook handlers ──────────────────────────────────────────────────────────


async def record_session_start(db: aiosqlite.Connection, payload: dict) -> None:
    session_id = payload.get("session_id")
    if not session_id:
        return

    # Snapshot existence BEFORE upserting so we can detect a brand-new row
    # below (i.e. a /clear restart that brings a fresh session_id).
    existing_before = await _get_session(db, session_id)

    await _upsert_session_start(
        db,
        session_id,
        payload.get("cwd"),
        payload.get("transcript_path"),
    )

    # If this session_id was not previously known it might be a /clear restart
    # inside a still-running PTY pane.  Re-link the existing agent_runs row to
    # the new session_id so the Agents panel does not show a stale 'running'
    # entry alongside a new orphan session.
    if existing_before is None:
        from . import agent_runs_service  # local import to avoid circular dep

        cwd = payload.get("cwd")
        pane_id = await agent_runs_service.relink_run_to_session(db, session_id, cwd)
        if pane_id:
            # Stamp pane_id on the new agent_sessions row so subsequent /clear
            # relinks can use the deterministic pane_id path instead of the
            # cwd heuristic.  Guard against DBs that have not yet run the
            # 001_agent_sessions_pane_id migration.
            try:
                await db.execute(
                    "UPDATE agent_sessions SET pane_id = ? WHERE session_id = ?",
                    (pane_id, session_id),
                )
                await db.commit()
            except Exception:  # noqa: BLE001, S110
                # Column not yet present (migration pending) — non-fatal.
                pass

    event_id = await _append_event(
        db, session_id, "SessionStart", None, None, "Session started", payload
    )
    await db.commit()
    await _broadcast(db, session_id, event_id, "session_started")


async def record_user_prompt(db: aiosqlite.Connection, payload: dict) -> None:
    session_id = payload.get("session_id")
    if not session_id:
        return
    await _upsert_session_start(
        db, session_id, payload.get("cwd"), payload.get("transcript_path")
    )
    await _record_provenance(db, session_id, payload)
    prompt = (payload.get("prompt") or "").strip()
    summary = _truncate(prompt, 200)
    if prompt:
        # initial_prompt holds the LATEST user prompt (kept under that column name
        # for schema stability) — gives the detail panel a current headline.
        await db.execute(
            "UPDATE agent_sessions SET initial_prompt = ?, last_event_at = ?, status='active' WHERE session_id = ?",
            (prompt, _now(), session_id),
        )
    else:
        await db.execute(
            "UPDATE agent_sessions SET last_event_at = ?, status='active' WHERE session_id = ?",
            (_now(), session_id),
        )
    event_id = await _append_event(
        db, session_id, "UserPromptSubmit", None, None, summary, payload
    )
    await db.commit()
    await _broadcast(db, session_id, event_id, "prompt")


async def record_pre_tool(db: aiosqlite.Connection, payload: dict) -> None:
    session_id = payload.get("session_id")
    if not session_id:
        return
    await _upsert_session_start(
        db, session_id, payload.get("cwd"), payload.get("transcript_path")
    )
    await _record_provenance(db, session_id, payload)
    tool_name = payload.get("tool_name")
    tool_use_id = payload.get("tool_use_id")
    tool_input = payload.get("tool_input")
    detail = _summarize_tool_input(tool_name or "", tool_input)
    summary = f"{tool_name}: {detail}" if detail else (tool_name or "tool")
    now = _now()
    await db.execute(
        """UPDATE agent_sessions
           SET current_tool=?, current_tool_use_id=?, current_tool_started_at=?,
               last_event_at=?, status='active'
           WHERE session_id=?""",
        (tool_name, tool_use_id, now, now, session_id),
    )
    event_id = await _append_event(
        db, session_id, "PreToolUse", tool_name, tool_use_id, summary, payload
    )
    await db.commit()
    await _broadcast(db, session_id, event_id, "pre_tool")


async def record_post_tool(db: aiosqlite.Connection, payload: dict) -> None:
    session_id = payload.get("session_id")
    if not session_id:
        return
    await _upsert_session_start(
        db, session_id, payload.get("cwd"), payload.get("transcript_path")
    )
    tool_name = payload.get("tool_name")
    tool_use_id = payload.get("tool_use_id")
    summary = f"{tool_name} done" if tool_name else "tool done"
    now = _now()
    await db.execute(
        """UPDATE agent_sessions
           SET current_tool=NULL, current_tool_use_id=NULL, current_tool_started_at=NULL,
               last_event_at=?, total_tool_calls=total_tool_calls + 1
           WHERE session_id=?""",
        (now, session_id),
    )
    # Per-project attribution: tag the event with the project behind the file
    # this tool touched (symlink-resolved). NULL when it maps to no project.
    touched = attribution_service.extract_touched_path(
        tool_name, payload.get("tool_input"), payload.get("cwd")
    )
    project_id = await attribution_service.resolve_path_to_project(db, touched)
    event_id = await _append_event(
        db,
        session_id,
        "PostToolUse",
        tool_name,
        tool_use_id,
        summary,
        payload,
        project_id=project_id,
    )
    await db.commit()
    await _broadcast(db, session_id, event_id, "post_tool")


def _read_last_turn_usage(transcript_path: str | None) -> tuple[dict, str | None]:
    """Return (usage dict, model) from the last assistant entry in the transcript JSONL.

    The Stop hook payload carries no usage — we have to read it from the file.
    Returns ({}, None) if the file is missing or malformed.
    """
    if not transcript_path:
        return {}, None
    try:
        with open(transcript_path, encoding="utf-8") as fh:
            last_usage: dict = {}
            last_model: str | None = None
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "assistant":
                    msg = obj.get("message") or {}
                    if msg.get("usage"):
                        last_usage = msg["usage"]
                    if msg.get("model"):
                        last_model = msg["model"]
            return last_usage, last_model
    except OSError:
        return {}, None


async def record_stop(db: aiosqlite.Connection, payload: dict) -> None:
    session_id = payload.get("session_id")
    if not session_id:
        return
    await _upsert_session_start(
        db, session_id, payload.get("cwd"), payload.get("transcript_path")
    )
    await _record_provenance(db, session_id, payload)
    now = _now()
    # Stop hook payload has no usage — read the last turn's usage from the transcript.
    usage, transcript_model = _read_last_turn_usage(payload.get("transcript_path"))
    tokens_in = int(usage.get("input_tokens", 0) or 0)
    tokens_out = int(usage.get("output_tokens", 0) or 0)
    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    # KNOWN DEFECT, tracked separately and deliberately NOT fixed here: this
    # prices every model at Sonnet 4 rates ($3/M input, cached $0.30/M, $15/M
    # output) regardless of which model actually ran. See the session-state
    # HUD plan's Follow-ups / session_hud_service.py's cost_usd comment.
    cost_delta = (tokens_in * 3 + cache_read * 0.30 + tokens_out * 15) / 1_000_000
    cache_creation = int(usage.get("cache_creation_input_tokens", 0) or 0)
    # Context occupancy = the whole prompt the model saw on this turn.
    # Overwritten (not summed) every Stop — unlike tokens_in/tokens_out, which
    # are running sums. A turn with no usage at all (unreadable transcript)
    # overwrites it to 0, which session_hud_service maps to "unknown" rather
    # than a stale number.
    context_tokens = tokens_in + cache_read + cache_creation
    model = payload.get("model") or transcript_model
    set_model = "model = COALESCE(?, model)," if model else ""
    # Resolve provider: the session's profile is authoritative; fall back to
    # model-name lookup only when the profile gives no match. This prevents
    # the model-name lookup from overwriting a profile-based provider_id that
    # was already correctly set at session start (provider_models maps each
    # Claude model to a single provider, so every session would otherwise be
    # re-resolved to that provider regardless of its profile).
    from . import provider_service  # local import to avoid cycle

    session_row = await _get_session(db, session_id)
    session_profile: str | None = session_row["profile"] if session_row else None
    provider_id: int | None = await provider_service.resolve_profile_to_provider(
        db, session_profile
    )
    if provider_id is None and model:
        provider_id = await provider_service.resolve_model_to_provider(db, model)
    set_provider = "provider_id = COALESCE(?, provider_id)," if provider_id else ""
    params: list[Any] = []
    if model:
        params.append(model)
    if provider_id:
        params.append(provider_id)
    params += [tokens_in, tokens_out, cost_delta, context_tokens, now, session_id]
    await db.execute(
        f"""UPDATE agent_sessions
           SET {set_model}
               {set_provider}
               tokens_in = tokens_in + ?,
               tokens_out = tokens_out + ?,
               cost_usd = cost_usd + ?,
               context_tokens = ?,
               status='idle', current_tool=NULL, current_tool_use_id=NULL,
               current_tool_started_at=NULL, last_event_at=?
           WHERE session_id=?""",
        params,
    )
    # Distribute this turn's cost across the projects touched since the last
    # Stop — must run BEFORE the new Stop event is appended (turn boundary).
    await attribution_service.attribute_turn_cost(
        db, session_id, cost_delta, tokens_in, tokens_out
    )
    event_id = await _append_event(
        db, session_id, "Stop", None, None, "Idle (turn complete)", payload
    )
    _stats_cache.clear()
    await db.commit()
    await _broadcast(db, session_id, event_id, "stop")

    today = datetime.now(UTC).strftime("%Y-%m-%d")
    total_row = await db.execute(
        "SELECT SUM(cost_usd) as total FROM agent_sessions WHERE DATE(last_event_at) = ?",
        (today,),
    )
    total_r = await total_row.fetchone()
    daily_total = (total_r["total"] or 0.0) if total_r else 0.0

    settings_row = await db.execute(
        "SELECT value_json FROM app_settings WHERE key = 'cost_threshold_usd'"
    )
    settings_r = await settings_row.fetchone()
    try:
        threshold = float(json.loads(settings_r["value_json"])) if settings_r else 10.0
    except (ValueError, TypeError):
        threshold = 10.0

    if daily_total >= threshold:
        dup = await db.execute(
            "SELECT id FROM notifications WHERE type='cost_threshold' AND DATE(created_at) = ?",
            (today,),
        )
        if not await dup.fetchone():
            await notification_service.emit(
                db,
                type="cost_threshold",
                title="Daily cost threshold reached",
                body=f"${daily_total:.2f} spent today (threshold: ${threshold:.2f})",
                payload={"daily_cost_usd": daily_total, "threshold_usd": threshold},
                priority="high",
            )

    # Walk per-scope budgets and emit 50/80/100% alerts. Pass the
    # stopped session's project/profile so workspace + matching scope
    # budgets are evaluated and unrelated per-scope rows are skipped.
    # Wrapped so a budget-eval failure can never break stop-hook ingestion.
    try:
        scope_row = await db.execute(
            "SELECT project_id, profile FROM agent_sessions WHERE session_id = ?",
            (session_id,),
        )
        scope = await scope_row.fetchone()
        await budget_service.evaluate_alerts(
            db,
            project_id=scope["project_id"] if scope else None,
            profile=scope["profile"] if scope else None,
        )
    except Exception:  # noqa: BLE001, S110
        pass


async def record_session_end(db: aiosqlite.Connection, payload: dict) -> None:
    session_id = payload.get("session_id")
    if not session_id:
        return
    existing = await _get_session(db, session_id)
    now = _now()
    if not existing:
        # Late event for an unknown session — still record it
        await _upsert_session_start(
            db, session_id, payload.get("cwd"), payload.get("transcript_path")
        )
    reason = payload.get("reason") or ""
    summary = f"Session ended ({reason})" if reason else "Session ended"
    await db.execute(
        """UPDATE agent_sessions
           SET status='ended', ended_at=?, last_event_at=?,
               current_tool=NULL, current_tool_use_id=NULL, current_tool_started_at=NULL
           WHERE session_id=?""",
        (now, now, session_id),
    )
    event_id = await _append_event(
        db, session_id, "SessionEnd", None, None, summary, payload
    )
    _stats_cache.clear()
    await db.commit()
    await _broadcast(db, session_id, event_id, "session_ended")

    category = classify(reason)
    if category in {EndCategory.ERROR, EndCategory.TIMEOUT}:
        await notification_service.emit(
            db,
            type="session_failed",
            title="Session ended with errors",
            body=f"Session {session_id[:8]} — reason: {reason}",
            payload={"session_id": session_id, "reason": reason},
            priority="high",
        )
    elif category is EndCategory.UNKNOWN:
        await notification_service.emit(
            db,
            type="session_info",
            title="Session ended",
            body=f"Session {session_id[:8]} — unrecognised reason: {reason}",
            payload={"session_id": session_id, "reason": reason},
            priority="normal",
        )
    elif category is EndCategory.CLEAN:
        await notification_service.emit(
            db,
            type="session_completed",
            title="Session completed",
            body=f"Session {session_id[:8]} finished successfully",
            payload={"session_id": session_id, "reason": reason},
            priority="normal",
        )


async def cleanup_stale_sessions(db: aiosqlite.Connection) -> dict:
    """Force-close any sessions still marked active/idle/stopped.

    Used when the dashboard's view of live sessions diverges from reality
    (e.g. the platform was disabled or Claude was closed without a clean
    SessionEnd hook firing). Each affected session is transitioned to
    ``status='ended'`` with reason ``manual_cleanup`` and a synthetic
    ``SessionEnd`` event is appended so replay/history stays consistent.
    """
    now = _now()
    rows = await db.execute(
        "SELECT session_id FROM agent_sessions "
        "WHERE status IN ('active','idle','stopped')"
    )
    stale = [r["session_id"] for r in await rows.fetchall()]
    if not stale:
        return {"closed": 0, "session_ids": []}

    await db.execute(
        "UPDATE agent_sessions "
        "SET status='ended', ended_at=?, last_event_at=?, "
        "    current_tool=NULL, current_tool_use_id=NULL, "
        "    current_tool_started_at=NULL "
        "WHERE status IN ('active','idle','stopped')",
        (now, now),
    )
    for sid in stale:
        event_id = await _append_event(
            db,
            sid,
            "SessionEnd",
            None,
            None,
            "Session ended (manual_cleanup)",
            {"session_id": sid, "reason": "manual_cleanup"},
        )
        await _broadcast(db, sid, event_id, "session_ended")
    _stats_cache.clear()
    await db.commit()
    return {"closed": len(stale), "session_ids": stale}


# ─── Read API ───────────────────────────────────────────────────────────────


async def list_sessions(
    db: aiosqlite.Connection,
    profile: str | None = None,
    status: str | None = None,
    limit: int = 100,
    offset: int = 0,
    include_ended: bool = False,
    provider_id: int | None = None,
):
    """Return sessions ordered active → idle → stopped → ended.

    By default (``include_ended=False``) sessions with status='ended' are
    excluded so the live list stays uncluttered. Pass ``status='ended'`` or
    ``include_ended=True`` to fetch them explicitly. The paginated
    ``/sessions/ended`` endpoint uses ``count_sessions`` + this helper with
    ``include_ended=True``.
    """
    query = (
        "SELECT s.*, p.name as project_name "
        "FROM agent_sessions s "
        "LEFT JOIN projects p ON s.project_id = p.id"
    )
    conditions = []
    params: list[Any] = []
    if profile:
        conditions.append("s.profile = ?")
        params.append(profile)
    if status:
        # Explicit status filter wins — caller knows what they want.
        conditions.append("s.status = ?")
        params.append(status)
    elif not include_ended:
        # Default: hide ended; active+idle+stopped only.
        conditions.append("s.status IN ('active','idle','stopped')")
    if provider_id is not None:
        conditions.append("s.provider_id = ?")
        params.append(provider_id)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    # Active first, then idle, stopped, ended — within each bucket, most
    # recent activity wins.
    query += (
        " ORDER BY CASE s.status"
        "   WHEN 'active'  THEN 0"
        "   WHEN 'idle'    THEN 1"
        "   WHEN 'stopped' THEN 2"
        "   WHEN 'ended'   THEN 3"
        "   ELSE 4 END,"
        " s.last_event_at DESC LIMIT ? OFFSET ?"
    )
    params.append(limit)
    params.append(offset)
    rows = await db.execute(query, params)
    return await rows.fetchall()


async def count_sessions(
    db: aiosqlite.Connection,
    profile: str | None = None,
    status: str | None = None,
) -> int:
    """Return the total row count matching the given filters."""
    query = "SELECT COUNT(*) FROM agent_sessions s"
    conditions = []
    params: list[Any] = []
    if profile:
        conditions.append("s.profile = ?")
        params.append(profile)
    if status:
        conditions.append("s.status = ?")
        params.append(status)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    row = await db.execute(query, params)
    result = await row.fetchone()
    return int(result[0]) if result else 0


async def list_recent_events(
    db: aiosqlite.Connection,
    limit: int = 50,
    provider_id: int | None = None,
) -> list[dict[str, Any]]:
    """Return the most recent cross-session events for the Live Activity ticker.

    Each row includes the joined session fields needed to render a ticker row:
    profile, project_name, status, and provider_id. Only event types relevant
    to the ticker are returned (PreToolUse, UserPromptSubmit, SessionEnd).
    Pass `provider_id` to scope the feed to a single provider.
    """
    sql = """
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.tool_name,
            e.summary,
            e.payload_json,
            e.created_at,
            s.profile,
            s.status,
            s.provider_id,
            p.name AS project_name
        FROM agent_events e
        JOIN agent_sessions s ON s.session_id = e.session_id
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE e.event_type IN ('PreToolUse','UserPromptSubmit','SessionEnd')
    """
    params: list[Any] = []
    if provider_id is not None:
        sql += " AND s.provider_id = ?"
        params.append(provider_id)
    sql += " ORDER BY e.id DESC LIMIT ?"
    params.append(limit)
    rows = await db.execute(sql, params)
    return [dict(r) for r in await rows.fetchall()]


async def get_session(db: aiosqlite.Connection, session_id: str):
    row = await db.execute(
        "SELECT s.*, p.name as project_name "
        "FROM agent_sessions s LEFT JOIN projects p ON s.project_id = p.id "
        "WHERE s.session_id = ?",
        (session_id,),
    )
    return await row.fetchone()


async def get_events(db: aiosqlite.Connection, session_id: str, limit: int = 200):
    rows = await db.execute(
        "SELECT * FROM agent_events WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        (session_id, limit),
    )
    return await rows.fetchall()


# ─── Stats ──────────────────────────────────────────────────────────────────

_stats_cache: dict[tuple, tuple[float, Any]] = {}
_CACHE_TTL = 60.0


def _cache_get(key: tuple) -> Any | None:
    entry = _stats_cache.get(key)
    if entry and (time.monotonic() - entry[0]) < _CACHE_TTL:
        return entry[1]
    return None


def _cache_set(key: tuple, value: Any) -> None:
    _stats_cache[key] = (time.monotonic(), value)


def _range_cutoff(range_str: str) -> str | None:
    if range_str == "7d":
        return "datetime('now', '-7 days')"
    if range_str == "30d":
        return "datetime('now', '-30 days')"
    return None  # "all" — no date filter


async def list_with_stats(db: aiosqlite.Connection, range_str: str) -> list:
    cache_key = ("list_stats", range_str)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    rows = await db.execute(
        """
        SELECT
            s.profile,
            COUNT(*) AS run_count,
            MAX(s.last_event_at) AS last_seen,
            COALESCE(SUM(s.cost_usd), 0.0) AS total_cost_usd,
            COUNT(DISTINCT CASE WHEN s.project_id IS NOT NULL THEN s.project_id END) AS projects_touched_count,
            SUM(CASE WHEN s.status IN ('ended') THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN s.status = 'stopped' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN s.status IN ('active','idle') THEN 1 ELSE 0 END) AS ongoing_count
        FROM agent_sessions s
        WHERE s.started_at >= datetime('now', '-30 days')
        GROUP BY s.profile
        ORDER BY run_count DESC
        """
    )
    session_rows = await rows.fetchall()

    result: list[dict] = []
    for row in session_rows:
        profile = row["profile"]
        run_count = row["run_count"]
        success_count = row["success_count"] or 0
        success_rate = success_count / run_count if run_count > 0 else 0.0

        # Top tool for this profile in the same window
        top_row = await db.execute(
            """
            SELECT tool_name, COUNT(*) AS cnt
            FROM agent_events e
            JOIN agent_sessions s ON s.session_id = e.session_id
            WHERE s.profile = ?
              AND e.event_type = 'PreToolUse'
              AND e.tool_name IS NOT NULL
              AND s.started_at >= datetime('now', '-30 days')
            GROUP BY tool_name
            ORDER BY cnt DESC
            LIMIT 1
            """,
            (profile,),
        )
        top_tool_row = await top_row.fetchone()
        top_tool = top_tool_row["tool_name"] if top_tool_row else None

        result.append(
            {
                "profile": profile,
                "run_count": run_count,
                "success_rate": success_rate,
                "last_seen": row["last_seen"],
                "total_cost_usd": row["total_cost_usd"],
                "top_tool": top_tool,
                "projects_touched_count": row["projects_touched_count"] or 0,
            }
        )

    _cache_set(cache_key, result)
    return result


async def get_stats(db: aiosqlite.Connection, profile: str, range_str: str) -> dict:
    cache_key = ("agent_stats", profile, range_str)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    cutoff = _range_cutoff(range_str)
    date_filter = f" AND started_at >= {cutoff}" if cutoff is not None else ""
    date_filter_sessions = (
        f" AND s.started_at >= {cutoff}" if cutoff is not None else ""
    )

    # 1. Counts + cost
    counts_row = await db.execute(
        f"""
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'ended' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status IN ('active','idle') THEN 1 ELSE 0 END) AS ongoing,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(cost_usd), 0.0) AS cost_usd,
            AVG(
                CASE WHEN ended_at IS NOT NULL
                     THEN (julianday(ended_at) - julianday(started_at)) * 86400
                END
            ) AS avg_duration_seconds
        FROM agent_sessions
        WHERE profile = ?{date_filter}
        """,
        (profile,),
    )
    counts = await counts_row.fetchone()

    # 2. Tool histogram
    tools_rows = await db.execute(
        f"""
        SELECT e.tool_name, COUNT(*) AS cnt
        FROM agent_events e
        JOIN agent_sessions s ON s.session_id = e.session_id
        WHERE s.profile = ?{date_filter_sessions}
          AND e.event_type = 'PreToolUse'
          AND e.tool_name IS NOT NULL
        GROUP BY e.tool_name
        ORDER BY cnt DESC
        LIMIT 20
        """,
        (profile,),
    )
    tools = [
        {"name": r["tool_name"], "count": r["cnt"]} for r in await tools_rows.fetchall()
    ]

    # 3. Projects breakdown
    projects_rows = await db.execute(
        f"""
        SELECT p.id, p.name, COUNT(*) AS run_count, COALESCE(SUM(s.cost_usd), 0.0) AS cost_usd
        FROM agent_sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE s.profile = ?{date_filter_sessions}
          AND s.project_id IS NOT NULL
        GROUP BY s.project_id
        ORDER BY run_count DESC
        """,
        (profile,),
    )
    projects = [
        {
            "id": r["id"],
            "name": r["name"],
            "count": r["run_count"],
            "cost": r["cost_usd"],
        }
        for r in await projects_rows.fetchall()
    ]

    # 4. Daily series
    daily_rows = await db.execute(
        f"""
        SELECT date(started_at) AS day,
               COUNT(*) AS runs,
               COALESCE(SUM(cost_usd), 0.0) AS cost
        FROM agent_sessions
        WHERE profile = ?{date_filter}
        GROUP BY day
        ORDER BY day ASC
        """,
        (profile,),
    )
    daily = [
        {"date": r["day"], "runs": r["runs"], "cost": r["cost"]}
        for r in await daily_rows.fetchall()
    ]

    avg_dur = counts["avg_duration_seconds"] if counts else None
    result = {
        "profile": profile,
        "range": range_str,
        "counts": {
            "total": counts["total"] or 0 if counts else 0,
            "success": counts["success"] or 0 if counts else 0,
            "failed": counts["failed"] or 0 if counts else 0,
            "ongoing": counts["ongoing"] or 0 if counts else 0,
        },
        "costs": {
            "tokens_in": counts["tokens_in"] or 0 if counts else 0,
            "tokens_out": counts["tokens_out"] or 0 if counts else 0,
            "cost_usd": counts["cost_usd"] or 0.0 if counts else 0.0,
        },
        "tools": tools,
        "avg_duration_seconds": round(avg_dur or 0),
        "projects": projects,
        "daily": daily,
    }
    _cache_set(cache_key, result)
    return result


async def get_agent_invocation_stats(
    db: aiosqlite.Connection,
    agent_name: str,
    range_str: str,
) -> dict:
    """Return aggregate invocation stats for a named agent.

    Counts Pre↔Post pairs so that orphaned PreToolUse rows (agent still
    running) do not inflate the ``completed`` count.
    """
    cutoff = _range_cutoff(range_str)
    date_filter = f" AND pre.created_at >= {cutoff}" if cutoff is not None else ""
    row = await db.execute(
        f"""
        SELECT
            COUNT(pre.id) AS total_invocations,
            MAX(pre.created_at) AS last_invoked_at,
            AVG(
                CASE WHEN post.id IS NOT NULL
                     THEN (julianday(post.created_at) - julianday(pre.created_at)) * 86400
                END
            ) AS avg_duration_seconds,
            SUM(CASE WHEN post.id IS NOT NULL THEN 1 ELSE 0 END) AS completed
        FROM agent_events pre
        LEFT JOIN agent_events post
               ON post.tool_use_id = pre.tool_use_id
              AND post.event_type = 'PostToolUse'
              AND post.tool_name IN ('Agent','Task')
        WHERE pre.event_type = 'PreToolUse'
          AND pre.tool_name IN ('Agent','Task')
          AND json_extract(pre.payload_json, '$.tool_input.subagent_type') = ?
          {date_filter}
        """,
        (agent_name,),
    )
    r = await row.fetchone()
    avg_dur = r["avg_duration_seconds"] if r else None
    return {
        "total_invocations": r["total_invocations"] or 0 if r else 0,
        "last_invoked_at": r["last_invoked_at"] if r else None,
        "avg_duration_seconds": round(avg_dur) if avg_dur is not None else None,
        "completed": r["completed"] or 0 if r else 0,
    }


async def list_agent_invocations(
    db: aiosqlite.Connection,
    agent_name: str,
    range_str: str,
    limit: int = 50,
    offset: int = 0,
) -> tuple[int, list]:
    """Return paginated invocations for a named agent.

    Each row joins the parent session's profile and project name.
    Duration is NULL when the matching PostToolUse event doesn't exist
    yet (agent still running) or was never recorded.
    """
    cutoff = _range_cutoff(range_str)
    date_filter = f" AND pre.created_at >= {cutoff}" if cutoff is not None else ""

    count_row = await db.execute(
        f"""
        SELECT COUNT(*) AS total
        FROM agent_events pre
        WHERE pre.event_type = 'PreToolUse'
          AND pre.tool_name IN ('Agent','Task')
          AND json_extract(pre.payload_json, '$.tool_input.subagent_type') = ?
          {date_filter}
        """,
        (agent_name,),
    )
    total_r = await count_row.fetchone()
    total = total_r["total"] if total_r else 0

    rows = await db.execute(
        f"""
        SELECT
            pre.id,
            pre.created_at,
            pre.session_id,
            json_extract(pre.payload_json, '$.tool_input.name') AS label,
            json_extract(pre.payload_json, '$.tool_input.description') AS description,
            s.profile,
            p.name AS project_name,
            CASE WHEN post.id IS NOT NULL
                 THEN ROUND((julianday(post.created_at) - julianday(pre.created_at)) * 86400)
                 ELSE NULL
            END AS duration_seconds
        FROM agent_events pre
        JOIN agent_sessions s ON s.session_id = pre.session_id
        LEFT JOIN projects p ON p.id = s.project_id
        LEFT JOIN agent_events post
               ON post.tool_use_id = pre.tool_use_id
              AND post.event_type = 'PostToolUse'
              AND post.tool_name IN ('Agent','Task')
        WHERE pre.event_type = 'PreToolUse'
          AND pre.tool_name IN ('Agent','Task')
          AND json_extract(pre.payload_json, '$.tool_input.subagent_type') = ?
          {date_filter}
        ORDER BY pre.created_at DESC
        LIMIT ? OFFSET ?
        """,
        (agent_name, limit, offset),
    )
    invocations = [
        {
            "id": r["id"],
            "created_at": r["created_at"],
            "session_id": r["session_id"],
            "label": r["label"],
            "description": _truncate(r["description"], 140)
            if r["description"]
            else None,
            "profile": r["profile"],
            "project_name": r["project_name"],
            "duration_seconds": int(r["duration_seconds"])
            if r["duration_seconds"] is not None
            else None,
        }
        for r in await rows.fetchall()
    ]
    return total, invocations


async def list_sessions_for_agent(
    db: aiosqlite.Connection,
    profile: str,
    limit: int = 50,
    offset: int = 0,
) -> tuple[int, list]:
    count_row = await db.execute(
        "SELECT COUNT(*) FROM agent_sessions WHERE profile = ?",
        (profile,),
    )
    total_row = await count_row.fetchone()
    total = total_row[0] if total_row else 0

    rows = await db.execute(
        """
        SELECT s.*, p.name as project_name
        FROM agent_sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        WHERE s.profile = ?
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?
        """,
        (profile, limit, offset),
    )
    sessions = [dict(r) for r in await rows.fetchall()]
    return total, sessions


async def list_events_for_session(
    db: aiosqlite.Connection,
    profile: str,
    session_id: str,
    limit: int = 200,
) -> list:
    # Verify the session belongs to this profile
    check_row = await db.execute(
        "SELECT profile FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    )
    row = await check_row.fetchone()
    if row is None or row["profile"] != profile:
        raise HTTPException(status_code=403, detail="forbidden")

    events_rows = await db.execute(
        "SELECT * FROM agent_events WHERE session_id = ? ORDER BY id ASC LIMIT ?",
        (session_id, limit),
    )
    return [dict(e) for e in await events_rows.fetchall()]


async def get_session_stats(db: aiosqlite.Connection, session_id: str) -> dict:
    """Returns tool counts + per-minute activity buckets for the last 30 minutes."""
    rows = await db.execute(
        "SELECT tool_name, COUNT(*) as cnt FROM agent_events "
        "WHERE session_id = ? AND event_type = 'PreToolUse' AND tool_name IS NOT NULL "
        "GROUP BY tool_name ORDER BY cnt DESC",
        (session_id,),
    )
    tool_counts = [
        {"tool": r["tool_name"], "count": r["cnt"]} for r in await rows.fetchall()
    ]

    # Per-minute buckets across the full session lifetime (capped at 60 buckets)
    rows = await db.execute(
        "SELECT strftime('%Y-%m-%dT%H:%M', created_at) as minute, COUNT(*) as cnt "
        "FROM agent_events WHERE session_id = ? AND event_type = 'PreToolUse' "
        "GROUP BY minute ORDER BY minute DESC LIMIT 60",
        (session_id,),
    )
    buckets = [
        {"minute": r["minute"], "count": r["cnt"]} for r in await rows.fetchall()
    ]
    buckets.reverse()
    return {"tool_counts": tool_counts, "activity": buckets}


# ─── Warp launch config ─────────────────────────────────────────────────────

WARP_LAUNCH_DIR = Path.home() / ".warp" / "launch_configurations"


def _yaml_escape(s: str) -> str:
    # Single-quote and escape embedded single quotes per YAML rules
    return "'" + s.replace("'", "''") + "'"


def _build_pane_tree(
    n: int, cwd: str, exec_cmd: str, direction: str = "horizontal"
) -> dict:
    """Recursive bisection — yields a roughly grid-shaped split for any N >= 1.
    1 -> single pane.  2 -> 2 cols.  3 -> 1 + 2 stacked.  4 -> 2x2.  N -> grid.
    """
    if n <= 1:
        return {"leaf": True, "cwd": cwd, "exec": exec_cmd}
    left = n // 2
    right = n - left
    flip = "vertical" if direction == "horizontal" else "horizontal"
    return {
        "leaf": False,
        "split_direction": direction,
        "children": [
            _build_pane_tree(left, cwd, exec_cmd, flip),
            _build_pane_tree(right, cwd, exec_cmd, flip),
        ],
    }


def _emit_pane_lines(node: dict, indent: str) -> list[str]:
    """Emit YAML lines for a layout / pane subtree starting at the given indent."""
    if node["leaf"]:
        return [
            f"{indent}cwd: {_yaml_escape(node['cwd'])}",
            f"{indent}commands:",
            f"{indent}  - exec: {_yaml_escape(node['exec'])}",
        ]
    lines = [
        f"{indent}split_direction: {node['split_direction']}",
        f"{indent}panes:",
    ]
    child_indent = indent + "    "
    for child in node["children"]:
        child_lines = _emit_pane_lines(child, child_indent)
        # Promote the child's first line under a '- ' list marker
        first = child_lines[0][len(child_indent) :]
        child_lines[0] = f"{indent}  - {first}"
        lines.extend(child_lines)
    return lines


def build_warp_launch_yaml(
    name: str,
    work_count: int,
    personal_count: int,
    work_cwd: str,
    personal_cwd: str,
    profiles: list[dict] | None = None,
) -> str:
    """Builds a Warp launch_configuration YAML.

    One window with one tab per requested slot (when N > 0). Inside each tab,
    N split panes arranged as a recursive-bisection grid. Each pane runs
    `claude` with CLAUDE_CONFIG_DIR taken from the caller-supplied profile
    rows; when no profile defines a config dir, panes run plain `claude`.
    """
    lines: list[str] = ["---", f"name: {_yaml_escape(name)}", "windows:"]
    lines.append("  - tabs:")

    def add_tab(count: int, cwd: str, exec_cmd: str, title: str, color: str) -> None:
        lines.append(f"      - title: {_yaml_escape(title)}")
        lines.append(f"        color: {color}")
        lines.append("        layout:")
        tree = _build_pane_tree(count, cwd, exec_cmd)
        lines.extend(_emit_pane_lines(tree, "          "))

    entries: list[tuple[str, str]] = []
    for profile in profiles or []:
        config_dir = (profile.get("claude_config_dir") or "").strip()
        if not config_dir:
            continue
        # Warp's pane executor may deliver `commands.exec` without a shell, so
        # `~` / `$HOME` would not expand — resolve to an absolute path here.
        config_dir = str(Path(config_dir).expanduser())
        entries.append((profile["name"], f"CLAUDE_CONFIG_DIR={config_dir} claude"))
    if not entries:
        entries = [("claude", "claude")]

    if work_count > 0:
        title, exec_cmd = entries[0]
        add_tab(work_count, work_cwd, exec_cmd, title, "blue")
    if personal_count > 0:
        title, exec_cmd = entries[1] if len(entries) > 1 else entries[0]
        add_tab(personal_count, personal_cwd, exec_cmd, title, "purple")

    return "\n".join(lines) + "\n"


def write_warp_launch_config(name: str, yaml_text: str) -> Path:
    WARP_LAUNCH_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in name)
    path = WARP_LAUNCH_DIR / f"{safe_name}.yaml"
    path.write_text(yaml_text, encoding="utf-8")
    return path
