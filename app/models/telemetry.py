"""Response shapes for the guided telemetry enable (#179).

Kept free of database imports for the reason ``app/models/hooks.py`` gives:
``telemetry_enable_service`` returns plain dicts and the router wraps them on
the way out.

One rule is encoded in these shapes rather than left to the router, because it
is the rule most easily lost: **``value`` only ever holds a value this app
itself writes.** A settings.json ``env`` block is where an ``ANTHROPIC_API_KEY``
lives. A key this app did not author is reported by name and by action and
never by content — the same rule ``app/models/effective_hooks.py`` states for a
third-party hook command's argv, and ``left_foreign`` is a count for the same
reason ``HookInstallEventPlan``'s three ``left_*`` fields are.
"""

from __future__ import annotations

from pydantic import BaseModel


class TelemetryKeyPlan(BaseModel):
    """What would happen — or did happen — to one environment variable.

    ``value`` is what *this app* writes for the key. It is populated on
    ``ok``/``add``/``update``/``conflict`` so the consent screen can print the
    exact value being proposed, and it is never the value found in the file
    unless the two are the same by definition (``ok``). On a ``conflict`` it is
    the value that was *not* written.
    """

    key: str
    # "ok" | "add" | "update" | "conflict"  (enable direction)
    # "remove" | "absent"                   (disable direction)
    action: str
    value: str | None = None
    detail: str | None = None


class TelemetryNote(BaseModel):
    """A key this app does not set that changes what enabling means here.

    ``severity`` is ``blocking`` when the enable will not take effect as
    described, ``warn`` when it will and something else is worth knowing. Both
    name the key and neither prints its value.
    """

    key: str
    severity: str  # "blocking" | "warn"
    detail: str


class TelemetryResult(BaseModel):
    """Outcome for one requested config home.

    ``state`` is the state of the file **as this call found it** — ``off``,
    ``partial`` or ``on`` — not the state it leaves behind. A caller that has
    just written re-reads the plan; a ``state`` that flipped inside the write
    response would be the one field on this object describing a different
    moment from all the others.

    ``backup_path`` names the copy of the previous content taken immediately
    before the write, and is ``None`` when nothing was written and when the file
    did not exist to begin with — identical to ``HookInstallResult``, because it
    is the same backup taken by the same function.
    """

    config_home: str
    settings_path: str
    status: str  # "applied" | "planned" | "unchanged" | "refused"
    refusal: str | None = None
    changed: bool = False
    created_file: bool = False
    backup_path: str | None = None
    state: str  # "off" | "partial" | "on"
    enable: list[TelemetryKeyPlan] = []
    disable: list[TelemetryKeyPlan] = []
    # How many env entries this app did not author and therefore did not touch.
    # A count, never names: see the module docstring.
    left_foreign: int = 0
    notes: list[TelemetryNote] = []


class TelemetryReport(BaseModel):
    """Response for the telemetry plan / enable / disable routes.

    ``endpoint_url`` is rendered rather than derived by the client because an
    OTLP/HTTP exporter appends ``v1/metrics`` to the endpoint env var itself:
    the value written into settings.json and the URL actually POSTed to are two
    different strings, and a consent screen that showed only the first would be
    naming a URL that never appears on the wire.
    """

    base_url: str
    endpoint_url: str
    export_interval_ms: int
    dry_run: bool
    mode: str  # "plan" | "enable" | "disable"
    overall: str  # "applied" | "planned" | "unchanged" | "refused"
    results: list[TelemetryResult]
