export const meta = {
  name: 'ship-tasks',
  description: 'Deliver N Codenest tasks as reviewed, gated, committed local branches — one isolated worktree each, removed on success',
  whenToUse: 'The engine behind /ship — the only way this pipeline runs. Tasks must already be resolved into waves by Stage 0, which lives in .claude/commands/ship.md.',
  phases: [
    { title: 'Setup', detail: 'worktree off base, shared-cache symlinks, pnpm install' },
    { title: 'Plan', detail: 'planner-agent, then plan-reviewer until APPROVED (max 2 revisions)' },
    { title: 'Implement', detail: 'coder-agent executes the approved plan' },
    { title: 'Review', detail: 'code-reviewer, then coder-agent fixes blockers (max 2 rounds)' },
    { title: 'Gate', detail: 'compiler-agent full (+ cargo-test / smoke), fixes until green (max 2 rounds)' },
    { title: 'Finalize', detail: 'drop symlinks, commit, remove worktree, branch survives' },
  ],
}

/* Stage 0 (intake, wave planning, plan-doc resolution) and Stage 9 (plan-doc
   write-back) are NOT here — they belong to the caller, /ship, because a workflow
   script has no filesystem access. See .claude/commands/ship.md. This script
   starts at an already-resolved task list and ends at committed branches. */

/* The Workflow tool sometimes flattens `args` to a JSON string before the
   script sees it, in which case `args.repo` is undefined on a string primitive
   and the guard below rejects a run whose arguments were in fact perfectly
   correct. Parsing that back is not guessing — it is the same payload in a
   different wrapper — so accept it rather than making the caller wrap this
   script just to hand it an object. A bound local, not a reassignment: `args`
   is runtime-provided and may not be writable. */
const input = typeof args === 'string' ? tryParse(args) : args

function tryParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null // fall through to the guard, which reports it properly
  }
}

/* A workflow script has no filesystem access: it cannot read
   .claude/pipeline.env and cannot derive the repo root from git. The caller
   resolves both in the constants block of .claude/commands/ship.md and
   passes them in. Fail loudly rather than guess — a default here would bake
   somebody's home directory into a public repository. */
if (!input || !input.repo || !input.wtRoot) {
  throw new Error(
    'ship-tasks: args.repo and args.wtRoot are required absolute paths, resolved by the caller. ' +
      `Received ${typeof args}${typeof args === 'string' ? ' (unparseable as JSON)' : ''}. ` +
      'See the args contract in .claude/commands/ship.md.',
  )
}

const REPO = input.repo
const WT_ROOT = input.wtRoot
const TASKS = input.tasks || []

if (TASKS.length === 0) throw new Error('ship-tasks: args.tasks is empty — nothing to deliver.')

const LIMITS = input.limits || {}
const MAX_PLAN_REVISIONS = LIMITS.planRevisions ?? 2
const MAX_REVIEW_FIXES = LIMITS.reviewFixes ?? 2
const MAX_GATE_FIXES = LIMITS.gateFixes ?? 2
/* CONTRIBUTING.md requires a DCO sign-off on every commit; opt out with signoff:false. */
const SIGNOFF = input.signoff !== false

