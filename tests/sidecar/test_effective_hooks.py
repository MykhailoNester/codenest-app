"""Tests for the effective-hooks read (#169).

Four of these assertions are the ticket's own acceptance criteria written down
as code, and each guards something that is invisible at the call site that
would break it:

1. **All eight sources, on every event.** The count is eight, not five: the
   five settings scopes plus plugin, skill and agent files. A merge that quietly
   dropped one would still return a plausible-looking report — a smaller number
   with no gap in it — which is precisely the failure mode this whole read
   exists to end.
2. **The vocabulary check.** The module must not describe hooks with the words
   that belong to scalar-settings resolution. Hooks accumulate: every hook found
   on an event runs, in addition to all the others. A docstring that reached for
   the resolution vocabulary would teach the reader the opposite of how the
   thing works, and no behavioural test can catch prose.
3. **No timing.** Hook payloads carry none and a transcript can only time this
   app's own hook, so any duration in this response would describe one
   contributor out of eight while appearing to describe the event. The
   assertion is on the serialized response, not on the model's field list,
   because a duration could just as easily arrive inside a string.
4. **Redaction.** A hook command is an arbitrary shell string somebody else
   wrote and can carry a token in its argv. This response reaches the frontend
   and every log between here and there, so the test plants a credential in a
   third-party command and asserts it is nowhere in the serialized report.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

import pytest

from app.services import effective_hooks_service as effective
from app.services import hooks_service

_BASE = "http://localhost:8002"

# Planted credentials. Each one sits in a third-party hook's argument list; not
# one of them may appear anywhere in the serialized report.
_USER_SECRET = "sk-user-secret-1"
_PLUGIN_SECRET = "sk-plugin-secret-2"
_SKILL_SECRET = "sk-skill-secret-3"
_AGENT_SECRET = "sk-agent-secret-4"
_PROJECT_SECRET = "sk-project-secret-5"
_LOCAL_SECRET = "sk-local-secret-6"
_POLICY_SECRET = "sk-policy-secret-7"

# The three shapes that a containment test for authorship, and a `netloc`
# reduction of a hook URL, both hand back intact. Each sits on `PostToolUse`
# so the `PreToolUse` arithmetic above stays exactly eight.
_SAME_HOST_SECRET = "sk-same-host-secret-8"  # bearer header beside OUR ingest URL
_CHAINED_SECRET = "sk-chained-secret-9"  # our URL echoed, then a real command
_BASIC_AUTH_SECRET = "sk-basic-auth-secret-10"  # `user:password@` in a hook URL

_ALL_SECRETS = (
    _USER_SECRET,
    _PLUGIN_SECRET,
    _SKILL_SECRET,
    _AGENT_SECRET,
    _PROJECT_SECRET,
    _LOCAL_SECRET,
    _POLICY_SECRET,
    _SAME_HOST_SECRET,
    _CHAINED_SECRET,
    _BASIC_AUTH_SECRET,
)


def _settings_hook(command: str, matcher: str = "*") -> dict[str, Any]:
    return {
        "matcher": matcher,
        "hooks": [{"type": "command", "command": command, "timeout": 6}],
    }


def _write_json(path: Path, body: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2), encoding="utf-8")


def _ours_pre_tool_command() -> str:
    """The real command this app generates for PreToolUse, not a lookalike."""
    block = hooks_service.build_hook_settings(_BASE)["hooks"]
    command = block["PreToolUse"][0]["hooks"][0]["command"]
    assert isinstance(command, str)
    return command


@pytest.fixture
def eight_sources(tmp_path: Path) -> dict[str, Any]:
    """A tree carrying one PreToolUse hook from every observable source.

    Seven contributions land on `PreToolUse` from seven different files, plus
    this app's own hook in the user file — eight rows on one event, from the
    seven sources that exist on disk. The eighth source (`--settings`) has no
    file by definition and is what the merge must still account for.
    """
    config_home = tmp_path / "claude-home"
    project_root = tmp_path / "repo"
    policy_file = tmp_path / "policy" / "managed-settings.json"

    # 1. user settings — this app's own hook plus a third-party one.
    _write_json(
        config_home / "settings.json",
        {
            "hooks": {
                "PreToolUse": [
                    _settings_hook(_ours_pre_tool_command()),
                    _settings_hook(f"/usr/local/bin/notify --token={_USER_SECRET}"),
                ],
                # Four hostile shapes, none of them ours, all of them written
                # by somebody who is not this app:
                #   1. a curl at OUR ingest URL with a bearer token beside it,
                #   2. our URL echoed and then a real program run,
                #   3. an `http` hook with a basic-auth credential in the URL,
                #   4. an `http` hook whose URL `urlsplit` refuses outright.
                "PostToolUse": [
                    _settings_hook(
                        "curl -H 'Authorization: Bearer "
                        f"{_SAME_HOST_SECRET}' -X POST "
                        f"{_BASE}/api/v1/hooks/post-tool"
                    ),
                    _settings_hook(
                        f"echo {_BASE}/api/v1/hooks/stop && "
                        f"/opt/x.sh --key={_CHAINED_SECRET}"
                    ),
                    {
                        "matcher": "*",
                        "hooks": [
                            {
                                "type": "http",
                                "url": (
                                    f"https://deploy:{_BASIC_AUTH_SECRET}"
                                    "@hooks.example.com:8443/n?sig=abc"
                                ),
                            },
                            {"type": "http", "url": "http://[oops"},
                        ],
                    },
                ],
            }
        },
    )

    # 2. plugin hooks.json
    _write_json(
        config_home / "plugins" / "acme" / "hooks" / "hooks.json",
        {
            "hooks": {
                "PreToolUse": [
                    _settings_hook(
                        f"python3 /opt/acme/hook.py --secret={_PLUGIN_SECRET}"
                    )
                ]
            }
        },
    )

    # 3. skill frontmatter — the list form.
    skill = config_home / "skills" / "guard" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text(
        "---\n"
        "name: guard\n"
        "description: A guard skill\n"
        "hooks:\n"
        "  PreToolUse:\n"
        "    - matcher: Bash\n"
        f"      command: ./skill-guard.sh --token={_SKILL_SECRET}\n"
        "---\n\n# Guard\n",
        encoding="utf-8",
    )

    # 4. agent definition — the inline scalar form.
    agent = config_home / "agents" / "reviewer.md"
    agent.parent.mkdir(parents=True, exist_ok=True)
    agent.write_text(
        "---\n"
        "name: reviewer\n"
        "hooks:\n"
        f"  PreToolUse: /opt/tools/agent-guard --key={_AGENT_SECRET}\n"
        "---\n\nReview things.\n",
        encoding="utf-8",
    )

    # 5 + 6. project and project-local settings.
    _write_json(
        project_root / ".claude" / "settings.json",
        {
            "hooks": {
                "PreToolUse": [
                    _settings_hook(f"./scripts/repo-guard.sh --pw={_PROJECT_SECRET}")
                ]
            }
        },
    )
    _write_json(
        project_root / ".claude" / "settings.local.json",
        {
            "hooks": {
                "PreToolUse": [
                    _settings_hook(f"bash -c 'send {_LOCAL_SECRET}'", matcher="Bash")
                ]
            }
        },
    )

    # 7. managed policy.
    _write_json(
        policy_file,
        {
            "hooks": {
                "PreToolUse": [
                    _settings_hook(f"/opt/corp/audit --auth={_POLICY_SECRET}")
                ]
            }
        },
    )

    return {
        "config_homes": [str(config_home)],
        "project_roots": [str(project_root)],
        "policy_file": policy_file,
    }


@pytest.fixture
def report(eight_sources, monkeypatch) -> dict[str, Any]:
    """The merged report for the eight-source tree, as the router would build it."""
    monkeypatch.setattr(
        effective, "managed_policy_paths", lambda: (eight_sources["policy_file"],)
    )
    import asyncio

    return asyncio.run(
        effective.build_effective_hooks(
            eight_sources["config_homes"],
            eight_sources["project_roots"],
            base_url=_BASE,
        )
    )


def _event(report: dict[str, Any], name: str) -> dict[str, Any]:
    matches = [entry for entry in report["events"] if entry["event"] == name]
    assert len(matches) == 1, name
    return matches[0]


def _bucket(event: dict[str, Any], source: str) -> dict[str, Any]:
    matches = [b for b in event["by_source"] if b["source"] == source]
    assert len(matches) == 1, source
    return matches[0]


# ─── the catalog ─────────────────────────────────────────────────────────────


def test_catalog_covers_every_ingested_event() -> None:
    """Built from the registry, not from a second list of event names.

    A catalog with its own copy of the event names would go stale the first
    time an event was added to `hooks_service.HOOK_EVENTS`, and the symptom
    would be this report claiming nothing runs on an event that is very much
    live.
    """
    assert set(effective.HOOK_EVENT_CATALOG) == {
        spec.event for spec in hooks_service.HOOK_EVENTS
    }
    for spec in hooks_service.HOOK_EVENTS:
        entry = effective.HOOK_EVENT_CATALOG[spec.event]
        assert entry.tier == spec.tier
        assert entry.ingest_path == spec.path


def test_every_catalog_entry_lists_all_eight_sources() -> None:
    """Eight, on every event, populated or not."""
    assert len(effective.CONTRIBUTOR_SOURCES) == 8
    assert {source.slug for source in effective.CONTRIBUTOR_SOURCES} == {
        effective.SOURCE_USER,
        effective.SOURCE_PROJECT,
        effective.SOURCE_PROJECT_LOCAL,
        effective.SOURCE_SETTINGS_FLAG,
        effective.SOURCE_MANAGED_POLICY,
        effective.SOURCE_PLUGIN,
        effective.SOURCE_SKILL,
        effective.SOURCE_AGENT,
    }
    for entry in effective.HOOK_EVENT_CATALOG.values():
        assert len(entry.sources) == 8, entry.event


def test_exactly_one_source_is_not_readable_off_disk() -> None:
    """`--settings` is named on a command line this app never sees.

    It is carried with `observable=False` rather than left out, because a
    source missing from the list reads as "nothing contributes here" — the one
    statement this report must never make by accident.
    """
    unobservable = [s for s in effective.CONTRIBUTOR_SOURCES if not s.observable]
    assert [s.slug for s in unobservable] == [effective.SOURCE_SETTINGS_FLAG]
    assert unobservable[0].note


# ─── the vocabulary the module may not use ───────────────────────────────────


def test_module_avoids_the_scalar_resolution_vocabulary() -> None:
    """Hooks accumulate; every hook on an event runs alongside every other.

    The banned words all belong to how Claude Code resolves *scalar* settings,
    where consulting several scopes yields one value. Hook blocks are not
    resolved that way — they are merged — so a docstring reaching for that
    vocabulary would teach a reader the exact opposite of the behaviour, and
    prose is the one thing no behavioural test can check.
    """
    banned = re.compile(r"winner|winning|shadow|overridden|precedence", re.IGNORECASE)
    for module in (effective, __import__("app.models.effective_hooks", fromlist=["x"])):
        source = Path(module.__file__ or "").read_text(encoding="utf-8")
        hits = banned.findall(source)
        assert not hits, f"{module.__name__} uses {sorted(set(hits))}"


def test_module_says_out_loud_that_hooks_merge_and_all_run() -> None:
    """The positive half of the rule above — the claim must actually be made."""
    doc = (effective.__doc__ or "").lower()
    assert "merge" in doc
    assert "every one of them runs" in doc


# ─── the eight-source merge ──────────────────────────────────────────────────


def test_merge_collects_every_source_on_one_event(report) -> None:
    """Seven files contribute eight hooks to PreToolUse; none is dropped."""
    pre_tool = _event(report, "PreToolUse")
    counts = {b["source"]: b["count"] for b in pre_tool["by_source"]}
    assert counts == {
        effective.SOURCE_USER: 2,  # this app's own hook + a third-party one
        effective.SOURCE_PROJECT: 1,
        effective.SOURCE_PROJECT_LOCAL: 1,
        effective.SOURCE_MANAGED_POLICY: 1,
        effective.SOURCE_PLUGIN: 1,
        effective.SOURCE_SKILL: 1,
        effective.SOURCE_AGENT: 1,
        # No file on disk can populate this one, so it is always zero and the
        # note on the source is what explains why.
        effective.SOURCE_SETTINGS_FLAG: 0,
    }
    assert pre_tool["total"] == 8
    assert pre_tool["total"] == sum(counts.values())


def test_total_is_a_sum_and_never_a_selection(report) -> None:
    """The arithmetic that encodes the behaviour: nothing is deducted.

    Two hooks in the same file, on the same event, under the same matcher, both
    count — which is the case a reader is most likely to assume collapses to
    one.
    """
    pre_tool = _event(report, "PreToolUse")
    user = _bucket(pre_tool, effective.SOURCE_USER)
    assert user["count"] == 2
    assert len(user["contributions"]) == 2
    assert {c["matcher"] for c in user["contributions"]} == {"*"}
    for entry in report["events"]:
        assert entry["total"] == sum(b["count"] for b in entry["by_source"])


def test_every_event_reports_all_eight_buckets(report) -> None:
    for entry in report["events"]:
        assert len(entry["by_source"]) == 8, entry["event"]
        assert [b["source"] for b in entry["by_source"]] == [
            s.slug for s in effective.CONTRIBUTOR_SOURCES
        ]


def test_an_event_nothing_targets_still_reports_its_sources(report) -> None:
    """Nothing in the tree declares a `SessionEnd` hook.

    The entry must still be there, and must still carry all eight buckets at
    zero. An event that vanished when empty would make "nothing runs here" and
    "this event does not exist" the same answer.
    """
    session_end = _event(report, "SessionEnd")
    assert session_end["total"] == 0
    assert len(session_end["by_source"]) == 8
    assert all(bucket["count"] == 0 for bucket in session_end["by_source"])
    assert all(bucket["contributions"] == [] for bucket in session_end["by_source"])


def test_each_file_the_scan_touched_is_reported(report) -> None:
    scanned = {
        (f["source"], Path(f["path"]).name): f["status"] for f in report["scanned"]
    }
    assert scanned[(effective.SOURCE_USER, "settings.json")] == "ok"
    assert scanned[(effective.SOURCE_PROJECT, "settings.json")] == "ok"
    assert scanned[(effective.SOURCE_PROJECT_LOCAL, "settings.local.json")] == "ok"
    assert scanned[(effective.SOURCE_PLUGIN, "hooks.json")] == "ok"
    assert scanned[(effective.SOURCE_SKILL, "SKILL.md")] == "ok"
    assert scanned[(effective.SOURCE_AGENT, "reviewer.md")] == "ok"
    assert scanned[(effective.SOURCE_MANAGED_POLICY, "managed-settings.json")] == "ok"


# ─── redaction ───────────────────────────────────────────────────────────────


def test_no_third_party_command_string_reaches_the_response(report) -> None:
    """The acceptance criterion, asserted on the whole serialized payload.

    Not on one field: the point is that the credential is nowhere in what
    leaves the process, however it might have been carried there.
    """
    serialized = json.dumps(report)
    for secret in _ALL_SECRETS:
        assert secret not in serialized, secret


def test_third_party_hooks_return_an_executable_name_only(report) -> None:
    pre_tool = _event(report, "PreToolUse")
    by_executable = {
        c["executable"]: c
        for bucket in pre_tool["by_source"]
        for c in bucket["contributions"]
    }
    # A bare program name in every case — never a path, never an argument.
    assert "notify" in by_executable
    assert "python3" in by_executable
    assert "skill-guard.sh" in by_executable
    assert "agent-guard" in by_executable
    assert "repo-guard.sh" in by_executable
    assert "bash" in by_executable

    for name in ("notify", "python3", "skill-guard.sh", "agent-guard", "repo-guard.sh"):
        row = by_executable[name]
        assert row["command"] is None, name
        assert row["redacted"] is True, name
        assert row["codenest_authored"] is False, name


def test_this_apps_own_hook_is_returned_whole(report) -> None:
    """Ours is safe to show: this app generates it and it carries no credential."""
    pre_tool = _event(report, "PreToolUse")
    ours = [
        c
        for bucket in pre_tool["by_source"]
        for c in bucket["contributions"]
        if c["codenest_authored"]
    ]
    assert len(ours) == 1
    assert ours[0]["command"] == _ours_pre_tool_command()
    assert ours[0]["redacted"] is False
    assert ours[0]["executable"] == "curl"


def test_authorship_is_exact_membership_not_a_substring_scan() -> None:
    """Only a command this app itself mints is ours — character for character.

    The substring version of this check fails OPEN on the case that matters
    most. Any of the strings below mentions one of our own ingest URLs, and a
    containment test therefore calls each one ours and returns it whole,
    credential included. They are not ours: this module did not write any of
    them, and "mentions our URL" is not a property only our commands have — it
    is a property a hostile hook has every reason to arrange.
    """
    authored = effective.authored_commands(_BASE)

    # Every one of the 22 real commands, at every loopback spelling, is ours.
    for base in ("http://localhost:8002", "http://127.0.0.1:8002"):
        block = hooks_service.build_hook_settings(base)["hooks"]
        for entries in block.values():
            command = entries[0]["hooks"][0]["command"]
            assert effective._is_codenest_authored(command, authored), command
    assert len(authored) >= len(hooks_service.HOOK_EVENTS)

    not_ours = (
        # Same host, same path, plus a bearer token in the same argv.
        f"curl -H 'Authorization: Bearer SECRET' -X POST {_BASE}/api/v1/hooks/stop",
        # Our URL merely echoed, with the real work chained after it.
        f"echo {_BASE}/api/v1/hooks/stop && /opt/x.sh --key=SECRET",
        # Ours, with something appended after it.
        f"{_ours_pre_tool_command()} && /opt/x.sh --key=SECRET",
        # Ours, with something prepended before it.
        f"/opt/x.sh --key=SECRET; {_ours_pre_tool_command()}",
        # A lookalike on another host.
        "curl -s https://evil.example.com/api/v1/hooks/pre-tool?t=abc",
        None,
        "",
    )
    for command in not_ours:
        assert not effective._is_codenest_authored(command, authored), command


def test_a_same_host_third_party_command_is_redacted_end_to_end(report) -> None:
    """The criterion, on the path a real request takes.

    The unit test above proves the predicate; this proves the predicate is what
    the report actually consults, because a fix applied to the helper and not
    to its caller would leave the response exactly as leaky as before.
    """
    post_tool = _event(report, "PostToolUse")
    rows = [c for bucket in post_tool["by_source"] for c in bucket["contributions"]]
    assert len(rows) == 4
    for row in rows:
        assert row["codenest_authored"] is False, row
        assert row["redacted"] is True, row
        assert row["command"] is None, row
    assert {row["executable"] for row in rows} == {
        "curl",  # the bearer-token lookalike: name only, no header, no URL
        "echo",  # the chained command: token zero only
        "hooks.example.com:8443",  # host and port, no `deploy:...@`
        "(unresolved)",  # the URL `urlsplit` refuses
    }


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("/usr/local/bin/notify --token=abc", "notify"),
        ("python3 ~/.claude/hooks/x.py --key secret", "python3"),
        ("API_KEY=abc /opt/bin/tool --flag", "tool"),
        ("env API_KEY=abc /opt/bin/tool", "tool"),
        ("bash -c 'curl -H \"Authorization: Bearer abc\" https://x'", "bash"),
        ("./guard.sh", "guard.sh"),
        # Unbalanced quotes: the whitespace fallback, still token zero only.
        ("./guard.sh --msg='unterminated", "guard.sh"),
        ("   ", "(unresolved)"),
        ("--only-flags", "(unresolved)"),
    ],
)
def test_executable_name_never_returns_an_argument(command: str, expected: str) -> None:
    assert effective.executable_name(command) == expected


def test_an_http_hook_is_reduced_to_its_host(report) -> None:
    """A hook URL's path and query carry secrets as readily as an argv does."""
    hook = {"type": "http", "url": "https://audit.example.com/ingest?sig=abc123"}
    hook_type, safe, raw = effective._hook_identity(hook)
    assert hook_type == "http"
    assert safe == "audit.example.com"
    assert "sig" not in safe
    assert raw is not None  # the caller's input to the authorship check only


