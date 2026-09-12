"""Pre-authorisation — the user's standing answers to permission prompts (#172).

This is the one place in the app that can say something back to a running
Claude Code session. Every other hook the app installs discards its stdout;
``PreToolUse`` does not, because Claude Code reads a ``PreToolUse`` hook's
stdout for a ``hookSpecificOutput.permissionDecision`` and acts on it. That
protocol is bound to ``PreToolUse`` and to nothing else — in particular not to
``PermissionRequest``, which is the event whose *name* suggests it and which
this app therefore only ever records. A rule set evaluated anywhere but here
would be a rule set nothing could act on.

What a rule can express
-----------------------
A rule is a tool name, a decision, and at most one textual test against one
named field of that tool's input::

    {"tool": "Bash", "decision": "allow",
     "field": "command", "operator": "prefix", "value": "git status"}

* ``tool`` — an exact, case-insensitive tool name, or ``"*"`` for any tool.
* ``decision`` — ``allow`` or ``deny``.
* ``field`` / ``operator`` / ``value`` — optional, and all three together or
  none. The field is looked up in ``tool_input`` and must be a string;
  ``operator`` is ``equals``, ``prefix`` or ``contains``, compared
  case-sensitively.
* ``note`` — free text, echoed back to the session in
  ``permissionDecisionReason`` so the transcript says which standing answer
  fired rather than "Codenest said so".

Rules are evaluated in stored order and the first match wins, so a narrow
``deny`` placed above a broad ``allow`` is how an exception is written.

What a rule cannot express, deliberately
----------------------------------------
No regular expressions and no globs: this evaluator runs on the critical path
of every tool call in every session, and a user-supplied regex there is a
stall waiting to be written. No negation, no combining two conditions, no
scoping by project, session, cwd or time of day, and no ``ask`` decision —
``ask`` is what already happens when nothing matches, and a rule whose effect
is "behave normally" is a rule that can only mislead the person reading the
list. A rule also cannot answer an ``Elicitation`` or a ``Notification``;
those are recorded as attention items and answered by a human at the terminal.

Above all, the match is textual and shell-unaware. ``prefix`` ``"git "`` on
``Bash`` is a standing grant for ``git push --force``, and ``contains``
``"pytest"`` is one for ``rm -rf / # pytest``. An ``allow`` rule is a decision
the user has made in advance about a family of commands they cannot fully
enumerate; ``deny`` carries no such risk. The UI writing these should say so.

Why the rule set is cached in process
-------------------------------------
``evaluate`` is called from the ``PreToolUse`` handler, behind
``curl --max-time 5``, on every tool call — a slow read here is a five-second
stall on every single tool use, not a slow page. The rules live in one
``app_settings`` row, so the read is a primary-key lookup, but it still
contends for the one shared sidecar connection with every other hook's writes.
The parsed rules are therefore held in a module-level cache with a short TTL
and invalidated explicitly by both write paths, which makes the overwhelmingly
common case — no rules configured at all — cost nothing. The sidecar is a
single uvicorn process with no ``--workers`` (the same assumption
``hooks_service``'s self-test token store already makes), so one process-local
cache is the whole cache.
"""

from __future__ import annotations

import json
import time
from typing import Any

import aiosqlite
from fastapi import HTTPException

# The `app_settings` key the rule set lives under. Dotted to sort next to the
# other hook configuration a user might read out of the settings table.
SETTING_KEY = "hooks.preauth_rules"

# `ask` is absent on purpose — see the module docstring.
DECISIONS: tuple[str, ...] = ("allow", "deny")

# Plain `str` operations, no regex. See the module docstring.
OPERATORS: tuple[str, ...] = ("equals", "prefix", "contains")

# The tool wildcard. Written as a constant because it is also the value the
# validator has to exempt from the "tool names have no spaces" check.
ANY_TOOL = "*"

# Caps. None of these is a limit anyone will meet by hand; they exist so a
# rule set written by something other than a hand — a bad import, a loop in a
# script — cannot turn the tool-call critical path into a linear scan of
# thousands of long string comparisons.
_MAX_RULES = 200
_MAX_VALUE_LEN = 500
_MAX_TOOL_LEN = 100
_MAX_NOTE_LEN = 200

# How long a loaded rule set is trusted without re-reading. Both write paths
# invalidate explicitly, so this is only the backstop for a write that reached
# the table some other way (a direct sqlite edit, a future writer that forgets
# to call `invalidate_cache`). Short enough that such a write is live in
# seconds; long enough that a burst of tool calls reads the DB once.
_CACHE_TTL_SECONDS = 5.0

