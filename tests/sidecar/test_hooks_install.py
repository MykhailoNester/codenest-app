"""Tests for the write-through hooks install (#170).

This is the only code in the sidecar that rewrites a file the user did not
hand it, and the file it rewrites holds every hook every tool they have ever
installed. So the suite is weighted towards what must *not* happen rather than
what must: most of it asserts that something was left alone, that nothing was
truncated, or that the operation refused.

Four properties carry the ticket and each has its own section below.

1. **Preservation.** A hook this app did not author is never removed, never
   rewritten and never reordered, and neither is anything else in the file.
2. **Idempotence.** A second install is a no-op — byte-identical file, no
   second backup, `status: unchanged`. Without this, "repair" is a loop.
3. **Stale repair**, and in particular the case from #172's verification: a
   `PreToolUse` command installed before #172 ends in `>/dev/null 2>&1`, so
   the permission decision the sidecar computes is thrown away. `verify`
   grades that file green, because grading is containment. The repair is
   proved end to end here — the repaired command is actually run against a
   real HTTP server and its stdout inspected — because "the command no longer
   contains a redirect" is a claim about a string, and the thing that matters
   is whether a decision can reach the session.
4. **Atomicity and refusal.** A failure part-way through a write leaves the
   original whole; anything ambiguous is refused rather than guessed at.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import workspace as workspace_router
from app.services import hooks_service, project_scanner_service

_BASE = "http://localhost:8002"


# ─── fixtures / helpers ──────────────────────────────────────────────────────


def _settings_file(tmp_path: pathlib.Path, body: object, name: str = "claude") -> Any:
    """Write *body* as a settings.json under a fresh config home; return both."""
    config_home = tmp_path / name
    config_home.mkdir(parents=True, exist_ok=True)
    target = config_home / "settings.json"
    target.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return str(config_home), target


def _our_command(event: str, base: str = _BASE) -> str:
    return hooks_service.build_hook_settings(base)["hooks"][event][0]["hooks"][0][
        "command"
    ]


def _pre_172_command(event: str, base: str = _BASE) -> str:
    """The command a pre-#172 release wrote for *event*: stdout discarded.

    Built from the frozen generation-1 form rather than from today's builder,
    because that is what makes it a genuine historical command and not an
    approximation of one.
    """
    path = hooks_service.hook_endpoint_path(event)
    assert path is not None
    return hooks_service._LEGACY_COMMAND_FORMS[0].format(url=f"{base}{path}")


def _installed_hook(target: pathlib.Path, event: str, base: str = _BASE) -> dict:
    """The one hook under *event*'s `"*"` matcher, read back off disk."""
    body = json.loads(target.read_text(encoding="utf-8"))
    for entry in body["hooks"][event]:
        if entry.get("matcher") == "*":
            for hook in entry["hooks"]:
                if (
                    hooks_service.hook_authorship(hook, event, base)
                    != hooks_service.AUTHORSHIP_FOREIGN
                ):
                    return hook
    raise AssertionError(f"no hook of ours found under {event}")


def _plan_for(report: dict, event: str) -> dict:
    return next(e for e in report["results"][0]["events"] if e["event"] == event)


def _run_hook_command(command: str) -> subprocess.CompletedProcess[bytes]:
    """Run an installed hook command the way Claude Code runs it: through a
    shell, with the event payload on stdin. Blocking, so callers hop to a
    thread — the point of the exercise is the real `curl`, not a stand-in."""
    return subprocess.run(
        command,
        shell=True,
        input=b"{}",
        capture_output=True,
        timeout=20,
        check=False,
    )


# ─── authorship: the gate in front of every rewrite ──────────────────────────


def test_marker_alone_is_not_enough() -> None:
    """A marker somebody copied into an unrelated command is not adoption.

    The marker is a plain string in a file anyone may read and paste. What
    stops that from handing this app a stranger's command to rewrite is the
    second half of the rule: the command must target *our* endpoint, for *this*
    event, at a loopback spelling of the sidecar's own base URL.
    """
    marked_elsewhere = {
        "type": "command",
        "command": (
            "curl -s -H 'X-Codenest-Hook: 1' -X POST "
            "https://telemetry.example.com/ingest || true"
        ),
    }
    assert (
        hooks_service.hook_authorship(marked_elsewhere, "PreToolUse", _BASE)
        == hooks_service.AUTHORSHIP_FOREIGN
    )


