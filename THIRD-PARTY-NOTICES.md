# Third-Party Notices

Codenest bundles third-party open-source software. This document lists the
**direct dependencies** that ship in the distributed DMG, grouped by layer, with
their declared SPDX license identifiers.

Scope and accuracy:

- This covers **direct** dependencies only — the packages Codenest declares, not
  their transitive dependency trees. A full transitive inventory would be much
  larger.
- Build-time-only and test-only dependencies (linters, type checkers, bundlers,
  test runners) are **excluded** because they are not part of the shipped app.
  Where a dependency is build-time-only but listed for completeness, it is
  marked as such.
- There is **no automated license-collection tooling** in this repository today.
  This file is maintained **manually**: to regenerate it, re-read
  `frontend/package.json` (`dependencies`), `src-tauri/Cargo.toml`
  (`[dependencies]` and the macOS target block), and the runtime section of
  `requirements.txt`, then read each package's declared license (for npm
  packages, the `license` field in `node_modules/<pkg>/package.json`).

Each dependency remains under its own license; consult the individual project
for full license text.

## Frontend (`frontend/package.json` — runtime `dependencies`)

| Package | License |
|---|---|
| `@tanstack/react-query` | MIT |
| `@tanstack/react-virtual` | MIT |
| `@crabnebula/tauri-plugin-drag` | MIT OR Apache-2.0 (see note) |
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-global-shortcut` | MIT OR Apache-2.0 |
| `@xterm/addon-fit` | MIT |
| `@xterm/addon-search` | MIT |
| `@xterm/addon-web-links` | MIT |
| `@xterm/addon-webgl` | MIT |
| `@xterm/xterm` | MIT |
| `react` | MIT |
| `react-dom` | MIT |
| `react-grid-layout` | MIT |
| `react-markdown` | MIT |
| `react-resizable` | MIT |
| `react-resizable-panels` | MIT |
| `react-router-dom` | MIT |
| `recharts` | MIT |
| `remark-gfm` | MIT |
| `sonner` | MIT |
| `zustand` | MIT |

Note: `@crabnebula/tauri-plugin-drag` does not declare a `license` field in its
published `package.json`. Its upstream repository publishes it under
MIT OR Apache-2.0; that dual license is reported here.

The frontend `devDependencies` (TypeScript, ESLint, Prettier, Vite, Vitest,
testing libraries, type stubs) are build/test-time only and are not distributed.

## Rust shell (`src-tauri/Cargo.toml`)

Runtime `[dependencies]`:

| Crate | License |
|---|---|
| `serde_json` | MIT OR Apache-2.0 |
| `serde` | MIT OR Apache-2.0 |
| `log` | MIT OR Apache-2.0 |
| `tauri` | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | Apache-2.0 OR MIT |
| `tauri-plugin-drag` | Apache-2.0 OR MIT |
| `tauri-plugin-global-shortcut` | Apache-2.0 OR MIT |
| `tauri-plugin-log` | Apache-2.0 OR MIT |
| `tauri-plugin-notification` | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | Apache-2.0 OR MIT |
| `tauri-plugin-window-state` | Apache-2.0 OR MIT |
| `portable-pty` | MIT |
| `uuid` | Apache-2.0 OR MIT |
| `base64` | MIT OR Apache-2.0 |
| `libc` | MIT OR Apache-2.0 |
| `url` | MIT OR Apache-2.0 |
| `reqwest` | MIT OR Apache-2.0 |

macOS target `[dependencies]` (`cfg(target_os = "macos")`):

| Crate | License |
|---|---|
| `objc2` | MIT |
| `objc2-app-kit` | Zlib OR Apache-2.0 OR MIT |
| `objc2-foundation` | MIT |
| `core-graphics` | MIT OR Apache-2.0 |

Build-time `[build-dependencies]`:

| Crate | License |
|---|---|
| `tauri-build` | Apache-2.0 OR MIT (build-time only) |

## Python sidecar (`requirements.txt` — runtime)

| Package | License |
|---|---|
| `fastapi` | MIT |
| `uvicorn` | BSD-3-Clause |
| `aiosqlite` | MIT |
| `platformdirs` | MIT |
| `croniter` | MIT |

The `requirements.txt` dev tooling and testing sections (`ruff`, `mypy`,
`types-croniter`, `pyinstaller`, `pytest`, `pytest-asyncio`, `httpx`) are
build/test-time only and are not distributed.
