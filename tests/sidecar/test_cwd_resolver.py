"""Tests for `app/services/cwd_resolver_service.py` (epic #153 / #156).

Every test builds a real directory tree under `tmp_path` — a `.git`
directory with a `HEAD` file is all the resolver reads, so the fixtures are
the genuine article rather than mocks, and the "no subprocess" rule is
enforced by there being no repo for `git` to talk to (nothing here is ever
`git init`-ed).

`tmp_path` on macOS lives under `/private/var/...` and reaches the test
through a symlinked `/var`, so every expected path goes through `_real`,
which applies the same `os.path.realpath` normalisation the resolver does.
"""

from __future__ import annotations

import logging
import os
import pathlib

import aiosqlite
import pytest

from app.services import agent_service, cwd_resolver_service

# ─── Fixtures / helpers ──────────────────────────────────────────────────────


def _real(path: pathlib.Path | str) -> str:
    return os.path.realpath(str(path)).rstrip("/")


def _mk_repo(
    path: pathlib.Path, head: str | None = "ref: refs/heads/main\n"
) -> pathlib.Path:
    """Create `path` as a git repo: a `.git/` directory holding `head`.

    `head=None` creates the `.git` directory with no `HEAD` file at all.
    """
    path.mkdir(parents=True, exist_ok=True)
    git_dir = path / ".git"
    git_dir.mkdir()
    if head is not None:
        (git_dir / "HEAD").write_text(head, encoding="utf-8")
    return path


async def _insert_project(
    db: aiosqlite.Connection,
    name: str,
    *,
    path: str | None = None,
    root_path: str | None = None,
) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace, is_active) "
        "VALUES (?, 'active', ?, ?, 0, 1)",
        (name, path, root_path),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return int(cur.lastrowid)


async def _add_root(
    db: aiosqlite.Connection, path: str, *, enabled: bool = True
) -> None:
    await db.execute(
        "INSERT INTO project_roots (path, label, source, enabled) "
        "VALUES (?, NULL, 'manual', ?)",
        (path, 1 if enabled else 0),
    )
    await db.commit()


async def _project_rows(db: aiosqlite.Connection) -> list[dict]:
    async with db.execute(
        "SELECT id, name, status, path, root_path FROM projects ORDER BY id"
    ) as cur:
        return [dict(row) for row in await cur.fetchall()]


# ─── Matching an existing project ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_exact_repo_match_resolves_project_and_branch(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "api")
    pid = await _insert_project(migrated_db, "api", root_path=_real(repo))

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id == pid
    assert result.git_branch == "main"
    assert result.repo_path == _real(repo)


@pytest.mark.asyncio
async def test_cwd_deep_inside_the_repo_matches_the_project(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "api")
    pid = await _insert_project(migrated_db, "api", root_path=_real(repo))
    deep = repo / "src" / "handlers" / "http"
    deep.mkdir(parents=True)

    result = await cwd_resolver_service.resolve(migrated_db, str(deep))

    assert result.project_id == pid
    assert result.repo_path == _real(repo)