_cache: tuple[float, list[dict[str, Any]]] | None = None


def invalidate_cache() -> None:
    """Drop the cached rule set; the next `evaluate` re-reads it.

    Called by every writer in this process. It is not an optimisation to skip:
    without it a user who saves a rule watches it not apply, which reads as the
    feature being broken rather than as a cache being stale.
    """
    global _cache
    _cache = None


# ─── Validation ───────────────────────────────────────────────────────────────


def _reject(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _validate_rule(index: int, raw: Any) -> dict[str, Any]:
    """One rule, normalised, or HTTP 422.

    Normalisation is narrow and total: the tool name is lowercased (matching
    is case-insensitive, so storing the fold means `evaluate` does not repeat
    it on every tool call), and the optional condition is either all three of
    `field`/`operator`/`value` or none of them. A partially-specified
    condition is rejected rather than silently dropped, because a rule that
    was meant to be narrow and is stored broad is an `allow` that grants more
    than its author read it as granting.
    """
    where = f"rule {index}"
    if not isinstance(raw, dict):
        raise _reject(f"{where} must be an object")

    unknown = set(raw) - {"tool", "decision", "field", "operator", "value", "note"}
    if unknown:
        raise _reject(f"{where} has unknown key(s): {', '.join(sorted(unknown))}")

    tool = raw.get("tool")
    if not isinstance(tool, str) or not tool.strip():
        raise _reject(f"{where}: 'tool' must be a non-empty string")
    tool = tool.strip()
    if len(tool) > _MAX_TOOL_LEN:
        raise _reject(f"{where}: 'tool' is longer than {_MAX_TOOL_LEN} characters")
    if tool != ANY_TOOL and (" " in tool or "*" in tool):
        # Not a glob engine: a value like `Bash*` would silently never match
        # and read to its author as though it did.
        raise _reject(
            f"{where}: 'tool' must be an exact tool name or '{ANY_TOOL}' "
            "(no wildcards or spaces)"
        )

    decision = raw.get("decision")
    if decision not in DECISIONS:
        raise _reject(f"{where}: 'decision' must be one of {', '.join(DECISIONS)}")

    rule: dict[str, Any] = {"tool": tool.lower(), "decision": decision}

    note = raw.get("note")
    if note is not None:
        if not isinstance(note, str):
            raise _reject(f"{where}: 'note' must be a string")
        rule["note"] = note.strip()[:_MAX_NOTE_LEN]

    condition = [k for k in ("field", "operator", "value") if raw.get(k) is not None]
    if not condition:
        return rule
    if len(condition) != 3:
        raise _reject(
            f"{where}: 'field', 'operator' and 'value' must be given together "
            "or all omitted"
        )

    field = raw["field"]
    if not isinstance(field, str) or not field.strip():
        raise _reject(f"{where}: 'field' must be a non-empty string")
    operator = raw["operator"]
    if operator not in OPERATORS:
        raise _reject(f"{where}: 'operator' must be one of {', '.join(OPERATORS)}")
    value = raw["value"]
    if not isinstance(value, str) or not value:
        raise _reject(f"{where}: 'value' must be a non-empty string")
    if len(value) > _MAX_VALUE_LEN:
        raise _reject(f"{where}: 'value' is longer than {_MAX_VALUE_LEN} characters")

    rule["field"] = field.strip()
    rule["operator"] = operator
    rule["value"] = value
    return rule


def validate_rules(raw: Any) -> list[dict[str, Any]]:
    """A whole rule set, normalised, or HTTP 422."""
    if not isinstance(raw, list):
        raise _reject(f"{SETTING_KEY} must be a list of rules")
    if len(raw) > _MAX_RULES:
        raise _reject(f"{SETTING_KEY} holds more than {_MAX_RULES} rules")
    return [_validate_rule(i, rule) for i, rule in enumerate(raw)]


def validate_rules_json(value_json: str) -> list[dict[str, Any]]:
    """The `app_settings` write path's entry point: validate the stored string.

    Wired into `settings_service.upsert_setting` as well as this module's own
    writer, so the generic `PUT /api/v1/settings/{key}` cannot put a rule set
    in the table that `_coerce_rules` would then have to throw away on the
    hook path.
    """
    try:
        parsed = json.loads(value_json)
    except json.JSONDecodeError as exc:
        raise _reject(f"invalid JSON: {exc.msg}") from exc
    return validate_rules(parsed)


# ─── Read ─────────────────────────────────────────────────────────────────────


def _coerce_rules(raw: Any) -> list[dict[str, Any]]:
    """Best-effort read of whatever is in the table, never raising.

    The write paths validate, so this should always find a good rule set. It
    is written to survive one that is not anyway — a hand-edited database, a
    row written by an older or newer version — because this runs inside a hook
    and the failure it must never produce is "no tool call works". A rule it
    cannot read is a rule it does not apply.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw[:_MAX_RULES]:
        try:
            out.append(_validate_rule(len(out), entry))
        except HTTPException:
            continue
    return out


async def load_rules(
    db: aiosqlite.Connection, *, use_cache: bool = True
) -> list[dict[str, Any]]:
    """The current rule set, from the process cache when it is fresh."""
    global _cache
    if use_cache and _cache is not None and time.monotonic() < _cache[0]:
        return _cache[1]
    cur = await db.execute(
        "SELECT value_json FROM app_settings WHERE key = ?", (SETTING_KEY,)
    )
    row = await cur.fetchone()
    rules: list[dict[str, Any]] = []
    if row is not None:
        try:
            rules = _coerce_rules(json.loads(row["value_json"]))
        except json.JSONDecodeError:
            rules = []
    _cache = (time.monotonic() + _CACHE_TTL_SECONDS, rules)
    return rules


async def save_rules(db: aiosqlite.Connection, raw: Any) -> list[dict[str, Any]]:
    """Validate, store and return the normalised rule set."""
    rules = validate_rules(raw)
    await db.execute(
        """INSERT INTO app_settings (key, value_json, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at""",
        (SETTING_KEY, json.dumps(rules)),
    )
    await db.commit()
    invalidate_cache()
    return rules


# ─── Evaluation ───────────────────────────────────────────────────────────────


def _matches(rule: dict[str, Any], tool_name: str, tool_input: Any) -> bool:
    """Whether *rule* applies to this tool call. No regex; see the docstring."""
    if rule["tool"] != ANY_TOOL and rule["tool"] != tool_name.lower():
        return False
    field = rule.get("field")
    if field is None:
        return True
    if not isinstance(tool_input, dict):
        # A rule with a condition asks a question about the tool's input. A
        # call that has no input dict has not answered it, so the rule does
        # not apply — which is the safe direction for `allow` and the honest
        # one for `deny`.
        return False
    actual = tool_input.get(field)
    if not isinstance(actual, str):
        return False
    value = rule["value"]
    operator = rule["operator"]
    if operator == "equals":
        return actual == value
    if operator == "prefix":
        return actual.startswith(value)
    return value in actual


def _reason(rule: dict[str, Any], position: int) -> str:
    note = rule.get("note")
    if note:
        return f"Codenest pre-authorisation rule {position}: {note}"
    scope = rule["tool"] if rule["tool"] != ANY_TOOL else "any tool"
    if rule.get("field") is None:
        return f"Codenest pre-authorisation rule {position}: {scope}"
    return (
        f"Codenest pre-authorisation rule {position}: {scope} "
        f"{rule['field']} {rule['operator']} {rule['value']!r}"
    )


def decide(
    rules: list[dict[str, Any]], tool_name: str, tool_input: Any
) -> tuple[str, str] | None:
    """First matching rule's `(decision, reason)`, or None for "no opinion"."""
    for position, rule in enumerate(rules, start=1):
        if _matches(rule, tool_name, tool_input):
            return rule["decision"], _reason(rule, position)
    return None


async def evaluate(
    db: aiosqlite.Connection, payload: dict[str, Any]
) -> tuple[str, str] | None:
    """The `PreToolUse` handler's question: is there a standing answer for this?

    Returns None — "say nothing, let Claude Code ask the human" — for a
    payload with no usable tool name, and for a tool no rule mentions. The
    caller treats an exception from here the same way.
    """
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str) or not tool_name:
        return None
    rules = await load_rules(db)
    if not rules:
        return None
    return decide(rules, tool_name, payload.get("tool_input"))


def hook_response(decision: str, reason: str) -> dict[str, Any]:
    """The `PreToolUse` stdout body that carries a decision.

    ``hookSpecificOutput`` is the shape Claude Code reads for a permission
    decision, and ``hookEventName`` inside it is part of that shape rather
    than decoration — the decision is only honoured for the event it names.
    ``continue`` stays true even for a ``deny``: denying one tool call is not
    stopping the session, and conflating the two would turn a narrow standing
    "no" into a halt.
    """
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        },
    }
