"""Tests for `migrations/014_transcript_scan_state.sql` and
`app/services/transcript_scanner_service.py` (epic #153 / #163).

The five traps this ticket was written around are each measured facts about
this machine's data, so each one gets a test that reproduces the *shape* that
caused it rather than a test that restates the rule:

1. two config directories, only one of which holds the session;
2. an `agent-<hex>.jsonl` sidechain file whose rows carry the parent's
   `sessionId` — it must neither mint a session nor inflate the context peak;
3. a transcript whose peak turn is bigger than its last turn;
4. a resumed session replaying its parent's compaction row verbatim;
5. a transcript for a session id that has no `agent_sessions` row.
"""

from __future__ import annotations

import inspect
import json
import pathlib

import aiosqlite
import pytest

from app.routers import agents
from app.services import agent_service
from app.services import lane_reconciler_service as lrs
from app.services import transcript_scanner_service as tss

SERVICE_SRC = (
    pathlib.Path(__file__).parents[2]
    / "app"
    / "services"
    / "transcript_scanner_service.py"
).read_text()


# ─── fixtures / helpers ─────────────────────────────────────────────────────


def _row(**fields) -> dict:
    """A transcript row with the fields every real one carries."""
    base = {
        "isSidechain": False,
        "userType": "external",
        "entrypoint": "cli",
        "version": "2.1.251",
        "cwd": "/w/acme",
        "gitBranch": "main",
        "timestamp": "2026-09-01T10:00:00.000Z",
    }
    base.update(fields)
    return base


def _assistant(session_id: str, occupancy: int, **fields) -> dict:
    """An assistant turn whose usage sums to `occupancy`."""
    return _row(
        type="assistant",
        sessionId=session_id,
        uuid=f"u-{session_id}-{occupancy}",
        message={
            "role": "assistant",
            "model": "claude-opus-5",
            "usage": {
                "input_tokens": occupancy,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "output_tokens": 12,
            },
        },
        **fields,
    )


def _compaction(session_id: str, row_uuid: str, **fields) -> dict:
    return _row(
        type="system",
        subtype="compact_boundary",
        sessionId=session_id,
        uuid=row_uuid,
        content="Conversation compacted",
        compactMetadata={
            "trigger": "auto",
            "preTokens": 994897,
            "postTokens": 54529,
            "cumulativeDroppedTokens": 940368,
            "durationMs": 166044,
        },
        **fields,
    )


def _write(path: pathlib.Path, rows: list[dict]) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def _append(path: pathlib.Path, row: dict) -> None:
    """Add one row the way the CLI does — the file grows, nothing else moves."""
    path.write_text(
        path.read_text(encoding="utf-8") + json.dumps(row) + "\n", encoding="utf-8"
    )


def _config_dir(root: pathlib.Path, name: str, project: str = "-w-acme"):
    """`<root>/<name>/projects/<project>/`, the real on-disk layout."""
    directory = root / name / "projects" / project
    directory.mkdir(parents=True, exist_ok=True)
    return directory


async def _add_profile(db: aiosqlite.Connection, name: str, config_dir) -> None:
    await db.execute(
        "INSERT INTO profiles (name, claude_config_dir) VALUES (?, ?)",
        (name, str(config_dir)),
    )
    await db.commit()


async def _add_session(db: aiosqlite.Connection, session_id: str) -> None:
    await db.execute(
        """INSERT INTO agent_sessions (session_id, profile, cwd, status)
           VALUES (?, 'unknown', '/w/acme', 'ended')""",
        (session_id,),
    )
    await db.commit()


async def _session(db: aiosqlite.Connection, session_id: str) -> aiosqlite.Row:
    cur = await db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    return await cur.fetchone()


@pytest.fixture(autouse=True)
def _no_ambient_config_dir(monkeypatch):
    """Keep the developer's real `$CLAUDE_CONFIG_DIR` out of every test.

    The pass reads it by design, so leaving it set would have these tests walk
    the machine's actual transcript tree — slow, and the assertions would
    depend on whoever ran them. The one test that cares sets it itself.
    """
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)


# ─── migration shape ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_migration_creates_transcript_scan_state_with_every_column(
    migrated_db,
):
    cur = await migrated_db.execute("PRAGMA table_info(transcript_scan_state)")
    cols = {r["name"]: r for r in await cur.fetchall()}
    assert set(cols) == {
        "realpath",
        "config_dir",
        "session_id",
        "file_kind",
        "dev",
        "inode",
        "size_bytes",
        "mtime_ns",
        "byte_offset",
        "rows_parsed",
        "rows_unparsed",
        "parser_version",
        "last_scanned_at",
        "last_error",
    }
    assert [c["name"] for c in cols.values() if c["pk"]] == ["realpath"]


