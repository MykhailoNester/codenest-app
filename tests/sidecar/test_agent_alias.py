"""Tests for agent_alias_service — the frontmatter rewrite behind an alias.

An alias is only real if the generated file *declares* it: Claude Code reads the
frontmatter ``name:``, so a copy that kept its source's name would be the very
ambiguity aliasing exists to remove.
"""

from __future__ import annotations

import os
import pathlib
import stat

import pytest

from app.services import agent_alias_service as alias
from app.services import symlink_service

AGENT = """\
---
name: code-reviewer
description: Reviews the branch.
model: opus
---

# Code reviewer

Body text with a `---` line below it.

---

More body.
"""


def test_alias_name_joins_with_a_double_dash():
    assert alias.alias_name("miragold", "code-reviewer") == "miragold--code-reviewer"


def test_rewrite_replaces_only_the_name():
    out = alias.rewrite_frontmatter_name(AGENT, "miragold--code-reviewer", "/p/cr.md")

    assert "name: miragold--code-reviewer" in out
    assert "name: code-reviewer\n" not in out
    # Everything else survives: the alias is the same agent under a second name.
    assert "description: Reviews the branch." in out
    assert "model: opus" in out
    assert "# Code reviewer" in out
    assert "More body." in out


def test_rewrite_keeps_the_frontmatter_at_byte_zero():
    """The header must land *after* the block — frontmatter is only frontmatter at
    the start of the file, so a comment above it would hide the whole block."""
    out = alias.rewrite_frontmatter_name(AGENT, "x--code-reviewer", "/p/cr.md")

    assert out.startswith("---\n")
    header_at = out.index("<!-- codenest:")
    assert out.index("model: opus") < header_at
    assert header_at < out.index("# Code reviewer")
    assert "/p/cr.md" in out


def test_rewrite_handles_a_quoted_name_and_odd_spacing():
    text = '---\n  name :   "code-reviewer"  \ndescription: x\n---\nbody\n'
    out = alias.rewrite_frontmatter_name(text, "a--code-reviewer", "/p/cr.md")
    assert "name: a--code-reviewer" in out
    assert 'code-reviewer"' not in out


def test_rewrite_handles_crlf():
    text = "---\r\nname: cr\r\n---\r\nbody\r\n"
    out = alias.rewrite_frontmatter_name(text, "a--cr", "/p/cr.md")
    assert "name: a--cr" in out
    assert "body" in out


def test_rewrite_only_touches_the_first_name_line():
    text = "---\nname: cr\ntools: [Read]\n---\nname: not-frontmatter\n"
    out = alias.rewrite_frontmatter_name(text, "a--cr", "/p/cr.md")
    assert "name: a--cr" in out
    assert "name: not-frontmatter" in out


def test_rewrite_refuses_a_file_with_no_frontmatter():
    with pytest.raises(alias.AliasRewriteError):
        alias.rewrite_frontmatter_name("# just markdown\n", "a--cr", "/p/cr.md")


def test_rewrite_refuses_frontmatter_without_a_name():
    text = "---\ndescription: no name here\n---\nbody\n"
    with pytest.raises(alias.AliasRewriteError):
        alias.rewrite_frontmatter_name(text, "a--cr", "/p/cr.md")


def test_materialize_writes_a_read_only_copy(tmp_path: pathlib.Path):
    src = tmp_path / "project" / "cr.md"
    src.parent.mkdir()
    src.write_text(AGENT)
    dst = tmp_path / "ws" / "agents" / "beta--code-reviewer.md"

    link_type = alias.materialize(src, dst, alias="beta--code-reviewer")

    assert link_type is symlink_service.LinkType.COPY
    assert not dst.is_symlink()
    assert "name: beta--code-reviewer" in dst.read_text()
    # Read-only is the standing signal that edits belong in the project file.
    assert not (dst.stat().st_mode & stat.S_IWUSR)
    assert src.read_text() == AGENT, "the source must never be touched"


def test_materialize_replaces_a_symlink_instead_of_writing_through_it(
    tmp_path: pathlib.Path,
):
    """Writing through a link would edit the imported project — the same
    read-only invariant write_projects_skill guards."""
    src = tmp_path / "project" / "cr.md"
    src.parent.mkdir()
    src.write_text(AGENT)
    victim = tmp_path / "other-project" / "cr.md"
    victim.parent.mkdir()
    victim.write_text("ORIGINAL\n")
    dst = tmp_path / "ws" / "agents" / "beta--code-reviewer.md"
    dst.parent.mkdir(parents=True)
    os.symlink(victim, dst)

    alias.materialize(src, dst, alias="beta--code-reviewer")

    assert victim.read_text() == "ORIGINAL\n"
    assert not dst.is_symlink()


def test_materialize_reports_a_missing_source(tmp_path: pathlib.Path):
    with pytest.raises(FileNotFoundError):
        alias.materialize(tmp_path / "gone.md", tmp_path / "ws" / "x.md", alias="a--x")


def test_materialize_refuses_an_unaliasable_source(tmp_path: pathlib.Path):
    src = tmp_path / "cr.md"
    src.write_text("# no frontmatter\n")
    with pytest.raises(alias.AliasRewriteError):
        alias.materialize(src, tmp_path / "ws" / "a--cr.md", alias="a--cr")


def test_rewrite_ignores_a_name_line_inside_a_block_scalar():
    """A `description: |` block can carry indented lines of its own; the agent's
    real name is the key at column zero."""
    text = (
        "---\n"
        "description: |\n"
        "  Use it when the user says:\n"
        "  name: not the agent name\n"
        "name: code-reviewer\n"
        "---\n"
        "body\n"
    )
    out = alias.rewrite_frontmatter_name(text, "a--code-reviewer", "/p/cr.md")

    assert "name: a--code-reviewer" in out
    assert "  name: not the agent name" in out
    assert "name: code-reviewer\n" not in out
