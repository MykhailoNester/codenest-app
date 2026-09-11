"""Plan-usage reader (epic #153 / #164).

Claude desktop keeps a rolling history of the user's plan consumption at
``~/Library/Application Support/Claude/plan-usage-history.json``. The verified
shape is ``{"version": 2, "samples": [{"t", "org", "u": {"fh", "sd"}}]}``,
appended to roughly every 15 minutes, and the file rolls — old samples fall off
the front, so both its length and the values it holds change under us.

The reason this module is written so defensively is that **the meaning and the
unit of ``fh`` and ``sd`` are completely undocumented**. Nothing in the file, and
nothing Claude desktop publishes, says whether they are hours, requests, tokens,
percentages, or a scaled internal score; nothing says what value counts as full.
A reader that guessed would produce a panel that looks authoritative and is
quietly wrong — the worst possible outcome for a number a person makes decisions
against. So this module commits to three rules, and the tests in
``tests/sidecar/test_plan_usage.py`` hold it to them:

1. **No claimed unit.** The payload carries no unit, limit or percentage token.
   The two series are labelled "rolling short window" and "rolling long window"
   and nothing more — that is the whole of what we actually know.
2. **Ranges are observed, never asserted.** ``observed_min``/``observed_max`` are
   computed from the samples present at read time. They were 0–43 and 0–36 when
   the ticket was written and 0–64 and 0–46 a day later, which is exactly why
   hardcoding them would have shipped a lie.
3. **Absence degrades, it does not fail.** A machine with no Claude desktop
   install, an unreadable file, or a version we have never seen all return a
   well-formed payload with the same keys and a ``reason``. The caller renders an
   explanation instead of an error, and never a fabricated number.

Every payload — healthy or degraded — carries the identical key set so the
frontend types stay total and the panel needs no optional-field branching.

``reason`` vocabulary (``None`` when the read was clean):

``missing``
    No file at the resolved path. The overwhelmingly common case on a machine
    that has never run Claude desktop.
``unreadable``
    The file exists but could not be opened or decoded as JSON text.
``malformed``
    It decoded, but not into a JSON object.
``oversize``
    Larger than ``MAX_FILE_BYTES``; refused unread so a pathological file cannot
    stall the event loop or balloon the response.
``unsupported_version``
    Present and parseable, but ``version`` is not 2. We refuse to guess at a
    shape we have not verified — ``supported`` goes false and no series are
    emitted.
``no_samples``
    A well-formed version 2 file whose ``samples`` array holds nothing we could
    parse. Supported, available, and honestly empty.

This module does no IO beyond one bounded read, holds no state, and never
raises: ``read_plan_usage`` catches everything it can provoke and answers with a
degraded payload, which keeps it safe to call from any handler.
"""

from __future__ import annotations

import json
import logging
import math
import os
from pathlib import Path
from typing import Any, Final

log = logging.getLogger(__name__)

# The only history-file version whose shape this reader has actually seen.
SUPPORTED_VERSION: Final[int] = 2

# Overridable so tests (and anyone running a non-default Claude data dir) can
# point the reader at a fixture, matching the `CODENEST_DB_PATH` convention in
# `app/config.py`.
PATH_ENV_VAR: Final[str] = "CODENEST_PLAN_USAGE_PATH"

# 30 KB is the observed size at ~338 samples. The cap is three orders of
# magnitude above that: generous enough that no plausible roll trips it, small
# enough that a corrupt or adversarial file cannot be slurped into memory.
MAX_FILE_BYTES: Final[int] = 8 * 1024 * 1024

# Samples are returned newest-last for a sparkline. The cap bounds the response
# only; the counts, the observed ranges and the gap are computed over every
# sample parsed, not over this tail.
MAX_RETURNED_SAMPLES: Final[int] = 600

