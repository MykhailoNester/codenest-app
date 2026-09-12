"""What is actually on each Claude Code hook event, across all eight contributors.

The question this module answers
-------------------------------
"What runs on ``PreToolUse``?" has, today, no single place to look. The answer
is spread across eight separate config surfaces, each owned by a different part
of the system, and reading them by hand means opening eight files in four
directories and mentally combining them. This module does that combining once,
in code, and returns the combined answer.

Hooks accumulate. Every one of them runs.
-----------------------------------------
This is the fact the whole module is built around, and it is easy to get wrong
because the surrounding machinery works the other way. Claude Code's settings
system resolves *scalar* settings — a model name, a permission mode, an env
var — by consulting user, then project, then project-local, then a
``--settings`` file, then managed policy, and keeping one value. Hooks are not
resolved that way. A hook block found in one scope does not replace the hook
block found in another: the blocks are merged, and at event time the harness
runs every hook it collected from every source, in addition to each other. The
binary logs ``Failed to merge hooks from <manifest>`` when a plugin's block is
malformed — the verb in its own error message is *merge*.

So the useful question is never "which source supplies the hooks for this
event". It is "how many separate things sit on this event's critical path, and
which file put each of them there" — because five hooks on ``PreToolUse`` means
five processes spawned before every single tool call, whether or not the person
who added the fifth knew about the other four. That is what
``HOOK_EVENT_CATALOG`` and ``build_effective_hooks`` report: a count and a
provenance, per event, per source, with nothing discarded along the way.

The eight contributor sources
-----------------------------
Five are settings scopes and three are not, which is why "settings scopes" is
not a synonym for "hook sources" and why the count is eight rather than five:

1. ``user``            — ``<config home>/settings.json``
2. ``project``         — ``<repo>/.claude/settings.json``
3. ``project_local``   — ``<repo>/.claude/settings.local.json``
4. ``settings_flag``   — a file handed to the CLI as ``--settings <path>``
5. ``managed_policy``  — the OS-level managed settings file
6. ``plugin``          — an installed plugin's ``hooks/hooks.json``
7. ``skill``           — a ``SKILL.md`` frontmatter ``hooks:`` block
8. ``agent``           — an agent definition's frontmatter ``hooks:`` block

Seven of the eight are files on disk this module reads. ``settings_flag`` is
the exception and is reported rather than dropped: the path is chosen per
invocation on the command line, the sidecar never sees the argv of the process
that ran the hook, and a source that is silently absent from the report reads
as "nothing contributes here" — the single most misleading thing this module
could say. It is carried with ``observable=False`` and a note explaining the
gap, so the count it contributes is honestly "unknown", not "zero".

Why no timing, anywhere
-----------------------
There is no measured-duration field in anything this module returns, and the
temptation to add one is worth naming. Hook payloads carry no timing, and a
transcript's ``hookInfos`` entries mostly carry a command name and nothing
else — though not universally: a minority of them do carry a ``durationMs``,
and every one of those is this app's own ``/hooks/stop`` curl, which is to say
the app can time itself and nothing else. Timing one of eight contributors is
not a picture of what an event costs; it is a picture of what *we* cost, which
invites exactly the wrong conclusion about the other seven. Real per-hook
timing needs the harness to emit it (OTLP), and that is a later phase.
``timeout_seconds`` below is the one number here and it is not a measurement:
it is the ceiling the config file itself declares, read straight out of the
file, which is the only thing on this page that is knowable from config alone.

Why a third-party hook's command is not returned
------------------------------------------------
A hook command is an arbitrary shell string somebody else wrote, and shell
strings carry secrets in argv — an API key passed as ``--token=...``, a webhook
URL with its signature in the query, a bearer header typed inline. This report
is an HTTP response: it reaches the frontend, and on the way it can land in any
request log, any error report, any support bundle. So for every hook this app
did not author, the response carries the executable's *name* only — ``bash``,
``python3``, ``guard.sh`` — and never the argument list. An ``http``-type hook
is reduced the same way, to its host and port, with any ``user:password@``
prefix dropped along with the path and the query.

Authorship is decided by exact membership in the set of commands this module's
own generator emits (``authored_commands`` / ``_is_codenest_authored``), and it
fails closed because set membership is the only form of the question that can.
Asking instead whether a command *mentions* one of our ingest URLs gets this
backwards: a shell string somebody else wrote can name our URL and still be
theirs, and the ones that name it are precisely the ones likely to be carrying
a bearer token in the same argv. The app's own commands are returned whole
because this module is what generates them
(``hooks_service.build_hook_settings``) and they are a fixed curl with no
credential in them; everything else is redacted.
"""