def test_our_url_alone_is_not_enough() -> None:
    """Nor is a stranger's curl that happens to POST to our endpoint.

    This is the shape #169 already refuses to print back, for the reason it
    gives: a hand-written call to a local HTTP API is the one most likely to be
    carrying a credential in the same argv. Rewriting it would destroy it.
    """
    hand_written = {
        "type": "command",
        "command": (
            f"curl -H 'Authorization: Bearer sk-SECRET' -X POST "
            f"{_BASE}/api/v1/hooks/pre-tool"
        ),
    }
    assert (
        hooks_service.hook_authorship(hand_written, "PreToolUse", _BASE)
        == hooks_service.AUTHORSHIP_FOREIGN
    )


def test_our_command_filed_under_the_wrong_event_is_not_ours() -> None:
    """The host/path check is per event, not per app.

    A `PreToolUse` command sitting under `Stop` would, if adopted, be
    overwritten with the `Stop` command — silently moving a user's wiring.
    """
    hook = {"type": "command", "command": _our_command("PreToolUse")}
    assert (
        hooks_service.hook_authorship(hook, "Stop", _BASE)
        == hooks_service.AUTHORSHIP_FOREIGN
    )


def test_loopback_alias_is_current_not_stale() -> None:
    """127.0.0.1 where the sidecar says localhost works, so it is not stale.

    Calling it stale would make every such install repair itself on every run
    and never reach a fixed point — idempotence would be false for exactly the
    users whose wiring is already correct.
    """
    hook = {"type": "command", "command": _our_command("Stop", "http://127.0.0.1:8002")}
    assert (
        hooks_service.hook_authorship(hook, "Stop", _BASE)
        == hooks_service.AUTHORSHIP_CURRENT
    )


def test_pre_172_command_is_stale_ours() -> None:
    hook = {"type": "command", "command": _pre_172_command("PreToolUse")}
    assert (
        hooks_service.hook_authorship(hook, "PreToolUse", _BASE)
        == hooks_service.AUTHORSHIP_STALE
    )


def test_legacy_http_hook_is_stale_ours() -> None:
    hook = {"type": "http", "url": f"{_BASE}/api/v1/hooks/stop"}
    assert (
        hooks_service.hook_authorship(hook, "Stop", _BASE)
        == hooks_service.AUTHORSHIP_STALE
    )


# ─── 1. preservation ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_third_party_hooks_and_unknown_keys_survive_untouched(
    tmp_path: pathlib.Path,
) -> None:
    """The worst outcome this ticket can produce is clobbering someone else's
    hook. This asserts the whole file back, not a sample of it."""
    guard = {
        "type": "command",
        "command": "/opt/security/guard.sh --token=SECRET --strict",
        "timeout": 12,
    }
    other_tool = {
        "type": "command",
        "command": "node /usr/local/lib/some-other-tool/hook.js",
    }
    original = {
        "env": {"ANTHROPIC_API_KEY": "sk-ant-SECRET"},
        "permissions": {"allow": ["Bash(git status)"]},
        "hooks": {
            "PreToolUse": [{"matcher": "Bash", "hooks": [guard]}],
            "Stop": [{"matcher": "*", "hooks": [other_tool]}],
            "SomeEventWeDoNotKnow": [{"matcher": "*", "hooks": [other_tool]}],
        },
    }
    config_home, target = _settings_file(tmp_path, original)

    report = await hooks_service.install_settings_files([config_home], _BASE)
    assert report["overall"] == "applied"

    body = json.loads(target.read_text(encoding="utf-8"))
    # Unknown top-level keys, byte for byte.
    assert body["env"] == original["env"]
    assert body["permissions"] == original["permissions"]
    # An event we do not know is not an event we touch.
    assert body["hooks"]["SomeEventWeDoNotKnow"] == [
        {"matcher": "*", "hooks": [other_tool]}
    ]
    # Third-party hooks keep their object, their index and their enclosing
    # entry; ours is appended after, never inserted before.
    assert body["hooks"]["PreToolUse"][0] == {"matcher": "Bash", "hooks": [guard]}
    assert body["hooks"]["Stop"][0] == {"matcher": "*", "hooks": [other_tool]}
    assert len(body["hooks"]["Stop"][0]["hooks"]) == 1
    assert body["hooks"]["Stop"][-1]["hooks"][0]["command"] == _our_command("Stop")

    # And the report says so, in counts rather than in commands — a
    # third-party command is an arbitrary shell string that may carry a secret.
    assert _plan_for(report, "PreToolUse")["left_foreign"] == 1
    assert "SECRET" not in json.dumps(report)


