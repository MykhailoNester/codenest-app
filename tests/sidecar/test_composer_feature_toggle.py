"""Tests for the retired `composer` / `explorer` feature slugs.

Both used to gate parts of the Terminal page: `composer` the native agent pane
(now the default session surface) and `explorer` the workspace navigator beside
it. Neither is toggleable any more, so this file pins the *retirement* contract
rather than the gate:

* the reader never serves them, on any install, however the setting is stored —
  which is what lets the frontend drop its own gate;
* a write that still carries them is accepted, because
  `000_baseline_schema.sql` seeded them into `enabled_features` on every
  existing install and that migration can never be edited;
* a genuine typo is still a 422.
"""

from __future__ import annotations

import json

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import settings as settings_router
from app.services import settings_service


@pytest_asyncio.fixture
async def test_app(migrated_db: aiosqlite.Connection):
    """FastAPI test client wired to the isolated migrated database."""
    original = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(settings_router.router)
    with TestClient(application, raise_server_exceptions=True) as client:
        yield client, migrated_db
    db_module._db = original


def test_retired_slugs_are_not_toggleable() -> None:
    for slug in ("composer", "explorer"):
        assert slug not in settings_service.KNOWN_FEATURES
        assert slug not in settings_service._FEATURES_DEFAULT
        assert slug in settings_service._RETIRED_FEATURES


@pytest.mark.asyncio
async def test_lookups_never_serve_a_retired_slug(test_app) -> None:
    client, _ = test_app
    resp = client.get("/api/v1/settings/lookups")
    assert resp.status_code == 200
    features = resp.json()["enabled_features"]
    assert "composer" not in features
    assert "explorer" not in features


@pytest.mark.asyncio
async def test_a_stored_retired_slug_is_accepted_but_dropped(test_app) -> None:
    """An existing install PUTs the map it already has — including the slugs
    the baseline seeded — and must not get a 422 for it."""
    client, _ = test_app
    resp = client.put(
        "/api/v1/settings/enabled_features",
        json={
            "value_json": json.dumps(
                {"composer": False, "explorer": False, "feed": True}
            )
        },
    )
    assert resp.status_code == 200

    features = client.get("/api/v1/settings/lookups").json()["enabled_features"]
    assert "composer" not in features
    assert "explorer" not in features
    assert features["feed"] is True


@pytest.mark.asyncio
async def test_an_unknown_feature_slug_still_422s(test_app) -> None:
    client, _ = test_app
    resp = client.put(
        "/api/v1/settings/enabled_features",
        json={"value_json": json.dumps({"not_a_real_feature": True})},
    )
    assert resp.status_code == 422
