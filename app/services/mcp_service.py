"""Workboard MCP server: JSON-RPC dispatch and the tool catalogue.

Exposes projects, tasks and inbox items to any MCP client (an external
`claude` session, an IDE) over the sidecar's loopback HTTP port. Every tool
calls the same services the REST routers do, so the blocker cascade, activity
log and notifications behave identically whichever door a write came through.

Deliberately out of reach: deleting anything, and the project fields that
steer where sessions launch (`path`, `profile_id`, `default_provider_id`).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import aiosqlite
from fastapi import HTTPException

from app import _APP_VERSION

from . import (
    inbox_service,
    project_service,
    task_service,
    taxonomy_service,
    team_service,
)

logger = logging.getLogger(__name__)

SERVER_NAME = "codenest-workboard"

# Newest first; the first entry is what we answer with when a client asks for
# a version we do not know.
SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

_INSTRUCTIONS = (
    "Codenest workboard: projects, tasks and inbox items on this machine. "
    "Every task belongs to a project — call list_projects first to resolve a "
    "name to its id. Statuses, priorities and labels are user-configurable; "
    "call describe_workboard for the current values. Marking a task done "
    "automatically unblocks the tasks it was blocking."
)

_EFFORTS = ("small", "medium", "large")
_INBOX_STATUSES = ("inbox", "review", "ready", "done", "rejected")
_INBOX_PRIORITIES = ("high", "medium", "low")
_LIST_LIMIT_DEFAULT = 50
_LIST_LIMIT_MAX = 200

# JSON-RPC 2.0 error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class ToolError(Exception):
    """A failure the calling model should see and can act on."""


Handler = Callable[[aiosqlite.Connection, dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    properties: dict[str, dict[str, Any]]
    handler: Handler
    required: tuple[str, ...] = ()
    read_only: bool = False
    annotations: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": {
                "type": "object",
                "properties": self.properties,
                "required": list(self.required),
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": self.read_only,
                "destructiveHint": False,
                "openWorldHint": False,
                **self.annotations,
            },
        }


# --- argument validation ----------------------------------------------------
#
# The advertised JSON Schema is also the enforcement: one small checker walks
# it, so a schema and its validation cannot drift apart.

_PY_TYPES: dict[str, Callable[[Any], bool]] = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "array": lambda v: isinstance(v, list),
    "null": lambda v: v is None,
}


def _check_value(name: str, value: Any, schema: dict[str, Any]) -> None:
    types = schema.get("type", "string")
    allowed = types if isinstance(types, list) else [types]
    if not any(_PY_TYPES[t](value) for t in allowed):
        raise ToolError(f"{name} must be of type {' or '.join(allowed)}")
    if value is None:
        return
    if "enum" in schema and value not in schema["enum"]:
        raise ToolError(f"{name} must be one of: {', '.join(schema['enum'])}")
    if isinstance(value, int) and not isinstance(value, bool):
        if value < schema.get("minimum", value):
            raise ToolError(f"{name} must be >= {schema['minimum']}")
        if value > schema.get("maximum", value):
            raise ToolError(f"{name} must be <= {schema['maximum']}")
    if isinstance(value, str) and schema.get("minLength", 0) > len(value.strip()):
        raise ToolError(f"{name} must not be empty")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            _check_value(f"{name}[{i}]", item, schema["items"])


def _validate_args(tool: Tool, args: Any) -> dict[str, Any]:
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise ToolError("arguments must be an object")
    unknown = sorted(set(args) - set(tool.properties))
    if unknown:
        raise ToolError(f"unknown argument(s): {', '.join(unknown)}")
    missing = [k for k in tool.required if k not in args]
    if missing:
        raise ToolError(f"missing required argument(s): {', '.join(missing)}")
    for key, value in args.items():
        _check_value(key, value, tool.properties[key])
    return args


def _id(description: str) -> dict[str, Any]:
    return {"type": "integer", "minimum": 1, "description": description}


def _nullable_id(description: str) -> dict[str, Any]:
    return {"type": ["integer", "null"], "minimum": 1, "description": description}


def _text(description: str, *, required: bool = False) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "string", "description": description}
    if required:
        schema["minLength"] = 1
    return schema


def _enum(values: tuple[str, ...], description: str) -> dict[str, Any]:
    return {"type": "string", "enum": list(values), "description": description}


# --- lookups shared by the handlers -----------------------------------------


async def _slugs(db: aiosqlite.Connection, kind: str) -> list[str]:
    return [row["slug"] for row in await taxonomy_service.list_by_kind(db, kind)]


async def _require_slug(
    db: aiosqlite.Connection, kind: str, name: str, value: str
) -> None:
    allowed = await _slugs(db, kind)
    if value not in allowed:
        raise ToolError(f"{name} must be one of: {', '.join(allowed)}")


async def _require_project(db: aiosqlite.Connection, project_id: int) -> None:
    if await project_service.get_project(db, project_id) is None:
        raise ToolError(f"project {project_id} does not exist")


async def _require_member(db: aiosqlite.Connection, member_id: int | None) -> None:
    if member_id is not None and await team_service.get_member(db, member_id) is None:
        raise ToolError(f"team member {member_id} does not exist")


async def _require_task(db: aiosqlite.Connection, task_id: int) -> dict[str, Any]:
    task = await task_service.get_task(db, task_id)
    if task is None:
        raise ToolError(f"task {task_id} does not exist")
    return task


async def _require_inbox_item(db: aiosqlite.Connection, item_id: int) -> None:
    if await inbox_service.get_item(db, item_id) is None:
        raise ToolError(f"inbox item {item_id} does not exist")


def _limit(args: dict[str, Any]) -> int:
    return int(args.get("limit", _LIST_LIMIT_DEFAULT))


def _label_names(task: dict[str, Any]) -> list[str]:
    return [label["slug"] for label in task.get("labels", [])]


def _task_summary(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": task["id"],
        "title": task["title"],
        "status": task["status"],
        "priority": task["priority"],
        "effort": task["effort"],
        "project_id": task["project_id"],
        "project_name": task["project_name"],
        "assignee_id": task["assignee_id"],
        "assignee_name": task["assignee_name"],
        "labels": _label_names(task),
        "updated_at": task["updated_at"],
    }


async def _task_detail(db: aiosqlite.Connection, task_id: int) -> dict[str, Any]:
    task = await _require_task(db, task_id)
    blockers = await task_service.get_task_blockers(db, task_id)
    return {
        **task,
        "blocked_by": [
            {
                "task_id": b["blocking_task_id"],
                "title": b["blocking_title"],
                "status": b["blocking_status"],
            }
            for b in blockers
        ],
        "subtasks": await task_service.list_subtasks(db, task_id),
        "comments": await task_service.list_comments(db, task_id),
    }


def _project_row(project: Any, stats: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": project["id"],
        "name": project["name"],
        "description": project["description"],
        "tech_stack": project["tech_stack"],
        "status": project["status"],
        "root_path": project["root_path"] or project["path"],
        "task_counts": stats.get("task_counts", {}),
        "inbox_count": stats.get("inbox_count", 0),
    }


# --- read tools -------------------------------------------------------------


async def _describe_workboard(db: aiosqlite.Connection, _: dict[str, Any]) -> Any:
    labels = await taxonomy_service.list_by_kind(db, "task_label")
    return {
        "task_statuses": await _slugs(db, "task_status"),
        "task_priorities": await _slugs(db, "task_priority"),
        "task_efforts": list(_EFFORTS),
        "task_labels": [
            {"id": label["id"], "slug": label["slug"], "name": label["display_name"]}
            for label in labels
        ],
        "inbox_statuses": list(_INBOX_STATUSES),
        "inbox_priorities": list(_INBOX_PRIORITIES),
    }


async def _list_projects(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    projects = await project_service.get_all_projects(db)
    stats = await project_service.get_project_stats_bulk(db)
    include_inactive = args.get("include_inactive", False)
    return [
        _project_row(p, stats.get(p["id"], {}))
        for p in projects
        if include_inactive or p["is_active"]
    ]


async def _get_project(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    project_id = args["project_id"]
    project = await project_service.get_project(db, project_id)
    if project is None:
        raise ToolError(f"project {project_id} does not exist")
    stats = await project_service.get_project_stats(db, project_id)
    return _project_row(project, stats)


async def _list_tasks(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    filters: dict[str, Any] = {
        key: args[key]
        for key in ("project_id", "status", "priority", "assignee_id")
        if key in args
    }
    tasks = await task_service.get_all_tasks(db, filters)
    if "label" in args:
        tasks = [t for t in tasks if args["label"] in _label_names(t)]
    if "query" in args:
        needle = args["query"].strip().lower()
        tasks = [
            t
            for t in tasks
            if needle in t["title"].lower()
            or needle in (t["description"] or "").lower()
        ]
    limit = _limit(args)
    return {
        "total": len(tasks),
        "tasks": [_task_summary(t) for t in tasks[:limit]],
    }


async def _get_task(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    return await _task_detail(db, args["task_id"])


async def _list_inbox(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    items = await inbox_service.get_all_items(
        db,
        status_filter=args.get("status", "inbox"),
        project_id=args.get("project_id"),
    )
    return [dict(item) for item in items[: _limit(args)]]


async def _list_team(db: aiosqlite.Connection, _: dict[str, Any]) -> Any:
    return [
        {
            "id": m["id"],
            "name": m["name"],
            "role": m["role"],
            "type": m["type"],
            "status": m["status"],
        }
        for m in await team_service.get_all_members(db)
    ]


# --- write tools ------------------------------------------------------------


async def _create_task(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    await _require_project(db, args["project_id"])
    await _require_member(db, args.get("assignee_id"))
    if "status" in args:
        await _require_slug(db, "task_status", "status", args["status"])
    if "priority" in args:
        await _require_slug(db, "task_priority", "priority", args["priority"])
    label_ids = args.pop("label_ids", None)
    task_id = await task_service.create_task(
        db, {**args, "title": args["title"].strip()}
    )
    if label_ids:
        await task_service.set_task_labels(db, task_id, label_ids)
    return await _task_detail(db, task_id)


async def _update_task(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    task_id = args.pop("task_id")
    await _require_task(db, task_id)
    if not args:
        raise ToolError("nothing to update")
    if "project_id" in args:
        await _require_project(db, args["project_id"])
    if "assignee_id" in args:
        await _require_member(db, args["assignee_id"])
    if "status" in args:
        await _require_slug(db, "task_status", "status", args["status"])
    if "priority" in args:
        await _require_slug(db, "task_priority", "priority", args["priority"])
    if "title" in args:
        args["title"] = args["title"].strip()
    await task_service.update_task(db, task_id, args)
    return await _task_detail(db, task_id)


async def _set_task_labels(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    await _require_task(db, args["task_id"])
    return await task_service.set_task_labels(db, args["task_id"], args["label_ids"])


async def _add_comment(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    return await task_service.create_comment(
        db, args["task_id"], args["body"], args.get("author_id")
    )


async def _add_subtask(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    return await task_service.create_subtask(db, args["task_id"], args["title"])


async def _update_subtask(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    patch = {k: args[k] for k in ("title", "done") if k in args}
    return await task_service.update_subtask(
        db, args["task_id"], args["subtask_id"], patch
    )


async def _add_blocker(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    task_id, blocking_id = args["task_id"], args["blocking_task_id"]
    if task_id == blocking_id:
        raise ToolError("a task cannot block itself")
    await _require_task(db, task_id)
    await _require_task(db, blocking_id)
    await task_service.add_blocker(db, task_id, blocking_id)
    return await _task_detail(db, task_id)


async def _remove_blocker(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    task_id, blocking_id = args["task_id"], args["blocking_task_id"]
    await _require_task(db, task_id)
    for blocker in await task_service.get_task_blockers(db, task_id):
        if blocker["blocking_task_id"] == blocking_id:
            await task_service.remove_blocker(db, blocker["id"])
            return await _task_detail(db, task_id)
    raise ToolError(f"task {blocking_id} is not blocking task {task_id}")


async def _create_inbox_item(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    if "project_id" in args:
        await _require_project(db, args["project_id"])
    item_id = await inbox_service.create_item(
        db, {**args, "title": args["title"].strip(), "status": "inbox"}
    )
    return dict(await inbox_service.get_item(db, item_id))


async def _update_inbox_item(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    item_id = args.pop("item_id")
    await _require_inbox_item(db, item_id)
    if not args:
        raise ToolError("nothing to update")
    if args.get("project_id") is not None:
        await _require_project(db, args["project_id"])
    await inbox_service.update_item(db, item_id, args)
    return dict(await inbox_service.get_item(db, item_id))


async def _promote_inbox_item(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    item_id = args.pop("item_id")
    await _require_inbox_item(db, item_id)
    if "project_id" in args:
        await _require_project(db, args["project_id"])
    await _require_member(db, args.get("assignee_id"))
    if "priority" in args:
        await _require_slug(db, "task_priority", "priority", args["priority"])
    task_id = await inbox_service.promote_to_task(db, item_id, args)
    return await _task_detail(db, task_id)


async def _create_project(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    project_id = await project_service.create_project(
        db, {**args, "name": args["name"].strip()}
    )
    return await _get_project(db, {"project_id": project_id})


async def _update_project(db: aiosqlite.Connection, args: dict[str, Any]) -> Any:
    project_id = args.pop("project_id")
    await _require_project(db, project_id)
    if not args:
        raise ToolError("nothing to update")
    await project_service.update_project(db, project_id, args)
    return await _get_project(db, {"project_id": project_id})


# --- catalogue --------------------------------------------------------------

_LIMIT = {
    "type": "integer",
    "minimum": 1,
    "maximum": _LIST_LIMIT_MAX,
    "description": f"Maximum rows to return (default {_LIST_LIMIT_DEFAULT}).",
}
_STATUS = _text("Task status slug; see describe_workboard.")
_PRIORITY = _text("Task priority slug; see describe_workboard.")
_EFFORT = _enum(_EFFORTS, "Rough size of the work.")
_LABEL_IDS = {
    "type": "array",
    "items": {"type": "integer", "minimum": 1},
    "description": "Label ids from describe_workboard; replaces the task's labels.",
}

TOOLS: tuple[Tool, ...] = (
    Tool(
        "describe_workboard",
        "List the valid task statuses, priorities, efforts and labels, and the "
        "inbox statuses. Call this before setting any of them.",
        {},
        _describe_workboard,
        read_only=True,
    ),
    Tool(
        "list_projects",
        "List projects with their task counts by status and open inbox count.",
        {
            "include_inactive": {
                "type": "boolean",
                "description": "Include archived projects (default false).",
            }
        },
        _list_projects,
        read_only=True,
    ),
    Tool(
        "get_project",
        "Get one project with its task counts by status.",
        {"project_id": _id("Project id.")},
        _get_project,
        required=("project_id",),
        read_only=True,
    ),
    Tool(
        "list_tasks",
        "List tasks, newest first, optionally filtered. Returns summaries; use "
        "get_task for the description, blockers, subtasks and comments.",
        {
            "project_id": _id("Only tasks in this project."),
            "status": _STATUS,
            "priority": _PRIORITY,
            "assignee_id": _id("Only tasks assigned to this team member."),
            "label": _text("Only tasks carrying this label slug."),
            "query": _text("Case-insensitive match on title or description."),
            "limit": _LIMIT,
        },
        _list_tasks,
        read_only=True,
    ),
    Tool(
        "get_task",
        "Get one task with its description, labels, open blockers, subtasks "
        "and comments.",
        {"task_id": _id("Task id.")},
        _get_task,
        required=("task_id",),
        read_only=True,
    ),
    Tool(
        "list_inbox",
        "List inbox (workflow) items — ideas and requests not yet promoted to tasks.",
        {
            "status": _enum(_INBOX_STATUSES, "Item status (default inbox)."),
            "project_id": _id("Only items in this project."),
            "limit": _LIMIT,
        },
        _list_inbox,
        read_only=True,
    ),
    Tool(
        "list_team",
        "List team members (humans and agents). Their ids are what assignee_id "
        "and author_id take.",
        {},
        _list_team,
        read_only=True,
    ),
    Tool(
        "create_task",
        "Create a task in a project. Returns the created task.",
        {
            "project_id": _id("Project the task belongs to."),
            "title": _text("Short task title.", required=True),
            "description": _text("Markdown body: context, acceptance criteria."),
            "status": _STATUS,
            "priority": _PRIORITY,
            "effort": _EFFORT,
            "assignee_id": _id("Team member to assign."),
            "label_ids": _LABEL_IDS,
        },
        _create_task,
        required=("project_id", "title"),
    ),
    Tool(
        "update_task",
        "Update fields on a task. Setting status to done resolves the blockers "
        "it holds and moves unblocked tasks back to todo.",
        {
            "task_id": _id("Task id."),
            "title": _text("New title.", required=True),
            "description": _text("New markdown body (replaces the old one)."),
            "status": _STATUS,
            "priority": _PRIORITY,
            "effort": _EFFORT,
            "assignee_id": _nullable_id("Team member to assign, or null to clear."),
            "project_id": _id("Move the task to this project."),
        },
        _update_task,
        required=("task_id",),
        annotations={"idempotentHint": True},
    ),
    Tool(
        "set_task_labels",
        "Replace a task's labels with exactly the given label ids.",
        {"task_id": _id("Task id."), "label_ids": _LABEL_IDS},
        _set_task_labels,
        required=("task_id", "label_ids"),
        annotations={"idempotentHint": True},
    ),
    Tool(
        "add_task_comment",
        "Post a comment on a task — progress notes, findings, hand-offs.",
        {
            "task_id": _id("Task id."),
            "body": _text("Markdown comment body.", required=True),
            "author_id": _id("Team member posting it; omit to post as the operator."),
        },
        _add_comment,
        required=("task_id", "body"),
    ),
    Tool(
        "add_subtask",
        "Add a checklist item to a task.",
        {"task_id": _id("Task id."), "title": _text("Subtask text.", required=True)},
        _add_subtask,
        required=("task_id", "title"),
    ),
    Tool(
        "update_subtask",
        "Rename a subtask or tick it off.",
        {
            "task_id": _id("Task id."),
            "subtask_id": _id("Subtask id from get_task."),
            "title": _text("New subtask text.", required=True),
            "done": {"type": "boolean", "description": "Whether it is done."},
        },
        _update_subtask,
        required=("task_id", "subtask_id"),
        annotations={"idempotentHint": True},
    ),
    Tool(
        "add_blocker",
        "Mark a task as blocked by another task. It is unblocked automatically "
        "when the blocking task is marked done.",
        {
            "task_id": _id("The task that is blocked."),
            "blocking_task_id": _id("The task it waits on."),
        },
        _add_blocker,
        required=("task_id", "blocking_task_id"),
        annotations={"idempotentHint": True},
    ),
    Tool(
        "remove_blocker",
        "Remove a blocker between two tasks.",
        {
            "task_id": _id("The task that is blocked."),
            "blocking_task_id": _id("The task it waits on."),
        },
        _remove_blocker,
        required=("task_id", "blocking_task_id"),
    ),
    Tool(
        "create_inbox_item",
        "Capture an idea, request or follow-up in the inbox for later triage.",
        {
            "title": _text("Short title.", required=True),
            "description": _text("Markdown details."),
            "project_id": _id("Project it relates to, if any."),
            "priority": _enum(_INBOX_PRIORITIES, "Priority (default medium)."),
            "source": _text("Where it came from, e.g. the session or agent name."),
        },
        _create_inbox_item,
        required=("title",),
    ),
    Tool(
        "update_inbox_item",
        "Update an inbox item — retitle it, move it through review, or reject it.",
        {
            "item_id": _id("Inbox item id."),
            "title": _text("New title.", required=True),
            "description": _text("New markdown details."),
            "status": _enum(_INBOX_STATUSES, "New status."),
            "priority": _enum(_INBOX_PRIORITIES, "New priority."),
            "project_id": _nullable_id("Project it relates to, or null to clear."),
        },
        _update_inbox_item,
        required=("item_id",),
        annotations={"idempotentHint": True},
    ),
    Tool(
        "promote_inbox_item",
        "Turn an inbox item into a task (status todo) and close the item. "
        "Returns the new task.",
        {
            "item_id": _id("Inbox item id."),
            "project_id": _id("Project for the task; defaults to the item's."),
            "priority": _PRIORITY,
            "assignee_id": _id("Team member to assign."),
            "notes": _text("Extra notes appended to the task description."),
        },
        _promote_inbox_item,
        required=("item_id",),
    ),
    Tool(
        "create_project",
        "Create a project to track tasks under. It has no folder attached; "
        "link one from the Codenest app if sessions should launch in it.",
        {
            "name": _text("Project name.", required=True),
            "description": _text("What the project is."),
            "tech_stack": _text("Comma-separated tech stack."),
        },
        _create_project,
        required=("name",),
    ),
    Tool(
        "update_project",
        "Update a project's name, description, tech stack or status.",
        {
            "project_id": _id("Project id."),
            "name": _text("New name.", required=True),
            "description": _text("New description."),
            "tech_stack": _text("New comma-separated tech stack."),
            "status": _text("Project status, e.g. active, paused, archived."),
        },
        _update_project,
        required=("project_id",),
        annotations={"idempotentHint": True},
    ),
)

_TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}


# --- JSON-RPC dispatch ------------------------------------------------------


def negotiate_version(requested: object) -> str:
    if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return SUPPORTED_PROTOCOL_VERSIONS[0]


def jsonrpc_error(msg_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def _result(msg_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _tool_result(payload: Any, *, is_error: bool = False) -> dict[str, Any]:
    text = payload if isinstance(payload, str) else json.dumps(payload, default=str)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


async def call_tool(
    db: aiosqlite.Connection, name: object, args: object
) -> dict[str, Any]:
    tool = _TOOLS_BY_NAME.get(name) if isinstance(name, str) else None
    if tool is None:
        return _tool_result(f"unknown tool: {name}", is_error=True)
    try:
        validated = _validate_args(tool, args)
        return _tool_result(await tool.handler(db, dict(validated)))
    except ToolError as exc:
        return _tool_result(str(exc), is_error=True)
    except HTTPException as exc:
        return _tool_result(str(exc.detail), is_error=True)
    except Exception:
        # Same rule as the app-wide handler: log the traceback here, hand the
        # client nothing that names a path or a table.
        logger.exception("mcp tool %s failed", tool.name)
        return _tool_result("internal error", is_error=True)


async def handle_message(
    db: aiosqlite.Connection, message: object
) -> dict[str, Any] | None:
    """Answer one JSON-RPC message. Notifications and responses get None."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return jsonrpc_error(None, INVALID_REQUEST, "not a JSON-RPC 2.0 message")
    method = message.get("method")
    if "id" not in message:
        return None
    msg_id = message["id"]
    if not isinstance(method, str):
        return jsonrpc_error(msg_id, INVALID_REQUEST, "missing method")
    params = message.get("params") or {}
    if not isinstance(params, dict):
        return jsonrpc_error(msg_id, INVALID_PARAMS, "params must be an object")

    if method == "initialize":
        return _result(
            msg_id,
            {
                "protocolVersion": negotiate_version(params.get("protocolVersion")),
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": _APP_VERSION},
                "instructions": _INSTRUCTIONS,
            },
        )
    if method == "ping":
        return _result(msg_id, {})
    if method == "tools/list":
        return _result(msg_id, {"tools": [tool.describe() for tool in TOOLS]})
    if method == "tools/call":
        return _result(
            msg_id,
            await call_tool(db, params.get("name"), params.get("arguments")),
        )
    return jsonrpc_error(msg_id, METHOD_NOT_FOUND, f"method not found: {method}")
