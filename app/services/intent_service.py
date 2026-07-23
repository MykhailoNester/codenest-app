"""Intent classification for the Universal Prompt Bar.

Pure, side-effect-free. The frontend hits ``POST /api/v1/intent/classify``
with the raw input string and routes the user to the matching surface
based on the returned ``kind``. The classifier is regex/prefix-based in
v1; an LLM-assisted classifier is filed as a follow-up.
"""

from __future__ import annotations

from typing import Any, Literal

IntentKind = Literal[
    "command-palette",
    "slash",
    "reference",
    "search",
    "prompt",
]

# Heuristic threshold for "this is too long to be a search query, treat it
# as a captured prompt instead". Below this we route bare text to search.
_PROMPT_MIN_CHARS = 4


def classify(query: str) -> dict[str, Any]:
    """Return ``{kind, payload}`` for the given input.

    Payload is the input with the leading sigil stripped where applicable.
    """
    if not isinstance(query, str):
        return {"kind": "command-palette", "payload": ""}
    stripped = query.strip()
    if not stripped:
        return {"kind": "command-palette", "payload": ""}
    if stripped.startswith("/"):
        return {"kind": "slash", "payload": stripped[1:].lstrip()}
    if stripped.startswith("@"):
        return {"kind": "reference", "payload": stripped[1:].lstrip()}
    # Free text:
    #   short → search;
    #   long-form, contains a space or ends with "?" → captured prompt.
    has_space = " " in stripped
    ends_question = stripped.endswith("?")
    if len(stripped) >= _PROMPT_MIN_CHARS and (has_space or ends_question):
        return {"kind": "prompt", "payload": stripped}
    return {"kind": "search", "payload": stripped}
