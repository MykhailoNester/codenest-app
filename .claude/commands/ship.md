---
description: Runs the autonomous delivery pipeline over one or more tasks via .claude/workflows/ship-tasks.js — worktree off develop, plan, plan review, implement, code review, quality gate, commit, worktree removed. Leaves one reviewed local branch per task. No push, no PR.
argument-hint: <tasks, in prose or by roadmap item name>
---

Deliver these tasks autonomously, each as its own committed local branch:

**$ARGUMENTS**

## How this runs

One engine: **`.claude/workflows/ship-tasks.js`**, launched through the Workflow
tool. It owns Stages 1–8 for every task — worktree → plan → plan review →
implement → code review → quality gate → commit → teardown — and fans each wave
out concurrently.

You own **Stage 0** and **Stage 9** only, because a workflow script has no
filesystem access: it cannot read `.claude/pipeline.env`, cannot derive the repo
root from git, and cannot touch a roadmap document.

Guarantees the script enforces, so you need not re-check them: every task gets its
own worktree and branch and the main checkout is never modified; a worktree is
removed only after a successful commit and preserved on any failure;
`git worktree remove` is never forced; nothing is pushed, merged, rebased or
opened as a PR; and a failed task does not block its wave — only tasks chained
behind it are skipped.

## Constants — run this block first, verbatim

**This file is committed to a public repository. Never hardcode an absolute path,
a username, or a machine-specific value here.** Resolve them at run time:

```bash
# Main repo root. --git-common-dir is correct even when run from inside a
# worktree, where --show-toplevel would wrongly return the worktree.
REPO="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

# Optional local config; every value below has a working default.
CONF="$REPO/.claude/pipeline.env"
if [ -f "$CONF" ]; then set -a; . "$CONF"; set +a; fi

WT_ROOT="${CODENEST_WORKTREE_ROOT:-$(dirname "$REPO")/.codenest-worktrees}"
BASE_BRANCH="${CODENEST_BASE_BRANCH:-develop}"
PREFIX_FEATURE="${CODENEST_PREFIX_FEATURE:-feature/}"
PREFIX_FIX="${CODENEST_PREFIX_FIX:-fix/}"
PREFIX_CHORE="${CODENEST_PREFIX_CHORE:-chore/}"
PLAN_DOC="${CODENEST_PLAN_DOC:-}"
WRITEBACK="${CODENEST_PLAN_DOC_WRITEBACK:-wip}"
SIGNOFF="${CODENEST_COMMIT_SIGNOFF:-1}"
MAX_PLAN_REVISIONS="${CODENEST_MAX_PLAN_REVISIONS:-2}"
MAX_REVIEW_FIXES="${CODENEST_MAX_REVIEW_FIXES:-2}"
MAX_GATE_FIXES="${CODENEST_MAX_GATE_FIXES:-2}"
```

`WT_ROOT` sits **outside** the repo on purpose — worktrees never need
gitignoring, and a preserved failure is easy to find. `.claude/pipeline.env` is
gitignored; `.claude/pipeline.env.example` documents every value. With no config
file at all this still works: repo root from git, worktrees beside it, branches
off `develop`, tasks from the prompt.

Report paths back to the user as they actually resolved, never as `$WT_ROOT`.

## Stage 0 — intake and wave planning

Do this yourself. It is the whole of your job before the workflow starts.

**Resolve the tasks.** If `$PLAN_DOC` is empty or missing — the default, since
this repo has no roadmap document — take the tasks from the prompt as free text
with no doc key, say once that no roadmap document is configured, and carry on.
That is a normal configuration, not an error.

Otherwise read `$PLAN_DOC` and match each requested task to a row, using whatever
status notation that document already uses. Capture the row's prose as `docRow`
and its identifier as `docKey`. Skip anything already marked done and say so. If
the document has no status notation, treat it as read-only reference and skip
Stage 9. A request matching no row is carried as free text.

**Name each task.**

| Field | Rule |
|---|---|
| `slug` | Short kebab-case, 2–4 words, unique. `schedule-pause`, `budget-csv-export`. |
| `branch` | `$PREFIX_FEATURE$SLUG` for new capability, `$PREFIX_FIX$SLUG` for a bug, `$PREFIX_CHORE$SLUG` for tooling/CI/docs/deps. |
| `base` | `$BASE_BRANCH`, unless chained — see below. |
| `statement` | The task in one or two sentences. **Every stage agent is briefed from this**, so a vague statement degrades the whole run. |

**Group into waves.** Within a wave tasks run in parallel; waves run in order.
Two tasks belong in different waves only on a **hard dependency**:

- task B consumes a service function, migration column, setting, feature toggle,
  Tauri command or API endpoint that task A introduces;
- both rewrite the body of the *same function* (merely sharing a file is not
  enough — separate worktrees make that safe);
- **both add a migration.** Migration filenames are append-only and numbered, so
  two parallel tasks would both claim `003_` and collide on merge. Sequence them
  and tell the second which number is taken.

Otherwise same wave. Do not serialise out of caution; safe parallelism is the
entire point of the worktrees.

**A chained task is based on its predecessor's branch, not `$BASE_BRANCH`** — set
its `base` to that branch and its `dependsOn` to that slug. Say so in the final
report, because it dictates review order.

**Preflight.** Once per run:

```bash
git -C "$REPO" rev-parse --verify "$BASE_BRANCH"          # abort if missing
test -d "$REPO/.venv"                                     # abort if missing
test -f "$REPO/src-tauri/resources/sidecar.tar.gz"        # build if missing
```

