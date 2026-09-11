"""Lane C — the incremental transcript scan (epic #153 / #163).

`source_app`, `cli_version` and `title` are empty on almost every session for
one reason: nothing in this application has ever opened a transcript.
`agent_service` stores `transcript_path` on every session and uses it only as
a string to match a profile name against. The file it points at is a full
JSONL conversation log that carries which client started the session
(`entrypoint`), which CLI build ran it (`version`), the branch it started on,
the title the model gave it, every turn's exact token occupancy and every
compaction boundary — none of which any hook payload mentions. This module is
the reader.

What measurement changed about the obvious design
-------------------------------------------------
The epic's decision 4 had this walk `~/.claude/projects`. On this machine that
directory joins **0 of 130** recorded sessions, while `~/.claude-work/projects`
joins 62. A single hardcoded config directory is therefore not a simplification
but a guarantee of reading the wrong files, so — a deliberate, owner-approved
deviation — the pass walks *every* `profiles.claude_config_dir` plus
`$CLAUDE_CONFIG_DIR`. Four more measured facts shape the rest of it:

* **239 of the 335 files under `~/.claude-work` are `agent-<hex>.jsonl`
  sidechain files.** Their rows carry the *parent's* `sessionId` and
  `isSidechain: true`, and not one of them is any session's stored
  `transcript_path`. Keying a session on the filename would mint 239 phantom
  sessions; folding their per-turn occupancy into the parent would overstate
  its context peak by up to 76%. So files are keyed on the `sessionId` found
  *inside* their rows, and a sidechain row contributes only what is a property
  of the CLI process it ran inside (`entrypoint`, `version`) plus the fact that
  the session was still producing rows at that timestamp. Its `cwd`-derived
  branch, permission mode, effort, titles and token usage describe the
  subagent's own window and are dropped.
* **`agent_sessions.context_tokens` is overwritten with the last turn's
  occupancy on every Stop** (`agent_service.record_stop`), so it reports
  wherever a session happened to finish rather than how full it ever got. The
  transcript's true peak is higher for 49 of the 62 joinable sessions, which is
  what `context_peak_tokens` records.
* **A resumed session replays its parent's rows verbatim** under its own new
  session id, so a compaction boundary genuinely belongs to two sessions'
  histories. Compactions are keyed `(session_id, row_uuid)` and inserted with
  `ON CONFLICT DO NOTHING`: re-reading bytes already seen changes nothing, and
  a resumed session's copy neither overwrites nor deletes the parent's.
* **68 of 130 stored `transcript_path` values no longer exist on disk and 23
  on-disk `sessionId`s have no session row.** Neither side of that join is a
  complete list of the work, so the pass is driven by the files it can actually
  open. It does not mint `agent_sessions` rows (owner decision 3): an id with
  no session row is recorded in `transcript_scan_state.session_id` and counted
  as `sessions_unmatched`.

`titleSource` appears 0 times in 113,708 rows on this machine — the field
exists only in the Cowork session registry, not in the transcripts — so
`title_source` is *derived* from which kind of title row was found, never read.

Honest coverage target
----------------------
The epic asked for ">90% known source app". That is unreachable from
transcripts alone and stating it would be a promise the data cannot keep: 68 of
130 sessions have no transcript left to read. The target this module is
measured against instead:

    >45% of all sessions, >95% of sessions whose transcript still exists

62/130 = 48% is the measured ceiling.

Why incremental, and why byte offsets
-------------------------------------
`agent_service._read_last_turn_usage` re-parses the ENTIRE transcript on every
Stop hook — median file 340 KB, largest 15.5 MB — which already makes the one
transcript read this application does the most expensive thing on its hook
critical path. This module deliberately does not copy that shape. Progress is
per *file* and measured in bytes: `transcript_scan_state.byte_offset` is where
the last pass stopped, and a pass resumes there only when `dev`, `inode`,
`size_bytes`, `mtime_ns` and `parser_version` all still agree that the bytes
before it are the same bytes. A rotated, truncated or rewritten file is re-read
from zero; a smarter parser (a bumped `PARSER_VERSION`) re-reads history rather
than leaving it parsed by the old rules forever.

Transcripts are appended to while we read them, so only *complete* lines are
consumed: a trailing partial line is normal rather than corrupt and is left at
the offset for the next pass to finish. A complete line that still will not
decode is counted in `rows_unparsed` and the scan moves on.

Who may write what
------------------
Every `agent_sessions` field a second lane can contest goes through
`lane_reconciler_service.apply(db, session_id, LANE_TRANSCRIPT, …)` first, and
the column is written only when the claim is granted. That covers all eight:
the five provenance fields, `git_branch`, and the two live switches
(`permission_mode`, `effort`) that Lane A outranks us on precisely because a
hook that just saw the switch beats a file read from minutes ago.

The only columns this module writes on its own authority are the three
uncontested rollups migration `014_transcript_scan_state.sql` adds —
`context_peak_tokens`, `compaction_count`, `transcript_last_row_at`. No other
lane computes them, and `_ROLLUP_SQL` is the one statement here that assigns
`agent_sessions` columns without asking the reconciler first.

Profile derivation is `agent_service._derive_profile`, reused rather than
reimplemented, for the same reason the repository has exactly one cwd matcher:
a second matcher is how two code paths start disagreeing about the same
question. It is asked only when it has something to derive: this pass walks
`config_dir` by `config_dir`, so for a file it opened itself the owning profile
is a *lookup on that directory* rather than a match against the file's path,
and only a directory no profile row claims — one reached through
`$CLAUDE_CONFIG_DIR` alone — falls through to the matcher. That ordering is not
a taste: `~/.claude` is a string prefix of `~/.claude-work`, `source_detail` is
a field Lane C wins over the hook, and a label written with Lane C authority
can never be corrected afterwards. `_derive_profile` itself is now anchored on
a path boundary rather than a bare substring (the bug class #156 already
settled once), so the fallback is safe rather than merely secondary.

Nothing here is reachable from a hook handler, but nothing here raises into one
either — the module is import-safe and every filesystem call is guarded, so a
future hook-adjacent caller inherits the same "never block ingest" contract the
rest of the ingest path keeps.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiosqlite

from . import agent_service, lane_reconciler_service

logger = logging.getLogger(__name__)

# Bump when the *reading* of a transcript changes — a new field extracted, a
# corrected derivation — not when unrelated code moves. It is the fifth member
# of the resume guard: the four `stat()` fields can only tell us the file
# changed, and this is the one that says our interpretation of it did, which is
# what makes a fix apply to history instead of only to rows recorded after it.
PARSER_VERSION = 1

# Commit cadence, in rows parsed. Every write this pass makes is a max, a
# last-known-wins or an `ON CONFLICT DO NOTHING`, so a partially committed pass
# is a consistent prefix of a complete one rather than half a sweep: the file
# state committed alongside it names exactly the bytes those rows came from, and
# the next pass resumes from there. That is why this is a commit cadence and not
# the all-or-nothing transaction `session_backfill_service` uses — that pass
# rewrites attribution and cannot be half-applied; this one accumulates facts
# and can.
SCAN_COMMIT_ROWS = 500

# Per-pass budgets. The pass is a background sweep sharing one SQLite
# connection with live hook ingest, so it must end in bounded time no matter
# how much history is on disk. Files are taken oldest-unscanned-first, so a
# budget that stops short never starves a file — it only defers it to the next
# pass, with its byte offset already recorded.
SCAN_MAX_FILES_PER_PASS = 25
SCAN_MAX_BYTES_PER_PASS = 32 * 1024 * 1024

FILE_KIND_SESSION = "session"
FILE_KIND_SIDECHAIN = "sidechain"

# `agent-<hex>.jsonl`. Matched on the filename alone because that is all the
# classification needs: the rows inside still have to be read to learn which
# session they belong to, and this only decides whether their token usage may
# count toward that session's context peak.
_SIDECHAIN_FILENAME = re.compile(r"^agent-[0-9a-f]+\.jsonl$", re.IGNORECASE)

# The `agent_sessions` columns this module may write only with the reconciler's
# permission, and the single source of the column names that reach the
# statement text in `_write_claimed_columns`. Every one of them is registered in
# `lane_reconciler_service.FIELD_LANES` with Lane C permitted; a name that is
# not would be refused by `apply` before any SQL was built.
_CLAIMED_COLUMNS: tuple[str, ...] = (
    "source_app",
    "source_detail",
    "cli_version",
    "title",
    "title_source",
    "git_branch",
    "permission_mode",
    "effort",
)

# The three uncontested rollups, written without asking. `compaction_count` is
# recomputed from `agent_session_compactions` rather than incremented so it
# cannot drift from the rows it counts; the other two are folded with MAX so
# that an incremental slice of a transcript composes with everything earlier
# passes already learned. `NULLIF(..., 0)` / `NULLIF(..., '')` keep "we have
# never seen a value" as NULL instead of collapsing it to a confident zero.
_ROLLUP_SQL = """UPDATE agent_sessions
       SET context_peak_tokens =
               NULLIF(MAX(COALESCE(context_peak_tokens, 0), ?), 0),
           compaction_count = (
               SELECT COUNT(*) FROM agent_session_compactions
                WHERE session_id = agent_sessions.session_id),
           transcript_last_row_at =
               NULLIF(MAX(COALESCE(transcript_last_row_at, ''), COALESCE(?, '')), '')
     WHERE session_id = ?"""

# Titles, strongest first. Derived from *which row carried it*, because no
# transcript row states a `titleSource` — a user-typed title outranks one the
# model generated, which outranks falling back to the last prompt.
_TITLE_ROWS: tuple[tuple[str, str, str], ...] = (
    ("custom-title", "customTitle", "custom"),
    ("ai-title", "aiTitle", "ai"),
    ("last-prompt", "lastPrompt", "prompt"),
)

_TITLE_SOURCES: frozenset[str] = frozenset(source for _k, _v, source in _TITLE_ROWS)

_TITLE_MAX_CHARS = 200

# The two facts a later slice of the same file must not be allowed to weaken.
# `git_branch` is first-wins by design — it is registered to Lane C precisely
# because the transcript knows the branch the run *started* on — and `title`
# is precedence-ordered, so a chunk carrying only a `last-prompt` row must not
# displace a `custom-title` an earlier chunk already proved. Both are decided
# from the aggregate, so both break the moment an aggregate is thrown away
# mid-file; `_flush(carry=True)` keeps it across the commit cadence and
# `_seed_carried_fields` restores it when a *pass* boundary fell mid-file.


@dataclass(frozen=True)
class _ScannedRow:
    """One decoded transcript line, with where it ends and what preceded it.

    `end_offset` is the byte position immediately after this line, and
    `parsed` / `unparsed` are the running counts as of it. The scan loop needs
    all three at the commit cadence: the offset it persists must name the last
    row it actually absorbed, and the counts it adds must cover exactly the
    rows in that same commit rather than the whole slice it was handed.
    """

    data: dict[str, Any]
    is_sidechain: bool
    end_offset: int
    parsed: int
    unparsed: int


@dataclass
class _Compaction:
    """One `compact_boundary` row, flattened to the columns it is stored in."""

    row_uuid: str
    trigger: str | None
    pre_tokens: int | None
    post_tokens: int | None
    cumulative_dropped_tokens: int | None
    duration_ms: int | None
    occurred_at: str | None


@dataclass
class _SessionAggregate:
    """Everything one pass learned about one session id, before it is written.

    Accumulated in memory and flushed at the commit cadence rather than written
    per row: a transcript states the same `entrypoint` and `version` on every
    one of its lines, so writing per row would be tens of thousands of
    redundant UPDATEs and reconciler claims for a single unchanged fact.

    The three title candidates are kept separate rather than resolved as they
    arrive because precedence between them is only decidable once the slice is
    read — an `ai-title` row appearing after a `custom-title` row must not
    displace it.
    """

    session_id: str
    source_app: str | None = None
    source_detail: str | None = None
    cli_version: str | None = None
    git_branch: str | None = None
    permission_mode: str | None = None
    effort: str | None = None
    titles: dict[str, str] = field(default_factory=dict)
    context_peak: int = 0
    last_row_at: str | None = None
    compactions: list[_Compaction] = field(default_factory=list)


@dataclass
class _FileState:
    """A `transcript_scan_state` row in flight, plus where reading stopped."""

    realpath: str
    config_dir: str
    file_kind: str
    dev: int
    inode: int
    size_bytes: int
    mtime_ns: int
    byte_offset: int
    rows_parsed: int
    rows_unparsed: int
    session_id: str | None = None
    last_error: str | None = None


# ─── Reading ────────────────────────────────────────────────────────────────


def _text(value: Any) -> str | None:
    """A non-blank string, or None for everything else.

    Same normalisation `agent_service._provenance_value` applies to hook
    payloads: a missing key, a null, a number, a nested object and a string
    that is blank after stripping all mean "this row proves nothing", and only
    a real string is stored. Kept distinct from the literal `"unknown"`, which
    is a value a client can genuinely send.
    """
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _int(value: Any) -> int | None:
    """An int, or None — transcripts carry these as numbers but not always."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def _classify(path: Path) -> str:
    return (
        FILE_KIND_SIDECHAIN
        if _SIDECHAIN_FILENAME.match(path.name)
        else FILE_KIND_SESSION
    )