@pytest.mark.asyncio
async def test_ours_under_a_narrow_matcher_is_left_alone(
    tmp_path: pathlib.Path,
) -> None:
    """A matcher we never mint is a user edit, and the matcher belongs to the
    entry — a sibling third-party hook shares it. So the narrowed hook is
    neither rewritten nor counted as coverage; a correct `"*"` entry is added
    beside it instead."""
    narrowed = {"type": "command", "command": _pre_172_command("PostToolUse")}
    config_home, target = _settings_file(
        tmp_path, {"hooks": {"PostToolUse": [{"matcher": "Bash", "hooks": [narrowed]}]}}
    )

    report = await hooks_service.install_settings_files([config_home], _BASE)

    plan = _plan_for(report, "PostToolUse")
    assert plan["action"] == "add"
    assert plan["left_narrow"] == 1
    assert plan["repaired"] == 0

    body = json.loads(target.read_text(encoding="utf-8"))
    assert body["hooks"]["PostToolUse"][0] == {"matcher": "Bash", "hooks": [narrowed]}
    assert body["hooks"]["PostToolUse"][1]["matcher"] == "*"


@pytest.mark.asyncio
async def test_an_ours_hook_not_wrapped_in_an_entry_is_reported_not_deleted(
    tmp_path: pathlib.Path,
) -> None:
    """The flat shape `classify_settings_hooks` calls malformed. Deleting is
    the one operation running the installer again cannot undo, so it stays."""
    flat = {"type": "command", "command": _pre_172_command("SessionEnd")}
    config_home, target = _settings_file(tmp_path, {"hooks": {"SessionEnd": [flat]}})

    report = await hooks_service.install_settings_files([config_home], _BASE)

    assert _plan_for(report, "SessionEnd")["left_malformed"] == 1
    body = json.loads(target.read_text(encoding="utf-8"))
    assert body["hooks"]["SessionEnd"][0] == flat


# ─── 2. idempotence ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_second_install_changes_nothing(tmp_path: pathlib.Path) -> None:
    config_home, target = _settings_file(tmp_path, {"hooks": {}})

    first = await hooks_service.install_settings_files([config_home], _BASE)
    assert first["overall"] == "applied"
    after_first = target.read_bytes()
    backups_after_first = sorted(target.parent.glob("settings.json.codenest-backup-*"))

    second = await hooks_service.install_settings_files([config_home], _BASE)

    assert second["overall"] == "unchanged"
    assert second["results"][0]["changed"] is False
    assert second["results"][0]["backup_path"] is None
    assert all(e["action"] == "ok" for e in second["results"][0]["events"])
    assert target.read_bytes() == after_first
    # A run that changes nothing takes no backup — otherwise every page load
    # that touched this endpoint would leave a file behind.
    assert (
        sorted(target.parent.glob("settings.json.codenest-backup-*"))
        == backups_after_first
    )


@pytest.mark.asyncio
async def test_install_output_verifies_green(tmp_path: pathlib.Path) -> None:
    """The installer and the verifier have to agree, or "repair" would produce
    a file the app itself then calls broken."""
    config_home, _target = _settings_file(tmp_path, {"hooks": {}})
    await hooks_service.install_settings_files([config_home], _BASE)

    report = await hooks_service.verify_settings_files([config_home], _BASE)
    assert report["overall"] == "ok"
    assert all(e["status"] == "ok" for e in report["results"][0]["events"])


@pytest.mark.asyncio
async def test_dry_run_writes_nothing(tmp_path: pathlib.Path) -> None:
    config_home, target = _settings_file(tmp_path, {"hooks": {}})
    before_bytes = target.read_bytes()
    before_mtime = target.stat().st_mtime_ns

    report = await hooks_service.plan_settings_files([config_home], _BASE)

    assert report["dry_run"] is True
    assert report["overall"] == "planned"
    assert report["results"][0]["changed"] is True
    assert [e["action"] for e in report["results"][0]["events"]] == ["add"] * 22
    assert target.read_bytes() == before_bytes
    assert target.stat().st_mtime_ns == before_mtime
    assert list(target.parent.glob("*codenest-backup*")) == []
    assert list(target.parent.glob("*codenest-tmp*")) == []