def test_an_http_hook_never_publishes_its_userinfo() -> None:
    """`netloc` carries `user:password@`; the safe identifier must not.

    This is the worst possible field for a credential to survive in, because it
    is the field that exists to be the safe one and the row around it says
    `redacted: true`.
    """
    hook = {
        "type": "http",
        "url": "https://deploy:s3cr3t-PASSWORD@hooks.example.com:8443/n?sig=abc",
    }
    _, safe, _ = effective._hook_identity(hook)
    assert safe == "hooks.example.com:8443"
    assert "s3cr3t-PASSWORD" not in safe
    assert "@" not in safe


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://audit.example.com/ingest?sig=abc", "audit.example.com"),
        ("https://u:p@audit.example.com/ingest", "audit.example.com"),
        ("https://audit.example.com:8443/x", "audit.example.com:8443"),
        ("http://[::1]:9000/x", "[::1]:9000"),
        # `urlsplit` raises on these; a hooks block is user input and the
        # report must degrade to a placeholder rather than 500 the request.
        ("http://[oops", "(unresolved)"),
        ("http://example.com:99999/x", "(unresolved)"),
        ("not a url at all", "(unresolved)"),
    ],
)
def test_url_identity_never_raises_and_never_widens(url: str, expected: str) -> None:
    assert effective._url_identity(url) == expected