@pytest.mark.asyncio
async def test_transcript_scan_state_has_no_foreign_key(migrated_db):
    """23 on-disk session ids have no session row; an FK would forbid them."""
    cur = await migrated_db.execute("PRAGMA foreign_key_list(transcript_scan_state)")
    assert await cur.fetchall() == []


@pytest.mark.asyncio
async def test_migration_creates_the_compactions_table_keyed_on_the_pair(
    migrated_db,
):
    cur = await migrated_db.execute("PRAGMA table_info(agent_session_compactions)")
    cols = {r["name"]: r for r in await cur.fetchall()}
    assert {
        "session_id",
        "row_uuid",
        "trigger",
        "pre_tokens",
        "post_tokens",
        "cumulative_dropped_tokens",
        "duration_ms",
        "occurred_at",
    } <= set(cols)
    assert sorted(c["name"] for c in cols.values() if c["pk"]) == [
        "row_uuid",
        "session_id",
    ]


@pytest.mark.asyncio
async def test_migration_adds_the_three_rollup_columns(migrated_db):
    cur = await migrated_db.execute("PRAGMA table_info(agent_sessions)")
    cols = {r["name"] for r in await cur.fetchall()}
    assert {
        "context_peak_tokens",
        "compaction_count",
        "transcript_last_row_at",
    } <= cols


@pytest.mark.asyncio
async def test_migration_ships_both_tables_empty(migrated_db):
    for table in ("transcript_scan_state", "agent_session_compactions"):
        cur = await migrated_db.execute(f"SELECT COUNT(*) AS n FROM {table}")
        assert (await cur.fetchone())["n"] == 0


# ─── budgets and constants ──────────────────────────────────────────────────


def test_budget_constants_have_the_named_values():
    assert tss.SCAN_COMMIT_ROWS == 500
    assert tss.SCAN_MAX_FILES_PER_PASS == 25
    assert tss.SCAN_MAX_BYTES_PER_PASS == 32 * 1024 * 1024


# ─── trap 1: every config directory, not one hardcoded path ─────────────────


@pytest.mark.asyncio
async def test_scan_walks_every_profile_config_dir(migrated_db, tmp_path):
    """`~/.claude` joins 0 of 130 sessions here; the second directory joins 62."""
    empty = _config_dir(tmp_path, "claude")
    populated = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "personal", empty.parents[1])
    await _add_profile(migrated_db, "work", populated.parents[1])
    await _add_session(migrated_db, "s-work")
    _write(
        populated / "s-work.jsonl",
        [_assistant("s-work", 100, entrypoint="claude-desktop", version="2.1.260")],
    )

    counts = await tss.scan_transcripts(migrated_db)

    assert counts["config_dirs"] == 2
    row = await _session(migrated_db, "s-work")
    assert row["source_app"] == "claude-desktop"
    assert row["cli_version"] == "2.1.260"


@pytest.mark.asyncio
async def test_scan_walks_the_env_config_dir_too(migrated_db, tmp_path, monkeypatch):
    """No profile row at all — `$CLAUDE_CONFIG_DIR` alone must be enough."""
    directory = _config_dir(tmp_path, "claude-env")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(directory.parents[1]))
    await _add_session(migrated_db, "s-env")
    _write(directory / "s-env.jsonl", [_assistant("s-env", 10, entrypoint="sdk-cli")])

    counts = await tss.scan_transcripts(migrated_db)

    assert counts["config_dirs"] == 1
    assert (await _session(migrated_db, "s-env"))["source_app"] == "sdk-cli"


