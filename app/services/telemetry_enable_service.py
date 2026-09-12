"""The guided telemetry enable — Lane B's missing on-switch (epic #153 / #179).

#175 built the OTLP receiver and #176 let what it receives supersede the app's
own cost estimate. Neither does anything, because Claude Code emits no
telemetry until it is told to and nothing in this app told it to. This module
is the switch: it writes the `env` block that turns the CLI's telemetry on and
points its OTLP exporter at this sidecar, it reports exactly what it would do
before it does it, and it takes the whole thing back out again.

Why `settings.json` and not a shell profile
===========================================
Claude Code reads an `env` block out of the same `settings.json` this app
already installs hooks into, and the values in it are exported into the CLI's
process environment. A shell profile would be a worse answer three times over:
it is not the file the CLI reads for this, it differs per shell (and per login
vs. interactive invocation, and not at all for a GUI-launched session), and it
is outside everything this app knows how to write safely. `settings.json` is
inside it — #170 built an atomic, backed-up, merge-not-clobber writer for this
exact file, and the four primitives it needs are published at the bottom of
`hooks_service` (see the "reuse seam" comment there). Nothing in this module
opens a file for writing; it decides *what* and `hooks_service` decides *how*.

The five variables, and the one that is a pin rather than a setting
==================================================================
`CLAUDE_CODE_ENABLE_TELEMETRY=1`
    The master switch. Without it the CLI creates no meter and exports nothing.

`OTEL_METRICS_EXPORTER=otlp`
    Which exporter the metrics signal uses. Deliberately only the *metrics*
    signal: see "logs are not enabled, ever" below.

`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`
    Pinned, and the pin is load-bearing rather than tidy. `otlp_receiver_service`
    takes zero new dependencies *precisely* because it parses JSON with the
    standard library; `requirements.txt` carries neither `protobuf` nor any
    `opentelemetry` package. The OTLP default is `http/protobuf`, and a
    protobuf body arrives at `/v1/metrics` as bytes the receiver refuses with a
    415. Leaving this unset would produce an enable that looks complete and
    exports nothing readable.

`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8002`
    The sidecar's own base URL, no path. An OTLP/HTTP exporter appends
    `v1/metrics` itself, which is why `app/routers/otlp.py` mounts that route
    outside `/api/v1`.

`OTEL_METRIC_EXPORT_INTERVAL=60000`
    Set, at the CLI's own present default, and the reasoning is worth stating
    because "it already defaults to this" is an argument for leaving it out.

    What this key actually buys is that the load the app accepts is a number
    the app chose. Reconciliation runs *inline on the ingest path*
    (`otlp_reconcile_service`, "When this runs, and why here") on the same
    `aiosqlite` connection Claude Code's hooks use, so the export interval is
    the frequency of that work. Unpinned, it is whatever a future CLI release
    decides; a default moving from 60s to 5s would multiply that work twelvefold
    with nobody having decided anything. Pinned, it is also the only reason the
    consent copy is allowed to say "about once a minute" — an unpinned interval
    makes that sentence a guess.

    Shorter was considered and rejected. The number this buys is an accounting
    figure, not a live readout; freshness on it is worth very little, and it is
    paid for on the connection a tool call waits on.

Logs are not enabled, ever
==========================
`OTEL_LOGS_EXPORTER` is not in the authored set and never will be. Claude
Code's log signal is the one that carries prompt and response text, and this
app's receiver refuses it outright — `/v1/logs` answers 501 *without reading
the request body*, so the content is never materialised in this process even
transiently. Enabling it here would be this module asking the CLI to send
something the next module along is built to refuse.

`OTEL_TRACES_EXPORTER` is likewise absent, for a duller reason: there is no
trace receiver. Ten of the eighteen instrument names the CLI ships are spans,
not counters — `claude_code.hook`, `claude_code.tool`, `claude_code.llm_request`
among them — and a metrics endpoint cannot receive a span. So this enable does
not, and the surface must not claim it does, deliver hook latency or tool
reliability. Those are #178's, and #178 is not built.

Whose env key is this?
======================
The same question #170 answers for hooks, with the marker gone. A hook command
is a shell string with room for an inert `-H 'X-Codenest-Hook: 1'`; an env value
is `1`, or `otlp`, or a URL, and there is nowhere to hide a marker in it.

So authorship is decided by **exact value equality against what this app emits
for that key** — which is not a weaker rule than the marker but the stricter
one #170 already falls back to for pre-marker installs (`_LEGACY_COMMAND_FORMS`
is matched by character-for-character equality for exactly this reason). A key
whose value is anything else is somebody's own, and is never overwritten and
never removed: it is counted, named where it is consequential, and left.

The endpoint is the one key with more than one spelling of "ours", and only
one: `hooks_service.loopback_equivalents` supplies `127.0.0.1` and `[::1]`
alongside `localhost` for the *same port*. A loopback URL on a different port
is **not** ours — 4318 is the standard OTLP/HTTP port and a user may well be
running their own collector there. Re-pointing that would silently redirect
their telemetry to us, which is the single worst thing this module could do, so
a differing endpoint is reported as a conflict and left alone even though the
result is an enable that does not take effect. The user is told exactly that.

When a value has to change generation, its old spelling is added to the tuple
`_authored_values` returns for that key, current first — never edited out. The
same append-only rule, and the same reason: what a past release wrote into a
user's file is a historical fact, and a version of this module that no longer
recognises it is a version that can neither repair nor remove it.

Disable removes only what this app added
========================================
`disable` is a real path and not a paragraph telling the user to hand-edit
JSON, because consent that cannot be withdrawn in the place it was given is not
consent. It removes exactly the keys whose current value is ours, through the
same backup and the same atomic replace, and leaves every other key — including
one of ours whose value the user has since edited, which by the rule above is
no longer ours.

Two consequences it states rather than hides. If the `env` block is empty after
the removals, the block goes too: an `"env": {}` left behind is litter, and it
is the one deletion here that cannot destroy anything, because an empty object
says nothing to anyone. And if `CLAUDE_CODE_ENABLE_TELEMETRY` survives with a
value this app did not write, telemetry stays *on* with no endpoint configured;
that is reported on the key rather than smoothed over.

What disable does not do is retract anything already recorded. Cost figures
Lane B has written stay written, and stay outranking every other lane. Turning
the tap off does not empty the bucket, and the copy says so.
"""

