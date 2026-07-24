"""Launch seed service.

Centralises prompt composition and seed building for the task-launch feature.
The endpoint `GET /api/v1/launch/seed` returns a `LaunchSeed` that the
frontend uses to pre-fill the Launch modal.

Design D1: prompt composition lives here so that future consumers (slash
commands, global shortcuts) share the same formatting without duplicating
field access logic.
"""

from __future__ import annotations

import aiosqlite
from fastapi import HTTPException

from app.models.launch import LaunchSeed, LaunchSeedProject, LaunchSeedSource
from app.services import agent_override_service, launch_override_service
from app.services.provider_service import list_providers


def compose_prompt(
    title: str,
    description: str | None,
    action_text: str | None,
    project: LaunchSeedProject | None,
    *,
    source_kind: str,
    source_id: int,
) -> str:
    """Build the seeded prompt string from source fields.

    Format (per design D1):

        You are working on {kind} #{id}: {title}

        {description}

        Suggested action: {action_text}   ← only when action_text is present

        Project: {name} ({path})           ← only when project is non-null
    """
    lines: list[str] = [f"You are working on {source_kind} #{source_id}: {title}"]

    if description:
        lines.append("")
        lines.append(description)

    if action_text:
        lines.append("")
        lines.append(f"Suggested action: {action_text}")

    if project:
        path_part = f" ({project.path})" if project.path else ""
        lines.append("")
        lines.append(f"Project: {project.name}{path_part}")

    return "\n".join(lines)


async def build_seed(
    db: aiosqlite.Connection,
    source_kind: str,
    source_id: int,
) -> LaunchSeed:
    """Build a `LaunchSeed` for the given source.

    1. Load the source row (tasks or workflow_items) — 404 if missing.
    2. Resolve the project row from source.project_id — None if NULL or gone.
    3. Load the per-source override — None if absent.
    4. Pick defaults from the first enabled provider.
    5. Merge override over defaults and return.
    """
    # ── Load source row ───────────────────────────────────────────────────────
    if source_kind == "task":
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (source_id,))
    else:
        cur = await db.execute(
            "SELECT * FROM workflow_items WHERE id = ?", (source_id,)
        )
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"{source_kind} #{source_id} not found"
        )

    title: str = row["title"]
    description: str | None = (
        row["description"] if "description" in row.keys() else None  # noqa: SIM118
    )
    action_text: str | None = (
        row["action_text"] if "action_text" in row.keys() else None  # noqa: SIM118
    )
    project_id_raw: int | None = (
        row["project_id"] if "project_id" in row.keys() else None  # noqa: SIM118
    )

    # ── Resolve project ───────────────────────────────────────────────────────
    project: LaunchSeedProject | None = None
    if project_id_raw is not None:
        cur = await db.execute(
            "SELECT id, name, path FROM projects WHERE id = ?", (project_id_raw,)
        )
        proj_row = await cur.fetchone()
        if proj_row is not None:
            project = LaunchSeedProject(
                id=proj_row["id"],
                name=proj_row["name"],
                path=proj_row["path"],
            )

    # ── Compose prompt ────────────────────────────────────────────────────────
    prompt = compose_prompt(
        title=title,
        description=description,
        action_text=action_text,
        project=project,
        source_kind=source_kind,
        source_id=source_id,
    )

    # ── Load per-source override ──────────────────────────────────────────────
    override = await launch_override_service.get_override(db, source_kind, source_id)
    has_override = override is not None

    # ── Load assignee's per-agent override as a fallback ───────────
    agent_override = None
    if source_kind == "task":
        assignee_id_raw = row["assignee_id"] if "assignee_id" in row.keys() else None  # noqa: SIM118
        if assignee_id_raw is not None:
            mcur = await db.execute(
                "SELECT name FROM members WHERE id = ?", (assignee_id_raw,)
            )
            mrow = await mcur.fetchone()
            if mrow is not None and mrow["name"]:
                agent_override = await agent_override_service.get_override(
                    db, str(mrow["name"])
                )

    # ── Provider defaults ─────────────────────────────────────────────────────
    providers = await list_providers(db, only_enabled=True)
    default_provider = providers[0] if providers else None

    # Resolution order: task-source override > agent override > first enabled provider.
    if override and override.provider_id is not None:
        provider_id = override.provider_id
    elif agent_override and agent_override.provider_id is not None:
        provider_id = agent_override.provider_id
    elif default_provider:
        provider_id = default_provider.id
    else:
        provider_id = 1

    # Resolve model: source override > agent override > provider default_model > None
    model: str | None
    if override and override.model is not None:
        model = override.model
    elif agent_override and agent_override.model is not None:
        model = agent_override.model
    elif default_provider and default_provider.default_model is not None:
        model = default_provider.default_model
    else:
        model = None

    # Grid / target / fanout: from override when set, else sensible defaults.
    rows: int = override.rows if override and override.rows is not None else 1
    cols: int = override.cols if override and override.cols is not None else 1
    target = override.target if override and override.target is not None else "embedded"
    profile_id: int | None = (
        override.profile_id if override and override.profile_id is not None else None
    )
    extra_args: str | None = (
        override.extra_args if override and override.extra_args is not None else None
    )
    prompt_fanout = (
        override.prompt_fanout
        if override and override.prompt_fanout is not None
        else "primary"
    )

    url_fragment = f"/tasks/{source_id}" if source_kind == "task" else "/inbox"

    return LaunchSeed(
        source=LaunchSeedSource(
            kind=source_kind,  # type: ignore[arg-type]
            id=source_id,
            title=title,
            url=url_fragment,
        ),
        project=project,
        prompt=prompt,
        provider_id=provider_id,
        model=model,
        rows=rows,
        cols=cols,
        target=target,  # type: ignore[arg-type]
        profile_id=profile_id,
        extra_args=extra_args,
        prompt_fanout=prompt_fanout,  # type: ignore[arg-type]
        has_override=has_override,
    )
