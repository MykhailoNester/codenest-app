"""Local-First Sync & Backup.

Writes versioned `.tar.gz` snapshots of the live SQLite DB and the
plugins directory into a user-configured target directory. The user's
existing sync software (iCloud, Dropbox, Syncthing) handles the actual
off-device upload — the sidecar only owns the filesystem write/read.

Snapshot layout (inside the tarball):

    manifest.json   {version, created_at_utc, sources, db_sha256, plugins_sha256}
    codenest.db     point-in-time copy made via SQLite VACUUM INTO
    plugins/...     recursive tree of ~/.codenest/plugins (if any)

Restore validates the embedded SHAs before overwriting live files; the
pre-restore versions are renamed to ``<name>.pre-restore-<utc-iso>`` so
a botched restore is recoverable from disk.

Encryption is intentionally **out of scope for v1**. The user's choice
of sync software typically encrypts in transit/at-rest (iCloud, Dropbox)
or runs on a private LAN (Syncthing). Filed as a follow-up.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import shutil
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import HTTPException


log = logging.getLogger(__name__)


# ─── Constants ───────────────────────────────────────────────────────────────


SNAPSHOT_VERSION = 1

_VALID_KINDS: frozenset[str] = frozenset(
    {"local", "icloud", "dropbox", "syncthing", "s3"}
)

# Filename glob the listing/scan uses to identify our snapshots.
_SNAPSHOT_PREFIX = "codenest-snapshot-"
_SNAPSHOT_SUFFIX = ".tar.gz"

# Suffix appended to live files we rename out of the way during restore.
_PRE_RESTORE_SUFFIX = ".pre-restore-"

# Action values stored in sync_snapshots.action.
_ACTION_CREATE = "create"
_ACTION_RESTORE = "restore"

# Cap how large a snapshot we'll restore from. Defends against a 100 GB
# file silently triggered through the UI; real snapshots are MBs.
_MAX_RESTORE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB

# Cap individual entry size inside a tarball during restore — bounds the
# "decompression bomb" surface. 1 GiB is more than enough for a personal
# DB + plugins tree.
_MAX_TAR_MEMBER_BYTES = 1 * 1024 * 1024 * 1024


# ─── Path resolution ────────────────────────────────────────────────────────


def _db_path() -> Path:
    """Resolve the live SQLite path the same way ``app/config.py`` does."""
    from ..config import settings

    return Path(settings.DATABASE_PATH).resolve()


def _plugins_path() -> Path:
    """Resolve the plugins root without importing at module load."""
    from . import plugin_service

    return plugin_service.plugins_root()


def _utc_stamp() -> str:
    return datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")


# ─── Target CRUD ────────────────────────────────────────────────────────────


def _row_to_target(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    d["enabled"] = bool(d.get("enabled", 0))
    return d


async def list_targets(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    async with db.execute("SELECT * FROM sync_targets ORDER BY id ASC") as cur:
        rows = await cur.fetchall()
    return [_row_to_target(r) for r in rows]


async def get_target(db: aiosqlite.Connection, target_id: int) -> dict[str, Any]:
    async with db.execute(
        "SELECT * FROM sync_targets WHERE id = ?", (target_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "sync target not found")
    return _row_to_target(row)


async def create_target(
    db: aiosqlite.Connection, payload: dict[str, Any]
) -> dict[str, Any]:
    label = str(payload.get("label", "")).strip()
    if not label:
        raise HTTPException(400, "label is required")
    kind = str(payload.get("kind", "local"))
    if kind not in _VALID_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(_VALID_KINDS)}")
    if kind == "s3":
        raise HTTPException(
            400,
            "s3 sync targets are not yet supported; configure a local "
            "directory (Dropbox, iCloud, Syncthing) instead.",
        )
    raw_dir = str(payload.get("dir_path", "")).strip()
    if not raw_dir:
        raise HTTPException(400, "dir_path is required")
    dir_path = Path(raw_dir).expanduser().resolve()
    # Validate the directory at create-time so the user finds out now,
    # not after their first snapshot attempt.
    if not dir_path.exists():
        raise HTTPException(400, f"dir_path does not exist: {dir_path}")
    if not dir_path.is_dir():
        raise HTTPException(400, f"dir_path is not a directory: {dir_path}")
    enabled = 0 if payload.get("enabled") is False else 1
    try:
        cur = await db.execute(
            "INSERT INTO sync_targets (label, kind, dir_path, enabled) "
            "VALUES (?, ?, ?, ?)",
            (label, kind, str(dir_path), enabled),
        )
    except aiosqlite.IntegrityError as exc:
        raise HTTPException(409, f"sync target label {label!r} exists: {exc}")
    await db.commit()
    return await get_target(db, int(cur.lastrowid or 0))


async def delete_target(db: aiosqlite.Connection, target_id: int) -> None:
    await get_target(db, target_id)
    await db.execute("DELETE FROM sync_targets WHERE id = ?", (target_id,))
    await db.commit()


# ─── Snapshot helpers ───────────────────────────────────────────────────────


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_dir(root: Path) -> str:
    """Stable hash of an entire directory tree (file names + contents).

    Uses ``os.walk(followlinks=False)`` and skips any symlinked file or
    directory so a `ln -s ~` inside the plugins tree can't pull the
    user's home directory into the hash (or, downstream, into the tar
    snapshot). The tar.add call below uses the same skip rule via its
    ``filter`` arg so manifest hashes and tarball bytes stay in sync.
    """
    if not root.is_dir():
        return ""
    h = hashlib.sha256()
    entries: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirpath_p = Path(dirpath)
        # Skip walking into symlinked subdirs (defence in depth — os.walk
        # already honours followlinks=False, but the listing may still
        # surface the symlink entry itself; drop it explicitly).
        dirnames[:] = [d for d in dirnames if not (dirpath_p / d).is_symlink()]
        for name in filenames:
            entries.append(dirpath_p / name)
    for path in sorted(entries):
        if path.is_symlink():
            continue
        rel = path.relative_to(root)
        h.update(str(rel).encode("utf-8"))
        h.update(b"\x00")
        if path.is_file():
            with path.open("rb") as f:
                for chunk in iter(lambda: f.read(64 * 1024), b""):
                    h.update(chunk)
    return h.hexdigest()


def _tar_skip_symlinks(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    """tar.add filter: keep regular files/dirs, drop sym/hardlinks."""
    if info.issym() or info.islnk():
        return None
    return info


async def _vacuum_db_to(src_db: Path, dest_path: Path) -> None:
    """Make a consistent point-in-time DB copy via SQLite VACUUM INTO."""
    # Use a short-lived connection so we don't entangle with the global
    # `_db` connection's transactions.
    async with aiosqlite.connect(str(src_db)) as conn:
        await conn.execute("VACUUM INTO ?", (str(dest_path),))


async def _insert_audit_row(
    conn: aiosqlite.Connection,
    *,
    target_id: int,
    file_name: str,
    file_path: str,
    bytes_: int,
    archive_sha256: str,
    sources: list[str],
    action: str,
) -> None:
    await conn.execute(
        "INSERT INTO sync_snapshots "
        "  (target_id, file_name, file_path, bytes, archive_sha256, "
        "   sources_json, action) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            target_id,
            file_name,
            file_path,
            bytes_,
            archive_sha256,
            json.dumps(sources),
            action,
        ),
    )
    await conn.commit()


# ─── Snapshot create ────────────────────────────────────────────────────────


async def create_snapshot(db: aiosqlite.Connection, target_id: int) -> dict[str, Any]:
    target = await get_target(db, target_id)
    if not target["enabled"]:
        raise HTTPException(400, "target is disabled")
    target_dir = Path(target["dir_path"])
    if not target_dir.is_dir():
        raise HTTPException(500, f"target dir_path no longer exists: {target_dir}")

    stamp = _utc_stamp()
    file_name = f"{_SNAPSHOT_PREFIX}{stamp}{_SNAPSHOT_SUFFIX}"
    final_path = target_dir / file_name

    db_src = _db_path()
    plugins_src = _plugins_path()

    sources: list[str] = []
    with tempfile.TemporaryDirectory(prefix="codenest-snap-") as staging:
        staging_root = Path(staging)
        db_copy = staging_root / "codenest.db"
        await _vacuum_db_to(db_src, db_copy)
        db_sha = _sha256_file(db_copy)
        sources.append("codenest.db")

        plugins_sha = ""
        if plugins_src.is_dir():
            # Compute the hash before adding so the manifest matches the
            # bytes inside the tarball even if a plugin file changes
            # mid-tar-write (extremely unlikely; defensive).
            plugins_sha = _sha256_dir(plugins_src)
            sources.append("plugins/")

        manifest = {
            "version": SNAPSHOT_VERSION,
            "created_at_utc": datetime.utcnow().isoformat(timespec="seconds"),
            "sources": sources,
            "db_sha256": db_sha,
            "plugins_sha256": plugins_sha,
        }
        manifest_bytes = json.dumps(manifest, sort_keys=True, indent=2).encode("utf-8")

        # Write the tarball to a sibling temp file in the target dir then
        # atomically rename, so a partial write never appears in listings.
        tmp_path = target_dir / f".{file_name}.partial"
        try:
            with tarfile.open(tmp_path, "w:gz") as tar:
                info = tarfile.TarInfo("manifest.json")
                info.size = len(manifest_bytes)
                tar.addfile(info, io.BytesIO(manifest_bytes))
                tar.add(db_copy, arcname="codenest.db")
                if plugins_src.is_dir():
                    tar.add(plugins_src, arcname="plugins", filter=_tar_skip_symlinks)
            tmp_path.replace(final_path)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

    archive_sha = _sha256_file(final_path)
    size = final_path.stat().st_size
    await _insert_audit_row(
        db,
        target_id=target_id,
        file_name=file_name,
        file_path=str(final_path),
        bytes_=size,
        archive_sha256=archive_sha,
        sources=sources,
        action=_ACTION_CREATE,
    )
    async with db.execute(
        "SELECT id FROM sync_snapshots WHERE target_id = ? " "ORDER BY id DESC LIMIT 1",
        (target_id,),
    ) as cur:
        row = await cur.fetchone()
    snapshot_id = int(row["id"]) if row else 0
    return {
        "snapshot_id": snapshot_id,
        "file_name": file_name,
        "file_path": str(final_path),
        "bytes": size,
        "archive_sha256": archive_sha,
        "sources": sources,
        "manifest": manifest,
    }


# ─── Snapshot list (from disk + DB) ─────────────────────────────────────────


def _read_manifest_from_archive(path: Path) -> dict[str, Any] | None:
    try:
        with tarfile.open(path, "r:gz") as tar:
            member = tar.getmember("manifest.json")
            if member.size > 64 * 1024:
                return None
            fh = tar.extractfile(member)
            if fh is None:
                return None
            data = json.loads(fh.read().decode("utf-8"))
            if isinstance(data, dict):
                return data
    except (OSError, tarfile.TarError, KeyError, json.JSONDecodeError):
        return None
    return None


async def list_snapshots(
    db: aiosqlite.Connection, target_id: int
) -> list[dict[str, Any]]:
    """Enumerate snapshots in the target's directory (authoritative)."""
    target = await get_target(db, target_id)
    target_dir = Path(target["dir_path"])
    if not target_dir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for path in sorted(target_dir.iterdir(), reverse=True):
        if not path.is_file():
            continue
        if not path.name.startswith(_SNAPSHOT_PREFIX):
            continue
        if not path.name.endswith(_SNAPSHOT_SUFFIX):
            continue
        manifest = _read_manifest_from_archive(path)
        try:
            size = path.stat().st_size
        except OSError:
            continue
        out.append(
            {
                "file_name": path.name,
                "file_path": str(path),
                "bytes": size,
                "manifest": manifest,
                "valid": manifest is not None,
            }
        )
    return out


