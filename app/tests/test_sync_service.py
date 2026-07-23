"""Tests for sync_service."""

from __future__ import annotations

import json
import pathlib
import tarfile

import aiosqlite
import pytest
import pytest_asyncio

from app.services import sync_service


MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    """A self-contained sync world: isolated DB, plugins dir, target dir.

    We patch ``sync_service._db_path`` and ``sync_service._plugins_path`` so
    snapshots read/write into the temp tree, not the host's real paths.
    """
    db_file = tmp_path / "live.db"
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    (plugins_dir / "hello").mkdir()
    (plugins_dir / "hello" / "manifest.json").write_text(
        json.dumps({"slug": "hello", "name": "Hello", "version": "1.0.0"})
    )

    target_dir = tmp_path / "target"
    target_dir.mkdir()

    conn = await aiosqlite.connect(str(db_file))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)

    monkeypatch.setattr(sync_service, "_db_path", lambda: db_file)
    monkeypatch.setattr(sync_service, "_plugins_path", lambda: plugins_dir)
    # Restore calls close_db() to drop WAL handles before the file swap;
    # ensure no stale global connection bleeds in from a prior test.
    import app.database as _database

    _database._db = None

    yield {
        "db": conn,
        "db_file": db_file,
        "plugins_dir": plugins_dir,
        "target_dir": target_dir,
    }
    await conn.close()


# ─── Target CRUD ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_target_validates_dir_exists(env):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await sync_service.create_target(
            env["db"],
            {"label": "bad", "kind": "local", "dir_path": "/nonexistent/path/x"},
        )


@pytest.mark.asyncio
async def test_create_target_rejects_s3_in_v1(env):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await sync_service.create_target(
            env["db"],
            {"label": "s3-bucket", "kind": "s3", "dir_path": str(env["target_dir"])},
        )


@pytest.mark.asyncio
async def test_create_target_rejects_unknown_kind(env):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await sync_service.create_target(
            env["db"],
            {"label": "x", "kind": "ftp", "dir_path": str(env["target_dir"])},
        )


# ─── Snapshot create + list ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_snapshot_writes_tarball_with_manifest(env):
    target = await sync_service.create_target(
        env["db"],
        {"label": "dev", "kind": "local", "dir_path": str(env["target_dir"])},
    )
    result = await sync_service.create_snapshot(env["db"], target["id"])
    archive = pathlib.Path(result["file_path"])
    assert archive.is_file()
    assert archive.name.startswith("codenest-snapshot-")
    assert archive.suffix == ".gz"
    with tarfile.open(archive, "r:gz") as tar:
        names = tar.getnames()
        assert "manifest.json" in names
        assert "codenest.db" in names
        assert any(n.startswith("plugins/hello") for n in names)
        manifest_member = tar.extractfile("manifest.json")
        assert manifest_member is not None
        manifest = json.loads(manifest_member.read())
        assert manifest["version"] == sync_service.SNAPSHOT_VERSION
        assert "db_sha256" in manifest
        assert "plugins_sha256" in manifest


@pytest.mark.asyncio
async def test_list_snapshots_returns_newest_first(env):
    target = await sync_service.create_target(
        env["db"],
        {"label": "dev", "kind": "local", "dir_path": str(env["target_dir"])},
    )
    first = await sync_service.create_snapshot(env["db"], target["id"])
    # Sleep-less: create_snapshot uses second-resolution stamps, so the
    # second snapshot may collide. Write a fake second snapshot directly.
    import time

    time.sleep(1.1)
    second = await sync_service.create_snapshot(env["db"], target["id"])
    listed = await sync_service.list_snapshots(env["db"], target["id"])
    names = [s["file_name"] for s in listed]
    assert second["file_name"] in names
    assert first["file_name"] in names
    # Newest first.
    assert names[0] == second["file_name"]


# ─── Restore ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_restore_snapshot_recreates_db_and_plugins(env):
    target = await sync_service.create_target(
        env["db"],
        {"label": "dev", "kind": "local", "dir_path": str(env["target_dir"])},
    )
    result = await sync_service.create_snapshot(env["db"], target["id"])
    # Delete the live files so restore has work to do.
    env["db_file"].unlink()
    import shutil

    shutil.rmtree(env["plugins_dir"])
    # close global DB to mimic the production restore boundary
    from app.database import close_db

    await close_db()
    restored = await sync_service.restore_snapshot(
        env["db"], target["id"], result["file_name"]
    )
    assert pathlib.Path(restored["db_path"]).is_file()
    assert pathlib.Path(restored["plugins_path"]).is_dir()
    assert (env["plugins_dir"] / "hello" / "manifest.json").is_file()


@pytest.mark.asyncio
async def test_restore_creates_pre_restore_backup_of_existing_files(env):
    target = await sync_service.create_target(
        env["db"],
        {"label": "dev", "kind": "local", "dir_path": str(env["target_dir"])},
    )
    result = await sync_service.create_snapshot(env["db"], target["id"])
    from app.database import close_db

    await close_db()
    await sync_service.restore_snapshot(env["db"], target["id"], result["file_name"])
    siblings = list(env["db_file"].parent.iterdir())
    backups = [p for p in siblings if ".pre-restore-" in p.name]
    assert backups, f"expected pre-restore backup; saw {siblings}"


@pytest.mark.asyncio
async def test_restore_refuses_tampered_archive(env, tmp_path):
    target = await sync_service.create_target(
        env["db"],
        {"label": "dev", "kind": "local", "dir_path": str(env["target_dir"])},
    )
    result = await sync_service.create_snapshot(env["db"], target["id"])
    archive = pathlib.Path(result["file_path"])
    # Rebuild a tarball where codenest.db has been replaced with bogus
    # bytes but the manifest is left untouched — the SHA mismatch should
    # cause restore to refuse before any live file is touched.
    import io
    import tarfile as _tarfile

    src_members: dict[str, bytes] = {}
    with _tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            fh = tar.extractfile(member)
            if fh is None:
                continue
            src_members[member.name] = fh.read()
    src_members["codenest.db"] = b"tampered"
    tampered = tmp_path / "tampered.tar.gz"
    with _tarfile.open(tampered, "w:gz") as tar:
        for name, data in src_members.items():
            info = _tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    # Move the tampered file into the target dir under the original name
    # so restore() finds it.
    archive.unlink()
    tampered.rename(archive)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await sync_service.restore_snapshot(
            env["db"], target["id"], result["file_name"]
        )
    assert "db_sha256" in str(exc.value.detail) or "mismatch" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_restore_refuses_path_traversal_member(env, tmp_path):
    target = await sync_service.create_target(
        env["db"],
        {"label": "dev", "kind": "local", "dir_path": str(env["target_dir"])},
    )
    # Hand-craft a tarball with an `..` member — restore must refuse.
    import io
    import tarfile as _tarfile

    archive = env["target_dir"] / "codenest-snapshot-20250101T000000Z.tar.gz"
    with _tarfile.open(archive, "w:gz") as tar:
        manifest_bytes = json.dumps(
            {
                "version": 1,
                "created_at_utc": "x",
                "sources": ["codenest.db"],
                "db_sha256": "",
                "plugins_sha256": "",
            }
        ).encode()
        info = _tarfile.TarInfo("manifest.json")
        info.size = len(manifest_bytes)
        tar.addfile(info, io.BytesIO(manifest_bytes))
        bad = _tarfile.TarInfo("../escape.txt")
        bad.size = 3
        tar.addfile(bad, io.BytesIO(b"bad"))

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await sync_service.restore_snapshot(env["db"], target["id"], archive.name)
    assert "unsafe" in str(exc.value.detail)
