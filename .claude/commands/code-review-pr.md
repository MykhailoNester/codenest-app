---
description: Reviews a pull request opened by someone else. Fetches the PR branch with plain git, reviews the diff against Codenest's conventions, and outputs a review ready to paste into GitHub.
argument-hint: <PR number | branch | URL>
allowed-tools: Bash(git fetch:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git branch:*), Bash(git merge-base:*), Bash(git ls-remote:*), Bash(git rev-parse:*), Bash(shasum:*), Read, Grep, Glob
---

# Code Review PR

Reviews a pull request against Codenest's architecture, conventions, and quality
gate, and produces a review as **text to paste into GitHub yourself**.

This command uses plain `git` against the repository's configured `origin`. It
never posts, approves, merges, pushes, or otherwise writes to the remote — the
output is yours to review before anything reaches the PR.

## Input

`$ARGUMENTS` — one of:

- a **PR number** (`42`)
- a **PR URL** (`https://github.com/<owner>/<repo>/pull/42`) — take the number
  off the end
- a **branch name** (`feature/schedule-pause`) — for a branch pushed to `origin`
  without a PR yet
- **nothing** — ask which PR or branch to review, and stop until told

## Step 1 — Fetch the changes

For a PR number `N`, substitute the actual number for `<N>` everywhere below,
including in the local branch name. (This works for fork PRs too — GitHub exposes
every PR head under `refs/pull/*` on the base repository.)

```bash
git fetch origin "pull/<N>/head:pr-<N>"
git log --oneline develop..pr-<N>
git diff --stat develop...pr-<N>
git diff develop...pr-<N>
```

For a branch:

```bash
git fetch origin <branch>
git log --oneline develop..FETCH_HEAD
git diff --stat develop...FETCH_HEAD
git diff develop...FETCH_HEAD
```

Use `develop` as the base when it exists (or `origin/develop` if the local one is
behind), and fall back to `master`, the GitHub default branch. Check which one the
PR actually targets and use that.

If the fetch fails — no network, no such PR, or a remote that does not expose
`refs/pull` — say exactly what failed and offer the fallback: ask the author for
the branch name, or have the diff pasted directly into the conversation, and
review that instead. Do not guess at the contents.

The local `pr-N` branch is a leftover; mention it at the end so it can be deleted
with `git branch -D pr-N`. Never check it out over uncommitted work, and never
push it anywhere.

## Step 2 — Check the PR description

Compare against `.github/PULL_REQUEST_TEMPLATE.md`. The PR should have a
**Summary** that says what and why, the **Layer(s) touched** boxes matching the
paths in the diff, and the five **Checklist** boxes honestly ticked — including
the org-agent manifest box when a bundled agent changed.

Flag missing, empty, or template-boilerplate sections, and flag a layer box that
disagrees with the diff. If the PR text is not available — nothing here reads it
from the remote, and it is not in the conversation — say "PR description not
available — not checked" rather than assuming it is fine.

## Step 3 — Read the changed files

For each file in the diff, read the **whole file**, not just the hunks, plus the
callers of anything changed in `app/services/` **and** the consumers on the other
side of any layer boundary (`frontend/src/lib/api.ts` for sidecar shapes,
`frontend/src/lib/ipc.ts` for Tauri commands). In this codebase the other half of
a contract is usually in a different layer, so a hunk-only reading is how a
reviewer gets it wrong.

## Step 4 — Apply the review checklist

The full Codenest review checklist lives in **`.claude/agents/code-reviewer.md`**.
**Read it and apply it** — its checklist, its adversarial verify pass, and its
severity scale. Do not work from a summary and do not reproduce one here; a second
copy of that checklist is exactly how the two drift apart. **Ignore its Output
format** — the Output section below governs this command.

Then add these, which only apply to reviewing someone else's PR:

