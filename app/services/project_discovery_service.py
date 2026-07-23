"""Filesystem-based project discovery and bulk import.

Two surfaces:

* :func:`scan` — bounded-depth walk of one or more roots that returns
  candidate projects (directories containing ``.git`` or a recognised
  manifest). Caps depth + result count so it stays responsive.
* :func:`import_candidates` — inserts the selected candidates into the
  ``projects`` table, skipping anything whose absolute ``path`` already
  exists. Returns a small summary.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Iterable

import aiosqlite

# Ordered most-specific → least-specific. First match wins so e.g. a Rust
# project with a stray ``package.json`` is still labelled ``rust``.
_STACK_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("rust", ("Cargo.toml",)),
    ("python", ("pyproject.toml",)),
    ("node", ("package.json",)),
    ("gradle", ("build.gradle", "build.gradle.kts")),
    ("go", ("go.mod",)),
    ("swift", ("Package.swift",)),
    ("ruby", ("Gemfile",)),
    ("php", ("composer.json",)),
    ("dotnet", ()),  # glob-only; handled below via _DOTNET_GLOBS
)

_DOTNET_GLOBS: tuple[str, ...] = ("*.csproj", "*.sln")

DEFAULT_SCAN_ROOTS: tuple[str, ...] = (
    "~/Documents",
    "~/Projects",
    "~/Code",
    "~/Work",
    "~/dev",
    "~/src",
)

DEFAULT_MAX_DEPTH = 4
DEFAULT_MAX_RESULTS = 200

_NOISY_DIRS: frozenset[str] = frozenset(
    {"node_modules", "venv", ".venv", "target", "dist", "build", "__pycache__"}
)


def _classify(path: Path) -> str | None:
    """Return the stack label for ``path``, or ``None`` if it is not a project.

    Single pass over the rule set. ``_is_project_dir`` and the per-row
    stack label both come out of this — no double-stat.
    """
    for label, manifests in _STACK_RULES:
        if any((path / m).is_file() for m in manifests):
            return label
    try:
        for pattern in _DOTNET_GLOBS:
            if any(path.glob(pattern)):
                return "dotnet"
    except OSError:
        return None
    return None


def _git_present(path: Path) -> bool:
    """True for both a ``.git/`` directory and a ``.git`` gitdir file.

    The file form is what worktrees and submodules use, and the previous
    is_dir-only check missed them.
    """
    return (path / ".git").exists()


# AI-tool detection registry. Each entry maps a tool id to a predicate that
# is True when the repo uses that tool. v1 wires Claude only; supporting more
# tools (Cursor, Copilot, Gemini, …) is just another (id, predicate) tuple —
# no call-site changes. ``detect_tools`` returns every matching id.
_TOOL_RULES: tuple[tuple[str, Callable[[Path], bool]], ...] = (
    ("claude", lambda p: (p / ".claude").is_dir()),
)


def detect_tools(path: Path) -> list[str]:
    """Return the ids of AI tools detected in ``path`` (see ``_TOOL_RULES``)."""
    found: list[str] = []
    for tool_id, matches in _TOOL_RULES:
        try:
            if matches(path):
                found.append(tool_id)
        except OSError:
            continue
    return found


def _git_remote(path: Path) -> str | None:
    """``origin`` (preferred) or the first remote URL parsed from ``.git/config``.

    Reads the config file directly (no subprocess) so it stays cheap inside the
    bulk walk. Worktrees/submodules use a ``.git`` *file* (no local config) and
    return ``None``.
    """
    cfg = path / ".git" / "config"
    if not cfg.is_file():
        return None
    try:
        text = cfg.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    remotes: dict[str, str] = {}
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[remote "):
            # [remote "origin"] -> origin
            current = line[len('[remote "') :].split('"', 1)[0] or None
        elif line.startswith("["):
            current = None
        elif current is not None:
            key, sep, val = line.partition("=")
            if sep and key.strip().lower() == "url" and val.strip():
                remotes.setdefault(current, val.strip())
    if not remotes:
        return None
    return remotes.get("origin") or next(iter(remotes.values()))


def _claude_asset_counts(path: Path) -> tuple[int, int]:
    """Return ``(agent_count, skill_count)`` from a repo's ``.claude/`` dir."""
    claude = path / ".claude"
    agents_dir = claude / "agents"
    skills_dir = claude / "skills"
    try:
        agents = sum(1 for _ in agents_dir.glob("*.md")) if agents_dir.is_dir() else 0
    except OSError:
        agents = 0
    try:
        skills = (
            sum(1 for c in skills_dir.iterdir() if c.is_dir())
            if skills_dir.is_dir()
            else 0
        )
    except OSError:
        skills = 0
    return agents, skills


