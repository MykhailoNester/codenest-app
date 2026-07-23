"""Parallel Agent Runner backend.

Fans one prompt out into N isolated git worktrees inside a target project
and merges the chosen winner back when the user picks one.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import HTTPException

from ._project_paths import resolve_project_root

logger = logging.getLogger(__name__)

# Bound a single run's fan-out so a misclick can't spawn dozens of worktrees.
MIN_ATTEMPTS = 2
MAX_ATTEMPTS = 8

# Cap the stored prompt and the diff payload so a runaway client can't OOM
# the sidecar.
MAX_PROMPT_BYTES = 16 * 1024
MAX_DIFF_BYTES = 256 * 1024

_DEFAULT_BRANCH_FALLBACKS = ("main", "master")

# Branch names are written by ``_attempt_paths`` so the format is well-known,
# but git accepts surprising leading characters (``-``) that can be confused
# with flags. Re-validate at the data boundary as defence-in-depth.
_SAFE_BRANCH = re.compile(r"^parallel/\d+/\d+$")


async def _run_git(*args: str, cwd: Path) -> tuple[int, str, str]:
    """Returns ``(returncode, stdout, stderr)`` so callers can distinguish
    expected non-zero exits (e.g. ``git diff`` returns 1 when trees differ)
    from real failures."""
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return (
        int(proc.returncode or 0),
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


async def _resolve_default_branch(project_root: Path) -> str:
    rc, out, _ = await _run_git(
        "symbolic-ref", "--short", "refs/remotes/origin/HEAD", cwd=project_root
    )
    if rc == 0 and out.strip():
        name = out.strip()
        if "/" in name:
            return name.split("/", 1)[1]
        return name
    for candidate in _DEFAULT_BRANCH_FALLBACKS:
        rc, _, _ = await _run_git(
            "rev-parse", "--verify", "--quiet", candidate, cwd=project_root
        )
        if rc == 0:
            return candidate
    raise HTTPException(
        status_code=400,
        detail=(
            f"cannot determine default branch for {project_root} — neither "
            "origin/HEAD nor main/master exists"
        ),
    )


def _attempt_paths(
    project_root: Path, run_id: int, attempt_index: int
) -> tuple[Path, str]:
    worktree = project_root / ".tauri-agents" / f"parallel-{run_id}-{attempt_index}"
    branch = f"parallel/{run_id}/{attempt_index}"
    return worktree, branch


async def _cleanup_attempt(project_root: Path, worktree: Path, branch: str) -> None:
    """Best-effort teardown — logs failures so callers always make progress."""
    rc, _, err = await _run_git(
        "worktree", "remove", "--force", str(worktree), cwd=project_root
    )
    if rc != 0:
        logger.warning(
            "git worktree remove %s failed (rc=%s): %s", worktree, rc, err.strip()
        )
    rc, _, err = await _run_git("branch", "-D", branch, cwd=project_root)
    if rc != 0:
        logger.warning("git branch -D %s failed (rc=%s): %s", branch, rc, err.strip())


async def _cleanup_all_attempts(
    db: aiosqlite.Connection, run_id: int, project_root: Path
) -> int:
    """Tear down still-open worktrees; already-discarded ones were
    cleaned up at transition time."""
    async with db.execute(
        """
        SELECT branch, worktree_path FROM parallel_run_attempts
        WHERE run_id = ? AND status = 'open'
        """,
        (run_id,),
    ) as cur:
        rows = list(await cur.fetchall())
    for row in rows:
        await _cleanup_attempt(
            project_root, Path(str(row["worktree_path"])), str(row["branch"])
        )
    return len(rows)


async def create_run(
    db: aiosqlite.Connection,
    project_id: int,
    prompt: str,
    attempts: int,
) -> dict[str, Any]:
    if not isinstance(prompt, str) or not prompt.strip():
        raise HTTPException(status_code=400, detail="'prompt' is required")
    if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise HTTPException(
            status_code=413, detail=f"prompt exceeds {MAX_PROMPT_BYTES} bytes"
        )
    if (
        not isinstance(attempts, int)
        or attempts < MIN_ATTEMPTS
        or attempts > MAX_ATTEMPTS
    ):
        raise HTTPException(
            status_code=400,
            detail=f"'attempts' must be an integer in [{MIN_ATTEMPTS}, {MAX_ATTEMPTS}]",
        )

    project_root = await resolve_project_root(db, project_id)
    # `_resolve_default_branch` rejects non-repos with a clear 400, so we let
    # it stand in for an explicit `git rev-parse --git-dir` probe — saves a
    # subprocess on the happy path.
    default_branch = await _resolve_default_branch(project_root)

    # Reserve the run row first so we have a stable id to embed in branch
    # names. Worktree creation happens against that id.
    cur = await db.execute(
        """
        INSERT INTO parallel_runs (project_id, prompt, attempts, default_branch)
        VALUES (?, ?, ?, ?)
        """,
        (project_id, prompt, attempts, default_branch),
    )
    run_id = cur.lastrowid
    if run_id is None:
        raise HTTPException(status_code=500, detail="failed to allocate run id")

    created: list[tuple[Path, str, int]] = []
    try:
        for n in range(1, attempts + 1):
            worktree, branch = _attempt_paths(project_root, run_id, n)
            # `git worktree add -b` is atomic and refuses if the branch already
            # exists, which prevents a second concurrent create_run from racing
            # onto the same name.
            rc, out, err = await _run_git(
                "worktree",
                "add",
                "-b",
                branch,
                str(worktree),
                default_branch,
                cwd=project_root,
            )
            if rc != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"git worktree add failed (rc={rc}): {err.strip() or out.strip()}",
                )
            await db.execute(
                """
                INSERT INTO parallel_run_attempts
                    (run_id, attempt_index, branch, worktree_path)
                VALUES (?, ?, ?, ?)
                """,
                (run_id, n, branch, str(worktree)),
            )
            created.append((worktree, branch, n))
        await db.commit()
    except Exception:
        # Roll the DB row back so a partial fan-out doesn't leave an orphan
        # run with fewer attempts than promised, then tear down whatever
        # worktrees we managed to create.
        try:
            await db.rollback()
        except Exception as rb_exc:
            logger.warning("rollback during create_run failure: %s", rb_exc)
        for worktree, branch, _ in created:
            await _cleanup_attempt(project_root, worktree, branch)
        await db.execute("DELETE FROM parallel_runs WHERE id = ?", (run_id,))
        await db.commit()
        raise

    return await get_run(db, run_id)


async def list_runs(
    db: aiosqlite.Connection, project_id: int | None = None
) -> list[dict[str, Any]]:
    cur = await db.execute(
        """
        SELECT r.*, p.name AS project_name, p.path AS project_path,
               (SELECT COUNT(*) FROM parallel_run_attempts a WHERE a.run_id = r.id) AS attempt_count
        FROM parallel_runs r
        JOIN projects p ON p.id = r.project_id
        WHERE (? IS NULL OR r.project_id = ?)
        ORDER BY r.created_at DESC
        LIMIT 200
        """,
        (project_id, project_id),
    )
    return [dict(row) for row in await cur.fetchall()]


async def _fetch_run_row(db: aiosqlite.Connection, run_id: int) -> aiosqlite.Row:
    async with db.execute(
        """
        SELECT r.*, p.name AS project_name, p.path AS project_path
        FROM parallel_runs r
        JOIN projects p ON p.id = r.project_id
        WHERE r.id = ?
        """,
        (run_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    return row


async def get_run(db: aiosqlite.Connection, run_id: int) -> dict[str, Any]:
    run_row = await _fetch_run_row(db, run_id)
    async with db.execute(
        """
        SELECT * FROM parallel_run_attempts
        WHERE run_id = ?
        ORDER BY attempt_index ASC
        """,
        (run_id,),
    ) as cur:
        attempt_rows = await cur.fetchall()
    return {
        "run": dict(run_row),
        "attempts": [dict(r) for r in attempt_rows],
    }


async def _fetch_attempt(
    db: aiosqlite.Connection, run_id: int, attempt_id: int
) -> tuple[dict[str, Any], dict[str, Any]]:
    run_row = await _fetch_run_row(db, run_id)
    async with db.execute(
        "SELECT * FROM parallel_run_attempts WHERE id = ? AND run_id = ?",
        (attempt_id, run_id),
    ) as cur:
        attempt_row = await cur.fetchone()
    if attempt_row is None:
        raise HTTPException(
            status_code=404,
            detail=f"attempt {attempt_id} not found in run {run_id}",
        )
    return dict(run_row), dict(attempt_row)


def _guard_branch(branch: str) -> str:
    if not _SAFE_BRANCH.match(branch):
        raise HTTPException(
            status_code=500,
            detail=f"attempt branch {branch!r} is not in the expected format",
        )
    return branch


async def attempt_diff(
    db: aiosqlite.Connection, run_id: int, attempt_id: int
) -> dict[str, Any]:
    run, attempt = await _fetch_attempt(db, run_id, attempt_id)
    project_root = await resolve_project_root(db, int(run["project_id"]))
    base = str(run["default_branch"])
    branch = _guard_branch(str(attempt["branch"]))

    name_status_result, unified_result = await asyncio.gather(
        _run_git("diff", "--name-status", f"{base}...{branch}", cwd=project_root),
        _run_git("diff", f"{base}...{branch}", cwd=project_root),
    )
    rc, name_status, err = name_status_result
    if rc not in (0, 1):
        raise HTTPException(
            status_code=500, detail=f"git diff --name-status failed: {err.strip()}"
        )
    files: list[dict[str, str]] = []
    for line in name_status.splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2:
            files.append({"status": parts[0], "path": parts[1]})

    rc, unified, err = unified_result
    if rc not in (0, 1):
        raise HTTPException(status_code=500, detail=f"git diff failed: {err.strip()}")

    diff_bytes = unified.encode("utf-8")
    truncated = False
    if len(diff_bytes) > MAX_DIFF_BYTES:
        unified = diff_bytes[:MAX_DIFF_BYTES].decode("utf-8", errors="ignore")
        unified += f"\n\n[diff truncated at {MAX_DIFF_BYTES} bytes]\n"
        truncated = True

    return {
        "run_id": run_id,
        "attempt_id": attempt_id,
        "branch": branch,
        "base_branch": base,
        "files": files,
        "unified_diff": unified,
        "truncated": truncated,
    }


async def merge_attempt(
    db: aiosqlite.Connection, run_id: int, attempt_id: int
) -> dict[str, Any]:
    run, attempt = await _fetch_attempt(db, run_id, attempt_id)
    if run["status"] != "open":
        raise HTTPException(
            status_code=409,
            detail=f"run {run_id} is {run['status']!r}; cannot merge",
        )
    project_root = await resolve_project_root(db, int(run["project_id"]))
    base = str(run["default_branch"])
    branch = _guard_branch(str(attempt["branch"]))

    # All three preflight checks are read-only and independent — issue them
    # in parallel so we pay one git subprocess startup instead of three.
    rev_list_result, status_result, head_result = await asyncio.gather(
        _run_git("rev-list", "--count", f"{base}..{branch}", cwd=project_root),
        _run_git("status", "--porcelain", cwd=project_root),
        _run_git("rev-parse", "--abbrev-ref", "HEAD", cwd=project_root),
    )

    rc, out, err = rev_list_result
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"git rev-list failed: {err.strip()}"
        )
    if out.strip() == "0":
        # Empty attempts would produce a confusing empty merge commit.
        raise HTTPException(
            status_code=409,
            detail=f"attempt {attempt_id} has no commits ahead of {base}",
        )

    rc, status_out, err = status_result
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"git status failed: {err.strip()}")
    # Ignore our own worktree directories — they live under `.tauri-agents/` and
    # would otherwise always trip this check because git sees them as untracked.
    dirty_lines = [
        line
        for line in status_out.splitlines()
        if line and ".tauri-agents/" not in line[3:]
    ]
    if dirty_lines:
        # `git checkout base` below would clobber or block on uncommitted edits.
        raise HTTPException(
            status_code=409,
            detail=(
                f"project working tree at {project_root} has uncommitted "
                "changes; commit or stash them before merging"
            ),
        )

    rc, prior_head_raw, _ = head_result
    prior_head = prior_head_raw.strip() if rc == 0 else ""

    rc, _, err = await _run_git("checkout", base, cwd=project_root)
    if rc != 0:
        raise HTTPException(
            status_code=500, detail=f"git checkout {base} failed: {err.strip()}"
        )
    rc, _, err = await _run_git(
        "merge",
        "--no-ff",
        "-m",
        f"merge(parallel-{run_id}/{attempt['attempt_index']}): pick winner",
        branch,
        cwd=project_root,
    )
    if rc != 0:
        # Try to leave the working tree in a sane state before bubbling the
        # error: abort the merge and switch back to where the user was.
        await _run_git("merge", "--abort", cwd=project_root)
        if prior_head and prior_head != base:
            await _run_git("checkout", prior_head, cwd=project_root)
        raise HTTPException(
            status_code=500,
            detail=f"git merge failed (rc={rc}): {err.strip()}",
        )

    await _cleanup_all_attempts(db, run_id, project_root)

    await db.execute(
        """
        UPDATE parallel_run_attempts
        SET status = CASE WHEN id = ? THEN 'merged' ELSE 'discarded' END,
            merged_at = CASE WHEN id = ? THEN CURRENT_TIMESTAMP ELSE merged_at END
        WHERE run_id = ?
        """,
        (attempt_id, attempt_id, run_id),
    )
    await db.execute(
        """
        UPDATE parallel_runs
        SET status = 'merged', closed_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (run_id,),
    )
    await db.commit()

    return await get_run(db, run_id)