async def list_history(
    db: aiosqlite.Connection, limit: int = 50
) -> list[dict[str, Any]]:
    """Recent snapshot create/restore actions recorded on THIS machine."""
    capped = max(1, min(int(limit), 200))
    async with db.execute(
        "SELECT * FROM sync_snapshots ORDER BY created_at DESC LIMIT ?",
        (capped,),
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ─── Restore ────────────────────────────────────────────────────────────────


def _validate_member(member: tarfile.TarInfo) -> None:
    """Reject members that would escape the extraction root or are too large."""
    name = member.name
    if not name or name.startswith("/") or ".." in Path(name).parts:
        raise HTTPException(400, f"unsafe tar member: {name!r}")
    if member.size > _MAX_TAR_MEMBER_BYTES:
        raise HTTPException(
            400, f"tar member {name!r} exceeds {_MAX_TAR_MEMBER_BYTES} bytes"
        )
    if member.issym() or member.islnk():
        # Symlinks/hardlinks inside a snapshot are not produced by
        # create_snapshot; refuse to honour them on restore so a crafted
        # tarball can't point a "plugins/" entry at /etc.
        raise HTTPException(400, f"refusing link member: {name!r}")


async def restore_snapshot(
    db: aiosqlite.Connection, target_id: int, file_name: str
) -> dict[str, Any]:
    target = await get_target(db, target_id)
    target_dir = Path(target["dir_path"])

    # Reject any file_name that contains path separators or traversal sequences
    # so a caller cannot escape the configured sync target directory.
    if "/" in file_name or "\\" in file_name or ".." in file_name:
        raise HTTPException(400, "invalid snapshot name")
    # Additionally verify that the resolved archive path stays within
    # the resolved target directory (defence against exotic edge cases).
    resolved_target = target_dir.resolve()
    resolved_archive = (target_dir / file_name).resolve()
    if resolved_archive.parent != resolved_target:
        raise HTTPException(400, "invalid snapshot name")

    archive = target_dir / file_name
    if not archive.is_file():
        raise HTTPException(404, f"snapshot not found: {file_name}")
    size = archive.stat().st_size
    if size > _MAX_RESTORE_BYTES:
        raise HTTPException(
            400, f"snapshot exceeds {_MAX_RESTORE_BYTES} bytes ({size} bytes)"
        )

    manifest = _read_manifest_from_archive(archive)
    if manifest is None:
        raise HTTPException(400, "snapshot has no valid manifest.json")

    db_dest = _db_path()
    plugins_dest = _plugins_path()
    backup_stamp = _utc_stamp()

    # Stage extraction into a temp dir so a half-extracted tar never lands
    # on top of the live DB.
    with tempfile.TemporaryDirectory(prefix="codenest-restore-") as staging:
        staging_root = Path(staging)
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar.getmembers():
                _validate_member(member)
            # filter="data" (Python 3.12+) is the canonical safe-extract
            # mode: it strips setuid, rejects absolute paths and links,
            # and closes the small TOCTOU sliver between getmembers() and
            # the second pass extractall does internally.
            tar.extractall(staging_root, filter="data")

        staged_db = staging_root / "codenest.db"
        if not staged_db.is_file():
            raise HTTPException(400, "snapshot is missing codenest.db")
        if _sha256_file(staged_db) != manifest.get("db_sha256"):
            raise HTTPException(400, "snapshot db_sha256 mismatch")

        staged_plugins = staging_root / "plugins"
        plugins_sha_expected = manifest.get("plugins_sha256", "")
        if staged_plugins.is_dir():
            if _sha256_dir(staged_plugins) != plugins_sha_expected:
                raise HTTPException(400, "snapshot plugins_sha256 mismatch")
        elif plugins_sha_expected:
            raise HTTPException(
                400, "snapshot manifest references plugins but tarball has none"
            )

        # Record the audit row BEFORE swapping files: the still-open
        # `db` connection points at the pre-restore DB, and writing here
        # avoids a close-then-reconnect-against-restored-file dance that
        # crosses test monkeypatch boundaries. Semantically right too —
        # we're logging the action, not its outcome on the restored data.
        archive_sha = _sha256_file(archive)
        sources = manifest.get("sources", [])
        if not isinstance(sources, list):
            sources = []
        await _insert_audit_row(
            db,
            target_id=target_id,
            file_name=file_name,
            file_path=str(archive),
            bytes_=size,
            archive_sha256=archive_sha,
            sources=sources,
            action=_ACTION_RESTORE,
        )

        # Drop the WAL handles before swapping the file out from under
        # SQLite. The next caller of get_db() lazily reconnects against
        # the restored file.
        from ..database import close_db

        await close_db()
        if db_dest.exists():
            db_dest.rename(
                db_dest.with_suffix(
                    db_dest.suffix + f"{_PRE_RESTORE_SUFFIX}{backup_stamp}"
                )
            )
        db_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(staged_db, db_dest)
        if staged_plugins.is_dir():
            if plugins_dest.exists():
                backup_plugins = plugins_dest.parent / (
                    plugins_dest.name + f"{_PRE_RESTORE_SUFFIX}{backup_stamp}"
                )
                plugins_dest.rename(backup_plugins)
            plugins_dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staged_plugins, plugins_dest)

        # Also record the audit row INSIDE the restored DB via a
        # short-lived connection, so a restore-on-new-machine flow has
        # "I was restored from X" visible in list_history without having
        # to crack open the .pre-restore-* backup.
        async with aiosqlite.connect(str(db_dest)) as restored:
            await _insert_audit_row(
                restored,
                target_id=target_id,
                file_name=file_name,
                file_path=str(archive),
                bytes_=size,
                archive_sha256=archive_sha,
                sources=sources,
                action=_ACTION_RESTORE,
            )

    return {
        "restored_from": str(archive),
        "db_path": str(db_dest),
        "plugins_path": str(plugins_dest),
        "backup_stamp": backup_stamp,
        "manifest": manifest,
    }