def scan(
    roots: Iterable[str | Path] | None = None,
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_results: int = DEFAULT_MAX_RESULTS,
    already_imported_paths: Iterable[str] = (),
    git_only: bool = False,
) -> list[dict[str, Any]]:
    """Walk ``roots`` and return candidate project directories.

    A directory qualifies if it contains ``.git`` (dir or file) or any
    recognised manifest. With ``git_only=True`` only git repos qualify and
    manifest-only directories are walked *through* (so a subprojects root whose
    children are each a git repo is fully discovered) — this is the onboarding
    mode. The walk does not descend into a matched project root (one match per
    tree). Results de-duplicate by absolute path.

    Each candidate carries ``tools`` (detected AI tooling, e.g. ``["claude"]``);
    git repos also carry ``git_remote``, and Claude repos add ``agents`` /
    ``skills`` counts read from ``.claude/``.
    """
    target_roots = list(roots) if roots else list(DEFAULT_SCAN_ROOTS)
    imported_set = {str(p) for p in already_imported_paths}
    results: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _walk(dirpath: Path, depth: int) -> None:
        if len(results) >= max_results or depth > max_depth:
            return
        stack = _classify(dirpath)
        git = _git_present(dirpath)
        qualifies = git if git_only else (stack is not None or git)
        if qualifies:
            abs_path = str(dirpath)
            if abs_path in seen:
                return
            seen.add(abs_path)
            tools = detect_tools(dirpath)
            candidate: dict[str, Any] = {
                "name": dirpath.name,
                "path": abs_path,
                "stack": stack,
                "git": git,
                "tools": tools,
                "git_remote": _git_remote(dirpath) if git else None,
                "already_imported": abs_path in imported_set,
            }
            if "claude" in tools:
                candidate["agents"], candidate["skills"] = _claude_asset_counts(dirpath)
            results.append(candidate)
            return
        try:
            entries = list(dirpath.iterdir())
        except (PermissionError, OSError):
            return
        for entry in entries:
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if entry.name in _NOISY_DIRS:
                continue
            _walk(entry, depth + 1)

    for raw_root in target_roots:
        try:
            resolved = Path(raw_root).expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        _walk(resolved, 0)
        if len(results) >= max_results:
            break

    return results


async def import_candidates(
    db: aiosqlite.Connection, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """Insert each item into ``projects``, skipping duplicates by ``path``.

    Each item needs an absolute ``path``. ``name`` falls back to the
    basename. ``stack`` is persisted into ``tech_stack``. Returns
    ``{imported, skipped, new_project_ids}``. Bad rows (non-absolute or
    empty path) are silently counted as skipped so one bad row cannot
    poison the batch. Paths are normalised via ``resolve(strict=False)``
    before duplicate detection so ``/foo/bar`` and ``/foo/bar/`` collide.
    """
    existing = set(await get_imported_paths(db))
    new_ids: list[int] = []
    skipped = 0
    seen_in_batch: set[str] = set()

    for item in items:
        raw_path = item.get("path")
        if not raw_path:
            skipped += 1
            continue
        try:
            path_obj = Path(str(raw_path)).expanduser()
        except (OSError, RuntimeError):
            skipped += 1
            continue
        if not path_obj.is_absolute():
            skipped += 1
            continue
        try:
            normalised = str(path_obj.resolve(strict=False))
        except (OSError, RuntimeError):
            normalised = str(path_obj)
        if normalised in existing or normalised in seen_in_batch:
            skipped += 1
            continue
        seen_in_batch.add(normalised)
        name = str(item.get("name") or Path(normalised).name or "imported")
        stack = item.get("stack")
        cursor = await db.execute(
            """INSERT INTO projects (name, description, tech_stack, status, path)
               VALUES (?, NULL, ?, 'active', ?)""",
            (name, stack, normalised),
        )
        if cursor.lastrowid is not None:
            new_ids.append(cursor.lastrowid)

    if new_ids:
        await db.commit()
    return {
        "imported": len(new_ids),
        "skipped": skipped,
        "new_project_ids": new_ids,
    }


async def get_imported_paths(db: aiosqlite.Connection) -> list[str]:
    """Return all absolute project paths currently stored in ``projects``."""
    cur = await db.execute("SELECT path FROM projects WHERE path IS NOT NULL")
    rows = await cur.fetchall()
    return [row["path"] for row in rows]
