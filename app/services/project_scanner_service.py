"""Scan a project directory for Claude Code assets (.claude/agents, skills, commands)."""

from __future__ import annotations

import re
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.services._sql import slugify as _slugify_from_sql


@dataclass
class DiscoveredAgent:
    name: str  # frontmatter name if present, else file stem
    frontmatter_name_raw: str | None  # raw frontmatter `name:` value, None if absent
    description: str | None
    model: str | None
    canonical_path: str  # absolute
    has_name_mismatch: bool  # True if frontmatter_name != file stem


@dataclass
class DiscoveredSkill:
    name: str
    canonical_path: str


@dataclass
class DiscoveredCommand:
    name: str
    canonical_path: str


@dataclass
class ScanResult:
    project_name: str  # inferred from dir basename
    root_path: str
    git_remote: str | None
    has_claude_dir: bool
    agents: list[DiscoveredAgent] = field(default_factory=list)
    skills: list[DiscoveredSkill] = field(default_factory=list)
    commands: list[DiscoveredCommand] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(text: str) -> dict[str, str]:
    """Parse a YAML-ish frontmatter block at the start of a file.
    Only handles simple `key: value` lines (no nested structures, no lists)."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    out: dict[str, str] = {}
    for raw_line in m.group(1).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            out[key] = value
    return out


def _slugify(s: str) -> str:
    return _slugify_from_sql(s)


# Sensitive locations never scanned, even within $HOME. Mirrors the Rust
# shell's require_home_scope (src-tauri/src/commands/docs.rs) so both trust
# boundaries enforce the same policy.
_SENSITIVE_SEGMENTS = (
    "Library/Keychains",
    "Library/Preferences/com.apple.security",
    ".ssh",
    ".gnupg",
    ".aws/credentials",
)


def _allowed_scan_roots() -> tuple[Path, ...]:
    """Base directories under which project scanning/import is permitted.

    Defaults to the user's home tree. Exposed as a function so tests can
    redirect it to a temp dir via monkeypatch.
    """
    return (Path.home().resolve(),)


def _require_scan_scope(root: Path) -> None:
    """Constrain directory scans to an allowed base root.

    The ``/command-center/projects/preview`` and import endpoints are
    unauthenticated; without this a localhost caller could enumerate arbitrary
    filesystem locations. ``root`` must already be ``.resolve()``-d.
    """
    if not any(root.is_relative_to(base) for base in _allowed_scan_roots()):
        raise ValueError(f"path is outside the allowed import roots: {root}")
    posix = root.as_posix()
    for segment in _SENSITIVE_SEGMENTS:
        if segment in posix:
            raise ValueError(f"path is in a sensitive directory: {root}")


def _get_git_remote(root: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def scan_project(root_path: str | Path) -> ScanResult:
    """Walk a project's .claude/ directory and discover agents, skills, commands.

    Does not require the project to be a git repo (git_remote is best-effort).
    Does not require `.claude/` to exist (returns empty lists if absent).
    """
    root = Path(root_path).expanduser().resolve()
    _require_scan_scope(root)
    if not root.exists() or not root.is_dir():
        raise ValueError(f"path is not a directory: {root}")

    result = ScanResult(
        project_name=root.name,
        root_path=str(root),
        git_remote=_get_git_remote(root),
        has_claude_dir=(root / ".claude").is_dir(),
    )

    claude_dir = root / ".claude"
    if not claude_dir.is_dir():
        result.warnings.append("project has no .claude/ directory")
        return result

    # Agents
    agents_dir = claude_dir / "agents"
    if agents_dir.is_dir():
        seen_names: set[str] = set()
        for md in sorted(agents_dir.glob("*.md")):
            try:
                text = md.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                result.warnings.append(f"unreadable agent file {md.name}: {exc}")
                continue
            fm = _parse_frontmatter(text)
            fm_name = fm.get("name")
            file_stem = md.stem
            name = fm_name or file_stem
            has_mismatch = bool(fm_name) and fm_name != file_stem
            if not fm_name:
                result.warnings.append(f"agent {md.name}: missing frontmatter 'name'")
            if has_mismatch:
                result.warnings.append(
                    f"agent {md.name}: frontmatter name '{fm_name}' != filename '{file_stem}'"
                )
            if name in seen_names:
                # Disambiguate by appending the file stem so the agent is
                # still importable rather than silently dropped.  This handles
                # the common case of multiple agent files sharing the same
                # frontmatter name (e.g. two code-reviewer variants).
                result.warnings.append(
                    f"agent {md.name}: duplicate name '{name}'; "
                    f"using '{name}--{file_stem}' to avoid collision"
                )
                name = f"{name}--{file_stem}"
                has_mismatch = True  # effective name diverges from frontmatter
            seen_names.add(name)
            result.agents.append(
                DiscoveredAgent(
                    name=name,
                    frontmatter_name_raw=fm_name,
                    description=fm.get("description") or None,
                    model=fm.get("model") or None,
                    canonical_path=str(md.resolve()),
                    has_name_mismatch=has_mismatch,
                )
            )

    # Skills (folders with SKILL.md inside)
    skills_dir = claude_dir / "skills"
    if skills_dir.is_dir():
        for sub in sorted(skills_dir.iterdir()):
            if not sub.is_dir():
                continue
            if not (sub / "SKILL.md").exists():
                continue
            result.skills.append(
                DiscoveredSkill(
                    name=sub.name,
                    canonical_path=str(sub.resolve()),
                )
            )

    # Commands
    commands_dir = claude_dir / "commands"
    if commands_dir.is_dir():
        for md in sorted(commands_dir.glob("*.md")):
            result.commands.append(
                DiscoveredCommand(
                    name=md.stem,
                    canonical_path=str(md.resolve()),
                )
            )

    return result


def scan_to_dict(root_path: str | Path) -> dict:
    """Convenience wrapper that returns a JSON-serializable dict."""
    r = scan_project(root_path)
    return {
        "project_name": r.project_name,
        "root_path": r.root_path,
        "git_remote": r.git_remote,
        "has_claude_dir": r.has_claude_dir,
        "agents": [asdict(a) for a in r.agents],
        "skills": [asdict(s) for s in r.skills],
        "commands": [asdict(c) for c in r.commands],
        "warnings": r.warnings,
    }
