from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.database import get_db
from app.services.document_service import (
    create_document,
    delete_document,
    get_all_documents,
    update_document,
    validate_document,
)

router = APIRouter()


# --- JSON API ---


@router.get("/api/v1/documents")
async def api_list_documents(category: str = ""):
    db = await get_db()
    docs = await get_all_documents(db, category_filter=category)
    return JSONResponse(docs)


@router.post("/api/v1/documents")
async def api_create_document(request: Request):
    db = await get_db()
    data = await request.json()
    doc_id = await create_document(db, data)
    return JSONResponse({"id": doc_id}, status_code=201)


@router.put("/api/v1/documents/{doc_id}")
async def api_update_document(doc_id: int, request: Request):
    db = await get_db()
    data = await request.json()
    await update_document(db, doc_id, data)
    return JSONResponse({"ok": True})


@router.delete("/api/v1/documents/{doc_id}")
async def api_delete_document(doc_id: int):
    db = await get_db()
    await delete_document(db, doc_id)
    return JSONResponse({"ok": True})


@router.post("/api/v1/documents/{doc_id}/validate")
async def api_validate_document(doc_id: int):
    db = await get_db()
    result = await validate_document(db, doc_id)
    if result is None:
        return JSONResponse({"detail": "document not found"}, status_code=404)
    return JSONResponse(result)