# ─── no timing, anywhere ─────────────────────────────────────────────────────


def test_response_carries_no_duration_and_no_percentile(report) -> None:
    """Hook latency is not derivable from hooks or transcripts.

    A transcript can time this app's own `/hooks/stop` curl and nothing else,
    so a duration here would measure one contributor out of eight while
    appearing to measure the event. Asserted against the serialized payload
    rather than the model's fields because a duration could as easily arrive
    inside a string.
    """
    serialized = json.dumps(report)
    assert not re.search(r"\d+\s*ms", serialized)
    assert not re.search(r"p50", serialized, re.IGNORECASE)


def test_no_model_field_is_a_measured_duration() -> None:
    """`timeout_seconds` is the declared ceiling, read out of the file."""
    from app.models.effective_hooks import EffectiveHookContribution

    fields = set(EffectiveHookContribution.model_fields)
    assert "timeout_seconds" in fields
    assert not {f for f in fields if "ms" in f or "duration" in f or "latency" in f}


def test_declared_timeout_is_carried_through_unchanged(report) -> None:
    pre_tool = _event(report, "PreToolUse")
    plugin = _bucket(pre_tool, effective.SOURCE_PLUGIN)["contributions"][0]
    assert plugin["timeout_seconds"] == 6


# ─── tolerance for the state real files are in ───────────────────────────────


