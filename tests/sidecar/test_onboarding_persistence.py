"""Test that onboarding completion survives a simulated sidecar restart.

Root cause: on a packaged build the PyInstaller sidecar
takes longer to become healthy than dev uvicorn.  The frontend's
``useOnboardingState`` query fired before the sidecar was ready, got a
network error, and — because ``retry: false`` was set — entered permanent
error state.  ``OnboardingGate`` treated the error as "not completed" and
re-routed the user to ``/onboarding`` even though the DB had the completion
flag.

The real fix lives in the frontend (gate the query on sidecar readiness).
This test guards the data-persistence contract the diagnosis relied on:
``workspace_state_service.set`` commits atomically, and a fresh DB
connection (simulating a process restart) reads the value back correctly.
"""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest

from app.database import apply_migration_file
from app.services import workspace_state_service as ws_state

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _open_db(path: pathlib.Path) -> aiosqlite.Connection:
    """Open a WAL-mode, FK-enabled connection to *path*."""
    conn = await aiosqlite.connect(str(path))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA journal_mode=WAL")
    await conn.execute("PRAGMA foreign_keys=ON")
    return conn


async def _apply_migrations(conn: aiosqlite.Connection) -> None:
    for migration_file in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await apply_migration_file(conn, migration_file)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_onboarding_not_completed_by_default(migrated_db) -> None:
    """A fresh DB has no onboarding_completed row — get() returns None and
    the router comparison ``val == 'true'`` yields False."""
    val = await ws_state.get(migrated_db, "onboarding_completed")
    assert val is None
    assert (val == "true") is False


@pytest.mark.asyncio
async def test_onboarding_complete_persists_across_connection_close(
    tmp_path: pathlib.Path,
) -> None:
    """Completing onboarding writes a durable row that a new connection reads.

    This mirrors the real scenario: the user hits "Enter Command Center" on
    the last onboarding step, the sidecar writes the flag and commits, then
    Cmd+Q closes the app (killing the sidecar process).  On next launch a
    brand-new sidecar process opens the same DB file and must see
    ``completed: true``.
    """
    db_path = tmp_path / "test_restart.db"

    # ── first connection (simulates the initial sidecar run) ───────────────
    conn1 = await _open_db(db_path)
    await _apply_migrations(conn1)

    # Mark onboarding complete (mirrors POST /onboarding/complete handler).
    await ws_state.set(conn1, "onboarding_completed", "true")

    # Close the connection (simulates the sidecar process exiting on Cmd+Q).
    await conn1.close()

    # ── second connection (simulates process restart) ───────────────────────
    conn2 = await _open_db(db_path)
    try:
        val = await ws_state.get(conn2, "onboarding_completed")
        assert val == "true", (
            f"onboarding_completed should survive connection close; got {val!r}"
        )
        # Mirror the router comparison to catch any future type drift.
        assert (val == "true") is True
    finally:
        await conn2.close()


@pytest.mark.asyncio
async def test_onboarding_complete_idempotent(migrated_db) -> None:
    """Calling set twice keeps the value correct (ON CONFLICT DO UPDATE path)."""
    await ws_state.set(migrated_db, "onboarding_completed", "true")
    await ws_state.set(migrated_db, "onboarding_completed", "true")
    val = await ws_state.get(migrated_db, "onboarding_completed")
    assert val == "true"


@pytest.mark.asyncio
async def test_onboarding_get_returns_none_for_missing_key(migrated_db) -> None:
    """get() returns None when the key does not exist — no row not a blank."""
    val = await ws_state.get(migrated_db, "nonexistent_key")
    assert val is None