async def reject_attempt(
    db: aiosqlite.Connection, run_id: int, attempt_id: int
) -> dict[str, Any]:
    """Tear down a single attempt's worktree without merging.

    Wraps the attempt-status flip, the open-count check, and the run-close
    update in ``BEGIN IMMEDIATE`` so two concurrent rejects can't both
    decide they are closing the run, and each per-attempt UPDATE is
    guarded by ``WHERE status = 'open'`` so the second reject becomes a
    no-op on an already-discarded row.
    """
    run, attempt = await _fetch_attempt(db, run_id, attempt_id)
    if attempt["status"] != "open":
        raise HTTPException(
            status_code=409,
            detail=f"attempt {attempt_id} is {attempt['status']!r}; cannot reject",
        )
    project_root = await resolve_project_root(db, int(run["project_id"]))
    # Tear down on disk *before* the transaction so the merge-commit-in-DB
    # never references a worktree that's still there. The branch guard runs
    # before any argv-bound use.
    await _cleanup_attempt(
        project_root,
        Path(str(attempt["worktree_path"])),
        _guard_branch(str(attempt["branch"])),
    )

    await db.execute("BEGIN IMMEDIATE")
    try:
        cur = await db.execute(
            """
            UPDATE parallel_run_attempts
            SET status = 'discarded'
            WHERE id = ? AND status = 'open'
            """,
            (attempt_id,),
        )
        if (cur.rowcount or 0) == 0:
            # A concurrent reject won the race. Treat the call as a no-op.
            await db.commit()
            return {
                "run_id": run_id,
                "attempt_id": attempt_id,
                "attempt_status": "discarded",
                "run_closed": False,
                "open_attempts_remaining": 0,
            }
        async with db.execute(
            """
            SELECT COUNT(*) AS n FROM parallel_run_attempts
            WHERE run_id = ? AND status = 'open'
            """,
            (run_id,),
        ) as count_cur:
            row = await count_cur.fetchone()
        open_left = int(row["n"]) if row is not None else 0
        closed_run = False
        if open_left == 0:
            close_cur = await db.execute(
                """
                UPDATE parallel_runs
                SET status = 'discarded', closed_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'open'
                """,
                (run_id,),
            )
            closed_run = (close_cur.rowcount or 0) > 0
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return {
        "run_id": run_id,
        "attempt_id": attempt_id,
        "attempt_status": "discarded",
        "run_closed": closed_run,
        "open_attempts_remaining": open_left,
    }


async def delete_run(db: aiosqlite.Connection, run_id: int) -> dict[str, Any]:
    """Discard the entire run without merging — useful when none of the
    attempts produced anything worth keeping."""
    run_row = await _fetch_run_row(db, run_id)
    project_root = await resolve_project_root(db, int(run_row["project_id"]))
    removed = await _cleanup_all_attempts(db, run_id, project_root)
    await db.execute(
        "UPDATE parallel_runs SET status = 'discarded', closed_at = CURRENT_TIMESTAMP WHERE id = ?",
        (run_id,),
    )
    await db.execute(
        "UPDATE parallel_run_attempts SET status = 'discarded' WHERE run_id = ?",
        (run_id,),
    )
    await db.commit()
    return {"run_id": run_id, "status": "discarded", "removed": removed}
