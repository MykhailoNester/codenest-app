# Contributing to Codenest

Thanks for your interest in Codenest. This guide covers setup, the local
development loop, the verification gate, and the conventions the project
follows.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Platform support

Codenest runs on a cross-platform stack — Tauri 2, a Python/FastAPI sidecar, and
a React frontend — so it is meant to build and run on macOS, Windows, and Linux.

For now it has only been built and tested on **macOS (Apple Silicon)**. That is
the one supported platform today, and the setup steps below assume it. Bringing
the build up on other platforms is on the roadmap, and help is welcome.

The first GitHub release ships a macOS `.dmg`; artifacts for other platforms
(and Intel Macs) will follow as each one is tested.

## Prerequisites

- macOS (Apple Silicon) — the only platform tested so far
- Xcode Command Line Tools
- Rust (stable, 1.88+)
- Node 20+ with [pnpm](https://pnpm.io/)
- Python 3.12

## Setup (fresh clone)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
pnpm install
pnpm tauri:dev     # full app; the sidecar archive auto-builds on first run
```

The Tauri `beforeDevCommand` hook builds the Python sidecar archive
(`bash scripts/build-sidecar.sh`) if it is missing, then starts Vite; the shell
launches the sidecar from your `.venv`. `pnpm tauri:build` rebuilds the sidecar
every time and produces a `.app` + DMG.

Most Python tooling assumes the venv is active — run `source .venv/bin/activate`
first, or call `.venv/bin/<tool>` directly.

## Development loop

- **The sidecar has no `--reload`.** After editing Python under `app/` (or
  `main.py`), **restart the app** for changes to take effect.
- **The frontend hot-reloads.** Vite picks up changes to `frontend/src/`
  immediately; no restart needed.
- **Rust shell changes** require rebuilding, which `pnpm tauri:dev` handles on
  the next launch.

## The verification gate

There is one gate, and it must pass before you open a pull request:

```bash
make check-all
```

It runs, in order:

- `make check-rust` — `cargo check` + `cargo clippy --all-targets -- -D warnings`
- `make check-python` — `ruff format --check .` + `ruff check .` + `mypy app/`
- `make test-python` — the pytest suites
- `make check-frontend` — `tsc` typecheck + ESLint
- `make test-frontend` — Vitest
- `make build-frontend` — a production frontend build (catches missing
  imports/assets that dev never surfaces)

## Project layout

```
main.py            # sidecar entrypoint (also the frozen PyInstaller __main__)
app/               # FastAPI sidecar
  routers/         #   thin HTTP endpoints
  services/        #   business logic
  config.py        #   env + DB path resolution
  database.py      #   migration runner
frontend/src/      # React + TypeScript app (pages/, components/, lib/, stores/)
src-tauri/src/     # Rust shell (lib.rs wiring, sidecar/, pty/, session/, scheduler/)
migrations/        # append-only NNN_*.sql schema files
scripts/           # build-sidecar.sh, pyinstaller.spec, seed helpers
tests/             # sidecar integration suite
```

## Database migrations

Migrations are **append-only** plain SQL files named `NNN_*.sql`, applied in
filename order and recorded in `schema_migrations` **by filename stem**. Once a
migration has been applied, its content is never re-checked.

- Never edit a migration that has already been applied.
- Never rename `000_baseline_schema.sql`.
- Never reuse a burned stem. These stems are already recorded in existing
  installs and would be silently skipped:
  - `000_baseline_schema`
  - `001_agent_sessions_pane_id`
  - `001_workflow_labels`
  - `002_schedule_artifact_dir`
- Start new migrations at `003_`.

## Bundled agents

The agent definitions in `src-tauri/resources/org-agents/*.md` are
manifest-driven. If you edit any of them, you must recompute that file's
`sha256` in `src-tauri/resources/org-agents/manifest.json` and bump the manifest
`version` — otherwise the change will not be picked up (installs are
per-file-hash-diffed and user edits are reverted on next launch).

## Licensing of contributions

Codenest is released under the Functional Source License, Version 1.1, ALv2
Future License (`FSL-1.1-ALv2`; see [LICENSE](LICENSE)), and contributions are
accepted under that same license.

To keep the project's licensing unambiguous — and to preserve the maintainer's
ability to offer the software under additional terms in the future (for example
a commercial license) — every commit must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/) (DCO). The
DCO is a lightweight statement that you wrote the change, or otherwise have the
right to submit it under the project's license. It is **not** a copyright
assignment.

Sign off each commit by adding a trailer with your real name and email:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it automatically. Commits without a sign-off cannot be
merged. (This is distinct from the banned `Co-Authored-By` trailer below.)

## Pull requests

- Keep PRs small and focused. Where possible, touch **one layer** (sidecar /
  frontend / shell); if a change crosses layers, describe the contract change in
  the PR description.
- Write short, imperative commit subject lines.
- **Do not add `Co-Authored-By` trailers.**
- `make check-all` must pass before you request review.

**Fork builds are unsigned — that is expected.** You will hit the same
Gatekeeper prompt described in [docs/install.md](docs/install.md) when running a
build you produced yourself.

## Troubleshooting

- **The first build is slow.** The sidecar is built with PyInstaller and the
  Rust shell does a cold `cargo` compile. Subsequent builds are much faster.
- **Port 8002 is stuck / the app can't start the sidecar.** An orphaned sidecar
  process is probably holding the port. Find and kill it:

  ```bash
  lsof -i :8002
  kill <pid>
  ```