# ─── 3. stale repair, including the #172 case ────────────────────────────────


@pytest.mark.asyncio
async def test_pre_172_pre_tool_use_is_repaired_in_place(
    tmp_path: pathlib.Path,
) -> None:
    """The install verify calls green and #172 calls broken.

    A pre-#172 `PreToolUse` command still contains our URL, so
    `_verdict_for_hook`'s containment test grades it "ok" — which is asserted
    here before the repair precisely because that verdict is the reason this
    ticket exists. The hook nonetheless discards stdout, and stdout is the only
    channel a pre-authorisation decision travels on.
    """
    stale = {
        "type": "command",
        "command": _pre_172_command("PreToolUse"),
        "timeout": 6,
    }
    config_home, target = _settings_file(
        tmp_path, {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [stale]}]}}
    )

    before = await hooks_service.verify_settings_files([config_home], _BASE)
    pre_tool = next(
        e for e in before["results"][0]["events"] if e["event"] == "PreToolUse"
    )
    assert pre_tool["status"] == "ok"  # the false green this ticket repairs

    report = await hooks_service.install_settings_files([config_home], _BASE)

    plan = _plan_for(report, "PreToolUse")
    assert plan["action"] == "repair"
    assert plan["repaired"] == 1

    repaired = _installed_hook(target, "PreToolUse")
    assert repaired["command"] == _our_command("PreToolUse")
    assert ">/dev/null 2>&1" not in repaired["command"]
    assert "--fail" in repaired["command"]
    # Repaired in place: still one entry, still one hook in it.
    body = json.loads(target.read_text(encoding="utf-8"))
    assert len(body["hooks"]["PreToolUse"]) == 1
    assert len(body["hooks"]["PreToolUse"][0]["hooks"]) == 1


class _DecisionHandler(BaseHTTPRequestHandler):
    """Answers any POST with a `PreToolUse` permission decision."""

    decision = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "standing rule",
            }
        }
    ).encode("utf-8")

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.decision)))
        self.end_headers()
        self.wfile.write(self.decision)

    def log_message(self, *args: object) -> None:
        return


@pytest.mark.asyncio
async def test_repaired_pre_tool_use_command_can_actually_carry_a_decision(
    tmp_path: pathlib.Path,
) -> None:
    """The end-to-end half of case E, run rather than asserted about.

    Everything above this line reasons about strings. This one starts a real
    HTTP server that answers with a permission decision, runs the *genuine*
    pre-#172 command against it and observes that the decision is lost, then
    installs, runs the repaired command from the file, and observes the same
    decision arriving on stdout — which is the only place Claude Code looks
    for one. Without this, "repair fixed it" is a claim about a substring.
    """
    if shutil.which("curl") is None:  # pragma: no cover - macOS/Linux both ship it
        pytest.skip("curl is not available")

    server = ThreadingHTTPServer(("127.0.0.1", 0), _DecisionHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{port}"
        stale_command = _pre_172_command("PreToolUse", base)

        # The install as it exists on a pre-#172 machine: the decision is
        # computed, returned, and redirected into /dev/null.
        before = await asyncio.to_thread(_run_hook_command, stale_command)
        assert before.stdout == b""

        config_home, target = _settings_file(
            tmp_path,
            {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "*",
                            "hooks": [{"type": "command", "command": stale_command}],
                        }
                    ]
                }
            },
        )
        await hooks_service.install_settings_files([config_home], base)

        repaired_command = _installed_hook(target, "PreToolUse", base)["command"]
        after = await asyncio.to_thread(_run_hook_command, repaired_command)
        assert after.returncode == 0
        decision = json.loads(after.stdout)
        assert decision["hookSpecificOutput"]["permissionDecision"] == "deny", (
            after.stdout
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.asyncio
async def test_legacy_http_hook_is_replaced_by_the_command_form(
    tmp_path: pathlib.Path,
) -> None:
    config_home, target = _settings_file(
        tmp_path,
        {
            "hooks": {
                "Stop": [
                    {
                        "matcher": "*",
                        "hooks": [
                            {"type": "http", "url": f"{_BASE}/api/v1/hooks/stop"}
                        ],
                    }
                ]
            }
        },
    )

    report = await hooks_service.install_settings_files([config_home], _BASE)

    assert _plan_for(report, "Stop")["action"] == "repair"
    hook = _installed_hook(target, "Stop")
    assert hook["type"] == "command"
    assert hook["command"] == _our_command("Stop")


# ─── 4a. atomicity and the backup ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_backup_holds_the_previous_content_and_is_named_in_the_result(
    tmp_path: pathlib.Path,
) -> None:
    original = {"env": {"X": "1"}, "hooks": {}}
    config_home, target = _settings_file(tmp_path, original)
    before = target.read_bytes()

    report = await hooks_service.install_settings_files([config_home], _BASE)

    backup_path = report["results"][0]["backup_path"]
    assert backup_path is not None
    backup = pathlib.Path(backup_path)
    assert backup.parent == target.parent
    assert backup.read_bytes() == before
    assert target.read_bytes() != before