def _occupancy(usage: dict[str, Any]) -> int:
    """The whole prompt the model saw on one turn.

    The same three-part sum `agent_service.record_stop` computes for
    `context_tokens` — input plus both cache halves — so `context_peak_tokens`
    and `context_tokens` are the same measurement taken at different moments
    and a reader can compare them directly. Output tokens are excluded: they
    are what the turn produced, not what it had to hold.
    """
    return (
        (_int(usage.get("input_tokens")) or 0)
        + (_int(usage.get("cache_read_input_tokens")) or 0)
        + (_int(usage.get("cache_creation_input_tokens")) or 0)
    )


def _absorb_row(
    agg: _SessionAggregate, row: dict[str, Any], is_sidechain: bool
) -> None:
    """Fold one decoded transcript row into its session's aggregate.

    `is_sidechain` is taken from the row's own `isSidechain` flag rather than
    from the filename, because that is the only statement that is true per row:
    a sidechain file's rows all carry the parent's `sessionId`, so the filename
    tells us nothing about which session a row belongs to and only the flag
    tells us whose window its numbers describe.

    A sidechain row contributes `entrypoint`, `version` and its timestamp —
    facts about the CLI process the subagent ran inside, which is the parent's
    process — and nothing else. Its `cwd`, branch, permission mode, effort,
    titles and token usage are the subagent's own, and counting that usage
    toward the parent is the 76% overstatement this module exists to avoid.
    """
    timestamp = _text(row.get("timestamp"))
    if timestamp is not None and (
        agg.last_row_at is None or timestamp > agg.last_row_at
    ):
        agg.last_row_at = timestamp

    # Last-known-wins: a transcript restates these on every line, and the last
    # line is the most recent statement of them.
    agg.source_app = _text(row.get("entrypoint")) or agg.source_app
    agg.cli_version = _text(row.get("version")) or agg.cli_version

    if is_sidechain:
        return

    # First-wins, unlike the two above: `git_branch` is registered to Lane C
    # because the transcript records the branch the run actually *started* on,
    # which a later row on a branch the user switched to mid-session would
    # destroy. Lane A already supplies "the branch as of the last hook".
    if agg.git_branch is None:
        agg.git_branch = _text(row.get("gitBranch"))

    agg.permission_mode = _text(row.get("permissionMode")) or agg.permission_mode
    agg.effort = _text(row.get("effort")) or agg.effort

    row_type = _text(row.get("type"))
    for kind, key, source in _TITLE_ROWS:
        if row_type == kind:
            title = _text(row.get(key))
            if title is not None:
                agg.titles[source] = title[:_TITLE_MAX_CHARS]

    message = row.get("message")
    if isinstance(message, dict):
        usage = message.get("usage")
        if isinstance(usage, dict):
            agg.context_peak = max(agg.context_peak, _occupancy(usage))

    if row_type == "system" and _text(row.get("subtype")) == "compact_boundary":
        meta = row.get("compactMetadata")
        row_uuid = _text(row.get("uuid"))
        if isinstance(meta, dict) and row_uuid is not None:
            agg.compactions.append(
                _Compaction(
                    row_uuid=row_uuid,
                    trigger=_text(meta.get("trigger")),
                    pre_tokens=_int(meta.get("preTokens")),
                    post_tokens=_int(meta.get("postTokens")),
                    cumulative_dropped_tokens=_int(meta.get("cumulativeDroppedTokens")),
                    duration_ms=_int(meta.get("durationMs")),
                    occurred_at=timestamp,
                )
            )


