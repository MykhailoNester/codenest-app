"""Pydantic models for the launch-agents-grid feature.

Covers providers (read-only registry) and launch presets (user-saved
launch configurations).  These models are imported by both the service
layer and the router layer — keep them free of database imports.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class Provider(BaseModel):
    """Public provider record. ``api_key`` is intentionally absent here —
    the cleartext secret never leaves the sidecar. ``has_api_key`` tells
    the UI whether to render "(set)" vs an empty input."""

    id: int
    name: str
    display_name: str
    command_template: str
    default_args: str
    is_enabled: bool
    color: str | None = None
    default_env: dict[str, str] = {}
    models: list[str] = ["default"]
    default_model: str | None = None
    has_api_key: bool = False
    base_url: str | None = None


class ProviderCreate(BaseModel):
    name: str
    display_name: str
    command_template: str = "claude {extra_args}"
    default_args: str = ""
    default_env: dict[str, str] = {}
    color: str | None = None
    is_enabled: bool = True
    api_key: str | None = None
    base_url: str | None = None


class ProviderUpdate(BaseModel):
    display_name: str | None = None
    command_template: str | None = None
    default_args: str | None = None
    default_env: dict[str, str] | None = None
    color: str | None = None
    is_enabled: bool | None = None
    api_key: str | None = None
    base_url: str | None = None


class ProviderModel(BaseModel):
    id: int
    provider_id: int
    model_name: str
    display_name: str
    is_default: bool
    is_enabled: bool


class ProviderStats(BaseModel):
    """Aggregate session statistics for a provider over a time window.

    `provider_id = None` represents the synthetic "Unknown" bucket — sessions
    whose `model` is set but not present in `provider_models`.
    """

    provider_id: int | None
    name: str
    display_name: str
    color: str | None
    default_model: str | None
    sessions: int
    sessions_today: int
    cost_usd: float
    tokens_in: int
    tokens_out: int
    linked_projects: int
    linked_tasks: int


# ---------------------------------------------------------------------------
# Launch presets — pane list (migrations 005_launch_preset_panes,
#                             008_launch_presets_drop_grid)
# ---------------------------------------------------------------------------
#
# A preset stores what the launch composer actually produces: an ordered list
# of typed panes plus a split mode. 008 dropped the rows x cols x provider_id
# grid header the table had carried since 2024, so this is now the only shape a
# preset has — there is no grid body to accept and no grid row to read back.
# `SplitMode` mirrors the type of the same name in
# `frontend/src/lib/launch-composer.ts:27`; `PresetPane` mirrors `ComposerPane`
# (`lib/launch-composer.ts:54`).

SplitMode = Literal["cols", "rows", "grid"]


class AgentPresetPane(BaseModel):
    """One agent pane in a saved preset's pane list."""

    kind: Literal["agent"] = "agent"
    provider_id: int
    model: str | None = None
    permission_mode: str = ""
    send_prompt: bool = True


class ShellPresetPane(BaseModel):
    """One shell pane in a saved preset's pane list."""

    kind: Literal["shell"] = "shell"
    shell: str = ""
    command: str = ""


PresetPane = Annotated[AgentPresetPane | ShellPresetPane, Field(discriminator="kind")]


class PresetUnresolved(BaseModel):
    """One pane whose provider no longer exists or is disabled (read-time)."""

    pane_index: int
    provider_id: int
    reason: Literal["missing", "disabled"]


class LaunchPresetBase(BaseModel):
    name: str = Field(..., min_length=1)
    project_id: int
    extra_args: str = ""
    target: Literal["embedded", "popout"]
    profile_id: int | None = None


class LaunchPresetCreate(LaunchPresetBase):
    """A preset body: an ordered pane list plus how to split the window.

    `panes` is required and `split` defaults to "cols" in the service. Any
    composition the composer can build is storable, shell-only included — the
    `provider_id`/`rows`/`cols` the old body carried existed only to satisfy
    NOT NULL columns that migration 008 removed.
    """

    panes: list[PresetPane]
    split: SplitMode | None = None


class LaunchPreset(LaunchPresetBase):
    id: int
    created_at: str
    panes: list[PresetPane]
    split: SplitMode
    unresolved: list[PresetUnresolved] = []


# ---------------------------------------------------------------------------
# Launch source overrides (task-launch feature)
# ---------------------------------------------------------------------------

SourceKind = Literal["task", "inbox"]
PromptFanout = Literal["primary", "every", "none"]
LaunchTarget = Literal["embedded", "popout"]


class LaunchOverride(BaseModel):
    """Represents a persisted per-source launch override row."""

    source_kind: SourceKind
    source_id: int
    project_id: int | None = None
    provider_id: int | None = None
    model: str | None = None
    rows: int | None = None
    cols: int | None = None
    target: LaunchTarget | None = None
    profile_id: int | None = None
    extra_args: str | None = None
    prompt_fanout: PromptFanout | None = None
    prompt_override: str | None = None
    updated_at: str | None = None


class LaunchOverrideUpsert(BaseModel):
    """Fields accepted by PUT /api/v1/launch/overrides/{kind}/{id}.

    All fields are optional — a minimal PUT body just with a changed model
    is valid.  Missing fields are written as NULL (not merged), so this is
    a full-replace upsert rather than a partial patch.
    """

    project_id: int | None = None
    provider_id: int | None = None
    model: str | None = None
    rows: int | None = None
    cols: int | None = None
    target: LaunchTarget | None = None
    profile_id: int | None = None
    extra_args: str | None = None
    prompt_fanout: PromptFanout | None = None
    prompt_override: str | None = None


# ---------------------------------------------------------------------------
# Per-agent launch override
# ---------------------------------------------------------------------------


class AgentOverride(BaseModel):
    """Per-agent provider/model override keyed on agent name."""

    agent_name: str
    provider_id: int | None = None
    model: str | None = None
    updated_at: str | None = None


class AgentOverrideUpsert(BaseModel):
    provider_id: int | None = None
    model: str | None = None


# ---------------------------------------------------------------------------
# Launch seed (task-launch feature)
# ---------------------------------------------------------------------------


class LaunchSeedSource(BaseModel):
    kind: SourceKind
    id: int
    title: str
    url: str


class LaunchSeedProject(BaseModel):
    id: int
    name: str
    path: str | None = None


LaunchSectionId = Literal["title", "description", "action", "project", "labels"]


class LaunchPromptSection(BaseModel):
    """One toggleable block of the seeded prompt.

    `tokens` is an approximation — see `launch_seed_service.estimate_tokens`.
    A section is only ever emitted when it has text, so `text` is never "".
    """

    id: LaunchSectionId
    label: str
    text: str
    tokens: int
    default_on: bool


class LaunchSeed(BaseModel):
    """Complete launch seed payload returned by GET /api/v1/launch/seed."""

    source: LaunchSeedSource
    project: LaunchSeedProject | None = None
    prompt: str  # == "\n\n".join(s.text for s in sections if s.default_on).
    # The flat projection of the `default_on` sections below, for a consumer
    # with no section UI of its own — the frontend still passes it as the
    # launch composer's `initialPrompt` for the never-observed-empty-sections
    # case (`test_prompt_is_the_join_of_default_on_sections` pins the join).
    sections: list[LaunchPromptSection] = []
    provider_id: int
    model: str | None = None
    rows: int = 1
    cols: int = 1
    target: LaunchTarget = "embedded"
    profile_id: int | None = None
    extra_args: str | None = None
    prompt_fanout: PromptFanout = "primary"
    has_override: bool = False
