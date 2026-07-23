"""Cron error type retained for schedule_service exception-handler compat.

The hand-rolled parser (parse_expression, CronExpression, matches,
next_fire_after, _FIELD_RANGES, _MAX_SEARCH_MINUTES) has been removed;
schedule_service uses the croniter-backed _cron_helpers module. CronError is
kept here so that existing ``except _cron.CronError`` handlers in
schedule_service.py do not need to change.
"""

from __future__ import annotations


class CronError(ValueError):
    """Raised when a cron expression cannot be parsed."""