def _derive_title(agg: _SessionAggregate) -> tuple[str | None, str | None]:
    """`(title, title_source)`, derived from which row carried the title.

    `titleSource` appears 0 times in 113,708 transcript rows on this machine —
    it is a Cowork session-registry field, not a transcript one — so reading it
    would populate nothing. What the transcript does say is *which kind of row*
    the title came from, and that is the same distinction under a name we
    derive rather than import. Returns `(None, None)` when the slice carried no
    title at all, which leaves whatever an earlier pass proved untouched.
    """
    for _kind, _key, source in _TITLE_ROWS:
        title = agg.titles.get(source)
        if title is not None:
            return title, source
    return None, None


def _iter_rows(
    path: Path, start: int, max_bytes: int
) -> tuple[list[_ScannedRow], int, int, int]:
    """Read complete JSONL lines from `start`; return rows and where we stopped.

    Returns `(rows, offset, parsed, unparsed)` where `offset` is the byte
    position after the last *complete* line consumed. Only complete lines are
    taken: a transcript is appended to while we read it, so a trailing fragment
    is the normal state of a live file rather than corruption, and leaving the
    offset in front of it means the next pass reads that line whole instead of
    discarding half a turn.

    `max_bytes` is the pass's remaining byte budget, enforced here rather than
    only when choosing files, so that a single very large transcript (15.5 MB
    is the largest on this machine) is read across several passes instead of
    blowing the budget in one.

    Every row carries where *it* ends and how many lines had been parsed and
    skipped by the time it was read, not just the slice totals. That is what
    lets the commit cadence record a byte offset the loop has actually reached:
    an offset committed ahead of the rows behind it would tell the next pass
    those bytes were absorbed when a failure mid-file meant they never were.

    Raises `OSError` only — a decode failure is counted, not raised, because
    one malformed line must not cost the rest of the file.
    """
    rows: list[_ScannedRow] = []
    parsed = 0
    unparsed = 0
    offset = start
    consumed = 0
    with open(path, "rb") as fh:
        fh.seek(start)
        for raw in fh:
            if not raw.endswith(b"\n"):
                # Partial trailing line — leave the offset in front of it.
                break
            offset += len(raw)
            consumed += len(raw)
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                unparsed += 1
                continue
            if not isinstance(obj, dict):
                unparsed += 1
                continue
            parsed += 1
            rows.append(
                _ScannedRow(
                    data=obj,
                    is_sidechain=bool(obj.get("isSidechain")),
                    end_offset=offset,
                    parsed=parsed,
                    unparsed=unparsed,
                )
            )
            if consumed >= max_bytes:
                break
    return rows, offset, parsed, unparsed