# (key in the file's `u` object, the only label we are entitled to give it).
# Owner decision 7: these two strings, no unit, no limit, no percentage. "window"
# is permitted because it describes the shape of the measurement (a rolling
# window) without claiming how long the window is or what it counts.
SERIES: Final[tuple[tuple[str, str], ...]] = (
    ("fh", "rolling short window"),
    ("sd", "rolling long window"),
)


def history_path() -> Path:
    """Resolve the plan-usage history file.

    macOS-only in practice — Claude desktop writes nowhere else — so on Linux or
    Windows this simply resolves to a path that will not exist and the reader
    degrades to ``missing``, which is the correct answer there.
    """
    raw = os.environ.get(PATH_ENV_VAR)
    if raw:
        return Path(raw).expanduser()
    return (
        Path.home()
        / "Library"
        / "Application Support"
        / "Claude"
        / "plan-usage-history.json"
    )


def _payload(
    *,
    available: bool,
    supported: bool,
    version: int | None = None,
    reason: str | None = None,
    sample_count: int = 0,
    org_count: int = 0,
    first_sample_at: int | None = None,
    last_sample_at: int | None = None,
    max_gap_seconds: int | None = None,
    series: list[dict[str, Any]] | None = None,
    samples: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the one payload shape every state returns.

    Keeping the key set constant across the healthy and the degraded states is
    deliberate: the panel reads `available`/`supported`/`reason` to decide what
    to say, and reads the rest without existence checks.
    """
    return {
        "available": available,
        "supported": supported,
        "version": version,
        "reason": reason,
        "sample_count": sample_count,
        "org_count": org_count,
        "first_sample_at": first_sample_at,
        "last_sample_at": last_sample_at,
        "max_gap_seconds": max_gap_seconds,
        "series": series if series is not None else [],
        "samples": samples if samples is not None else [],
    }


def _number(value: Any) -> int | float | None:
    """A finite JSON number, or ``None``.

    `bool` is rejected explicitly: it passes `isinstance(x, int)` in Python, and
    a `true` that slipped into the file would otherwise be charted as a 1.

    Non-finite floats are rejected for a sharper reason than tidiness. Python's
    `json.loads` accepts the bare `NaN` / `Infinity` literals by default, but
    Starlette renders responses with `json.dumps(..., allow_nan=False)` — so a
    non-finite value read here does not fail at the boundary that could report
    it, it fails during serialization, long after this function returned, and
    the route answers 500. That would break this module's whole contract: every
    documented failure mode degrades to `available=False` at HTTP 200 precisely
    so a malformed file cannot take the panel down. Dropping the value keeps
    that promise.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return None


def _parse_samples(raw: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Normalise the file's samples into flat dicts, discarding what we cannot read.

    Returns the samples sorted oldest-first plus the org identifiers seen. A
    sample survives only if it carries an integer epoch-millis ``t``; the two
    series values are copied across individually, so a sample missing one of them
    still contributes its timestamp to the cadence and its other value to that
    series' observed range. Anything else in the file — including keys inside
    ``u`` that we have not verified the meaning of — is dropped rather than
    passed through under a name we would have had to invent.
    """
    if not isinstance(raw, list):
        return [], []

    parsed: list[dict[str, Any]] = []
    orgs: list[str] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        stamp = entry.get("t")
        if isinstance(stamp, bool) or not isinstance(stamp, int):
            continue
        usage = entry.get("u")
        sample: dict[str, Any] = {"t": stamp}
        if isinstance(usage, dict):
            for key, _label in SERIES:
                value = _number(usage.get(key))
                if value is not None:
                    sample[key] = value
        parsed.append(sample)
        org = entry.get("org")
        if isinstance(org, str) and org not in orgs:
            orgs.append(org)

    # The file is written in order, but sorting makes the cadence figures true
    # even if an append ever lands out of sequence.
    parsed.sort(key=lambda s: s["t"])
    return parsed, orgs


def _max_gap_seconds(samples: list[dict[str, Any]]) -> int | None:
    """Longest interval between consecutive samples, in seconds.

    This is the staleness signal the panel has: the cadence is roughly 15
    minutes, so a much larger gap means Claude desktop was not running (or not
    sampling) for a stretch, and any shape read off the series across that hole
    is not a trend. ``None`` with fewer than two samples — one sample implies no
    interval at all, and reporting 0 would read as a perfectly fresh file.
    """
    if len(samples) < 2:
        return None
    widest_ms = max(
        samples[i + 1]["t"] - samples[i]["t"] for i in range(len(samples) - 1)
    )
    return round(widest_ms / 1000)


def _series_entry(
    key: str, label: str, samples: list[dict[str, Any]]
) -> dict[str, Any]:
    """One series, described only in terms of what this file actually contained.

    ``latest`` is the value from the newest sample that carried this key, and the
    observed bounds span every sample that carried it. All three are ``None``
    when the file has never recorded the key — an empty panel row, not a zero,
    because zero is a value this counter genuinely takes.
    """
    values = [s[key] for s in samples if key in s]
    return {
        "key": key,
        "label": label,
        "latest": values[-1] if values else None,
        "observed_min": min(values) if values else None,
        "observed_max": max(values) if values else None,
    }


def read_plan_usage() -> dict[str, Any]:
    """Read and parse the plan-usage history file. Never raises.

    Every failure mode — absent file, unreadable bytes, unknown version, empty
    sample array — comes back as a 200-shaped payload with a ``reason``, because
    the caller's job is to explain the absence, not to surface a stack trace for
    a file this app does not own and cannot repair.
    """
    path = history_path()

    try:
        size = path.stat().st_size
    except OSError:
        # Missing file, unreadable parent, permission denied — all indistinguishable
        # from "Claude desktop was never installed here" as far as the panel cares.
        return _payload(available=False, supported=False, reason="missing")

    if size > MAX_FILE_BYTES:
        log.warning(
            "plan-usage history at %s is %d bytes, above the %d cap; not read",
            path,
            size,
            MAX_FILE_BYTES,
        )
        return _payload(available=False, supported=False, reason="oversize")

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        # RecursionError joins the other two because `json.loads` raises it —
        # not a ValueError — on a deeply nested document, and it is exactly the
        # shape a corrupt file takes. Without it the module's "never raises"
        # contract is false for an input it is explicitly meant to survive, and
        # the route 500s instead of reporting `unreadable`.
        log.debug("plan-usage history at %s could not be read", path, exc_info=True)
        return _payload(available=False, supported=False, reason="unreadable")

    if not isinstance(raw, dict):
        return _payload(available=False, supported=False, reason="malformed")

    version = raw.get("version")
    if isinstance(version, bool) or not isinstance(version, int):
        version = None

    if version != SUPPORTED_VERSION:
        # Refuse to guess. A version bump could reorganise `u` entirely, and
        # reading version 3 through version 2's assumptions is precisely the
        # class of silent wrongness this ticket exists to prevent.
        return _payload(
            available=True,
            supported=False,
            version=version,
            reason="unsupported_version",
        )

    samples, orgs = _parse_samples(raw.get("samples"))
    if not samples:
        return _payload(
            available=True,
            supported=True,
            version=version,
            reason="no_samples",
            org_count=len(orgs),
        )

    return _payload(
        available=True,
        supported=True,
        version=version,
        sample_count=len(samples),
        # Surfaced as a count, not as the identifiers themselves: the panel only
        # needs to know whether it is looking at one organisation's numbers or a
        # blend of several, and the org UUIDs have no business leaving the file.
        org_count=len(orgs),
        first_sample_at=samples[0]["t"],
        last_sample_at=samples[-1]["t"],
        max_gap_seconds=_max_gap_seconds(samples),
        series=[_series_entry(key, label, samples) for key, label in SERIES],
        samples=samples[-MAX_RETURNED_SAMPLES:],
    )
