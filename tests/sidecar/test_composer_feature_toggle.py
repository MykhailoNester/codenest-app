"""Tests for the `composer` feature slug — the native agent pane's gate.

Pins Design decision 1 of the agent-pane-composer plan: no migration is
needed because `get_lookups` merges the stored `enabled_features` setting on
top of `_FEATURES_DEFAULT`, so a slug absent from the baseline seed row still
resolves to its Python default on every install, old or new.
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


def test_composer_is_a_known_feature_slug() -> None:
    assert "composer" in settings_service.KNOWN_FEATURES


def test_composer_defaults_off() -> None:
    assert settings_service._FEATURES_DEFAULT["composer"] is False


@pytest.mark.asyncio
async def test_lookups_serve_composer_false_on_a_freshly_migrated_db(test_app) -> None:
    """The baseline seed row has no `composer` key at all — this is what
    makes editing `migrations/000_baseline_schema.sql` unnecessary."""
    client, _ = test_app
    resp = client.get("/api/v1/settings/lookups")
    assert resp.status_code == 200
    assert resp.json()["enabled_features"]["composer"] is False


@pytest.mark.asyncio
async def test_composer_can_be_turned_on_and_reads_back_true(test_app) -> None:
    client, _ = test_app
    resp = client.put(
        "/api/v1/settings/enabled_features",
        json={"value_json": json.dumps({"composer": True})},
    )
    assert resp.status_code == 200

    lookups = client.get("/api/v1/settings/lookups")
    assert lookups.json()["enabled_features"]["composer"] is True


@pytest.mark.asyncio
async def test_an_unknown_feature_slug_still_422s(test_app) -> None:
    client, _ = test_app
    resp = client.put(
        "/api/v1/settings/enabled_features",
        json={"value_json": json.dumps({"not_a_real_feature": True})},
    )
    assert resp.status_code == 422
