import aiosqlite

VALID_TYPES = {
    "task",
    "project",
    "doc",
    "inbox",
    "event",
    "session",
    "attention",
}

# Which ingest lane a hit is evidence from. `agent_events` is written only by
# the hook path (agent_service), so an event hit is Lane A evidence. A session
# row is written field-by-field by all three lanes — squashing that into one
# value would be a lie, so it stays None and the Session Inspector shows the
# per-field provenance. The workflow tables are not lane data at all.
_LANE = {"event": "A"}

# Which UI surface owns the hit. Labels live in the frontend.
_SURFACE = {
    "task": "tasks",
    "project": "project-context",
    "doc": "docs",
    "inbox": "inbox",
    "event": "session-inspector",
    "session": "session-inspector",
    "attention": "attention",
}

_URL_MAP = {
    "task": lambda r: f"/tasks/{r['id']}",
    "project": lambda r: f"/projects/{r['id']}/context",
    "doc": lambda r: f"/docs?id={r['id']}",
    "inbox": lambda r: f"/inbox?id={r['id']}",
    "event": lambda r: (
        f"/sessions/{r['session_id']}" if r.get("session_id") else "/sessions"
    ),
    "session": lambda r: f"/sessions/{r['id']}",
    "attention": lambda r: "/attention",
}

_FTS_TYPES = ("task", "project", "doc", "inbox", "event")

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

# Sessions and attention items are matched with LIKE, not FTS, so they carry no
# bm25 figure. bm25() is negative and the merge sorts ascending, so these two
# constants place an identifier/title hit mid-pack and a secondary-field hit
# below it.
_DIRECT_SCORE_PRIMARY = -3.0
_DIRECT_SCORE_SECONDARY = -1.0

_SESSION_SQL = r"""
    SELECT session_id, title, cwd, model, source_app, git_branch, started_at
    FROM agent_sessions
    WHERE session_id LIKE ? ESCAPE '\'
       OR COALESCE(cwd, '') LIKE ? ESCAPE '\'
       OR COALESCE(model, '') LIKE ? ESCAPE '\'
       OR COALESCE(source_app, '') LIKE ? ESCAPE '\'
       OR COALESCE(git_branch, '') LIKE ? ESCAPE '\'
       OR COALESCE(title, '') LIKE ? ESCAPE '\'
    ORDER BY last_event_at DESC
    LIMIT ?
"""

_ATTENTION_SQL = r"""
    SELECT id, kind, severity, state, title, detail, session_id, first_seen_at
    FROM attention_items
    WHERE title LIKE ? ESCAPE '\'
       OR COALESCE(detail, '') LIKE ? ESCAPE '\'
       OR kind LIKE ? ESCAPE '\'
    ORDER BY (state = 'open') DESC, first_seen_at DESC
    LIMIT ?
"""


def _escape_fts_query(q: str) -> str:
    cleaned = q.replace('"', "").replace("(", "").replace(")", "").strip()
    if " " in cleaned:
        return f'"{cleaned}"'
    return f"{cleaned}*"


def _like_term(q: str) -> str:
    esc = q.strip().replace("\\", r"\\").replace("%", r"\%").replace("_", r"\_")
    return f"%{esc}%"


def _mark(text: str | None, needle: str) -> str:
    """Wrap the first case-insensitive hit in <mark>, matching snippet()."""
    if not text or not needle:
        return text or ""
    idx = text.lower().find(needle.lower())
    if idx < 0:
        return text
    end = idx + len(needle)
    return f"{text[:idx]}<mark>{text[idx:end]}</mark>{text[end:]}"


def _hit(text: str | None, needle: str) -> bool:
    return bool(text) and needle in (text or "").lower()


async def _fts_rows(
    db: aiosqlite.Connection, q: str, types: list[str], limit: int
) -> list[dict]:
    branches = [_BRANCH_SQL[t] for t in types]
    sql = " UNION ALL ".join(branches) + " ORDER BY score ASC LIMIT ?"
    params = [_escape_fts_query(q)] * len(branches) + [limit]
    cursor = await db.execute(sql, params)
    return [dict(r) for r in await cursor.fetchall()]


async def _session_rows(db: aiosqlite.Connection, q: str, limit: int) -> list[dict]:
    term = _like_term(q)
    cursor = await db.execute(_SESSION_SQL, [term] * 6 + [limit])
    needle = q.strip().lower()
    out = []
    for row in await cursor.fetchall():
        r = dict(row)
        title = r["title"] or r["session_id"]
        facets = [r["cwd"], r["model"], r["git_branch"], r["source_app"]]
        primary = _hit(r["session_id"], needle) or _hit(r["title"], needle)
        out.append(
            {
                "type": "session",
                "id": r["session_id"],
                "title": title,
                "snippet": _mark(" · ".join(f for f in facets if f), q.strip()),
                "score": (
                    _DIRECT_SCORE_PRIMARY if primary else _DIRECT_SCORE_SECONDARY
                ),
                "created_at": r["started_at"],
                "session_id": r["session_id"],
            }
        )
    return out


async def _attention_rows(db: aiosqlite.Connection, q: str, limit: int) -> list[dict]:
    term = _like_term(q)
    cursor = await db.execute(_ATTENTION_SQL, [term] * 3 + [limit])
    needle = q.strip().lower()
    out = []
    for row in await cursor.fetchall():
        r = dict(row)
        detail = r["detail"] or f"{r['kind']} · {r['severity']}"
        out.append(
            {
                "type": "attention",
                "id": r["id"],
                "title": r["title"],
                "snippet": _mark(detail, q.strip()),
                "score": (
                    _DIRECT_SCORE_PRIMARY
                    if _hit(r["title"], needle)
                    else _DIRECT_SCORE_SECONDARY
                ),
                "created_at": r["first_seen_at"],
                "session_id": r["session_id"],
                "state": r["state"],
                "severity": r["severity"],
            }
        )
    return out


async def search(
    db: aiosqlite.Connection,
    q: str,
    types: list[str],
    limit: int,
) -> list[dict]:
    if len(q.strip()) < 2:
        return []

    active = [t for t in types if t in VALID_TYPES]
    if not active:
        return []

    db.row_factory = aiosqlite.Row

    rows: list[dict] = []
    fts_types = [t for t in _FTS_TYPES if t in active]
    if fts_types:
        rows += await _fts_rows(db, q, fts_types, limit)
    if "session" in active:
        rows += await _session_rows(db, q, limit)
    if "attention" in active:
        rows += await _attention_rows(db, q, limit)

    rows.sort(key=lambda r: r["score"])

    results = []
    for r in rows[:limit]:
        url_fn = _URL_MAP.get(r["type"])
        r["url"] = url_fn(r) if url_fn else None
        r["lane"] = _LANE.get(r["type"])
        r["surface"] = _SURFACE.get(r["type"])
        if r.get("session_id") is None:
            r.pop("session_id", None)
        results.append(r)
    return results
