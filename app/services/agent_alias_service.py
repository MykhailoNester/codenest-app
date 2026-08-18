"""Project-scoped agent aliases: the name rewrite that lets duplicates coexist.

Claude Code resolves a subagent by the ``name:`` in its frontmatter, not by the
file it sits in. Two imported projects that both ship a ``code-reviewer`` therefore
cannot both be *linked* into the workspace — a symlink shares its target's bytes,
so both entries would declare the same name and the CLI would pick one silently
(see ``command_center_service._collect_desired_links``).

The way out is to stop linking the duplicates and generate them: write a copy
whose frontmatter ``name:`` reads ``<project-slug>--<agent-name>``, which the CLI
then resolves as its own agent. The copy is disposable — every
``regenerate_workspace_links`` pass rebuilds the workspace ``.claude/`` from
scratch — so the canonical file in the project stays the only thing anyone edits,
and this module marks the generated one read-only to say so.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.services import symlink_service

# Separates the project slug from the agent name. Two dashes rather than one so a
# slug or a name that legitimately contains a dash cannot be misread as the seam,
# and `:` is not an option at all: CLI agent names are [A-Za-z0-9][A-Za-z0-9_-]*,
# so `project:agent` is a display form only.
ALIAS_SEPARATOR = "--"

# The leading frontmatter block: `---` on its own line, through the next `---`.
# Anchored at the start of the file because that is the only place Claude Code
# reads it from — a `---` further down is body text, not metadata.
_FRONTMATTER_BLOCK = re.compile(
    r"\A---[ \t]*\r?\n(.*?\r?\n)---[ \t]*(\r?\n|\Z)", re.DOTALL
)

# A `name:` line inside that block. Two patterns, tried in order: an unindented
# key first, any indented one second. A frontmatter block scalar
# (`description: |`) can carry indented body lines of its own, and one of those
# reading `name: something` must not be mistaken for the agent's name — the real
# key is at column zero. The value is replaced wholesale, so quoting and spacing
# in the original do not matter.
_TOP_LEVEL_NAME_LINE = re.compile(r"^name[ \t]*:.*$", re.MULTILINE)
_INDENTED_NAME_LINE = re.compile(r"^[ \t]*name[ \t]*:.*$", re.MULTILINE)


class AliasRewriteError(ValueError):
    """The file cannot be aliased because it declares no frontmatter ``name:``.

    Raised rather than papered over: inventing a frontmatter block for a file
    that has none would change what the CLI thinks the agent *is*, and an agent
    reported as invocable under a name its file never declares is exactly the
    silent ambiguity aliasing exists to remove. The caller reports the row as a
    conflict instead.
    """


def alias_name(project_slug: str, agent_name: str) -> str:
    """``<project-slug>--<agent-name>`` — the name an aliased copy declares."""
    return f"{project_slug}{ALIAS_SEPARATOR}{agent_name}"


def generated_header(canonical_path: str | Path) -> str:
    """The comment the generated copy carries, naming the file to edit instead.

    Placed after the frontmatter, never before it: frontmatter is only frontmatter
    at byte 0, so a comment above it would stop the CLI seeing the block at all.
    """
    return (
        f"<!-- codenest: generated alias of {canonical_path} — "
        "edit that file, not this one; this copy is rewritten on every "
        "workspace regeneration. -->"
    )


def rewrite_frontmatter_name(text: str, alias: str, canonical_path: str | Path) -> str:
    """*text* with its frontmatter ``name:`` set to *alias* and a header added.

    Everything else is preserved byte for byte — description, model, tools, body —
    because the alias is meant to be the same agent under a second name, not a
    different agent.

    Raises:
        AliasRewriteError: no leading frontmatter block, or no ``name:`` in it.
    """
    block = _FRONTMATTER_BLOCK.match(text)
    if block is None:
        raise AliasRewriteError("no frontmatter block at the start of the file")

    body_start = block.end()
    front = text[: block.end(1)]  # `---\n` … up to the closing delimiter
    closing = text[block.end(1) : body_start]

    pattern = (
        _TOP_LEVEL_NAME_LINE
        if _TOP_LEVEL_NAME_LINE.search(front)
        else _INDENTED_NAME_LINE
    )
    if pattern.search(front) is None:
        raise AliasRewriteError("frontmatter declares no name:")

    front = pattern.sub(f"name: {alias}", front, count=1)
    rest = text[body_start:]
    return f"{front}{closing}\n{generated_header(canonical_path)}\n{rest}"


def materialize(src: Path, dst: Path, *, alias: str) -> symlink_service.LinkType:
    """Write *src* to *dst* as a read-only copy that declares *alias*.

    Returns :attr:`symlink_service.LinkType.COPY`, which is what the row's
    ``link_type`` records — an aliased entry is a copy and a copy is an aliased
    entry, so no separate flag is needed.

    Raises:
        FileNotFoundError: *src* is gone (caller marks the row missing_target).
        AliasRewriteError: *src* cannot carry an alias.
        OSError: the copy could not be written.
    """
    src = Path(src)
    dst = Path(dst)
    if not src.exists():
        raise FileNotFoundError(f"source missing: {src}")

    rewritten = rewrite_frontmatter_name(
        src.read_text(encoding="utf-8"), alias, str(src)
    )

    # Never write *through* whatever occupies the slot: a symlink there would
    # carry the rewrite into an imported project, which is the read-only
    # invariant write_projects_skill guards the same way.
    if dst.is_symlink() or dst.exists():
        symlink_service.remove_link(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(rewritten, encoding="utf-8")
    symlink_service.set_readonly(dst)
    return symlink_service.LinkType.COPY
