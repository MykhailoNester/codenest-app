"""`frontend/src/styles/deck.css` is generated — this proves it is current.

`design/deck/build_app_css.py` scopes `design/deck/tokens.css` and
`design/deck/deck.css` to `.deck` and writes the result into the frontend. The
generated file carries a "do not edit" banner, and AGENTS-level guidance says
never to touch it, but nothing enforced either half: an edit to the generated
file, or a change to the source without a regenerate, both shipped silently.
That matters because the two diverging means the browser stops agreeing with
the stylesheet anyone reads to reason about the design.

Runs the generator in a subprocess against a copy of the tree, so a failure
never rewrites the file it is checking.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
GENERATED = REPO / "frontend" / "src" / "styles" / "deck.css"
BUILDER = REPO / "design" / "deck" / "build_app_css.py"


def test_generated_deck_css_matches_its_source() -> None:
    assert BUILDER.is_file(), f"generator missing: {BUILDER}"
    assert GENERATED.is_file(), f"generated stylesheet missing: {GENERATED}"

    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        shutil.copytree(REPO / "design", root / "design")
        (root / "frontend" / "src" / "styles").mkdir(parents=True)

        result = subprocess.run(
            [sys.executable, str(root / "design" / "deck" / "build_app_css.py")],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, (
            f"build_app_css.py failed:\n{result.stdout}\n{result.stderr}"
        )

        fresh = (root / "frontend" / "src" / "styles" / "deck.css").read_text()

    assert fresh == GENERATED.read_text(), (
        "frontend/src/styles/deck.css is out of date with design/deck/. "
        "Run `python3 design/deck/build_app_css.py` and commit the result — "
        "and never hand-edit the generated file."
    )
