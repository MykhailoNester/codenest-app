"""One-shot re-attribution of historical `agent_sessions` rows (epic #153 / #158).

Attribution is computed exactly once, at hook time, and the upsert's clause is
`project_id=COALESCE(project_id, ?)` (`agent_service._upsert_session_start`):
a row that was `NULL` when it was first recorded is never revisited by
anything. So a better resolver only helps sessions recorded *after* it ships,
while the months of history behind it stay wrong — and every rollup, cost
split and per-project view built on that history stays wrong with it. This
module is the missing second look: it walks every existing session row back
through `cwd_resolver_service.resolve`, the *same* function every hook uses,
and fills in what the old substring matcher could not.

It resolves nothing itself. There is deliberately no path-matching, no repo
walk and no project creation here — a second matcher is precisely the bug
epic #153 was opened to delete (the launch route and the hook path used to
disagree about which project a cwd belonged to). What this module owns is the
*pass*: which rows to look at, which of the resolver's answers may be written
over what is already stored, and how to count the result.

Four rules shape the writes, and each is a way the pass could otherwise do
damage:

  * **A cwd that no longer exists on disk proves nothing.** `match_project`
    is a path-prefix test, so a deleted `/w/acme/api` would be attributed to
    the project at `/w/acme` on the strength of the string alone — a
    plausible-looking guess about a directory nobody can inspect any more.
    Resolution is therefore gated on `cwd_resolver_service.cwd_exists`, and a
    vanished directory stays unattributed and is counted as such. The same
    gate is what keeps the `git_branch` promise: the branch can only come
    from a `<repo>/.git/HEAD` we actually read.
  * **Ephemerality is a property of the path, not of the disk.** A cwd under
    a temp root or the `/ship` worktree root is classified `ephemeral` (#157)
    whether or not it still exists — the throwaway directories are the ones
    most likely to have been cleaned up, and refusing to classify them would
    leave the bulk of the history in `still_unattributed` and hide the very
    distinction #157 added. Nothing is ever attributed on that basis; it only
    decides which column the row is counted in, and pins `session_kind`.
  * **Only `NULL` is filled.** An already-set `project_id` may have been set
    by hand, and an automated sweep must not quietly re-file it. `force=True`
    is the explicit opt-in to overwrite one; no caller in #158 passes it.
    Even under `force`, a resolver that answers `None` never *clears* a
    project id — a forced run replaces attribution, it does not destroy it.
  * **Discovery follows the write.** `resolve(allow_discovery=True)` can mint
    a `status='discovered'` project, so it is only allowed for rows whose
    `project_id` this pass is actually permitted to write. Otherwise a row
    that already has a project would leave a brand-new project row behind
    that nothing references.

`?dry_run=1` writes nothing at all — not even work it later rolls back. The
sidecar shares a single SQLite connection across every request, so a
speculative insert plus `ROLLBACK` is unsafe in both directions: an
interleaved hook's `commit()` would make our writes permanent, and our
rollback would discard that hook's own uncommitted work. It therefore reports
the `created_projects` a real run *would* make via
`cwd_resolver_service.would_discover`, a read-only probe of the resolver's own
step 4, and de-duplicates the way a real run does: by path *prefix* against
the repos the pass has already decided to discover. A real run's second
session hits `match_project`, which is a prefix test against the project set
as it grows, so a project minted at `<root>/outer` claims the nested repo at
`<root>/outer/vendor/inner` and no second row appears. The probe, which only
ever sees the pre-pass project table, would report both — so the pass keeps
that growing set itself and asks `_has_prefix` the same question
`match_project` will. Being already claimed only cancels the *row*: the
nested session is still attributed, to the outer project, so it stays in
`attributed`.

A real run is all-or-nothing. Every UPDATE, and any project row `resolve`
discovered along the way, rides in one transaction committed once at the end;
anything that raises before that — a `database is locked` from SQLite, a cwd
`realpath` will not accept — is rolled back and re-raised. That matters
because of the same shared connection: leaving half a sweep pending on it
would hand the writes to the next hook's `commit()`, which is the hazard
`agents._safe_handle` guards on the ingest path and the reason nothing here
may return a count for work it only partly did.

Idempotence is a property of every write here being conditional on the stored
value differing from the resolved one: a second real run finds nothing to
change, reports `attributed=0` and `created_projects=0`, and leaves every row
byte-identical. The pass is a single bounded `SELECT` materialised up front —
128 rows on the live database — so nothing recurses and no statement mutates
the table a cursor is still walking.
"""

from __future__ import annotations

import logging
from typing import Any

import aiosqlite

from . import cwd_resolver_service

logger = logging.getLogger(__name__)

# Columns this pass is allowed to write, in the order they are assembled into
# an UPDATE. An explicit whitelist rather than "whatever keys the caller put
# in the dict": the SQL is built by joining these names, so nothing outside
# this tuple can ever reach the statement text.
_WRITABLE_COLUMNS = ("project_id", "git_branch", "session_kind")


