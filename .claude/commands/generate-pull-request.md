---
description: Prepares pull request text locally — title and body filled into the repo's PR template, ready to copy into GitHub. It does not create the PR.
argument-hint: "[extra context about why this change was made]"
allowed-tools: Bash(git branch:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git merge-base:*), Bash(shasum:*), Read, Grep, Glob
---

# Pull Request Text Generator

Produces the title and body for a pull request on the current branch, filled
into `.github/PULL_REQUEST_TEMPLATE.md`, so it can be pasted straight into
GitHub's "New pull request" form.

**This command is local preparation only.** It does not push, does not open a
PR, and does not talk to GitHub. No ticket references — Codenest tracks work by
branch name.

## Input

None. Everything comes from the current branch and its diff. If the caller
passes `$ARGUMENTS`, treat it as extra context about intent (the "why") rather
than as a ticket ID.

## Steps

### 1. Establish the branch and base

```bash
git branch --show-current
git status --short
git log --oneline develop..HEAD
git diff --stat develop...HEAD
git diff develop...HEAD
```

`develop` is the integration branch feature work is cut from; `master` is the
GitHub default branch. Use `develop` when it exists (or `origin/develop` if the
local one is behind), and fall back to `master`. If the current branch *is*
`develop` or `master`, say that a PR from it is not the intended flow and stop.

If there are uncommitted changes, note them — they will not be in the PR — and
carry on with what is committed.

### 2. Understand the change

Read the commits and the diff. Where the diff alone does not explain the intent,
read the changed files. The "why" has to say something the diff cannot.

### 3. Write the title

Same shape as this repo's commit subjects: capitalised, imperative, under ~72
characters, no trailing period, no Conventional Commit prefix.

Example: `Add a paused state to agent schedules`

### 4. Fill the template

The body follows `.github/PULL_REQUEST_TEMPLATE.md` exactly — the same headings
in the same order. **Read that file** rather than trusting this copy, in case it
has changed:

```markdown
## Summary

<what this changes, and why>

## Layer(s) touched

- [ ] Sidecar (`app/`, `main.py`)
- [ ] Frontend (`frontend/`)
- [ ] Shell (`src-tauri/`)

## Checklist

- [ ] `make check-all` passes locally
- [ ] Tests added or updated for this change
- [ ] No internal / private references introduced (paths, hostnames, employer data, PII)
- [ ] `AGENTS.md` updated if commands or the dev workflow changed
- [ ] Org-agent `manifest.json` sha256 re-hashed and `version` bumped if any `src-tauri/resources/org-agents/*.md` file changed
```

Tick the layer boxes from the paths in the diff. If more than one is ticked,
the Summary must describe the contract that crosses them — that is what the
template's comment asks for.

Tick a checklist box only when it is **verifiably true**:

- `make check-all` — tick only if it has actually been run and passed in this
  session (or via `compiler-agent`). Otherwise leave it unticked and say so.
- Tests — check the diff actually contains test changes in the right suite
  (`tests/sidecar/`, `app/tests/`, `frontend/src/**/__tests__/`, or a Rust
  `#[cfg(test)]` module).
- Private references — grep the diff for absolute home paths, hostnames, tokens,
  real project names, and anything identifying in `docs/media/`.
- `AGENTS.md` — tick only if commands or the dev workflow genuinely changed and
  the file was updated.
- Org-agent manifest — if the diff touches `src-tauri/resources/org-agents/*.md`,
  verify the sha256 with
  `shasum -a 256 src-tauri/resources/org-agents/<file>.md` and confirm the
  manifest `version` was bumped. If it touches none, say "n/a" rather than
  ticking it.

Then add, below the template, one short **Migration** note if the diff adds a
`migrations/NNN_*.sql`: the filename, what it changes, and that it applies to
existing databases on next launch. That is the highest-risk kind of change in this
repo and a reviewer should not have to find it in the file list.

Drop a heading only if the template drops it. If a section genuinely has nothing
to say, write one honest line rather than deleting it.

## Writing guidelines

❌ Avoid marketing filler — "improves the user experience", "ensures expected
behaviour", "enhances the flow".

✅ Be factual and technical. Problem → change → observable result. Name the
files, the functions, and what a reviewer can check.

For anything touching migrations, the scheduler, or process spawning, spell out
how to verify it: which command to run, what the app should do, what the database
should look like afterwards.

## Output

Print, in this order and nothing else:

1. The title on its own line, prefixed with `Title:`.
2. The body inside a single fenced ```markdown block, so it copies cleanly into
   GitHub.
3. One short line after the block noting anything the author must fix before
   opening the PR — unticked checklist items, uncommitted work, an unpushed
   branch. Skip the line entirely if there is nothing to flag.

Do not add commentary, a summary of your own work, or next-step suggestions
beyond that one line.
