# Workboard MCP server

While Codenest is running, its sidecar serves an [MCP](https://modelcontextprotocol.io)
endpoint at `http://127.0.0.1:8002/mcp`. Any MCP client on the same machine —
a `claude` session in another terminal, an IDE, another agent — can use it to
read and manage your projects, tasks and inbox.

## Connect Claude Code

Add it once, for every project on this machine:

```bash
claude mcp add --scope user --transport http codenest http://127.0.0.1:8002/mcp
```

Or check it into one repository's `.mcp.json`:

```json
{
  "mcpServers": {
    "codenest": { "type": "http", "url": "http://127.0.0.1:8002/mcp" }
  }
}
```

The server is only there while the app is open. With the app closed, the
client shows `codenest` as failed to connect, and it reconnects next session.

## Tools

| Tool | What it does |
|---|---|
| `describe_workboard` | Valid task statuses, priorities, efforts, labels; inbox statuses |
| `list_projects`, `get_project` | Projects with task counts by status and open inbox count |
| `create_project`, `update_project` | Create a tracking project; edit name, description, tech stack, status |
| `list_tasks` | Filter by project, status, priority, assignee, label or text |
| `get_task` | One task with description, labels, open blockers, subtasks and comments |
| `create_task`, `update_task` | Create or edit a task; `status: done` runs the blocker cascade |
| `set_task_labels` | Replace a task's labels |
| `add_task_comment` | Post a comment, as the operator or as a team member |
| `add_subtask`, `update_subtask` | Checklist items on a task |
| `add_blocker`, `remove_blocker` | Dependencies between tasks |
| `list_inbox`, `create_inbox_item`, `update_inbox_item` | Capture and triage ideas and requests |
| `promote_inbox_item` | Turn an inbox item into a task |
| `list_team` | Team members, whose ids `assignee_id` and `author_id` take |

Statuses and priorities are checked against the values configured in
**Settings**, so a status you have added there is accepted and a typo is not.
Writes go through the same services as the app, so they appear in activity,
notifications and the Work view immediately.

## What it cannot do

- **Delete anything.** Removing tasks, items or projects stays in the app.
- **Change where sessions run.** A project's folder, profile and provider are
  not exposed; `create_project` makes a tracking-only project, and you link a
  folder from the app.

## Security

The endpoint has the same trust model as the rest of the sidecar: it binds
`127.0.0.1`, has no authentication, and acts with your privileges, so anything
running as you on this machine can use it. Two additional checks keep web
pages out:

- A request with an `Origin` header is refused. MCP clients don't send one;
  browsers always do.
- A request whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` is refused.
  This blocks DNS-rebinding attacks.

The transport is stateless Streamable HTTP. Each `POST` returns a JSON
response, and there is no session and no SSE stream.
