"""Tests for IDEA-08 markdown editor service + router."""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import markdown_editor as md_router
from app.services import markdown_editor_service as svc


@pytest_asyncio.fixture
async def editor_app(
    migrated_db: aiosqlite.Connection,
) -> tuple[TestClient, aiosqlite.Connection]:
    original_db = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(md_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db
    db_module._db = original_db


async def _make_project(db: aiosqlite.Connection, project_path: pathlib.Path) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, status, path) VALUES (?, 'active', ?)",
        ("editor-test", str(project_path)),
    )
    await db.commit()
    return int(cur.lastrowid or 0)


@pytest.mark.asyncio
async def test_read_returns_empty_for_missing_file(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    pid = await _make_project(migrated_db, tmp_path)
    result = await svc.read(migrated_db, pid, "claude")
    assert result["exists"] is False
    assert result["content"] == ""
    assert result["path"].endswith("/CLAUDE.md")


@pytest.mark.asyncio
async def test_read_existing_file(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    (tmp_path / "CLAUDE.md").write_text("# Hello\n", encoding="utf-8")
    pid = await _make_project(migrated_db, tmp_path)
    result = await svc.read(migrated_db, pid, "claude")
    assert result["exists"] is True
    assert result["content"] == "# Hello\n"
    assert len(result["sha"]) == 64


@pytest.mark.asyncio
async def test_write_round_trips(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    pid = await _make_project(migrated_db, tmp_path)
    written = await svc.write(migrated_db, pid, "agents", "# Agents\n\nVega\n", None)
    assert written["content"].startswith("# Agents")
    assert (tmp_path / "AGENTS.md").read_text() == "# Agents\n\nVega\n"


@pytest.mark.asyncio
async def test_write_rejects_stale_sha(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    (tmp_path / "CLAUDE.md").write_text("initial\n", encoding="utf-8")
    pid = await _make_project(migrated_db, tmp_path)
    # Caller passes a wrong sha (e.g. they saw a different version).
    with pytest.raises(Exception) as exc:
        await svc.write(migrated_db, pid, "claude", "new\n", "deadbeef")
    assert "changed since you started editing" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_diff_format_and_no_op(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    (tmp_path / "CLAUDE.md").write_text("line a\nline b\n", encoding="utf-8")
    pid = await _make_project(migrated_db, tmp_path)
    same = await svc.diff(migrated_db, pid, "claude", "line a\nline b\n")
    assert same["no_op"] is True
    diff = await svc.diff(migrated_db, pid, "claude", "line a\nline B\n")
    assert diff["no_op"] is False
    assert "-line b" in diff["unified_diff"]
    assert "+line B" in diff["unified_diff"]


@pytest.mark.asyncio
async def test_rejects_unknown_kind(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    pid = await _make_project(migrated_db, tmp_path)
    with pytest.raises(Exception) as exc:
        await svc.read(migrated_db, pid, "settings")
    assert "unknown kind" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_symlink_target_is_rejected(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    # Create a CLAUDE.md that's actually a symlink to /etc/hosts (or any
    # path outside tmp_path). The service should refuse.
    target = tmp_path / "CLAUDE.md"
    outside = tmp_path.parent / "evil.md"
    outside.write_text("nope", encoding="utf-8")
    target.symlink_to(outside)
    pid = await _make_project(migrated_db, tmp_path)
    with pytest.raises(Exception) as exc:
        await svc.read(migrated_db, pid, "claude")
    detail = str(exc.value.detail).lower()
    assert "symlink" in detail or "escapes the project root" in detail


@pytest.mark.asyncio
async def test_router_read_diff_write(
    editor_app: tuple[TestClient, aiosqlite.Connection], tmp_path: pathlib.Path
) -> None:
    client, db = editor_app
    (tmp_path / "CLAUDE.md").write_text("v1\n", encoding="utf-8")
    pid = await _make_project(db, tmp_path)
    r = client.get(f"/api/v1/markdown-files/{pid}", params={"kind": "claude"})
    assert r.status_code == 200
    body = r.json()
    assert body["content"] == "v1\n"
    sha = body["sha"]
    d = client.post(
        f"/api/v1/markdown-files/{pid}/diff",
        json={"kind": "claude", "content": "v2\n"},
    )
    assert d.status_code == 200
    assert d.json()["no_op"] is False
    w = client.put(
        f"/api/v1/markdown-files/{pid}",
        json={"kind": "claude", "content": "v2\n", "expected_sha": sha},
    )
    assert w.status_code == 200
    assert (tmp_path / "CLAUDE.md").read_text() == "v2\n"
