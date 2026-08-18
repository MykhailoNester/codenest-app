"""Cross-platform link creation for the Command Center workspace.

macOS/Linux: POSIX symlinks. Always work for files and directories.
Windows: try symlink (requires Developer Mode or admin); on failure fall back to
hardlinks (for files) or directory junctions (`_winapi.CreateJunction`, or shell out
to `mklink /J`). Copy is never used — DB is the source of truth, workspace links
must be re-resolvable to canonical paths.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from enum import Enum
from pathlib import Path

logger = logging.getLogger(__name__)


class LinkType(str, Enum):
    SYMLINK = "symlink"
    HARDLINK = "hardlink"
    JUNCTION = "junction"
    # Not a link at all: a generated file whose frontmatter differs from its
    # source, written by agent_alias_service when two projects ship an agent of
    # the same name. Recorded so a row says plainly that its workspace entry is
    # a copy and edits to it do not reach the project. (migration 006)
    COPY = "copy"


def create_link(src: Path, dst: Path) -> LinkType:
    """Create a link at dst pointing to src. Returns the LinkType used.

    Raises:
        FileNotFoundError: if src does not exist
        OSError: if link creation fails on all available strategies
    """
    src = Path(src)
    dst = Path(dst)

    if not src.exists():
        raise FileNotFoundError(f"source missing: {src}")

    # Atomic-ish replace: remove existing dst (file, symlink, or empty dir)
    if dst.is_symlink() or dst.exists():
        remove_link(dst)

    dst.parent.mkdir(parents=True, exist_ok=True)

    if sys.platform != "win32":
        os.symlink(str(src), str(dst), target_is_directory=src.is_dir())
        return LinkType.SYMLINK

    # Windows path
    try:
        os.symlink(str(src), str(dst), target_is_directory=src.is_dir())
        return LinkType.SYMLINK
    except OSError as exc:
        winerr = getattr(exc, "winerror", None)
        if winerr not in (1314, 5):  # not "no privilege" / "access denied"
            raise

    if src.is_file():
        os.link(str(src), str(dst))
        return LinkType.HARDLINK

    # Directory junction
    try:
        import _winapi  # type: ignore[attr-defined]

        _winapi.CreateJunction(str(src), str(dst))
        return LinkType.JUNCTION
    except (ImportError, AttributeError, OSError):
        # mklink fallback
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(dst), str(src)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise OSError(f"mklink junction failed: {result.stderr.strip()}")
        return LinkType.JUNCTION


def remove_link(dst: Path) -> None:
    """Remove a link entry (symlink, hardlink, or junction). No-op if missing."""
    dst = Path(dst)
    if not dst.is_symlink() and not dst.exists():
        return
    try:
        dst.unlink()
    except IsADirectoryError:
        # Windows junction — unlink the directory entry only
        os.rmdir(str(dst))
    except OSError:
        # Last-resort cleanup
        if dst.is_dir() and not dst.is_symlink():
            os.rmdir(str(dst))
        else:
            raise


def set_readonly(path: Path) -> None:
    """Mark a file read-only (defense against writes propagating via hardlink)."""
    path = Path(path)
    if sys.platform == "win32":
        try:
            subprocess.run(["attrib", "+R", str(path)], check=True, capture_output=True)
        except subprocess.CalledProcessError as exc:
            logger.warning("attrib +R failed for %s: %s", path, exc)
    else:
        try:
            path.chmod(0o444)
        except OSError as exc:
            logger.warning("chmod 0444 failed for %s: %s", path, exc)
