# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Codenest FastAPI sidecar.
# Build via scripts/build-sidecar.sh (handles per-arch naming + rename).
# Direct invocation: pyinstaller scripts/pyinstaller.spec
#
# Cross-arch builds: set PYINSTALLER_TARGET_ARCH=arm64|x86_64 before invoking.
# x86_64 cross-builds from Apple Silicon require an x86_64 Python installation
# (e.g. arch -x86_64 /usr/local/bin/python3 -m PyInstaller ...).

import os
from pathlib import Path

project_root = Path(SPECPATH).parent  # the repo root

# Allow the build script to override target arch via env var
_target_arch = os.environ.get("PYINSTALLER_TARGET_ARCH") or None

a = Analysis(
    [str(project_root / "main.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=[
        (str(project_root / "migrations"), "migrations"),
        (str(project_root / "app"), "app"),
    ],
    hiddenimports=[
        # uvicorn internals that PyInstaller misses
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        # aiosqlite and its dependencies
        "aiosqlite",
        "sqlite3",
        # FastAPI / Starlette internals
        "anyio",
        "anyio._backends._asyncio",
        "starlette.routing",
        "starlette.middleware",
        "starlette.middleware.cors",
        # croniter (Phase 1 scheduled sessions — cron helper utilities)
        "croniter",
        "dateutil",
        "dateutil.relativedelta",
        "dateutil.parser",
        "dateutil.tz",
        "six",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Dev tooling — not needed in the sidecar binary
        "ruff",
        "mypy",
        "pytest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

# ONEDIR build (not onefile). A onefile binary self-extracts its entire payload
# to a temp dir on EVERY launch (~6 s here — measured), which, combined with the
# Rust shell's startup timeout, was the direct cause of the ~20 s first launch.
# onedir loads libraries directly from the bundled folder: no per-launch
# extraction, cold start drops to <1 s. The Tauri shell bundles dist/sidecar/
# as a resource at Contents/Resources/sidecar/ and spawns Resources/sidecar/sidecar
# (see src-tauri/src/sidecar/mod.rs release branch).
#
# UPX is disabled: it must be decompressed into memory on launch (and can trip
# macOS Gatekeeper per-dylib scans), which only adds startup latency.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    target_arch=_target_arch,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="sidecar",
)
