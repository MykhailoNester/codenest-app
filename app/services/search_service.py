import aiosqlite

VALID_TYPES = {"task", "project", "doc", "inbox", "event"}

_URL_MAP = {
    "task": lambda r: f"/tasks/{r['id']}",
    "project": lambda r: f"/projects/{r['id']}",
    "doc": lambda r: f"/docs?id={r['id']}",
    "inbox": lambda r: f"/inbox?id={r['id']}",
    "event": lambda r: (
        f"/sessions/{r['session_id']}" if r.get("session_id") else "/sessions"
    ),
}

_BRANCH_SQL = {
    "task": """
        SELECT 'task' AS type, t.id, t.title AS title,
               snippet(tasks_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
               bm25(tasks_fts) AS score, t.created_at, NULL AS session_id
        FROM tasks_fts JOIN tasks t ON t.id = tasks_fts.rowid
        WHERE tasks_fts MATCH ?""",
    "project": """
        SELECT 'project' AS type, p.id, p.name AS title,
               snippet(projects_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
               bm25(projects_fts) AS score, p.created_at, NULL AS session_id
        FROM projects_fts JOIN projects p ON p.id = projects_fts.rowid
        WHERE projects_fts MATCH ?""",
    "doc": """
        SELECT 'doc' AS type, d.id, d.title AS title,
               snippet(documents_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
               bm25(documents_fts) AS score, d.created_at, NULL AS session_id
        FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
        WHERE documents_fts MATCH ?""",
    "inbox": """
        SELECT 'inbox' AS type, wi.id, wi.title AS title,
               snippet(inbox_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
               bm25(inbox_fts) AS score, wi.created_at, NULL AS session_id
        FROM inbox_fts JOIN workflow_items wi ON wi.id = inbox_fts.rowid
        WHERE inbox_fts MATCH ?""",
    "event": """
        SELECT 'event' AS type, ae.id,
               COALESCE(ae.summary, ae.event_type) AS title,
               snippet(agent_events_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
               bm25(agent_events_fts) AS score, ae.created_at, ae.session_id
        FROM agent_events_fts JOIN agent_events ae ON ae.id = agent_events_fts.rowid
        WHERE agent_events_fts MATCH ?""",
}


def _escape_fts_query(q: str) -> str:
    cleaned = q.replace('"', "").replace("(", "").replace(")", "").strip()
    if " " in cleaned:
        return f'"{cleaned}"'
    return f"{cleaned}*"


async def search(
    db: aiosqlite.Connection,
    q: str,
    types: list[str],
    limit: int,
) -> list[dict]:
    if len(q.strip()) < 2:
        return []

    active_types = [t for t in types if t in VALID_TYPES]
    if not active_types:
        return []

    fts_q = _escape_fts_query(q)

    branches = [_BRANCH_SQL[t] for t in active_types]
    sql = " UNION ALL ".join(branches) + " ORDER BY score ASC LIMIT ?"
    params = [fts_q] * len(active_types) + [limit]

    db.row_factory = aiosqlite.Row
    cursor = await db.execute(sql, params)
    rows = await cursor.fetchall()

    results = []
    for row in rows:
        r = dict(row)
        url_fn = _URL_MAP.get(r["type"])
        r["url"] = url_fn(r) if url_fn else None
        if r["type"] != "event":
            r.pop("session_id", None)
        results.append(r)
    return results
