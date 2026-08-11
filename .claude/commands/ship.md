---
description: "Autonomous delivery pipeline, two lanes. Triage routes each WorkBoard ticket: SIMPLE runs inline at 1–2 agents; COMPLEX gets an isolated worktree → plan + plan review → implement → code review → quality gate → commit. Leaves one reviewed local branch per task. No push, no PR. Usage: /ship <#id… or descriptions> [--lane simple|complex] [--dry-run] [--base <branch>] [--review]"
argument-hint: <#24 #25 … or tasks in prose> [--dry-run] [--lane simple|complex] [--base <branch>] [--review]
---

Deliver these tasks autonomously, each as its own committed local branch:

**$ARGUMENTS**

## How this runs

Two lanes, and triage decides which each task takes.

- **SIMPLE** — you run it yourself, inline, at **1 agent (2 ceiling)**. A ≤3-file
  edit-in-place change does not need a plan, a plan review and a code review
  round; it needs the gate to be green and a human to read the branch.
- **COMPLEX** — **`.claude/workflows/ship-tasks.js`**, launched through the
  Workflow tool. It owns worktree → plan → plan review → implement → code review
  → quality gate → commit → teardown for its tasks, and fans each wave out
  concurrently. **8–22 agents per task.**

You own **intake, triage, the SIMPLE lane, the report and the ledger**. The
workflow script is sandboxed — no filesystem, no git, no network — so everything
outside its stages is yours to resolve and it cannot second-guess you.

Guarantees the script enforces for COMPLEX tasks, so you need not re-check them:
every task gets its own worktree and branch and the main checkout is never
modified; a worktree is removed only after a successful commit and preserved on
any failure; `git worktree remove` is never forced; nothing is pushed, merged,
rebased or opened as a PR; and a failed task does not block its wave — only tasks
chained behind it are skipped. **The SIMPLE lane below upholds the same
guarantees; they are not the script's to give when you are the one running.**

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
BOARD="${CODENEST_BOARD_URL:-http://localhost:8002}"
MAX_PLAN_REVISIONS="${CODENEST_MAX_PLAN_REVISIONS:-2}"
MAX_REVIEW_FIXES="${CODENEST_MAX_REVIEW_FIXES:-2}"
MAX_GATE_FIXES="${CODENEST_MAX_GATE_FIXES:-2}"
```

`WT_ROOT` sits **outside** the repo on purpose — worktrees never need
gitignoring, and a preserved failure is easy to find. `.claude/pipeline.env` is
gitignored; `.claude/pipeline.env.example` documents every value.

**`--base <branch>` overrides `$BASE_BRANCH` for the whole run.** Whichever wins,
**print the resolved base as the first line of the triage block** and name it in
the report. A run silently cut from a stale base is the most expensive mistake
this command can make: every stage passes, every branch is green, and the work
sits on top of code that is weeks behind. Do not make the human infer it.

Report paths back to the user as they actually resolved, never as `$WT_ROOT`.

## 1. Resolve the tasks

Three sources, in this order.

**A WorkBoard ticket — `#24`, or a bare number.** This is the primary path.

```bash
curl -s --max-time 5 "$BOARD/api/v1/tasks/24"
```

The `description` field **is** the spec — the tickets are written for this
pipeline, with Problem / root cause / Wanted / Acceptance criteria / Ship notes.
Take `title` for the task name, `description` verbatim as `docRow`, `effort` and
`priority` as triage inputs, and the `Ship notes` section for the branch name and
any stated dependency. A ticket whose `status` is `done` is skipped, and say so.

If the sidecar does not answer, **say once that the board is unreachable and fall
back** to the prose in `$ARGUMENTS`. Do not guess at a ticket's contents from its
number, and do not silently ship a task briefed only by its id — a task with
`statement: "#24"` briefs every agent with nothing.

**A `$PLAN_DOC` row.** When `$PLAN_DOC` is set, match each remaining request to a
row using whatever status notation that document uses. Capture the row's prose as
`docRow` and its identifier as `docKey`. Skip anything already marked done and
say so. A document with no status notation is read-only reference: use its prose,
skip §8.