@pytest.mark.asyncio
async def test_no_backup_when_the_file_did_not_exist(tmp_path: pathlib.Path) -> None:
    config_home = tmp_path / "fresh"
    config_home.mkdir()

    report = await hooks_service.install_settings_files([str(config_home)], _BASE)

    result = report["results"][0]
    assert result["status"] == "applied"
    assert result["created_file"] is True
    assert result["backup_path"] is None
    body = json.loads((config_home / "settings.json").read_text(encoding="utf-8"))
    assert len(body["hooks"]) == 22
    # A file that may hold an API key is not created world-readable.
    mode = (config_home / "settings.json").stat().st_mode & 0o777
    assert mode & 0o077 == 0


@pytest.mark.asyncio
async def test_an_interrupted_write_leaves_the_original_whole(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The property the whole write path exists for.

    A plain `open(..., "w")` truncates before the first byte lands, so a crash
    between those two moments costs the user every hook every tool ever
    installed. The write here goes to a temp file in the same directory and is
    renamed over the target, so the failure injected at the rename can only
    leave the original — never half of the new content, and never nothing.
    """
    original = {"env": {"X": "1"}, "hooks": {"Stop": []}}
    config_home, target = _settings_file(tmp_path, original)
    before = target.read_bytes()

    real_replace = os.replace
    calls: list[str] = []

    def exploding_replace(src: object, dst: object, **kwargs: object) -> None:
        # The backup is written through the same helper; let that one land so
        # the test also proves the backup survives a failed main write.
        if str(dst) == str(target):
            calls.append(str(dst))
            raise OSError(28, "No space left on device")
        real_replace(src, dst, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(os, "replace", exploding_replace)
    report = await hooks_service.install_settings_files([config_home], _BASE)

    assert calls, "the write never reached os.replace"
    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "write failed" in result["refusal"]

    assert target.read_bytes() == before
    # No temp file left behind for the next reader to trip over.
    assert list(target.parent.glob("*.codenest-tmp")) == []
    assert list(target.parent.glob(".settings.json.*")) == []
    # The backup taken before the attempt is still a usable restore point.
    backup = pathlib.Path(result["backup_path"])
    assert backup.read_bytes() == before


# ─── 4b. refusals ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_refuses_invalid_json_without_writing(tmp_path: pathlib.Path) -> None:
    config_home = tmp_path / "claude-bad"
    config_home.mkdir()
    target = config_home / "settings.json"
    target.write_text("{ not valid json", encoding="utf-8")

    report = await hooks_service.install_settings_files([str(config_home)], _BASE)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "JSON" in result["refusal"]
    assert target.read_text(encoding="utf-8") == "{ not valid json"
    assert list(config_home.iterdir()) == [target]


@pytest.mark.asyncio
async def test_refuses_a_file_over_the_read_limit(tmp_path: pathlib.Path) -> None:
    config_home = tmp_path / "claude-huge"
    config_home.mkdir()
    target = config_home / "settings.json"
    padding = " " * (hooks_service._MAX_SETTINGS_BYTES + 1)
    target.write_text("{}" + padding, encoding="utf-8")
    before = target.stat().st_size

    report = await hooks_service.install_settings_files([str(config_home)], _BASE)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "read limit" in result["refusal"]
    assert target.stat().st_size == before


@pytest.mark.asyncio
async def test_refuses_when_settings_json_is_a_directory(
    tmp_path: pathlib.Path,
) -> None:
    config_home = tmp_path / "claude-dir"
    (config_home / "settings.json").mkdir(parents=True)

    report = await hooks_service.install_settings_files([str(config_home)], _BASE)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "directory" in result["refusal"]


@pytest.mark.asyncio
async def test_refuses_when_the_config_home_does_not_exist(
    tmp_path: pathlib.Path,
) -> None:
    """A missing directory is far more often a typo or an unconfigured
    provider than a place the user wants this app to start creating trees."""
    report = await hooks_service.install_settings_files(
        [str(tmp_path / "nope" / "deeper")], _BASE
    )

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "does not exist" in result["refusal"]
    assert not (tmp_path / "nope").exists()


@pytest.mark.asyncio
async def test_refuses_an_unwritable_file(tmp_path: pathlib.Path) -> None:
    config_home, target = _settings_file(tmp_path, {"hooks": {}})
    target.chmod(0o444)
    try:
        report = await hooks_service.install_settings_files([config_home], _BASE)
    finally:
        target.chmod(0o644)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "not writable" in result["refusal"]


@pytest.mark.asyncio
async def test_refuses_a_path_outside_the_allowed_roots(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same containment policy every other path-taking endpoint applies.

    These routes are unauthenticated localhost routes by design (AGENTS.md), so
    for a *writer* this check is the only thing between a caller-supplied
    string and an arbitrary file.
    """
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "settings.json").write_text('{"keep": true}', encoding="utf-8")
    monkeypatch.setattr(
        project_scanner_service, "_allowed_scan_roots", lambda: (allowed.resolve(),)
    )

    report = await hooks_service.install_settings_files([str(outside)], _BASE)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "allowed import roots" in result["refusal"]
    assert (outside / "settings.json").read_text(encoding="utf-8") == '{"keep": true}'