from __future__ import annotations

import asyncio
import re
import shlex
import sys
from collections.abc import Container, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from app.services import hooks_service, project_scanner_service

# ─── the eight contributor sources ───────────────────────────────────────────

SOURCE_USER = "user"
SOURCE_PROJECT = "project"
SOURCE_PROJECT_LOCAL = "project_local"
SOURCE_SETTINGS_FLAG = "settings_flag"
SOURCE_MANAGED_POLICY = "managed_policy"
SOURCE_PLUGIN = "plugin"
SOURCE_SKILL = "skill"
SOURCE_AGENT = "agent"


@dataclass(frozen=True)
class ContributorSource:
    """One of the eight places a hook can come from.

    Frozen and module-level: the tuple below is shared state every catalog
    entry points at, and nothing may edit an entry in place.

    ``observable`` is the field that earns this dataclass its existence. Seven
    sources are files this module can open; ``settings_flag`` is a path chosen
    on a command line the sidecar never sees. Carrying that distinction as data
    is what lets the report say "this source contributes an unknown amount"
    instead of quietly implying it contributes nothing.
    """

    slug: str
    label: str
    where: str
    observable: bool
    note: str


CONTRIBUTOR_SOURCES: tuple[ContributorSource, ...] = (
    ContributorSource(
        slug=SOURCE_USER,
        label="User settings",
        where="<config home>/settings.json",
        observable=True,
        note=(
            "The per-machine settings file, shared by every project this user "
            "opens. Hooks declared here run in addition to every project's own."
        ),
    ),
    ContributorSource(
        slug=SOURCE_PROJECT,
        label="Project settings",
        where="<repo>/.claude/settings.json",
        observable=True,
        note=(
            "Checked into the repo, so it runs for everyone who clones it. Its "
            "hooks join the user's rather than standing in for them."
        ),
    ),
    ContributorSource(
        slug=SOURCE_PROJECT_LOCAL,
        label="Project-local settings",
        where="<repo>/.claude/settings.local.json",
        observable=True,
        note=(
            "The gitignored sibling of the project file, for one developer's "
            "own additions. Adds to the merge like any other source."
        ),
    ),
    ContributorSource(
        slug=SOURCE_SETTINGS_FLAG,
        label="--settings flag",
        where="a file named on the command line",
        observable=False,
        note=(
            "A settings file handed to the CLI per invocation. The path is "
            "chosen in the argv of the process that ran the hook, which this "
            "app never sees, so its contribution is unknown rather than zero — "
            "it is listed here so its absence from the counts is explicit."
        ),
    ),
    ContributorSource(
        slug=SOURCE_MANAGED_POLICY,
        label="Managed policy settings",
        where="the OS-level managed settings file",
        observable=True,
        note=(
            "Installed by an administrator outside the user's home directory. "
            "Usually absent on a personal machine; when present its hooks run "
            "alongside everything else rather than replacing it."
        ),
    ),
    ContributorSource(
        slug=SOURCE_PLUGIN,
        label="Plugin hooks",
        where="<plugin>/hooks/hooks.json",
        observable=True,
        note=(
            "Every installed plugin may ship its own hooks file, and all of "
            "them are merged in. A malformed one is what the CLI reports as "
            "'Failed to merge hooks from <manifest>'."
        ),
    ),
    ContributorSource(
        slug=SOURCE_SKILL,
        label="Skill frontmatter",
        where="<skill>/SKILL.md frontmatter",
        observable=True,
        note=(
            "A skill can declare hooks in its own frontmatter, which is easy "
            "to miss because nothing about the file looks like a settings file."
        ),
    ),
    ContributorSource(
        slug=SOURCE_AGENT,
        label="Agent definition",
        where="<agents dir>/<agent>.md frontmatter",
        observable=True,
        note=(
            "An agent definition can carry a hooks block too, and an agent is "
            "installed the same way a prompt is — by dropping in a file."
        ),
    ),
)

