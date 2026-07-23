"""Profiles REST router.

CRUD over `/api/v1/profiles`. All persistence and validation lives in
`profile_service`; this file only deals with HTTP plumbing.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import profile_service
from app.services.profile_service import ProfileCreate, ProfileUpdate

router = APIRouter()


@router.get("/api/v1/profiles")
async def api_list_profiles() -> JSONResponse:
    db = await get_db()
    profiles = await profile_service.list_profiles(db)
    return JSONResponse(profiles)


@router.get("/api/v1/profiles/{profile_id}")
async def api_get_profile(profile_id: int) -> JSONResponse:
    db = await get_db()
    profile = await profile_service.get_profile(db, profile_id)
    return JSONResponse(profile)


@router.post("/api/v1/profiles", status_code=201)
async def api_create_profile(payload: ProfileCreate) -> JSONResponse:
    db = await get_db()
    profile = await profile_service.create_profile(db, payload)
    return JSONResponse(profile, status_code=201)


@router.put("/api/v1/profiles/{profile_id}")
async def api_update_profile(profile_id: int, payload: ProfileUpdate) -> JSONResponse:
    db = await get_db()
    profile = await profile_service.update_profile(db, profile_id, payload)
    return JSONResponse(profile)


@router.delete("/api/v1/profiles/{profile_id}")
async def api_delete_profile(profile_id: int) -> JSONResponse:
    db = await get_db()
    await profile_service.delete_profile(db, profile_id)
    return JSONResponse({"ok": True})
