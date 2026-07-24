"""Pydantic models for the launch-agents-grid feature.

Covers providers (read-only registry) and launch presets (user-saved
launch configurations).  These models are imported by both the service
layer and the router layer — keep them free of database imports.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


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


class LaunchCell(BaseModel):
    """One cell in a heterogeneous workspace-mode grid."""

    row: int = Field(ge=0)
    col: int = Field(ge=0)
    project_id: int
    provider_id: int
    extra_args: str = ""
    profile_id: int | None = None
    env_overlay: dict[str, str] = Field(default_factory=dict)


class LaunchPresetBase(BaseModel):
    name: str = Field(..., min_length=1)
    project_id: int
    provider_id: int
    rows: int = Field(ge=1, le=4)
    cols: int = Field(ge=1, le=4)
    extra_args: str = ""
    target: Literal["embedded", "popout"]
    profile_id: int | None = None
    cells: list[LaunchCell] | None = None


class LaunchPresetCreate(LaunchPresetBase):
    @model_validator(mode="after")
    def derive_dims_from_cells(self) -> LaunchPresetCreate:
        """When cells are supplied, derive rows/cols and validate uniqueness."""
        if not self.cells:
            return self

        # Reject duplicate (row, col) pairs.
        coords = [(c.row, c.col) for c in self.cells]
        if len(coords) != len(set(coords)):
            raise ValueError("cells contains duplicate (row, col) pairs")

        # Derive dimensions from max coordinates.
        self.rows = max(c.row for c in self.cells) + 1
        self.cols = max(c.col for c in self.cells) + 1

        return self


class LaunchPreset(LaunchPresetBase):
    id: int
    created_at: str


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


class LaunchSeed(BaseModel):
    """Complete launch seed payload returned by GET /api/v1/launch/seed."""

    source: LaunchSeedSource
    project: LaunchSeedProject | None = None
    prompt: str
    provider_id: int
    model: str | None = None
    rows: int = 1
    cols: int = 1
    target: LaunchTarget = "embedded"
    profile_id: int | None = None
    extra_args: str | None = None
    prompt_fanout: PromptFanout = "primary"
    has_override: bool = False
