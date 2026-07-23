"""Cron helper utilities for Phase 1 of the scheduled-sessions feature.

Provides:
  - preset_to_cron()    : 6 human preset types → cron expression
  - describe_cron()     : cron expression → plain-English summary
  - next_fire_times()   : cron expression → list of next N fire datetimes

These power the friendly builder UI. The underlying engine is
`croniter` (6.x), which supports comma lists (e.g. 1,3,5 in DOW for
Mon/Wed/Fri), ranges, steps, and standard named tokens.

Preset types
------------
  "daily"           Every day at a given hour:minute.
  "weekdays"        Mon–Fri at a given hour:minute.
  "weekly"          On selected weekdays at a given hour:minute.
  "monthly"         On a given day-of-month at a given hour:minute.
  "every_n_hours"   Every N hours (on the hour).
  "custom"          Raw cron expression passed through with validation.

All times are in local wall-clock time (no timezone awareness); the
running sidecar process timezone is used, matching the existing cron
behaviour in _cron.py and schedule_service.py.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from croniter import croniter

# ── Public preset types ──────────────────────────────────────────────────────

PresetKind = Literal[
    "daily", "weekdays", "weekly", "monthly", "every_n_hours", "custom"
]

# Day-of-week names used in human descriptions.
_DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
_DOW_FULL = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
]


# Ordinal suffixes for day-of-month descriptions.
def _ordinal(n: int) -> str:
    if 11 <= (n % 100) <= 13:
        return f"{n}th"
    suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


class CronHelperError(ValueError):
    """Raised when a preset or raw cron expression is invalid."""


def preset_to_cron(
    kind: PresetKind,
    *,
    hour: int = 9,
    minute: int = 0,
    weekdays: list[int] | None = None,  # 0=Sun … 6=Sat (cron convention)
    day_of_month: int = 1,
    every_n_hours: int = 1,
    raw_cron: str | None = None,
) -> str:
    """Convert a friendly preset to a 5-field cron expression.

    Parameters
    ----------
    kind:
        One of the 6 preset types.
    hour, minute:
        Wall-clock time used by daily / weekdays / weekly / monthly presets.
        ``hour`` 0–23, ``minute`` 0–59.
    weekdays:
        List of day-of-week integers (0=Sunday … 6=Saturday, cron convention)
        for the ``"weekly"`` preset.  Must be non-empty; duplicates are removed
        and the list is sorted before encoding.
    day_of_month:
        Day number (1–28) for the ``"monthly"`` preset.  Capped at 28 to avoid
        non-existent dates (Feb 29 etc.).
    every_n_hours:
        Interval for the ``"every_n_hours"`` preset.  Must be a divisor of 24
        (1, 2, 3, 4, 6, 8, 12, 24).
    raw_cron:
        A 5-field cron string for the ``"custom"`` preset.  Validated via
        croniter; raises ``CronHelperError`` when invalid.

    Returns
    -------
    str
        A valid 5-field cron expression.
    """
    if not (0 <= hour <= 23):
        raise CronHelperError(f"hour must be 0–23, got {hour}")
    if not (0 <= minute <= 59):
        raise CronHelperError(f"minute must be 0–59, got {minute}")

    if kind == "daily":
        return f"{minute} {hour} * * *"

    if kind == "weekdays":
        return f"{minute} {hour} * * 1-5"

    if kind == "weekly":
        if not weekdays:
            raise CronHelperError("'weekly' preset requires at least one weekday")
        days = sorted(set(weekdays))
        for d in days:
            if not (0 <= d <= 6):
                raise CronHelperError(f"weekday must be 0–6, got {d}")
        dow_field = ",".join(str(d) for d in days)
        return f"{minute} {hour} * * {dow_field}"

    if kind == "monthly":
        dom = max(1, min(28, day_of_month))
        return f"{minute} {hour} {dom} * *"

    if kind == "every_n_hours":
        valid_intervals = {1, 2, 3, 4, 6, 8, 12, 24}
        if every_n_hours not in valid_intervals:
            raise CronHelperError(
                f"every_n_hours must be one of {sorted(valid_intervals)}, got {every_n_hours}"
            )
        if every_n_hours == 1:
            return "0 * * * *"
        return f"0 */{every_n_hours} * * *"

    if kind == "custom":
        if not raw_cron or not raw_cron.strip():
            raise CronHelperError(
                "'custom' preset requires a non-empty raw_cron string"
            )
        expr = raw_cron.strip()
        _validate_cron(expr)
        return expr

    raise CronHelperError(f"unknown preset kind: {kind!r}")


def _validate_cron(expr: str) -> None:
    """Raise ``CronHelperError`` if ``expr`` is not a valid 5-field cron expression."""
    try:
        # croniter accepts the expression in its constructor; an invalid one
        # raises a ValueError.
        croniter(expr, datetime.now())
    except (ValueError, KeyError) as exc:
        raise CronHelperError(f"invalid cron expression {expr!r}: {exc}") from exc


def describe_cron(expr: str) -> str:
    """Return a plain-English description of a 5-field cron expression.

    Examples
    --------
    ``"0 9 * * *"``      → "Every day at 9:00 AM"
    ``"0 9 * * 1-5"``    → "At 9:00 AM, Mon–Fri"
    ``"0 9 * * 1,3,5"``  → "At 9:00 AM, Mon, Wed, Fri"
    ``"0 */4 * * *"``    → "Every 4 hours"
    ``"0 * * * *"``      → "Every hour"
    ``"30 14 1 * *"``    → "On the 1st of each month at 2:30 PM"
    """
    _validate_cron(expr)
    parts = expr.strip().split()
    if len(parts) != 5:
        return expr  # fall back for weird whitespace
    min_f, hr_f, dom_f, mon_f, dow_f = parts

    # Build time string (used by many patterns).
    def _time_str(h_field: str, m_field: str) -> str | None:
        try:
            h = int(h_field)
            m = int(m_field)
            suffix = "AM" if h < 12 else "PM"
            h12 = h % 12 or 12
            return f"{h12}:{m:02d} {suffix}"
        except ValueError:
            return None

    time_str = _time_str(hr_f, min_f)

    # Every N hours (step patterns)
    if (
        min_f == "0"
        and hr_f.startswith("*/")
        and dom_f == "*"
        and mon_f == "*"
        and dow_f == "*"
    ):
        try:
            n = int(hr_f[2:])
            if n == 1:
                return "Every hour"
            return f"Every {n} hours"
        except ValueError:
            pass

    if min_f == "0" and hr_f == "*" and dom_f == "*" and mon_f == "*" and dow_f == "*":
        return "Every hour"

    # Every-N-minutes
    if (
        min_f.startswith("*/")
        and hr_f == "*"
        and dom_f == "*"
        and mon_f == "*"
        and dow_f == "*"
    ):
        try:
            n = int(min_f[2:])
            return f"Every {n} minutes"
        except ValueError:
            pass

    # Monthly
    if dom_f != "*" and dow_f == "*" and mon_f == "*" and time_str:
        try:
            day = int(dom_f)
            return f"On the {_ordinal(day)} of each month at {time_str}"
        except ValueError:
            pass

    # Weekly — DOW patterns
    if dom_f == "*" and mon_f == "*" and time_str:
        # All days (wildcard)
        if dow_f == "*":
            return f"Every day at {time_str}"

        # Mon–Fri (range 1-5)
        if dow_f in ("1-5",):
            return f"At {time_str}, Mon–Fri"

        # Sat–Sun (range 0,6 or 6,0)
        if dow_f in ("0,6", "6,0", "0-6", "6-0"):
            if dow_f in ("0,6", "6,0"):
                return f"At {time_str}, weekends"

        # Comma-separated day list
        try:
            days = [int(d) for d in dow_f.split(",")]
            if all(0 <= d <= 6 for d in days):
                day_names = [_DOW_NAMES[d] for d in days]
                if len(day_names) == 1:
                    return f"Every {_DOW_FULL[days[0]]} at {time_str}"
                return f"At {time_str}, {', '.join(day_names)}"
        except ValueError:
            pass

        # Range (e.g. 1-5, 0-6)
        m = re.match(r"^(\d)-(\d)$", dow_f)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
            if 0 <= lo <= 6 and 0 <= hi <= 6:
                names = [_DOW_NAMES[d] for d in range(lo, hi + 1)]
                return f"At {time_str}, {', '.join(names)}"

    # Fallback: raw expression
    return expr


def next_fire_times(
    expr: str, *, count: int = 3, after: datetime | None = None
) -> list[datetime]:
    """Return the next ``count`` fire times for a cron expression.

    Parameters
    ----------
    expr:
        A valid 5-field cron expression.
    count:
        How many upcoming fire times to return (default 3, max 10).
    after:
        Start computing from this datetime (default: now).

    Returns
    -------
    list[datetime]
        Datetimes in ascending order, rounded to the minute.
    """
    _validate_cron(expr)
    n = max(1, min(count, 10))
    base = after or datetime.now()
    it = croniter(expr, base)
    return [it.get_next(datetime) for _ in range(n)]
