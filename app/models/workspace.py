"""Pydantic model for the workspace entity.

Kept free of database imports so both the service and router layers can use it.
"""

from __future__ import annotations

from pydantic import BaseModel


class Workspace(BaseModel):
    """The active workspace. ``root_path`` is derived from settings, not stored."""

    id: int
    slug: str
    label: str
    root_path: str
    created_at: str | None = None
    updated_at: str | None = None
