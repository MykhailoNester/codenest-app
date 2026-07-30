"""Tests for agent_service.record_stop's context_tokens persistence.

Coverage:
1. record_stop sums the transcript's last-turn usage into context_tokens.
2. A missing/unreadable transcript leaves a previously-set context_tokens
   alone (the COALESCE guard) rather than zeroing it.
3. Regression net: the (defective, deliberately untouched) Sonnet-4 cost
   arithmetic still produces the same result. Anyone "fixing" that pricing
   bug in this file's neighbourhood should see this test fail and know to
   look elsewhere — the fix belongs in its own P1 branch.
"""

from __future__ import annotations

import json
import uuid

import aiosqlite
import pytest

from app.services import agent_service


def _gen_uuid() -> str:
    return str(uuid.uuid4())


async def _get_session(
    db: aiosqlite.Connection, session_id: str
) -> aiosqlite.Row | None:
    row = await db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    return await row.fetchone()


@pytest.mark.asyncio
async def test_record_stop_persists_context_tokens(
    migrated_db: aiosqlite.Connection, tmp_path
):
    session_id = _gen_uuid()
    transcript = tmp_path / "transcript.jsonl"
    usage = {
        "input_tokens": 1000,
        "cache_creation_input_tokens": 200,
        "cache_read_input_tokens": 300,
        "output_tokens": 500,
    }
    transcript.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {"model": "claude-opus-4-5", "usage": usage},
            }
        )
        + "\n"
    )

    await agent_service.record_stop(
        migrated_db,
        {"session_id": session_id, "transcript_path": str(transcript)},
    )

    row = await _get_session(migrated_db, session_id)
    assert row is not None
    assert row["context_tokens"] == 1000 + 200 + 300 + 500


@pytest.mark.asyncio
async def test_record_stop_missing_transcript_preserves_context_tokens(
    migrated_db: aiosqlite.Connection, tmp_path
):
    session_id = _gen_uuid()
    # First Stop: a real transcript sets context_tokens to a known value.
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "model": "claude-opus-4-5",
                    "usage": {
                        "input_tokens": 100,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0,
                        "output_tokens": 45,
                    },
                },
            }
        )
        + "\n"
    )
    await agent_service.record_stop(
        migrated_db,
        {"session_id": session_id, "transcript_path": str(transcript)},
    )
    row = await _get_session(migrated_db, session_id)
    assert row is not None
    assert row["context_tokens"] == 145

    # Second Stop: transcript path points nowhere — context_tokens must be
    # left exactly as it was, not zeroed.
    await agent_service.record_stop(
        migrated_db,
        {
            "session_id": session_id,
            "transcript_path": str(tmp_path / "does-not-exist.jsonl"),
        },
    )
    row_after = await _get_session(migrated_db, session_id)
    assert row_after is not None
    assert row_after["context_tokens"] == 145
    # tokens_in/tokens_out/cost_usd behave exactly as before: no usage read
    # this turn means no delta added.
    assert row_after["tokens_in"] == row["tokens_in"]
    assert row_after["tokens_out"] == row["tokens_out"]
    assert row_after["cost_usd"] == row["cost_usd"]


@pytest.mark.asyncio
async def test_record_stop_cost_unchanged(migrated_db: aiosqlite.Connection, tmp_path):
    """Regression net for "do not touch the cost arithmetic."

    Sonnet-4 pricing (agent_service.py:444-445): $3/M input (cached:
    $0.30/M), $15/M output. This is a known accuracy defect — it prices
    every model at these rates — tracked as its own follow-up. This test
    only pins that this branch does not change the number it produces.
    """
    session_id = _gen_uuid()
    transcript = tmp_path / "transcript.jsonl"
    usage = {
        "input_tokens": 1_000_000,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
    }
    transcript.write_text(
        json.dumps({"type": "assistant", "message": {"usage": usage}}) + "\n"
    )

    await agent_service.record_stop(
        migrated_db,
        {"session_id": session_id, "transcript_path": str(transcript)},
    )

    row = await _get_session(migrated_db, session_id)
    assert row is not None
    expected_cost = (1_000_000 * 3 + 1_000_000 * 0.30 + 1_000_000 * 15) / 1_000_000
    assert row["cost_usd"] == pytest.approx(expected_cost)
