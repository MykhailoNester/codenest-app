"""Workboard MCP endpoint: protocol handshake, the loopback guard, and the
ticket tools driving the same services the REST API does."""

from __future__ import annotations

import json
from typing import Any

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import mcp as mcp_router
from app.services import mcp_service


@pytest_asyncio.fixture
async def client(migrated_db: aiosqlite.Connection) -> TestClient:
    original_db = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(mcp_router.router)
    yield TestClient(application, base_url="http://127.0.0.1:8002")
    db_module._db = original_db


def _rpc(client: TestClient, method: str, params: dict | None = None, **headers):
    return client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers=headers,
    )


def _call(client: TestClient, tool: str, **args: Any) -> tuple[Any, bool]:
    response = _rpc(client, "tools/call", {"name": tool, "arguments": args})
    assert response.status_code == 200
    result = response.json()["result"]
    text = result["content"][0]["text"]
    if result["isError"]:
        return text, True
    return json.loads(text), False


def _ok(client: TestClient, tool: str, **args: Any) -> Any:
    payload, is_error = _call(client, tool, **args)
    assert not is_error, payload
    return payload


@pytest.mark.asyncio
async def test_initialize_negotiates_version_and_lists_tools(client: TestClient):
    init = _rpc(client, "initialize", {"protocolVersion": "2025-03-26"}).json()
    assert init["result"]["protocolVersion"] == "2025-03-26"
    assert init["result"]["capabilities"] == {"tools": {"listChanged": False}}

    unknown = _rpc(client, "initialize", {"protocolVersion": "1999-01-01"}).json()
    assert unknown["result"]["protocolVersion"] == "2025-11-25"

    note = client.post(
        "/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}
    )
    assert note.status_code == 202

    tools = _rpc(client, "tools/list").json()["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {
        "create_task",
        "update_task",
        "list_projects",
        "promote_inbox_item",
    } <= names
    assert _rpc(client, "nope").json()["error"]["code"] == mcp_service.METHOD_NOT_FOUND


@pytest.mark.asyncio
async def test_catalogue_cannot_delete_or_repoint_projects():
    """The boundary this endpoint promises: nothing destructive, and nothing
    that changes where the app launches sessions."""
    names = {t.name for t in mcp_service.TOOLS}
    assert not any("delete" in n for n in names)
    for tool in mcp_service.TOOLS:
        assert not {"path", "root_path", "profile_id", "default_provider_id"} & set(
            tool.properties
        ), tool.name


@pytest.mark.parametrize(
    ("headers", "status"),
    [
        ({"Origin": "https://example.com"}, 403),
        ({"Origin": "null"}, 403),
        ({"Host": "attacker.example:8002"}, 403),
        ({"MCP-Protocol-Version": "1999-01-01"}, 400),
    ],
)
@pytest.mark.asyncio
async def test_guard_refuses_browsers_and_foreign_hosts(
    client: TestClient, headers: dict[str, str], status: int
):
    assert _rpc(client, "ping", **headers).status_code == status


@pytest.mark.asyncio
async def test_guard_requires_json_and_offers_no_stream(client: TestClient):
    text = client.post("/mcp", content=b"{}", headers={"Content-Type": "text/plain"})
    assert text.status_code == 415
    assert client.get("/mcp").status_code == 405
    assert (
        client.post(
            "/mcp", content=b"{", headers={"Content-Type": "application/json"}
        ).json()["error"]["code"]
        == mcp_service.PARSE_ERROR
    )


@pytest.mark.asyncio
async def test_ticket_lifecycle_runs_the_blocker_cascade(client: TestClient):
    project = _ok(client, "create_project", name="Demo", tech_stack="Python")
    first = _ok(client, "create_task", project_id=project["id"], title="Schema")
    second = _ok(
        client,
        "create_task",
        project_id=project["id"],
        title="API",
        status="blocked",
        priority="high",
    )
    blocked = _ok(
        client, "add_blocker", task_id=second["id"], blocking_task_id=first["id"]
    )
    assert [b["task_id"] for b in blocked["blocked_by"]] == [first["id"]]

    _ok(client, "add_task_comment", task_id=first["id"], body="started")
    sub = _ok(client, "add_subtask", task_id=first["id"], title="write migration")
    _ok(client, "update_subtask", task_id=first["id"], subtask_id=sub["id"], done=True)
    _ok(client, "update_task", task_id=first["id"], status="done")

    unblocked = _ok(client, "get_task", task_id=second["id"])
    assert unblocked["status"] == "todo"
    assert unblocked["blocked_by"] == []

    done = _ok(client, "get_task", task_id=first["id"])
    assert [c["body"] for c in done["comments"]] == ["started"]
    assert done["subtasks"][0]["done"] is True

    listing = _ok(client, "list_tasks", project_id=project["id"], query="api")
    assert [t["id"] for t in listing["tasks"]] == [second["id"]]
    projects = _ok(client, "list_projects")
    demo = next(p for p in projects if p["id"] == project["id"])
    assert demo["task_counts"] == {"done": 1, "todo": 1}


@pytest.mark.asyncio
async def test_inbox_item_promotes_to_a_task(client: TestClient):
    project = _ok(client, "create_project", name="Demo")
    item = _ok(client, "create_inbox_item", title="Idea", project_id=project["id"])
    assert [i["id"] for i in _ok(client, "list_inbox")] == [item["id"]]

    task = _ok(client, "promote_inbox_item", item_id=item["id"], notes="from triage")
    assert task["project_id"] == project["id"]
    assert "from triage" in task["description"]
    assert _ok(client, "list_inbox") == []


@pytest.mark.parametrize(
    ("tool", "args", "message"),
    [
        ("create_task", {"title": "x"}, "missing required argument(s): project_id"),
        ("create_task", {"project_id": 99, "title": "x"}, "project 99 does not exist"),
        ("get_task", {"task_id": "1"}, "task_id must be of type integer"),
        ("get_task", {"task_id": 1, "verbose": True}, "unknown argument(s): verbose"),
        ("update_task", {"task_id": 42}, "task 42 does not exist"),
        ("create_project", {"name": "  "}, "name must not be empty"),
        ("not_a_tool", {}, "unknown tool: not_a_tool"),
    ],
)
@pytest.mark.asyncio
async def test_bad_calls_come_back_as_tool_errors(
    client: TestClient, tool: str, args: dict, message: str
):
    payload, is_error = _call(client, tool, **args)
    assert is_error
    assert payload == message


@pytest.mark.asyncio
async def test_status_is_checked_against_the_configured_taxonomy(client: TestClient):
    project = _ok(client, "create_project", name="Demo")
    payload, is_error = _call(
        client, "create_task", project_id=project["id"], title="x", status="shipped"
    )
    assert is_error
    assert payload.startswith("status must be one of: backlog, todo, in-progress")
