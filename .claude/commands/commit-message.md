---
description: "Generates a git commit message in project format [#N] - description; keyed to the WorkBoard ticket, derived from the current branch and the staged/unstaged changes. Outputs the message only; it does not commit."
argument-hint: "[#24]  (optional — only needed when the branch name carries no ticket id)"
allowed-tools: Bash(git branch:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Read, Grep, Glob
---

Generate a git commit message for the current changes in Codenest.

## Steps

1. **Resolve the ticket id**, in this order — first hit wins:
   1. `git branch --show-current`, and take the leading numeric segment after the
      prefix: `fix/18-agent-pane-view-fill` → `18`, `feature/24-task-detail-document`
      → `24`. `/ship` mints branches in that form precisely so this step works.
   2. A `#N` passed in `$ARGUMENTS`.
   3. None — then **omit the bracket entirely** and write the summary alone. Do
      not invent a number, and do not reach for the most recent ticket you saw:
      a commit keyed to the wrong ticket is worse than one keyed to none, because
      it is wrong in a way `git log` will never reveal.

2. `git diff --cached` for staged changes. If it is empty, `git diff HEAD` for
   unstaged ones. If both are empty, say so and stop.

3. Work out which layers the change touches, because that shapes the bullets:

   | Path | Layer |
   |---|---|
   | `app/`, `main.py`, `migrations/` | sidecar |
   | `frontend/` | frontend |
   | `src-tauri/` | shell |
   | `Makefile`, `.github/`, `scripts/`, `requirements.txt`, lockfiles | tooling |
   | `*.md`, `docs/` | docs |

   One layer is the norm. When the change crosses layers, one bullet says what the
   contract between them now is — endpoint, payload, SSE event or Tauri command.

4. Write a clear, **lowercase** summary line describing the overall change. No
   hard word limit, but keep it to one line and make it specific: "stop the
   scheduler re-dispatching a run after a mid-tick restart" beats "fix scheduler
   bug".

5. If the change touches several distinct areas, add bullets under the summary.

6. **Call out anything with consequences beyond the diff.** These are what a
   reviewer, or a future `git bisect`, needs and cannot reconstruct from the code.
   One bullet each, only when present:

   - a **new migration** — name the file, and that migrations are append-only and
     stem-recorded, so it can never be edited after it applies;
   - a **re-hashed `src-tauri/resources/org-agents/manifest.json`** — installs are
     per-file-hash-diffed and revert anything that disagrees, so the hash and the
     bumped version are the change, not bookkeeping;
   - a **mirror pair touched** — `FEATURE_DEFAULTS` ↔ `_FEATURES_DEFAULT`, or
     `KNOWN_FEATURES_ORDERED` ↔ `KNOWN_FEATURES` — so the next person knows the
     pair was considered; a slug missing from the ordered list can never be
     switched on and no gate catches it;
   - a **new dependency or a version bump**, and why the stdlib or an existing one
     did not do;
   - a **capability added in `src-tauri/capabilities/*.json`** — a missing one
     presents as a frontend bug, not a permission error;
   - a **behaviour change behind an existing setting or feature toggle**;
   - a change that needs **`AGENTS.md` or `README.md`** updated.

Prefer the one or two decisions a reader in six months could not reconstruct from
the diff over a complete narration of the change.

## Output rules — this is critical

- Output **ONLY** the commit message string, nothing else.
- No explanation, no preamble, no markdown code fence around it.
- **Do not run `git commit`.** This command produces text; committing is the
  user's call. (The one exception is `/ship`, which owns its own commit stage.)
- **Never add a `Co-Authored-By` trailer** — this project bans them.
- Do not write a `Signed-off-by` trailer by hand either; `git commit -s`
  generates it from the committer's own identity, which is the point of the DCO.
- **This repo does not use Conventional Commits.** Never write `feat(scope):`,
  `fix:` or `chore:`. The bracketed ticket id is the only prefix.

## Format

Simple change:

```
[#N] - <description>;
```

Change with several parts:

```
[#N] - <description>;

- <detail one>;
- <detail two>;
- <detail three>;
```

Every line, summary and bullets alike, ends in a semicolon.

## Examples

```
[#18] - give the agent pane's drill-in views the same grow-and-scroll box as the transcript;
```

```
[#17] - attribute sub-agent frames to their own stream instead of the main transcript;

- route every frame carrying a non-null parent_tool_use_id into the owning Task/Agent block;
- render one delegation card in the transcript where the delegated prompt used to land;
- drop a frame whose parent_tool_use_id names no known block, rather than showing it as the user's own words;
```

```
[#24] - rebuild task detail as a read-first document with a properties sidebar;

- add frontend/src/styles/d3-taskdetail.css, imported from main.tsx beside d3-taskboard.css;
- reads only existing tokens.css custom properties — no new tokens;
- renders the three efforts the CHECK constraint allows, not the mockup's five;
```

```
- run the quality gate on pushes to develop;
```