def test_a_broken_file_is_a_status_and_not_an_exception(tmp_path, monkeypatch) -> None:
    """Invalid JSON, a missing file and a directory where a file was expected.

    Every one of these is a real situation on a real machine, and each has to
    reach the reader as its own explanation rather than as a failed request.
    """
    import asyncio

    config_home = tmp_path / "claude-home"
    config_home.mkdir()
    (config_home / "settings.json").write_text("{ not json", encoding="utf-8")
    monkeypatch.setattr(
        effective, "managed_policy_paths", lambda: (tmp_path / "nope.json",)
    )

    result = asyncio.run(
        effective.build_effective_hooks(
            [str(config_home)], [str(tmp_path / "no-such-repo")], base_url=_BASE
        )
    )
    statuses = {(f["source"], f["status"]) for f in result["scanned"]}
    assert (effective.SOURCE_USER, "invalid_json") in statuses
    assert (effective.SOURCE_PROJECT, "missing_file") in statuses
    assert (effective.SOURCE_MANAGED_POLICY, "missing_file") in statuses
    assert all(entry["total"] == 0 for entry in result["events"])


def test_a_path_outside_the_allowed_roots_is_refused_not_read(
    tmp_path, monkeypatch
) -> None:
    """These routes are unauthenticated localhost routes, like the import
    preview, so a caller-supplied path stays inside the same guard."""
    import asyncio

    from app.services import project_scanner_service

    monkeypatch.setattr(
        project_scanner_service, "_allowed_scan_roots", lambda: (tmp_path.resolve(),)
    )
    monkeypatch.setattr(
        effective, "managed_policy_paths", lambda: (tmp_path / "nope.json",)
    )
    outside = tmp_path.parent / "outside-repo"
    outside.mkdir(exist_ok=True)

    result = asyncio.run(
        effective.build_effective_hooks([], [str(outside)], base_url=_BASE)
    )
    refused = [f for f in result["scanned"] if f["status"] == "out_of_scope"]
    assert refused and refused[0]["source"] == effective.SOURCE_PROJECT


