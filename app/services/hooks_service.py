"""Claude Code hook-setup guidance + inbound-ping verification.

Onboarding shows the user the exact ``hooks`` block to paste into their Claude
Code ``settings.json`` (guided copy-paste — the app never auto-writes it) so the
command center receives session telemetry. ``hooks_status`` reports whether any
inbound hook has been received yet, which the UI uses to confirm the wiring.

The hook type is ``"command"`` — a ``curl`` POST of the hook payload (piped in
on stdin via ``--data-binary @-``) to the sidecar endpoint, ending in
``|| true``. The native ``"http"`` hook type surfaces a connection error
(``ECONNREFUSED``) in every Claude Code session when the desktop app is offline;
the ``|| true`` makes curl always exit 0 so the hook silently no-ops instead.
``--max-time`` is one second under the hook ``timeout`` so curl aborts cleanly
before the harness kills it — the sidecar is never on the critical path. Each
event carries a ``"matcher": "*"`` so every session is captured regardless of
cwd.

The event registry
------------------
``HOOK_EVENTS`` is the single enumeration of every Claude Code hook event this
app ingests, and the import path the rest of P2 consumes — the settings
snippet, the settings diff, the ingest routes and the retention split all read
it rather than restating a list of their own. A second copy of the list is the
bug this module exists to prevent: the app already shipped one
(``frontend/src/pages/onboarding/hooks-step.tsx``'s ``FALLBACK_SNIPPET``,
deliberately kept as a *loading placeholder* and replaced by this module's
live snippet the moment the sidecar answers), and every further copy is one
more place for an event to be added in one and forgotten in the other.

Each entry is a ``HookEvent`` carrying four facts:

* ``event`` — the Claude Code hook event name, and the ``agent_events.event_type``
  value the recorder writes. It is what ``event_retention_service`` classifies on,
  so renaming one silently re-buckets history.
* ``path`` — the sidecar ingest path, stored whole rather than derived from the
  event name. The original six predate the ``/event/`` namespace and sit at
  ``/api/v1/hooks/<slug>`` with slugs that are not mechanical transforms of
  their names (``UserPromptSubmit`` → ``user-prompt``); every event added since
  lives under ``/api/v1/hooks/event/<slug>``. Those six paths are already
  pasted into real users' ``settings.json`` files and can never move.
* ``tier`` — ``TIER_CORE`` for the six the app has always required,
  ``TIER_EXTENDED`` for everything added in P2. This is what keeps widening the
  registry from being a user-visible regression: ``classify_settings_hooks``
  grades a ``settings.json`` against the core tier only, so an install that was
  green yesterday does not turn amber today merely because the app learned
  about sixteen more events it would *like* to have. The extended tier is
  telemetry the app makes better use of when present, never a precondition.
* ``discards_stdout`` — whether the generated command redirects curl's output
  to ``/dev/null``. True for 21 of the 22 and load-bearing for at least two of
  them: Claude Code feeds a ``SessionStart`` / ``UserPromptSubmit`` hook's
  stdout back into the session as context, so an unredirected response body
  would be injected into the user's conversation. It is a field rather than an
  unconditional suffix because a hook that discards its stdout has no return
  channel at all, and one event needs one.

  ``PreToolUse`` is that event (#172). Its response body is how a hook answers
  a permission prompt — ``hookSpecificOutput.permissionDecision`` — and the
  protocol is bound to ``PreToolUse`` specifically, so pre-authorisation is
  not expressible anywhere else in this registry. Everything else still
  discards, including ``PermissionRequest``: it looks like the event that
  ought to carry a decision and it does not.

  A hook with a live return channel is a hook whose failure mode changed. On
  every other event the worst a broken sidecar can do is print into
  ``/dev/null``; on ``PreToolUse`` whatever curl prints is fed to Claude Code
  as a decision, and FastAPI answers an unhandled exception with a JSON error
  body. ``_curl_command_for_url`` therefore gives the undiscarded form
  ``--fail`` (no output at all on an HTTP status ≥ 400, and a non-zero exit
  the existing ``|| true`` swallows) and sends stderr to ``/dev/null`` rather
  than leaving it on the terminal. A sidecar that is offline, slow or throwing
  produces empty stdout, and the session proceeds exactly as if this app were
  not installed.

Self-test verification
-----------------------
``hooks_status`` only ever goes green on an inbound ping from a *real* Claude
Code session, which onboarding has no way to produce. This module also
supports verifying the wiring without one:

* ``verify_settings_files`` reads each configured ``settings.json`` off the
  event loop (``asyncio.to_thread``, read-only — this module never writes a
  user's file) and diffs its ``hooks`` block against what
  ``build_hook_settings`` would emit, per event. It never returns file
  contents, only the structural verdict.
* ``mint_self_test`` / ``record_self_test`` / ``read_self_test`` back a true
  end-to-end check: the frontend hands the minted URL to the Rust shell,
  which spawns the same ``curl`` a real hook would run, so an inbound POST is
  actually observed. Token state is an in-process ``OrderedDict`` (this is a
  single uvicorn process, no ``--workers``) keyed on ``time.monotonic()`` — no
  ``datetime`` is involved and no schema change is needed.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import aiosqlite

# Default base URL for hook endpoints. Uses ``localhost`` (not 127.0.0.1)
# because that matches what users' existing ``settings.json`` files typically
# contain and avoids IPv4/IPv6 resolution surprises on some macOS setups.
_DEFAULT_BASE_URL = "http://localhost:8002"

# Tier names. `core` is the six events the app has always ingested and still
# grades a settings.json against; `extended` is everything P2 added, which the
# app uses when present and never requires. See the module docstring.
TIER_CORE = "core"
TIER_EXTENDED = "extended"

# URL prefix for every event added after the original six. Keeping a distinct
# path per event (rather than one catch-all taking the event name as a path
# parameter) means an unknown or misspelled event 404s at the router instead of
# reaching the recorder, and it keeps each hook's latency attributable to its
# own route in an access log.
_EVENT_PREFIX = "/api/v1/hooks/event"


@dataclass(frozen=True)
class HookEvent:
    """One Claude Code hook event and how this app ingests it.

    Frozen because the tuple below is module-level shared state read on the
    hook path; nothing may mutate an entry in place. See the module docstring
    for what each field means and why `path` is stored rather than derived.
    """

    event: str
    path: str
    tier: str
    discards_stdout: bool


# The one and only enumeration of ingested hook events. Ordered core-first,
# then extended in the rough order a session emits them, because this order is
# what the pasted settings.json snippet reads in.
#
# Deliberately absent — the epic's P2 paragraph names them, the design's triage
# puts all four in "not for us", and the design wins: `InstructionsLoaded`,
# `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`.
HOOK_EVENTS: tuple[HookEvent, ...] = (
    # ─── core: the six already in users' settings.json; paths are frozen ────
    HookEvent("SessionStart", "/api/v1/hooks/session-start", TIER_CORE, True),
    HookEvent("UserPromptSubmit", "/api/v1/hooks/user-prompt", TIER_CORE, True),
    # The one undiscarded command: its stdout is the pre-authorisation
    # decision channel (#172). See `discards_stdout` in the module docstring.
    HookEvent("PreToolUse", "/api/v1/hooks/pre-tool", TIER_CORE, False),
    HookEvent("PostToolUse", "/api/v1/hooks/post-tool", TIER_CORE, True),
    HookEvent("Stop", "/api/v1/hooks/stop", TIER_CORE, True),
    HookEvent("SessionEnd", "/api/v1/hooks/session-end", TIER_CORE, True),
    # ─── extended: P2, all behind the one generic recorder ──────────────────
    HookEvent("Notification", f"{_EVENT_PREFIX}/notification", TIER_EXTENDED, True),
    HookEvent("Elicitation", f"{_EVENT_PREFIX}/elicitation", TIER_EXTENDED, True),
    HookEvent(
        "PermissionRequest", f"{_EVENT_PREFIX}/permission-request", TIER_EXTENDED, True
    ),
    HookEvent(
        "PermissionDenied", f"{_EVENT_PREFIX}/permission-denied", TIER_EXTENDED, True
    ),
    HookEvent(
        "PostToolUseFailure",
        f"{_EVENT_PREFIX}/post-tool-failure",
        TIER_EXTENDED,
        True,
    ),
    HookEvent("SubagentStart", f"{_EVENT_PREFIX}/subagent-start", TIER_EXTENDED, True),
    HookEvent("SubagentStop", f"{_EVENT_PREFIX}/subagent-stop", TIER_EXTENDED, True),
    HookEvent("TaskCreated", f"{_EVENT_PREFIX}/task-created", TIER_EXTENDED, True),
    HookEvent("TaskCompleted", f"{_EVENT_PREFIX}/task-completed", TIER_EXTENDED, True),
    HookEvent("StopFailure", f"{_EVENT_PREFIX}/stop-failure", TIER_EXTENDED, True),
    HookEvent("PreCompact", f"{_EVENT_PREFIX}/pre-compact", TIER_EXTENDED, True),
    HookEvent("PostCompact", f"{_EVENT_PREFIX}/post-compact", TIER_EXTENDED, True),
    HookEvent("CwdChanged", f"{_EVENT_PREFIX}/cwd-changed", TIER_EXTENDED, True),
    HookEvent(
        "DirectoryAdded", f"{_EVENT_PREFIX}/directory-added", TIER_EXTENDED, True
    ),
    HookEvent(
        "PreModelSwitch", f"{_EVENT_PREFIX}/pre-model-switch", TIER_EXTENDED, True
    ),
    HookEvent(
        "PostModelSwitch", f"{_EVENT_PREFIX}/post-model-switch", TIER_EXTENDED, True
    ),
)

_EVENTS_BY_NAME: dict[str, HookEvent] = {spec.event: spec for spec in HOOK_EVENTS}


def core_events() -> tuple[HookEvent, ...]:
    """The six events a settings.json is graded against (see `tier`)."""
    return tuple(spec for spec in HOOK_EVENTS if spec.tier == TIER_CORE)


def extended_events() -> tuple[HookEvent, ...]:
    """The P2 events, each served by the one generic recorder."""
    return tuple(spec for spec in HOOK_EVENTS if spec.tier == TIER_EXTENDED)


# curl ``--max-time`` ceiling (seconds) — how long curl waits for the sidecar
# before giving up. Kept under ``_HOOK_TIMEOUT`` so curl aborts itself first.
_CURL_MAX_TIME = 5

# Outer hook ``timeout`` (seconds) Claude Code allows the command to run. One
# second over ``_CURL_MAX_TIME`` so curl exits gracefully before the harness
# force-kills it.
_HOOK_TIMEOUT = 6


def sidecar_base_url() -> str:
    return os.environ.get("CODENEST_SIDECAR_URL", _DEFAULT_BASE_URL).rstrip("/")


def settings_json_path(config_home: str | None) -> str:
    """Absolute path to the settings.json for a given Claude config home."""
    home = config_home.strip() if config_home and config_home.strip() else "~/.claude"
    return str(Path(home).expanduser() / "settings.json")


def _curl_command_for_url(url: str, discard_stdout: bool = True) -> str:
    """Shell command that POSTs the hook payload (stdin) to *url*.

    Shared by the real hook builder (``_curl_command``) and the self-test
    minter (``mint_self_test``) so the two can never drift apart — the
    live-probe test asserts the two are the same command, URL substituted.

    ``--max-time`` and the trailing ``|| true`` are not optional and are not
    parameters: every one of the 22 commands must carry both, or a stalled or
    absent sidecar becomes a stalled or erroring Claude Code session.

    What varies is the stdout handling, per ``HookEvent.discards_stdout``, and
    the undiscarded form is not simply "the same command without the
    redirect". Its stdout is read by Claude Code, so the command has to
    guarantee that only a *deliberate* sidecar answer can ever appear there:

    * ``--fail`` — curl prints nothing at all on an HTTP status ≥ 400 and
      exits non-zero, which ``|| true`` swallows. Without it a FastAPI 500's
      JSON error body would be handed to Claude Code as a hook decision.
    * ``2>/dev/null`` — stderr is still silenced. ``-s`` already keeps curl
      quiet, but a transport failure must not paint the user's terminal
      either, and the redirect costs nothing.

    A connection refused, a timeout and a 500 all therefore produce the same
    thing: no output, exit 0, session unaffected.
    """
    if discard_stdout:
        return (
            f"curl -s --max-time {_CURL_MAX_TIME} -X POST "
            "-H 'Content-Type: application/json' --data-binary @- "
            f"{url} >/dev/null 2>&1 || true"
        )
    return (
        f"curl -s --fail --max-time {_CURL_MAX_TIME} -X POST "
        "-H 'Content-Type: application/json' --data-binary @- "
        f"{url} 2>/dev/null || true"
    )


def _curl_command(base: str, spec: HookEvent) -> str:
    """Shell command that POSTs *spec*'s hook payload (stdin) to the sidecar.

    ``--data-binary @-`` forwards the hook event JSON that Claude Code pipes in
    on stdin, so the sidecar receives the same body the old ``http`` hook sent.
    ``|| true`` swallows curl's non-zero exit when the app is offline so Claude
    Code never surfaces a hook error. Output is discarded (``>/dev/null 2>&1``)
    to keep ``SessionStart`` / ``UserPromptSubmit`` stdout out of the context —
    except for ``PreToolUse``, whose stdout is the decision channel and which
    gets the hardened ``--fail`` form instead.
    """
    return _curl_command_for_url(f"{base}{spec.path}", spec.discards_stdout)


def build_hook_settings(base_url: str | None = None) -> dict:
    """Return the ``{"hooks": {...}}`` block to merge into settings.json.

    Emits the ``"type": "command"`` hook format: a ``curl`` POST that no-ops
    (``|| true``) when the desktop app is offline, instead of the native
    ``"http"`` type which raises ``ECONNREFUSED`` in every session. Each event
    gets a single entry with ``"matcher": "*"`` so all sessions are captured
    regardless of cwd or project.

    Covers every entry in ``HOOK_EVENTS``, both tiers: a user pasting the
    snippet gets the full 22, and the core/extended distinction only governs
    how a settings.json that *already exists* is graded
    (``classify_settings_hooks``), never what this offers.

    Example for SessionStart::

        "SessionStart": [
          {
            "matcher": "*",
            "hooks": [
              {
                "type": "command",
                "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:8002/api/v1/hooks/session-start >/dev/null 2>&1 || true",
                "timeout": 6
              }
            ]
          }
        ]
    """
    base = (base_url or sidecar_base_url()).rstrip("/")
    hooks = {
        spec.event: [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": _curl_command(base, spec),
                        "timeout": _HOOK_TIMEOUT,
                    }
                ],
            }
        ]
        for spec in HOOK_EVENTS
    }
    return {"hooks": hooks}


async def hooks_status(db: aiosqlite.Connection, since: str | None = None) -> dict:
    """Whether an inbound hook has been received (the verify signal).

    Reuses existing telemetry: ``agent_sessions`` rows mean Claude Code reached
    the sidecar. Pass ``since`` (a prior ``last_ping_at``) so the onboarding
    verify only goes green on a *fresh* ping, not pre-existing history.
    """
    cur = await db.execute(
        "SELECT COUNT(*) AS n, MAX(last_event_at) AS last FROM agent_sessions"
    )
    row = await cur.fetchone()
    assert row is not None  # an aggregate query always returns exactly one row
    sessions = int(row["n"])
    last = row["last"]
    if since:
        connected = last is not None and last > since
    else:
        connected = sessions > 0
    return {"connected": connected, "sessions": sessions, "last_ping_at": last}


# ─── settings.json hooks-block diff (self-test, part 1) ──────────────────────
#
# Pure functions below (no filesystem, no DB) so the diff logic itself is
# exhaustively unit-testable; `_read_settings` / `verify_settings_files` are
# the thin I/O layer that feeds them an already-parsed body.

# Fixed mis-paste destinations. The sibling `<config_home>/settings.local.json`
# is NOT here — it is derived from the target inside `_alternate_settings_paths`.
_ALT_SETTINGS_CANDIDATES: tuple[str, ...] = (
    "~/.claude/settings.json",
    "~/.claude.json",
)

# ``~/.claude.json`` accumulates project history and is routinely
# multi-megabyte on a real machine — it will usually be skipped as
# "unreadable" below and so will rarely register as a `found_elsewhere` hit.
# Accepted, not a bug: of the three mis-paste candidates it is the least
# likely destination, and reading a multi-MB file synchronously (even off the
# event loop) on every "Test hooks" click is not worth doing for that case.
_MAX_SETTINGS_BYTES = 2 * 1024 * 1024

# Hosts that resolve to "this machine" for the purposes of the diff — a
# `settings.json` hand-wired with any of these must not be reported as a
# mismatch against the sidecar's own base URL just because the literal host
# string differs (see `_equivalent_base_urls`).
_LOOPBACK_HOSTS: frozenset[str] = frozenset({"localhost", "127.0.0.1", "[::1]"})

# Canonical iteration order for the loopback aliases. `_LOOPBACK_HOSTS` above
# is a set (membership only); str hashing is randomized per process, so an
# order derived from iterating it would make a mismatch detail name a
# different "expected" base URL from run to run. This keeps it deterministic.
_LOOPBACK_HOST_ORDER: tuple[str, ...] = ("localhost", "127.0.0.1", "[::1]")


def hook_endpoint_path(event: str) -> str | None:
    """'SessionStart' -> '/api/v1/hooks/session-start'; None for unknown events."""
    spec = _EVENTS_BY_NAME.get(event)
    return spec.path if spec is not None else None


def _equivalent_base_urls(base_url: str) -> tuple[str, ...]:
    """('http://localhost:8002',) -> the same URL with each loopback alias.

    Returns a single-element tuple unchanged when *base_url*'s host is not one
    of the loopback aliases (nothing to normalise). *base_url* itself is
    always first, so callers that report "instead of <equivalents[0]>" always
    name the base the sidecar is actually using.
    """
    parsed = urlsplit(base_url)
    hostname = parsed.hostname or ""
    host_token = f"[{hostname}]" if ":" in hostname else hostname
    if host_token not in _LOOPBACK_HOSTS:
        return (base_url,)
    port_suffix = f":{parsed.port}" if parsed.port is not None else ""
    ordered_hosts = [
        host_token,
        *(h for h in _LOOPBACK_HOST_ORDER if h != host_token),
    ]
    return tuple(f"{parsed.scheme}://{h}{port_suffix}" for h in ordered_hosts)


def _endpoint_pattern(target_path: str) -> re.Pattern[str]:
    """Regex matching *target_path* with a boundary so e.g. ``/stop`` does not
    match inside a hypothetical ``/stop-foo``."""
    return re.compile(re.escape(target_path) + r"(?![\w-])")


def _extract_base(command: str, target_path: str) -> str | None:
    """Best-effort extraction of the base URL a command actually targets, for
    the "points at <found base> instead of <expected>" mismatch detail."""
    match = re.search(
        r"(https?://\S+?)" + re.escape(target_path) + r"(?![\w-])", command
    )
    return match.group(1) if match else None


def _hook_is_ours(hook: dict[str, Any], pattern: re.Pattern[str]) -> bool:
    """A hook dict "is ours" when its ``command`` or legacy ``url`` targets
    one of our endpoints — regardless of whether it is otherwise well-formed."""
    command = hook.get("command")
    if isinstance(command, str) and pattern.search(command):
        return True
    url = hook.get("url")
    return isinstance(url, str) and pattern.search(url) is not None


def _verdict_for_hook(
    hook: dict[str, Any],
    matcher: object,
    target_path: str,
    equivalents: tuple[str, ...],
) -> tuple[str, str | None]:
    """Verdict for a single ours-matching hook already known to be wrapped in
    a ``{matcher, hooks[]}`` entry."""
    if hook.get("type") != "command":
        return "mismatch", 'uses the legacy "http" hook type instead of "command"'

    command = hook.get("command")
    if not isinstance(command, str):
        return "mismatch", "hook command is missing or not a string"

    if not any(f"{base}{target_path}" in command for base in equivalents):
        found = _extract_base(command, target_path)
        expected = equivalents[0] if equivalents else ""
        detail = (
            f"points at {found} instead of {expected}"
            if found
            else f"command does not target {expected}"
        )
        return "mismatch", detail

    if matcher != "*":
        return "mismatch", f'hook matcher is "{matcher}", not "*"'

    return "ok", None


def _classify_event(
    entries: object, event: str, equivalents: tuple[str, ...]
) -> tuple[str, str | None]:
    target_path = hook_endpoint_path(event)
    assert target_path is not None  # event always comes from HOOK_EVENTS
    pattern = _endpoint_pattern(target_path)

    if not isinstance(entries, list):
        return "missing", None

    best: tuple[str, str | None] | None = None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        wrapped = entry.get("hooks")
        if isinstance(wrapped, list):
            matcher = entry.get("matcher")
            for hook in wrapped:
                if not isinstance(hook, dict) or not _hook_is_ours(hook, pattern):
                    continue
                status, detail = _verdict_for_hook(
                    hook, matcher, target_path, equivalents
                )
                if status == "ok":
                    return "ok", None
                if best is None:
                    best = (status, detail)
        elif _hook_is_ours(entry, pattern):
            # Flat form: a hook dict directly in the event array, not wrapped
            # in a {matcher, hooks[]} object — the pre-`build_hook_settings`
            # shape some hand-edited files may still use.
            return (
                "malformed",
                "hook entries must be wrapped in a {matcher, hooks[]} object",
            )

    return best if best is not None else ("missing", None)


def _all_missing() -> list[dict[str, Any]]:
    return [
        {"event": spec.event, "status": "missing", "detail": None}
        for spec in core_events()
    ]


def classify_settings_hooks(
    parsed: object, base_url: str
) -> tuple[str, list[dict[str, Any]], str | None]:
    """(file_status, per-event verdicts, detail) for an ALREADY-PARSED settings body.

    file_status is one of 'ok' | 'partial' | 'absent'. Matching is containment,
    not equality: a real settings.json will have other hooks, other matchers,
    and other top-level keys, so this only asks "does *some* entry for this
    event target our endpoint under a wildcard matcher".

    Grades the **core tier only** (`hooks_service.core_events`), which is the
    whole point of `HookEvent.tier`. `build_hook_settings` offers all 22 events
    and the app is better off with all 22, but file_status is a verdict on
    whether the user's wiring is *broken* — and it is not broken merely because
    it predates P2. Grading all 22 would take every existing install, which has
    exactly the core six in it and is working perfectly, from 'ok' to 'partial'
    on upgrade, and light sixteen red chips on the onboarding card describing
    nothing that ever worked. A user who re-pastes the snippet gets the full
    set; one who does not keeps a green card and the six events the app has
    always run on.
    """
    if not isinstance(parsed, dict):
        return "absent", _all_missing(), "settings.json does not contain a JSON object"

    hooks_block = parsed.get("hooks")
    if hooks_block is None:
        return "absent", _all_missing(), 'no top-level "hooks" key'
    if not isinstance(hooks_block, dict):
        return "absent", _all_missing(), 'the top-level "hooks" key must be an object'

    equivalents = _equivalent_base_urls(base_url)
    verdicts: list[dict[str, Any]] = []
    for spec in core_events():
        status, detail = _classify_event(
            hooks_block.get(spec.event), spec.event, equivalents
        )
        verdicts.append({"event": spec.event, "status": status, "detail": detail})

    statuses = {v["status"] for v in verdicts}
    if statuses == {"ok"}:
        file_status = "ok"
    elif statuses <= {"missing"}:
        file_status = "absent"
    else:
        file_status = "partial"
    return file_status, verdicts, None


# ─── settings.json hooks-block diff (self-test, part 2: filesystem) ──────────


def _read_settings(path: Path) -> tuple[str, object | None, str | None]:
    """(status, parsed, detail) — status in
    'ok' | 'missing_file' | 'invalid_json' | 'unreadable'. Blocking; called only
    from the to_thread hop below. Only ever opens *path* for reading — there is
    no write path anywhere in this module.
    """
    if not path.is_absolute():
        return "unreadable", None, f"resolved path is not absolute: {path}"

    if path.is_dir():
        return "unreadable", None, f"{path} is a directory, not a file"

    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return "missing_file", None, None
    except OSError as exc:
        return "unreadable", None, str(exc)

    if size > _MAX_SETTINGS_BYTES:
        return (
            "unreadable",
            None,
            f"{path} is larger than the {_MAX_SETTINGS_BYTES}-byte read limit",
        )

    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "missing_file", None, None
    except UnicodeDecodeError:
        return "unreadable", None, f"{path} is not valid UTF-8"
    except OSError as exc:
        return "unreadable", None, str(exc)

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        return "invalid_json", None, f"could not parse JSON: {exc}"

    return "ok", parsed, None


def _alternate_settings_paths(target: Path) -> list[Path]:
    """Bounded sibling scan for the "pasted into the wrong file" signal.

    Checks the sibling `settings.local.json` next to *target*, plus the two
    fixed candidates in `_ALT_SETTINGS_CANDIDATES` — the three plausible
    mis-paste destinations. Walking the whole home directory would be slow and
    invasive, so this stays a short, fixed list. Excludes *target* itself and
    de-duplicates while preserving order.
    """
    candidates = [target.parent / "settings.local.json"]
    candidates.extend(Path(p).expanduser() for p in _ALT_SETTINGS_CANDIDATES)
    seen: set[Path] = {target}
    result: list[Path] = []
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        result.append(candidate)
    return result


def _overall_status(results: list[dict[str, Any]]) -> str:
    if not results:
        return "absent"
    if any(r["file_status"] in ("invalid_json", "unreadable") for r in results):
        return "error"
    if all(r["file_status"] == "ok" for r in results):
        return "ok"
    if all(r["file_status"] in ("absent", "missing_file") for r in results):
        return "absent"
    return "partial"


def _verify_sync(config_homes: Sequence[str], base: str) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for config_home in config_homes:
        target = Path(settings_json_path(config_home))
        read_status, parsed, read_detail = _read_settings(target)

        if read_status == "ok":
            file_status, events, detail = classify_settings_hooks(parsed, base)
        else:
            file_status, events, detail = read_status, _all_missing(), read_detail

        found_elsewhere: list[str] = []
        if file_status != "ok":
            for alt in _alternate_settings_paths(target):
                alt_status, alt_parsed, _alt_detail = _read_settings(alt)
                if alt_status != "ok":
                    continue
                _, alt_events, _alt_detail2 = classify_settings_hooks(alt_parsed, base)
                if any(e["status"] != "missing" for e in alt_events):
                    found_elsewhere.append(str(alt))

        results.append(
            {
                "config_home": config_home,
                "settings_path": str(target),
                "file_status": file_status,
                "detail": detail,
                "events": events,
                "found_elsewhere": found_elsewhere,
            }
        )

    return {
        "base_url": base,
        # Core tier only, matching what `classify_settings_hooks` graded — the
        # frontend renders one chip per name here and must not be handed a
        # name it has no verdict for.
        "expected_events": [spec.event for spec in core_events()],
        "overall": _overall_status(results),
        "results": results,
    }


async def verify_settings_files(
    config_homes: Sequence[str], base_url: str | None = None
) -> dict[str, Any]:
    """Diff each config home's settings.json against `build_hook_settings()`.

    Read-only, off the event loop (one `asyncio.to_thread` hop for the whole
    request — precedent: `marketplace_service.py`'s `exists_flags`), so a slow
    or huge settings.json never stalls any other request the sidecar is
    handling.
    """
    return await asyncio.to_thread(
        _verify_sync, list(config_homes), (base_url or sidecar_base_url()).rstrip("/")
    )


# ─── Self-test token state (self-test, part 3: the live probe) ───────────────
#
# In-process only — a migration for a 10-minute ephemeral nonce would be dead
# weight, and "a freshly migrated DB ships empty" argues against a table whose
# only content is transient. Safe because there is exactly one uvicorn process
# (no `--workers`). All timing uses `time.monotonic()`, never `datetime`, so no
# DTZ-rule suppression is needed anywhere in this module.

_SELF_TEST_TTL_SECONDS = 600
_SELF_TEST_MAX = 16


@dataclass
class _SelfTest:
    created_at: float  # time.monotonic()
    received_at: float | None = None


_self_tests: OrderedDict[str, _SelfTest] = OrderedDict()


def _prune_self_tests(now: float) -> None:
    expired = [
        token
        for token, entry in _self_tests.items()
        if now - entry.created_at > _SELF_TEST_TTL_SECONDS
    ]
    for token in expired:
        del _self_tests[token]


def mint_self_test(base_url: str | None = None) -> dict[str, Any]:
    """Mint a one-shot probe token and the sidecar URL + curl command for it.

    `command` is built via `_curl_command_for_url` — the same helper the real
    hook command uses — so the live probe can never drift from what a pasted
    hook actually runs. `max_time_seconds` is `_CURL_MAX_TIME`, handed to Rust
    rather than duplicated there.
    """
    now = time.monotonic()
    _prune_self_tests(now)
    while len(_self_tests) >= _SELF_TEST_MAX:
        _self_tests.popitem(last=False)  # evict oldest

    token = secrets.token_hex(16)
    _self_tests[token] = _SelfTest(created_at=now)

    base = (base_url or sidecar_base_url()).rstrip("/")
    url = f"{base}/api/v1/workspace/hooks/self-test/{token}"
    return {
        "token": token,
        "url": url,
        "max_time_seconds": _CURL_MAX_TIME,
        "expires_in_seconds": _SELF_TEST_TTL_SECONDS,
        "command": _curl_command_for_url(url),
    }


def record_self_test(token: str) -> bool:
    """Mark *token* as received. Returns False for an unknown/expired token —
    the ingest endpoint still answers `continue: true` either way; a probe
    must never be able to block a real hook."""
    now = time.monotonic()
    _prune_self_tests(now)
    entry = _self_tests.get(token)
    if entry is None:
        return False
    entry.received_at = now
    return True


def read_self_test(token: str) -> dict[str, Any]:
    """The self-test receipt. `known: False` for an unknown/expired token —
    never an HTTP error, so any thrown error at this endpoint is genuinely a
    transport/app failure (the property the frontend's failure mapping relies
    on)."""
    now = time.monotonic()
    _prune_self_tests(now)
    entry = _self_tests.get(token)
    if entry is None:
        return {"known": False, "received": False, "elapsed_ms": None}
    received_at = entry.received_at
    elapsed_ms = (
        round((received_at - entry.created_at) * 1000)
        if received_at is not None
        else None
    )
    return {
        "known": True,
        "received": received_at is not None,
        "elapsed_ms": elapsed_ms,
    }