const RULES = `
Codenest — the rules that matter, all binding (AGENTS.md is the authority):
- Layering: app/routers/ parse and delegate; ALL business logic and SQL lives in app/services/;
  app/models/ holds Pydantic shapes. A query in a router is architecture drift.
- Migrations are append-only, applied in filename order and recorded by filename STEM; content is
  never re-checked. Never edit a shipped migration, never rename 000_baseline_schema.sql, never
  reuse the stems 000_baseline_schema / 001_agent_sessions_pane_id / 001_workflow_labels /
  002_schedule_artifact_dir. New files start at 003_ — check migrations/ for the highest in use.
- A freshly migrated DB ships EMPTY apart from functional reference data (settings defaults,
  taxonomies, catalog). Only the providers table is test-enforced
  (test_migrations.py::test_clean_slate_zero_providers), so a seeded person or project would pass
  the gate green — the rule binds anyway. Demo data enters only via 'make seed-demo'.
- Process spawning lives in the Rust shell, never the sidecar. The sidecar owns state and queues;
  src-tauri/ owns child processes; they are bridged by poll-dispatch. No subprocess in app/.
- The sidecar binds 127.0.0.1 only and is deliberately unauthenticated. Never widen the bind
  address or the CORS allowlist (localhost:1420, 127.0.0.1:1420, tauri://localhost) — the MCP
  trust model, where registering a server executes a local command, rests on that.
- Parameterized SQL only. A dynamic column goes through app/services/_sql.py build_update's
  allowlist; a LIKE goes through escape_like AND the literal ESCAPE '\\' clause.
- A gated feature is a FOUR-WAY mirror, all in one change: _FEATURES_DEFAULT <-> FEATURE_DEFAULTS,
  KNOWN_FEATURES <-> KNOWN_FEATURES_ORDERED (settings_service.py <-> lib/nav-items.ts), plus the
  FEATURES nav-slug map in nav-items.ts and the enabled_features seed row in
  migrations/000_baseline_schema.sql. KNOWN_FEATURES_ORDERED drives the Settings toggle list, so
  omitting it ships a feature that cannot be switched on.
- Any src-tauri/resources/org-agents/*.md must move with its sha256 in that dir's manifest.json
  plus a bumped manifest version.
- Datetimes are naive on purpose: row timestamps are SQLite CURRENT_TIMESTAMP (naive UTC), the
  scheduler compares naive LOCAL wall-clock (schedule_service._now, task_service date.today()),
  each with a # noqa: DTZ0xx. A tz-aware datetime in either path breaks comparisons silently.
- Frontend: every sidecar fetch through fetchSidecar in lib/api.ts, every Tauri call through
  lib/ipc.ts. Strict TS with noUncheckedIndexedAccess, noUnusedLocals/Parameters,
  verbatimModuleSyntax, erasableSyntaxOnly. clippy warnings are errors in the Rust shell.
- The gate is 'make check-all': cargo check + clippy -D warnings, ruff format --check . +
  ruff check . + mypy app/, both pytest suites, tsc -b + eslint, vitest, prod frontend build.
`

const wtOf = t => `${WT_ROOT}/${t.slug}`
const artOf = t => `${WT_ROOT}/_artifacts/${t.slug}`

/* Every agent works inside its task's worktree, never in the main checkout. */
const envFor = t => `
REPO (main checkout — DO NOT EDIT ANYTHING HERE): ${REPO}
WORKTREE (your repo root for this task, all paths absolute under it): ${wtOf(t)}
ARTIFACTS (plan, reviews, commit message): ${artOf(t)}
BRANCH: ${t.branch}   BASE: ${t.base}

Run every shell command from ${wtOf(t)}. Inside it, .venv, src-tauri/target and
src-tauri/resources/sidecar.tar.gz are SYMLINKS into the main checkout — that is expected
and correct. Never delete them (except where the Finalize stage explicitly does) and never
report one as an environment failure.
Never create a branch or worktree. Never push, never open a PR, never merge or rebase.
`

const pass = (prev, extra) => Object.assign({}, prev, extra)
const failed = p => p && p.failed

