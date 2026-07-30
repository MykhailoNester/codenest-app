"""FastAPI router for the active workspace."""

from __future__ import annotations

import json

from fastapi import APIRouter
from pydantic import BaseModel

from app.database import get_db
from app.models.hooks import (
    HookSelfTestIngest,
    HookSelfTestMint,
    HookSelfTestReceipt,
    HookVerifyReport,
)
from app.models.workspace import Workspace
from app.services import hooks_service, workspace_context_service, workspace_service

router = APIRouter(prefix="/api/v1/workspace", tags=["workspace"])


@router.get("")
async def get_workspace() -> Workspace:
    db = await get_db()
    return Workspace(**await workspace_service.get_active(db))


@router.get("/context")
async def get_workspace_context() -> dict:
    """Return the workspace project registry.

    Note: the SessionStart hook (hooks_service.py) does NOT call this endpoint;
    hook payloads go to /api/v1/hooks/session-start. This endpoint is available
    for future integration or tooling but currently has no frontend caller.
    """
    db = await get_db()
    return await workspace_context_service.session_context(db)


@router.get("/hooks/snippet")
async def get_hook_snippet(config_home: str | None = None) -> dict:
    """The settings.json hooks block to paste (guided copy-paste; no auto-write)."""
    base = hooks_service.sidecar_base_url()
    block = hooks_service.build_hook_settings(base)
    return {
        "settings_path": hooks_service.settings_json_path(config_home),
        "base_url": base,
        "hooks": block,
        "snippet": json.dumps(block, indent=2),
    }


@router.get("/hooks/status")
async def get_hook_status(since: str | None = None) -> dict:
    """Verify signal. Pass ``since`` (a prior last_ping_at) to require a fresh ping."""
    db = await get_db()
    return await hooks_service.hooks_status(db, since)


class HookVerifyRequest(BaseModel):
    config_homes: list[str] = []


@router.post("/hooks/verify")
async def post_hook_verify(body: HookVerifyRequest) -> HookVerifyReport:
    """Diff each requested config home's settings.json against build_hook_settings().

    Never 4xx/5xx on bad user data — a missing file, unreadable file or invalid
    JSON is a per-result ``file_status``, not an HTTP error, because each is a
    real user situation the UI must explain rather than a request the client
    got wrong.
    """
    return HookVerifyReport(
        **await hooks_service.verify_settings_files(body.config_homes)
    )


@router.post("/hooks/self-test")
async def post_hook_self_test_mint() -> HookSelfTestMint:
    """Mint a one-shot self-test token for the Rust shell's live curl probe."""
    return HookSelfTestMint(**hooks_service.mint_self_test())


@router.post("/hooks/self-test/{token}")
async def post_hook_self_test_ingest(token: str) -> HookSelfTestIngest:
    """The curl target the live probe POSTs to. Body is ignored — curl's payload
    is irrelevant to a self-test. Deliberately not routed through
    ``agent_service``: a probe must never create an ``agent_sessions`` row.

    Constructed via alias (``**{"continue": ...}``) rather than the
    ``continue_`` field name: mypy synthesizes ``HookSelfTestIngest.__init__``
    from the field's declared alias (PEP 681), independent of the model's
    runtime ``populate_by_name`` setting, so ``continue_=...`` is rejected
    statically even though pydantic itself would accept it.
    """
    return HookSelfTestIngest(
        **{"continue": True, "recorded": hooks_service.record_self_test(token)}
    )


@router.get("/hooks/self-test/{token}")
async def get_hook_self_test_receipt(token: str) -> HookSelfTestReceipt:
    """The self-test receipt. Returns ``known: false`` for an unknown/expired
    token rather than a 404, so a thrown error here is always a genuine
    transport/app failure the frontend can map unambiguously."""
    return HookSelfTestReceipt(**hooks_service.read_self_test(token))