- **Dependencies** — any addition to `requirements.txt`, `frontend/package.json`
  or `src-tauri/Cargo.toml` must be pinned, lockfile-updated, justified, and
  actually needed. Treat an unexplained new dependency as a 🟡 at minimum, and a
  new transitive-heavy one on a desktop app that ships its whole runtime as worth
  a question.
- **CI, tooling, and build** — changes to `.github/workflows/`, `Makefile`,
  `scripts/build-sidecar.sh`, `pyinstaller.spec`, `tauri.conf.json` or
  `capabilities/` in a PR that is otherwise a feature deserve explicit scrutiny; a
  fork PR editing CI or a Tauri capability is a 🔴 until explained.
- **Committed artefacts** — anything under `data/`, a `.env`, a credential, a real
  project path, a `sidecar.tar.gz`, or a `src-tauri/target` entry. All are
  gitignored; their presence means something went wrong.
- **DCO** — `CONTRIBUTING.md` requires a `Signed-off-by` trailer on every commit.
  Check `git log --format='%b' develop..pr-N` for it and note any commit missing
  one. Also check no commit carries a `Co-Authored-By` trailer, which this project
  bans.
- **Licensing** — the project is `FSL-1.1-ALv2`; new vendored third-party files
  need their licence recorded in `THIRD-PARTY-NOTICES.md`.
- **Intent match** — does the diff do what the PR says it does, and only that?

## Step 5 — Verify findings (adversarial pass)

Run the adversarial pass from `code-reviewer.md` before writing anything: try to
**refute** every candidate 🔴 and 🟡, and default to "not a bug unless proven".

It matters more here than on your own branch. A wrong blocker on someone else's PR
costs the author a round trip and costs you credibility, so when you cannot name
the trigger, downgrade it or drop it.

## Output

Two parts.

### Part 1 — the review, ready to paste

Print the review body inside a single fenced ```markdown block so it copies
cleanly into GitHub's review box:

```markdown
## Summary

<one paragraph: what the PR does, and the verdict — **Approve** /
**Request changes** / **Needs discussion**>

## Findings

**F1. 🔴 BLOCKER `migrations/000_baseline_schema.sql:212` — Column added to an applied migration**
What is wrong and why it matters.
**Reachability:** entry point → call site → the input or state that reaches it,
and why nothing guards it.
**Fix:** the concrete change.

**F2. 🟡 SUGGESTION `app/routers/schedules.py:44` — …**
…

## What looks good

<two or three specific things — not filler>

## Questions

<where the intent is unclear and only the author can answer>
```

Rules:

- Number findings `F1, F2, F3…` continuously, ordered most-severe first, so they
  can be referenced in follow-up discussion. Keep IDs stable across re-posts.
- Severities are `code-reviewer.md`'s, unchanged. Every 🔴 and 🟡 needs a
  reachability line; if you cannot name a trigger, downgrade it or drop it.
- Write it for the author, not for yourself: direct, specific, no hedging, no
  moralising. Say what is wrong and what to do about it.
- A clean PR gets a short review. Do not pad empty sections to fill the shape.

### Part 2 — notes for you (outside the fenced block)

- **Verdict** and the count by severity.
- **Inline comments**, if any are worth placing on specific lines — as a short
  `file:line — F<N>` list, so they can be pasted onto the right lines by hand.
- **Not checked** — anything skipped and why (PR description unavailable, the gate
  not run locally, a generated file or a screenshot not reviewed byte by byte).
- **Cleanup** — the `git branch -D pr-N` reminder if a local branch was created.

To validate the PR actually builds and passes rather than only reading it, check
it out in a scratch worktree, bootstrap it the way the Setup stage of
`.claude/workflows/ship-tasks.js` does — symlink `.venv`, `src-tauri/target` and
`src-tauri/resources/sidecar.tar.gz`, then `pnpm install --frozen-lockfile` — and
hand it to `compiler-agent` in `full` mode. Say so as a suggestion; do not do it
unasked, since it means creating a worktree.