const SETUP_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    head: { type: 'string', description: 'branch name HEAD resolves to in the new worktree' },
    error: { type: 'string' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['plan_path', 'summary'],
  properties: {
    plan_path: { type: 'string' },
    summary: { type: 'string' },
    layers: { type: 'array', items: { type: 'string' } },
    files_touched: { type: 'array', items: { type: 'string' } },
    needs_migration: { type: 'boolean' },
    migration_stem: { type: 'string' },
    touches_org_agents: { type: 'boolean' },
    new_dependencies: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
}

const PLAN_REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'REVISE'] },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        required: ['where', 'gap', 'fix'],
        properties: { where: { type: 'string' }, gap: { type: 'string' }, fix: { type: 'string' } },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    round: { type: 'integer' },
    verified: { type: 'array', items: { type: 'string' } },
    closed_from_last_round: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    diverged_from_plan: { type: 'boolean' },
    divergence_reason: { type: 'string' },
    error: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['Approve', 'Request changes', 'Needs discussion'] },
    blockers: {
      type: 'array',
      description: 'Only 🔴 BLOCKER findings, plus 🟡 that name a missing test or a layering violation',
      items: {
        type: 'object',
        required: ['id', 'where', 'what', 'fix'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          where: { type: 'string' },
          what: { type: 'string' },
          reachability: { type: 'string', description: 'entry point -> call site -> the state that reaches it' },
          fix: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  required: ['overall', 'summary'],
  properties: {
    overall: { type: 'string', enum: ['pass', 'fail'] },
    failing_stage: { type: 'string' },
    errors: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const FINAL_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    commit: { type: 'string', description: 'short sha' },
    commit_subject: { type: 'string' },
    worktree_removed: { type: 'boolean' },
    branch_head: { type: 'string' },
    error: { type: 'string' },
  },
}

/* ---- Stage 1: worktree ------------------------------------------------- */

async function setup(_prev, t) {
  /* A task escalated out of /ship's SIMPLE lane arrives with its worktree
     already created — right branch, symlinks in place, node_modules installed,
     and usually uncommitted work in it. Re-running the bootstrap would call
     `git worktree add -b <branch>` and correctly hard-stop on "branch already
     exists", failing a task whose only problem was being mis-triaged.
     Short-circuiting costs one agent invocation less and keeps that hard stop
     intact for every other caller: the only way past it is a carry the command
     layer has to set deliberately. */
  if (t.carry && t.carry.worktree) {
    log(`setup:${t.slug} — reusing escalated worktree (${t.carry.escalatedBy || 'escalated'})`)
    return { task: t, setup: { ok: true, head: t.branch, reused: true } }
  }

  const r = await agent(
    `Create and bootstrap the isolated worktree for one Codenest task. Shell work only — write no code.

${envFor(t)}

Run exactly this, and report what happened:

    mkdir -p ${WT_ROOT} ${artOf(t)}
    git -C ${REPO} rev-parse --verify ${t.base}
    git -C ${REPO} worktree add -b ${t.branch} ${wtOf(t)} ${t.base}
    ln -s ${REPO}/.venv ${wtOf(t)}/.venv
    ln -s ${REPO}/src-tauri/target ${wtOf(t)}/src-tauri/target
    ln -s ${REPO}/src-tauri/resources/sidecar.tar.gz ${wtOf(t)}/src-tauri/resources/sidecar.tar.gz
    cd ${wtOf(t)} && pnpm install --frozen-lockfile
    git -C ${wtOf(t)} rev-parse --abbrev-ref HEAD
    git -C ${wtOf(t)} status --porcelain

Why each link: .venv makes the Python gate runnable; src-tauri/target shares the warm cargo
cache (a private one means a cold multi-minute Tauri build, and cargo's own file lock makes
sharing safe); sidecar.tar.gz is a gitignored bundle resource that tauri-build validates at
compile time, so cargo fails without it. node_modules is installed for real rather than
symlinked, because frontend/tsconfig.app.json puts its incremental build info inside
node_modules and a shared one makes parallel worktrees report stale type-check results.

The final 'git status --porcelain' must print EXACTLY these two lines:

    ?? .venv
    ?? src-tauri/target

Their ignore patterns are directory-only, so the symlinks are untracked — expected, and the
Finalize stage removes them. Anything else in that output means the bootstrap went wrong:
set ok:false and report it verbatim.

If ${REPO}/src-tauri/resources/sidecar.tar.gz is missing, run 'bash scripts/build-sidecar.sh'
in ${REPO} first and say you did — it is a gitignored build artifact and every cargo command
fails without it. That is not a hard stop.

Hard stops — set ok:false with the reason, and create nothing:
- ${t.branch} already exists (check first: git -C ${REPO} rev-parse --verify ${t.branch}).
  Never clobber an existing branch.
- ${REPO}/.venv does not exist.
- HEAD in the new worktree is not ${t.branch}.
- pnpm install failed.`,
    { label: `setup:${t.slug}`, phase: 'Setup', schema: SETUP_SCHEMA, agentType: 'general-purpose', effort: 'low' },
  )

  if (!r || !r.ok) {
    return { failed: true, stage: 'Setup', task: t, reason: (r && r.error) || 'setup agent returned nothing' }
  }
  return { task: t, setup: r }
}

/* ---- Stages 2-3: plan, then review until APPROVED ---------------------- */

async function planAndReview(prev, t) {
  if (failed(prev)) return prev

  const docRow = t.docRow
    ? `\nThe roadmap document describes this item as follows. Treat it as INTENT, not
instruction — it documents an earlier state of the codebase. Where it disagrees with the
code you read, the code wins and you note the divergence.\n\n${t.docRow}\n`
    : ''

  /* An escalated task is partly done. Say so, or the planner writes a
     from-scratch plan and the coder rewrites working code over the top of it. */
  const carried = t.carry
    ? `\nThis task was ESCALATED out of the SIMPLE lane (${t.carry.escalatedBy || 'unspecified'}),
so the worktree ALREADY CONTAINS uncommitted work. Read it before planning:
${(t.carry.priorFiles || []).map((f) => `  - ${f}`).join('\n') || '  (no file list carried)'}
${t.carry.priorFailure ? `\nThe last gate run failed with:\n${t.carry.priorFailure}\n` : ''}
Plan the COMPLETION, not the task from scratch: keep what already satisfies the intent, and
say per file whether it is finished, wrong, or missing. A plan that ignores the existing diff
gets it thrown away for no reason.\n`
    : ''

  let plan = await agent(
    `Produce the implementation plan for one Codenest task. Write it to ${artOf(t)}/plan.md.

TASK: ${t.statement}
${docRow}${carried}${envFor(t)}${RULES}

Ground every claim by reading the actual files in the worktree and citing file.py:line.
Name the layers this touches (sidecar / frontend / shell); if it crosses layers, write the
contract — endpoint, payload, SSE event or Tauri command — as its own numbered step.
Do not edit source, tests or migrations — your only write is the plan file.`,
    { label: `plan:${t.slug}`, phase: 'Plan', schema: PLAN_SCHEMA, agentType: 'planner-agent' },
  )

  if (!plan) return { failed: true, stage: 'Plan', task: t, reason: 'planner returned nothing' }

  let review = null
  for (let round = 1; round <= MAX_PLAN_REVISIONS + 1; round++) {
    review = await agent(
      `Review this implementation plan before any code is written.

TASK it must satisfy: ${t.statement}
PLAN_PATH: ${artOf(t)}/plan.md
ROUND: ${round}
${envFor(t)}${RULES}

Verify the plan against the code in the worktree — resolve every file.py:line citation and
rg for the callers of everything it changes, including the consumers on the other side of a
layer boundary (frontend/src/lib/api.ts for sidecar shapes, lib/ipc.ts for Tauri commands).
Blocking means "executing this produces wrong code, broken code, or code that fails the
gate"; everything else is a note and must not hold the plan up. Write your verdict to
${artOf(t)}/plan-review-${round}.md.
${round > 1 ? 'This is a re-review: state which previously blocking gaps are now closed, and open no new nitpicks — converge.' : ''}`,
      { label: `plan-review:${t.slug}:r${round}`, phase: 'Plan', schema: PLAN_REVIEW_SCHEMA, agentType: 'plan-reviewer' },
    )

    if (!review) return { failed: true, stage: 'Plan review', task: t, reason: 'plan-reviewer returned nothing' }
    if (review.verdict === 'APPROVED') return { task: t, setup: prev.setup, plan, planRounds: round }
    if (round > MAX_PLAN_REVISIONS) break

    const gaps = (review.blocking || [])
      .map((b, i) => `${i + 1}. [${b.where}] ${b.gap}\n   -> ${b.fix}`)
      .join('\n')
    log(`${t.slug}: plan revision ${round} — ${(review.blocking || []).length} blocking gap(s)`)

    plan = await agent(
      `Revise your implementation plan at ${artOf(t)}/plan.md in place.

TASK: ${t.statement}
${envFor(t)}
REVISION — address every blocking gap below. If you believe one is not a real gap, say so in a
short "## Reviewer disagreements" section with your reasoning; never silently ignore it. Keep
what was already sound — do not start over.

${gaps}`,
      { label: `replan:${t.slug}:r${round}`, phase: 'Plan', schema: PLAN_SCHEMA, agentType: 'planner-agent' },
    )
    if (!plan) return { failed: true, stage: 'Plan revision', task: t, reason: 'planner returned nothing on revision' }
  }

  /* Never implement a plan known to be broken — that is what this stage is for. */
  return {
    failed: true,
    stage: 'Plan review',
    task: t,
    reason: `plan still REVISE after ${MAX_PLAN_REVISIONS} revisions: ${review.summary}`,
    blocking: review.blocking,
  }
}

/* ---- Stage 4: implement ------------------------------------------------ */

async function implement(prev, t) {
  if (failed(prev)) return prev

  const r = await agent(
    `Implement one Codenest task by executing an approved plan.

PLAN (read it first, it is the spec): ${artOf(t)}/plan.md
TASK: ${t.statement}
${envFor(t)}${RULES}

Rules for this stage:
- Every path you touch is absolute under ${wtOf(t)}. Never edit anything under ${REPO}.
- Do NOT commit, and do not stage anything. A later stage owns the commit.
- Run 'ruff format' on the Python files you touched — formatting is gated, and a gate round
  spent on it is waste. NEVER run 'ruff format .' or 'pnpm format' repo-wide.
- Do not delete ${wtOf(t)}/.venv, ${wtOf(t)}/src-tauri/target, or the sidecar.tar.gz symlink.
- Write the tests the plan commits to. A fix ships with a test.
- Discharge the obligations the plan flagged: claim the migration number it named, re-hash the
  org-agent manifest and bump its version if you touched a bundled agent, mirror a feature
  default on both sides, update the lockfile for a new dependency.
- If the plan turns out to be wrong once the code is in front of you, diverge deliberately and
  report it in diverged_from_plan / divergence_reason. A silent divergence is a defect.`,
    { label: `implement:${t.slug}`, phase: 'Implement', schema: IMPL_SCHEMA, agentType: 'coder-agent' },
  )

  if (!r || !r.ok) {
    return { failed: true, stage: 'Implement', task: t, reason: (r && (r.error || r.summary)) || 'coder-agent returned nothing' }
  }
  return pass(prev, { impl: r })
}

/* ---- Stage 5: review, then fix blockers -------------------------------- */

async function reviewAndFix(prev, t) {
  if (failed(prev)) return prev

  let review = null
  for (let round = 1; round <= MAX_REVIEW_FIXES + 1; round++) {
    review = await agent(
      `Review the change on this branch: everything in 'git -C ${wtOf(t)} diff ${t.base}...HEAD'
plus everything still uncommitted.

TASK the change implements: ${t.statement}
PLAN it was built from: ${artOf(t)}/plan.md
ROUND: ${round}
${envFor(t)}${RULES}

Report findings by severity as you normally do (🔴 BLOCKER / 🟡 SUGGESTION / 🟢 NIT) and write
the full review to ${artOf(t)}/review-${round}.md.

In the structured payload, put in 'blockers' ONLY: every 🔴, plus any 🟡 that names a missing
test or a layering violation. Leave 🟢 out entirely — style does not hold up this pipeline.
Check these explicitly; they are this repo's most likely silent defects: an edited or
number-colliding migration, a mirror updated on only one side (feature defaults, org-agent
manifest sha256), a subprocess spawned from the sidecar, and a tz-aware datetime introduced
into a naive comparison path.`,
      { label: `review:${t.slug}:r${round}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'code-reviewer' },
    )

    if (!review) return { failed: true, stage: 'Code review', task: t, reason: 'code-reviewer returned nothing' }

    const blockers = review.blockers || []
    if (blockers.length === 0 && review.verdict !== 'Request changes') {
      return pass(prev, { review, reviewRounds: round })
    }
    if (round > MAX_REVIEW_FIXES) break

    log(`${t.slug}: review fix round ${round} — ${blockers.length} blocker(s)`)
    const list = blockers
      .map(b => `${b.id} [${b.severity || 'BLOCKER'}] ${b.where} — ${b.what}${b.reachability ? `\n   reachable via: ${b.reachability}` : ''}\n   fix: ${b.fix}`)
      .join('\n')

    const fix = await agent(
      `Fix the review findings on this branch. Do not refactor beyond them.

${envFor(t)}${RULES}

${list}

Fix each one. If a finding is wrong, say so in divergence_reason instead of changing code you
believe is correct. Do not commit. Do not run a repo-wide formatter.`,
      { label: `review-fix:${t.slug}:r${round}`, phase: 'Review', schema: IMPL_SCHEMA, agentType: 'coder-agent' },
    )
    if (!fix || !fix.ok) {
      return { failed: true, stage: 'Review fix', task: t, reason: (fix && (fix.error || fix.summary)) || 'coder-agent returned nothing' }
    }
  }

  /* Never commit over a known blocker. */
  return {
    failed: true,
    stage: 'Code review',
    task: t,
    reason: `blockers still open after ${MAX_REVIEW_FIXES} fix rounds`,
    blocking: review.blockers,
  }
}

/* ---- Stage 6: gate, then fix until green ------------------------------- */

async function gate(prev, t) {
  if (failed(prev)) return prev

  const touched = ((prev.impl && prev.impl.files_changed) || []).join(' ')
  /* Two modes make-check-all does not cover. Rust unit tests aren't in the gate at all;
     smoke is the only thing that proves the sidecar still boots and migrates. */
  const needsCargoTest = /src-tauri\/src\//.test(touched)
  const needsSmoke = /app\/routers\/|app\/services\/|main\.py|migrations\//.test(touched)
  const extra = [needsCargoTest ? 'mode=cargo-test' : null, needsSmoke ? 'mode=smoke' : null]
    .filter(Boolean)
    .join(', then ')

  let result = null
  for (let round = 1; round <= MAX_GATE_FIXES + 1; round++) {
    result = await agent(
      `Validate this Codenest change. mode=full${extra ? `, then ${extra}` : ''}.

${envFor(t)}

The repo root for this run is ${wtOf(t)} — run 'source .venv/bin/activate && make check-all'
from there, NOT from ${REPO}.
${needsCargoTest ? 'This change touched src-tauri/src/, so also run mode=cargo-test — make check-all does not run the Rust unit tests.\n' : ''}${needsSmoke ? 'This change touched routers, services, main.py or migrations, so also run mode=smoke — a failed migration or a startup exception is a runtime error the other stages will not catch. Set CODENEST_DB_PATH and CODENEST_APP_DATA_DIR to the throwaway temp dir, never the real ones, and CODENEST_DISABLE_SCHEDULE_TICK=1.\n' : ''}
Report results only. Never edit source, never run a formatter or 'ruff check --fix'.`,
      { label: `gate:${t.slug}:r${round}`, phase: 'Gate', schema: GATE_SCHEMA, agentType: 'compiler-agent' },
    )

    if (!result) return { failed: true, stage: 'Gate', task: t, reason: 'compiler-agent returned nothing' }
    if (result.overall === 'pass') return pass(prev, { gate: result, gateRounds: round })
    if (round > MAX_GATE_FIXES) break

    log(`${t.slug}: gate fix round ${round} — ${result.failing_stage} failed`)
    const fix = await agent(
      `The quality gate is red on this branch. Make it green.

${envFor(t)}${RULES}

Failing stage: ${result.failing_stage}
${(result.errors || []).join('\n')}

Fix the cause, not the symptom — never weaken a test, relax a clippy lint, add a blanket
type: ignore, or loosen the migration assertions to silence the gate. You may run individual
targets ('make check-python', 'make check-frontend', 'cd src-tauri && cargo check') from
${wtOf(t)} to check your work. Do not commit.`,
      { label: `gate-fix:${t.slug}:r${round}`, phase: 'Gate', schema: IMPL_SCHEMA, agentType: 'coder-agent' },
    )
    if (!fix || !fix.ok) {
      return { failed: true, stage: 'Gate fix', task: t, reason: (fix && (fix.error || fix.summary)) || 'coder-agent returned nothing' }
    }
  }

  /* There is no "commit anyway". */
  return {
    failed: true,
    stage: 'Gate',
    task: t,
    reason: `gate still red after ${MAX_GATE_FIXES} fix rounds: ${result.failing_stage} — ${result.summary}`,
  }
}

/* ---- Stages 7-8: commit, then remove the worktree --------------------- */

async function finalize(prev, t) {
  if (failed(prev)) return prev

  const r = await agent(
    `Commit this finished task and remove its worktree. The branch must survive.

${envFor(t)}

STEP 1 — write the commit message to ${artOf(t)}/commit-msg.txt.

FIRST, read ${wtOf(t)}/.claude/commands/commit-message.md in full. That file is this
repo's commit-message specification and the only authority on style — do not work from
your own idea of a good commit message, and do not work from a summary of that file.
Follow it exactly: its layer table, its subject rule, its body rule, its list of things
to call out that carry consequences beyond the diff, and its output rules.

Match its worked examples for LENGTH, not just for shape. They run three to six lines of
body. A commit message is not a design document: the plan, the reviews and the gate
results are already archived under ${artOf(t)} for anyone who wants the full account.
Prefer the one or two decisions a reader in six months could not reconstruct from the
diff over a complete narration of the change.

Two deltas from that file, which describes the interactive command rather than this stage:
- Write the message to ${artOf(t)}/commit-msg.txt instead of printing it.
- It says committing is the user's call; /ship is the exception it names, and STEP 2
  below is that commit stage.

Base the message on 'git -C ${wtOf(t)} diff ${t.base}...HEAD' plus the uncommitted work,
and on ${artOf(t)}/plan.md for the why.

STEP 2 — commit, in this exact order. The order matters:

    rm ${wtOf(t)}/.venv ${wtOf(t)}/src-tauri/target
    git -C ${wtOf(t)} status --porcelain
    git -C ${wtOf(t)} add -A
    git -C ${wtOf(t)} commit ${SIGNOFF ? '-s ' : ''}-F ${artOf(t)}/commit-msg.txt
    git -C ${wtOf(t)} status --porcelain

The 'rm' is FIRST and is mandatory: the '.venv/' and '/target/' ignore patterns are
directory-only, so those two symlinks are NOT ignored — leave them and they land in the
commit and block teardown. The sidecar.tar.gz symlink and node_modules ARE properly ignored;
leave them alone. Before 'add -A', check the status output really is only this task's work.
The final status must be empty. ${SIGNOFF ? "The '-s' adds the Signed-off-by (DCO) trailer CONTRIBUTING.md requires. " : ''}One commit unless the diff holds genuinely separate
concerns.

STEP 3 — teardown:

    git -C ${REPO} worktree remove ${wtOf(t)}
    git -C ${REPO} worktree prune
    git -C ${REPO} log --oneline -1 ${t.branch}

NEVER pass --force to 'worktree remove'. If it refuses with "contains modified or untracked
files", something is still uncommitted: stop, leave the worktree in place, and return ok:false
with what 'git status' shows. Forcing it would delete work.

Do not push. Do not open a pull request. Do not merge or rebase. Do not touch ${artOf(t)} —
those artifacts are the audit trail for the human review.`,
    { label: `finalize:${t.slug}`, phase: 'Finalize', schema: FINAL_SCHEMA, agentType: 'general-purpose' },
  )

  if (!r || !r.ok) {
    return { failed: true, stage: 'Finalize', task: t, reason: (r && r.error) || 'finalize agent returned nothing', partial: r }
  }
  return pass(prev, { final: r })
}

/* ---- Drive the waves --------------------------------------------------- */

const waveNumbers = [...new Set(TASKS.map(t => t.wave || 1))].sort((a, b) => a - b)
const results = []
const okSlugs = new Set()

for (const w of waveNumbers) {
  const all = TASKS.filter(t => (t.wave || 1) === w)

  /* A chained task is based on its predecessor's BRANCH. If that predecessor never
     committed, the base is not usable — skip rather than build on sand. */
  const runnable = []
  for (const t of all) {
    const dep = t.dependsOn
    if (dep && !okSlugs.has(dep)) {
      log(`wave ${w}: skipping ${t.slug} — predecessor ${dep} did not complete`)
      results.push({ failed: true, skipped: true, stage: 'Blocked', task: t, reason: `predecessor ${dep} did not complete` })
    } else {
      runnable.push(t)
    }
  }
  if (runnable.length === 0) continue

  log(`wave ${w}: ${runnable.length} task(s) in parallel — ${runnable.map(t => t.branch).join(', ')}`)

  const waveResults = await pipeline(runnable, setup, planAndReview, implement, reviewAndFix, gate, finalize)

  waveResults.forEach((r, i) => {
    const t = runnable[i]
    if (r && !r.failed) okSlugs.add(t.slug)
    results.push(r || { failed: true, stage: 'Unknown', task: t, reason: 'pipeline returned nothing for this task' })
  })
}

/* Report shape the caller turns into the final table, and drives Stage 9 from:
   only 'committed' tasks get a plan-doc write-back, and never to 'done'. */
return {
  tasks: results.map(r => {
    const t = r.task || {}
    return {
      slug: t.slug,
      title: t.title,
      branch: t.branch,
      base: t.base,
      docKey: t.docKey || null,
      chainedOn: t.dependsOn || null,
      status: r.failed ? (r.skipped ? 'skipped' : 'failed') : 'committed',
      failedStage: r.failed ? r.stage : null,
      reason: r.failed ? r.reason : null,
      blocking: r.blocking || null,
      commit: r.final ? r.final.commit : null,
      commitSubject: r.final ? r.final.commit_subject : null,
      worktreeRemoved: r.final ? r.final.worktree_removed === true : false,
      worktreePreserved: r.failed && !r.skipped ? wtOf(t) : null,
      /* Teardown refused => the commit landed but the worktree is dirty. The protocol
         promises to report what is still uncommitted, so don't drop it. */
      finalizePartial: r.stage === 'Finalize' ? r.partial || null : null,
      artifacts: t.slug ? artOf(t) : null,
      rounds: { plan: r.planRounds || null, review: r.reviewRounds || null, gate: r.gateRounds || null },
      planSummary: r.plan ? r.plan.summary : null,
      layers: r.plan ? r.plan.layers || [] : [],
      newDependencies: r.plan ? r.plan.new_dependencies || [] : [],
      needsMigration: r.plan ? r.plan.needs_migration === true : false,
      migrationStem: r.plan ? r.plan.migration_stem || null : null,
      touchesOrgAgents: r.plan ? r.plan.touches_org_agents === true : false,
    }
  }),
  committed: results.filter(r => !r.failed).length,
  failed: results.filter(r => r.failed && !r.skipped).length,
  skipped: results.filter(r => r.skipped).length,
}
