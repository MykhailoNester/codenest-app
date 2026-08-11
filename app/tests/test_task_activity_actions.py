"""Cross-language parity for the task activity feed's phrase map.

`app/services/*.py` writes `activity_log` rows via `log_activity(db,
entity_type, entity_id, action, ...)`. `frontend/src/lib/task-activity.ts`
maps each `action` for `entity_type == "task"` to a display phrase. This
walks both sides — an `ast` traversal of every Python service module, and a
small regex over the TypeScript action tuple — and asserts the two sets are
exactly equal, so a newly logged task action can never silently degrade to
raw text unnoticed, and the phrase map never claims to cover an action
nothing actually logs.

No database is needed — this reads source files only, which is why it lives
in `app/tests/` (no `conftest.py`) rather than `tests/sidecar/`. A vitest
test cannot do the Python-source half: `tsconfig.app.json`'s
`types: ["vite/client"]` means a test under `frontend/src` cannot import
`node:fs` without breaking `tsc -b`.
"""

from __future__ import annotations

import ast
import pathlib
import re

SERVICES_DIR = pathlib.Path(__file__).parents[1] / "services"
TASK_ACTIVITY_TS = (
    pathlib.Path(__file__).parents[2] / "frontend" / "src" / "lib" / "task-activity.ts"
)


def _log_activity_calls(tree: ast.Module) -> list[ast.Call]:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "log_activity"
    ]


def _arg(call: ast.Call, position: int, name: str) -> ast.expr | None:
    """The positional arg at `position`, or the keyword arg `name`."""
    if len(call.args) > position:
        return call.args[position]
    for kw in call.keywords:
        if kw.arg == name:
            return kw.value
    return None


def _string_literal(node: ast.expr | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _task_actions_by_file() -> dict[str, set[str]]:
    """``{module stem: {action, ...}}`` for every ``log_activity(...,
    entity_type="task", ...)`` call across ``app/services/*.py``.

    Raises loudly (not skips) if a matching call's ``action`` argument is
    not a string literal — an unparseable call would silently shrink the
    expected set and defeat the whole point of this test.
    """
    by_file: dict[str, set[str]] = {}
    for path in sorted(SERVICES_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for call in _log_activity_calls(tree):
            entity_type = _string_literal(_arg(call, 1, "entity_type"))
            if entity_type != "task":
                continue
            action = _string_literal(_arg(call, 3, "action"))
            if action is None:
                raise AssertionError(
                    f"{path.name}:{call.lineno}: a log_activity(..., "
                    "entity_type='task', ...) call's action is not a string "
                    "literal — this test cannot verify it has a frontend phrase"
                )
            by_file.setdefault(path.stem, set()).add(action)
    return by_file


def _frontend_actions() -> set[str]:
    text = TASK_ACTIVITY_TS.read_text()
    match = re.search(
        r"TASK_ACTIVITY_ACTIONS\s*=\s*\[(.*?)\]\s*as const;", text, re.DOTALL
    )
    assert match is not None, (
        "could not find `TASK_ACTIVITY_ACTIONS = [...] as const;` in "
        f"{TASK_ACTIVITY_TS}"
    )
    return set(re.findall(r'"([a-z_]+)"', match.group(1)))


def test_every_logged_task_action_has_a_frontend_phrase() -> None:
    logged: set[str] = set()
    for actions in _task_actions_by_file().values():
        logged |= actions

    mapped = _frontend_actions()

    missing_phrase = logged - mapped
    speculative = mapped - logged
    assert not missing_phrase and not speculative, (
        "actions logged with no frontend phrase (would render raw): "
        f"{sorted(missing_phrase)}; phrases for actions nothing logs "
        f"(speculative mapping): {sorted(speculative)}"
    )


def test_only_task_service_logs_task_entity_activity() -> None:
    """Keeps the parity test's reach honest: if another service ever starts
    logging `entity_type="task"` activity, this fails until the reach above
    (and this assertion) are updated to include it."""
    by_file = _task_actions_by_file()
    other_files = set(by_file) - {"task_service"}
    assert not other_files, (
        f"entity_type='task' activity is also logged outside task_service.py: "
        f"{sorted(other_files)} — update this test's reach if that is intentional"
    )