@pytest.mark.asyncio
async def test_legacy_project_with_only_path_still_matches(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Rows imported before `root_path` existed carry only `path`."""
    repo = _mk_repo(tmp_path / "legacy")
    pid = await _insert_project(migrated_db, "legacy", path=_real(repo))

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id == pid


@pytest.mark.asyncio
async def test_nested_repo_picks_the_deepest_repo(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    outer = _mk_repo(tmp_path / "monorepo")
    outer_id = await _insert_project(migrated_db, "monorepo", root_path=_real(outer))
    inner = _mk_repo(outer / "vendor" / "lib", head="ref: refs/heads/vendored\n")
    inner_id = await _insert_project(migrated_db, "lib", root_path=_real(inner))

    result = await cwd_resolver_service.resolve(migrated_db, str(inner / "src"))

    assert result.project_id == inner_id
    assert result.project_id != outer_id
    assert result.git_branch == "vendored"


@pytest.mark.asyncio
async def test_prefix_match_is_path_boundary_safe(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """`/a/b` must never match `/a/bc` — the old substring matcher's bug."""
    await _insert_project(migrated_db, "api", root_path=_real(tmp_path / "api"))
    sibling = _mk_repo(tmp_path / "api-gw")

    result = await cwd_resolver_service.resolve(migrated_db, str(sibling))

    assert result.project_id is None
    assert result.git_branch == "main"


@pytest.mark.asyncio
async def test_no_hardcoded_project_name_fallback(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A cwd containing a project's *name* is not a match for that project.

    The deleted `_match_project` fell back to `"/Codenest" in cwd` →
    `WHERE name = 'Codenest'`; nothing may replace it with another literal.
    """
    await _insert_project(
        migrated_db, "Codenest", root_path=_real(tmp_path / "elsewhere" / "Codenest")
    )
    unrelated = _mk_repo(tmp_path / "somewhere" / "Codenest-clone")

    result = await cwd_resolver_service.resolve(migrated_db, str(unrelated))

    assert result.project_id is None


@pytest.mark.asyncio
async def test_symlinked_cwd_resolves_to_the_real_repo(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "real" / "api")
    pid = await _insert_project(migrated_db, "api", root_path=_real(repo))
    link = tmp_path / "workspace-link"
    link.symlink_to(repo)

    result = await cwd_resolver_service.resolve(migrated_db, str(link))

    assert result.project_id == pid
    assert result.repo_path == _real(repo)


# ─── Auto-creating a discovered project under a root ─────────────────────────


@pytest.mark.asyncio
async def test_repo_under_enabled_root_creates_a_discovered_project(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "fresh-repo")
    await _add_root(migrated_db, _real(root))

    result = await cwd_resolver_service.resolve(migrated_db, str(repo / "src"))

    assert result.project_id is not None
    created = [
        p for p in await _project_rows(migrated_db) if p["id"] == result.project_id
    ]
    assert created == [
        {
            "id": result.project_id,
            "name": "fresh-repo",
            "status": "discovered",
            "path": _real(repo),
            "root_path": _real(repo),
        }
    ]


@pytest.mark.asyncio
async def test_auto_create_is_idempotent_across_sessions(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "fresh-repo")
    await _add_root(migrated_db, _real(root))
    before = len(await _project_rows(migrated_db))

    first = await cwd_resolver_service.resolve(migrated_db, str(repo))
    second = await cwd_resolver_service.resolve(migrated_db, str(repo / "src"))

    assert first.project_id == second.project_id
    assert len(await _project_rows(migrated_db)) == before + 1


@pytest.mark.asyncio
async def test_name_collision_creates_a_second_row_with_its_own_path(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Two repos called `api` under different parents are two distinct rows."""
    existing_id = await _insert_project(
        migrated_db, "api", root_path=_real(tmp_path / "other" / "api")
    )
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "api")
    await _add_root(migrated_db, _real(root))

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id is not None
    assert result.project_id != existing_id
    api_rows = [p for p in await _project_rows(migrated_db) if p["name"] == "api"]
    assert len(api_rows) == 2
    assert len({p["root_path"] for p in api_rows}) == 2


@pytest.mark.asyncio
async def test_repo_outside_every_root_stays_unattributed(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    await _add_root(migrated_db, _real(tmp_path / "Projects"))
    (tmp_path / "Projects").mkdir()
    repo = _mk_repo(tmp_path / "Elsewhere" / "loose-repo")
    before = await _project_rows(migrated_db)

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id is None
    assert result.git_branch == "main"
    assert await _project_rows(migrated_db) == before


@pytest.mark.asyncio
async def test_disabled_root_creates_nothing(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "fresh-repo")
    await _add_root(migrated_db, _real(root), enabled=False)
    before = await _project_rows(migrated_db)

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id is None
    assert await _project_rows(migrated_db) == before


@pytest.mark.asyncio
async def test_directory_under_a_root_with_no_repo_creates_nothing(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A root is "one project per git repo": a bare directory is not one."""
    root = tmp_path / "Projects"
    plain = root / "notes"
    plain.mkdir(parents=True)
    await _add_root(migrated_db, _real(root))
    before = await _project_rows(migrated_db)

    result = await cwd_resolver_service.resolve(migrated_db, str(plain))

    assert result.project_id is None
    assert result.repo_path is None
    assert await _project_rows(migrated_db) == before


# ─── The upward walk ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_walk_never_looks_downward(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """A directory that merely *contains* repos is not itself a project."""
    parent = tmp_path / "Projects"
    _mk_repo(parent / "child-repo")
    await _insert_project(
        migrated_db, "child-repo", root_path=_real(parent / "child-repo")
    )

    result = await cwd_resolver_service.resolve(migrated_db, str(parent))

    assert result.project_id is None
    assert result.repo_path is None


def test_the_walk_is_bounded(tmp_path: pathlib.Path) -> None:
    repo = _mk_repo(tmp_path / "deep-repo")
    levels = cwd_resolver_service._MAX_WALK_LEVELS + 5
    deep = repo.joinpath(*[f"l{i}" for i in range(levels)])
    deep.mkdir(parents=True)

    assert cwd_resolver_service.find_repo_root(str(deep)) is None
    # …and the same repo is found from just inside the bound.
    near = repo / "l0" / "l1"
    assert cwd_resolver_service.find_repo_root(str(near)) == _real(repo)


def test_the_walk_stops_at_home(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    above_home = _mk_repo(tmp_path / "above")
    home = above_home / "home"
    inside = home / "Documents" / "notes"
    inside.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))

    assert cwd_resolver_service.find_repo_root(str(inside)) is None


def test_home_itself_is_examined(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dotfiles repo at `$HOME` is a repo — `git` would say so too."""
    home = _mk_repo(tmp_path / "home")
    monkeypatch.setenv("HOME", str(home))

    assert cwd_resolver_service.find_repo_root(str(home)) == _real(home)


@pytest.mark.asyncio
@pytest.mark.parametrize("cwd", [None, "", "   ", "relative/path", "~/Projects/api"])
async def test_unusable_cwd_resolves_to_nothing(
    migrated_db: aiosqlite.Connection, cwd: str | None
) -> None:
    """Notably a *relative* cwd: `realpath` would resolve it against the
    sidecar's own working directory and attribute the session to whatever
    repo the sidecar runs from."""
    result = await cwd_resolver_service.resolve(migrated_db, cwd)

    assert result == cwd_resolver_service.CwdResolution()


# ─── git_branch, read straight out of .git/HEAD ──────────────────────────────


def test_detached_head_yields_no_branch(tmp_path: pathlib.Path) -> None:
    repo = _mk_repo(tmp_path / "repo", head="9f8b2c1d" + "0" * 32 + "\n")

    assert cwd_resolver_service.read_git_branch(_real(repo)) is None


def test_a_symbolic_ref_that_is_not_a_branch_yields_no_branch(
    tmp_path: pathlib.Path,
) -> None:
    repo = _mk_repo(tmp_path / "repo", head="ref: refs/tags/v1.2.3\n")

    assert cwd_resolver_service.read_git_branch(_real(repo)) is None


def test_branch_name_with_slashes_is_kept_whole(tmp_path: pathlib.Path) -> None:
    repo = _mk_repo(tmp_path / "repo", head="ref: refs/heads/feature/156-cwd\n")

    assert cwd_resolver_service.read_git_branch(_real(repo)) == "feature/156-cwd"


def test_missing_head_yields_no_branch(tmp_path: pathlib.Path) -> None:
    repo = _mk_repo(tmp_path / "repo", head=None)

    assert cwd_resolver_service.read_git_branch(_real(repo)) is None


def test_unreadable_head_yields_no_branch(tmp_path: pathlib.Path) -> None:
    """An unreadable HEAD must degrade to `None`, not raise on a hook.

    Modelled as a *directory* named HEAD: deterministic across users, unlike
    a `chmod 000` file, which root can still read.
    """
    repo = _mk_repo(tmp_path / "repo", head=None)
    (repo / ".git" / "HEAD").mkdir()

    assert cwd_resolver_service.read_git_branch(_real(repo)) is None


def test_worktree_git_file_resolves_one_level(tmp_path: pathlib.Path) -> None:
    real_git = tmp_path / "main-repo" / ".git" / "worktrees" / "wt"
    real_git.mkdir(parents=True)
    (real_git / "HEAD").write_text("ref: refs/heads/wt-branch\n", encoding="utf-8")
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / ".git").write_text(f"gitdir: {real_git}\n", encoding="utf-8")

    assert cwd_resolver_service.read_git_branch(_real(worktree)) == "wt-branch"


def test_relative_gitdir_pointer_resolves_against_the_repo(
    tmp_path: pathlib.Path,
) -> None:
    real_git = tmp_path / "wt-git"
    real_git.mkdir()
    (real_git / "HEAD").write_text("ref: refs/heads/wt-branch\n", encoding="utf-8")
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / ".git").write_text("gitdir: ../wt-git\n", encoding="utf-8")

    assert cwd_resolver_service.read_git_branch(_real(worktree)) == "wt-branch"


def test_deeper_gitdir_indirection_yields_no_branch(tmp_path: pathlib.Path) -> None:
    """One level of `gitdir:` is followed; a pointer to a pointer is not."""
    second = tmp_path / "second-pointer"
    second.write_text(f"gitdir: {tmp_path / 'wt-git'}\n", encoding="utf-8")
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / ".git").write_text(f"gitdir: {second}\n", encoding="utf-8")

    assert cwd_resolver_service.read_git_branch(_real(worktree)) is None


