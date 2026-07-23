"""Providers REST router.

Exposes the provider registry, models lookup, aggregate stats, and admin
mutators under ``/api/v1/providers``.  All logic lives in
``provider_service``; this file only handles HTTP plumbing.
"""

from __future__ import annotations

import glob
import os
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.models.launch import ProviderCreate, ProviderUpdate
from app.services import provider_service

router = APIRouter()


@router.get("/api/v1/providers/config-homes")
async def api_config_homes() -> JSONResponse:
    """Return a list of candidate Claude config home directories on the host.

    Scans ``~/.claude*`` for directories that look like Claude config homes
    (must contain ``settings.json`` or be exactly ``~/.claude``).  The result
    is deduplicated and sorted; tilde paths are NOT expanded — the frontend and
    PTY spawn layer both handle tilde expansion so the stored value stays
    portable across user accounts.

    Always includes ``~/.claude`` (the canonical default) even when that
    directory does not yet exist.
    """
    home = os.path.expanduser("~")
    candidates: list[str] = []

    # Glob for all ~/.claude* directories.
    for path in glob.glob(os.path.join(home, ".claude*")):
        if not os.path.isdir(path):
            continue
        tilde_path = "~/" + os.path.relpath(path, home)
        candidates.append(tilde_path)

    # Ensure the canonical default is always present.
    if "~/.claude" not in candidates:
        candidates.insert(0, "~/.claude")

    # Sort: ~/.claude first, then alphabetically.
    candidates.sort(key=lambda p: (p != "~/.claude", p))

    return JSONResponse({"config_homes": candidates})


@router.get("/api/v1/providers")
async def api_list_providers(include_disabled: bool = False) -> JSONResponse:
    """List providers.

    By default returns only enabled providers (``is_enabled = 1``).
    Pass ``?include_disabled=true`` to include disabled rows — used by the
    Settings → Providers admin UI.
    """
    db = await get_db()
    providers = await provider_service.list_providers(
        db, only_enabled=not include_disabled
    )
    return JSONResponse([p.model_dump() for p in providers])


@router.get("/api/v1/providers/stats")
async def api_provider_stats(
    since: Literal["today", "7d", "30d", "all"] = "today",
) -> JSONResponse:
    """Per-provider session aggregates over a time window.

    Returns one row per registered provider plus a synthetic Unknown bucket
    when there are sessions whose model isn't in `provider_models`.
    """
    db = await get_db()
    stats = await provider_service.list_providers_with_stats(db, since=since)
    return JSONResponse([s.model_dump() for s in stats])


@router.get("/api/v1/providers/{provider_id}/models")
async def api_provider_models(
    provider_id: int,
    include_disabled: bool = False,
) -> JSONResponse:
    """List models registered for a provider."""
    db = await get_db()
    models = await provider_service.list_models(
        db, provider_id, only_enabled=not include_disabled
    )
    return JSONResponse([m.model_dump() for m in models])


@router.get("/api/v1/providers/{provider_id}/launch-config")
async def api_provider_launch_config(provider_id: int) -> JSONResponse:
    """UNMASKED launch config (incl. cleartext api_key) for the trusted Rust
    shell to spawn a scheduled `claude` run. Localhost-only; never used by the
    WebView (the frontend uses the masked Provider representation)."""
    db = await get_db()
    return JSONResponse(
        await provider_service.get_provider_launch_config(db, provider_id)
    )


@router.patch("/api/v1/providers/{provider_id}")
async def api_set_provider_enabled(provider_id: int, request: Request) -> JSONResponse:
    """Toggle a provider's enabled flag.

    Body: ``{"is_enabled": bool}``.
    """
    body = await request.json()
    if "is_enabled" not in body:
        raise HTTPException(status_code=400, detail="is_enabled is required")
    db = await get_db()
    provider = await provider_service.set_provider_enabled(
        db, provider_id, bool(body["is_enabled"])
    )
    return JSONResponse(provider.model_dump())


@router.post("/api/v1/providers/{provider_id}/models")
async def api_add_provider_model(provider_id: int, request: Request) -> JSONResponse:
    """Add a model to a provider's registry.

    Body: ``{"model_name": str, "display_name": str, "is_default"?: bool}``.
    """
    body = await request.json()
    model_name = body.get("model_name")
    display_name = body.get("display_name")
    if not model_name or not display_name:
        raise HTTPException(
            status_code=400, detail="model_name and display_name are required"
        )
    db = await get_db()
    model = await provider_service.add_provider_model(
        db,
        provider_id=provider_id,
        model_name=str(model_name),
        display_name=str(display_name),
        is_default=bool(body.get("is_default", False)),
    )
    return JSONResponse(model.model_dump())


@router.put("/api/v1/providers/{provider_id}/models")
async def api_set_provider_models(provider_id: int, request: Request) -> JSONResponse:
    """Replace a provider's whole model set (idempotent).

    Body: ``{"models": [{"model_name", "display_name"?, "is_default"?}, ...]}``.
    Used by the onboarding provider step to set the three Claude tiers at once.
    """
    body = await request.json()
    models = body.get("models")
    if not isinstance(models, list) or not models:
        raise HTTPException(status_code=400, detail="models must be a non-empty list")
    db = await get_db()
    result = await provider_service.set_provider_models(db, provider_id, models)
    return JSONResponse([m.model_dump() for m in result])


@router.delete("/api/v1/providers/models/{model_id}")
async def api_delete_provider_model(model_id: int) -> JSONResponse:
    db = await get_db()
    await provider_service.delete_provider_model(db, model_id)
    return JSONResponse({"ok": True})


@router.post("/api/v1/providers")
async def api_create_provider(body: ProviderCreate) -> JSONResponse:
    """Create a new provider row.  Returns 409 when the name is already taken."""
    db = await get_db()
    provider = await provider_service.create_provider(db, body)
    return JSONResponse(provider.model_dump(), status_code=201)


@router.put("/api/v1/providers/{provider_id}")
async def api_update_provider(provider_id: int, body: ProviderUpdate) -> JSONResponse:
    """Full/partial update of a provider (all fields optional).

    Distinct from the existing PATCH which only toggles ``is_enabled`` — this
    endpoint accepts any subset of fields and is used by the Settings UI.
    The legacy PATCH endpoint is preserved for backward compatibility.
    """
    db = await get_db()
    provider = await provider_service.update_provider(db, provider_id, body)
    return JSONResponse(provider.model_dump())


@router.delete("/api/v1/providers/{provider_id}")
async def api_delete_provider(provider_id: int) -> JSONResponse:
    """Delete a provider row (cascades to launch_presets via FK)."""
    db = await get_db()
    await provider_service.delete_provider(db, provider_id)
    return JSONResponse({"ok": True})