# ─── the frontmatter reader ──────────────────────────────────────────────────


def test_frontmatter_without_a_hooks_block_yields_nothing() -> None:
    assert effective.parse_frontmatter_hooks("---\nname: x\n---\n\nbody\n") == {}
    assert effective.parse_frontmatter_hooks("no frontmatter here\n") == {}


def test_frontmatter_reader_handles_both_shapes_and_several_events() -> None:
    text = (
        "---\n"
        "name: multi\n"
        "hooks:\n"
        "  PreToolUse:\n"
        "    - matcher: Bash\n"
        "      command: ./a.sh\n"
        "    - command: ./b.sh\n"
        "  Stop: ./c.sh\n"
        "model: opus\n"
        "---\n"
    )
    parsed = effective.parse_frontmatter_hooks(text)
    assert parsed == {
        "PreToolUse": [
            {"matcher": "Bash", "command": "./a.sh"},
            {"command": "./b.sh"},
        ],
        "Stop": [{"command": "./c.sh"}],
    }


def test_frontmatter_hooks_for_unknown_events_are_ignored(
    tmp_path, monkeypatch
) -> None:
    """An event this app does not ingest has no catalog entry to file under."""
    import asyncio

    config_home = tmp_path / "claude-home"
    agent = config_home / "agents" / "odd.md"
    agent.parent.mkdir(parents=True)
    agent.write_text(
        "---\nname: odd\nhooks:\n  WorktreeCreate: ./never.sh\n---\n", encoding="utf-8"
    )
    monkeypatch.setattr(
        effective, "managed_policy_paths", lambda: (tmp_path / "nope.json",)
    )

    result = asyncio.run(
        effective.build_effective_hooks([str(config_home)], [], base_url=_BASE)
    )
    assert all(entry["total"] == 0 for entry in result["events"])
    assert "WorktreeCreate" not in {e["event"] for e in result["events"]}