# ─── Discovery ──────────────────────────────────────────────────────────────


async def config_dirs(db: aiosqlite.Connection) -> list[Path]:
    """Every Claude config directory this machine is known to write under.

    `profiles.claude_config_dir` plus `$CLAUDE_CONFIG_DIR`, expanded,
    symlink-resolved and de-duplicated — the owner-approved deviation from the
    epic's decision 4, which named `~/.claude` alone and would read 0 of the
    130 recorded sessions here. No implicit default is added: a directory this
    application was never told about holds sessions it was never told about
    either, and guessing one would make the coverage figure unattributable to
    any configured profile.

    Never raises. A `profiles` table that cannot be read (mid-migration, a
    locked database) yields whatever the environment alone can say, because a
    partial scan is worth more than a failed one.
    """
    raw: list[str] = []
    try:
        cursor = await db.execute(
            "SELECT claude_config_dir FROM profiles "
            "WHERE claude_config_dir IS NOT NULL AND claude_config_dir != '' "
            "ORDER BY created_at ASC, id ASC"
        )
        raw = [row["claude_config_dir"] for row in await cursor.fetchall()]
    except Exception:
        logger.warning("transcript scan: could not read profiles", exc_info=True)

    env_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if env_dir:
        raw.append(env_dir)

    resolved: list[Path] = []
    seen: set[str] = set()
    for value in raw:
        text = (value or "").strip()
        if not text:
            continue
        try:
            path = Path(text).expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        resolved.append(path)
    return resolved


