"""Claude Code hook-setup guidance, inbound-ping verification, and install.

Onboarding shows the user the exact ``hooks`` block for their Claude Code
``settings.json`` so the command center receives session telemetry.
``hooks_status`` reports whether any inbound hook has been received yet, which
the UI uses to confirm the wiring. Since #170 the block can also be *written*
— see "Write-through install" below and the long comment above
``hook_authorship``; before it, guided copy-paste was the only path and this
module opened a user's file for reading only.

The hook type is ``"command"`` — a ``curl`` POST of the hook payload (piped in
on stdin via ``--data-binary @-``) to the sidecar endpoint, ending in
``|| true``. The native ``"http"`` hook type surfaces a connection error
(``ECONNREFUSED``) in every Claude Code session when the desktop app is offline;
the ``|| true`` makes curl always exit 0 so the hook silently no-ops instead.
``--max-time`` is one second under the hook ``timeout`` so curl aborts cleanly
before the harness kills it — the sidecar is never on the critical path. Each
event carries a ``"matcher": "*"`` so every session is captured regardless of
cwd. Every command also carries the marker header ``X-Codenest-Hook``, which is
inert on the wire and exists so the installer can tell its own work from
somebody else's.

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
  event loop (``asyncio.to_thread``; read-only, and it stays read-only now
  that the install path below exists) and diffs its ``hooks`` block against
  what ``build_hook_settings`` would emit, per event. It never returns file
  contents, only the structural verdict.
* ``mint_self_test`` / ``record_self_test`` / ``read_self_test`` back a true
  end-to-end check: the frontend hands the minted URL to the Rust shell,
  which spawns the same ``curl`` a real hook would run, so an inbound POST is
  actually observed. Token state is an in-process ``OrderedDict`` (this is a
  single uvicorn process, no ``--workers``) keyed on ``time.monotonic()`` — no
  ``datetime`` is involved and no schema change is needed.

Write-through install (#170)
----------------------------
``install_settings_files`` merges this module's block into a real
``settings.json``: it adds the events that are missing, rewrites the hooks this
app itself wrote in an older shape, and leaves everything else in the file
exactly where it was. ``plan_settings_files`` is the same computation with the
write removed, so the UI can show what would change before anything does.

The whole of the design is in one constraint: a ``settings.json`` is the user's
property and holds hooks from other tools and from their own hand, so
clobbering one of those is a worse outcome than never installing at all. Three
rules follow, and each is enforced rather than intended:

* authorship is decided before anything is touched, by a marker header *and* a
  host/path check that must agree — see the comment above ``hook_authorship``;
* the write is atomic (temp file in the same directory, ``os.replace`` over the
  target) and is preceded by a timestamped backup, so no failure anywhere in
  this module can leave a user with a truncated settings.json and no copy of
  what it used to say;
* anything this module cannot merge into with certainty — invalid JSON, an
  oversized file, a directory, a symlink resolving outside the allowed roots,
  an unwritable path, a ``hooks`` block of an unexpected shape — is refused
  whole, per file, with the reason reported. There is no partial write.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import secrets
import stat
import tempfile
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import aiosqlite

from app.services import project_scanner_service

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

# The install marker (#170). Every command this module mints carries this
# header, and it is the first half of the test that decides whether the
# installer may rewrite a hook (the second half is the host/path check — see
# the comment above ``hook_authorship``).
#
# It is a request header rather than a comment or a wrapper because a hook
# command has nowhere else to put one: the settings.json format is JSON with no
# comment syntax, the hook object's keys are a fixed schema Claude Code
# validates, and anything bolted onto the shell string itself would change what
# the command *does*. A header changes nothing — the sidecar never reads it,
# curl sends one more line, and every failure mode of the command is the one it
# had before. The value is a format version, not a secret: it identifies which
# generation of this app minted the command, so a future change of shape can be
# recognised without guessing.
_MARKER_HEADER = "X-Codenest-Hook"
_MARKER_VERSION = "1"
_MARKER_ARG = f"-H '{_MARKER_HEADER}: {_MARKER_VERSION}'"


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

    Both forms carry ``_MARKER_ARG`` (#170), and it sits *before* the URL on
    purpose. ``_verdict_for_hook`` grades an installed command by asking
    whether ``f"{base}{target_path}"`` appears in it, so anything inserted
    between ``curl`` and the URL leaves every existing verdict exactly as it
    was; anything inserted between the base and the path would flip every
    install in the world to "mismatch" at once.
    """
    if discard_stdout:
        return (
            f"curl -s --max-time {_CURL_MAX_TIME} -X POST "
            f"-H 'Content-Type: application/json' {_MARKER_ARG} --data-binary @- "
            f"{url} >/dev/null 2>&1 || true"
        )
    return (
        f"curl -s --fail --max-time {_CURL_MAX_TIME} -X POST "
        f"-H 'Content-Type: application/json' {_MARKER_ARG} --data-binary @- "
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
                "command": "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -H 'X-Codenest-Hook: 1' --data-binary @- http://localhost:8002/api/v1/hooks/session-start >/dev/null 2>&1 || true",
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
    'ok' | 'missing_file' | 'invalid_json' | 'unreadable'. Blocking; called
    only from a to_thread hop. Only ever opens *path* for reading: this is the
    read half of the module and it stays read-only even now that a write half
    exists below it, which is why the installer calls this for the file's
    current content rather than opening it a second way.
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


# ─── write-through install, part 1: whose hook is this? ──────────────────────
#
# Everything from here to the end of the install section is the write path this
# module spent two releases not having, and the reason it exists is a class of
# install the read path structurally cannot fix: a hook *this app itself wrote*
# in an older shape, which still grades "ok" and quietly does the wrong thing.
#
# #172's `PreToolUse` is the motivating case and worth stating exactly. Before
# it, all 22 commands ended in `>/dev/null 2>&1`. After it, `PreToolUse`'s
# stdout is the channel a pre-authorisation decision comes back on. A user who
# installed before #172 still has the redirecting command, `_verdict_for_hook`
# grades by containment so their file still verifies green, and every standing
# rule they write from now on is computed by the sidecar, printed by curl, and
# discarded into /dev/null with no signal at any layer. Only a writer can
# repair that, and only a writer that can tell its own work from a stranger's
# may be trusted to try.
#
# Authorship is therefore decided before anything is touched, by two
# independent facts that must agree:
#
# * the marker header — every command minted from #170 onward carries
#   `-H 'X-Codenest-Hook: 1'`. A command carrying it came out of a generator,
#   not out of somebody's hand.
# * the host and path — the command must actually target this app's ingest
#   endpoint *for the very event it is filed under*, at one of the loopback
#   spellings of the sidecar's own base URL.
#
# Neither half is sufficient, and each covers the other's blind spot. The
# marker alone would adopt any command someone pasted one of ours into and then
# built on — the marker is a plain string in a file anyone may copy. The
# host/path alone would adopt a stranger's curl that happens to POST to our
# endpoint, which is precisely the shape #169 already refuses to even print
# back, because a hand-written call to a local HTTP API is the one most likely
# to be carrying a credential in the same argv. Both together is the owner's
# rule. A hook failing either is somebody else's: it is never rewritten, never
# removed, never reordered, and nothing about it beyond this verdict is read.

# Authorship verdicts. `FOREIGN` is the safe default and every uncertain case
# resolves to it, because the cost of misfiling somebody else's hook as ours is
# a destroyed hook and the cost of misfiling ours as theirs is a duplicate.
AUTHORSHIP_CURRENT = "current"  # ours, and exactly what we would emit today
AUTHORSHIP_STALE = "stale"  # ours, in a shape we no longer emit
AUTHORSHIP_FOREIGN = "foreign"  # not ours; do not touch

# The command shapes earlier releases minted, frozen as literals with a `{url}`
# hole. They are deliberately NOT rebuilt from `_CURL_MAX_TIME` or from
# `_curl_command_for_url`: what a past release wrote into a user's file is a
# historical fact, and deriving it from today's constants would silently
# rewrite that history the first time one of them changed — at which moment
# every install of that era would stop being recognisable as ours and become
# permanently un-repairable. New entries are appended here, never edited.
#
# This list is also the only way a pre-#170 install is recognisable at all:
# those commands predate the marker, so the marker rule cannot reach them.
# Exact string equality is what makes that safe. It is not a weaker test than
# the marker — it is a stricter one, admitting only a command that is
# character-for-character something this app generated, which is the same
# standard `effective_hooks_service.authored_commands` already holds its own
# output to.
_LEGACY_COMMAND_FORMS: tuple[str, ...] = (
    # Generation 1 (up to #172) — one form for all 22 events, stdout always
    # discarded. A `PreToolUse` hook in this shape is the repair case above.
    (
        "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' "
        "--data-binary @- {url} >/dev/null 2>&1 || true"
    ),
    # Generation 2 (#172, before this ticket) — the builder split in two and
    # the undiscarded `PreToolUse` form gained `--fail`. Still no marker.
    (
        "curl -s --fail --max-time 5 -X POST -H 'Content-Type: application/json' "
        "--data-binary @- {url} 2>/dev/null || true"
    ),
)


def _targets_pattern(base: str, target_path: str) -> re.Pattern[str]:
    """Regex matching this app's endpoint at *base*, with the same trailing
    boundary `_endpoint_pattern` uses so `/stop` cannot match `/stop-foo`."""
    return re.compile(re.escape(f"{base}{target_path}") + r"(?![\w-])")


def hook_authorship(
    hook: Mapping[str, Any], event: str, base_url: str | None = None
) -> str:
    """Whether *hook*, filed under *event*, is ours — and if so, still current.

    The one gate in front of every rewrite. See the comment above for why it
    takes two agreeing facts and why it fails closed; the short version is that
    a wrong `FOREIGN` costs a duplicate hook and a wrong `CURRENT`/`STALE`
    costs somebody else's work.

    A command wired at a different loopback spelling of our own base URL
    (`127.0.0.1` where the sidecar says `localhost`) is `CURRENT`, not `STALE`
    — it works, and `_verdict_for_hook` already treats the two as equivalent,
    so calling it stale here would make every such install repair itself
    forever and never reach a fixed point.
    """
    spec = _EVENTS_BY_NAME.get(event)
    if spec is None:
        return AUTHORSHIP_FOREIGN

    base = (base_url or sidecar_base_url()).rstrip("/")
    equivalents = _equivalent_base_urls(base)

    command = hook.get("command")
    if isinstance(command, str):
        stripped = command.strip()
        if not any(
            _targets_pattern(alias, spec.path).search(stripped) for alias in equivalents
        ):
            return AUTHORSHIP_FOREIGN
        current = {_curl_command(alias, spec).strip() for alias in equivalents}
        if _MARKER_HEADER in stripped:
            return AUTHORSHIP_CURRENT if stripped in current else AUTHORSHIP_STALE
        legacy = {
            form.format(url=f"{alias}{spec.path}")
            for alias in equivalents
            for form in _LEGACY_COMMAND_FORMS
        }
        return AUTHORSHIP_STALE if stripped in legacy else AUTHORSHIP_FOREIGN

    # The legacy `"http"` hook type, which has no command to carry a marker and
    # no argv to hide anything in. Exact equality against the endpoint URL is
    # the whole test: this shape is either the URL we would have written or it
    # is not ours. It is always stale — the app stopped emitting it precisely
    # because it raises ECONNREFUSED in every session when the app is offline.
    url = hook.get("url")
    if isinstance(url, str) and url.strip() in {
        f"{alias}{spec.path}" for alias in equivalents
    }:
        return AUTHORSHIP_STALE
    return AUTHORSHIP_FOREIGN


# ─── write-through install, part 2: planning the merge ───────────────────────

# Per-event outcomes. Reported for all 22 whether or not anything changed, so
# the dry run is a complete account of the file rather than a diff the reader
# has to invert.
ACTION_OK = "ok"  # already present and current; nothing to do
ACTION_REPAIR = "repair"  # an ours-hook rewritten in place
ACTION_ADD = "add"  # no ours-hook under a "*" matcher; one appended
ACTION_CONFLICT = "conflict"  # a shape we will not merge into; refuses the file


def _desired_entry(block: dict, event: str) -> dict:
    """The `{matcher, hooks[]}` entry `build_hook_settings` mints for *event*.

    Taken from that builder's own output rather than assembled here: it is the
    single source of the 22 commands, and a second place that knows what a
    correct entry looks like is a second place to forget to update.
    """
    return copy.deepcopy(block["hooks"][event][0])


def _plan_event(
    entries: list[Any], spec: HookEvent, desired: dict, base: str
) -> dict[str, Any]:
    """Merge our hook for *spec* into *entries*, mutating it in place.

    *entries* is the list a settings.json has under one event name. Third-party
    hooks in it are counted and then left exactly where they are — same object,
    same index, same enclosing entry — because the list is rewritten by
    `json.dumps` of this very structure and anything not reassigned survives
    byte for byte.
    """
    desired_hook = desired["hooks"][0]
    repaired = 0
    left_narrow = 0
    left_foreign = 0
    left_malformed = 0
    covered = False

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        wrapped = entry.get("hooks")
        if not isinstance(wrapped, list):
            # Either a `{matcher}` object with no hooks list, or a bare hook
            # dict sitting flat in the event array — the shape
            # `classify_settings_hooks` calls "malformed". If it is ours we say
            # so and still do not touch it: deleting is the one operation that
            # cannot be undone by running the installer again.
            if hook_authorship(entry, spec.event, base) != AUTHORSHIP_FOREIGN:
                left_malformed += 1
            continue
        matcher = entry.get("matcher")
        for index, hook in enumerate(wrapped):
            if not isinstance(hook, dict):
                continue
            verdict = hook_authorship(hook, spec.event, base)
            if verdict == AUTHORSHIP_FOREIGN:
                left_foreign += 1
                continue
            if matcher != "*":
                # Ours by authorship, but the matcher is an edit we never make.
                # It is also a property of the *entry*, shared with any sibling
                # hook in it, so narrowing or widening it here could change the
                # behaviour of a third-party hook standing beside ours. Left
                # alone, and it does not count as coverage — the `*` entry
                # appended below is what makes the event verify.
                left_narrow += 1
                continue
            covered = True
            if verdict == AUTHORSHIP_STALE:
                wrapped[index] = copy.deepcopy(desired_hook)
                repaired += 1

    if not covered:
        entries.append(copy.deepcopy(desired))

    if repaired:
        action = ACTION_REPAIR
    elif not covered:
        action = ACTION_ADD
    else:
        action = ACTION_OK
    return {
        "event": spec.event,
        "action": action,
        "repaired": repaired,
        "left_narrow": left_narrow,
        "left_foreign": left_foreign,
        "left_malformed": left_malformed,
        "detail": None,
    }


def _conflict(event: str, detail: str) -> dict[str, Any]:
    return {
        "event": event,
        "action": ACTION_CONFLICT,
        "repaired": 0,
        "left_narrow": 0,
        "left_foreign": 0,
        "left_malformed": 0,
        "detail": detail,
    }


def _plan_settings_body(parsed: object, base: str) -> tuple[object, list[dict], str]:
    """(new body, per-event plan, refusal) for an already-parsed settings body.

    Pure: no filesystem, no clock, same testability contract as
    `classify_settings_hooks` above it. A non-empty refusal means nothing may
    be written and the returned body must be discarded.

    Refuses rather than reshapes. A `hooks` value that is not an object, or an
    event whose value is not an array, is a structure somebody built on purpose
    or a file that is not a settings.json at all; either way replacing it is a
    guess, and the one thing this module may never do with a user's file is
    guess. A file whose whole body is a JSON `null`, a list or a string is the
    same refusal for the same reason — the caller passes `{}` for a file that
    does not exist yet, which is the only case where starting from nothing is
    starting from something the user did not write.
    """
    if not isinstance(parsed, dict):
        return None, [], "settings.json does not contain a JSON object"

    body = copy.deepcopy(parsed)
    hooks_block = body.get("hooks")
    if hooks_block is None:
        hooks_block = {}
        body["hooks"] = hooks_block
    elif not isinstance(hooks_block, dict):
        return None, [], 'the top-level "hooks" key must be an object'

    offered = build_hook_settings(base)
    plan: list[dict[str, Any]] = []
    conflicts: list[str] = []
    for spec in HOOK_EVENTS:
        entries = hooks_block.get(spec.event)
        if entries is None:
            entries = []
            hooks_block[spec.event] = entries
        elif not isinstance(entries, list):
            conflicts.append(spec.event)
            plan.append(_conflict(spec.event, f'"{spec.event}" is not an array'))
            continue
        plan.append(
            _plan_event(entries, spec, _desired_entry(offered, spec.event), base)
        )

    if conflicts:
        return (
            None,
            plan,
            "refusing to merge: "
            + ", ".join(f'"{name}" is not an array' for name in conflicts),
        )
    return body, plan, ""


def _plan_changes_file(plan: Sequence[Mapping[str, Any]]) -> bool:
    return any(entry["action"] in (ACTION_ADD, ACTION_REPAIR) for entry in plan)


# ─── write-through install, part 3: touching the disk ────────────────────────

# Suffix for the pre-write copy. Timestamped rather than fixed so a second
# repair can never overwrite the evidence the first one preserved, and left
# beside the target rather than in app-data so it is where a user looking for
# it would look.
_BACKUP_SUFFIX = ".codenest-backup"


def _resolve_write_target(config_home: str) -> tuple[Path | None, str | None]:
    """(path to write, refusal). Exactly one of the two is None.

    Applies the same containment policy as every other path-taking endpoint in
    the sidecar (`project_scanner_service._require_scan_scope`, reached here
    the way `effective_hooks_service._in_scan_scope` reaches it): these routes
    are unauthenticated localhost routes, so a caller-supplied path has to stay
    inside the home tree and out of the directories that hold credentials. That
    mattered for a reader; for a writer it is the difference between a scan and
    an overwrite.

    A symlinked settings.json is resolved and the check applied to the *real*
    path, which is then what gets written — so a config file a user keeps in a
    dotfiles repo and links into place survives the install as a link, and one
    linked somewhere the policy does not allow is refused instead of followed.
    """
    raw = Path(settings_json_path(config_home))
    if not raw.is_absolute():
        return None, f"resolved path is not absolute: {raw}"
    try:
        target = raw.resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as exc:
        return None, f"cannot resolve {raw}: {exc}"

    try:
        project_scanner_service._require_scan_scope(target.parent)
    except (ValueError, OSError, RuntimeError) as exc:
        return None, str(exc)

    if target.is_dir():
        return None, f"{target} is a directory, not a file"

    parent = target.parent
    if not parent.is_dir():
        # Deliberately not created. The directory name came from the caller,
        # and a config home that does not exist is far more likely to be a
        # typo or an unconfigured provider than a place the user wants this
        # app to start making directories.
        return None, f"{parent} does not exist; create the config home first"
    if not os.access(parent, os.W_OK | os.X_OK):
        return None, f"{parent} is not writable"
    if target.exists() and not os.access(target, os.W_OK):
        return None, f"{target} is not writable"
    return target, None


def _atomic_write(target: Path, data: bytes, mode: int | None) -> None:
    """Write *data* to *target* so that no failure can truncate it.

    A settings.json holds every hook every tool the user has ever installed
    ever wrote. A plain `open(..., "w")` empties it before the first byte goes
    in, so a crash, a full disk or a kill between those two moments loses all
    of it. This writes a temp file in the *same directory* — same filesystem,
    which is what makes the following step a rename and not a copy — fsyncs it,
    then `os.replace`s it over the target. A reader at any instant sees either
    the whole old file or the whole new one.

    The target's permission bits are carried over when it already exists; a new
    file keeps `mkstemp`'s 0600, which is the right default for a file that
    routinely holds an API key.
    """
    handle, temp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=f".{target.name}.", suffix=".codenest-tmp"
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(handle, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            os.chmod(temp_path, mode)
        os.replace(temp_path, target)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    # The rename itself is only durable once the directory entry is. Best
    # effort: a filesystem that will not give us a directory handle has still
    # had the atomic replace, which is the property that matters here.
    try:
        dir_handle = os.open(str(target.parent), os.O_RDONLY)
        try:
            os.fsync(dir_handle)
        finally:
            os.close(dir_handle)
    except OSError:
        pass


def _write_backup(target: Path, previous: bytes, mode: int | None) -> Path:
    """Copy the pre-write content beside *target* and return where it went.

    Written through `_atomic_write` as well: a half-written backup is worse
    than none, because it looks like a restore point and is not one.
    """
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    candidate = target.with_name(f"{target.name}{_BACKUP_SUFFIX}-{stamp}")
    suffix = 1
    while candidate.exists():
        candidate = target.with_name(f"{target.name}{_BACKUP_SUFFIX}-{stamp}-{suffix}")
        suffix += 1
    _atomic_write(candidate, previous, mode)
    return candidate


def _install_one(config_home: str, base: str, apply: bool) -> dict[str, Any]:
    """Plan (and optionally perform) the merge for one config home.

    Never raises on the state of a user's files, for the same reason
    `verify_settings_files` does not: a missing, unreadable, oversized or
    unparseable settings.json is a real situation the UI has to explain, not a
    request the client got wrong. Each becomes `status: "refused"` with the
    reason attached.
    """
    result: dict[str, Any] = {
        "config_home": config_home,
        "settings_path": settings_json_path(config_home),
        "status": "refused",
        "refusal": None,
        "changed": False,
        "created_file": False,
        "backup_path": None,
        "events": [],
    }

    target, refusal = _resolve_write_target(config_home)
    if target is None:
        result["refusal"] = refusal
        return result
    result["settings_path"] = str(target)

    # The same reader the verify path uses, so the size ceiling, the UTF-8
    # rule and the JSON rule are one implementation and cannot diverge between
    # what the app is willing to read and what it is willing to rewrite.
    read_status, parsed, detail = _read_settings(target)
    if read_status not in ("ok", "missing_file"):
        result["refusal"] = detail or f"settings.json is {read_status}"
        return result
    created = read_status == "missing_file"

    body, plan, plan_refusal = _plan_settings_body({} if created else parsed, base)
    result["events"] = plan
    if plan_refusal:
        result["refusal"] = plan_refusal
        return result

    changed = _plan_changes_file(plan)
    result["changed"] = changed
    result["created_file"] = created

    if not apply:
        result["status"] = "planned" if changed else "unchanged"
        return result
    if not changed:
        result["status"] = "unchanged"
        return result

    try:
        if created:
            mode: int | None = None
            previous: bytes | None = None
        else:
            mode = stat.S_IMODE(target.stat().st_mode)
            previous = target.read_bytes()
        rendered = (json.dumps(body, indent=2, ensure_ascii=False) + "\n").encode(
            "utf-8"
        )
        if previous is not None:
            result["backup_path"] = str(_write_backup(target, previous, mode))
        _atomic_write(target, rendered, mode)
    except (OSError, ValueError) as exc:
        # The backup, if one was taken, is already on disk and named in the
        # result: a failure here leaves the target either untouched (the write
        # never began) or whole (the rename never half-happened).
        result["status"] = "refused"
        result["refusal"] = f"write failed: {exc}"
        return result

    result["status"] = "applied"
    return result


def _install_sync(
    config_homes: Sequence[str], base: str, apply: bool
) -> dict[str, Any]:
    results = [_install_one(config_home, base, apply) for config_home in config_homes]
    if not results:
        overall = "unchanged"
    elif any(r["status"] == "refused" for r in results):
        overall = "refused"
    elif any(r["status"] == "applied" for r in results):
        overall = "applied"
    elif any(r["status"] == "planned" for r in results):
        overall = "planned"
    else:
        overall = "unchanged"
    return {
        "base_url": base,
        "dry_run": not apply,
        "overall": overall,
        "results": results,
    }


async def plan_settings_files(
    config_homes: Sequence[str], base_url: str | None = None
) -> dict[str, Any]:
    """What `install_settings_files` would change, with the write removed.

    A separate entry point rather than a flag on the writer, and the route
    layer keeps them separate too: "this call cannot write" is worth making
    true by construction rather than by the value of an argument that a caller,
    a default, or a serialisation bug could get wrong.
    """
    return await asyncio.to_thread(
        _install_sync,
        list(config_homes),
        (base_url or sidecar_base_url()).rstrip("/"),
        False,
    )


async def install_settings_files(
    config_homes: Sequence[str], base_url: str | None = None
) -> dict[str, Any]:
    """Merge this module's hook block into each config home's settings.json.

    Off the event loop for the same reason the verify path is (one
    `asyncio.to_thread` hop for the whole request): these are blocking reads
    and writes of files that may be large, and the sidecar is one process
    serving every other hook arriving at the same moment.

    Idempotent by construction, not by convention: a second call finds every
    event covered by a `"*"` entry whose command is exactly what
    `build_hook_settings` emits, plans no change, and so never reaches the
    write at all — which is also why it takes no second backup.
    """
    return await asyncio.to_thread(
        _install_sync,
        list(config_homes),
        (base_url or sidecar_base_url()).rstrip("/"),
        True,
    )


# ─── write-through install, part 4: the reuse seam (#179) ────────────────────
#
# `settings.json` has a second thing in it this app has a reason to write: the
# `env` block that turns Claude Code telemetry on and points its OTLP exporter
# at this sidecar (#179). That is a different key, a different vocabulary and a
# different consent question, so it is a different module — but it is the same
# file, and it must not be a second writer.
#
# Everything that makes the install above safe is a property of *how the file
# is touched*, not of what is written into it: the containment policy on the
# resolved path, the one reader with its size/UTF-8/JSON rules, the temp-file
# and rename, the timestamped backup beside the target. A module that copied
# those would be one `os.replace` away from being the one that truncates a
# user's settings.json, and the copy would drift from this one silently.
#
# So the four primitives are published here, under names without a leading
# underscore, and `telemetry_enable_service` calls them. They are thin on
# purpose: each is exactly its private counterpart, with no argument massaged
# and no behaviour added, so this section can never become a second
# implementation of anything. `_install_one` above still calls the private
# names directly, which keeps the #170 path byte-for-byte what it was.


def read_settings_file(path: Path) -> tuple[str, object | None, str | None]:
    """`(status, parsed, detail)` for a settings.json — see `_read_settings`.

    Status is `'ok' | 'missing_file' | 'invalid_json' | 'unreadable'`. Blocking;
    call it from a `to_thread` hop.
    """
    return _read_settings(path)


def resolve_write_target(config_home: str) -> tuple[Path | None, str | None]:
    """`(path to write, refusal)` for a config home — see `_resolve_write_target`.

    Exactly one of the two is None. This is the containment check, and for a
    writer on an unauthenticated loopback route it is the only thing between a
    caller-supplied path and an arbitrary overwrite.
    """
    return _resolve_write_target(config_home)


def atomic_write(target: Path, data: bytes, mode: int | None) -> None:
    """Write *data* over *target* without a window in which it is truncated —
    see `_atomic_write`."""
    _atomic_write(target, data, mode)


def write_backup(target: Path, previous: bytes, mode: int | None) -> Path:
    """Copy *previous* beside *target* and return where it went — see
    `_write_backup`. The suffix and timestamp scheme is shared, so a user
    looking for "the copy this app took" finds one naming convention."""
    return _write_backup(target, previous, mode)


def loopback_equivalents(base_url: str) -> tuple[str, ...]:
    """*base_url* spelled with each loopback alias, itself first.

    Published for the same reason as the four above: `127.0.0.1:8002` and
    `localhost:8002` are the same endpoint, and a second module deciding that
    for itself is a second module that can decide it differently.
    """
    return _equivalent_base_urls(base_url)


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