assert len(CONTRIBUTOR_SOURCES) == 8, "the contributor list is eight sources"

SOURCES_BY_SLUG: dict[str, ContributorSource] = {
    source.slug: source for source in CONTRIBUTOR_SOURCES
}


# ─── the catalog ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class HookEventCatalogEntry:
    """One hook event and every source that can put something on it.

    ``sources`` is all eight, always, in a fixed order — not "the sources that
    happened to contribute". Any event can be targeted from any of them, so an
    entry that listed only the populated ones would change shape depending on
    what is installed and would let a source disappear from the report exactly
    when a reader most needs to see that it is empty.
    """

    event: str
    tier: str
    ingest_path: str
    sources: tuple[ContributorSource, ...]


HOOK_EVENT_CATALOG: dict[str, HookEventCatalogEntry] = {
    spec.event: HookEventCatalogEntry(
        event=spec.event,
        tier=spec.tier,
        ingest_path=spec.path,
        sources=CONTRIBUTOR_SOURCES,
    )
    # Built from `hooks_service.HOOK_EVENTS` rather than from a list of event
    # names kept here. That registry is the one enumeration of ingested events
    # (#168) and a second copy of it is the exact defect its module docstring
    # exists to prevent: an event added there and forgotten here would be an
    # event this report silently claims nothing runs on.
    for spec in hooks_service.HOOK_EVENTS
}


# ─── scanning limits ─────────────────────────────────────────────────────────

# Per-source ceiling on how many files one scan will open. A plugins directory
# with a runaway install count, or a skills tree someone symlinked a source
# checkout into, must not turn a page load into a thousand-file read. The cap
# is reported as a `truncated` scan status rather than silently applied, so a
# short answer is never mistaken for a complete one.
_MAX_FILES_PER_SOURCE = 200

# Glob patterns for plugin hook files, relative to a config home. Fixed depths
# rather than a recursive `**`: a plugin lives at a known place (installed
# directly, or under a marketplace repo directory), and an unbounded walk of a
# directory the user can fill with anything is a cost with no upper bound.
_PLUGIN_HOOK_GLOBS: tuple[str, ...] = (
    "plugins/*/hooks/hooks.json",
    "plugins/*/*/hooks/hooks.json",
    "plugins/repos/*/*/hooks/hooks.json",
)

_SKILL_GLOB = "skills/*/SKILL.md"
_AGENT_GLOB = "agents/*.md"

# Where an administrator's managed settings file lives, per platform. These are
# fixed constants rather than caller input, which is why they are exempt from
# the home-directory scan guard below: the guard exists to stop a localhost
# caller from naming an arbitrary path, and nobody names these.
_MANAGED_POLICY_PATHS: dict[str, tuple[str, ...]] = {
    "darwin": ("/Library/Application Support/ClaudeCode/managed-settings.json",),
    "win32": ("C:\\ProgramData\\ClaudeCode\\managed-settings.json",),
}
_MANAGED_POLICY_DEFAULT: tuple[str, ...] = ("/etc/claude-code/managed-settings.json",)

# Shown instead of an executable name when a hook's command cannot be parsed
# into one. Never the raw string — an unparseable command is the case where
# guessing is least safe.
_UNRESOLVED_EXECUTABLE = "(unresolved)"


def managed_policy_paths() -> tuple[Path, ...]:
    """The managed settings files to look for on this platform."""
    raw = _MANAGED_POLICY_PATHS.get(sys.platform, _MANAGED_POLICY_DEFAULT)
    return tuple(Path(path) for path in raw)


# ─── command redaction ───────────────────────────────────────────────────────