async def _load_sessions(db: aiosqlite.Connection) -> list[aiosqlite.Row]:
    """Every session row, materialised in one shot.

    Read fully into memory before a single UPDATE runs. SQLite's behaviour
    when a statement modifies the table an open cursor is still stepping
    through is explicitly undefined, and this pass writes to the very table it
    is reading; ordering by the primary key also makes the pass deterministic,
    which is what lets `created_projects` be de-duplicated reliably across
    two sessions that share a repo.
    """
    async with db.execute(
        "SELECT session_id, cwd, project_id, git_branch, session_kind "
        "FROM agent_sessions ORDER BY session_id"
    ) as cur:
        return list(await cur.fetchall())


async def _existing_project_ids(db: aiosqlite.Connection) -> set[int]:
    """Project ids that exist *before* the pass starts.

    How a real run tells "matched an existing project" from "the resolver just
    created one": `resolve` returns an id either way and does not say which.
    The set grows as the pass creates rows, so the second session in a
    freshly discovered repo matches an id the set already holds and is not
    counted a second time.
    """
    async with db.execute("SELECT id FROM projects") as cur:
        return {int(row["id"]) for row in await cur.fetchall()}


def _repo_is_already_claimed(repo_path: str, discovered_repo_keys: set[str]) -> bool:
    """Whether a project the dry run has already counted would claim `repo_path`.

    The dry run's de-duplication, and it has to be a prefix test rather than
    an equality one because that is what a real run's is. A real run reaches
    discovery only after `match_project`, which compares the target against
    every project's stored path with `_has_prefix` — so the moment one row
    mints a project at `<root>/outer`, a later row whose repo is the nested
    `<root>/outer/vendor/inner` *matches that project* and discovery never
    runs a second time. `would_discover` cannot see this: it probes the
    project table as it was before the pass, where neither repo is claimed,
    and so answers `True` for both.

    The comparison delegates to the resolver's own `_match_key` /
    `_has_prefix` rather than re-deriving path-boundary and case rules here.
    Those two are the semantics `match_project` is built on, and a second
    copy of them is how the dry run would drift back out of agreement with
    the real run — the same "no second matcher" rule that keeps this module
    from resolving anything itself.

    Nested keys are not added back to the set by the caller: a repo under an
    already-claimed one mints nothing, and anything below it is under the
    claiming repo too, so the set stays exactly the paths a real run's
    project rows would cover.
    """
    repo_key = cwd_resolver_service._match_key(repo_path)
    return any(
        cwd_resolver_service._has_prefix(repo_key, claimed_key)
        for claimed_key in discovered_repo_keys
    )


async def _apply_updates(
    db: aiosqlite.Connection, session_id: str, updates: dict[str, Any]
) -> None:
    """Write the changed columns of one session row.

    One statement per row rather than one per column: the three values come
    from a single resolution and describe the same moment, so a partial write
    would be a row that is half re-attributed. No commit — the caller commits
    once at the end of the pass, and rolls back if anything raises before it
    gets there, so a failure mid-sweep leaves the table as it was rather than
    partly swept.
    """
    columns = [name for name in _WRITABLE_COLUMNS if name in updates]
    assignments = ", ".join(f"{name} = ?" for name in columns)
    params = [updates[name] for name in columns]
    params.append(session_id)
    await db.execute(
        f"UPDATE agent_sessions SET {assignments} WHERE session_id = ?",
        params,
    )


