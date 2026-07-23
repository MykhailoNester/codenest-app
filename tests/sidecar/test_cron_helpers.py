"""Unit tests for app/services/_cron_helpers.py

Covers:
- preset_to_cron: all 6 preset types, including edge cases and error paths.
- describe_cron: every branch in the description logic.
- next_fire_times: count clamping, ordering, and `after` parameter.
- CronHelperError is a subclass of ValueError.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.services._cron_helpers import (
    CronHelperError,
    describe_cron,
    next_fire_times,
    preset_to_cron,
)


# ---------------------------------------------------------------------------
# CronHelperError is a ValueError
# ---------------------------------------------------------------------------


def test_cron_helper_error_is_value_error() -> None:
    assert issubclass(CronHelperError, ValueError)


# ---------------------------------------------------------------------------
# preset_to_cron — daily
# ---------------------------------------------------------------------------


def test_daily_default_time() -> None:
    assert preset_to_cron("daily") == "0 9 * * *"


def test_daily_custom_time() -> None:
    assert preset_to_cron("daily", hour=7, minute=30) == "30 7 * * *"


def test_daily_midnight() -> None:
    assert preset_to_cron("daily", hour=0, minute=0) == "0 0 * * *"


# ---------------------------------------------------------------------------
# preset_to_cron — weekdays
# ---------------------------------------------------------------------------


def test_weekdays() -> None:
    assert preset_to_cron("weekdays", hour=9, minute=0) == "0 9 * * 1-5"


def test_weekdays_custom_time() -> None:
    assert preset_to_cron("weekdays", hour=17, minute=45) == "45 17 * * 1-5"


# ---------------------------------------------------------------------------
# preset_to_cron — weekly (single and multi-day)
# ---------------------------------------------------------------------------


def test_weekly_single_day() -> None:
    assert preset_to_cron("weekly", hour=9, minute=0, weekdays=[1]) == "0 9 * * 1"


def test_weekly_multi_day() -> None:
    # Mon/Wed/Fri = 1,3,5
    expr = preset_to_cron("weekly", hour=9, minute=0, weekdays=[1, 3, 5])
    assert expr == "0 9 * * 1,3,5"


def test_weekly_deduplicates_and_sorts() -> None:
    # Duplicates and out-of-order should be sorted and deduplicated.
    expr = preset_to_cron("weekly", hour=8, minute=0, weekdays=[5, 1, 3, 1])
    assert expr == "0 8 * * 1,3,5"


def test_weekly_all_days() -> None:
    expr = preset_to_cron("weekly", hour=6, minute=0, weekdays=[0, 1, 2, 3, 4, 5, 6])
    assert expr == "0 6 * * 0,1,2,3,4,5,6"


def test_weekly_requires_weekdays() -> None:
    with pytest.raises(CronHelperError, match="requires at least one weekday"):
        preset_to_cron("weekly", hour=9, minute=0, weekdays=[])


def test_weekly_none_weekdays_raises() -> None:
    with pytest.raises(CronHelperError):
        preset_to_cron("weekly", hour=9, minute=0, weekdays=None)


def test_weekly_invalid_day() -> None:
    with pytest.raises(CronHelperError, match="weekday must be 0–6"):
        preset_to_cron("weekly", hour=9, minute=0, weekdays=[7])


# ---------------------------------------------------------------------------
# preset_to_cron — monthly
# ---------------------------------------------------------------------------


def test_monthly_default() -> None:
    assert preset_to_cron("monthly", hour=9, minute=0) == "0 9 1 * *"


def test_monthly_day_15() -> None:
    assert preset_to_cron("monthly", hour=9, minute=0, day_of_month=15) == "0 9 15 * *"


def test_monthly_day_clamped_to_28() -> None:
    # Days > 28 are clamped to 28 to avoid non-existent dates.
    assert preset_to_cron("monthly", hour=9, minute=0, day_of_month=31) == "0 9 28 * *"


def test_monthly_day_clamped_to_1() -> None:
    assert preset_to_cron("monthly", hour=9, minute=0, day_of_month=0) == "0 9 1 * *"


# ---------------------------------------------------------------------------
# preset_to_cron — every_n_hours
# ---------------------------------------------------------------------------


def test_every_1_hour() -> None:
    assert preset_to_cron("every_n_hours", every_n_hours=1) == "0 * * * *"


def test_every_2_hours() -> None:
    assert preset_to_cron("every_n_hours", every_n_hours=2) == "0 */2 * * *"


def test_every_4_hours() -> None:
    assert preset_to_cron("every_n_hours", every_n_hours=4) == "0 */4 * * *"


def test_every_12_hours() -> None:
    assert preset_to_cron("every_n_hours", every_n_hours=12) == "0 */12 * * *"


def test_every_24_hours() -> None:
    assert preset_to_cron("every_n_hours", every_n_hours=24) == "0 */24 * * *"


def test_every_n_hours_invalid_interval() -> None:
    # 5 is not a divisor of 24.
    with pytest.raises(CronHelperError, match="every_n_hours must be one of"):
        preset_to_cron("every_n_hours", every_n_hours=5)


def test_every_n_hours_invalid_zero() -> None:
    with pytest.raises(CronHelperError):
        preset_to_cron("every_n_hours", every_n_hours=0)


# ---------------------------------------------------------------------------
# preset_to_cron — custom
# ---------------------------------------------------------------------------


def test_custom_passthrough() -> None:
    raw = "15 3 * * 2"
    assert preset_to_cron("custom", raw_cron=raw) == raw


def test_custom_strips_whitespace() -> None:
    assert preset_to_cron("custom", raw_cron="  0 9 * * *  ") == "0 9 * * *"


def test_custom_empty_raises() -> None:
    with pytest.raises(CronHelperError, match="non-empty raw_cron"):
        preset_to_cron("custom", raw_cron="")


def test_custom_none_raises() -> None:
    with pytest.raises(CronHelperError):
        preset_to_cron("custom", raw_cron=None)


def test_custom_invalid_raises() -> None:
    with pytest.raises(CronHelperError, match="invalid cron expression"):
        preset_to_cron("custom", raw_cron="99 99 * * *")


# ---------------------------------------------------------------------------
# preset_to_cron — bad inputs
# ---------------------------------------------------------------------------


def test_invalid_kind_raises() -> None:
    with pytest.raises(CronHelperError, match="unknown preset kind"):
        preset_to_cron("never")  # type: ignore[arg-type]


def test_hour_out_of_range_raises() -> None:
    with pytest.raises(CronHelperError, match="hour must be 0–23"):
        preset_to_cron("daily", hour=24)


def test_minute_out_of_range_raises() -> None:
    with pytest.raises(CronHelperError, match="minute must be 0–59"):
        preset_to_cron("daily", minute=60)


# ---------------------------------------------------------------------------
# describe_cron
# ---------------------------------------------------------------------------


def test_describe_every_day() -> None:
    assert describe_cron("0 9 * * *") == "Every day at 9:00 AM"


def test_describe_every_day_pm() -> None:
    assert describe_cron("0 14 * * *") == "Every day at 2:00 PM"


def test_describe_every_day_with_minutes() -> None:
    assert describe_cron("30 9 * * *") == "Every day at 9:30 AM"


def test_describe_midnight() -> None:
    assert describe_cron("0 0 * * *") == "Every day at 12:00 AM"


def test_describe_noon() -> None:
    assert describe_cron("0 12 * * *") == "Every day at 12:00 PM"


def test_describe_weekdays() -> None:
    assert describe_cron("0 9 * * 1-5") == "At 9:00 AM, Mon–Fri"


def test_describe_weekly_single_day() -> None:
    # Monday only
    assert describe_cron("0 9 * * 1") == "Every Monday at 9:00 AM"


def test_describe_weekly_multi_day() -> None:
    # Mon/Wed/Fri
    result = describe_cron("0 9 * * 1,3,5")
    assert result == "At 9:00 AM, Mon, Wed, Fri"


def test_describe_monthly_1st() -> None:
    assert describe_cron("0 9 1 * *") == "On the 1st of each month at 9:00 AM"


def test_describe_monthly_2nd() -> None:
    assert describe_cron("0 9 2 * *") == "On the 2nd of each month at 9:00 AM"


def test_describe_monthly_3rd() -> None:
    assert describe_cron("0 9 3 * *") == "On the 3rd of each month at 9:00 AM"


def test_describe_monthly_4th() -> None:
    assert describe_cron("0 9 4 * *") == "On the 4th of each month at 9:00 AM"


def test_describe_monthly_11th() -> None:
    # 11th → "11th" (teens always use "th")
    assert describe_cron("0 9 11 * *") == "On the 11th of each month at 9:00 AM"


def test_describe_monthly_21st() -> None:
    assert describe_cron("0 9 21 * *") == "On the 21st of each month at 9:00 AM"


def test_describe_every_hour() -> None:
    assert describe_cron("0 * * * *") == "Every hour"


def test_describe_every_4_hours() -> None:
    assert describe_cron("0 */4 * * *") == "Every 4 hours"


def test_describe_every_12_hours() -> None:
    assert describe_cron("0 */12 * * *") == "Every 12 hours"


def test_describe_invalid_cron_raises() -> None:
    with pytest.raises(CronHelperError):
        describe_cron("99 99 * * *")


# ---------------------------------------------------------------------------
# next_fire_times
# ---------------------------------------------------------------------------


def test_next_fire_times_returns_count() -> None:
    after = datetime(2025, 1, 1, 8, 0, 0)
    times = next_fire_times("0 9 * * *", count=3, after=after)
    assert len(times) == 3


def test_next_fire_times_default_count() -> None:
    after = datetime(2025, 1, 1, 8, 0, 0)
    times = next_fire_times("0 9 * * *", after=after)
    assert len(times) == 3  # default is 3


def test_next_fire_times_ascending_order() -> None:
    after = datetime(2025, 1, 1, 8, 0, 0)
    times = next_fire_times("0 9 * * *", count=5, after=after)
    assert times == sorted(times)


def test_next_fire_times_daily_values() -> None:
    after = datetime(2025, 6, 1, 8, 0, 0)  # 08:00 → next fire at 09:00 same day
    times = next_fire_times("0 9 * * *", count=3, after=after)
    assert times[0].hour == 9
    assert times[0].minute == 0
    # Each successive fire is one day later.
    delta = (times[1] - times[0]).total_seconds()
    assert delta == 24 * 3600


def test_next_fire_times_clamp_max_count() -> None:
    # count > 10 should be silently clamped to 10.
    after = datetime(2025, 1, 1, 0, 0, 0)
    times = next_fire_times("0 * * * *", count=50, after=after)
    assert len(times) == 10


def test_next_fire_times_clamp_min_count() -> None:
    after = datetime(2025, 1, 1, 0, 0, 0)
    times = next_fire_times("0 * * * *", count=0, after=after)
    assert len(times) == 1  # clamped to 1


def test_next_fire_times_weekly_multi_day() -> None:
    # Mon/Wed/Fri — test that all 3 are different days-of-week.
    after = datetime(2025, 6, 2, 8, 0, 0)  # Monday
    times = next_fire_times("0 9 * * 1,3,5", count=3, after=after)
    assert len(times) == 3
    weekdays = {t.weekday() for t in times}
    # Monday=0, Wednesday=2, Friday=4 in Python's weekday() convention
    assert weekdays == {0, 2, 4}


def test_next_fire_times_invalid_expr_raises() -> None:
    with pytest.raises(CronHelperError):
        next_fire_times("not a cron")