# Leading `NAME=value` env assignments, which a hook command may stack any
# number of before the program it actually runs.
_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# Wrappers that take the real program as their next non-flag argument. Stepping
# through them gives a more useful name than "env" without ever reaching into
# the argument list for anything but the program itself.
_COMMAND_WRAPPERS: frozenset[str] = frozenset({"env", "command", "exec", "nohup"})


def executable_name(command: str) -> str:
    """The program a hook command runs, with every argument discarded.

    This is the only part of a third-party command that leaves this module, so
    it is written to be incapable of returning an argument. It takes the first
    token that is not an env assignment or a wrapper, and returns that token's
    basename — never a flag, never a value, never a path that could name a
    directory the user would rather not publish. A command it cannot parse
    yields the placeholder rather than a best guess.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        # Unbalanced quotes: fall back to whitespace splitting, which cannot
        # fail and cannot widen what is returned (still token zero, basename).
        tokens = command.split()

    for token in tokens:
        if _ENV_ASSIGNMENT.match(token):
            continue
        if token.startswith("-"):
            continue
        name = Path(token).name
        if not name:
            continue
        if name in _COMMAND_WRAPPERS:
            continue
        return name
    return _UNRESOLVED_EXECUTABLE


def authored_commands(base_url: str) -> frozenset[str]:
    """Every hook command string this app itself emits, exactly as written.

    This is the whole of what counts as ours. The 22 commands are fully
    deterministic — ``hooks_service.build_hook_settings`` mints them from
    ``HOOK_EVENTS`` and a base URL, with no per-machine part — so the exact set
    is available to compare against, and it is generated here by calling that
    same builder rather than by re-deriving the string, which keeps the two
    from drifting.

    Built across every loopback spelling of the base URL, so a hook wired at
    ``127.0.0.1`` is recognised as ours exactly like one wired at
    ``localhost``.
    """
    commands: set[str] = set()
    for base in hooks_service._equivalent_base_urls(base_url):
        block = hooks_service.build_hook_settings(base).get("hooks", {})
        for entries in block.values():
            for entry in entries:
                for hook in entry.get("hooks", []):
                    command = hook.get("command")
                    if isinstance(command, str) and command.strip():
                        commands.add(command.strip())
    return frozenset(commands)


def _is_codenest_authored(raw: str | None, authored: Container[str]) -> bool:
    """Whether *raw* is, character for character, one of our own commands.

    Fails closed by construction, which a substring test does not. Asking
    whether a command *contains* one of our endpoint URLs answers the wrong
    question: a shell string somebody else wrote can mention our ingest URL and
    still be theirs, and the ones that mention it are exactly the ones likely
    to be carrying an ``Authorization:`` header or a ``--key=`` beside it. Two
    real shapes that a containment test hands back whole are
    ``curl -H 'Authorization: Bearer ...' -X POST <our url>`` and
    ``echo <our url> && /opt/x.sh --key=...``; set membership admits neither,
    because neither is a string this module generates.

    So the only thing that passes is equality with a command
    ``authored_commands`` produced. ``None``, an empty string, a lookalike on
    another host, a lookalike on *this* host, and anything that wraps, prefixes
    or extends one of ours are all somebody else's, and somebody else's command
    never leaves this module whole.
    """
    if not raw:
        return False
    return raw.strip() in authored


# ─── one declared hook ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class HookContribution:
    """One hook, as declared by one file, on one event.

    ``command`` is populated only when ``codenest_authored`` is true; for
    everything else it is ``None`` and ``redacted`` is true, leaving
    ``executable`` as the whole of what the caller learns about the program.
    The two flags are kept separate so the frontend can explain the gap ("this
    hook was written elsewhere") rather than rendering a blank cell.
    """

    event: str
    source: str
    origin: str
    matcher: str | None
    hook_type: str
    executable: str
    command: str | None
    redacted: bool
    codenest_authored: bool
    timeout_seconds: int | None


def _as_int(value: object) -> int | None:
    """An int from a JSON/frontmatter value, or None. Never raises — a hook
    with a nonsense timeout is still a hook that runs, and dropping it because
    its timeout is a string would undercount the event."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _url_identity(url: str) -> str:
    """Host (and port) of *url*, with userinfo, path and query all discarded.

    ``netloc`` is the wrong field to reach for here: it carries any
    ``user:password@`` prefix verbatim, so reducing a hook URL to its netloc
    publishes a basic-auth credential in the one field that exists to be safe —
    and publishes it on a hook that is otherwise correctly marked redacted,
    which is worse than not redacting at all. ``hostname`` plus an explicit
    port is the part a reader needs and is incapable of carrying a secret.

    Never raises. A hook URL is user file content and ``urlsplit`` rejects some
    spellings of it — an unterminated IPv6 literal for one, an out-of-range
    port for another — and a file this module cannot parse is a status to
    report, not a 500.
    """
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return _UNRESOLVED_EXECUTABLE
    if not hostname:
        return _UNRESOLVED_EXECUTABLE
    host = f"[{hostname}]" if ":" in hostname else hostname
    return f"{host}:{port}" if port is not None else host


def _hook_identity(hook: Mapping[str, Any]) -> tuple[str, str, str | None]:
    """``(hook_type, safe_identifier, raw)`` for one declared hook.

    ``raw`` is the command (or legacy ``url``) exactly as written and is the
    caller's input to the authorship check — it is not, on its own, safe to
    return. ``safe_identifier`` always is: an executable basename for a command
    hook, and for an ``http`` hook the host and port only, because a hook URL's
    path and query are as capable of carrying a signature or token as an argv.
    """
    command = hook.get("command")
    if isinstance(command, str) and command.strip():
        declared = hook.get("type")
        hook_type = declared if isinstance(declared, str) else "command"
        return hook_type, executable_name(command), command

    url = hook.get("url")
    if isinstance(url, str) and url.strip():
        declared = hook.get("type")
        hook_type = declared if isinstance(declared, str) else "http"
        return hook_type, _url_identity(url.strip()), url

    declared = hook.get("type")
    hook_type = declared if isinstance(declared, str) else "unknown"
    return hook_type, _UNRESOLVED_EXECUTABLE, None


def _contribution(
    hook: Mapping[str, Any],
    *,
    event: str,
    source: str,
    origin: str,
    matcher: object,
    authored: Container[str],
) -> HookContribution:
    hook_type, safe, raw = _hook_identity(hook)
    ours = _is_codenest_authored(raw, authored)
    return HookContribution(
        event=event,
        source=source,
        origin=origin,
        matcher=matcher if isinstance(matcher, str) else None,
        hook_type=hook_type,
        executable=safe,
        command=raw if ours else None,
        redacted=not ours,
        codenest_authored=ours,
        timeout_seconds=_as_int(hook.get("timeout")),
    )


# ─── reading a hooks block out of a settings-shaped document ─────────────────


def iter_declared_hooks(
    hooks_block: object, event: str
) -> list[tuple[object, Mapping[str, Any]]]:
    """``(matcher, hook)`` pairs declared for *event*, in declaration order.

    Accepts both shapes a real file uses: the current
    ``{"matcher": ..., "hooks": [...]}`` wrapper, and the flat form where a
    hook dict sits directly in the event's array. The flat form is accepted
    rather than rejected because the harness is not what this function is
    modelling — a malformed entry that the CLI refuses is still an entry
    somebody put there believing it would run, and a report whose job is
    "what is on this event" is more useful listing it than pretending the file
    is empty. Anything that is not a dict is skipped; a hooks block is user
    input and this must not raise.
    """
    if not isinstance(hooks_block, Mapping):
        return []
    entries = hooks_block.get(event)
    if isinstance(entries, Mapping):
        entries = [entries]
    if not isinstance(entries, list):
        return []

    found: list[tuple[object, Mapping[str, Any]]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        wrapped = entry.get("hooks")
        if isinstance(wrapped, list):
            matcher = entry.get("matcher")
            for hook in wrapped:
                if isinstance(hook, Mapping):
                    found.append((matcher, hook))
        else:
            found.append((entry.get("matcher"), entry))
    return found


# ─── reading a hooks block out of markdown frontmatter ───────────────────────

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)
_EVENT_KEY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$")


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())


