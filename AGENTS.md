# Codenest — Agent & Contributor Guide

Codenest is a desktop app for running and supervising AI agent teams: a Tauri 2 (Rust)
shell hosting a React/TypeScript frontend, with a FastAPI (Python) sidecar owning all state in
SQLite. Embedded terminals run real `claude` sessions; the app tracks their tasks, telemetry,
schedules, and MCP configuration. The stack is cross-platform (macOS, Windows, Linux); today it
is built and tested only on macOS (Apple Silicon).

## Setup (fresh clone)

Prerequisites: macOS (Apple Silicon for dev), Xcode Command Line Tools, Rust (stable),
Node 20+ with pnpm, Python 3.12.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
pnpm install
pnpm tauri:dev                  # full app: Vite on :1420 + Rust shell + sidecar from .venv
```

`pnpm tauri:dev` builds the sidecar archive on first run if it is missing (Tauri
`beforeDevCommand` hook) and `pnpm tauri:build` always rebuilds it, so
`bash scripts/build-sidecar.sh` is only needed to prebuild it by hand.

## Commands

There is one verification gate: **`make check-all`** must pass before any change is done.

| Command | What it does |
|---|---|
| `pnpm tauri:dev` | Run the full app in dev mode |
| `pnpm tauri:build` | Production `.app` + DMG bundle |
| `make check-all` | check-rust + check-python + test-python + check-frontend + test-frontend + build-frontend |
| `make check-rust` | `cargo check` + `cargo clippy --all-targets -- -D warnings` (in `src-tauri/`) |
| `make check-python` | `ruff format --check .` + `ruff check .` + `mypy app/` |
| `make test-python` | `python -m pytest app/tests tests/sidecar -q` |
| `make check-frontend` | `tsc -b --noEmit` + eslint |
| `make test-frontend` | `vitest run` (jsdom; tests in `src/**/__tests__/`) |
| `make seed-demo` | Seed `data/codenest.demo.db` with synthetic demo data (`ARGS=--reset` to wipe) |
| `bash scripts/build-sidecar.sh` | PyInstaller onedir sidecar → `src-tauri/resources/sidecar.tar.gz` (host arch only) |
| Sidecar standalone | venv active: `uvicorn main:app --port 8002` (rare — API testing in isolation) |

## Directory map

```
main.py               # sidecar entrypoint (frozen PyInstaller binary runs the __main__ branch)
app/                  # FastAPI sidecar: routers/ (thin HTTP), services/ (all business logic),
                      #   models/, config.py (env + DB paths), database.py (migration runner)
frontend/src/         # React app: pages/, components/, lib/ (api.ts, ipc.ts, nav-items.ts),
                      #   stores/ (zustand), hooks/, styles/ (design tokens)
src-tauri/src/        # Rust shell: lib.rs (commands/wiring), sidecar/ (spawn + health),
                      #   pty/ (terminals), session/, scheduler/, tray/, workspace/, commands/,
                      #   fswatch/ (live filesystem watcher for the workspace navigator)
src-tauri/resources/org-agents/   # bundled org agents + manifest.json (sha256 per file)
migrations/           # append-only NNN_*.sql; 000_baseline_schema.sql is the initial DB state
scripts/              # build-sidecar.sh, pyinstaller.spec, seed_demo.py
tests/sidecar/        # pytest integration suite (fresh migrated SQLite per test)
data/                 # local dev DBs (gitignored; auto-created)
```

## Runtime architecture

The Rust shell is the process supervisor. On launch it spawns the sidecar (dev: `.venv`
uvicorn on port 8002, no `--reload`; release: PyInstaller onedir extracted once per version
into app-data) and polls `GET /health` — a 200 means migrations have applied and the app is
ready. The frontend talks HTTP/SSE to the sidecar at `127.0.0.1:8002` and uses Tauri `invoke`
for shell things: PTYs (xterm.js terminals), windows, preview webview, screenshots, git.
Scheduling is split by design: the sidecar queues due cron runs in SQLite; the Rust scheduler
polls for pending runs and spawns headless `claude` processes. The Command Center bootstrap
(deferred, idempotent) creates the app-data workspace and installs the bundled org-agents.

## Environment variables

| Var | Effect | Default |
|---|---|---|
| `CODENEST_ENV` | `demo` or `prod` — selects the DB file | `demo` in dev; `prod` when packaged |
| `CODENEST_DB_PATH` | Absolute DB path override (tests/CI); wins over `CODENEST_ENV` | unset |
| `CODENEST_SIDECAR_PORT` | Sidecar port for standalone runs (the shell pins 8002) | `8002` |
| `CODENEST_APP_DATA_DIR` | App-data root; injected by the shell | platformdirs fallback |
| `CODENEST_BUNDLE_RESOURCES` | Bundled org-agents dir; injected by the shell | `src-tauri/resources/org-agents` |
| `CODENEST_DISABLE_SCHEDULE_TICK` | `1` disables background tick loops (tests) | off |
| `VITE_SIDECAR_URL` | Frontend override for the sidecar base URL | `http://127.0.0.1:8002` |