from __future__ import annotations

import asyncio
import copy
import json
import stat
from collections.abc import Mapping, Sequence
from typing import Any

from app.services import hooks_service

# ─── the authored set ────────────────────────────────────────────────────────

ENV_ENABLE = "CLAUDE_CODE_ENABLE_TELEMETRY"
ENV_METRICS_EXPORTER = "OTEL_METRICS_EXPORTER"
ENV_PROTOCOL = "OTEL_EXPORTER_OTLP_PROTOCOL"
ENV_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT"
ENV_INTERVAL = "OTEL_METRIC_EXPORT_INTERVAL"

# Order is the order the plan renders in, and it is the order a reader needs to
# understand the thing: the switch, then what it exports, then how, then where,
# then how often.
AUTHORED_KEYS: tuple[str, ...] = (
    ENV_ENABLE,
    ENV_METRICS_EXPORTER,
    ENV_PROTOCOL,
    ENV_ENDPOINT,
    ENV_INTERVAL,
)

# See the module header. `http/json` is the receiver's only readable protocol,
# and the interval is a pin at the CLI's current default rather than a tuning
# choice.
VALUE_ENABLE = "1"
VALUE_METRICS_EXPORTER = "otlp"
VALUE_PROTOCOL = "http/json"
VALUE_INTERVAL_MS = "60000"

# The path an OTLP/HTTP exporter appends to `OTEL_EXPORTER_OTLP_ENDPOINT`.
# Rendered for the consent copy so the screen can name the URL that will
# actually be POSTed to rather than the base the env var holds.
METRICS_PATH = "/v1/metrics"

