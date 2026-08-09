# Local verification gate (no CI — `make check-all` IS the gate, so it runs
# lint + types + the full test suites + a production frontend build across all
# three layers. Tests and the FE build are what catch runtime/module errors
# that typecheck + lint miss — e.g. import cycles and stale tests.)
# Activate the Python venv (.venv) before running the Python targets.

.PHONY: check-rust check-python test-python check-frontend test-frontend build-frontend check-all seed-demo

# .venv's interpreter is a universal2 (arm64 + x86_64) binary, but its compiled
# wheels (mypy, pydantic_core, ...) are arm64-only. Apple Silicon is the only
# architecture this project ships for (see docs/faq.md), yet a parent shell
# running under Rosetta steers that fat binary to its x86_64 slice, which then
# cannot dlopen those wheels — so mypy and pytest fail on import rather than on
# anything in the tree. "arch -arm64" pins execution to the native slice
# regardless of the calling shell's translation state.
PYTHON := arch -arm64 python3

# Seed the demo database (data/codenest.demo.db) with synthetic data.
# Pass ARGS=--reset to rebuild it from scratch.
seed-demo:
	$(PYTHON) scripts/seed_demo.py $(ARGS)

check-rust:
	cd src-tauri && cargo check
	cd src-tauri && cargo clippy --all-targets -- -D warnings

check-python:
	ruff format --check .
	ruff check .
	$(PYTHON) -m mypy app/

test-python:
	$(PYTHON) -m pytest app/tests tests/sidecar -q

check-frontend:
	pnpm --filter frontend run typecheck
	pnpm --filter frontend run lint

test-frontend:
	pnpm --filter frontend run test

# Production build — compiles the bundle the app actually loads; catches missing
# imports/assets that dev never surfaces.
build-frontend:
	pnpm --filter frontend run build

check-all: check-rust check-python test-python check-frontend test-frontend build-frontend