async def backfill_session_attribution(
    db: aiosqlite.Connection, *, dry_run: bool = False, force: bool = False
) -> dict[str, int]:
    """Re-resolve every session row; return what the pass found and changed.

    `scanned` is every row examined. `attributed` counts only rows this pass
    *changed* — a row that already had the project the resolver now names is
    not counted, which is what makes a second run report `0`. `ephemeral` and
    `still_unattributed` are counts of the resulting state rather than of
    changes: `ephemeral` is every row whose cwd is a throwaway directory (its
    `project_id` stays `NULL` on purpose), and `still_unattributed` is every
    row that ends the pass with no project and is *not* ephemeral — the
    number epic #153's P0 target is trying to drive to zero. The three are
    not a partition of `scanned`: a row that was already attributed is in
    none of them, and an ephemeral row that somehow carries a project id is
    counted as ephemeral.

    `created_projects` is the number of `status='discovered'` project rows the
    pass added (or, under `dry_run`, would add).

    With `dry_run=True` nothing is written and the same counts are returned.
    With `force=True` a project id that is already set is re-resolved and
    replaced; without it, set values are left exactly as they are.
    """
    rows = await _load_sessions(db)
    seen_project_ids = await _existing_project_ids(db)
    # `_match_key`-normalised paths of the repos a dry run has already counted
    # a project row for. Used as prefixes, not as identities — see
    # `_repo_is_already_claimed`.
    would_discover_repo_keys: set[str] = set()

    scanned = 0
    attributed = 0
    ephemeral = 0
    still_unattributed = 0
    created_projects = 0
    wrote_any = False

    try:
        for row in rows:
            scanned += 1
            cwd = row["cwd"]
            current_project_id = row["project_id"]
            # Whether this row's `project_id` is ours to touch at all. It also
            # gates discovery and the dry-run probe: a project row must only ever
            # be created for a session that can actually use it.
            may_write_project = current_project_id is None or force

            is_ephemeral = cwd_resolver_service.is_ephemeral_cwd(cwd)
            resolved_project_id: int | None = None
            git_branch: str | None = None
            session_kind: str | None = (
                cwd_resolver_service.SESSION_KIND_EPHEMERAL if is_ephemeral else None
            )
            would_create = False

            if cwd_resolver_service.cwd_exists(cwd):
                resolution = await cwd_resolver_service.resolve(
                    db, cwd, allow_discovery=may_write_project and not dry_run
                )
                resolved_project_id = resolution.project_id
                git_branch = resolution.git_branch
                session_kind = resolution.session_kind or session_kind
                if (
                    resolved_project_id is not None
                    and resolved_project_id not in seen_project_ids
                ):
                    # An id nothing had before this row's `resolve` call: it was
                    # minted by the discovery step just now.
                    seen_project_ids.add(resolved_project_id)
                    created_projects += 1
                elif may_write_project and dry_run and resolved_project_id is None:
                    would_create = await cwd_resolver_service.would_discover(db, cwd)
                    repo_path = resolution.repo_path
                    # Keyed on the repo, because that is what a real run's
                    # discovery is keyed on: two sessions in the same new repo are
                    # two attributions and one project row. And keyed by prefix,
                    # because a real run's second look goes through
                    # `match_project` — a repo nested inside one this pass has
                    # already decided to discover is claimed by that brand-new
                    # project and adds no row of its own. `would_create` stays
                    # `True` either way: the row is still attributed.
                    if (
                        would_create
                        and repo_path is not None
                        and not _repo_is_already_claimed(
                            repo_path, would_discover_repo_keys
                        )
                    ):
                        would_discover_repo_keys.add(
                            cwd_resolver_service._match_key(repo_path)
                        )
                        created_projects += 1

            changes_project = may_write_project and (
                (
                    resolved_project_id is not None
                    and resolved_project_id != current_project_id
                )
                or would_create
            )
            if changes_project:
                attributed += 1

            ends_attributed = (
                current_project_id is not None
                or resolved_project_id is not None
                or would_create
            )
            if is_ephemeral:
                ephemeral += 1
            elif not ends_attributed:
                still_unattributed += 1

            updates: dict[str, Any] = {}
            if changes_project and resolved_project_id is not None:
                updates["project_id"] = resolved_project_id
            # Fill-only, never overwrite: the branch a session actually ran on is
            # history, and today's `HEAD` is not it. `git_branch` is `None` unless
            # a repo that still exists gave up a readable `HEAD`, which is the
            # whole of the "vanished repo leaves it NULL" promise.
            if git_branch is not None and row["git_branch"] is None:
                updates["git_branch"] = git_branch
            # The same membership test `agent_service._record_session_kind`
            # applies on the hook path — migration 011 carries no CHECK, so this
            # is the constraint — plus a value comparison, so an unchanged kind
            # writes nothing and a re-run stays byte-identical.
            if (
                session_kind in cwd_resolver_service.SESSION_KINDS
                and session_kind != row["session_kind"]
            ):
                updates["session_kind"] = session_kind

            if updates and not dry_run:
                await _apply_updates(db, row["session_id"], updates)
                wrote_any = True

        if wrote_any:
            await db.commit()
    except Exception:
        # The sidecar shares one SQLite connection across every request, so a
        # raise here would leave this pass's applied UPDATEs — and any
        # `status='discovered'` project row `resolve` just inserted, which
        # rides inside our transaction and is not committed by
        # `_create_discovered_project` — pending on that connection, for the
        # next hook's own `commit()` to make permanent. Half a sweep is worse
        # than none: the counts this call would have reported never reach the
        # caller, so nobody knows which rows moved. Roll back to the state the
        # table was in when the pass started, then re-raise so the endpoint
        # fails loudly rather than reporting a run that did not happen. Same
        # discipline as the hook path's `_safe_handle` and
        # `taxonomy_service.reorder`, and unconditional rather than gated on
        # having written: the pending work may be a discovery insert made
        # before the first UPDATE.
        try:
            await db.rollback()
        except Exception:
            logger.exception("backfill_session_attribution: rollback failed")
        raise

    logger.info(
        "backfill_session_attribution: dry_run=%s, force=%s, scanned=%d, "
        "attributed=%d, ephemeral=%d, still_unattributed=%d, created_projects=%d",
        dry_run,
        force,
        scanned,
        attributed,
        ephemeral,
        still_unattributed,
        created_projects,
    )
    return {
        "scanned": scanned,
        "attributed": attributed,
        "ephemeral": ephemeral,
        "still_unattributed": still_unattributed,
        "created_projects": created_projects,
    }
