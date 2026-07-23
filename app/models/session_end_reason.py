"""Session-end reason classification.

Provides two enums and a pure ``classify()`` function used by
``agent_service.record_session_end`` to decide whether and how to emit a
notification when a Claude Code session finishes.

Design notes
------------
- ``SessionEndReason`` enumerates every raw reason string the harness is
  known to emit.  It is intentionally *open*: harness strings that are not
  listed fall through to the ``UNKNOWN`` bucket via ``classify()``.  Adding a
  new harness value only requires updating this enum and the mapping dict
  inside ``classify()`` — ``record_session_end`` does not need to change.
- ``EndCategory`` is the small, closed set of semantic routing buckets.
  Only ``ERROR`` and ``TIMEOUT`` emit a ``session_failed`` notification.
  ``USER_CANCELLED`` is silent.  ``UNKNOWN`` emits a soft ``session_info``
  notification so unexpected reason strings don't disappear silently.
- Both enums subclass ``str`` so members compare equal to raw strings,
  e.g. ``EndCategory.CLEAN == "clean"`` is ``True``.
"""

from __future__ import annotations

from enum import StrEnum


class SessionEndReason(StrEnum):
    """Raw reason strings emitted by the Claude Code harness."""

    EMPTY = ""
    NORMAL = "normal"
    COMPLETE = "complete"
    COMPLETED = "completed"
    CLEAR = "clear"
    PROMPT_INPUT_EXIT = "prompt_input_exit"
    OTHER = "other"
    MANUAL_CLEANUP = "manual_cleanup"
    USER_CANCELLED = "user_cancelled"
    ERROR = "error"
    TIMEOUT = "timeout"


class EndCategory(StrEnum):
    """Semantic routing bucket derived from a raw ``SessionEndReason``."""

    CLEAN = "clean"
    USER_CANCELLED = "user_cancelled"
    ERROR = "error"
    TIMEOUT = "timeout"
    UNKNOWN = "unknown"


# Mapping of known raw reason strings → category.
# Case-insensitive lookup is applied in ``classify()``.
_REASON_TO_CATEGORY: dict[str, EndCategory] = {
    SessionEndReason.EMPTY: EndCategory.CLEAN,
    SessionEndReason.NORMAL: EndCategory.CLEAN,
    SessionEndReason.COMPLETE: EndCategory.CLEAN,
    SessionEndReason.COMPLETED: EndCategory.CLEAN,
    SessionEndReason.CLEAR: EndCategory.CLEAN,
    SessionEndReason.PROMPT_INPUT_EXIT: EndCategory.CLEAN,
    SessionEndReason.OTHER: EndCategory.CLEAN,
    SessionEndReason.MANUAL_CLEANUP: EndCategory.CLEAN,
    SessionEndReason.USER_CANCELLED: EndCategory.USER_CANCELLED,
    SessionEndReason.ERROR: EndCategory.ERROR,
    SessionEndReason.TIMEOUT: EndCategory.TIMEOUT,
}


def classify(reason: str) -> EndCategory:
    """Return the ``EndCategory`` for *reason*.

    The lookup is case-insensitive.  Any string that is not in the known
    vocabulary returns ``EndCategory.UNKNOWN``.

    >>> classify("other")
    <EndCategory.CLEAN: 'clean'>
    >>> classify("error")
    <EndCategory.ERROR: 'error'>
    >>> classify("TIMEOUT")
    <EndCategory.TIMEOUT: 'timeout'>
    >>> classify("some_future_harness_string")
    <EndCategory.UNKNOWN: 'unknown'>
    """
    return _REASON_TO_CATEGORY.get(reason.lower(), EndCategory.UNKNOWN)