def _parse_hook_items(lines: Sequence[str]) -> list[dict[str, str]]:
    """The hook mappings nested under one event key in a frontmatter block."""
    items: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "-" or stripped.startswith("- "):
            current = {}
            items.append(current)
            stripped = stripped[1:].strip()
            if not stripped:
                continue
        if current is None:
            # A mapping written without a leading dash — a single hook rather
            # than a list of them.
            current = {}
            items.append(current)
        key, separator, value = stripped.partition(":")
        if not separator:
            continue
        key = key.strip()
        if key:
            current[key] = _unquote(value)
    return [item for item in items if item]


def parse_frontmatter_hooks(text: str) -> dict[str, list[dict[str, str]]]:
    """The ``hooks:`` block of a skill or agent file, as ``event -> hooks``.

    Deliberately a narrow reader, not a YAML parser. This repo has no YAML
    dependency and adding one to read a handful of ``command:`` lines would be
    a large new trust surface for a small gain, so this extends the existing
    ``project_scanner_service._parse_frontmatter`` approach — simple
    ``key: value`` lines — by exactly the one nesting level a hooks block uses:
    ``hooks:``, then an event name, then either a scalar command or a list of
    mappings. Anything more elaborate (anchors, block scalars, flow sequences)
    yields fewer hooks than are really there, which is the right way for this
    to be wrong: the report undercounts visibly rather than inventing entries.
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}
    lines = match.group(1).splitlines()

    start: int | None = None
    outer_indent = 0
    for index, line in enumerate(lines):
        if line.strip() == "hooks:":
            start = index
            outer_indent = _indent_of(line)
            break
    if start is None:
        return {}

    body: list[str] = []
    for line in lines[start + 1 :]:
        if not line.strip():
            continue
        if _indent_of(line) <= outer_indent:
            break
        body.append(line)
    if not body:
        return {}

    base_indent = min(_indent_of(line) for line in body)
    out: dict[str, list[dict[str, str]]] = {}
    event: str | None = None
    buffered: list[str] = []

    def flush() -> None:
        nonlocal event, buffered
        if event is not None and buffered:
            parsed = _parse_hook_items(buffered)
            if parsed:
                out.setdefault(event, []).extend(parsed)
        event, buffered = None, []

    for line in body:
        if _indent_of(line) == base_indent:
            key_match = _EVENT_KEY_RE.match(line.strip())
            if key_match is None:
                continue
            flush()
            name = key_match.group(1)
            inline = _unquote(key_match.group(2))
            if inline:
                # `PreToolUse: ./guard.sh` — the scalar form, one hook.
                out.setdefault(name, []).append({"command": inline})
            else:
                event = name
            continue
        if event is not None:
            buffered.append(line)
    flush()
    return out


# ─── the filesystem walk ─────────────────────────────────────────────────────


@dataclass
class _Scan:
    """Accumulator for one scan: the files opened and the hooks found.

    Mutable (unlike everything else here) because it is a local built up over
    a single synchronous pass and never shared or stored.
    """

    authored: frozenset[str]
    files: list[dict[str, Any]]
    contributions: list[HookContribution]


def _record_file(
    scan: _Scan, source: str, path: Path | str, status: str, detail: str | None
) -> None:
    scan.files.append(
        {"source": source, "path": str(path), "status": status, "detail": detail}
    )


def _in_scan_scope(path: Path) -> str | None:
    """``None`` when *path* may be read, else the reason it may not.

    Reuses ``project_scanner_service``'s guard rather than growing a second
    one. The endpoints that reach this module are unauthenticated localhost
    routes like the import preview, so the same policy has to hold: a
    caller-supplied path stays inside the home tree and out of the directories
    that hold credentials.
    """
    try:
        project_scanner_service._require_scan_scope(path)
    except (ValueError, OSError, RuntimeError) as exc:
        return str(exc)
    return None


def _harvest_settings_file(scan: _Scan, source: str, path: Path) -> None:
    """Read one settings-shaped JSON file and file its hooks under *source*."""
    try:
        status, parsed, detail = hooks_service._read_settings(path)
    except (OSError, ValueError) as exc:
        # `_read_settings` guards its own reads, but it probes the path first
        # (`is_absolute`, `is_dir`) and a path long enough or malformed enough
        # to fail that probe raises straight through. One unreadable file is a
        # status to report; this route promises it never 5xxs on the state of
        # a user's files.
        _record_file(scan, source, path, "unreadable", str(exc))
        return
    _record_file(scan, source, path, status, detail)
    if status != "ok" or not isinstance(parsed, Mapping):
        return
    hooks_block = parsed.get("hooks")
    for event in HOOK_EVENT_CATALOG:
        for matcher, hook in iter_declared_hooks(hooks_block, event):
            scan.contributions.append(
                _contribution(
                    hook,
                    event=event,
                    source=source,
                    origin=str(path),
                    matcher=matcher,
                    authored=scan.authored,
                )
            )


def _harvest_frontmatter_file(scan: _Scan, source: str, path: Path) -> None:
    """Read one markdown file and file its frontmatter hooks under *source*."""
    try:
        if path.stat().st_size > hooks_service._MAX_SETTINGS_BYTES:
            _record_file(
                scan, source, path, "unreadable", "file is over the read limit"
            )
            return
        text = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        _record_file(scan, source, path, "missing_file", None)
        return
    except OSError as exc:
        _record_file(scan, source, path, "unreadable", str(exc))
        return

    declared = parse_frontmatter_hooks(text)
    _record_file(scan, source, path, "ok", None)
    for event, hooks in declared.items():
        if event not in HOOK_EVENT_CATALOG:
            continue
        for hook in hooks:
            scan.contributions.append(
                _contribution(
                    hook,
                    event=event,
                    source=source,
                    origin=str(path),
                    matcher=hook.get("matcher"),
                    authored=scan.authored,
                )
            )


def _globbed(root: Path, patterns: Sequence[str]) -> list[Path]:
    """Files under *root* matching *patterns*, capped and deterministically
    ordered. ``glob`` yields in directory order, which differs between
    machines; sorting makes two scans of the same tree produce the same
    report."""
    found: list[Path] = []
    for pattern in patterns:
        try:
            found.extend(path for path in root.glob(pattern) if path.is_file())
        except OSError:
            # An unreadable directory in the middle of a glob is a permissions
            # fact about one plugin, not a reason to fail the whole report.
            continue
    return sorted(set(found))


def _harvest_globbed(
    scan: _Scan,
    source: str,
    root: Path,
    patterns: Sequence[str],
    settings_shaped: bool,
) -> None:
    matches = _globbed(root, patterns)
    if len(matches) > _MAX_FILES_PER_SOURCE:
        _record_file(
            scan,
            source,
            root,
            "truncated",
            f"{len(matches)} files matched; read the first {_MAX_FILES_PER_SOURCE}",
        )
        matches = matches[:_MAX_FILES_PER_SOURCE]
    for path in matches:
        if settings_shaped:
            _harvest_settings_file(scan, source, path)
        else:
            _harvest_frontmatter_file(scan, source, path)


def _scan_config_home(scan: _Scan, config_home: str) -> None:
    """The four sources rooted at a Claude config home."""
    try:
        root = Path(hooks_service.settings_json_path(config_home)).parent.resolve()
    except (OSError, ValueError, RuntimeError) as exc:
        # A caller-supplied config home is user input all the way down:
        # `~nosuchuser` raises RuntimeError out of `expanduser`, an embedded
        # NUL raises ValueError, and an over-long path raises OSError. Each is
        # one unreadable root, not a failed request.
        _record_file(scan, SOURCE_USER, config_home, "unreadable", str(exc))
        return
    denial = _in_scan_scope(root)
    if denial is not None:
        _record_file(scan, SOURCE_USER, root, "out_of_scope", denial)
        return
    _harvest_settings_file(scan, SOURCE_USER, root / "settings.json")
    _harvest_globbed(scan, SOURCE_PLUGIN, root, _PLUGIN_HOOK_GLOBS, True)
    _harvest_globbed(scan, SOURCE_SKILL, root, (_SKILL_GLOB,), False)
    _harvest_globbed(scan, SOURCE_AGENT, root, (_AGENT_GLOB,), False)


def _scan_project_root(scan: _Scan, project_root: str) -> None:
    """The four sources rooted at a repository's ``.claude`` directory."""
    try:
        root = Path(project_root).expanduser().resolve()
    except (OSError, ValueError, RuntimeError) as exc:
        # Same three shapes as a config home, and the same rule: a project root
        # this module cannot even name becomes a `scanned` row.
        _record_file(scan, SOURCE_PROJECT, project_root, "unreadable", str(exc))
        return
    denial = _in_scan_scope(root)
    if denial is not None:
        _record_file(scan, SOURCE_PROJECT, root, "out_of_scope", denial)
        return

    claude_dir = root / ".claude"
    _harvest_settings_file(scan, SOURCE_PROJECT, claude_dir / "settings.json")
    _harvest_settings_file(
        scan, SOURCE_PROJECT_LOCAL, claude_dir / "settings.local.json"
    )
    _harvest_globbed(scan, SOURCE_SKILL, claude_dir, (_SKILL_GLOB,), False)
    _harvest_globbed(scan, SOURCE_AGENT, claude_dir, (_AGENT_GLOB,), False)


