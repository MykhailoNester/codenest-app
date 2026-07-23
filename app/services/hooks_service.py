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
"""

from __future__ import annotations

import os
from pathlib import Path

import aiosqlite

# Default base URL for hook endpoints. Uses ``localhost`` (not 127.0.0.1)
# because that matches what users' existing ``settings.json`` files typically
# contain and avoids IPv4/IPv6 resolution surprises on some macOS setups.
_DEFAULT_BASE_URL = "http://localhost:8002"

# Claude Code hook event name -> sidecar ingest endpoint path segment.
_HOOK_EVENTS: tuple[tuple[str, str], ...] = (
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "user-prompt"),
    ("PreToolUse", "pre-tool"),
    ("PostToolUse", "post-tool"),
    ("Stop", "stop"),
    ("SessionEnd", "session-end"),
)

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


def _curl_command(base: str, ep: str) -> str:
    """Shell command that POSTs the hook payload (stdin) to the sidecar.

    ``--data-binary @-`` forwards the hook event JSON that Claude Code pipes in
    on stdin, so the sidecar receives the same body the old ``http`` hook sent.
    ``|| true`` swallows curl's non-zero exit when the app is offline so Claude
    Code never surfaces a hook error. Output is discarded (``>/dev/null 2>&1``)
    to keep ``SessionStart`` / ``UserPromptSubmit`` stdout out of the context.
    """
    return (
        f"curl -s --max-time {_CURL_MAX_TIME} -X POST "
        "-H 'Content-Type: application/json' --data-binary @- "
        f"{base}/api/v1/hooks/{ep} >/dev/null 2>&1 || true"
    )


def build_hook_settings(base_url: str | None = None) -> dict:
    """Return the ``{"hooks": {...}}`` block to merge into settings.json.

    Emits the ``"type": "command"`` hook format: a ``curl`` POST that no-ops
    (``|| true``) when the desktop app is offline, instead of the native
    ``"http"`` type which raises ``ECONNREFUSED`` in every session. Each event
    gets a single entry with ``"matcher": "*"`` so all sessions are captured
    regardless of cwd or project.

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
        event: [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": _curl_command(base, ep),
                        "timeout": _HOOK_TIMEOUT,
                    }
                ],
            }
        ]
        for event, ep in _HOOK_EVENTS
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
