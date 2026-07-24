import logging
from pathlib import Path

import aiosqlite

from .config import settings

logger = logging.getLogger(__name__)

_db: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    global _db
    if _db is None:
        settings.DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _db = await aiosqlite.connect(str(settings.DATABASE_PATH))
        _db.row_factory = aiosqlite.Row
        await _db.execute("PRAGMA journal_mode=WAL")
        await _db.execute("PRAGMA foreign_keys=ON")
    return _db


async def apply_migration_file(db: aiosqlite.Connection, migration_file: Path) -> None:
    """Execute a migration file's SQL script.

    Shared by ``init_db`` and the test ``conftest`` so both apply migrations
    identically. There are no Python pre-hooks; each migration file is run
    verbatim. ``executescript`` issues an implicit COMMIT before running.
    """
    await db.executescript(migration_file.read_text())


async def init_db():
    db = await get_db()

    # Migration tracking table (must exist before we check anything)
    await db.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    await db.commit()

    migrations_dir = Path(__file__).parent.parent / "migrations"
    for migration_file in sorted(migrations_dir.glob("*.sql")):
        version = migration_file.stem
        row = await db.execute(
            "SELECT 1 FROM schema_migrations WHERE version = ?", (version,)
        )
        if await row.fetchone():
            continue
        await apply_migration_file(db, migration_file)
        await db.execute(
            "INSERT INTO schema_migrations (version) VALUES (?)", (version,)
        )
        await db.commit()


async def close_db():
    global _db
    if _db is not None:
        # Flush the WAL into the main DB and truncate it to zero on clean
        # shutdown (the Rust shell SIGTERMs us first, which fires the FastAPI
        # shutdown event → this). Keeps the next launch's DB-open fast — no
        # large WAL to replay — and shrinks the window in which an orphaned
        # process can hold the WAL lock and block the next sidecar's startup.
        # Best-effort: a checkpoint failure must never prevent the close.
        try:
            await _db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception as exc:  # noqa: BLE001 — never block shutdown on this
            logger.warning("WAL checkpoint on close failed (continuing): %s", exc)
        await _db.close()
        _db = None
