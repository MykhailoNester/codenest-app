#!/usr/bin/env bash
# Build the PyInstaller sidecar (ONEDIR) and package it as a single archive
# that the Tauri shell extracts once per version at runtime.
#
# Output:
#   src-tauri/resources/sidecar.tar.gz   (the onedir, gzipped — one file)
#
# Tauri bundles src-tauri/resources/sidecar.tar.gz into the app at
# Contents/Resources/sidecar.tar.gz (see tauri.conf.json `bundle.resources`).
# On first launch of a given version the Rust shell extracts it to
# <APP_DATA_DIR>/sidecar/ and spawns <APP_DATA_DIR>/sidecar/sidecar; later
# launches reuse the extracted dir (see src-tauri/src/sidecar/mod.rs).
#
# Why onedir-in-an-archive (not a onefile binary): a PyInstaller onefile binary
# self-extracts its WHOLE payload to a temp dir on EVERY launch (~6 s, measured)
# — combined with the Rust startup timeout, that was the direct cause of the
# ~20 s first launch. onedir loads its libraries directly from a folder, so once
# extracted, cold start is <1 s. We ship it as ONE archive (not a raw resource
# tree) because Tauri's resource bundler can't copy the onedir's nested
# Python.framework symlink tree. tar preserves the symlinks, so the extracted
# framework stays intact.
#
# Usage (from the repo root):
#   bash scripts/build-sidecar.sh
#
# ARCH NOTE: this packages the HOST architecture (arm64 on Apple Silicon), which
# is what `pnpm tauri:build` targets by default. For a universal / x86_64 bundle,
# build the matching-arch onedir on (or for) that arch before bundling.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SPEC="$SCRIPT_DIR/pyinstaller.spec"
DIST_DIR="$PROJECT_ROOT/src-tauri/binaries"                       # transient onedir output (gitignored)
RESOURCES_ARCHIVE="$PROJECT_ROOT/src-tauri/resources/sidecar.tar.gz"  # bundled by Tauri (gitignored)

cd "$PROJECT_ROOT"

if [[ -f ".venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

command -v pyinstaller >/dev/null 2>&1 || {
  echo "Error: pyinstaller not found. Install with: pip install pyinstaller" >&2
  exit 1
}

mkdir -p "$DIST_DIR"

ARCH="$(uname -m)"  # arm64 | x86_64
echo "==> Building $ARCH sidecar (onedir)..."
PYINSTALLER_TARGET_ARCH="$ARCH" pyinstaller "$SPEC" \
  --distpath "$DIST_DIR" \
  --workpath "$PROJECT_ROOT/build/pyinstaller-$ARCH" \
  --noconfirm

# onedir output: $DIST_DIR/sidecar/ (sidecar exe + _internal/).
if [[ ! -x "$DIST_DIR/sidecar/sidecar" ]]; then
  echo "Error: expected onedir executable at $DIST_DIR/sidecar/sidecar (not found)." >&2
  exit 1
fi

echo "==> Packaging onedir into $RESOURCES_ARCHIVE ..."
mkdir -p "$(dirname "$RESOURCES_ARCHIVE")"
rm -rf "$PROJECT_ROOT/src-tauri/resources/sidecar"  # remove any stale raw-tree staging
rm -f "$RESOURCES_ARCHIVE"
# Archive root contains `sidecar/...` so extracting into <APP_DATA_DIR> yields
# <APP_DATA_DIR>/sidecar/. -L is NOT used: keep the framework symlinks intact.
tar -czf "$RESOURCES_ARCHIVE" -C "$DIST_DIR" sidecar

# Drop any stale single-file onefile binaries from the old externalBin layout.
rm -f "$DIST_DIR/sidecar-aarch64-apple-darwin" "$DIST_DIR/sidecar-x86_64-apple-darwin"

echo ""
echo "==> Sidecar archive written:"
ls -lh "$RESOURCES_ARCHIVE" | awk '{print "    " $9 "  (" $5 ")"}'
echo ""
echo "==> Quick smoke test:"
echo "    tar -xzf \"$RESOURCES_ARCHIVE\" -C /tmp && CODENEST_SIDECAR_PORT=8044 /tmp/sidecar/sidecar &"
echo "    sleep 2 && curl -s http://127.0.0.1:8044/health"
