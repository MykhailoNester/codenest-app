"""Retention: the endpoint is reachable, and a bad stored value cannot prune.

Both of these were filed as separate findings and both were still live:

  * `GET /api/v1/schedules/retention` was declared *after* `GET
    /{schedule_id}`. FastAPI matches in declaration order, so the literal path
    was swallowed by the parameterised one and 422'd on the int parse — the
    endpoint had never been reachable.
  * `resolve_retention_days` did a bare `int(json.loads(...))`. The writers
    validate 1-365, but the reader trusted the store, so a hand-edited `0`
    became a prune cutoff of "now" and a negative one a cutoff in the future.
"""

from __future__ import annotations

import json

import aiosqlite
import pytest

from app.routers import schedules as schedules_router
from app.services import event_retention_service


def test_retention_route_is_declared_before_the_id_route() -> None:
    """Declaration order on the router is where this bug lives.

    FastAPI matches routes in the order they were declared, so with
    `GET /{schedule_id}` first, `GET /retention` was matched as a schedule id
    and 422'd on the int parse — unreachable since the day it was added.
    Asserting on the router's own route list tests the ordering directly,
    without needing the app's lifespan or a database.
    """
    paths = [
        (r.path, sorted(r.methods))  # type: ignore[attr-defined]
        for r in schedules_router.router.routes
        if hasattr(r, "methods")
    ]
    gets = [p for p, methods in paths if "GET" in methods]
    assert "/api/v1/schedules/retention" in gets
    assert "/api/v1/schedules/{schedule_id}" in gets
    assert gets.index("/api/v1/schedules/retention") < gets.index(
        "/api/v1/schedules/{schedule_id}"
    ), "literal /retention must be declared before the parameterised route"


async def _store(db: aiosqlite.Connection, key: str, value: object) -> None:
    await db.execute(
        "INSERT INTO app_settings (key, value_json) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        (key, json.dumps(value)),
    )
    await db.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", [0, -1, -9999])
async def test_a_too_small_stored_window_cannot_prune_everything(
    migrated_db: aiosqlite.Connection, stored: int
) -> None:
    cls = event_retention_service.RETENTION_CLASSES[0]
    await _store(migrated_db, cls.setting_key, stored)
    effective = await event_retention_service.resolve_retention_days(migrated_db)
    assert effective[cls.key] == event_retention_service.MIN_RETENTION_DAYS


@pytest.mark.asyncio
async def test_a_too_large_stored_window_is_capped(
    migrated_db: aiosqlite.Connection,
) -> None:
    cls = event_retention_service.RETENTION_CLASSES[0]
    await _store(migrated_db, cls.setting_key, 10_000)
    effective = await event_retention_service.resolve_retention_days(migrated_db)
    assert effective[cls.key] == event_retention_service.MAX_RETENTION_DAYS


@pytest.mark.asyncio
async def test_an_in_range_window_is_returned_unchanged(
    migrated_db: aiosqlite.Connection,
) -> None:
    cls = event_retention_service.RETENTION_CLASSES[0]
    await _store(migrated_db, cls.setting_key, 45)
    effective = await event_retention_service.resolve_retention_days(migrated_db)
    assert effective[cls.key] == 45
