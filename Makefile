# Local verification gate (no CI — `make check-all` IS the gate, so it runs
# lint + types + the full test suites + a production frontend build across all
# three layers. Tests and the FE build are what catch runtime/module errors
# that typecheck + lint miss — e.g. import cycles and stale tests.)
# Activate the Python venv (.venv) before running the Python targets.

.PHONY: check-rust check-python test-python check-frontend test-frontend build-frontend check-all seed-demo

# Seed the demo database (data/codenest.demo.db) with synthetic data.
# Pass ARGS=--reset to rebuild it from scratch.
seed-demo:
	python scripts/seed_demo.py $(ARGS)

check-rust:
	cd src-tauri && cargo check
	cd src-tauri && cargo clippy --all-targets -- -D warnings

check-python:
	ruff format --check .
	ruff check .
	mypy app/

test-python:
	python -m pytest app/tests tests/sidecar -q

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