# ─── the flat hook shape a hand-edited file may still use ────────────────────


def test_a_flat_hook_entry_is_counted_rather_than_dropped() -> None:
    """The pre-wrapper shape: a hook dict sitting directly in the event array.

    The harness may well refuse it, but somebody put it there believing it
    would run, and a report answering "what is on this event" is more useful
    naming it than showing an empty list.
    """
    block = {"PreToolUse": [{"type": "command", "command": "./legacy.sh"}]}
    found = effective.iter_declared_hooks(block, "PreToolUse")
    assert len(found) == 1
    assert found[0][1]["command"] == "./legacy.sh"


def test_malformed_hook_blocks_never_raise() -> None:
    """A hooks block is user input; nothing here may throw on its shape."""
    assert effective.iter_declared_hooks(None, "Stop") == []
    assert effective.iter_declared_hooks("nonsense", "Stop") == []
    assert effective.iter_declared_hooks({"Stop": "nonsense"}, "Stop") == []
    assert effective.iter_declared_hooks({"Stop": [None, 3]}, "Stop") == []
    assert effective.iter_declared_hooks({"Stop": {"hooks": [{}]}}, "Stop") == [
        (None, {})
    ]


def test_a_hostile_caller_path_becomes_a_scanned_row_not_a_500() -> None:
    """The route promises it never 4xx/5xxs on the state of a user's files.

    `config_homes` and `project_roots` are caller-supplied strings, and three
    separate shapes of them raise from outside `Path.resolve`'s `OSError`:
    `~nosuchuser` raises RuntimeError out of `expanduser`, an embedded NUL
    raises ValueError, and a path past the OS limit raises OSError from the
    `is_dir` probe inside `_read_settings`. Each is a fact about one path and
    has to arrive as a `scanned` status.
    """
    hostile = [
        "~nosuchuser-{}/x".format("q" * 8),
        "/tmp/with\x00nul",
        "/tmp/" + ("x" * 3000),
        # Inside the allowed tree, so this one gets past the scope guard and
        # reaches `_read_settings`, whose own `is_dir` probe is what raises.
        # Read-only and nonexistent; nothing in this test creates it.
        str(Path.home() / ("x" * 3000)),
    ]
    result = asyncio.run(
        effective.build_effective_hooks(hostile, hostile, base_url=_BASE)
    )
    assert [entry["total"] for entry in result["events"]] == [
        0 for _ in result["events"]
    ]
    # Nothing silently vanished: every hostile path is accounted for.
    assert result["scanned"]
    assert all(
        row["status"] in {"unreadable", "out_of_scope", "missing_file"}
        for row in result["scanned"]
    ), result["scanned"]