@pytest.mark.asyncio
async def test_refuses_a_sensitive_directory(tmp_path: pathlib.Path) -> None:
    config_home = tmp_path / ".ssh"
    config_home.mkdir()

    report = await hooks_service.install_settings_files([str(config_home)], _BASE)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "sensitive" in result["refusal"]
    assert not (config_home / "settings.json").exists()


@pytest.mark.asyncio
async def test_symlink_out_of_scope_is_refused_and_one_in_scope_is_followed(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A settings.json kept in a dotfiles repo and linked into place is a real
    setup. Writing through the link keeps it a link; a link pointing somewhere
    the policy does not allow is refused rather than followed."""
    allowed = tmp_path / "allowed"
    dotfiles = allowed / "dotfiles"
    dotfiles.mkdir(parents=True)
    monkeypatch.setattr(
        project_scanner_service, "_allowed_scan_roots", lambda: (allowed.resolve(),)
    )

    # In scope: the link survives and the real file is what changed.
    in_scope_home = allowed / "claude"
    in_scope_home.mkdir()
    real = dotfiles / "claude-settings.json"
    real.write_text('{"hooks": {}}', encoding="utf-8")
    (in_scope_home / "settings.json").symlink_to(real)

    report = await hooks_service.install_settings_files([str(in_scope_home)], _BASE)
    assert report["results"][0]["status"] == "applied"
    assert (in_scope_home / "settings.json").is_symlink()
    assert len(json.loads(real.read_text(encoding="utf-8"))["hooks"]) == 22

    # Out of scope: refused, and the target is untouched.
    escape_target = tmp_path / "elsewhere" / "settings.json"
    escape_target.parent.mkdir()
    escape_target.write_text('{"keep": true}', encoding="utf-8")
    escape_home = allowed / "claude-escape"
    escape_home.mkdir()
    (escape_home / "settings.json").symlink_to(escape_target)

    report = await hooks_service.install_settings_files([str(escape_home)], _BASE)
    assert report["results"][0]["status"] == "refused"
    assert escape_target.read_text(encoding="utf-8") == '{"keep": true}'


@pytest.mark.asyncio
async def test_refuses_a_hooks_block_of_an_unexpected_shape(
    tmp_path: pathlib.Path,
) -> None:
    """Whole-file refusal, not a per-event skip.

    An event whose value is an object rather than an array is either a
    structure somebody built on purpose or a file that is not a settings.json
    at all. Merging into the other 21 and quietly dropping this one would leave
    the user with a half-installed file and a report they have to read
    carefully to notice; refusing the file says it once, loudly.
    """
    config_home, target = _settings_file(
        tmp_path, {"hooks": {"Stop": {"matcher": "*"}, "PreToolUse": []}}
    )
    before = target.read_bytes()

    report = await hooks_service.install_settings_files([config_home], _BASE)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert result["refusal"] is not None and "Stop" in result["refusal"]
    assert _plan_for(report, "Stop")["action"] == "conflict"
    assert target.read_bytes() == before
    assert list(target.parent.glob("*codenest-backup*")) == []


@pytest.mark.asyncio
async def test_refuses_a_body_that_is_not_an_object(tmp_path: pathlib.Path) -> None:
    config_home, target = _settings_file(tmp_path, [1, 2, 3])

    report = await hooks_service.install_settings_files([config_home], _BASE)

    assert report["results"][0]["status"] == "refused"
    assert json.loads(target.read_text(encoding="utf-8")) == [1, 2, 3]


@pytest.mark.asyncio
async def test_one_refusal_does_not_stop_another_config_home(
    tmp_path: pathlib.Path,
) -> None:
    """Separate files, separate outcomes. `overall` still reports the refusal
    so a caller reading only the summary is never told everything is fine."""
    bad_home = tmp_path / "bad"
    bad_home.mkdir()
    (bad_home / "settings.json").write_text("{oops", encoding="utf-8")
    good_home, good_target = _settings_file(tmp_path, {"hooks": {}}, name="good")

    report = await hooks_service.install_settings_files(
        [str(bad_home), good_home], _BASE
    )

    assert report["overall"] == "refused"
    assert report["results"][0]["status"] == "refused"
    assert report["results"][1]["status"] == "applied"
    assert len(json.loads(good_target.read_text(encoding="utf-8"))["hooks"]) == 22


# ─── routes ──────────────────────────────────────────────────────────────────


@pytest.fixture
def hooks_client() -> TestClient:
    app = FastAPI()
    app.include_router(workspace_router.router)
    return TestClient(app)


def test_plan_route_never_writes(
    hooks_client: TestClient, tmp_path: pathlib.Path
) -> None:
    """The reason the dry run is its own URL rather than a request-body flag:
    the call that cannot write should not be one deserialisation bug away from
    the call that can."""
    config_home, target = _settings_file(tmp_path, {"hooks": {}})
    before = target.read_bytes()

    resp = hooks_client.post(
        "/api/v1/workspace/hooks/install/plan", json={"config_homes": [config_home]}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["dry_run"] is True
    assert body["overall"] == "planned"
    assert target.read_bytes() == before


def test_install_route_applies_and_is_idempotent(
    hooks_client: TestClient, tmp_path: pathlib.Path
) -> None:
    config_home, target = _settings_file(tmp_path, {"hooks": {}})

    first = hooks_client.post(
        "/api/v1/workspace/hooks/install", json={"config_homes": [config_home]}
    ).json()
    assert first["dry_run"] is False
    assert first["overall"] == "applied"
    after = target.read_bytes()

    second = hooks_client.post(
        "/api/v1/workspace/hooks/install", json={"config_homes": [config_home]}
    ).json()
    assert second["overall"] == "unchanged"
    assert target.read_bytes() == after


def test_install_route_answers_200_on_a_broken_settings_file(
    hooks_client: TestClient, tmp_path: pathlib.Path
) -> None:
    """A refusal is data, not an HTTP error — the same contract `/hooks/verify`
    keeps. A 500 here has to stay distinguishable from a user's bad file."""
    config_home = tmp_path / "claude-broken"
    config_home.mkdir()
    (config_home / "settings.json").write_text("{oops", encoding="utf-8")

    resp = hooks_client.post(
        "/api/v1/workspace/hooks/install", json={"config_homes": [str(config_home)]}
    )

    assert resp.status_code == 200
    assert resp.json()["results"][0]["status"] == "refused"


def test_install_route_with_no_config_homes_is_a_no_op(
    hooks_client: TestClient,
) -> None:
    resp = hooks_client.post(
        "/api/v1/workspace/hooks/install", json={"config_homes": []}
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "base_url": hooks_service.sidecar_base_url(),
        "dry_run": False,
        "overall": "unchanged",
        "results": [],
    }