def test_garbage_git_file_yields_no_branch(tmp_path: pathlib.Path) -> None:
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / ".git").write_text("not a gitdir pointer at all\n", encoding="utf-8")

    assert cwd_resolver_service.read_git_branch(_real(worktree)) is None


@pytest.mark.asyncio
async def test_a_worktree_is_still_found_by_the_walk(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """`.git` as a file marks a repo root just as a `.git/` directory does."""
    worktree = tmp_path / "wt"
    (worktree / "src").mkdir(parents=True)
    (worktree / ".git").write_text("gitdir: /nonexistent/elsewhere\n", encoding="utf-8")
    pid = await _insert_project(migrated_db, "wt", root_path=_real(worktree))

    result = await cwd_resolver_service.resolve(migrated_db, str(worktree / "src"))

    assert result.project_id == pid
    assert result.git_branch is None


# ─── Failure containment ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_database_failure_yields_no_project_but_keeps_the_branch(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A pre-`010_project_roots` schema must not cost the session its branch."""
    repo = _mk_repo(tmp_path / "repo")
    await migrated_db.execute("DROP TABLE project_roots")

    with caplog.at_level(logging.WARNING):
        result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id is None
    assert result.git_branch == "main"
    assert any("cwd resolver" in record.message for record in caplog.records)


@pytest.mark.asyncio
async def test_an_unexpected_error_is_logged_and_swallowed(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing may propagate out of the resolver into hook ingest."""

    def _boom(_cwd: str | None) -> str | None:
        raise RuntimeError("filesystem exploded")

    monkeypatch.setattr(cwd_resolver_service, "find_repo_root", _boom)

    with caplog.at_level(logging.WARNING):
        result = await cwd_resolver_service.resolve(migrated_db, str(tmp_path))

    assert result == cwd_resolver_service.CwdResolution()
    assert any("cwd resolver" in record.message for record in caplog.records)


# ─── Wiring: the hook path uses the resolver ──────────────────────────────────


@pytest.mark.asyncio
async def test_session_start_hook_stamps_project_and_branch(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "api", head="ref: refs/heads/release\n")
    pid = await _insert_project(migrated_db, "api", root_path=_real(repo))

    await agent_service.record_session_start(
        migrated_db,
        {"session_id": "sess-156", "cwd": str(repo / "src")},
    )

    async with migrated_db.execute(
        "SELECT project_id, git_branch FROM agent_sessions WHERE session_id = ?",
        ("sess-156",),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["project_id"] == pid
    assert row["git_branch"] == "release"


@pytest.mark.asyncio
async def test_session_start_hook_leaves_an_unmatched_cwd_null(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "unknown-repo")

    await agent_service.record_session_start(
        migrated_db,
        {"session_id": "sess-157", "cwd": str(repo)},
    )

    async with migrated_db.execute(
        "SELECT project_id, git_branch FROM agent_sessions WHERE session_id = ?",
        ("sess-157",),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["project_id"] is None
    assert row["git_branch"] == "main"


# ─── A discovered row looks like every other project row ─────────────────────


async def _insert_default_profile(db: aiosqlite.Connection) -> int:
    """Seed a profile and point `default_profile_id` at it, as bootstrap does."""
    cur = await db.execute("INSERT INTO profiles (name) VALUES ('work')")
    assert cur.lastrowid is not None
    profile_id = int(cur.lastrowid)
    await db.execute(
        "INSERT INTO app_settings (key, value_json) VALUES ('default_profile_id', ?)",
        (str(profile_id),),
    )
    await db.commit()
    return profile_id


@pytest.mark.asyncio
async def test_discovered_project_gets_the_workspace_default_profile(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """`get_all_projects` is an unfiltered `SELECT *`, so a discovered row shows
    up beside imported ones and must not be the one project without a profile
    or a creation stamp."""
    profile_id = await _insert_default_profile(migrated_db)
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "fresh-repo")
    await _add_root(migrated_db, _real(root))

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id is not None
    async with migrated_db.execute(
        "SELECT profile_id, imported_at FROM projects WHERE id = ?",
        (result.project_id,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["profile_id"] == profile_id
    assert row["imported_at"]


@pytest.mark.asyncio
async def test_discovered_project_is_created_without_a_default_profile(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """No `default_profile_id` setting yet → the row still gets written."""
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "fresh-repo")
    await _add_root(migrated_db, _real(root))

    result = await cwd_resolver_service.resolve(migrated_db, str(repo))

    assert result.project_id is not None
    async with migrated_db.execute(
        "SELECT profile_id FROM projects WHERE id = ?", (result.project_id,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["profile_id"] is None


# ─── allow_discovery=False — the read-only caller (an agent pane's launch) ───


@pytest.mark.asyncio
async def test_read_only_resolve_still_matches_an_existing_project(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    repo = _mk_repo(tmp_path / "api")
    pid = await _insert_project(migrated_db, "api", root_path=_real(repo))

    result = await cwd_resolver_service.resolve(
        migrated_db, str(repo / "src"), allow_discovery=False
    )

    assert result.project_id == pid
    assert result.git_branch == "main"


@pytest.mark.asyncio
async def test_read_only_resolve_creates_nothing_under_a_root(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    root = tmp_path / "Projects"
    repo = _mk_repo(root / "fresh-repo")
    await _add_root(migrated_db, _real(root))
    before = await _project_rows(migrated_db)

    result = await cwd_resolver_service.resolve(
        migrated_db, str(repo), allow_discovery=False
    )

    assert result.project_id is None
    assert await _project_rows(migrated_db) == before


# ─── Path matching — the two sides come from different places ────────────────
#
# Moved here with the `_match_key` normalisation itself, from
# `agent_runs_service.resolve_project_id_for_cwd` (the second cwd→project
# matcher this module replaced). These go at `match_project`, which is pure
# string-and-SQL work: a Windows path cannot be handed to `resolve`, whose
# `os.path.isabs` guard is the platform's own.


@pytest.mark.asyncio
async def test_match_project_matches_across_separator_styles(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A Windows cwd arrives with backslashes; the stored path may not have them.

    A literal compare simply never matched, so every run on Windows would read
    as project "unknown".
    """
    pid = await _insert_project(migrated_db, "acme", root_path="C:/w/acme")

    assert (
        await cwd_resolver_service.match_project(migrated_db, "C:\\w\\acme\\frontend")
        == pid
    )
    assert await cwd_resolver_service.match_project(migrated_db, "C:/w/acme") == pid


@pytest.mark.asyncio
async def test_match_project_is_case_sensitive_where_the_filesystem_is(
    migrated_db: aiosqlite.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/w/App` and `/w/app` are two projects on Linux and one on Windows."""
    pid = await _insert_project(migrated_db, "acme", root_path="/w/App")

    assert await cwd_resolver_service.match_project(migrated_db, "/w/app/src") is None

    monkeypatch.setattr(
        cwd_resolver_service, "_paths_are_case_insensitive", lambda: True
    )
    assert await cwd_resolver_service.match_project(migrated_db, "/w/app/src") == pid


@pytest.mark.asyncio
async def test_match_project_still_rejects_a_sibling_prefix_on_windows(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Normalisation must not weaken the separator boundary."""
    await _insert_project(migrated_db, "app", root_path="C:/w/app")

    assert (
        await cwd_resolver_service.match_project(migrated_db, "C:\\w\\app-legacy\\src")
        is None
    )