DB locations: dev demo `data/codenest.demo.db`; dev prod `data/codenest.db`;
packaged `~/Library/Application Support/com.codenest.dashboard/codenest.db`.

## Hard rules

- **Migrations are append-only.** Plain SQL files `NNN_*.sql`, applied sorted by filename via
  `executescript`, recorded by filename stem in `schema_migrations`, skipped if recorded —
  content is never re-checked. Never edit an applied migration; never rename
  `000_baseline_schema.sql`. **Never reuse the stems** `000_baseline_schema`,
  `001_agent_sessions_pane_id`, `001_workflow_labels`, `002_schedule_artifact_dir`
  (recorded in existing installs) — start new migrations at `003_`.
- **A freshly migrated DB ships empty** apart from functional reference data (settings defaults,
  taxonomies, catalog). No people, no projects, no history. `make seed-demo` is the only way
  demo data enters a DB, and only the repo-local demo DB.
- **The dev sidecar has no `--reload`.** Python edits require an app restart; only the Vite
  frontend hot-reloads.
- **Process spawning lives in the Rust shell, never the sidecar.** The sidecar owns state and
  queues; the shell owns child processes. Bridged by poll-dispatch.
- **The sidecar binds `127.0.0.1` only** and is deliberately unauthenticated; the MCP manager's
  trust model (registering a server executes a local command) depends on loopback-only binding.
  Never widen the bind address or CORS allowlist.
- **Frontend chrome renders only from known-good state.** `FEATURE_DEFAULTS` in
  `frontend/src/lib/nav-items.ts` must mirror `_FEATURES_DEFAULT` in
  `app/services/settings_service.py`. Left-nav visibility is governed solely by feature toggles.
- **Org-agent bundle is manifest-driven.** Editing any file in
  `src-tauri/resources/org-agents/` requires recomputing its sha256 in `manifest.json`
  (and bumping the manifest `version`). Installs are idempotent, per-file-hash-diffed;
  user edits are reverted on next launch.
- **`sidecar.tar.gz` is a build artifact** (gitignored). Rebuild with `scripts/build-sidecar.sh`
  after sidecar changes and before `pnpm tauri:build`.
- The Rust binary name `Codenest` (Cargo `[[bin]]`) must match `mainBinaryName` in
  `tauri.conf.json`. The macOS app menu deliberately omits Cmd+W "Close Window" — the frontend
  owns Cmd+W for tab close; don't reintroduce it.

## Bundled org-agents

Installed into every user's app-data workspace at first run (read-only, symlinked into the
Command Center workspace's `.claude/agents/`):

- **Atlas** (`atlas-recruiter.md`) — recruiting & team architecture: designs new agent
  definitions for the user's team and registers them in the dashboard via Orion.
- **Orion** (`orion-ops.md`) — IT & workflow operations: the sole gateway for dashboard DB
  writes; other agents route natural-language requests through it and it executes the
  corresponding `http://localhost:8002/api/v1/` calls (tasks, inbox, team, documents).
- **Vega** (`vega-research.md`) — lead researcher: produces structured markdown research
  reports and files follow-up tasks/inbox items via Orion.

Agents must never call the dashboard API directly for writes — Orion is the gateway.

## Testing

Python: `make test-python` (unit in `app/tests/`, integration in `tests/sidecar/` — each test
gets a fresh migrated SQLite via the `migrated_db` fixture). Bare `pytest` from the repo
root works too — test paths come from `pytest.ini`. Frontend: `make test-frontend`
plus `make check-frontend` for types/lint. Rust: `cargo test` in `src-tauri/` (unit tests in
pty, window, scheduler, docs modules). New services/routers should land with tests; schema
changes must keep `tests/sidecar/test_migrations` green.

## Commits & PRs

- Small, focused commits; short imperative subject lines. No `Co-Authored-By` trailers.
- One layer per PR where possible (sidecar / frontend / shell); cross-layer changes should
  explain the contract change in the description.
- `make check-all` must pass before requesting review.
