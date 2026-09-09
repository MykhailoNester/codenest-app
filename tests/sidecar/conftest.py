"""Shared fixtures for sidecar (Python) tests.

Each test module that needs a database gets an isolated in-memory SQLite
connection via the `migrated_db` fixture.  The connection has WAL mode,
foreign keys enabled, and all migrations applied.
"""

from __future__ import annotations

import os
import pathlib

import aiosqlite
import pytest
import pytest_asyncio

from app.database import apply_migration_file
from app.services import cwd_resolver_service, project_scanner_service

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


@pytest.fixture(autouse=True)
def _pytest_tmp_is_not_ephemeral(tmp_path_factory, monkeypatch):
    """Keep pytest's own temp tree out of `cwd_resolver_service`'s ephemeral
    roots (#157).

    Ephemeral classification is "resolved path under the OS temp directory",
    and pytest hands every test a `tmp_path` under exactly that
    (`$TMPDIR/pytest-of-<user>/...`). Left alone, every fixture repo built
    under `tmp_path` would resolve as a throwaway scratch run and no test
    could exercise project matching or discovery at all — the same collision
    `_allow_temp_scan_roots` below solves for the scan allowlist.

    The narrowing is surgical rather than a blanket disable: the real root set
    is computed and only the entries that *contain pytest's basetemp* are
    dropped, so `/private/tmp` and the worktree root stay live and a test
    asserting on them is still testing the real thing.
    `tests/sidecar/test_session_kind.py` restores the genuine function where
    it needs the temp tree to read as temp.
    """
    base = os.path.realpath(str(tmp_path_factory.getbasetemp())).rstrip("/")
    kept = tuple(
        root
        for root in cwd_resolver_service._ephemeral_roots()
        if not (base == root or base.startswith(root + "/"))
    )
    monkeypatch.setattr(cwd_resolver_service, "_ephemeral_roots", lambda: kept)


@pytest.fixture(autouse=True)
def _allow_temp_scan_roots(tmp_path_factory, monkeypatch):
    """Project scanning/import is home-scoped in prod (see
    project_scanner_service._allowed_scan_roots). Tests build project dirs under
    pytest's temp tree, so widen the allowlist to include it for the test run."""
    base = pathlib.Path(tmp_path_factory.getbasetemp()).resolve()
    home = pathlib.Path.home().resolve()
    monkeypatch.setattr(
        project_scanner_service,
        "_allowed_scan_roots",
        lambda: (home, base),
    )


async def _apply_all_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    # Use the same pre-hook + SQL applier as init_db so migrations whose columns
    # are added by a Python pre-hook (055 root_path, 061 workspace_id) apply
    # correctly in tests too.
    for migration_file in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await apply_migration_file(db, migration_file)
    # NOTE: do NOT seed any rows here. A freshly migrated DB must match prod —
    # in particular the providers table ships empty (the E0.1 clean-slate
    # invariant asserted by test_migrations / test_providers). Tests that need a
    # provider seed their own row; e.g. test_schedule_service uses an autouse
    # fixture to insert provider id=1 to satisfy its FK / required-provider check.
    await db.commit()


@pytest_asyncio.fixture
async def migrated_db(tmp_path: pathlib.Path) -> aiosqlite.Connection:
    """Isolated in-memory–style SQLite database with all migrations applied."""
    db_path = tmp_path / "test.db"
    conn = await aiosqlite.connect(str(db_path))
    conn.row_factory = aiosqlite.Row
    await _apply_all_migrations(conn)
    yield conn
    await conn.close()