**Free text.** Anything matching neither is carried as prose with no doc key.
That is a normal configuration, not an error.

### Name each task

| Field | Rule |
|---|---|
| `slug` | Short kebab-case, 2–4 words, unique. `schedule-pause`, `budget-csv-export`. |
| `branch` | `<prefix><boardId>-<slug>`, e.g. `fix/18-agent-pane-view-fill`. Prefix: `$PREFIX_FEATURE` for new capability, `$PREFIX_FIX` for a bug, `$PREFIX_CHORE` for tooling/CI/docs/deps — take the kind from the ticket's own label when it has one. **The id goes in the branch on purpose:** `/commit-message` reads it back out of `git branch --show-current` to key the commit, and that is the only link between a commit and its ticket. A task with no `boardId` drops the number and uses `<prefix><slug>`. Honour a branch the ticket's `Ship notes` names, but insert the id if it is missing. |
| `base` | The resolved base, unless chained — see §3. |
| `statement` | The task in one or two sentences. **Every stage agent is briefed from this**, so a vague statement degrades the whole run. |
| `boardId` | The WorkBoard task id, when it came from there. Carried into the branch name and the commit subject. |

## 2. Triage — which lane

Decide this **here, in this turn**, while the ticket body is already in context.
It costs **zero agent invocations**: a paragraph of reasoning plus a bounded
`rg` probe. A guard that spawns an agent to decide whether to spawn agents is the
failure it exists to prevent.

Do **not** score this from board fields alone. `effort` is a human's guess made
before anyone read the code, and `priority` says how much it matters, not how
much it touches. They are inputs, not the verdict.

Three ordered filters, first match wins.

### Filter 1 — force COMPLEX by blast radius

Checked before any size test. Any hit routes COMPLEX no matter how small the
change looks, because these are the places where a one-line change is not a small
change — every one of them is a rule from `AGENTS.md` whose breakage is *silent*.
**`--lane simple` cannot override this filter.**

| Trigger | Why |
|---|---|
| `migrations/**` | Append-only and stem-recorded: applied files are never re-read, so a wrong migration cannot be fixed in place. Two parallel tasks would both claim the next number and collide on merge. |
| `src-tauri/resources/org-agents/**` | Every edit requires recomputing that file's sha256 in `manifest.json` and bumping the manifest version. Installs are per-file-hash-diffed and **revert** anything that disagrees, so a forgotten hash silently un-ships the change on next launch. |
| `frontend/src/lib/nav-items.ts` **or** `app/services/settings_service.py` | Two mirror pairs live here: `FEATURE_DEFAULTS` ↔ `_FEATURES_DEFAULT`, and `KNOWN_FEATURES_ORDERED` ↔ `KNOWN_FEATURES`. The ordered list is what drives the Settings toggles, so a slug missing from it can never be switched on — and no gate catches it. |
| Sidecar bind address or CORS allowlist (`main.py`, `app/config.py`) | Loopback-only binding is what makes the MCP manager's trust model sound — registering a server executes a local command. Widening it is a security change, never a chore. |
| A `subprocess` / spawn added under `app/` | Process spawning lives in the Rust shell, never the sidecar. Architectural, and invisible to the gate. |
| `src-tauri/capabilities/*.json` | A missing permission surfaces as a frontend bug, not a permission error — a window that will not close looks like broken JS. |
| `src-tauri/tauri.conf.json`, Cargo `[[bin]]` | `mainBinaryName` and the binary name must match, and the macOS menu deliberately omits Cmd+W because the frontend owns it. |
| `scripts/build-sidecar.sh`, `scripts/pyinstaller.spec` | Packaging. The onedir/onefile choice is worth ~15 s of every launch and only shows up in a packaged build. |
| `.claude/**` | The pipeline modifying itself. Never in a lane that skips review. |
| Board `effort: large` | Not a veto on the probe, but a large ticket that probes as ≤3 files usually means the probe missed a layer. |