async def _profiles_by_config_dir(db: aiosqlite.Connection) -> dict[str, str]:
    """`{resolved claude_config_dir: profile name}` — identity, not derivation.

    The walker already knows which config directory it opened a file from, so
    the profile that owns it is a lookup on that directory, not an inference
    from the file's path. That distinction is the whole of issue 1 on this
    ticket: matching the *path* is what let `~/.claude` claim the sessions of
    `~/.claude-work`, and `source_detail` is a Lane C field that outranks the
    hook, so a wrong label there can never be corrected later.

    `agent_service._derive_profile` remains the fallback for the case this map
    cannot answer — a config directory reached through `$CLAUDE_CONFIG_DIR`
    with no profile row of its own, or one whose stored spelling does not
    resolve. It is now boundary-anchored too, so the fallback is safe rather
    than merely secondary.

    Keys are `expanduser().resolve()`d exactly as `config_dirs` resolves the
    directories it walks, so the two sides compare the same spelling of the
    same directory. First profile wins on a tie, matching `_derive_profile`'s
    creation-order scan.
    """
    mapping: dict[str, str] = {}
    try:
        cursor = await db.execute(
            "SELECT name, claude_config_dir FROM profiles "
            "WHERE claude_config_dir IS NOT NULL AND claude_config_dir != '' "
            "ORDER BY created_at ASC, id ASC"
        )
        rows = await cursor.fetchall()
    except Exception:
        logger.warning("transcript scan: could not read profiles", exc_info=True)
        return mapping

    for row in rows:
        text = (row["claude_config_dir"] or "").strip()
        if not text:
            continue
        try:
            key = str(Path(text).expanduser().resolve())
        except (OSError, RuntimeError):
            continue
        mapping.setdefault(key, row["name"])
    return mapping


def _discover(config_dir: Path) -> list[Path]:
    """Every `*.jsonl` under `<config_dir>/projects`, symlink-resolved.

    Resolved because `transcript_scan_state` is keyed on the realpath: two
    config directories that symlink to the same tree — which is exactly how a
    profile gets "its own" directory pointing at a shared one — must not be
    read twice under two names and credited twice.
    """
    projects = config_dir / "projects"
    try:
        if not projects.is_dir():
            return []
        found = {path.resolve() for path in projects.rglob("*.jsonl") if path.is_file()}
    except OSError:
        logger.warning("transcript scan: could not list %s", projects, exc_info=True)
        return []
    return sorted(found)


async def _load_states(db: aiosqlite.Connection) -> dict[str, aiosqlite.Row]:
    """Every recorded file's progress, in one read.

    One query rather than one per candidate file: the pass looks at hundreds of
    paths to find the handful with new bytes, and a per-file SELECT would make
    the *deciding* cost scale the way the reading is supposed to not.
    """
    cursor = await db.execute("SELECT * FROM transcript_scan_state")
    return {row["realpath"]: row for row in await cursor.fetchall()}


def _resume_offset(state: aiosqlite.Row | None, stat: os.stat_result) -> int:
    """Where to resume this file, or 0 when the recorded progress is void.

    `byte_offset` is only meaningful while the bytes before it are the same
    bytes. Five things have to agree for that: the file is the same inode on
    the same device, it has not shrunk below the size we recorded, its mtime is
    not older than the one we recorded (a restored backup), and our parser is
    the same one that produced the offset. Any disagreement re-reads from zero,
    which is cheap and correct, where resuming into a different conversation is
    neither.
    """
    if state is None:
        return 0
    if int(state["parser_version"] or 0) != PARSER_VERSION:
        return 0
    if state["dev"] is None or state["inode"] is None:
        return 0
    if int(state["dev"]) != stat.st_dev or int(state["inode"]) != stat.st_ino:
        return 0
    recorded_size = int(state["size_bytes"] or 0)
    if stat.st_size < recorded_size:
        return 0
    if stat.st_mtime_ns < int(state["mtime_ns"] or 0):
        return 0
    offset = int(state["byte_offset"] or 0)
    return offset if 0 <= offset <= stat.st_size else 0


# ─── Writing ────────────────────────────────────────────────────────────────


async def _write_claimed_columns(
    db: aiosqlite.Connection, session_id: str, values: dict[str, Any]
) -> bool:
    """Write the contested columns Lane C is allowed to win, and only those.

    Every column here is contested — Lane A writes `permission_mode`, `effort`
    and `git_branch` from hooks, and Lane B (P3) will supersede the money
    fields — so each one asks `lane_reconciler_service.apply` first and is
    written only when the claim is granted. A refusal is not an error: on
    `permission_mode` and `effort` Lane A outranks us by design, because a hook
    that just observed a live switch beats a file read from minutes ago.

    The column name reaches the statement text from `_CLAIMED_COLUMNS` and
    nowhere else, so nothing a transcript contains can influence which column
    is written; the value is always a bound parameter. Returns whether any
    column was actually written, which is what `sessions_updated` counts.
    """
    wrote = False
    for column in _CLAIMED_COLUMNS:
        value = values.get(column)
        if value is None:
            continue
        claim = await lane_reconciler_service.apply(
            db,
            session_id,
            lane_reconciler_service.LANE_TRANSCRIPT,
            column,
            value,
        )
        if not claim.applied:
            continue
        await db.execute(
            f"UPDATE agent_sessions SET {column} = ? WHERE session_id = ?",
            (value, session_id),
        )
        wrote = True
    return wrote


