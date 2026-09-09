"""The single cwd → project / git-branch resolver (epic #153).

Every hook payload carries a `cwd` and nothing else about where the session
lives: no project id, no branch. This module is the only code that turns that
string into an `agent_sessions.project_id` and an `agent_sessions.git_branch`.
An agent pane's launch is the same question with the same input, so
`POST /agents/events/launch` resolves `agent_runs.project_id` through here too
(read-only — see `resolve`); it used to carry its own matcher,
`agent_runs_service.resolve_project_id_for_cwd`, which matched `projects.path`
alone and never walked to a repo root, so a pane and its own session could
land on two different projects.

It replaces `agent_service._match_project`, which was wrong in both
directions:

  * `if path in cwd` is a *substring* test with no path-boundary check, so a
    project at `/Users/x/api` claimed every session running in
    `/Users/x/api-gw`; and
  * a session sitting at a directory above many repos matched whichever
    imported project's path happened to appear in the string, or nothing at
    all — 70 of 128 live sessions ended up with `project_id NULL`.

It also carried a developer's own folder name in product code (`if "/Codenest"
in cwd` → `SELECT id FROM projects WHERE name = 'Codenest'`). Nothing here
replaces that with another literal: the equivalent behaviour is now a
`project_roots` row the user owns (migration 010 / `project_roots_service`).

The resolution, in order:

  1. Normalise the cwd (`os.path.realpath`, no trailing slash) so a session
     opened through a workspace symlink resolves back to the real directory.
     A non-absolute cwd is rejected outright — `realpath` would happily
     resolve it against the *sidecar's* working directory and attribute the
     session to whatever repo the sidecar happens to run from.
  2. Walk **up** to the deepest ancestor holding a `.git` entry: that
     directory, not the cwd, is what a project claims. The walk is bounded
     (`_MAX_WALK_LEVELS`, the filesystem root, the user's home) and never
     looks downward — a directory that merely *contains* repos is not itself
     a project.
  3. Match that directory against `projects` — exact first, then the longest
     path-boundary-safe prefix, exactly the discipline
     `attribution_service.resolve_path_to_project` already applies to
     per-event attribution.
  4. Unmatched but inside an enabled `project_roots` row → create the project
     with `status='discovered'`, keyed on the repo directory so a second
     session in the same repo reuses the row.
  5. Anything else → `None`. An unattributed session is the honest answer and
     is what the Unassigned/workspace rollups already handle.

Two disciplines this module is strict about, because it sits on every hook's
critical path:

  * **No subprocess.** `git_branch` is parsed straight out of
    `<repo>/.git/HEAD`. Shelling out to `git` per hook would add a process
    spawn to every tool call, and process spawning belongs to the Rust shell
    (see AGENTS.md), never the sidecar.
  * **No exception escapes.** `resolve` returns `_UNRESOLVED` and logs rather
    than raising, so a broken filesystem or a pre-migration database can
    never fail hook ingest.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime

import aiosqlite

from . import project_service

logger = logging.getLogger(__name__)

# Upper bound on the upward walk. A real repo is a handful of levels above the
# cwd; anything deeper than this is a pathological path (or a symlink loop
# `realpath` did not collapse) and is not worth statting further.
_MAX_WALK_LEVELS = 40

# `.git/HEAD` is a single short line ("ref: refs/heads/main" or a 40-char
# sha). Cap the read so a corrupt or hostile file cannot pull megabytes into
# memory on a hook.
_MAX_HEAD_BYTES = 4096

_BRANCH_REF_PREFIX = "refs/heads/"


@dataclass(frozen=True)
class CwdResolution:
    """What a cwd resolved to. Every field is independently optional.

    `project_id` and `git_branch` fail independently on purpose: a database
    that cannot answer the project question must not also cost the session
    its branch, and a repo with an unreadable `HEAD` still belongs to its
    project. `repo_path` is the directory the walk settled on (the git repo
    root, or `None` when no repo was found); callers do not need it, but it
    is what makes a wrong answer diagnosable.
    """

    project_id: int | None = None
    git_branch: str | None = None
    repo_path: str | None = None


_UNRESOLVED = CwdResolution()


def _normalize_cwd(cwd: str | None) -> str | None:
    """Return the `realpath`-resolved, trailing-slash-free cwd, or `None`.

    `None` for a blank cwd, a non-absolute cwd (see the module docstring —
    resolving it against the sidecar's own working directory would silently
    attribute the session to the sidecar's repo), a path that resolves to the
    filesystem root, or an `OSError` from `realpath` itself.
    """
    candidate = (cwd or "").strip()
    if not candidate or not os.path.isabs(candidate):
        return None
    try:
        resolved = os.path.realpath(candidate).rstrip("/")
    except OSError:
        return None
    return resolved or None


def _paths_are_case_insensitive() -> bool:
    """Whether this platform compares paths case-insensitively.

    A function rather than a module constant so a test can exercise the
    Windows branch without running on Windows — the whole point of the
    normalisation below is behaviour this platform cannot demonstrate.
    """
    return os.name == "nt"


def _match_key(path: str) -> str:
    """Normalise a path for prefix comparison.

    Separators are folded to ``/`` because the two sides come from different
    places: a project path is whatever was stored at import time, while a cwd
    comes from a hook payload or a pane. On Windows those legitimately differ
    in separator — a stored ``C:/w/acme`` against a ``C:\\w\\acme`` cwd — and
    a literal compare would simply never match.

    Case is folded only where the filesystem does, so ``/w/App`` and
    ``/w/app`` stay distinct projects on Linux (where they can genuinely
    coexist) and are the same one on Windows.
    """
    normalised = path.replace("\\", "/").rstrip("/")
    return normalised.casefold() if _paths_are_case_insensitive() else normalised


def _git_present(path: str) -> bool:
    """True for both a `.git/` directory and a `.git` gitdir file.

    The file form is what worktrees and submodules use. `os.path.exists`
    re-raises `EPERM`, so the guard is what keeps a TCC-protected directory
    (macOS hands the walk plenty of paths it may list but not stat) from
    aborting the walk — mirrors `project_discovery_service._git_present`.
    """
    try:
        return os.path.exists(os.path.join(path, ".git"))
    except OSError:
        return False


def find_repo_root(cwd: str | None) -> str | None:
    """Deepest ancestor of `cwd` (including `cwd`) holding a `.git` entry.

    The walk stops at the filesystem root, after `_MAX_WALK_LEVELS` levels,
    and at the user's home directory — home is *examined* and then the walk
    stops, so a dotfiles repo at `$HOME` is reported (that is what `git`
    itself would say) but no session can ever be attributed to something
    above home. Returns `None` when no repo is found; never raises.
    """
    current = _normalize_cwd(cwd)
    if current is None:
        return None
    try:
        home = os.path.realpath(os.path.expanduser("~")).rstrip("/")
    except OSError:
        home = ""

    for _ in range(_MAX_WALK_LEVELS):
        if _git_present(current):
            return current
        if home and current == home:
            return None
        parent = os.path.dirname(current)
        # dirname("/a") == "/" and dirname("/") == "/": both mean "the next
        # step would leave the tree", so stop without statting "/".
        if parent == current or parent in ("", "/"):
            return None
        current = parent
    return None


def _read_head_line(head_path: str) -> str | None:
    """First line of a `.git/HEAD`-shaped file, or `None` if unreadable.

    Reads bytes (capped at `_MAX_HEAD_BYTES`) and decodes leniently: a branch
    name is bytes to git, and a stray non-UTF-8 byte must degrade to "no
    branch", not to an exception on a hook.
    """
    try:
        with open(head_path, "rb") as fh:
            raw = fh.read(_MAX_HEAD_BYTES)
    except OSError:
        return None
    text = raw.decode("utf-8", errors="ignore")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return None


def read_git_branch(repo_path: str) -> str | None:
    """Current branch of `repo_path`, parsed from `<repo>/.git/HEAD`.

    `ref: refs/heads/x` → `"x"`. Everything else is `None`: a detached HEAD
    (a bare sha), a symbolic ref that is not a branch (`refs/tags/…`), a
    missing or unreadable HEAD.

    A worktree or submodule stores a `.git` *file* holding `gitdir: <path>`;
    that is followed exactly one level, and the target must be a directory
    with its own HEAD. Deeper indirection (a gitdir pointing at another
    gitdir file) resolves to `None` rather than looping — one level covers
    every real worktree layout, and the branch is a nice-to-have, not
    something worth chasing pointers for on every hook.

    No subprocess, by design. Never raises.
    """
    dot_git = os.path.join(repo_path, ".git")
    head_dir = dot_git
    try:
        is_file = os.path.isfile(dot_git)
    except OSError:
        return None
    if is_file:
        pointer = _read_head_line(dot_git)
        if pointer is None or not pointer.startswith("gitdir:"):
            return None
        target = pointer[len("gitdir:") :].strip()
        if not target:
            return None
        if not os.path.isabs(target):
            target = os.path.join(repo_path, target)
        try:
            if not os.path.isdir(target):
                return None
        except OSError:
            return None
        head_dir = target

    line = _read_head_line(os.path.join(head_dir, "HEAD"))
    if line is None or not line.startswith("ref:"):
        return None
    ref = line[len("ref:") :].strip()
    if not ref.startswith(_BRANCH_REF_PREFIX):
        return None
    return ref[len(_BRANCH_REF_PREFIX) :].strip() or None


async def match_project(db: aiosqlite.Connection, path: str) -> int | None:
    """Id of the project owning `path`, or `None`.

    `root_path` is the canonical column (`attribution_service` matches on it
    alone); `path` is the fallback for legacy rows imported before
    `root_path` existed — those are exactly the rows the old substring
    matcher was reading, so dropping them here would look like a regression.

    Ordering by stored-path length descending makes the first hit the most
    specific one, and gives exact matches priority for free: an exact match
    is the longest a match can possibly be, since every prefix match is
    strictly shorter than `path` itself. `== root or startswith(root + "/")`
    is the boundary-safe form — `/a/b` never matches `/a/bc`.

    Both sides go through `_match_key` first, so a Windows `C:\\w\\acme` cwd
    still matches a project stored as `C:/w/acme` and the comparison respects
    the platform's own case rules. That normalisation came from
    `agent_runs_service.resolve_project_id_for_cwd`, the second cwd→project
    matcher this function replaced; it is the only Windows behaviour either
    matcher had, so it moved here rather than being dropped.

    The synthetic workspace project is *not* excluded (unlike
    `attribution_service.resolve_path_to_project`, whose `None` deliberately
    rolls unmatched file touches up to the workspace): a session genuinely
    running inside the workspace directory belongs to the workspace project,
    and that was the pre-existing behaviour of `_match_project`.
    """
    needle = _match_key(path)
    async with db.execute(
        "SELECT id, COALESCE(NULLIF(root_path, ''), NULLIF(path, '')) AS stored "
        "FROM projects "
        "WHERE COALESCE(NULLIF(root_path, ''), NULLIF(path, '')) IS NOT NULL "
        "ORDER BY LENGTH(COALESCE(NULLIF(root_path, ''), NULLIF(path, ''))) DESC, "
        "         id ASC"
    ) as cur:
        rows = await cur.fetchall()
    for row in rows:
        stored = _match_key(str(row["stored"]))
        if not stored or stored == ".":
            continue
        if needle == stored or needle.startswith(stored + "/"):
            return int(row["id"])
    return None


async def _enabled_root_for(db: aiosqlite.Connection, path: str) -> str | None:
    """The most specific enabled `project_roots` row containing `path`.

    Roots are stored `realpath`-resolved and trailing-slash-free by
    `project_roots_service`, and `path` arrives here normalised the same way,
    so this is a plain string comparison — boundary-safe, and with the same
    "a root may itself be the repo" allowance (`path == root`) that keeps a
    root directory which happens to be a git repo from being unresolvable.
    Both sides still go through `_match_key`, so the auto-create gate reads
    paths exactly as `match_project` does rather than diverging on Windows.

    Returns the root as stored, not as a match key: the caller only uses it
    as a yes/no gate, and a case-folded value would be a lie about the row.
    """
    needle = _match_key(path)
    async with db.execute(
        "SELECT path FROM project_roots WHERE enabled = 1 "
        "ORDER BY LENGTH(path) DESC, id ASC"
    ) as cur:
        rows = await cur.fetchall()
    for row in rows:
        stored = str(row["path"])
        root = _match_key(stored)
        if root and (needle == root or needle.startswith(root + "/")):
            return stored.rstrip("/")
    return None


async def _default_profile_id(db: aiosqlite.Connection) -> int | None:
    """The workspace default profile, or `None` if it cannot be read.

    Delegates to `project_service.resolve_default_profile_id` so a discovered
    project gets the same profile every other creation path assigns, but
    swallows the lookup's failures: a database old enough to lack
    `app_settings` must still get its project row, just without a profile.
    """
    try:
        return await project_service.resolve_default_profile_id(db)
    except Exception:
        logger.debug("cwd resolver: default profile lookup failed", exc_info=True)
        return None


async def _create_discovered_project(
    db: aiosqlite.Connection, repo_path: str
) -> int | None:
    """Insert a `status='discovered'` project for `repo_path` and return its id.

    `name` is the repo directory's basename and `path` / `root_path` are both
    the repo directory, so the row is keyed on the only thing that is
    actually unique: its location. A name collision with an existing project
    is therefore harmless — two repos called `api` under different roots are
    two rows with two distinct paths, and neither can be mistaken for the
    other (the old matcher's `WHERE name = 'Codenest'` is exactly the bug
    this avoids).

    The row shape matches `project_import_service.import_project`'s, because
    `project_service.get_all_projects` is an unfiltered `SELECT *` and a
    discovered project therefore appears in the same lists a manually
    imported one does: it gets the workspace's `default_profile_id` (so it
    does not read as profile-less) and an `imported_at` stamp (so it is not
    the one project row with a NULL creation time). Only `status` sets it
    apart, which is the whole point of `'discovered'`.

    Idempotence rests on `uq_projects_root_path`: the losing side of a race
    catches the `IntegrityError` and re-selects the winner's row. SQLite
    rolls back the failed *statement*, not the transaction, so the caller's
    hook keeps everything else it has written. No commit happens here — this
    insert rides inside the caller's transaction, as the rest of hook ingest
    does.
    """
    name = os.path.basename(repo_path) or repo_path
    profile_id = await _default_profile_id(db)
    now_iso = datetime.now(UTC).isoformat()
    try:
        cur = await db.execute(
            """INSERT INTO projects
                   (name, status, path, root_path, is_workspace, is_active,
                    imported_at, profile_id)
                   VALUES (?, 'discovered', ?, ?, 0, 1, ?, ?)""",
            (name, repo_path, repo_path, now_iso, profile_id),
        )
    except aiosqlite.IntegrityError:
        async with db.execute(
            "SELECT id FROM projects WHERE root_path = ?", (repo_path,)
        ) as select_cur:
            row = await select_cur.fetchone()
        return int(row["id"]) if row is not None else None
    return int(cur.lastrowid) if cur.lastrowid is not None else None


async def _resolve_project(
    db: aiosqlite.Connection,
    repo_path: str | None,
    cwd_path: str | None,
    allow_discovery: bool,
) -> int | None:
    """Match, then auto-create under an enabled root, then give up.

    `repo_path` is the git repo root when the walk found one. When it did
    not, matching falls back to the resolved cwd so a session inside an
    imported project that is *not* a git repo (`project_discovery_service`
    imports manifest-only directories too) still attributes correctly — but
    auto-creation stays gated on a real repo, since "one project per git
    repo under a root" is the whole meaning of a root, and a bare directory
    has no repo identity to key a row on — and on `allow_discovery`, which a
    read-only caller clears.
    """
    target = repo_path or cwd_path
    if target is None:
        return None
    matched = await match_project(db, target)
    if matched is not None:
        return matched
    if repo_path is None or not allow_discovery:
        return None
    root = await _enabled_root_for(db, repo_path)
    if root is None:
        return None
    return await _create_discovered_project(db, repo_path)


async def resolve(
    db: aiosqlite.Connection, cwd: str | None, *, allow_discovery: bool = True
) -> CwdResolution:
    """Resolve a `cwd` into a project id and a git branch.

    The one entry point for the whole question: every hook goes through it
    (via `agent_service._upsert_session_start`) and so does an agent pane's
    launch (via `POST /agents/events/launch`, which has a cwd and no project
    id). Never raises: the inner guard keeps a database failure — a
    pre-`010_project_roots` schema, a locked file, a mid-migration table —
    from also costing the session its branch, and the outer guard is the
    promise that nothing at all propagates into hook ingest.

    `allow_discovery=False` makes the call read-only: it matches but never
    creates. The launch route passes it, because "which directories may grow
    the project list" is a decision about *sessions* — a pane launched in an
    unknown repo reads as unattributed now and picks up the project id the
    session's own hooks create moments later.
    """
    try:
        cwd_path = _normalize_cwd(cwd)
        if cwd_path is None:
            return _UNRESOLVED
        repo_path = find_repo_root(cwd_path)
        branch = read_git_branch(repo_path) if repo_path is not None else None
        try:
            project_id = await _resolve_project(
                db, repo_path, cwd_path, allow_discovery
            )
        except Exception:
            logger.warning(
                "cwd resolver: project lookup failed for %s", cwd_path, exc_info=True
            )
            project_id = None
        return CwdResolution(
            project_id=project_id, git_branch=branch, repo_path=repo_path
        )
    except Exception:
        logger.warning("cwd resolver: failed to resolve %r", cwd, exc_info=True)
        return _UNRESOLVED
