"""Notifications router.

REST endpoints and SSE stream for the notifications system.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from app.database import get_db
from app.services import notification_service

log = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/v1/notifications")
async def list_notifications(
    unread: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
):
    db = await get_db()
    items = await notification_service.list_notifications(
        db, unread_only=unread, limit=limit
    )
    return JSONResponse([dict(i) for i in items])


@router.post("/api/v1/notifications/read-all")
async def mark_all_read():
    db = await get_db()
    count = await notification_service.mark_all_read(db)
    return JSONResponse({"updated": count})


@router.post("/api/v1/notifications/{notification_id}/read")
async def mark_read(notification_id: int):
    db = await get_db()
    updated = await notification_service.mark_read(db, notification_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    return JSONResponse(dict(updated))


@router.delete("/api/v1/notifications/{notification_id}")
async def delete_notification(notification_id: int):
    db = await get_db()
    deleted = await notification_service.delete_notification(db, notification_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Notification not found")
    return JSONResponse({"deleted": notification_id})


@router.get("/api/v1/notifications/stream")
async def stream():
    async def gen() -> AsyncGenerator[bytes, None]:
        q = notification_service.subscribe()
        try:
            yield b": connected\n\n"
            try:
                db = await get_db()
                # Full unread snapshot so the bell badge is up-to-date.
                unread = await notification_service.list_notifications(
                    db, unread_only=True
                )
                snapshot_payload = json.dumps(unread, default=str)
                yield f"event: snapshot\ndata: {snapshot_payload}\n\n".encode()

                # Replay recent unread items individually so ToastHost can
                # show toasts for notifications that were emitted before the
                # client connected (e.g. right after onboarding completes).
                # The client deduplicates by id, so replaying items that
                # were already in the snapshot is safe.
                recent = await notification_service.list_recent_unread(db)
                for item in recent:
                    item_payload = json.dumps(item, default=str)
                    yield f"event: notification\ndata: {item_payload}\n\n".encode()
            except Exception:
                log.exception("failed to send notifications SSE snapshot/replay")

            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15.0)
                    payload = json.dumps(msg, default=str)
                    yield f"event: notification\ndata: {payload}\n\n".encode()
                except asyncio.TimeoutError:
                    yield b": ping\n\n"
        finally:
            notification_service.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