async def _record_compactions(
    db: aiosqlite.Connection, session_id: str, compactions: list[_Compaction]
) -> int:
    """Insert this slice's compaction boundaries; return how many were new.

    `ON CONFLICT DO NOTHING` on `(session_id, row_uuid)` is the whole of the
    resumed-session guarantee. A resumed session replays its parent's rows
    verbatim under its own id, so the same `row_uuid` legitimately appears
    under two session ids and both rows are kept; within one session id,
    re-reading bytes an earlier pass already saw inserts nothing. Nothing here
    deletes, so no re-scan can ever shorten a session's history.
    """
    inserted = 0
    for compaction in compactions:
        cursor = await db.execute(
            """INSERT INTO agent_session_compactions
                   (session_id, row_uuid, trigger, pre_tokens, post_tokens,
                    cumulative_dropped_tokens, duration_ms, occurred_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(session_id, row_uuid) DO NOTHING""",
            (
                session_id,
                compaction.row_uuid,
                compaction.trigger,
                compaction.pre_tokens,
                compaction.post_tokens,
                compaction.cumulative_dropped_tokens,
                compaction.duration_ms,
                compaction.occurred_at,
            ),
        )
        inserted += max(cursor.rowcount, 0)
    return inserted


async def _upsert_file_state(db: aiosqlite.Connection, state: _FileState) -> None:
    """Record where this file has been read to.

    `rows_parsed` / `rows_unparsed` accumulate across passes (`col = col + ?`)
    because they describe the file, not the slice; everything else is replaced,
    because it describes the file as of now. Written in the same transaction as
    the rows it accounts for, so a committed offset is never ahead of the facts
    extracted from the bytes behind it — which is why the caller sets
    `byte_offset` from the row it has just absorbed (`_ScannedRow.end_offset`)
    rather than from the end of the slice it was handed: an offset committed
    ahead of the loop would tell the next pass that a file whose read failed
    mid-way had been read whole, and the rows after the failure would be lost
    permanently.
    """
    await db.execute(
        """INSERT INTO transcript_scan_state
               (realpath, config_dir, session_id, file_kind, dev, inode,
                size_bytes, mtime_ns, byte_offset, rows_parsed, rows_unparsed,
                parser_version, last_scanned_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(realpath) DO UPDATE SET
               config_dir      = excluded.config_dir,
               session_id      = COALESCE(excluded.session_id, session_id),
               file_kind       = excluded.file_kind,
               dev             = excluded.dev,
               inode           = excluded.inode,
               size_bytes      = excluded.size_bytes,
               mtime_ns        = excluded.mtime_ns,
               byte_offset     = excluded.byte_offset,
               rows_parsed     = rows_parsed + excluded.rows_parsed,
               rows_unparsed   = rows_unparsed + excluded.rows_unparsed,
               parser_version  = excluded.parser_version,
               last_scanned_at = excluded.last_scanned_at,
               last_error      = excluded.last_error""",
        (
            state.realpath,
            state.config_dir,
            state.session_id,
            state.file_kind,
            state.dev,
            state.inode,
            state.size_bytes,
            state.mtime_ns,
            state.byte_offset,
            state.rows_parsed,
            state.rows_unparsed,
            PARSER_VERSION,
            datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds"),
            state.last_error,
        ),
    )
    # Counts are additive in the UPDATE branch, so a slice must not be counted
    # twice if the same state object is flushed again at the end of the file.
    state.rows_parsed = 0
    state.rows_unparsed = 0


