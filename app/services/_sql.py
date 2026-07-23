"""Shared SQL and text helpers.

Cross-service utilities that don't belong to a specific domain
service. Keep this surface small — anything that grows beyond a handful
of free functions belongs in its own service module.
"""

from __future__ import annotations


def escape_like(value: str) -> str:
    """Escape SQL LIKE metacharacters for use with ``LIKE ? ESCAPE '\\'``.

    Always pair the placeholder with the literal ``ESCAPE '\\'`` clause
    in the surrounding SQL — otherwise the backslash is meaningless and
    user-supplied ``%`` / ``_`` will still wildcard.
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def build_update(
    table: str,
    patch: dict,
    allowed: set[str],
    *,
    id_col: str = "id",
) -> tuple[str, list]:
    """Build a parameterized ``UPDATE … SET … WHERE id_col = ?`` statement.

    ``table`` and ``id_col`` must be code-controlled literals (never user input).
    Column names are validated against ``allowed`` before being interpolated.
    Values are always passed as query parameters.

    Returns ``(sql, params)`` where ``params`` ends with the id placeholder
    (caller must append the row id as the last element before executing).

    Usage::

        sql, params = build_update("documents", data, {"title", "category"})
        params.append(doc_id)
        await db.execute(sql, params)

    Returns ``("", [])`` when no allowed key is present in ``patch``.
    """
    fields: list[str] = []
    values: list = []
    for key, val in patch.items():
        if key in allowed:
            fields.append(f"{key} = ?")
            values.append(val)
    if not fields:
        return "", []
    sql = f"UPDATE {table} SET {', '.join(fields)} WHERE {id_col} = ?"
    return sql, values


def slugify(s: str, *, fallback: str = "") -> str:
    """Convert a string into a URL/file-safe slug.

    Replaces non-alphanumeric characters with hyphens, collapses runs of
    hyphens, strips leading/trailing hyphens, and returns ``fallback`` when
    the result is empty.

    >>> slugify("My Project Name")
    'my-project-name'
    >>> slugify("", fallback="project")
    'project'
    """
    out = "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return out or fallback