# ─── keys this module does not set, and watches for ──────────────────────────
#
# Each of these is somebody else's key that changes what *our* enable means.
# Naming them is the difference between a screen that tells the truth about
# this machine and one that tells the truth about a machine in general.

# Signal-specific endpoints win over the generic one and are used verbatim (no
# `/v1/metrics` appended). One of these present means our endpoint is ignored
# and the enable silently does nothing.
ENV_METRICS_ENDPOINT = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"

# The logs signal — prompt and response text. Never set by us; refused by the
# receiver. Worth saying out loud when the user already has it on.
ENV_LOGS_EXPORTER = "OTEL_LOGS_EXPORTER"

# The receiver joins every data point to a session row on the `session.id`
# attribute and refuses a point it cannot join. Turning that attribute off
# makes every export land and be rejected in full.
ENV_INCLUDE_SESSION_ID = "OTEL_METRICS_INCLUDE_SESSION_ID"

_FALSEY = frozenset({"0", "false", "no", "off"})

SEVERITY_BLOCKING = "blocking"  # the enable will not take effect
SEVERITY_WARN = "warn"  # it will, and something else is worth knowing

# ─── per-key verdicts ────────────────────────────────────────────────────────

AUTHORSHIP_CURRENT = "current"  # ours, and exactly what we emit today
AUTHORSHIP_STALE = "stale"  # ours, in a spelling we no longer emit
AUTHORSHIP_FOREIGN = "foreign"  # not ours; never written, never removed

ACTION_OK = "ok"  # present, ours, current — nothing to do
ACTION_ADD = "add"  # absent — would be added
ACTION_UPDATE = "update"  # ours in an older spelling — would be rewritten
ACTION_CONFLICT = "conflict"  # present, not ours — left exactly as it is
ACTION_REMOVE = "remove"  # ours — would be removed by disable
ACTION_ABSENT = "absent"  # nothing of ours here for disable to remove

STATE_OFF = "off"
STATE_PARTIAL = "partial"
STATE_ON = "on"

MODE_PLAN = "plan"
MODE_ENABLE = "enable"
MODE_DISABLE = "disable"


def desired_env(base_url: str) -> dict[str, str]:
    """The five variables this app writes, at *base_url*.

    The single source of what an enable means. The plan, the write, the
    authorship test and the consent copy's value column all read this; a second
    place that knows the values is a second place to forget one.
    """
    return {
        ENV_ENABLE: VALUE_ENABLE,
        ENV_METRICS_EXPORTER: VALUE_METRICS_EXPORTER,
        ENV_PROTOCOL: VALUE_PROTOCOL,
        ENV_ENDPOINT: base_url,
        ENV_INTERVAL: VALUE_INTERVAL_MS,
    }


def metrics_endpoint_url(base_url: str) -> str:
    """Where the exporter will actually POST — `<base>/v1/metrics`."""
    return f"{base_url.rstrip('/')}{METRICS_PATH}"


# Older spellings of a value this app used to write, per key. Append-only and
# empty today, because there has only ever been one generation. It exists as a
# real lookup rather than a promise in prose so that the day a value changes,
# the mechanism that keeps an existing install repairable and removable is
# already wired and tested instead of being invented under pressure.
_LEGACY_VALUES: dict[str, tuple[str, ...]] = {}


