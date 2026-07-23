"""Install and upgrade bundled org agents from the app's resource directory.

Org agents are distributed as a bundle directory containing:
  - ``manifest.json`` — version string + list of agent specs
  - ``<filename>.md`` per agent — the agent prompt/definition

On install, each .md file is copied to *target_dir*, marked read-only, and an
``org_agents`` row is upserted (migration 057).  ``install_or_upgrade`` is
idempotent: files whose sha256 matches the bundle are skipped unless
``force=True``.

The ``link_path`` column is left as a placeholder (workspace .claude/agents/
path) and is overwritten by ``command_center_service.regenerate_workspace_links``
during the full bootstrap pass.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from app.services import symlink_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OrgAgentSpec:
    name: str
    filename: str
    display_name: str
    description: str
    model: str | None
    sha256: str


def _sha256_file(p: Path) -> str:
    """Return the hex-encoded SHA-256 digest of the file at *p*."""
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(bundle_dir: Path) -> tuple[str, list[OrgAgentSpec]]:
    """Parse ``bundle_dir/manifest.json`` and return ``(version, [OrgAgentSpec, ...])``.

    Raises:
        FileNotFoundError: if the manifest is absent.
        json.JSONDecodeError: if the manifest is malformed JSON.
    """
    manifest_path = bundle_dir / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"org-agent manifest missing: {manifest_path}")
    data = json.loads(manifest_path.read_text())
    specs = [
        OrgAgentSpec(
            name=a["name"],
            filename=a["filename"],
            display_name=a["display_name"],
            description=a.get("description") or "",
            model=a.get("model"),
            sha256=a.get("sha256") or "",
        )
        for a in data.get("agents", [])
    ]
    return data.get("version", ""), specs


async def install_or_upgrade(
    db: aiosqlite.Connection,
    *,
    bundle_dir: Path,
    target_dir: Path,
    force: bool = False,
) -> tuple[int, int]:
    """Copy/update agent files from bundle into *target_dir*, mark them read-only,
    and upsert ``org_agents`` rows.

    Returns ``(installed_count, upgraded_count)``.

    Idempotent: if a file is already installed with a matching sha256 it is
    skipped unless *force* is ``True``.  If the sha256 differs, the existing
    file is overwritten.

    Args:
        db: open aiosqlite connection (write access required).
        bundle_dir: directory containing ``manifest.json`` and agent .md files.
        target_dir: destination directory for installed agent files (created if
            absent).
        force: if ``True``, overwrite existing files even when sha256 matches.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    version, specs = load_manifest(bundle_dir)

    installed = 0
    upgraded = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for spec in specs:
        src = bundle_dir / spec.filename
        if not src.exists():
            logger.warning("org-agent bundle file missing: %s", src)
            continue

        dst = target_dir / spec.filename
        bundle_sha = _sha256_file(src)

        if spec.sha256 and bundle_sha != spec.sha256:
            logger.warning(
                "org-agent %s: bundle sha256 mismatch (manifest=%s, file=%s)",
                spec.name,
                spec.sha256,
                bundle_sha,
            )

        existing_row = await (
            await db.execute(
                "SELECT id, sha256, version FROM org_agents WHERE name = ?",
                (spec.name,),
            )
        ).fetchone()

        needs_write = force or not dst.exists()
        if dst.exists():
            try:
                if _sha256_file(dst) != bundle_sha:
                    needs_write = True
            except OSError:
                needs_write = True

        if needs_write:
            # Remove read-only bit to allow overwrite
            try:
                if dst.exists():
                    dst.chmod(0o644)
            except OSError:
                pass
            shutil.copyfile(src, dst)
            symlink_service.set_readonly(dst)
            if existing_row:
                upgraded += 1
            else:
                installed += 1

        # link_path is a placeholder here; command_center_service.regenerate_workspace_links
        # will overwrite it with the real resolved path on its next pass.
        from app.config import settings

        link_path = str(settings.WORKSPACE_ROOT / ".claude" / "agents" / spec.filename)

        if existing_row:
            await db.execute(
                """UPDATE org_agents SET
                       display_name = ?, description = ?, model = ?,
                       version = ?, bundle_path = ?, install_path = ?, link_path = ?,
                       sha256 = ?, installed_at = ?, source = 'bundled'
                   WHERE id = ?""",
                (
                    spec.display_name,
                    spec.description,
                    spec.model,
                    version,
                    str(src),
                    str(dst),
                    link_path,
                    bundle_sha,
                    now_iso,
                    existing_row[0],
                ),
            )
        else:
            await db.execute(
                """INSERT INTO org_agents
                       (name, display_name, description, model, version,
                        bundle_path, install_path, link_path, sha256, installed_at,
                        source)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bundled')""",
                (
                    spec.name,
                    spec.display_name,
                    spec.description,
                    spec.model,
                    version,
                    str(src),
                    str(dst),
                    link_path,
                    bundle_sha,
                    now_iso,
                ),
            )

    await db.commit()
    return installed, upgraded


async def reconcile_stale(
    db: aiosqlite.Connection,
    *,
    bundle_dir: Path,
    target_dir: Path,
) -> list[str]:
    """Remove ``org_agents`` rows (and their installed files) that are no longer
    present in the manifest.

    This handles the case where a dev DB was previously populated with agents
    (e.g. ``orchestrator``, ``roadmap-orchestrator``) that have since been
    removed from the bundle.  After this call, ``org_agents`` contains only
    agents listed in the current manifest.

    Returns the list of agent names that were removed.
    """
    _, specs = load_manifest(bundle_dir)
    manifest_names = {s.name for s in specs}

    # Only bundled rows are subject to manifest-driven reconciliation.
    # Promoted rows (source='promoted') are user-managed and must survive restarts.
    cur = await db.execute(
        "SELECT id, name, install_path FROM org_agents WHERE source = 'bundled'"
    )
    existing_rows = await cur.fetchall()

    removed: list[str] = []
    for row_id, name, install_path in existing_rows:
        if name in manifest_names:
            continue
        # Remove the installed file from target_dir (if it exists there)
        if install_path:
            installed_file = Path(install_path)
            if installed_file.exists() and installed_file.parent == target_dir:
                try:
                    installed_file.chmod(0o644)
                    installed_file.unlink()
                except OSError as exc:
                    logger.warning(
                        "reconcile: could not remove installed file %s: %s",
                        installed_file,
                        exc,
                    )
        await db.execute("DELETE FROM org_agents WHERE id = ?", (row_id,))
        removed.append(name)
        logger.info(
            "reconcile: removed stale org_agent %r (no longer in manifest)", name
        )

    if removed:
        await db.commit()
    return removed
