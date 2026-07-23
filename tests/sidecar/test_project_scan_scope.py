"""Scope guard for the unauthenticated project preview/import endpoints.

`scan_project` (used by /command-center/projects/preview and import) must
refuse directories outside the allowed import roots so a localhost caller
cannot enumerate arbitrary filesystem locations (release blocker BLOCK-09).
"""

from __future__ import annotations

import pytest

from app.services import project_scanner_service as scanner


def test_scan_rejects_path_outside_allowed_roots(tmp_path, monkeypatch):
    # Restrict the allowlist to a sub-dir, then try to scan its parent.
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    monkeypatch.setattr(scanner, "_allowed_scan_roots", lambda: (allowed.resolve(),))

    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(ValueError, match="outside the allowed import roots"):
        scanner.scan_project(outside)


def test_scan_rejects_sensitive_segment(tmp_path, monkeypatch):
    monkeypatch.setattr(scanner, "_allowed_scan_roots", lambda: (tmp_path.resolve(),))
    ssh_dir = tmp_path / ".ssh"
    ssh_dir.mkdir()
    with pytest.raises(ValueError, match="sensitive directory"):
        scanner.scan_project(ssh_dir)


def test_scan_allows_path_within_allowed_root(tmp_path, monkeypatch):
    monkeypatch.setattr(scanner, "_allowed_scan_roots", lambda: (tmp_path.resolve(),))
    proj = tmp_path / "my-project"
    proj.mkdir()
    result = scanner.scan_project(proj)
    assert result.root_path == str(proj.resolve())
