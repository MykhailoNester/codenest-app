"""Per-repo attribution spans within one session (epic #153 / #173).

A session is attributed to exactly one project, decided from the cwd it opened
in and never revisited (`agent_service._upsert_session_start` writes
`project_id=COALESCE(project_id, ?)`). For a session opened at a directory
that parents many repos that single answer is wrong for everything after the
first move: five repos' worth of work is filed under whichever repo the
session happened to start in. This module is the missing second dimension —
it turns the `CwdChanged` / `DirectoryAdded` stream that #168 already ingests
into an ordered list of stretches, each attributed to the project the session
was actually in at the time.

It is additive and nothing else changes because it exists. `agent_sessions.
project_id` remains the session's primary attribution, every P1 surface that
reads it keeps reading it, and a consumer that wants the split opts into
`session_project_spans` deliberately.

It resolves nothing itself
--------------------------
Every cwd here goes through `cwd_resolver_service.resolve` — the one
cwd → project path in the codebase, and the one #156 deleted a second matcher
to establish. There is no path matching, no repo walk and no project lookup in
this file; a span's `project_id` is whatever the resolver says, so a span and
its own session can never disagree about what a directory means.

No second ingest path
---------------------
Nothing here registers a hook, mounts a route, or reads a payload off the
wire. `agent_service.record_hook_event` — the single generic recorder behind
all sixteen extended events — calls `record_cwd_observation` after it has
written the event row, inside the same transaction it is about to commit. The
events this module consumes are the rows that ingest already stores; this is a
reader of that stream, not a second copy of it.

Derived, therefore rebuildable
------------------------------
The span list is a pure function of an ordered list of `(cwd, timestamp)`
observations, and both ways of producing that list end up in the same
`_apply_observation`. The live path feeds it one observation as each hook
arrives; `rebuild_session_spans` feeds it the whole list read back out of
`agent_events`. That is what makes a backfill over the existing history
possible — running one is not this ticket's job, but a shape that could not
support it would have been the wrong shape. Because spans are keyed on an
ordinal within the session rather than on a timestamp, a rebuild is also
idempotent: replaying the same events writes the same rows at the same keys.

What opens the first span
-------------------------
`CwdChanged` fires when a session *moves*, so the repo it started in emits no
event of its own. The first observation for a session therefore seeds span 0
from `agent_sessions.cwd` / `started_at` before it is applied, which is why a
session that moves across five repos yields five spans and not four. A session
that never moves has no spans at all: the session row already says where it
was, and a table of one-span sessions would be a slower copy of a column that
is already correct.

Never raises
------------
Every public entry point is wrapped. These writes ride on the hook ingest path,
where the standing rule is that nothing may propagate into a hook handler — a
session that cannot have its spans recorded must still have its event, its
`last_event_at` and its broadcast. A failure is logged and the stream carries
on; the next observation re-opens the question from whatever state the table is
actually in.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

import aiosqlite

from . import cwd_resolver_service

logger = logging.getLogger(__name__)

# The two hook events that carry a directory change. `agent_service` reads
# this rather than spelling the names a second time, so the set of events that
# feed spans and the set this module can replay out of `agent_events` are the
# same set by construction.
CWD_EVENT_TYPES: tuple[str, ...] = ("CwdChanged", "DirectoryAdded")

# Payload keys that can carry the directory now in play, in priority order.
# `new_cwd` is the destination and the field both events actually document;
# `cwd` is the fallback for a payload that names only the directory it is
# reporting from. Both are in `agent_service._PAYLOAD_TOP_LEVEL`, so the
# trimmed payload that reaches `agent_events` still holds whichever one was
# sent — without which a replay could not see what the live path saw.
_CWD_PAYLOAD_KEYS: tuple[str, ...] = ("new_cwd", "cwd")


@dataclass(frozen=True)
class _Observation:
    """One "the session is in this directory now", with its evidence.

    `event_id` is the `agent_events` row that proves it, or `None` for the
    seeded observation that comes from the session row rather than an event.
    """

    cwd: str
    observed_at: str
    event_id: int | None


def observed_cwd(payload: dict) -> str | None:
    """The directory a `CwdChanged` / `DirectoryAdded` payload puts in play.

    Shared by the live recorder and the replay so the two cannot read the same
    payload differently — a divergence here would make a rebuilt span list
    disagree with the one the hooks wrote, for no visible reason.

    Hook payloads come from an external process, so a key can be absent, null,
    or a non-string; anything that is not a usable path reads as "this event
    said nothing about a directory" and the caller skips it.
    """
    for key in _CWD_PAYLOAD_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


async def _open_span(db: aiosqlite.Connection, session_id: str) -> aiosqlite.Row | None:
    """The session's current span — the highest `seq` — or `None` if it has none.

    The highest `seq` is always the open one: spans are appended and never
    inserted between, and closing one is the same statement that opens its
    successor.
    """
    async with db.execute(
        "SELECT seq, project_id, repo_path FROM session_project_spans "
        "WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
        (session_id,),
    ) as cur:
        return await cur.fetchone()


async def _apply_observation(
    db: aiosqlite.Connection,
    session_id: str,
    obs: _Observation,
    *,
    allow_discovery: bool,
) -> None:
    """Fold one observation into the session's spans. The whole algorithm.

    An observation either *extends* the open span or *closes* it and opens the
    next one, and which of the two happens is decided by comparing the
    resolver's answer — `(project_id, repo_path)` — with the open span's.

    Both halves of that pair matter. `project_id` alone would merge two
    unimported repos under one root into a single unattributed span, losing
    exactly the "five repos" distinction the table is for; `repo_path` alone
    would split a project whose directories are not a git repo at all
    (`project_discovery_service` imports manifest-only directories, for which
    the resolver returns no repo path). Together they say "the same place",
    which is what a span is a stretch of, and two subdirectories of one repo
    therefore extend rather than split.

    `ended_at` on the displaced span is written as the *new* span's
    `started_at`, never as a separate clock read: consecutive spans must chain
    exactly, or a session's time is either double-counted or quietly lost
    between them.

    `allow_discovery` is passed straight through to the resolver. The live
    path leaves it on — a session moving into a new repo under a root the user
    has enabled is precisely the case `project_roots` was added to attribute,
    and a span that had to wait for some later import to name its project
    would be recorded unattributed forever. A replay turns it off; see
    `rebuild_session_spans`.
    """
    # A cwd we cannot resolve at all is not evidence that the session moved.
    #
    # `record_cwd_observation` already skips an ABSENT cwd on exactly that
    # reasoning, and a present-but-unusable one proves precisely as little: a
    # relative path, an empty string or a path the resolver rejects tells us
    # nothing about where the session now is. Treating it as a move closes the
    # live span and opens an unattributed one, so a single malformed payload
    # truncates a real, correctly-attributed span and silently ends the
    # attribution for the rest of the session. Skipping keeps the open span
    # open, which is the honest reading of "we learned nothing".
    #
    # Note this is narrower than it looks: a cwd that resolves to no project
    # but IS a usable absolute path still opens an unattributed span, because
    # that genuinely is a move to somewhere we do not recognise.
    if not obs.cwd or not os.path.isabs(obs.cwd):
        logger.debug(
            "span: ignoring unusable cwd %r for session %s", obs.cwd, session_id
        )
        return

    resolution = await cwd_resolver_service.resolve(
        db, obs.cwd, allow_discovery=allow_discovery
    )
    last = await _open_span(db, session_id)
    if (
        last is not None
        and last["project_id"] == resolution.project_id
        and last["repo_path"] == resolution.repo_path
    ):
        await db.execute(
            "UPDATE session_project_spans SET last_seen_at = ? "
            "WHERE session_id = ? AND seq = ?",
            (obs.observed_at, session_id, last["seq"]),
        )
        return

    if last is not None:
        await db.execute(
            "UPDATE session_project_spans SET ended_at = ? "
            "WHERE session_id = ? AND seq = ?",
            (obs.observed_at, session_id, last["seq"]),
        )
    seq = 0 if last is None else int(last["seq"]) + 1
    await db.execute(
        """INSERT INTO session_project_spans
           (session_id, seq, project_id, repo_path, cwd,
            started_at, ended_at, last_seen_at, source_event_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)""",
        (
            session_id,
            seq,
            resolution.project_id,
            resolution.repo_path,
            obs.cwd,
            obs.observed_at,
            obs.observed_at,
            obs.event_id,
        ),
    )


async def _seed_from_session_start(
    db: aiosqlite.Connection, session_id: str, *, allow_discovery: bool
) -> None:
    """Open span 0 from the session's own starting cwd, if it has one.

    The repo a session starts in emits no `CwdChanged` — the event fires on a
    *change* — so a span list built from events alone would begin at the
    session's second repo and silently drop the first. The session row is the
    only record that the first repo was ever in play, and it is a record the
    replay can read back just as the live path can, so seeding from it keeps
    the two derivations identical.

    A session with no stored cwd (a hook that carried none) or no
    `started_at` is left unseeded rather than seeded with a guess: its first
    span then starts at its first observed move, which is the earliest moment
    anything here can actually evidence.
    """
    async with db.execute(
        "SELECT cwd, started_at FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return
    cwd = row["cwd"]
    started_at = row["started_at"]
    if not cwd or not started_at:
        return
    await _apply_observation(
        db,
        session_id,
        _Observation(cwd=cwd, observed_at=started_at, event_id=None),
        allow_discovery=allow_discovery,
    )


async def record_cwd_observation(
    db: aiosqlite.Connection,
    session_id: str,
    cwd: str | None,
    observed_at: str,
    *,
    event_id: int | None = None,
) -> None:
    """Record that `session_id` is now in `cwd`. The live entry point.

    Called by `agent_service.record_hook_event` for the two events in
    `CWD_EVENT_TYPES`, after the event row exists and before the commit, so a
    span rides the same transaction as the event it was derived from.

    Writes nothing and says nothing when the payload carried no usable
    directory: an event that does not name a directory is not evidence that
    the session moved, and inventing a span from its absence would be worse
    than having none.

    Never raises — see the module docstring. Anything that goes wrong here
    leaves the event, the session's liveness and the broadcast untouched.
    """
    try:
        if not session_id or not cwd:
            return
        if await _open_span(db, session_id) is None:
            await _seed_from_session_start(db, session_id, allow_discovery=True)
        await _apply_observation(
            db,
            session_id,
            _Observation(cwd=cwd, observed_at=observed_at, event_id=event_id),
            allow_discovery=True,
        )
    except Exception:
        logger.warning(
            "session spans: could not record cwd observation for session %s",
            session_id,
            exc_info=True,
        )


async def _recorded_observations(
    db: aiosqlite.Connection, session_id: str
) -> list[_Observation]:
    """The session's cwd observations, read back out of `agent_events`.

    Ordered by `id` and not by `created_at`. Timestamps here are truncated to
    the second (`agent_service._now`), and cwd events arrive in bursts — moving
    into a repo and adding a directory are two hooks about one movement — so
    ordering on the timestamp leaves ties that SQLite is free to break either
    way, and a replay that broke them differently would produce a different
    span list from the same history. `id` is the order the rows were ingested
    in, which is the order the hooks actually arrived in.

    A row whose payload will not decode, or which names no directory, is
    skipped rather than allowed to abort the replay: one unreadable event out
    of a session's history should cost that one observation, not the session's
    whole span list.
    """
    placeholders = ", ".join("?" for _ in CWD_EVENT_TYPES)
    async with db.execute(
        "SELECT id, created_at, payload_json FROM agent_events "
        f"WHERE session_id = ? AND event_type IN ({placeholders}) ORDER BY id",
        (session_id, *CWD_EVENT_TYPES),
    ) as cur:
        rows = list(await cur.fetchall())

    observations: list[_Observation] = []
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        cwd = observed_cwd(payload)
        if cwd is None or not row["created_at"]:
            continue
        observations.append(
            _Observation(
                cwd=cwd, observed_at=row["created_at"], event_id=int(row["id"])
            )
        )
    return observations


async def rebuild_session_spans(db: aiosqlite.Connection, session_id: str) -> int:
    """Public wrapper: recompute a session's spans, never raising.

    The module docstring promises every public entry point is wrapped, and this
    one was the exception — harmless only for as long as nothing reaches it
    from near a hook. A backfill route is the obvious future caller and would
    be one import away from breaking the invariant the rest of the file is
    built on, so the guarantee is made real here rather than left as prose.
    """
    try:
        return await _rebuild_session_spans(db, session_id)
    except Exception:
        logger.warning(
            "span rebuild failed for session %s (continuing)", session_id, exc_info=True
        )
        return 0


async def _rebuild_session_spans(db: aiosqlite.Connection, session_id: str) -> int:
    """Recompute one session's spans from the events already recorded.

    The proof that spans are derived rather than merely accumulated, and the
    unit a backfill over the existing `CwdChanged` / `DirectoryAdded` history
    would be built out of. It shares `_apply_observation` with the live path,
    so a rebuilt list cannot drift from the one the hooks wrote: the only
    inputs that differ are where the observations came from.

    `allow_discovery=False`. A replay is a reading of history, not a fresh
    observation of the filesystem, and it must not mint `status='discovered'`
    project rows for directories whose present-day state it is only inferring
    — the same restraint `session_backfill_service`'s dry run takes for the
    same reason. In practice this costs nothing: any repo the live path would
    have discovered already has its project row by the time a replay runs, so
    `match_project` answers and the span is attributed identically.

    The session's existing spans are deleted first so a rebuild *replaces*
    rather than appends. Combined with the `(session_id, seq)` key that makes
    the result a function of the observation list alone, running this twice
    leaves the table byte-identical apart from `recorded_at`.

    Returns the number of spans the session now has. Nothing is committed —
    the statements ride inside the caller's transaction, as everywhere else on
    this path.
    """
    # Read BEFORE deleting, and refuse to delete what cannot be rebuilt.
    #
    # `agent_events` is pruned on a far shorter clock than these spans are
    # meant to live on — `event_retention_service` files tool-grain rows at 30
    # days and this module's own migration header says a span outlives the
    # events it was derived from. So "no observations" is ambiguous: it means
    # either this session never moved, or its evidence has already been swept.
    # Deleting first collapses those two cases into the destructive one, and a
    # backfill run any time after a retention sweep would erase real,
    # correct attribution and return 0 — silently, since there is nothing left
    # to compare against.
    #
    # Existing spans are therefore left strictly alone when there is nothing to
    # rebuild them from. A caller that genuinely wants them gone can DELETE
    # them itself, which is at least a statement of intent.
    observations = await _recorded_observations(db, session_id)
    if not observations:
        async with db.execute(
            "SELECT COUNT(*) AS n FROM session_project_spans WHERE session_id = ?",
            (session_id,),
        ) as cur:
            existing = await cur.fetchone()
        return int(existing["n"]) if existing else 0

    await db.execute(
        "DELETE FROM session_project_spans WHERE session_id = ?", (session_id,)
    )
    await _seed_from_session_start(db, session_id, allow_discovery=False)
    for obs in observations:
        await _apply_observation(db, session_id, obs, allow_discovery=False)

    async with db.execute(
        "SELECT COUNT(*) AS n FROM session_project_spans WHERE session_id = ?",
        (session_id,),
    ) as cur:
        row = await cur.fetchone()
    return int(row["n"]) if row is not None else 0
