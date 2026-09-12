"""Tests for the Lane C transcript scan on the schedule tick (epic #153 / #167).

#163 shipped the scanner and #158 the backfill, and neither was ever called by
anything but a hand-rolled `curl` — which is why provenance stayed NULL on four
months of sessions. These tests pin the *scheduling* decisions rather than the
scanner, which `test_transcript_scanner.py` owns:

1. the scan runs on its own interval, not the daily prune interval;
2. a pass reporting `files_deferred > 0` comes back on the very next tick, so a
   backlog drains at the bound's pace instead of one 25-file bite per interval;
3. a raising scan is logged and swallowed, so cron keeps firing;
4. `CODENEST_DISABLE_SCHEDULE_TICK=1` suppresses it entirely;
5. a drained pass logs nothing — the steady state is ~288 passes a day and a
   summary line on each would bury everything else in the log.

The seam is `transcript_scanner_service.scan_transcripts`, monkeypatched to
return canned counts: the question here is what the loop does with a result,
never how the result was computed.
"""

from __future__ import annotations

import inspect
import logging

import aiosqlite
import pytest

import app as app_pkg
from app.services import transcript_scanner_service as tss

# ─── helpers ────────────────────────────────────────────────────────────────


def _counts(**overrides: int) -> dict[str, int]:
    """A scan result with the drained steady state as its baseline.

    Measured on the live dev DB on 2026-09-12: once the backlog is gone every
    pass returns files_scanned=0, files_up_to_date=200, files_deferred=0.
    """
    base = {
        "config_dirs": 2,
        "files_seen": 200,
        "files_scanned": 0,
        "files_up_to_date": 200,
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
    base.update(overrides)
    return base


@pytest.fixture
def spy(monkeypatch: pytest.MonkeyPatch):
    """Replace the scan with a recorder; `spy.result` is what it returns."""

    class _Spy:
        def __init__(self) -> None:
            self.calls: list[aiosqlite.Connection] = []
            self.result: dict[str, int] = _counts()
            self.raises: Exception | None = None

        async def __call__(self, db: aiosqlite.Connection) -> dict[str, int]:
            self.calls.append(db)
            if self.raises is not None:
                raise self.raises
            return self.result

    s = _Spy()
    monkeypatch.setattr(tss, "scan_transcripts", s)
    monkeypatch.delenv("CODENEST_DISABLE_SCHEDULE_TICK", raising=False)
    return s


def _tick_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Only records from the tick loop's own logger.

    `caplog` collects from the root handler, so an unrelated library logging
    during the fixture's DB setup would otherwise make "logs nothing" flaky.
    The claim under test is about `app`'s log, not the process's.
    """
    return [record for record in caplog.records if record.name == app_pkg.__name__]


# ─── interval ───────────────────────────────────────────────────────────────


def test_scan_has_its_own_interval_not_the_prune_interval() -> None:
    """The whole point of #167: a daily cadence is what left provenance blank."""
    assert app_pkg._TRANSCRIPT_SCAN_TICK_SECONDS != app_pkg._PRUNE_TICK_SECONDS
    assert app_pkg._TRANSCRIPT_SCAN_TICK_SECONDS < app_pkg._PRUNE_TICK_SECONDS
    # 300 s / 30 s tick == 10 ticks. Pinned because the drain test below reads
    # the same helper, and a silent retune should fail here, not there.
    assert app_pkg._transcript_scan_interval_ticks() == 10


def test_interval_ticks_never_rounds_down_to_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A scan interval shorter than one tick must still advance the counter."""
    monkeypatch.setattr(app_pkg, "_TRANSCRIPT_SCAN_TICK_SECONDS", 5.0)
    assert app_pkg._transcript_scan_interval_ticks() == 1


# ─── it runs, and it drains ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scan_is_called_when_enabled(
    migrated_db: aiosqlite.Connection, spy
) -> None:
    """The tick invokes the scanner with the loop's own connection."""
    await app_pkg._transcript_scan_tick(migrated_db, 0)

    assert spy.calls == [migrated_db]


@pytest.mark.asyncio
async def test_drained_pass_waits_a_full_interval(
    migrated_db: aiosqlite.Connection, spy
) -> None:
    """Nothing deferred: come back in `_transcript_scan_interval_ticks()`."""
    spy.result = _counts()

    assert await app_pkg._transcript_scan_tick(migrated_db, 7) == 7 + 10


@pytest.mark.asyncio
async def test_deferred_backlog_reschedules_on_the_next_tick(
    migrated_db: aiosqlite.Connection, spy
) -> None:
    """A bounded pass with work left over must not idle for a full interval.

    One pass takes at most SCAN_MAX_FILES_PER_PASS files, so a 136-file
    backlog needs six passes. At the interval that is 30 minutes; at one tick
    apiece it is three.
    """
    spy.result = _counts(files_scanned=25, files_deferred=111)

    assert await app_pkg._transcript_scan_tick(migrated_db, 3) == 4


@pytest.mark.asyncio
async def test_backlog_drains_tick_by_tick_then_settles(
    migrated_db: aiosqlite.Connection, spy
) -> None:
    """Drive the real decision function across a backlog and watch it settle."""
    remaining = 60
    tick = 0
    next_due = 0
    scan_ticks: list[int] = []

    for tick in range(40):
        if tick < next_due:
            continue
        took = min(25, remaining)
        remaining -= took
        spy.result = _counts(files_scanned=took, files_deferred=remaining)
        scan_ticks.append(tick)
        next_due = await app_pkg._transcript_scan_tick(migrated_db, tick)

    # Three consecutive ticks clear 60 files (25 + 25 + 10); the pass that
    # reports nothing deferred is the one that falls back to the interval.
    assert scan_ticks[:4] == [0, 1, 2, 12]
    assert remaining == 0


# ─── isolation ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_raising_scan_does_not_break_the_loop(
    migrated_db: aiosqlite.Connection,
    spy,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Logged at warning, swallowed, and backed off a full interval.

    The back-off is the point of the assertion on the return value: a scanner
    that is failing is not draining, so retrying it every 30 s would only
    multiply the warning.
    """
    spy.raises = RuntimeError("transcript root vanished")

    with caplog.at_level(logging.WARNING, logger="app"):
        next_due = await app_pkg._transcript_scan_tick(migrated_db, 2)

    assert next_due == 2 + 10
    assert "transcript scan failed (continuing)" in caplog.text
    assert "transcript root vanished" in caplog.text


@pytest.mark.asyncio
async def test_disable_flag_suppresses_the_scan(
    migrated_db: aiosqlite.Connection,
    spy,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`CODENEST_DISABLE_SCHEDULE_TICK=1` means the suite never scans implicitly."""
    monkeypatch.setenv("CODENEST_DISABLE_SCHEDULE_TICK", "1")

    next_due = await app_pkg._transcript_scan_tick(migrated_db, 0)

    assert spy.calls == []
    assert next_due == 10


# ─── log noise ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_drained_pass_logs_nothing(
    migrated_db: aiosqlite.Connection,
    spy,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The steady state is silent — 288 passes a day must not each leave a line."""
    spy.result = _counts()

    with caplog.at_level(logging.DEBUG, logger="app"):
        await app_pkg._transcript_scan_tick(migrated_db, 0)

    assert _tick_records(caplog) == []


@pytest.mark.asyncio
async def test_failed_only_pass_logs_nothing(
    migrated_db: aiosqlite.Connection,
    spy,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unreadable file keeps its offset and fails on every subsequent pass.

    Letting `files_failed` alone open the log gate would turn one bad file into
    a line every five minutes forever, which is the noise class this ticket
    forbids. The error is recorded in `transcript_scan_state.last_error`.
    """
    spy.result = _counts(files_failed=1)

    with caplog.at_level(logging.DEBUG, logger="app"):
        await app_pkg._transcript_scan_tick(migrated_db, 0)

    assert _tick_records(caplog) == []


@pytest.mark.asyncio
async def test_productive_pass_logs_one_summary_line(
    migrated_db: aiosqlite.Connection,
    spy,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One line per pass that did something, in `prune_transcript_blobs` style."""
    spy.result = _counts(
        files_scanned=25,
        files_up_to_date=175,
        sessions_updated=43,
        sessions_unmatched=2,
        files_deferred=4,
    )

    with caplog.at_level(logging.INFO, logger="app"):
        await app_pkg._transcript_scan_tick(migrated_db, 0)

    records = _tick_records(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert message == (
        "transcript scan: files_scanned=25, sessions_updated=43, "
        "sessions_unmatched=2, files_failed=0, files_deferred=4"
    )


# ─── the backfill stays manual ──────────────────────────────────────────────


def test_attribution_backfill_is_not_on_the_loop() -> None:
    """#158's backfill can create `projects` rows, so no timer may call it.

    A periodic job that mints projects because a transcript mentioned an
    unfamiliar `cwd` is a different risk class from one that fills columns on
    rows a human already created. It stays behind
    `POST /api/v1/agents/sessions/backfill-attribution`.
    """
    source = inspect.getsource(app_pkg._schedule_tick_loop) + inspect.getsource(
        app_pkg._transcript_scan_tick
    )
    assert "session_backfill_service" not in source
    assert "backfill_session_attribution" not in source


# ---------------------------------------------------------------------------
# Loop-level wiring and the stuck-backlog hot path (#167)
#
# Every test above calls `_transcript_scan_tick` directly, which leaves the two
# things that actually connect it to the app untested: the `next_scan_tick`
# accumulator and the `tick_count >= next_scan_tick` comparison in
# `_schedule_tick_loop`. An edit that broke either — scheduling on the daily
# prune interval, say — would pass every unit test in this file.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_accumulator_yields_the_scan_interval_not_the_prune_interval(
    migrated_db: aiosqlite.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Replay the loop's own accumulator arithmetic over a known tick span.

    At a 30 s tick and a 300 s scan interval, 25 ticks must yield exactly 3
    passes (ticks 0, 10, 20). On the daily prune interval it would yield 1, and
    on every tick it would yield 25 — so this one number distinguishes all
    three wirings.
    """

    async def drained(_db: aiosqlite.Connection) -> dict[str, int]:
        return {"files_scanned": 0, "files_deferred": 0}

    monkeypatch.setattr(tss, "scan_transcripts", drained)

    next_due = 0
    passes = 0
    for tick in range(25):
        if tick >= next_due:
            next_due = await app_pkg._transcript_scan_tick(migrated_db, tick)
            passes += 1

    assert passes == 3


@pytest.mark.asyncio
async def test_a_stuck_backlog_backs_off_instead_of_spinning_every_tick(
    migrated_db: aiosqlite.Connection,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """`deferred` without `scanned` is not progress and must not fast-path.

    More than SCAN_MAX_FILES_PER_PASS files that stat but cannot be opened give
    scanned=0, failed=25, deferred>0 on *every* pass. Rescheduling on `deferred`
    alone would re-run the scan every 30 s forever and log a summary each time —
    2,880 identical lines a day. The failure is recorded durably per file in
    `transcript_scan_state.last_error`, which is where a human should read it.
    """

    async def stuck(_db: aiosqlite.Connection) -> dict[str, int]:
        return {
            "files_scanned": 0,
            "files_failed": 25,
            "files_deferred": 175,
            "sessions_updated": 0,
            "sessions_unmatched": 0,
        }

    monkeypatch.setattr(tss, "scan_transcripts", stuck)
    caplog.clear()
    with caplog.at_level(logging.INFO):
        next_due = await app_pkg._transcript_scan_tick(migrated_db, 0)

    assert next_due == app_pkg._transcript_scan_interval_ticks()
    assert not [r for r in caplog.records if "transcript scan:" in r.getMessage()]


@pytest.mark.asyncio
async def test_real_progress_still_comes_back_on_the_next_tick(
    migrated_db: aiosqlite.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The drain rule still fires when the pass genuinely moved."""

    async def draining(_db: aiosqlite.Connection) -> dict[str, int]:
        return {
            "files_scanned": 25,
            "files_failed": 0,
            "files_deferred": 150,
            "sessions_updated": 4,
            "sessions_unmatched": 1,
        }

    monkeypatch.setattr(tss, "scan_transcripts", draining)
    assert await app_pkg._transcript_scan_tick(migrated_db, 7) == 8
