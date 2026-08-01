---
description: Writes a commit message for the current changes in this repo's own style — imperative subject, what-and-why body. Outputs the message only; it does not commit.
allowed-tools: Bash(git branch:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Read, Grep, Glob
---

Generate a git commit message for the current changes in Codenest.

**This repo does not use Conventional Commits.** Do not write `feat(scope):` or
`fix:` — look at `git log --format='%s' -10` and match what is there: a
capitalised, imperative sentence.

## Steps

1. `git diff --cached` for staged changes. If it is empty, `git diff HEAD` for
   unstaged ones. If both are empty, say so and stop.

2. Work out which layers the change touches, because that shapes the body:

   | Path | Layer |
   |---|---|
   | `app/`, `main.py`, `migrations/` | sidecar |
   | `frontend/` | frontend |
   | `src-tauri/` | shell |
   | `Makefile`, `.github/`, `scripts/`, `requirements.txt`, lockfiles | tooling |
   | `*.md`, `docs/` | docs |

   One layer is the norm. When the change crosses layers, the body says what the
   contract between them now is.

3. Write the subject: capitalised, imperative, **under 72 characters**, no
   trailing period, and specific about what changed. "Stop the scheduler
   re-dispatching a run after a mid-tick restart" beats "fix scheduler bug".

4. Write the body: a blank line, then prose or short bullets wrapped at **72
   characters**, saying **what and why — never how**. The diff already shows how.
   Where a decision is non-obvious, say what forced it; that is the part a reader
   in six months cannot reconstruct.

5. Call out anything with consequences beyond the diff, one line each:
   - a new migration (name the file, and that it is append-only)
   - a re-hashed `src-tauri/resources/org-agents/manifest.json`
   - a new dependency and why the stdlib or an existing one didn't do
   - a behaviour change that needs `AGENTS.md` or `README.md` updated

## Output rules — this is critical

- Output **only** the commit message. No explanation, no preamble, no markdown
  code fence around it.
- **Do not run `git commit`.** This command produces text; committing is the
  user's call. (The one exception is `/ship`, which owns its own commit stage.)
- **Never add a `Co-Authored-By` trailer** — this project bans them.
- Do not add a `Signed-off-by` trailer by hand either; `git commit -s` generates
  it from the committer's own identity, which is the point of the DCO.

## Format

Simple change:

```
<type>(<scope>): <summary>
```

Change with several parts:

```
<type>(<scope>): <summary>

- <detail one>
- <detail two>
```

## Examples

```
fix(dashboard): show a flat period as +0.00%, not as an em dash
```


```
feat(debts): add a paused state to agent schedules

- migrations/003_schedule_paused.sql add the column, defaulting to 0 so
  existing schedules keep firing
- the tick skips paused rows rather than filtering them out of the list,
  so a paused schedule still shows its next fire time in the UI
```

```
chore(ci): run the quality gate on pushes to develop
```
