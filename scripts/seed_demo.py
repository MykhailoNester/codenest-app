"""Seed the demo database with synthetic, internally-consistent data.

The demo DB (``data/codenest.demo.db``) is what every dev run uses by default
so the real prod DB is never touched. This script applies all migrations, then
inserts believable fake members / projects / tasks / inbox / docs / activity.

Usage:
    python scripts/seed_demo.py            # seed once (no-op if already seeded)
    python scripts/seed_demo.py --force    # re-seed on top of existing schema
    python scripts/seed_demo.py --reset     # delete the demo DB, then seed fresh

A hard safety guard aborts unless the resolved database filename is
``codenest.demo.db`` — this script can never write to prod.
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Force the demo environment BEFORE importing app modules: app.config resolves
# DATABASE_PATH at import time, so the env must be set first. Drop any explicit
# path override that could redirect us at the real DB.
os.environ["CODENEST_ENV"] = "demo"
os.environ.pop("CODENEST_DB_PATH", None)

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings  # noqa: E402
from app.database import close_db, get_db, init_db  # noqa: E402

DEMO_FILENAME = "codenest.demo.db"
SEED_MARKER = "demo_seeded"


def _guard_demo_target() -> None:
    """Refuse to run unless the active DB is the demo file."""
    path = Path(settings.DATABASE_PATH)
    if path.name != DEMO_FILENAME:
        sys.exit(
            f"ABORT: resolved database is {path}, not {DEMO_FILENAME}. "
            "seed_demo.py only ever writes to the demo database."
        )


def _delete_demo_files() -> None:
    base = Path(settings.DATABASE_PATH)
    for suffix in ("", "-wal", "-shm"):
        f = base.with_name(base.name + suffix)
        if f.exists():
            f.unlink()
            print(f"  removed {f.name}")


async def _already_seeded(db) -> bool:
    row = await db.execute("SELECT 1 FROM app_settings WHERE key = ?", (SEED_MARKER,))
    return await row.fetchone() is not None


async def _project_id(db, name: str) -> int | None:
    row = await db.execute("SELECT id FROM projects WHERE name = ?", (name,))
    found = await row.fetchone()
    return found["id"] if found else None


async def seed() -> None:
    db = await get_db()

    # ── members (mix of humans and agents) ───────────────────────────────
    members: dict[str, int] = {}
    member_rows = [
        # name, role, type, department, status
        ("Ada Lee", "Senior Engineer", "human", "Engineering", "active"),
        ("Sam Park", "Product Manager", "human", "Product", "active"),
        ("Jordan Diaz", "Designer", "human", "Design", "active"),
        ("Nova", "Research Assistant", "agent", "AI", "active"),
        ("Atlas", "Build & Release Agent", "agent", "Platform", "active"),
    ]
    for name, role, mtype, dept, status in member_rows:
        cur = await db.execute(
            "INSERT INTO members (name, role, type, department, status, joined_date) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, role, mtype, dept, status, "2026-01-15"),
        )
        members[name] = cur.lastrowid

    # ── projects: 2 fictional + attach to existing portfolio projects ────
    projects: dict[str, int] = {}
    fictional = [
        (
            "Acme Storefront",
            "Headless e-commerce rebuild",
            "Next.js, TypeScript, Stripe",
            "active",
        ),
        (
            "Nimbus Analytics",
            "Usage analytics dashboard",
            "Python, FastAPI, DuckDB",
            "active",
        ),
    ]
    for name, desc, stack, status in fictional:
        cur = await db.execute(
            "INSERT INTO projects (name, description, tech_stack, status, path) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, desc, stack, status, f"{name.lower().replace(' ', '-')}/"),
        )
        projects[name] = cur.lastrowid

    # Reuse a couple of already-seeded projects if present so the demo also
    # exercises named project scoping; fall back to Unassigned.
    for portfolio in ("Unassigned",):
        pid = await _project_id(db, portfolio)
        if pid is not None:
            projects[portfolio] = pid

    default_pid = projects.get("Acme Storefront") or projects.get("Unassigned")

    # ── tasks (varied status / priority / effort / assignee) ─────────────
    tasks: dict[str, int] = {}
    task_rows = [
        # key, title, status, priority, effort, project, assignee
        (
            "cart",
            "Build cart & checkout flow",
            "in-progress",
            "high",
            "large",
            "Acme Storefront",
            "Ada Lee",
        ),
        (
            "pdp",
            "Product detail page redesign",
            "todo",
            "high",
            "medium",
            "Acme Storefront",
            "Jordan Diaz",
        ),
        (
            "search",
            "Faceted search & filters",
            "backlog",
            "medium",
            "large",
            "Acme Storefront",
            None,
        ),
        (
            "stripe",
            "Stripe webhook reconciliation",
            "blocked",
            "high",
            "medium",
            "Acme Storefront",
            "Ada Lee",
        ),
        (
            "a11y",
            "Accessibility audit fixes",
            "todo",
            "medium",
            "small",
            "Acme Storefront",
            "Jordan Diaz",
        ),
        (
            "ingest",
            "Event ingestion pipeline",
            "in-progress",
            "high",
            "large",
            "Nimbus Analytics",
            "Atlas",
        ),
        (
            "dash",
            "Retention dashboard widgets",
            "todo",
            "medium",
            "medium",
            "Nimbus Analytics",
            "Sam Park",
        ),
        (
            "export",
            "CSV export endpoint",
            "done",
            "low",
            "small",
            "Nimbus Analytics",
            "Ada Lee",
        ),
        (
            "duckdb",
            "Migrate aggregates to DuckDB",
            "backlog",
            "medium",
            "large",
            "Nimbus Analytics",
            None,
        ),
        (
            "alerts",
            "Anomaly alerting rules",
            "todo",
            "high",
            "medium",
            "Nimbus Analytics",
            "Nova",
        ),
        (
            "docs",
            "Write API reference",
            "todo",
            "low",
            "medium",
            "Nimbus Analytics",
            "Sam Park",
        ),
        (
            "onboard",
            "User onboarding tour",
            "backlog",
            "low",
            "small",
            "Acme Storefront",
            None,
        ),
        (
            "perf",
            "Lighthouse perf budget",
            "in-progress",
            "medium",
            "small",
            "Acme Storefront",
            "Ada Lee",
        ),
    ]
    for key, title, status, priority, effort, proj, assignee in task_rows:
        pid = projects.get(proj) or default_pid
        cur = await db.execute(
            "INSERT INTO tasks (title, description, status, priority, effort, project_id, assignee_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                title,
                f"Synthetic demo task: {title}.",
                status,
                priority,
                effort,
                pid,
                members.get(assignee) if assignee else None,
            ),
        )
        tasks[key] = cur.lastrowid

    # ── task_blockers (so the blocker cascade is demoable) ───────────────
    await db.execute(
        "INSERT INTO task_blockers (blocked_task_id, blocking_task_id, resolved) VALUES (?, ?, 0)",
        (tasks["stripe"], tasks["cart"]),
    )
    await db.execute(
        "INSERT INTO task_blockers (blocked_task_id, blocking_task_id, resolved) VALUES (?, ?, 0)",
        (tasks["dash"], tasks["ingest"]),
    )

    # ── workflow_items (inbox across states) ─────────────────────────────
    inbox_rows = [
        # title, type, priority, status, project
        ("Add gift-card support", "idea", "medium", "inbox", "Acme Storefront"),
        (
            "Investigate slow checkout on mobile",
            "action",
            "high",
            "review",
            "Acme Storefront",
        ),
        (
            "Research competitor pricing tiers",
            "research",
            "medium",
            "inbox",
            "Nimbus Analytics",
        ),
        (
            "Decide on charting library",
            "decision",
            "medium",
            "ready",
            "Nimbus Analytics",
        ),
        ("Bug: duplicate order emails", "action", "high", "review", "Acme Storefront"),
        ("Q3 roadmap brainstorm", "idea", "low", "inbox", "Nimbus Analytics"),
        ("Adopt feature flags", "decision", "low", "done", "Acme Storefront"),
    ]
    for title, itype, priority, status, proj in inbox_rows:
        await db.execute(
            "INSERT INTO workflow_items (title, description, source, type, priority, status, project_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                title,
                f"Synthetic demo item: {title}.",
                "demo",
                itype,
                priority,
                status,
                projects.get(proj),
            ),
        )

    # ── documents ────────────────────────────────────────────────────────
    doc_rows = [
        (
            "Acme Q3 Strategy",
            "strategy",
            "docs/strategy/acme-q3.md",
            "Sam Park",
            "Goals & OKRs for the storefront rebuild.",
        ),
        (
            "Sprint 12 Retro",
            "retro",
            "docs/retros/sprint-12.md",
            "Ada Lee",
            "What went well, what to improve.",
        ),
        (
            "Charting Library Decision",
            "decision",
            "docs/decisions/charting.md",
            "Sam Park",
            "Chose a lightweight charting lib for Nimbus.",
        ),
    ]
    for title, category, fpath, author, summary in doc_rows:
        await db.execute(
            "INSERT INTO documents (title, category, file_path, author_id, summary) "
            "VALUES (?, ?, ?, ?, ?)",
            (title, category, fpath, members.get(author), summary),
        )

    # ── activity_log (so Live Activity views aren't empty) ───────────────
    acme_pid = projects.get("Acme Storefront")
    activity_rows = [
        ("task", tasks["cart"], "created", "Ada Lee", acme_pid),
        ("task", tasks["cart"], "status_changed", "Ada Lee", acme_pid),
        ("task", tasks["stripe"], "status_changed", "Atlas", acme_pid),
        (
            "task",
            tasks["export"],
            "status_changed",
            "Ada Lee",
            projects.get("Nimbus Analytics"),
        ),
        ("workflow_item", None, "created", "Sam Park", acme_pid),
    ]
    # Resolve the workflow_item id for the activity entry referencing inbox.
    inbox_row = await (
        await db.execute("SELECT id FROM workflow_items ORDER BY id LIMIT 1")
    ).fetchone()
    for entity_type, entity_id, action, actor, pid in activity_rows:
        eid = (
            entity_id
            if entity_id is not None
            else (inbox_row["id"] if inbox_row else 0)
        )
        await db.execute(
            "INSERT INTO activity_log (entity_type, entity_id, action, actor, project_id) "
            "VALUES (?, ?, ?, ?, ?)",
            (entity_type, eid, action, actor, pid),
        )

    # ── mark as seeded (idempotency) ─────────────────────────────────────
    await db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?, ?)",
        (SEED_MARKER, "true"),
    )
    await db.commit()

    counts = {}
    for table in (
        "members",
        "projects",
        "tasks",
        "workflow_items",
        "documents",
        "activity_log",
    ):
        row = await (await db.execute(f"SELECT COUNT(*) AS c FROM {table}")).fetchone()
        counts[table] = row["c"]
    print("Seeded demo DB:", ", ".join(f"{k}={v}" for k, v in counts.items()))


async def main(reset: bool, force: bool) -> None:
    _guard_demo_target()
    print(f"Demo database: {settings.DATABASE_PATH}")

    if reset:
        print("Resetting demo database...")
        await close_db()  # ensure no open handle before deleting
        _delete_demo_files()

    await init_db()  # apply all migrations (creates schema + sentinel rows)
    db = await get_db()

    if await _already_seeded(db) and not (reset or force):
        print("Demo data already present — nothing to do. Use --reset or --force.")
        await close_db()
        return

    await seed()
    await close_db()
    print("Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Seed the demo database with synthetic data."
    )
    parser.add_argument(
        "--reset", action="store_true", help="delete the demo DB, then seed fresh"
    )
    parser.add_argument(
        "--force", action="store_true", help="seed even if a marker already exists"
    )
    args = parser.parse_args()
    asyncio.run(main(reset=args.reset, force=args.force))
