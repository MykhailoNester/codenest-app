"""Workspace catalog change events.

One in-process pub/sub — the same shape as ``agent_service``'s and
``notification_service``'s — for a single fact: *what a session can invoke has
changed, refetch it*.

Published from exactly one place,
:func:`app.services.command_center_service.regenerate_workspace_links`, because
that function already is the single funnel every catalog mutation goes through:
import, rescan, promote, enable/disable, project delete and bootstrap all end in
it, and it is what atomically swaps the workspace ``.claude/`` into place. A
publish anywhere else would either duplicate an event or describe a state that
was never on disk.

The payload deliberately carries no catalog data. A subscriber's job is to drop
its cached answer and ask ``GET /api/v1/command-center/invocables`` again — that
endpoint is cwd-scoped, so a broadcast could not say anything true for every
listener anyway.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

# The SSE event name. Kept as a constant because the router writes it into the
# wire format and the frontend's `WORKSPACE_SSE_EVENT_NAMES` mirrors it.
CHANGED_EVENT = "workspace.catalog.changed"

_subscribers: set[asyncio.Queue[dict]] = set()


def subscribe() -> asyncio.Queue[dict]:
    q: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue[dict]) -> None:
    _subscribers.discard(q)


def subscriber_count() -> int:
    """How many streams are listening. Used by tests and by the regen logger."""
    return len(_subscribers)


def _publish(message: dict) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            # Drop the slowest subscriber rather than block a link
            # regeneration on a webview that stopped reading its socket.
            _subscribers.discard(q)


def publish_changed(
    *,
    reason: str,
    links: int | None = None,
    conflicts: int | None = None,
) -> dict:
    """Broadcast "the catalog changed" and return the message that was sent.

    ``reason`` is diagnostic only — a client invalidates on any of them. Never
    raises: a failure to notify must not fail the regeneration that caused it,
    and ``put_nowait`` on a bounded queue is the only I/O here.
    """
    message = {
        "kind": CHANGED_EVENT,
        "reason": reason,
        "links": links,
        "conflicts": conflicts,
        "at": datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds"),
    }
    _publish(message)
    return message