# ─── the response that actually reaches the frontend ─────────────────────────


@pytest.mark.asyncio
async def test_the_endpoint_redacts_and_carries_no_timing(
    eight_sources, monkeypatch
) -> None:
    """Same two rules, asserted on the real HTTP response body.

    The service tests above check the dicts; this checks what the router and
    the pydantic models actually emit, because a field the model widened or a
    validator that echoed its input would slip past a service-level assertion.
    """
    import httpx
    from fastapi import FastAPI

    from app.routers import workspace as workspace_router

    monkeypatch.setattr(
        effective, "managed_policy_paths", lambda: (eight_sources["policy_file"],)
    )
    monkeypatch.setattr(hooks_service, "sidecar_base_url", lambda: _BASE)

    app = FastAPI()
    app.include_router(workspace_router.router)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/v1/workspace/hooks/effective",
            json={
                "config_homes": eight_sources["config_homes"],
                "project_roots": eight_sources["project_roots"],
            },
        )

    assert response.status_code == 200
    body = response.text
    for secret in _ALL_SECRETS:
        assert secret not in body, secret
    assert not re.search(r"\d+\s*ms", body)
    assert not re.search(r"p50", body, re.IGNORECASE)

    payload = response.json()
    assert len(payload["sources"]) == 8
    assert len(payload["events"]) == len(hooks_service.HOOK_EVENTS)
    assert _event(payload, "PreToolUse")["total"] == 8


# ─── migration 016 ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_project_event_index_exists(migrated_db) -> None:
    """The index the per-repo, per-event read needs.

    `agent_events` ships with a session index and a created_at index, neither
    of which has `project_id` or `event_type` in it, so this query was a full
    scan of the largest table in the database before 016.
    """
    cur = await migrated_db.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        ("idx_agent_events_project_event",),
    )
    row = await cur.fetchone()
    assert row is not None, "016 did not create idx_agent_events_project_event"
    sql = " ".join(row["sql"].split()).lower()
    assert "on agent_events(project_id, event_type, created_at desc)" in sql


@pytest.mark.asyncio
async def test_the_planner_actually_picks_the_new_index(migrated_db) -> None:
    """An index nothing chooses is dead weight — ask SQLite, do not assume."""
    cur = await migrated_db.execute(
        "EXPLAIN QUERY PLAN "
        "SELECT id FROM agent_events "
        "WHERE project_id = 1 AND event_type = 'PreToolUse' "
        "ORDER BY created_at DESC LIMIT 20"
    )
    plan = " ".join(str(value) for row in await cur.fetchall() for value in row)
    assert "idx_agent_events_project_event" in plan, plan
