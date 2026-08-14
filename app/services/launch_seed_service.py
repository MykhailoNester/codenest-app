"""Launch seed service.

Centralises prompt composition and seed building for the task-launch feature.
The endpoint `GET /api/v1/launch/seed` returns a `LaunchSeed` that the
frontend uses to pre-fill the Launch modal.

Design D1: prompt composition lives here so that future consumers (slash
commands, global shortcuts) share the same formatting without duplicating
field access logic.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence

import aiosqlite
from fastapi import HTTPException

from app.models.launch import (
    LaunchPromptSection,
    LaunchSeed,
    LaunchSeedProject,
    LaunchSeedSource,
)
from app.services import agent_override_service, launch_override_service, task_service
from app.services.provider_service import list_providers

_CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    """Approximate the token count of `text`.

    Deliberately NOT a tokenizer: `ceil(len(text) / 4)`, the ~4-characters-per-
    token rule of thumb for English prose. This decorates a pre-flight checkbox
    list; it is never used for billing, truncation or a context-window decision,
    so it does not justify a tokenizer dependency or a network round trip. Every
    surface that renders it prefixes a tilde. Section separators are not counted.
    """
    return (len(text) + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


async def build_sections(
    db: aiosqlite.Connection,
    *,
    source_kind: str,
    source_id: int,
    title: str,
    description: str | None,
    action_text: str | None,
    project: LaunchSeedProject | None,
) -> list[LaunchPromptSection]:
    """Build the ordered, toggleable prompt sections for a source.

    Format (per design D1):

        You are working on {kind} #{id}: {title}

        {description}

        Suggested action: {action_text}   ← only when action_text is present

        Project: {name} ({path})           ← only when project is non-null

        Labels: {names}                    ← task only, off by default (D2)

    Each entry is present only when it has text — a task with no description
    yields no `description` section, never one with `text=""`. The guards
    are the same truthiness checks `compose_prompt` used before this split.
    """
    sections: list[LaunchPromptSection] = []

    title_text = f"You are working on {source_kind} #{source_id}: {title}"
    sections.append(
        LaunchPromptSection(
            id="title",
            label="Title + ref",
            text=title_text,
            tokens=estimate_tokens(title_text),
            default_on=True,
        )
    )

    if description:
        sections.append(
            LaunchPromptSection(
                id="description",
                label="Description",
                text=description,
                tokens=estimate_tokens(description),
                default_on=True,
            )
        )

    if action_text:
        action_text_full = f"Suggested action: {action_text}"
        sections.append(
            LaunchPromptSection(
                id="action",
                label="Suggested action",
                text=action_text_full,
                tokens=estimate_tokens(action_text_full),
                default_on=True,
            )
        )

    if project:
        path_part = f" ({project.path})" if project.path else ""
        project_text = f"Project: {project.name}{path_part}"
        sections.append(
            LaunchPromptSection(
                id="project",
                label="Project",
                text=project_text,
                tokens=estimate_tokens(project_text),
                default_on=True,
            )
        )

    if source_kind == "task":
        labels = await task_service.list_task_labels(db, source_id)
        names = [str(row["label"]) for row in labels]
        if names:
            labels_text = f"Labels: {', '.join(names)}"
            sections.append(
                LaunchPromptSection(
                    id="labels",
                    label="Labels",
                    text=labels_text,
                    tokens=estimate_tokens(labels_text),
                    # D2: off by default — a default-on Labels row would
                    # change `prompt` for every labelled task that exists
                    # today, breaking the "all-enabled composition is
                    # byte-identical to today's compose_prompt" invariant
                    # and drifting every saved prompt_override written from
                    # it. Flip once LaunchModal is deleted (see Follow-ups).
                    default_on=False,
                )
            )

    return sections


def default_enabled_ids(sections: Sequence[LaunchPromptSection]) -> list[str]:
    return [s.id for s in sections if s.default_on]


def compose_prompt(
    sections: Sequence[LaunchPromptSection],
    enabled_ids: Collection[str],
) -> str:
    """Join the enabled sections, in section order, with a blank line between.

    The separator is "\\n\\n" and it is duplicated in
    frontend/src/lib/launch-composer.ts (SECTION_SEPARATOR); the two are pinned
    against the same expected strings on both sides. Unknown ids in `enabled_ids`
    are ignored; the caller cannot reorder by reordering `enabled_ids`.
    """
    return "\n\n".join(s.text for s in sections if s.id in enabled_ids)


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

    # ── Build sections and compose prompt ─────────────────────────────────────
    sections = await build_sections(
        db,
        source_kind=source_kind,
        source_id=source_id,
        title=title,
        description=description,
        action_text=action_text,
        project=project,
    )
    prompt = compose_prompt(sections, default_enabled_ids(sections))

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
        sections=sections,
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
