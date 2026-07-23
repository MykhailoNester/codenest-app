"""Tests for build_warp_launch_yaml profile-derived exec entries."""

from __future__ import annotations

from pathlib import Path

from app.services.agent_service import build_warp_launch_yaml


def test_profiles_drive_config_dirs() -> None:
    yaml_text = build_warp_launch_yaml(
        name="test-launch",
        work_count=2,
        personal_count=1,
        work_cwd="/tmp/work",
        personal_cwd="/tmp/personal",
        profiles=[
            {"name": "acme", "claude_config_dir": "~/.claude-acme"},
            {"name": "beta", "claude_config_dir": "/opt/beta"},
        ],
    )
    assert f"CLAUDE_CONFIG_DIR={Path.home()}/.claude-acme claude" in yaml_text
    assert "CLAUDE_CONFIG_DIR=/opt/beta claude" in yaml_text
    assert "title: 'acme'" in yaml_text
    assert "title: 'beta'" in yaml_text
    assert ".claude-work" not in yaml_text
    assert ".claude-personal" not in yaml_text


def test_no_profiles_falls_back_to_plain_claude() -> None:
    yaml_text = build_warp_launch_yaml(
        name="test-launch",
        work_count=1,
        personal_count=1,
        work_cwd="/tmp/work",
        personal_cwd="/tmp/personal",
    )
    assert "exec: 'claude'" in yaml_text
    assert "CLAUDE_CONFIG_DIR" not in yaml_text


def test_single_profile_serves_both_tabs() -> None:
    yaml_text = build_warp_launch_yaml(
        name="test-launch",
        work_count=1,
        personal_count=1,
        work_cwd="/tmp/work",
        personal_cwd="/tmp/personal",
        profiles=[{"name": "solo", "claude_config_dir": "/opt/solo"}],
    )
    assert yaml_text.count("CLAUDE_CONFIG_DIR=/opt/solo claude") == 2