@pytest.mark.asyncio
async def test_source_detail_reuses_the_one_profile_matcher(migrated_db, tmp_path):
    """`source_detail` is `agent_service._derive_profile`, not a second matcher."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(directory / "s-1.jsonl", [_assistant("s-1", 10)])

    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-1"))["source_detail"] == "work"
    assert "_derive_profile" in SERVICE_SRC


# ─── trap 2: sidechain files ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sidechain_file_is_keyed_on_the_in_row_session_id(migrated_db, tmp_path):
    """239 of 335 files are `agent-<hex>.jsonl`; none is a session's transcript."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "parent-1")
    _write(
        directory / "subagents" / "agent-a0dc90c31972abeea.jsonl",
        [
            _assistant(
                "parent-1", 500, isSidechain=True, entrypoint="cli", version="2.1.228"
            )
        ],
    )

    counts = await tss.scan_transcripts(migrated_db)

    # No phantom session: the only row is still the parent's.
    cur = await migrated_db.execute("SELECT COUNT(*) AS n FROM agent_sessions")
    assert (await cur.fetchone())["n"] == 1
    assert counts["sessions_unmatched"] == 0
    # The file is recorded against the parent, under its own kind.
    cur = await migrated_db.execute(
        "SELECT session_id, file_kind FROM transcript_scan_state"
    )
    state = await cur.fetchone()
    assert state["session_id"] == "parent-1"
    assert state["file_kind"] == tss.FILE_KIND_SIDECHAIN


@pytest.mark.asyncio
async def test_sidechain_turns_are_excluded_from_the_context_peak(
    migrated_db, tmp_path
):
    """Folding a subagent's window into the parent overstates it by up to 76%."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "parent-1")
    _write(directory / "parent-1.jsonl", [_assistant("parent-1", 1000)])
    _write(
        directory / "subagents" / "agent-deadbeef.jsonl",
        [_assistant("parent-1", 900_000, isSidechain=True)],
    )

    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "parent-1"))["context_peak_tokens"] == 1000


@pytest.mark.asyncio
async def test_a_sidechain_row_inside_a_main_transcript_is_excluded_too(
    migrated_db, tmp_path
):
    """The flag is per row, not per filename — main transcripts carry both."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-mixed")
    _write(
        directory / "s-mixed.jsonl",
        [
            _assistant("s-mixed", 7000),
            _assistant("s-mixed", 800_000, isSidechain=True),
        ],
    )

    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-mixed"))["context_peak_tokens"] == 7000


# ─── trap 3: the peak, not the last turn ────────────────────────────────────


@pytest.mark.asyncio
async def test_context_peak_is_the_maximum_not_the_last_turn(migrated_db, tmp_path):
    """`context_tokens` is overwritten on every Stop; 49 of 62 peaks are higher."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-peak")
    _write(
        directory / "s-peak.jsonl",
        [
            _assistant("s-peak", 10_000),
            _assistant("s-peak", 990_000),
            _assistant("s-peak", 22_000),
        ],
    )

    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-peak"))["context_peak_tokens"] == 990_000


@pytest.mark.asyncio
async def test_context_peak_survives_a_later_smaller_pass(migrated_db, tmp_path):
    """Incremental slices compose: a second pass must not lower the peak."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-peak")
    path = directory / "s-peak.jsonl"
    _write(path, [_assistant("s-peak", 990_000)])
    await tss.scan_transcripts(migrated_db)

    _append(path, _assistant("s-peak", 5))
    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-peak"))["context_peak_tokens"] == 990_000


# ─── trap 4: compactions and replayed rows ──────────────────────────────────


@pytest.mark.asyncio
async def test_compaction_row_is_stored_with_its_metadata(migrated_db, tmp_path):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-c")
    _write(directory / "s-c.jsonl", [_compaction("s-c", "boundary-1")])

    counts = await tss.scan_transcripts(migrated_db)

    assert counts["compactions_recorded"] == 1
    cur = await migrated_db.execute("SELECT * FROM agent_session_compactions")
    row = await cur.fetchone()
    assert row["trigger"] == "auto"
    assert row["pre_tokens"] == 994897
    assert row["post_tokens"] == 54529
    assert row["cumulative_dropped_tokens"] == 940368
    assert row["duration_ms"] == 166044
    assert (await _session(migrated_db, "s-c"))["compaction_count"] == 1