**Do not route on `priority`.** A P0 one-line fix is the ideal SIMPLE task, and
routing it COMPLEX because it is urgent is exactly backwards — it spends 8–22
invocations and twenty minutes on the change that most needs to land now.

### Filter 2 — the one-sentence diff test

**Write the sentence out into the triage block.** Do not assert that one exists.
A classifier asked "is this simple?" says yes; one asked to *write the diff in
one sentence* fails visibly. If it cannot be written without hedging or an "and",
the task is not simple.

If it cannot be written **because the ticket does not say enough** — no repro, no
expected-vs-actual, no acceptance criteria — the verdict is **ASK**, not a lane.
Subagents cannot ask questions, so an unknown that survives intake becomes a
guess made 8–22 invocations deep with no way back. Bound it: **one clarification
round covering the whole run at once**, and only for unknowns that change *which
files get touched* — never for a preference the coder can reasonably pick.

### Filter 3 — the repo probe

**Hard cap: 6 read-only shell calls** (`rg`, `git log --oneline -5 --`, `ls`), no
file read over 200 lines. If the change cannot be localized in 6 calls, that is
itself a COMPLEX signal.

SIMPLE requires **all** of:

- **≤3 code files.** A component's own `.module.css` and its
  `__tests__/*.test.tsx` do not count — one logical edit to a component
  legitimately touches all three, and counting them raw would push every
  single-component fix into COMPLEX.
- **exactly one layer** — sidecar (`app/`, `main.py`), frontend (`frontend/`) or
  shell (`src-tauri/`). `AGENTS.md` already asks for one layer per PR; a
  cross-layer change is a contract change, and a contract change wants a plan.
- **edit-in-place only** — no new service, router, migration, table, React
  component, zustand store, Tauri command or IPC surface. A new type is a design
  decision, and a design decision is what plan review is for. This is also what
  makes it safe for the lane to skip the duplication audit, whose targets are the
  things a diff *adds*.
- a test obligation of **at most one new test case in an existing test file**.

### Decision table

| # | Condition | Verdict |
|---|---|---|
| 1 | Any Filter-1 trigger | **COMPLEX** (unoverridable) |
| 2 | Missing repro / expected-vs-actual / acceptance criteria | **ASK** |
| 3 | One-sentence diff not writable | **COMPLEX** |
| 4 | Probe: ≤3 code files, 1 layer, edit-in-place, ≤1 test case | **SIMPLE** |
| 5 | Probe: >3 code files, or >1 layer, or a new type | **COMPLEX** |
| 6 | Probe inconclusive within 6 calls | **COMPLEX** |
| 7 | Anything else — any tie, any "probably" | **COMPLEX** |

If a task looks like more than a day of work, print `oversized — consider
splitting` and route COMPLEX. A warning, not a refusal: the engineer running
`/ship` knows more than a rubric.

### What to print, before anything runs

```
base: prep/release/0.2.0  (--base override; pipeline.env says develop)

#18  SIMPLE   "give .panel the same grow-and-scroll flex contract .conv already has"
              1 code file + 1 module.css, frontend · est. 1 agent
#17  COMPLEX  new child-stream type on ConvToolBlock — a new type, Filter 3
              est. 8–22 agents
#29  ASK      three candidate linkage designs; which one — /ship reports back,
              app infers from git, or the user links by hand?
```

Then print the run total as `est. N–M agent invocations`. On `--dry-run`, **stop
here** — print nothing else, create nothing, and do not touch the ledger.

The verdict is **never written back to the board as a label or a status** — an
action-triggering field couples analysis to execution, and you could no longer
ask for triage without risking a run. Triage recommends; the human triggers.

`/ship` stays autonomous past this table — §4's "proceed without waiting for
approval" is unchanged. **ASK is the sole exception**, because it is the only
point in the whole system where a question can still be asked.

## 3. Group into waves

Within a wave tasks run in parallel; waves run in order. Two tasks belong in
different waves only on a **hard dependency**:

- task B consumes a service function, migration column, setting, feature toggle,
  Tauri command or API endpoint that task A introduces;
- both rewrite the body of the *same function* (merely sharing a file is not
  enough — separate worktrees make that safe);
- **both add a migration.** Migration filenames are append-only and numbered, so
  two parallel tasks would both claim the next number and collide on merge.
  Sequence them and tell the second which number is taken.

Otherwise same wave. Do not serialise out of caution; safe parallelism is the
entire point of the worktrees.

**A chained task is based on its predecessor's branch, not the resolved base** —
set its `base` to that branch and its `dependsOn` to that slug. Say so in the
final report, because it dictates review order. A ticket's `Ship notes` usually
states its dependency already; trust it, and verify the predecessor is in this
run or already merged.

**SIMPLE tasks run before every wave** (§5), so a COMPLEX task chained on a
SIMPLE one is fine: the SIMPLE branch exists by the time the workflow starts.

## 4. Preflight — two run-level aborts, one per-task drop

Once per run:

```bash
git -C "$REPO" rev-parse --verify "$BASE_BRANCH"          # abort if missing
test -d "$REPO/.venv"                                     # abort if missing
test -f "$REPO/src-tauri/resources/sidecar.tar.gz"        # build if missing
```

Then per task: `git -C "$REPO" rev-parse --verify "$BRANCH" 2>/dev/null && echo EXISTS`