Then per task: `git -C "$REPO" rev-parse --verify "$BRANCH" 2>/dev/null && echo EXISTS`

- **Abort the run** if `$BASE_BRANCH` does not exist — nothing can be based on it.
- **Abort the run** if there is no `.venv`; tell the user to create it
  (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`). Do not
  create it yourself — a wrong interpreter poisons every gate result.
- **Not an abort:** a missing `sidecar.tar.gz`. Run `bash scripts/build-sidecar.sh`
  once in `$REPO` and carry on, saying you are doing it and that it takes a few
  minutes. It is a gitignored build artifact, and without it **every** `cargo check`
  fails — `tauri-build` validates that literal bundle resource at compile time.
- **Drop that one task**, before the workflow starts, if `$BRANCH` already exists.
  Never clobber existing work. The other tasks continue.
- A dirty main working tree is **not** a blocker; worktrees are independent of it.

Print the wave plan — tasks, branches, bases, what runs in parallel — then start.
You are autonomous from here: do not ask for approval.

## Launch the workflow

```
{ scriptPath: "<REPO>/.claude/workflows/ship-tasks.js",
  args: {
    repo: "<REPO>", wtRoot: "<WT_ROOT>",
    signoff: true,                       // false only when $SIGNOFF=0
    limits: { planRevisions: 2, reviewFixes: 2, gateFixes: 2 },
    tasks: [
      { slug: "schedule-pause", title: "Pause toggle for schedules",
        statement: "the task in one or two sentences — every agent is briefed from this",
        branch: "feature/schedule-pause", base: "develop",
        wave: 1, dependsOn: null,        // dependsOn is another task's slug
        docKey: null, docRow: null }     // only when $PLAN_DOC matched a row
    ] } }
```

`repo` and `wtRoot` are **required** — the script rejects the run rather than
guessing, because a default would bake somebody's home directory into a public
repository. Pass the values you resolved in the constants block.

**Every other key is silently defaulted, so a typo costs you the setting.** The
names above are exact: `limits` uses `planRevisions` / `reviewFixes` / `gateFixes`
and falls back to 2 apiece; `signoff` defaults to true, so you must pass
`signoff: false` to honour `$SIGNOFF=0`; and a task missing `statement` briefs
every agent with `TASK: undefined` and the run proceeds anyway.

**If it fails in milliseconds with `args.repo and args.wtRoot are required`, read
the error's `Received …` clause before touching your arguments.** The Workflow
tool sometimes flattens `args` into a JSON string, and `args.repo` on a string is
`undefined` however correct the payload was. The script parses a stringified
`args` back into an object, so this should just work; `Received object` means the
paths really are missing, and `Received string (unparseable as JSON)` means the
payload itself is malformed.

## Stage 9 — plan-doc write-back

**Skip entirely** when `$PLAN_DOC` is empty, when `$WRITEBACK` is `off`, or when
the document has no status notation. Otherwise, for each task the script reports
as `committed` that carried a `docKey`: set that row's status to `$WRITEBACK` and
record the branch name beside it, in the document's own notation.

`$WRITEBACK` defaults to `wip`, and **at that default never write `done`** — the
work sits on an unmerged local branch, so `done` is the human's to set on merge.
Failed and skipped tasks get no write-back.

## Final report

Build this from the script's return value:

```markdown
## Pipeline result — N tasks

| Task | Branch | Base | Status | Commit | Rounds (plan/review/gate) |
|---|---|---|---|---|---|
| Schedule pause | feature/schedule-pause | develop | ✅ committed | a1b2c3d | 1/1/1 |
| Pause UI | feature/schedule-pause-ui | feature/schedule-pause | ✅ committed | e4f5a6b | 1/2/1 |
| Budget export | feature/budget-csv-export | develop | ❌ gate red | — | 1/1/2 |

**Review these locally**
git checkout feature/schedule-pause         # review first — the UI branch sits on it
git checkout feature/schedule-pause-ui

**Chained branches:** feature/schedule-pause-ui is cut from feature/schedule-pause,
not develop. Review and merge in that order.

**Preserved for inspection:** ../.codenest-worktrees/budget-csv-export — gate red,
uncommitted. Artifacts (plan, reviews, commit message) per task under
../.codenest-worktrees/_artifacts/<slug>/.
```

Say plainly what failed and what was skipped — a partially successful run reported
as a success is worse than a failure. Call out anything that changed the schema
(`needsMigration`, `migrationStem`), the bundled org-agents (`touchesOrgAgents`),
or a dependency lockfile (`newDependencies`); those need a closer look than the
rest. Surface `finalizePartial` when teardown refused, since it names what is
still uncommitted.

Never push. Never open a pull request. Never merge or rebase onto `develop`.

## If a run dies mid-flight

The worktrees and `_artifacts/` survive — that is why they live outside the repo.
**A workflow run cannot be resumed across a process exit**: `resumeFromRunId`
keys its cache to the session's transcript directory, so a new session replays
nothing, re-runs Setup, and hard-stops on the branch the dead run already created.

That hard stop is correct. Do not weaken it and do not delete the branch to get
past it. Instead read `git -C <worktree> status` and `ls <artifacts>` to see how
far it got — `plan.md` plus a `plan-review-*.md` saying APPROVED means planning is
done — then finish that task by launching the remaining stage agents directly
(`coder-agent`, `code-reviewer`, `compiler-agent`), and commit as the script's
Finalize stage does: remove the `.venv` and `src-tauri/target` symlinks first,
then `git add -A`, then commit.