def _authored_values(
    key: str, base_url: str
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """`(current spellings, older spellings)` of "written by this app" for *key*.

    One current spelling for four of the five keys. The endpoint has one per
    loopback alias of the sidecar's own base URL, and all of them are *current*
    rather than stale: `127.0.0.1:8002` and `localhost:8002` are the same
    endpoint, and rewriting one into the other would be a change with no effect
    that took a backup to make — and, being a change, would repeat forever
    without reaching a fixed point. A loopback URL on a different port is in
    neither tuple on purpose; see the module header.
    """
    if key == ENV_ENDPOINT:
        current: tuple[str, ...] = hooks_service.loopback_equivalents(base_url)
    else:
        current = (desired_env(base_url)[key],)
    return current, _LEGACY_VALUES.get(key, ())


def env_authorship(key: str, value: object, base_url: str) -> str:
    """Whether the env entry *key*=*value* was written by this app.

    Exact string equality, and nothing else. A non-string value (a JSON number,
    a bool, a nested object) is foreign by definition: this app only ever writes
    strings, so anything else is a shape somebody built on purpose.
    """
    if key not in AUTHORED_KEYS or not isinstance(value, str):
        return AUTHORSHIP_FOREIGN
    current, legacy = _authored_values(key, base_url)
    if value in current:
        return AUTHORSHIP_CURRENT
    return AUTHORSHIP_STALE if value in legacy else AUTHORSHIP_FOREIGN


# ─── planning (pure: no filesystem, no clock) ────────────────────────────────


def _key_plan(
    key: str,
    action: str,
    value: str | None = None,
    detail: str | None = None,
) -> dict[str, Any]:
    return {"key": key, "action": action, "value": value, "detail": detail}


def _conflict_detail(key: str) -> str:
    """Why a key is being left alone, in terms of what it costs the user.

    Never prints the value found. An `env` block is where an
    `ANTHROPIC_API_KEY` lives; the rule that this app does not print a value it
    did not write is the same rule `app/models/effective_hooks.py` states for a
    hook command's argv, and it holds even when the key in question is one of
    ours and the value is probably innocuous.
    """
    if key == ENV_ENDPOINT:
        return (
            "already set to something this app did not write, so it is left"
            " exactly as it is. Until it is removed or changed by hand,"
            " Claude Code will keep exporting to wherever it currently points"
            " and this app will receive nothing."
        )
    if key == ENV_ENABLE:
        return (
            "already set to something this app did not write, so it is left"
            " exactly as it is. Telemetry is governed by that value, not by"
            " this screen."
        )
    return (
        "already set to something this app did not write, so it is left exactly"
        " as it is. The enable may not behave as described until it is changed"
        " by hand."
    )


def _notes(env: Mapping[str, Any]) -> list[dict[str, str]]:
    """Keys this app did not set that change what enabling means, by name.

    Names only, never values: see `_conflict_detail`. Each entry here is a fact
    about *this* machine that the general copy would otherwise get wrong.
    """
    notes: list[dict[str, str]] = []

    if ENV_METRICS_ENDPOINT in env:
        notes.append(
            {
                "key": ENV_METRICS_ENDPOINT,
                "severity": SEVERITY_BLOCKING,
                "detail": (
                    "A signal-specific metrics endpoint is set in this file. It"
                    " overrides the generic endpoint and is used exactly as"
                    " written, so turning telemetry on here will export to that"
                    " address and not to this app. This app does not change it."
                ),
            }
        )

    logs = env.get(ENV_LOGS_EXPORTER)
    if isinstance(logs, str) and logs.strip().lower() not in ("", "none"):
        notes.append(
            {
                "key": ENV_LOGS_EXPORTER,
                "severity": SEVERITY_WARN,
                "detail": (
                    "A logs exporter is already configured in this file. This"
                    " app never sets one and never will: the OpenTelemetry logs"
                    " signal is the one carrying prompt and response text. This"
                    " app's receiver answers /v1/logs with 501 and does not read"
                    " the request body — but this key is yours, it is pointed"
                    " wherever you pointed it, and this app does not change it."
                ),
            }
        )

    include = env.get(ENV_INCLUDE_SESSION_ID)
    if isinstance(include, str) and include.strip().lower() in _FALSEY:
        notes.append(
            {
                "key": ENV_INCLUDE_SESSION_ID,
                "severity": SEVERITY_BLOCKING,
                "detail": (
                    "The session id attribute is switched off in this file."
                    " This app's receiver joins every exported data point to a"
                    " session by that attribute and refuses a point it cannot"
                    " join, so every export would arrive and be rejected in"
                    " full. This app does not change it."
                ),
            }
        )

    return notes


def _state(enable_plan: Sequence[Mapping[str, Any]]) -> str:
    actions = {entry["action"] for entry in enable_plan}
    if actions == {ACTION_OK}:
        return STATE_ON
    if actions <= {ACTION_ADD}:
        return STATE_OFF
    return STATE_PARTIAL


def _plan_env_body(
    parsed: object, base_url: str, mode: str
) -> tuple[object, dict[str, Any], str]:
    """`(new body, plan, refusal)` for an already-parsed settings body.

    Pure, and the same refusal discipline `hooks_service._plan_settings_body`
    holds: a body that is not a JSON object, or an `env` value that is not an
    object, is a structure somebody built on purpose or a file that is not a
    settings.json at all. Replacing either would be a guess, and a guess is the
    one thing this module may never make about a user's file. A non-empty
    refusal means the returned body must be discarded.

    Both directions are planned on every call, whatever *mode* asks to be
    applied to the body. The screen needs both — it renders "this is what
    turning it on writes" and "this is what turning it off takes away" at the
    same time — and computing them together is what stops the two answers being
    derived from two different reads of the file.
    """
    if not isinstance(parsed, dict):
        return (
            None,
            _empty_plan(base_url),
            "settings.json does not contain a JSON object",
        )

    body = copy.deepcopy(parsed)
    env = body.get("env")
    if env is None:
        env = {}
        created_env = True
    elif isinstance(env, dict):
        created_env = False
    else:
        return None, _empty_plan(base_url), 'the top-level "env" key must be an object'

    desired = desired_env(base_url)
    enable_plan: list[dict[str, Any]] = []
    disable_plan: list[dict[str, Any]] = []

    for key in AUTHORED_KEYS:
        want = desired[key]
        if key not in env:
            enable_plan.append(_key_plan(key, ACTION_ADD, want))
            disable_plan.append(_key_plan(key, ACTION_ABSENT))
            continue
        verdict = env_authorship(key, env[key], base_url)
        if verdict == AUTHORSHIP_CURRENT:
            enable_plan.append(_key_plan(key, ACTION_OK, want))
            disable_plan.append(_key_plan(key, ACTION_REMOVE, want))
        elif verdict == AUTHORSHIP_STALE:
            enable_plan.append(
                _key_plan(
                    key,
                    ACTION_UPDATE,
                    want,
                    "was written by an earlier version of this app; rewritten in place.",
                )
            )
            disable_plan.append(_key_plan(key, ACTION_REMOVE, None))
        else:
            detail = _conflict_detail(key)
            enable_plan.append(_key_plan(key, ACTION_CONFLICT, want, detail))
            not_removed = (
                "this value was not written by this app, so it is not removed."
            )
            if key == ENV_ENABLE:
                not_removed += (
                    " Telemetry stays on: turning it off means editing this"
                    " value by hand."
                )
            disable_plan.append(_key_plan(key, ACTION_ABSENT, None, not_removed))

    left_foreign = sum(1 for key in env if key not in AUTHORED_KEYS)
    plan = {
        "enable": enable_plan,
        "disable": disable_plan,
        "left_foreign": left_foreign,
        "notes": _notes(env),
        "state": _state(enable_plan),
    }

    # Mutate the body for the direction being applied. `mode == MODE_PLAN`
    # falls through untouched, which is what makes the dry run structurally
    # incapable of producing something a caller could accidentally write.
    if mode == MODE_ENABLE:
        for entry in enable_plan:
            if entry["action"] in (ACTION_ADD, ACTION_UPDATE):
                env[entry["key"]] = desired[entry["key"]]
        if created_env and env:
            body["env"] = env
    elif mode == MODE_DISABLE:
        for entry in disable_plan:
            if entry["action"] == ACTION_REMOVE:
                env.pop(entry["key"], None)
        # An `env` block emptied by our own removals is litter, and deleting an
        # empty object destroys nothing. A block that was already empty when we
        # arrived is the user's and stays.
        if not env and not created_env and _plan_changes_file(plan, MODE_DISABLE):
            body.pop("env", None)

    return body, plan, ""


def _empty_plan(base_url: str) -> dict[str, Any]:
    """The plan shape for a file that was refused before it could be read.

    Every key reported `conflict` rather than omitted: a refused file is one
    this app will not touch, and a plan that simply lacked the keys would read
    as "nothing to do".
    """
    desired = desired_env(base_url)
    return {
        "enable": [
            _key_plan(key, ACTION_CONFLICT, desired[key]) for key in AUTHORED_KEYS
        ],
        "disable": [_key_plan(key, ACTION_ABSENT) for key in AUTHORED_KEYS],
        "left_foreign": 0,
        "notes": [],
        "state": STATE_PARTIAL,
    }


def _plan_changes_file(plan: Mapping[str, Any], mode: str) -> bool:
    """Whether *mode* would rewrite the file.

    `MODE_PLAN` answers for the **enable** direction, not for neither. The dry
    run's job is to say whether pressing the button would change anything, and
    the button the plan is rendered in front of is the one that turns telemetry
    on — the same thing `/hooks/install/plan` reports about `/hooks/install`.
    The disable direction has its own answer in `plan["disable"]`, which the
    same response carries.
    """
    if mode == MODE_DISABLE:
        return any(entry["action"] == ACTION_REMOVE for entry in plan["disable"])
    return any(
        entry["action"] in (ACTION_ADD, ACTION_UPDATE) for entry in plan["enable"]
    )


# ─── the disk half ───────────────────────────────────────────────────────────


def _apply_one(config_home: str, base_url: str, mode: str) -> dict[str, Any]:
    """Plan, and for a write mode perform, the env merge for one config home.

    Structured exactly like `hooks_service._install_one`, and for its reason:
    a missing, unreadable, oversized or unparseable settings.json is a real
    user situation the UI has to explain, not a request the client got wrong.
    Each becomes `status: "refused"` with the reason attached, never an HTTP
    error.
    """
    result: dict[str, Any] = {
        "config_home": config_home,
        "settings_path": hooks_service.settings_json_path(config_home),
        "status": "refused",
        "refusal": None,
        "changed": False,
        "created_file": False,
        "backup_path": None,
        "state": STATE_PARTIAL,
        "enable": [],
        "disable": [],
        "left_foreign": 0,
        "notes": [],
    }

    target, refusal = hooks_service.resolve_write_target(config_home)
    if target is None:
        result["refusal"] = refusal
        result.update(_empty_plan(base_url))
        return result
    result["settings_path"] = str(target)

    read_status, parsed, detail = hooks_service.read_settings_file(target)
    if read_status not in ("ok", "missing_file"):
        result["refusal"] = detail or f"settings.json is {read_status}"
        result.update(_empty_plan(base_url))
        return result
    created = read_status == "missing_file"

    body, plan, plan_refusal = _plan_env_body({} if created else parsed, base_url, mode)
    result.update(plan)
    if plan_refusal:
        result["refusal"] = plan_refusal
        return result

    changed = _plan_changes_file(plan, mode)
    result["changed"] = changed

    if mode == MODE_PLAN:
        result["status"] = "planned" if changed else "unchanged"
        return result

    # Disabling never brings a settings.json into existence. There is nothing
    # of ours in a file that does not exist, so writing one to say so would be
    # this module creating a file in order to remove nothing from it.
    if mode == MODE_DISABLE and created:
        result["status"] = "unchanged"
        return result

    result["created_file"] = created and mode == MODE_ENABLE
    if not changed:
        result["status"] = "unchanged"
        return result

    try:
        if created:
            mode_bits: int | None = None
            previous: bytes | None = None
        else:
            mode_bits = stat.S_IMODE(target.stat().st_mode)
            previous = target.read_bytes()
        rendered = (json.dumps(body, indent=2, ensure_ascii=False) + "\n").encode(
            "utf-8"
        )
        if previous is not None:
            result["backup_path"] = str(
                hooks_service.write_backup(target, previous, mode_bits)
            )
        hooks_service.atomic_write(target, rendered, mode_bits)
    except (OSError, ValueError) as exc:
        result["status"] = "refused"
        result["refusal"] = f"write failed: {exc}"
        return result

    result["status"] = "applied"
    return result


def _run_sync(config_homes: Sequence[str], base_url: str, mode: str) -> dict[str, Any]:
    results = [_apply_one(home, base_url, mode) for home in config_homes]
    if not results:
        overall = "unchanged"
    elif any(r["status"] == "refused" for r in results):
        overall = "refused"
    elif any(r["status"] == "applied" for r in results):
        overall = "applied"
    elif any(r["status"] == "planned" for r in results):
        overall = "planned"
    else:
        overall = "unchanged"
    return {
        "base_url": base_url,
        "endpoint_url": metrics_endpoint_url(base_url),
        "export_interval_ms": int(VALUE_INTERVAL_MS),
        "dry_run": mode == MODE_PLAN,
        "mode": mode,
        "overall": overall,
        "results": results,
    }


def _base(base_url: str | None) -> str:
    return (base_url or hooks_service.sidecar_base_url()).rstrip("/")


async def plan_telemetry_files(
    config_homes: Sequence[str], base_url: str | None = None
) -> dict[str, Any]:
    """What enabling and what disabling would each change, with the write removed.

    Its own entry point rather than a flag, exactly as `plan_settings_files` is
    — "this call cannot write" is worth making true by construction rather than
    by the value of an argument a caller, a default or a serialisation bug could
    get wrong. It reaches `_plan_env_body` with `MODE_PLAN`, which never
    mutates the body, and it never reaches the write block at all.
    """
    return await asyncio.to_thread(
        _run_sync, list(config_homes), _base(base_url), MODE_PLAN
    )


async def enable_telemetry_files(
    config_homes: Sequence[str], base_url: str | None = None
) -> dict[str, Any]:
    """Write the five variables into each config home's settings.json.

    Idempotent by construction rather than by convention: a second call finds
    every key present with exactly the value this app emits, plans no change,
    and so never reaches the write — which is also why it takes no second
    backup.
    """
    return await asyncio.to_thread(
        _run_sync, list(config_homes), _base(base_url), MODE_ENABLE
    )


async def disable_telemetry_files(
    config_homes: Sequence[str], base_url: str | None = None
) -> dict[str, Any]:
    """Remove exactly the keys this app wrote, and nothing else.

    The withdrawal half of the consent. Idempotent the same way: a second call
    finds nothing of ours left and writes nothing.
    """
    return await asyncio.to_thread(
        _run_sync, list(config_homes), _base(base_url), MODE_DISABLE
    )


__all__ = [
    "ACTION_ABSENT",
    "ACTION_ADD",
    "ACTION_CONFLICT",
    "ACTION_OK",
    "ACTION_REMOVE",
    "ACTION_UPDATE",
    "AUTHORED_KEYS",
    "AUTHORSHIP_CURRENT",
    "AUTHORSHIP_FOREIGN",
    "AUTHORSHIP_STALE",
    "ENV_ENABLE",
    "ENV_ENDPOINT",
    "ENV_INTERVAL",
    "ENV_METRICS_EXPORTER",
    "ENV_PROTOCOL",
    "MODE_DISABLE",
    "MODE_ENABLE",
    "MODE_PLAN",
    "STATE_OFF",
    "STATE_ON",
    "STATE_PARTIAL",
    "desired_env",
    "disable_telemetry_files",
    "enable_telemetry_files",
    "env_authorship",
    "metrics_endpoint_url",
    "plan_telemetry_files",
]