- **Abort the run** if the resolved base does not exist — nothing can be based on it.
- **Abort the run** if there is no `.venv`; tell the user to create it
  (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`). Do not
  create it yourself — a wrong interpreter poisons every gate result.
- **Not an abort:** a missing `sidecar.tar.gz`. Run `bash scripts/build-sidecar.sh`
  once in `$REPO` and carry on, saying you are doing it and that it takes a few
  minutes. It is a gitignored build artifact, and without it **every** `cargo check`
  fails — `tauri-build` validates that literal bundle resource at compile time.
- **Drop that one task**, before anything starts, if `$BRANCH` already exists.
  Never clobber existing work. The other tasks continue.
- A dirty main working tree is **not** a blocker; worktrees are independent of it.

Print the wave plan — tasks, lanes, branches, bases, what runs in parallel — then
start. You are autonomous from here: do not ask for approval.

## 5. The SIMPLE lane — run these yourself, first

Run every SIMPLE task here, inline, **before** launching the workflow. They take
about two minutes each, and finishing them first means a mis-triage surfaces
before the expensive lane starts. Collect any escalations as you go and carry
them into §6.

You have `Bash`, so **you create the worktree yourself** — only the sandboxed
script needs an agent for that. That is the whole reason this lane costs one
agent instead of eight.

| # | Step | Agents |
|---|---|---|
| 1 | Bootstrap the worktree — the block below, verbatim | 0 |
| 2 | Read the ≤3 probed files and edit in place. Write the one test case if the change is business logic. | 0 |
| 3 | `compiler-agent` — **one** invocation, `mode=full` plus the conditional modes below | **1** |
| 4 | Red? One inline fix, one re-run of step 3. **Second red → escalate.** Never loop. | +1 |
| 5 | Envelope check (below). Breach → escalate. | 0 |
| 6 | Commit per `.claude/commands/commit-message.md`: `git add <explicit paths>`, never `-A`, one commit. Never push. | 0 |
| 7 | Teardown (below). Append the ledger row (§10). | 0 |

**1 agent floor, 2 ceiling.** A third would be a loop, so it escalates instead.

### Step 1 — bootstrap, identical to the script's Setup stage

```bash
mkdir -p "$WT_ROOT" "$WT_ROOT/_artifacts/<slug>"
git -C "$REPO" worktree add -b <branch> "$WT_ROOT/<slug>" <base>
ln -s "$REPO/.venv"                                "$WT_ROOT/<slug>/.venv"
ln -s "$REPO/src-tauri/target"                     "$WT_ROOT/<slug>/src-tauri/target"
ln -s "$REPO/src-tauri/resources/sidecar.tar.gz"   "$WT_ROOT/<slug>/src-tauri/resources/sidecar.tar.gz"
cd "$WT_ROOT/<slug>" && pnpm install --frozen-lockfile
git -C "$WT_ROOT/<slug>" status --porcelain    # must print EXACTLY: ?? .venv / ?? src-tauri/target
```

All three symlinks are load-bearing: `.venv` makes the Python gate runnable;
`src-tauri/target` shares the warm cargo cache (a private one means a cold
multi-minute Tauri build, and cargo's own file lock makes sharing safe);
`sidecar.tar.gz` is the gitignored bundle resource `tauri-build` validates at
compile time. `node_modules` is installed for real rather than symlinked, because
`frontend/tsconfig.app.json` puts its incremental build info inside it and a
shared one makes parallel worktrees report stale type-check results.

That final `git status --porcelain` printing anything beyond those two lines means
the bootstrap went wrong. Stop; do not edit code on a broken worktree.

### Step 3 — the gate, in one invocation

**The lane does not weaken the gate.** `AGENTS.md` states one verification gate
and this lane runs all of it — the saving here is agent invocations, not
coverage. Ask `compiler-agent` for every applicable mode in a *single* call:

- always `mode=full` → `source .venv/bin/activate && make check-all` (~80 s)
- **and** `mode=cargo-test` if the diff touched `src-tauri/src/` — `make
  check-all` does not run the Rust unit tests
- **and** `mode=smoke` if the diff touched `app/routers/`, `app/services/` or
  `main.py` — a startup exception is a runtime error no static check catches.
  Point it at a throwaway `CODENEST_DB_PATH` and `CODENEST_APP_DATA_DIR`, never
  the real ones, with `CODENEST_DISABLE_SCHEDULE_TICK=1`.

The repo root for the invocation is the worktree, not `$REPO`.

### Step 5 — the envelope check, in full

```bash
git -C "$WT_ROOT/<slug>" status --porcelain
```

Escalate — do not commit — if any of these is true:

1. More than 3 code files (excluding a touched component's own `.module.css` and
   `__tests__/`), **or** a second layer entered, **or** any Filter-1 path touched.
2. Step 3 came back red **twice**. A second red is a spec or approach problem,
   not a typo, and that is what plan review exists for.

Otherwise every path must sit under `app/`, `frontend/src/`, `src-tauri/src/` or
`tests/`, plus anything the task declared as an allowed extra. Anything else is
the human's call: stop and say so.

Measure this yourself with `git status`. **Never ask the implementer whether it
stayed in scope** — the trigger has to be observable and binary.

### Step 7 — teardown

```bash
rm "$WT_ROOT/<slug>/.venv" "$WT_ROOT/<slug>/src-tauri/target"
git -C "$WT_ROOT/<slug>" add <explicit paths>
git -C "$WT_ROOT/<slug>" commit ${SIGNOFF:+-s} -m "<message>"
git -C "$REPO" worktree remove "$WT_ROOT/<slug>"      # never --force
```

**The `rm` is first and is mandatory.** The `.venv/` and `/target/` ignore
patterns are directory-only, so those two *symlinks* are not ignored — leave them
and they land in the commit and block teardown. The `sidecar.tar.gz` symlink and
`node_modules` are properly ignored and must be left alone. The branch survives;
only the worktree goes.

### Escalation — SIMPLE → COMPLEX

Automatic, one-way, and it wastes nothing. The worktree already exists, on the
right branch, with its symlinks and `node_modules` in place. Add the task to §6's
payload with:

```js
{ …task, lane: 'complex',
  carry: { worktree: '<abs path>',
           escalatedBy: 'envelope-breach' | 'gate-red-twice',
           priorFiles: ['frontend/src/...'],
           priorFailure: '<the failing mode and errors from the last gate run>' } }
```

`carry.worktree` short-circuits the script's Setup stage — without it, Setup runs
`git worktree add -b <branch>` and hard-stops on "branch already exists", which
is correct behaviour and not something to work around by deleting the branch.
`priorFiles` and `priorFailure` reach the planner's brief so it plans the
*completion* rather than the task from scratch. Leave the uncommitted work in
place: `code-reviewer` diffs `base...HEAD` plus uncommitted changes, and Finalize
stages whatever is there.

Report it as `ESCALATED: <which tripwire>` so mis-triage is visible and the rubric
can be corrected against real cases. Cost: the 1–2 invocations already spent,
then the complex lane minus its Setup stage.

**COMPLEX → SIMPLE never happens automatically.** Oscillation between lanes is
unbounded cost. The only de-escalation is a human passing `--lane simple` after
reading the printed verdict — and Filter 1 still refuses.

## 6. Launch the workflow — COMPLEX tasks only

Skip entirely when every task triaged SIMPLE.

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
        boardId: 24,                     // when it came from the WorkBoard
        docKey: null, docRow: null,      // docRow is the ticket body, verbatim
        carry: null }                    // set only for an escalated task (§5)
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

## 7. Plan-doc write-back

**Skip entirely** when `$PLAN_DOC` is empty, when `$WRITEBACK` is `off`, or when
the document has no status notation. Otherwise, for each task reported as
`committed` that carried a `docKey`: set that row's status to `$WRITEBACK` and
record the branch name beside it, in the document's own notation.

`$WRITEBACK` defaults to `wip`, and **at that default never write `done`** — the
work sits on an unmerged local branch, so `done` is the human's to set on merge.
Failed and skipped tasks get no write-back.

**The WorkBoard is never written to either** — same reason, and the board is what
`/review` and the UI read. Tell the human which tickets are ready to move; let
them move them.

## 8. Final report

```markdown
## Pipeline result — N tasks · base prep/release/0.2.0

| Task | Lane | Branch | Base | Status | Commit | Agents | Rounds (plan/review/gate) |
|---|---|---|---|---|---|---|---|
| #18 Composer pinning | simple | fix/18-agent-pane-view-fill | prep/release/0.2.0 | ✅ committed | a1b2c3d | 1 | —/—/1 |
| #17 Frame attribution | complex | fix/17-subagent-frame-attribution | prep/release/0.2.0 | ✅ committed | e4f5a6b | 11 | 1/2/1 |
| #21 Dock rows | complex | feature/21-agent-dock-rows | fix/17-… | ❌ gate red | — | 14 | 1/1/2 |

**Review these locally**
git checkout fix/18-agent-pane-view-fill
git checkout fix/17-subagent-frame-attribution     # review before #21, which sits on it

**Escalated:** none.
**Preserved for inspection:** ../.codenest-worktrees/agent-dock-rows — gate red,
uncommitted. Artifacts per task under ../.codenest-worktrees/_artifacts/<slug>/.
```

Say plainly what failed and what was skipped — a partially successful run reported
as a success is worse than a failure. Call out anything that changed the schema
(`needsMigration`, `migrationStem`), the bundled org-agents (`touchesOrgAgents`),
or a dependency lockfile (`newDependencies`); those need a closer look than the
rest. Surface `finalizePartial` when teardown refused, since it names what is
still uncommitted. Name every escalation and its tripwire.

Never push. Never open a pull request. Never merge or rebase onto the base.

## 9. Ledger

One line per task, appended **after** the report is printed. Gitignored, and
wrapped so a failed write can never fail a run.

```bash
printf '%s\n' "$ROW" >> "$REPO/.claude/ship-runs.jsonl" 2>/dev/null || true
```

```json
{"board":18,"lane":"simple","predictedFiles":2,"actualFiles":2,
 "escalated":false,"escalatedBy":null,"invocations":1,
 "rounds":{"plan":null,"review":null,"gate":1},"outcome":"committed"}
```

Then read the tail of that file and print **one** rolling line:

```
last 20: 6 simple (1 escalated), 14 complex; mean 9.4 agents; 3 branches amended by hand
```

The point is calibration, in both directions. Escalations over ~15 % of simple
tasks means the envelope is too generous. COMPLEX tasks whose actual diff would
have fitted the simple envelope — compare `actualFiles` against the rubric — over
~25 % means the gate is too cautious, and **that is the failure nobody notices**,
because an over-cautious gate degrades into single-lane behaviour and never
generates a complaint.

**Do not tune on one surprising run.** Run-to-run variance on the same task is
large. Ship the thresholds as written and change nothing until the ledger holds
~20 rows.

## Never resume. Finish by hand.

**`resumeFromRunId` is not a retry mechanism, and there is no case in this
pipeline where you should reach for it.** Whatever went wrong — the process
exited, or the run completed with some tasks failed — the recovery is the same
and it is manual. This section is the whole of it.

Why resume does not work here, in both directions:

- **Across a process exit**, the cache keys to the session's transcript
  directory, so a new session replays nothing.
- **Within the same session, on a run that already finished**, the cache does
  not reliably hit either. Setup re-runs, hard-stops on the branches the first
  run created, and the tasks you wanted retried never start — while tasks that
  already committed can re-run and *commit a second time*, leaving two commits
  with the same subject doing one job.

That hard stop on an existing branch is correct behaviour. Do not weaken it, do
not delete the branch to get past it, and do not rename the branch to dodge it.

### The recovery

Read the state first — `git -C <worktree> status` and `ls <artifacts>`. Then:

| What you find | What it means |
|---|---|
| No `plan.md` | Planning never finished. Start from `planner-agent`. |
| `plan.md` + a `plan-review-*.md` saying APPROVED | Planning is done. Do not regenerate the plan — it is the artifact the work was reviewed against. |
| Worktree full of changes, no commit | Implementation got some distance. **Verify and finish it; do not re-implement it.** |

Then drive the remaining stages directly — `coder-agent`, `code-reviewer`,
`compiler-agent` — and commit as Finalize does: remove the `.venv` and
`src-tauri/target` symlinks first, then `git add`, then commit.

Two things that are easy to get wrong here:

- **Brief the finisher that the work is mostly done.** A `coder-agent` pointed at
  a full worktree with a bare "implement the plan" will rewrite working code.
  Tell it to walk the plan item by item, verify what exists, finish only what is
  missing, and explicitly not improve what already satisfies the plan.
- **A stage agent can go idle without reporting.** Silence is not success. Ask it
  for the result explicitly, give it permission to say it did not finish, and
  never commit on an assumed green gate — re-run `make check-all` yourself, in a
  separate `compiler-agent`, as one invocation.

## Failure modes that are not code failures

Check `reason` before concluding a task failed on its merits.

- **Account or session limit.** The coder was killed mid-write; nothing is wrong
  with the plan or the code. The worktree usually holds near-complete work. Wait
  for the reset, then verify-and-finish as above.
- **Branch already exists / worktree missing.** An orchestration state mismatch,
  almost always the wreckage of an attempted resume, or an escalated task whose
  `carry.worktree` was dropped from the payload. Never clobber; recover by hand.
- **A truncated write can corrupt a file invisibly.** A coder killed mid-write
  can leave stray bytes in source — a NUL inside a string literal survives
  `tsc`, `eslint` and the tests without complaint. After finishing an
  interrupted task, scan its files for NUL bytes before committing, and scan the
  sibling branches the same run produced.

## Sizing a run

A COMPLEX task costs roughly six to eight agent invocations across its stages;
a SIMPLE one costs one, or two if it needs a fix round. The whole run shares one
account budget. **Five COMPLEX `L`-sized tasks is at the practical ceiling** —
that is where this pipeline first hit a session limit mid-implement. SIMPLE tasks
barely count against it, which is the point: a run of eight SIMPLE tasks costs
less than one COMPLEX one.

Prefer more waves of smaller tasks over one wide wave of large ones. A task that
spans a new Rust subsystem *and* a full UI surface should usually be two tasks
with the second chained on the first: each gets its own plan, its own review and
its own gate, and a failure costs one stage rather than the lot.