async def _session_exists(db: aiosqlite.Connection, session_id: str) -> bool:
    cursor = await db.execute(
        "SELECT 1 FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    return await cursor.fetchone() is not None


async def _seed_carried_fields(
    db: aiosqlite.Connection, agg: _SessionAggregate
) -> None:
    """Restore what Lane C already proved, for a file resumed mid-way.

    Only called when a pass picks a file up at a non-zero byte offset, i.e.
    when an earlier pass read the beginning of this conversation and stopped
    at a budget boundary. That earlier pass saw the branch the run started on
    and any title stronger than the ones left in the remaining bytes; without
    re-reading its conclusion, this pass would re-derive both from a middle
    chunk and, at equal Lane C rank, be granted the overwrite.

    Deliberately *not* done when a file is read from byte 0. A full re-read is
    how a `PARSER_VERSION` bump repairs history, and seeding from the old
    conclusion would make the repair a no-op.

    Reads the reconciler's own claim table rather than the `agent_sessions`
    columns, because the question is "what did Lane C decide", not "what is
    stored" — a value another lane owns must not be mistaken for ours.
    """
    try:
        claims = await lane_reconciler_service.read(db, agg.session_id)
    except Exception:
        logger.warning(
            "transcript scan: could not read prior claims for %s",
            agg.session_id,
            exc_info=True,
        )
        return

    def mine(field: str) -> str | None:
        claim = claims.get(field)
        if claim is None or claim["lane"] != lane_reconciler_service.LANE_TRANSCRIPT:
            return None
        return _text(claim["value_text"])

    agg.git_branch = mine("git_branch")
    source = mine("title_source")
    title = mine("title")
    if source in _TITLE_SOURCES and title is not None:
        agg.titles.setdefault(str(source), title)


async def _flush(
    db: aiosqlite.Connection,
    aggregates: dict[str, _SessionAggregate],
    counts: dict[str, int],
    unmatched: set[str],
    updated: set[str],
    *,
    carry: bool,
) -> None:
    """Write one commit-cadence slice of accumulated session facts.

    A session id with no `agent_sessions` row is counted and dropped, never
    minted (owner decision 3): 23 on-disk ids have no row, and inventing them
    would put sessions in the catalog that the application never observed. The
    only record such an id leaves is
    `transcript_scan_state.session_id`, which is written by the caller
    regardless of whether the join succeeded — so the evidence that the
    transcript exists survives even though the session does not.

    `carry` says whether the file is finished. Mid-file (`carry=True`) the
    aggregates are kept, minus the compactions already inserted: `git_branch`
    is first-wins and `title` is precedence-ordered, so a fresh aggregate for
    the next chunk would take the first branch in *that* chunk and whatever
    title it happened to contain — and because a Lane C claim over a Lane C
    claim is granted at equal rank, it would overwrite the right answer with a
    mid-session one. At the end of a file (`carry=False`) they are cleared, so
    the next file starts from its own evidence.
    """
    for session_id, agg in aggregates.items():
        if not await _session_exists(db, session_id):
            unmatched.add(session_id)
            continue
        counts["compactions_recorded"] += await _record_compactions(
            db, session_id, agg.compactions
        )
        title, title_source = _derive_title(agg)
        wrote = await _write_claimed_columns(
            db,
            session_id,
            {
                "source_app": agg.source_app,
                "source_detail": agg.source_detail,
                "cli_version": agg.cli_version,
                "title": title,
                "title_source": title_source,
                "git_branch": agg.git_branch,
                "permission_mode": agg.permission_mode,
                "effort": agg.effort,
            },
        )
        await db.execute(_ROLLUP_SQL, (agg.context_peak, agg.last_row_at, session_id))
        if wrote or agg.compactions or agg.context_peak or agg.last_row_at:
            updated.add(session_id)
        # Already inserted; keeping them would re-run eight no-op inserts per
        # cadence commit for the rest of the file.
        agg.compactions = []
    if not carry:
        aggregates.clear()


# ─── The pass ───────────────────────────────────────────────────────────────


def _empty_counts() -> dict[str, int]:
    return {
        "config_dirs": 0,
        "files_seen": 0,
        "files_scanned": 0,
        "files_up_to_date": 0,
        "files_deferred": 0,
        "files_failed": 0,
        "bytes_read": 0,
        "rows_parsed": 0,
        "rows_unparsed": 0,
        "sessions_seen": 0,
        "sessions_updated": 0,
        "sessions_unmatched": 0,
        "compactions_recorded": 0,
    }


async def scan_transcripts(db: aiosqlite.Connection) -> dict[str, int]:
    """Read new transcript bytes from every config directory; return the counts.

    One bounded, resumable pass. It reads at most `SCAN_MAX_FILES_PER_PASS`
    files and `SCAN_MAX_BYTES_PER_PASS` bytes, commits every
    `SCAN_COMMIT_ROWS` rows, and records where each file was left so the next
    call continues rather than repeats. Files with no new bytes cost a `stat()`
    and nothing else; the rest are taken oldest-first, which drains a backlog
    deterministically and cannot starve a file behind a busy one.

    There is deliberately no `?dry_run=1`. The sidecar shares a single SQLite
    connection with live hook ingest, so a speculative write plus `ROLLBACK` is
    unsafe in both directions — an interleaved hook's `commit()` would make our
    writes permanent, and our rollback would discard that hook's uncommitted
    work. A dry run that wrote nothing at all would also be a second code path
    modelling the same rules as the real one, which is the divergence class
    #158 shipped and had to repair.

    Returns per-pass counts. `sessions_unmatched` is the number of distinct
    on-disk session ids with no `agent_sessions` row — they are recorded in
    `transcript_scan_state.session_id` and nothing is minted for them. Known
    limitation, deliberately left to a follow-up: because progress is per file
    and byte offsets advance regardless, a session row that appears *after* its
    transcript was consumed is not retroactively filled; requeueing those files
    needs a `parser_version` bump or a targeted reset.

    `db.in_transaction` is False on return from both the success and the
    raising path: this pass shares its connection with hook ingest, so leaving
    work pending on it would hand those writes to the next hook's `commit()` —
    the hazard `agents._safe_handle` guards on the ingest side.
    """
    counts = _empty_counts()
    unmatched: set[str] = set()
    updated: set[str] = set()
    seen_sessions: set[str] = set()
    aggregates: dict[str, _SessionAggregate] = {}
    rows_since_commit = 0

    try:
        dirs = await config_dirs(db)
        counts["config_dirs"] = len(dirs)
        states = await _load_states(db)
        profiles_by_dir = await _profiles_by_config_dir(db)

        # (mtime_ns, realpath) ordering: oldest unscanned work first, with the
        # path as a tiebreak so two files written in the same nanosecond do not
        # swap places between passes.
        candidates: list[tuple[int, str, Path, Path, int, os.stat_result]] = []
        for config_dir in dirs:
            for path in _discover(config_dir):
                counts["files_seen"] += 1
                try:
                    stat = path.stat()
                except OSError:
                    counts["files_failed"] += 1
                    continue
                start = _resume_offset(states.get(str(path)), stat)
                if start >= stat.st_size:
                    counts["files_up_to_date"] += 1
                    continue
                candidates.append(
                    (stat.st_mtime_ns, str(path), path, config_dir, start, stat)
                )

        candidates.sort(key=lambda item: (item[0], item[1]))
        if len(candidates) > SCAN_MAX_FILES_PER_PASS:
            counts["files_deferred"] = len(candidates) - SCAN_MAX_FILES_PER_PASS
            candidates = candidates[:SCAN_MAX_FILES_PER_PASS]

        for _mtime, realpath, path, config_dir, start, stat in candidates:
            remaining = SCAN_MAX_BYTES_PER_PASS - counts["bytes_read"]
            if remaining <= 0:
                counts["files_deferred"] += 1
                continue

            file_kind = _classify(path)
            state = _FileState(
                realpath=realpath,
                config_dir=str(config_dir),
                file_kind=file_kind,
                dev=stat.st_dev,
                inode=stat.st_ino,
                size_bytes=stat.st_size,
                mtime_ns=stat.st_mtime_ns,
                byte_offset=start,
                rows_parsed=0,
                rows_unparsed=0,
            )
            try:
                rows, offset, parsed, unparsed = _iter_rows(path, start, remaining)
            except OSError as exc:
                # The file vanished or became unreadable between the listing
                # and the open — routine on a tree the CLI is rewriting. Record
                # why and leave the offset where it was, so the next pass
                # retries from the same place instead of skipping bytes.
                counts["files_failed"] += 1
                state.last_error = f"{type(exc).__name__}: {exc}"
                await _upsert_file_state(db, state)
                await db.commit()
                continue

            counts["files_scanned"] += 1
            counts["bytes_read"] += offset - start
            counts["rows_parsed"] += parsed
            counts["rows_unparsed"] += unparsed

            # The profile that owns the config directory this file sits in —
            # answered by the directory we walked to reach it, not by matching
            # its path, because `~/.claude` is a string prefix of
            # `~/.claude-work` and `source_detail` is a field Lane C wins over
            # the hook, so a wrong label there is permanent. `_derive_profile`
            # answers for a directory no profile row claims. "unknown" is
            # dropped rather than stored, so "we could not tell" stays NULL
            # instead of becoming a confident label.
            profile = profiles_by_dir.get(str(config_dir))
            if profile is None:
                profile = await agent_service._derive_profile(db, realpath)

            # How far the *row loop* has got, as opposed to how far the slice
            # reaches. The cadence commit persists these, so that a failure
            # later in the same file leaves an offset naming bytes whose facts
            # are committed — never one that claims rows the loop never reached.
            committed_parsed = 0
            committed_unparsed = 0

            for scanned in rows:
                row = scanned.data
                session_id = _text(row.get("sessionId"))
                if session_id is None:
                    continue
                if state.session_id is None:
                    state.session_id = session_id
                seen_sessions.add(session_id)
                agg = aggregates.get(session_id)
                if agg is None:
                    agg = _SessionAggregate(session_id=session_id)
                    agg.source_detail = None if profile == "unknown" else profile
                    if start > 0:
                        await _seed_carried_fields(db, agg)
                    aggregates[session_id] = agg
                # Belt and braces on the two independent sidechain signals. The
                # row's own `isSidechain` is the general one — it also catches a
                # sidechain row embedded in a main transcript, which the filename
                # cannot — but it is the *file's* classification that survives a
                # row which simply omits the flag. An `agent-<hex>.jsonl` whose
                # rows carry no flag would otherwise fold a sub-agent's turns
                # into the parent's context peak, which is the 76%-overstatement
                # this ticket exists to prevent. Either signal is sufficient.
                _absorb_row(
                    agg,
                    row,
                    scanned.is_sidechain or state.file_kind == FILE_KIND_SIDECHAIN,
                )

                rows_since_commit += 1
                if rows_since_commit >= SCAN_COMMIT_ROWS:
                    state.byte_offset = scanned.end_offset
                    state.rows_parsed = scanned.parsed - committed_parsed
                    state.rows_unparsed = scanned.unparsed - committed_unparsed
                    committed_parsed = scanned.parsed
                    committed_unparsed = scanned.unparsed
                    await _flush(db, aggregates, counts, unmatched, updated, carry=True)
                    await _upsert_file_state(db, state)
                    await db.commit()
                    rows_since_commit = 0

            state.byte_offset = offset
            state.rows_parsed = parsed - committed_parsed
            state.rows_unparsed = unparsed - committed_unparsed
            await _flush(db, aggregates, counts, unmatched, updated, carry=False)
            await _upsert_file_state(db, state)
            await db.commit()
            rows_since_commit = 0

        if db.in_transaction:
            await db.commit()
    except Exception:
        # Same discipline as `session_backfill_service`: one shared connection
        # means pending work would otherwise be committed by whichever hook
        # fires next, under counts nobody ever saw.
        try:
            await db.rollback()
        except Exception:
            logger.exception("transcript scan: rollback failed")
        else:
            # Only assert on the path where the rollback actually succeeded. If
            # it did not, the connection genuinely may still be in a
            # transaction, and asserting here would raise AssertionError *over*
            # the original exception — hiding the real failure behind a
            # bookkeeping one. The `raise` below re-raises the original either
            # way, which is what the caller needs to see.
            assert db.in_transaction is False
        raise

    counts["sessions_seen"] = len(seen_sessions)
    counts["sessions_updated"] = len(updated)
    counts["sessions_unmatched"] = len(unmatched)
    logger.info(
        "transcript scan: config_dirs=%d, files_seen=%d, files_scanned=%d, "
        "bytes_read=%d, rows_parsed=%d, rows_unparsed=%d, sessions_seen=%d, "
        "sessions_updated=%d, sessions_unmatched=%d, compactions_recorded=%d",
        counts["config_dirs"],
        counts["files_seen"],
        counts["files_scanned"],
        counts["bytes_read"],
        counts["rows_parsed"],
        counts["rows_unparsed"],
        counts["sessions_seen"],
        counts["sessions_updated"],
        counts["sessions_unmatched"],
        counts["compactions_recorded"],
    )
    assert db.in_transaction is False
    return counts
