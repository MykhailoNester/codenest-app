"""System info router.

Exposes lightweight host-level metadata that the frontend uses for
display purposes (e.g. expanding ``~`` in path inputs).
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


@router.get("/api/v1/system/info")
async def api_system_info() -> JSONResponse:
    """Return host metadata.

    ``home``     — absolute path to the current user's home directory.
    ``platform`` — ``sys.platform`` string (e.g. ``darwin``, ``linux``).
    """
    return JSONResponse(
        {
            "home": str(Path.home()),
            "platform": sys.platform,
        }
    )
