"""Every version declaration in the repo agrees.

The app states its version in five places — the root and frontend
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and
`_APP_VERSION` in the sidecar, which is what `GET /health` reports and what the
Tauri shell reads to decide whether to re-extract the packaged sidecar.

Nothing tied them together, and the sidecar duly drifted: it was still on
`0.1.0` while the other four had moved to `0.2.0`. That is silent — a stale
sidecar version reports the wrong thing at `/health` and can make a release
look like it shipped an older sidecar than it did.
"""

from __future__ import annotations

import json
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[2]


def _package_json(rel: str) -> str:
    return json.loads((REPO / rel).read_text())["version"]


def _cargo_toml() -> str:
    text = (REPO / "src-tauri" / "Cargo.toml").read_text()
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert m, "no version in src-tauri/Cargo.toml"
    return m.group(1)


def _sidecar() -> str:
    text = (REPO / "app" / "__init__.py").read_text()
    m = re.search(r'^_APP_VERSION\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert m, "no _APP_VERSION in app/__init__.py"
    return m.group(1)


def test_every_version_declaration_agrees() -> None:
    declared = {
        "package.json": _package_json("package.json"),
        "frontend/package.json": _package_json("frontend/package.json"),
        "src-tauri/tauri.conf.json": _package_json("src-tauri/tauri.conf.json"),
        "src-tauri/Cargo.toml": _cargo_toml(),
        "app/__init__.py:_APP_VERSION": _sidecar(),
    }
    assert len(set(declared.values())) == 1, (
        "version declarations disagree — bump them together: "
        + ", ".join(f"{k}={v}" for k, v in sorted(declared.items()))
    )


def test_the_version_is_a_plain_semver() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", _sidecar()), _sidecar()
