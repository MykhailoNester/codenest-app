"""Tests for the workspace catalog change event (#48).

The composer's pickers stay fresh because every catalog mutation ends in
``regenerate_workspace_links`` and that function publishes one
``workspace.catalog.changed`` message. Two things are pinned here: the publish
happens (and only after the tree is actually swapped into place), and the stream
puts it on the wire under the name the frontend listens for.
"""

from __future__ import annotations

import asyncio
import pathlib
from unittest.mock import patch

import aiosqlite
import pytest

from app.config import settings as real_settings
from app.routers import command_center as cc_router
from app.services import catalog_events, command_center_service


@pytest.fixture
def workspace(tmp_path: pathlib.Path):
    """Point WORKSPACE_ROOT at a temp dir for the duration of a test."""
    root = tmp_path / "workspace"
    with patch.object(real_settings, "WORKSPACE_ROOT", root):
        yield root


@pytest.fixture
def subscriber():
    """One live queue, always unsubscribed — the module state is process-wide."""
    q = catalog_events.subscribe()
    try:
        yield q
    finally:
        catalog_events.unsubscribe(q)


def _write_agent(path: pathlib.Path, name: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: d\n---\nbody\n")


async def _insert_project(db: aiosqlite.Connection, name: str) -> int:
    await db.execute(
        """INSERT INTO projects (name, status, is_workspace, is_active, imported_at)
           VALUES (?, 'active', 0, 1, '2024-01-01')""",
        (name,),
    )
    await db.commit()
    row = await (
        await db.execute("SELECT id FROM projects WHERE name = ?", (name,))
    ).fetchone()
    return int(row[0])


async def _insert_agent(
    db: aiosqlite.Connection, project_id: int, name: str, canonical: str
) -> None:
    await db.execute(
        """INSERT INTO project_agents
               (project_id, name, frontmatter_name_raw, canonical_path, link_path,
                link_type, enabled, verify_status)
           VALUES (?, ?, ?, ?, ?, 'symlink', 1, 'ok')""",
        (project_id, name, name, canonical, canonical),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Publishing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_regeneration_publishes_one_change_event(
    migrated_db: aiosqlite.Connection, workspace: pathlib.Path, subscriber, tmp_path
):
    agent = tmp_path / "alpha" / "debugger.md"
    _write_agent(agent, "debugger")
    pid = await _insert_project(migrated_db, "alpha")
    await _insert_agent(migrated_db, pid, "debugger", str(agent))

    regen = await command_center_service.regenerate_workspace_links(
        migrated_db, reason="rescan"
    )

    msg = subscriber.get_nowait()
    assert subscriber.empty(), "one regeneration must be one event, not one per link"
    assert msg["kind"] == catalog_events.CHANGED_EVENT
    assert msg["reason"] == "rescan"
    # The counts a client could log, taken from the same pass it is told about.
    assert msg["links"] == regen["total"] == 1
    assert msg["conflicts"] == 0
    assert msg["at"]


@pytest.mark.asyncio
async def test_event_lands_after_the_workspace_tree_is_swapped_in(
    migrated_db: aiosqlite.Connection, workspace: pathlib.Path, subscriber, tmp_path
):
    """A listener refetches the instant it reads this, so the tree must be real.

    Published before the swap, the refetch would race a `.claude.next/` that is
    not `.claude/` yet — the catalog would answer from a tree the CLI cannot see.
    """
    agent = tmp_path / "alpha" / "debugger.md"
    _write_agent(agent, "debugger")
    pid = await _insert_project(migrated_db, "alpha")
    await _insert_agent(migrated_db, pid, "debugger", str(agent))

    linked: list[bool] = []

    original = command_center_service.catalog_events.publish_changed

    def spy(**kwargs):
        linked.append((workspace / ".claude" / "agents" / "debugger.md").exists())
        return original(**kwargs)

    with patch.object(command_center_service.catalog_events, "publish_changed", spy):
        await command_center_service.regenerate_workspace_links(migrated_db)

    assert linked == [True]
    assert not (workspace / ".claude.next").exists()


@pytest.mark.asyncio
async def test_a_full_subscriber_is_dropped_not_awaited(
    migrated_db: aiosqlite.Connection, workspace: pathlib.Path
):
    """A webview that stopped reading its socket must not stall a regeneration."""
    q = catalog_events.subscribe()
    try:
        for i in range(q.maxsize):
            q.put_nowait({"filler": i})

        await asyncio.wait_for(
            command_center_service.regenerate_workspace_links(migrated_db),
            timeout=10,
        )

        assert catalog_events.subscriber_count() == 0
    finally:
        catalog_events.unsubscribe(q)


# ---------------------------------------------------------------------------
# Stream wiring
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_opens_with_a_change_event_then_relays_published_ones():
    """Driven through the response's own iterator rather than a `TestClient`.

    The generator is an endless loop by design (it pings every 15 s), so a sync
    test client would have to abandon a live connection to return; iterating the
    body directly is the only way to assert on the wire format *and* leave the
    stream properly closed.
    """
    response = await cc_router.stream_catalog_events()
    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache"

    stream = response.body_iterator
    try:
        assert await anext(stream) == b": connected\n\n"

        # A client that missed a regeneration while disconnected cannot know it
        # did, so every connection starts with one change event — the same
        # reason the agents stream opens with a snapshot.
        opening = await anext(stream)
        assert opening.startswith(
            f"event: {catalog_events.CHANGED_EVENT}\ndata: ".encode()
        )
        assert b'"reason": "stream_connected"' in opening

        catalog_events.publish_changed(reason="rescan", links=3, conflicts=1)
        relayed = await anext(stream)
        assert relayed.startswith(
            f"event: {catalog_events.CHANGED_EVENT}\ndata: ".encode()
        )
        assert b'"reason": "rescan"' in relayed
        assert b'"links": 3' in relayed
        assert relayed.endswith(b"\n\n")
    finally:
        await stream.aclose()

    # Closing the stream must take the subscriber with it, or every reconnect
    # would leak a queue the publisher keeps writing to.
    assert catalog_events.subscriber_count() == 0