@pytest.mark.asyncio
async def test_a_resumed_session_keeps_both_copies_of_a_replayed_compaction(
    migrated_db, tmp_path
):
    """Same `row_uuid`, two session ids — both histories are real."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-parent")
    await _add_session(migrated_db, "s-resumed")
    _write(directory / "s-parent.jsonl", [_compaction("s-parent", "boundary-1")])
    # The resumed transcript replays the parent's rows verbatim under its own id.
    _write(directory / "s-resumed.jsonl", [_compaction("s-resumed", "boundary-1")])

    await tss.scan_transcripts(migrated_db)

    cur = await migrated_db.execute(
        "SELECT session_id FROM agent_session_compactions ORDER BY session_id"
    )
    assert [r["session_id"] for r in await cur.fetchall()] == [
        "s-parent",
        "s-resumed",
    ]
    assert (await _session(migrated_db, "s-parent"))["compaction_count"] == 1
    assert (await _session(migrated_db, "s-resumed"))["compaction_count"] == 1


@pytest.mark.asyncio
async def test_rescanning_the_same_bytes_neither_duplicates_nor_deletes(
    migrated_db, tmp_path
):
    """A forced re-read of a file already scanned must be a no-op."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-c")
    _write(directory / "s-c.jsonl", [_compaction("s-c", "boundary-1")])
    await tss.scan_transcripts(migrated_db)

    # Rewind the recorded progress: the same bytes are read a second time.
    await migrated_db.execute("UPDATE transcript_scan_state SET byte_offset = 0")
    await migrated_db.commit()
    counts = await tss.scan_transcripts(migrated_db)

    assert counts["compactions_recorded"] == 0
    cur = await migrated_db.execute(
        "SELECT COUNT(*) AS n FROM agent_session_compactions"
    )
    assert (await cur.fetchone())["n"] == 1
    assert (await _session(migrated_db, "s-c"))["compaction_count"] == 1


# ─── trap 5: files, not the table ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_unjoined_session_id_is_recorded_and_counted_not_minted(
    migrated_db, tmp_path
):
    """23 on-disk ids have no session row; Lane C does not mint one (decision 3)."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    _write(directory / "orphan.jsonl", [_assistant("s-orphan", 42)])

    counts = await tss.scan_transcripts(migrated_db)

    assert counts["sessions_unmatched"] == 1
    assert counts["sessions_updated"] == 0
    cur = await migrated_db.execute("SELECT COUNT(*) AS n FROM agent_sessions")
    assert (await cur.fetchone())["n"] == 0
    cur = await migrated_db.execute("SELECT session_id FROM transcript_scan_state")
    assert (await cur.fetchone())["session_id"] == "s-orphan"


@pytest.mark.asyncio
async def test_a_session_whose_transcript_path_is_gone_is_still_scanned(
    migrated_db, tmp_path
):
    """68 of 130 stored paths no longer exist; the pass is driven by files."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-moved")
    await migrated_db.execute(
        "UPDATE agent_sessions SET transcript_path = '/gone/nowhere.jsonl'"
    )
    await migrated_db.commit()
    _write(directory / "elsewhere.jsonl", [_assistant("s-moved", 33)])

    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-moved"))["context_peak_tokens"] == 33


# ─── titles are derived, never read ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_title_prefers_a_custom_title_over_an_ai_one(migrated_db, tmp_path):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-t")
    _write(
        directory / "s-t.jsonl",
        [
            _row(type="ai-title", sessionId="s-t", aiTitle="Model guess"),
            _row(type="custom-title", sessionId="s-t", customTitle="Epic #153 P0"),
        ],
    )

    await tss.scan_transcripts(migrated_db)

    row = await _session(migrated_db, "s-t")
    assert row["title"] == "Epic #153 P0"
    assert row["title_source"] == "custom"


@pytest.mark.asyncio
async def test_title_falls_back_to_the_ai_title_then_the_last_prompt(
    migrated_db, tmp_path
):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-ai")
    await _add_session(migrated_db, "s-p")
    _write(
        directory / "s-ai.jsonl",
        [
            _row(type="last-prompt", sessionId="s-ai", lastPrompt="do the thing"),
            _row(type="ai-title", sessionId="s-ai", aiTitle="Do the thing"),
        ],
    )
    _write(
        directory / "s-p.jsonl",
        [_row(type="last-prompt", sessionId="s-p", lastPrompt="only a prompt")],
    )

    await tss.scan_transcripts(migrated_db)

    ai = await _session(migrated_db, "s-ai")
    assert (ai["title"], ai["title_source"]) == ("Do the thing", "ai")
    prompt = await _session(migrated_db, "s-p")
    assert (prompt["title"], prompt["title_source"]) == ("only a prompt", "prompt")


def test_title_source_is_never_read_from_a_transcript_field():
    """`titleSource` appears 0 times in 113,708 rows — reading it fills nothing.

    Asserted on the quoted forms, so the prose explaining *why* the field is
    not read does not itself look like a read.
    """
    assert '"titleSource"' not in SERVICE_SRC
    assert "'titleSource'" not in SERVICE_SRC
    assert all(key != "titleSource" for _kind, key, _source in tss._TITLE_ROWS)


