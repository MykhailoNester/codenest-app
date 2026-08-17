"""Tests for the IDEA-02 project discovery service + router.

Two things are pinned here:

1. **Detection.** Manifest- and ``.git``-based detection works across the
   supported stacks; depth/result caps bound the walk; noisy dirs
   (``node_modules``, ``target``, …) are skipped.
2. **Import contract.** Bulk import skips duplicates by path, rejects
   non-absolute paths, and writes ``tech_stack`` from the supplied
   stack label.
3. **Scan roots are the user's choice.** A scan needs an explicit, non-empty
   root; there is no default root, and ``/`` and ``$HOME`` itself are refused.
"""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import project_discovery as project_discovery_router
from app.services import project_discovery_service

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def discovery_app(
    migrated_db: aiosqlite.Connection,
) -> tuple[TestClient, aiosqlite.Connection]:
    """Mount the discovery router against the shared migrated DB."""
    original_db = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(project_discovery_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db
    db_module._db = original_db


def _make_repo(
    base: pathlib.Path, name: str, *, manifest: str | None = None, git: bool = False
) -> pathlib.Path:
    """Create a fake project directory under ``base``."""
    repo = base / name
    repo.mkdir(parents=True, exist_ok=True)
    if git:
        (repo / ".git").mkdir(exist_ok=True)
    if manifest:
        (repo / manifest).write_text("")
    return repo


# ---------------------------------------------------------------------------
# Service-level tests
# ---------------------------------------------------------------------------


def test_scan_detects_git_and_manifests(tmp_path: pathlib.Path) -> None:
    _make_repo(tmp_path, "alpha", manifest="Cargo.toml")
    _make_repo(tmp_path, "beta", manifest="package.json")
    _make_repo(tmp_path, "gamma", git=True)
    _make_repo(tmp_path, "delta")  # not a project — should be ignored
    _make_repo(tmp_path / "nested", "epsilon", manifest="pyproject.toml")

    candidates = project_discovery_service.scan(roots=[tmp_path])

    by_name = {c["name"]: c for c in candidates}
    assert {"alpha", "beta", "gamma", "epsilon"} <= by_name.keys()
    assert "delta" not in by_name
    assert by_name["alpha"]["stack"] == "rust"
    assert by_name["beta"]["stack"] == "node"
    assert by_name["gamma"]["git"] is True
    assert by_name["epsilon"]["stack"] == "python"
    # default already_imported is False because no DB rows passed in
    assert all(c["already_imported"] is False for c in candidates)


def test_scan_respects_max_depth(tmp_path: pathlib.Path) -> None:
    # depth=0 → only ``tmp_path`` itself is inspected; nothing nested found.
    _make_repo(tmp_path / "level1", "deep", manifest="package.json")
    assert project_discovery_service.scan(roots=[tmp_path], max_depth=0) == []
    # depth=2 finds it.
    candidates = project_discovery_service.scan(roots=[tmp_path], max_depth=2)
    assert any(c["name"] == "deep" for c in candidates)


def test_scan_respects_max_results(tmp_path: pathlib.Path) -> None:
    for i in range(5):
        _make_repo(tmp_path, f"r{i}", manifest="Cargo.toml")
    candidates = project_discovery_service.scan(roots=[tmp_path], max_results=3)
    assert len(candidates) == 3


def test_scan_ignores_manifest_subdirs_of_matched_project(
    tmp_path: pathlib.Path,
) -> None:
    # The walk descends below a match, but inside a matched project only git
    # repos qualify — otherwise every package of a monorepo is a "project".
    outer = _make_repo(tmp_path, "outer", manifest="package.json")
    _make_repo(outer, "inner", manifest="Cargo.toml")
    candidates = project_discovery_service.scan(roots=[tmp_path])
    names = [c["name"] for c in candidates]
    assert names == ["outer"]


def test_scan_finds_repos_nested_inside_a_repo(tmp_path: pathlib.Path) -> None:
    # The reported bug: an umbrella folder that is itself git-tracked and holds
    # further git repos used to yield only the umbrella.
    umbrella = _make_repo(tmp_path, "umbrella", git=True)
    _make_repo(umbrella, "app", git=True, manifest="package.json")
    _make_repo(umbrella / "games", "engine", git=True, manifest="Cargo.toml")
    _make_repo(umbrella, "notes")  # plain dir — not a project

    for git_only in (False, True):
        candidates = project_discovery_service.scan(roots=[tmp_path], git_only=git_only)
        by_name = {c["name"]: c for c in candidates}
        assert set(by_name) == {"umbrella", "app", "engine"}, f"{git_only=}"
        # Parent before child, alphabetical within a level.
        assert [c["name"] for c in candidates] == ["umbrella", "app", "engine"]
        assert by_name["app"]["stack"] == "node"
        assert by_name["engine"]["stack"] == "rust"
        assert all(c["git"] is True for c in candidates)


def test_scan_nested_repos_respect_max_depth_and_noisy_dirs(
    tmp_path: pathlib.Path,
) -> None:
    root = _make_repo(tmp_path, "root", git=True)
    _make_repo(root / "a" / "b", "deep", git=True)  # depth 3 below the root
    _make_repo(root / "vendor", "dep", git=True)  # vendored copy — skipped

    shallow = {
        c["name"]
        for c in project_discovery_service.scan(
            roots=[tmp_path], max_depth=2, git_only=True
        )
    }
    assert shallow == {"root"}
    deeper = {
        c["name"]
        for c in project_discovery_service.scan(
            roots=[tmp_path], max_depth=4, git_only=True
        )
    }
    assert deeper == {"root", "deep"}


def test_scan_skips_noisy_directories(tmp_path: pathlib.Path) -> None:
    # node_modules / target / build / dist / .venv / __pycache__ are skipped
    for noisy in ("node_modules", "target", "build", "dist", ".venv", "__pycache__"):
        _make_repo(tmp_path / noisy, "ignored", manifest="package.json")
    # control: real project at the same level should still surface
    _make_repo(tmp_path, "real", manifest="package.json")
    candidates = project_discovery_service.scan(roots=[tmp_path])
    assert {c["name"] for c in candidates} == {"real"}


def test_scan_marks_already_imported(tmp_path: pathlib.Path) -> None:
    repo = _make_repo(tmp_path, "known", manifest="go.mod")
    candidates = project_discovery_service.scan(
        roots=[tmp_path], already_imported_paths=[str(repo)]
    )
    [hit] = [c for c in candidates if c["name"] == "known"]
    assert hit["already_imported"] is True
    assert hit["stack"] == "go"


def test_scan_dedupes_overlapping_roots(tmp_path: pathlib.Path) -> None:
    _make_repo(tmp_path, "shared", manifest="Cargo.toml")
    sub = tmp_path / "sub"
    sub.mkdir()
    # Make ``sub`` resolve back into tmp_path via a relative path through
    # ``..``. Both roots should still only surface ``shared`` once.
    candidates = project_discovery_service.scan(roots=[tmp_path, sub / ".."])
    assert len([c for c in candidates if c["name"] == "shared"]) == 1


def test_scan_detects_extended_stacks(tmp_path: pathlib.Path) -> None:
    _make_repo(tmp_path, "rs", manifest="Cargo.toml")
    _make_repo(tmp_path, "rb", manifest="Gemfile")
    _make_repo(tmp_path, "ph", manifest="composer.json")
    _make_repo(tmp_path, "sw", manifest="Package.swift")
    candidates = {
        c["name"]: c["stack"] for c in project_discovery_service.scan(roots=[tmp_path])
    }
    assert candidates["rs"] == "rust"
    assert candidates["rb"] == "ruby"
    assert candidates["ph"] == "php"
    assert candidates["sw"] == "swift"


# ---------------------------------------------------------------------------
# Tool detection + git-only mode (Command Center onboarding)
# ---------------------------------------------------------------------------


def _write_git_config(repo: pathlib.Path, *remotes: tuple[str, str]) -> None:
    """Write a ``.git/config`` listing the given ``(name, url)`` remotes in order."""
    (repo / ".git").mkdir(parents=True, exist_ok=True)
    body = "".join(f'[remote "{n}"]\n\turl = {u}\n' for n, u in remotes)
    (repo / ".git" / "config").write_text(body)


def test_detect_tools_claude(tmp_path: pathlib.Path) -> None:
    repo = _make_repo(tmp_path, "withclaude", git=True)
    (repo / ".claude").mkdir()
    assert project_discovery_service.detect_tools(repo) == ["claude"]
    plain = _make_repo(tmp_path, "plain", git=True)
    assert project_discovery_service.detect_tools(plain) == []


def test_scan_git_only_descends_through_manifest_parent(tmp_path: pathlib.Path) -> None:
    parent = _make_repo(tmp_path, "parent", manifest="package.json")
    _make_repo(parent, "child", git=True)
    # Default mode reports the manifest parent and still finds the nested repo.
    default = [c["name"] for c in project_discovery_service.scan(roots=[tmp_path])]
    assert default == ["parent", "child"]
    # git_only walks THROUGH the manifest-only parent to find the nested git repo.
    git_only = [
        c["name"]
        for c in project_discovery_service.scan(roots=[tmp_path], git_only=True)
    ]
    assert git_only == ["child"]


def test_scan_enriches_tools_and_assets(tmp_path: pathlib.Path) -> None:
    repo = _make_repo(tmp_path, "rich", git=True)
    _write_git_config(repo, ("origin", "git@github.com:acme/rich.git"))
    agents = repo / ".claude" / "agents"
    agents.mkdir(parents=True)
    (agents / "a.md").write_text("name: a\n")
    (agents / "b.md").write_text("name: b\n")
    (repo / ".claude" / "skills" / "s1").mkdir(parents=True)
    [hit] = [
        c
        for c in project_discovery_service.scan(roots=[tmp_path])
        if c["name"] == "rich"
    ]
    assert hit["tools"] == ["claude"]
    assert hit["agents"] == 2
    assert hit["skills"] == 1
    assert hit["git_remote"] == "git@github.com:acme/rich.git"


def test_git_remote_prefers_origin(tmp_path: pathlib.Path) -> None:
    repo = _make_repo(tmp_path, "multi")
    _write_git_config(
        repo,
        ("upstream", "https://example.com/upstream.git"),
        ("origin", "https://example.com/origin.git"),
    )
    assert (
        project_discovery_service._git_remote(repo) == "https://example.com/origin.git"
    )


def test_git_remote_none_for_worktree_and_missing(tmp_path: pathlib.Path) -> None:
    # Worktree: .git is a file, not a dir → no local config → None.
    wt = _make_repo(tmp_path, "wt")
    (wt / ".git").write_text("gitdir: /somewhere/.git/worktrees/wt\n")
    assert project_discovery_service._git_remote(wt) is None
    # Git repo with no remotes configured → None.
    plain = _make_repo(tmp_path, "plain", git=True)
    assert project_discovery_service._git_remote(plain) is None


# ---------------------------------------------------------------------------
# Scan roots are always the user's choice (#37)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("roots", [[], [""], ["   "]])
def test_scan_requires_an_explicit_root(roots: list[str]) -> None:
    # There is no default root and no fallback: a scan the user did not ask for
    # is an error, not a walk of ~/Documents, ~/Code and friends.
    with pytest.raises(ValueError, match="at least one root"):
        project_discovery_service.scan(roots=roots)


def test_scan_refuses_the_home_directory_itself(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = (tmp_path / "home").resolve()
    _make_repo(home, "repo", git=True)
    monkeypatch.setattr(project_discovery_service, "_home_dir", lambda: home)
    with pytest.raises(ValueError, match="whole home directory"):
        project_discovery_service.scan(roots=[home])


def test_scan_refuses_the_filesystem_root() -> None:
    with pytest.raises(ValueError, match="filesystem root"):
        project_discovery_service.scan(roots=["/"])


def test_scan_allows_a_folder_inside_home(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The rejection is the home dir itself, not everything under it — the whole
    # point is that the user picks a folder, and that folder usually lives here.
    home = (tmp_path / "home").resolve()
    _make_repo(home / "Code", "repo", git=True)
    monkeypatch.setattr(project_discovery_service, "_home_dir", lambda: home)
    candidates = project_discovery_service.scan(roots=[home / "Code"])
    assert [c["name"] for c in candidates] == ["repo"]


@pytest.mark.asyncio
async def test_router_scan_rejects_a_request_with_no_roots(
    discovery_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, _ = discovery_app
    assert client.post("/api/v1/projects/discovery/scan", json={}).status_code == 422
    assert (
        client.post("/api/v1/projects/discovery/scan", json={"roots": []}).status_code
        == 422
    )


@pytest.mark.asyncio
async def test_router_scan_rejects_the_filesystem_root(
    discovery_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, _ = discovery_app
    resp = client.post("/api/v1/projects/discovery/scan", json={"roots": ["/"]})
    assert resp.status_code == 400
    assert "filesystem root" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Import tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_inserts_new_paths(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    items = [
        {"path": str(tmp_path / "new-one"), "name": "new-one", "stack": "python"},
        {"path": str(tmp_path / "new-two"), "stack": "rust"},
    ]
    result = await project_discovery_service.import_candidates(migrated_db, items)
    assert result["imported"] == 2
    assert result["skipped"] == 0
    rows = await (
        await migrated_db.execute(
            "SELECT name, tech_stack, path FROM projects WHERE path IN (?, ?)",
            (items[0]["path"], items[1]["path"]),
        )
    ).fetchall()
    by_path = {r["path"]: r for r in rows}
    assert by_path[items[0]["path"]]["name"] == "new-one"
    assert by_path[items[0]["path"]]["tech_stack"] == "python"
    # Fallback name when not supplied is the basename
    assert by_path[items[1]["path"]]["name"] == "new-two"


@pytest.mark.asyncio
async def test_import_skips_duplicate_paths(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    path = str(tmp_path / "dup")
    await migrated_db.execute(
        "INSERT INTO projects (name, status, path) VALUES ('dup', 'active', ?)",
        (path,),
    )
    await migrated_db.commit()
    result = await project_discovery_service.import_candidates(
        migrated_db, [{"path": path, "stack": "node"}]
    )
    assert result["imported"] == 0
    assert result["skipped"] == 1


@pytest.mark.asyncio
async def test_import_rejects_non_absolute_paths(
    migrated_db: aiosqlite.Connection,
) -> None:
    result = await project_discovery_service.import_candidates(
        migrated_db, [{"path": "relative/dir"}, {"path": ""}, {"path": "/ok"}]
    )
    assert result["imported"] == 1
    assert result["skipped"] == 2


# ---------------------------------------------------------------------------
# Router-level tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_router_scan_returns_candidates(
    discovery_app: tuple[TestClient, aiosqlite.Connection], tmp_path: pathlib.Path
) -> None:
    client, _ = discovery_app
    _make_repo(tmp_path, "rscan", manifest="pyproject.toml")
    resp = client.post(
        "/api/v1/projects/discovery/scan",
        json={"roots": [str(tmp_path)]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "candidates" in body
    names = {c["name"] for c in body["candidates"]}
    assert "rscan" in names


@pytest.mark.asyncio
async def test_router_import_round_trip(
    discovery_app: tuple[TestClient, aiosqlite.Connection], tmp_path: pathlib.Path
) -> None:
    client, db = discovery_app
    repo = tmp_path / "rt-import"
    repo.mkdir()
    (repo / "Cargo.toml").write_text("")
    resp = client.post(
        "/api/v1/projects/discovery/import",
        json={"items": [{"path": str(repo), "name": "rt-import", "stack": "rust"}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["imported"] == 1
    assert body["skipped"] == 0
    row = await (
        await db.execute("SELECT tech_stack FROM projects WHERE name = 'rt-import'")
    ).fetchone()
    assert row is not None
    assert row["tech_stack"] == "rust"


@pytest.mark.asyncio
async def test_router_scan_marks_already_imported_from_db(
    discovery_app: tuple[TestClient, aiosqlite.Connection], tmp_path: pathlib.Path
) -> None:
    client, db = discovery_app
    repo = _make_repo(tmp_path, "already-here", manifest="go.mod")
    await db.execute(
        "INSERT INTO projects (name, status, path) VALUES ('already-here', 'active', ?)",
        (str(repo),),
    )
    await db.commit()
    resp = client.post(
        "/api/v1/projects/discovery/scan",
        json={"roots": [str(tmp_path)]},
    )
    assert resp.status_code == 200
    [hit] = [c for c in resp.json()["candidates"] if c["name"] == "already-here"]
    assert hit["already_imported"] is True


def test_scan_detects_git_worktree_or_submodule_with_file(
    tmp_path: pathlib.Path,
) -> None:
    # In a git worktree / submodule, ``.git`` is a file pointing at the
    # gitdir. The old is_dir() check missed those repos entirely.
    repo = tmp_path / "wt"
    repo.mkdir()
    (repo / ".git").write_text("gitdir: /tmp/somewhere\n")
    candidates = project_discovery_service.scan(roots=[tmp_path])
    [hit] = [c for c in candidates if c["name"] == "wt"]
    assert hit["git"] is True