def _scan_managed_policy(scan: _Scan) -> None:
    for path in managed_policy_paths():
        _harvest_settings_file(scan, SOURCE_MANAGED_POLICY, path)


# ─── assembling the answer ───────────────────────────────────────────────────


def _event_report(
    event: str, entry: HookEventCatalogEntry, found: Sequence[HookContribution]
) -> dict[str, Any]:
    by_source: list[dict[str, Any]] = []
    total = 0
    for source in entry.sources:
        rows = [c for c in found if c.source == source.slug]
        total += len(rows)
        by_source.append(
            {
                "source": source.slug,
                "label": source.label,
                "observable": source.observable,
                "count": len(rows),
                "contributions": [vars(row) for row in rows],
            }
        )
    return {
        "event": event,
        "tier": entry.tier,
        "ingest_path": entry.ingest_path,
        # The sum across all eight buckets, and the number this whole module
        # exists to produce: how many separate programs sit on this event.
        # Nothing is deducted from it — every hook found is a hook that runs.
        "total": total,
        "by_source": by_source,
    }


def _collect_sync(
    config_homes: Sequence[str], project_roots: Sequence[str], base: str
) -> dict[str, Any]:
    scan = _Scan(authored=authored_commands(base), files=[], contributions=[])
    for config_home in config_homes:
        _scan_config_home(scan, config_home)
    for project_root in project_roots:
        _scan_project_root(scan, project_root)
    _scan_managed_policy(scan)

    by_event: dict[str, list[HookContribution]] = {
        event: [] for event in HOOK_EVENT_CATALOG
    }
    for contribution in scan.contributions:
        by_event[contribution.event].append(contribution)

    return {
        "base_url": base,
        "sources": [vars(source) for source in CONTRIBUTOR_SOURCES],
        "scanned": scan.files,
        "events": [
            _event_report(event, entry, by_event[event])
            for event, entry in HOOK_EVENT_CATALOG.items()
        ],
    }


async def build_effective_hooks(
    config_homes: Sequence[str],
    project_roots: Sequence[str],
    base_url: str | None = None,
) -> dict[str, Any]:
    """Every hook on every event, merged across all eight contributor sources.

    Read-only and off the event loop in one ``asyncio.to_thread`` hop, matching
    ``hooks_service.verify_settings_files``: this opens a variable number of
    files under directories the user controls, and none of that may stall the
    requests the sidecar is serving alongside it — the hook ingest routes above
    all share this one process.

    No file this touches is ever written, and no error from one file fails the
    request. A missing, unreadable, oversized or malformed file becomes an
    entry in ``scanned`` with its own status, because "the project settings
    file is not valid JSON" is a thing the reader needs told, not a 500.
    """
    return await asyncio.to_thread(
        _collect_sync,
        list(config_homes),
        list(project_roots),
        (base_url or hooks_service.sidecar_base_url()).rstrip("/"),
    )