# ─── lane discipline ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provenance_writes_are_recorded_as_lane_c_claims(migrated_db, tmp_path):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(
        directory / "s-1.jsonl",
        [
            _assistant(
                "s-1", 10, effort="xhigh", permissionMode="auto", gitBranch="feat/x"
            ),
            _row(type="ai-title", sessionId="s-1", aiTitle="A title"),
        ],
    )

    await tss.scan_transcripts(migrated_db)

    claims = await lrs.read(migrated_db, "s-1")
    assert {
        "source_app",
        "source_detail",
        "cli_version",
        "title",
        "title_source",
        "git_branch",
        "permission_mode",
        "effort",
    } <= set(claims)
    assert {c["lane"] for c in claims.values()} == {lrs.LANE_TRANSCRIPT}


@pytest.mark.asyncio
async def test_a_hook_claim_on_a_live_switch_beats_the_transcript(
    migrated_db, tmp_path
):
    """`permission_mode` and `effort` are A > C — a hook saw the switch happen."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    await lrs.apply(migrated_db, "s-1", lrs.LANE_HOOK, "permission_mode", "plan")
    await migrated_db.execute(
        "UPDATE agent_sessions SET permission_mode = 'plan' WHERE session_id = 's-1'"
    )
    await migrated_db.commit()
    _write(directory / "s-1.jsonl", [_assistant("s-1", 10, permissionMode="auto")])

    await tss.scan_transcripts(migrated_db)

    row = await _session(migrated_db, "s-1")
    assert row["permission_mode"] == "plan"
    # ... but the uncontested provenance the hook cannot supply still lands.
    assert row["source_app"] == "cli"


def test_every_claimed_column_is_registered_to_lane_c():
    for column in tss._CLAIMED_COLUMNS:
        assert lrs.is_registered(column)
        assert lrs.LANE_TRANSCRIPT in lrs.FIELD_LANES[column]


def test_direct_agent_sessions_updates_touch_only_the_three_rollups():
    """The grep the acceptance criteria name, as a test.

    The one statement that assigns `agent_sessions` columns without asking the
    reconciler is `_ROLLUP_SQL`, and it may name only the three uncontested
    columns migration 014 adds. Every other column write goes through
    `_write_claimed_columns`, whose column names come from `_CLAIMED_COLUMNS`
    and which writes nothing until `lane_reconciler_service.apply` grants the
    claim.
    """
    rollups = {"context_peak_tokens", "compaction_count", "transcript_last_row_at"}
    for column in tss._CLAIMED_COLUMNS:
        assert column not in tss._ROLLUP_SQL
    assert rollups <= set(tss._ROLLUP_SQL.split())  # each appears as a bare token
    # Exactly two places build an `UPDATE agent_sessions` statement.
    assert SERVICE_SRC.count("UPDATE agent_sessions") == 2
    assert (
        'f"UPDATE agent_sessions SET {column} = ? WHERE session_id = ?"' in SERVICE_SRC
    )


def test_precedence_is_not_re_derived_here():
    assert "LANE_RANK" not in SERVICE_SRC
    assert "CASE WHEN lane" not in SERVICE_SRC


def test_there_is_no_dry_run_parameter():
    """Asserted on the signatures, which is where a parameter would have to be.

    The service and the endpoint both *explain* the absence in prose, so a
    substring test over the source would fail on its own documentation.
    """
    assert "dry_run" not in inspect.signature(tss.scan_transcripts).parameters
    assert inspect.signature(agents.api_scan_transcripts).parameters == {}


def test_the_honest_coverage_target_is_stated():
    target = ">45% of all sessions, >95% of sessions whose transcript still exists"
    assert target in SERVICE_SRC
    assert target in inspect.getdoc(agents.api_scan_transcripts).replace("\n", " ")


# ─── incrementality, budgets and transaction hygiene ────────────────────────


@pytest.mark.asyncio
async def test_a_second_pass_reads_no_bytes(migrated_db, tmp_path):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(directory / "s-1.jsonl", [_assistant("s-1", 10)])

    first = await tss.scan_transcripts(migrated_db)
    second = await tss.scan_transcripts(migrated_db)

    assert first["files_scanned"] == 1 and first["bytes_read"] > 0
    assert second["files_scanned"] == 0 and second["bytes_read"] == 0
    assert second["files_up_to_date"] == 1


@pytest.mark.asyncio
async def test_appended_bytes_are_read_from_the_recorded_offset(migrated_db, tmp_path):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    path = _write(directory / "s-1.jsonl", [_assistant("s-1", 10)])
    first = await tss.scan_transcripts(migrated_db)

    _append(path, _compaction("s-1", "boundary-2"))
    second = await tss.scan_transcripts(migrated_db)

    assert second["rows_parsed"] == 1
    assert second["bytes_read"] < first["bytes_read"] + second["bytes_read"]
    assert (await _session(migrated_db, "s-1"))["compaction_count"] == 1


@pytest.mark.asyncio
async def test_a_partial_trailing_line_is_left_for_the_next_pass(migrated_db, tmp_path):
    """Transcripts are appended to while we read them; half a turn is normal."""
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    path = directory / "s-1.jsonl"
    complete = json.dumps(_assistant("s-1", 10)) + "\n"
    fragment = json.dumps(_assistant("s-1", 999_999))[:40]
    path.write_text(complete + fragment, encoding="utf-8")

    first = await tss.scan_transcripts(migrated_db)
    assert first["rows_parsed"] == 1
    assert first["rows_unparsed"] == 0
    assert (await _session(migrated_db, "s-1"))["context_peak_tokens"] == 10

    # Finish the line; the next pass reads it whole rather than discarding it.
    path.write_text(complete + json.dumps(_assistant("s-1", 999_999)) + "\n", "utf-8")
    second = await tss.scan_transcripts(migrated_db)
    assert second["rows_parsed"] == 1
    assert (await _session(migrated_db, "s-1"))["context_peak_tokens"] == 999_999


@pytest.mark.asyncio
async def test_a_truncated_file_is_re_read_from_zero(migrated_db, tmp_path):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    path = _write(
        directory / "s-1.jsonl", [_assistant("s-1", 10), _assistant("s-1", 20)]
    )
    await tss.scan_transcripts(migrated_db)

    _write(path, [_assistant("s-1", 30)])
    counts = await tss.scan_transcripts(migrated_db)

    assert counts["rows_parsed"] == 1
    cur = await migrated_db.execute("SELECT byte_offset FROM transcript_scan_state")
    assert (await cur.fetchone())["byte_offset"] == path.stat().st_size


@pytest.mark.asyncio
async def test_a_parser_version_bump_re_reads_history(
    migrated_db, tmp_path, monkeypatch
):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(directory / "s-1.jsonl", [_assistant("s-1", 10)])
    await tss.scan_transcripts(migrated_db)

    monkeypatch.setattr(tss, "PARSER_VERSION", tss.PARSER_VERSION + 1)
    counts = await tss.scan_transcripts(migrated_db)

    assert counts["rows_parsed"] == 1


@pytest.mark.asyncio
async def test_a_malformed_line_is_counted_and_the_file_continues(
    migrated_db, tmp_path
):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    path = directory / "s-1.jsonl"
    path.write_text(
        "{not json at all\n" + json.dumps(_assistant("s-1", 55)) + "\n",
        encoding="utf-8",
    )

    counts = await tss.scan_transcripts(migrated_db)

    assert counts["rows_unparsed"] == 1
    assert counts["rows_parsed"] == 1
    assert (await _session(migrated_db, "s-1"))["context_peak_tokens"] == 55


@pytest.mark.asyncio
async def test_the_file_budget_defers_the_rest_of_the_backlog(
    migrated_db, tmp_path, monkeypatch
):
    monkeypatch.setattr(tss, "SCAN_MAX_FILES_PER_PASS", 2)
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    for i in range(5):
        await _add_session(migrated_db, f"s-{i}")
        _write(directory / f"s-{i}.jsonl", [_assistant(f"s-{i}", 10)])

    counts = await tss.scan_transcripts(migrated_db)

    assert counts["files_seen"] == 5
    assert counts["files_scanned"] == 2
    assert counts["files_deferred"] == 3


@pytest.mark.asyncio
async def test_the_byte_budget_stops_mid_file_and_resumes(
    migrated_db, tmp_path, monkeypatch
):
    monkeypatch.setattr(tss, "SCAN_MAX_BYTES_PER_PASS", 1)
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(directory / "s-1.jsonl", [_assistant("s-1", 10), _assistant("s-1", 900_000)])

    first = await tss.scan_transcripts(migrated_db)
    assert first["rows_parsed"] == 1
    assert (await _session(migrated_db, "s-1"))["context_peak_tokens"] == 10

    monkeypatch.setattr(tss, "SCAN_MAX_BYTES_PER_PASS", 32 * 1024 * 1024)
    second = await tss.scan_transcripts(migrated_db)
    assert second["rows_parsed"] == 1
    assert (await _session(migrated_db, "s-1"))["context_peak_tokens"] == 900_000


@pytest.mark.asyncio
async def test_the_commit_cadence_persists_work_before_the_pass_ends(
    migrated_db, tmp_path, monkeypatch
):
    """`SCAN_COMMIT_ROWS` is a real cadence, not a decorative constant."""
    monkeypatch.setattr(tss, "SCAN_COMMIT_ROWS", 1)
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(
        directory / "s-1.jsonl",
        [_compaction("s-1", "b-1"), _compaction("s-1", "b-2")],
    )

    counts = await tss.scan_transcripts(migrated_db)

    assert counts["compactions_recorded"] == 2
    assert (await _session(migrated_db, "s-1"))["compaction_count"] == 2


@pytest.mark.asyncio
async def test_returns_with_no_open_transaction(migrated_db, tmp_path):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(directory / "s-1.jsonl", [_assistant("s-1", 10)])

    await tss.scan_transcripts(migrated_db)

    assert migrated_db.in_transaction is False


@pytest.mark.asyncio
async def test_a_raising_pass_rolls_back_and_leaves_no_open_transaction(
    migrated_db, tmp_path, monkeypatch
):
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(directory / "s-1.jsonl", [_assistant("s-1", 10)])

    async def boom(*_args, **_kwargs):
        raise RuntimeError("disk went away")

    monkeypatch.setattr(tss, "_upsert_file_state", boom)

    with pytest.raises(RuntimeError):
        await tss.scan_transcripts(migrated_db)

    assert migrated_db.in_transaction is False
    # Nothing from the aborted pass survived.
    cur = await migrated_db.execute("SELECT COUNT(*) AS n FROM transcript_scan_state")
    assert (await cur.fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_an_empty_machine_scans_nothing_and_writes_nothing(migrated_db):
    counts = await tss.scan_transcripts(migrated_db)

    assert counts["config_dirs"] == 0
    assert counts["files_seen"] == 0
    assert counts["sessions_seen"] == 0
    assert migrated_db.in_transaction is False


# ─── the three defects the first review found ───────────────────────────────


def test_a_config_dir_matches_only_on_a_path_boundary():
    """`~/.claude` is a string prefix of `~/.claude-work` — and not its parent.

    The unanchored `in` test this replaced gave every `~/.claude-work` session
    to whichever of the pair was created first, and `source_detail` is a Lane C
    field the hook cannot correct afterwards.
    """
    work = "/tmp/x/.claude-work/projects/p/w1.jsonl"
    assert agent_service._config_dir_matches("/tmp/x/.claude-work", work) is True
    assert agent_service._config_dir_matches("/tmp/x/.claude", work) is False
    assert agent_service._config_dir_matches("/tmp/x/.claude-work/", work) is True
    assert (
        agent_service._config_dir_matches(
            "/tmp/x/.claude", "/tmp/x/.claude/projects/p/w1.jsonl"
        )
        is True
    )
    assert agent_service._config_dir_matches("", work) is False
    assert agent_service._config_dir_matches(None, work) is False


@pytest.mark.asyncio
async def test_source_detail_names_the_profile_whose_directory_holds_the_file(
    migrated_db, tmp_path
):
    """The `~/.claude` + `~/.claude-work` pair this ticket exists for.

    `personal` is created first, so a creation-ordered substring scan hands it
    every session that actually lives under `work`'s directory.
    """
    personal = _config_dir(tmp_path, "claude")
    work = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "personal", personal.parents[1])
    await _add_profile(migrated_db, "work", work.parents[1])
    await _add_session(migrated_db, "s-work")
    await _add_session(migrated_db, "s-personal")
    _write(work / "w1.jsonl", [_assistant("s-work", 10)])
    _write(personal / "p1.jsonl", [_assistant("s-personal", 10)])

    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-work"))["source_detail"] == "work"
    assert (await _session(migrated_db, "s-personal"))["source_detail"] == "personal"


@pytest.mark.asyncio
async def test_a_mid_file_failure_never_commits_an_offset_ahead_of_the_rows(
    migrated_db, tmp_path, monkeypatch
):
    """The cadence offset must name the last row absorbed, not the slice end.

    Committing the end of the slice before the loop has walked it means a
    failure later in the same file leaves an offset claiming bytes whose facts
    were never written — and because the next pass resumes from it, those rows
    are gone permanently rather than merely deferred.
    """
    monkeypatch.setattr(tss, "SCAN_COMMIT_ROWS", 2)
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(
        directory / "s-1.jsonl",
        [_assistant("s-1", n * 1000) for n in range(1, 7)],
    )

    real_flush = tss._flush
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk went away")
        await real_flush(*args, **kwargs)

    monkeypatch.setattr(tss, "_flush", flaky)
    with pytest.raises(RuntimeError):
        await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-1"))["context_peak_tokens"] == 2000

    monkeypatch.setattr(tss, "_flush", real_flush)
    recovered = await tss.scan_transcripts(migrated_db)

    assert recovered["rows_parsed"] == 4
    assert recovered["bytes_read"] > 0
    assert (await _session(migrated_db, "s-1"))["context_peak_tokens"] == 6000
    cur = await migrated_db.execute(
        "SELECT rows_parsed, byte_offset, size_bytes FROM transcript_scan_state"
    )
    state = await cur.fetchone()
    assert state["rows_parsed"] == 6
    assert state["byte_offset"] == state["size_bytes"]


@pytest.mark.asyncio
async def test_git_branch_stays_the_starting_branch_across_the_commit_cadence(
    migrated_db, tmp_path, monkeypatch
):
    """First-wins has to survive the flush that clears the aggregate.

    `agent_service` declines the hook's own `git_branch` because Lane C "reads
    the branch the run actually started on"; a chunk boundary that re-derived
    it from mid-session rows would write a wrong value *and* block the hook
    from correcting it.
    """
    monkeypatch.setattr(tss, "SCAN_COMMIT_ROWS", 2)
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(
        directory / "s-1.jsonl",
        [_assistant("s-1", n, gitBranch="main") for n in (1, 2, 3)]
        + [_assistant("s-1", n, gitBranch="feature/switched") for n in (4, 5, 6)],
    )

    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-1"))["git_branch"] == "main"


@pytest.mark.asyncio
async def test_git_branch_survives_a_pass_boundary_that_fell_mid_file(
    migrated_db, tmp_path, monkeypatch
):
    """Same rule across two passes: the second one re-reads Lane C's answer."""
    monkeypatch.setattr(tss, "SCAN_MAX_BYTES_PER_PASS", 1)
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    _write(
        directory / "s-1.jsonl",
        [
            _row(type="custom-title", sessionId="s-1", customTitle="Epic #153 P0"),
            _assistant("s-1", 10, gitBranch="feature/switched"),
            _row(type="last-prompt", sessionId="s-1", lastPrompt="a later prompt"),
        ],
    )

    await tss.scan_transcripts(migrated_db)
    await tss.scan_transcripts(migrated_db)
    await tss.scan_transcripts(migrated_db)

    row = await _session(migrated_db, "s-1")
    assert row["git_branch"] == "main"
    assert (row["title"], row["title_source"]) == ("Epic #153 P0", "custom")


@pytest.mark.asyncio
async def test_a_full_re_read_still_repairs_a_first_wins_field(migrated_db, tmp_path):
    """Carrying the old answer must not outlive the bytes it came from.

    A rewritten (or `PARSER_VERSION`-bumped) file is read from zero, and that
    re-read is how history gets repaired — so nothing may be seeded into it.
    """
    directory = _config_dir(tmp_path, "claude-work")
    await _add_profile(migrated_db, "work", directory.parents[1])
    await _add_session(migrated_db, "s-1")
    path = _write(
        directory / "s-1.jsonl",
        [_assistant("s-1", 10, gitBranch="main"), _assistant("s-1", 20)],
    )
    await tss.scan_transcripts(migrated_db)
    assert (await _session(migrated_db, "s-1"))["git_branch"] == "main"

    # Shorter than what we recorded, so the resume guard re-reads from zero.
    _write(path, [_assistant("s-1", 5, gitBranch="release/0.2.0")])
    await tss.scan_transcripts(migrated_db)

    assert (await _session(migrated_db, "s-1"))["git_branch"] == "release/0.2.0"
