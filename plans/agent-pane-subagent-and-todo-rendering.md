# Agent pane: subagent activity and the todo checklist — feasibility and design

Written 2026-08-08. Wire evidence captured against Claude Code 2.1.226 and
2.1.220; class-(ii) binary evidence independently re-verified against the
locally installed 2.1.226 build on 2026-08-08 while writing this document.

This is a research/feasibility document, not an implementation plan: no
application source file changes anywhere in this repo. It answers three
things the originating ticket asked for — a `TodoWrite` checklist renderer, a
`Task`/`Agent` subagent card renderer, and the central question of whether
nested subagent activity is recoverable client-side at all — against what the
`claude` CLI actually emits today, not against the ticket's assumptions about
what it emits.

**Why `plans/` and not `docs/`.** `git ls-files` shows `plans/` holds exactly
one file, `plans/one-workspace-scaling.md`, and it is an internal design
document (strands → tickets, `file.py:line` citations, no external audience).
`docs/` holds only user-facing material — `docs/faq.md`, `docs/install.md`,
`docs/media/*` — linked from `README.md` and `CONTRIBUTING.md`; nothing links
into `plans/`, and conversely `src-tauri/src/sidecar/mod.rs:88` cites
`plans/one-workspace-scaling.md` from production code, which is the strongest
signal that `plans/` is this repo's internal-design home. (`Docs/` is not a
distinct convention — macOS's case-insensitive filesystem resolves it to the
same directory as `docs/`, which `git ls-files` confirms holds only lowercase
entries.) This document therefore lives at
`plans/agent-pane-subagent-and-todo-rendering.md`.

## Evidence classes, and the rule that governs every claim below

Two kinds of evidence appear in this document, and every payload block below
is labelled with one of them:

- **Class (i) — live model runs.** Behavioural, authoritative about what the
  CLI actually does on the wire. Paid and slow (seconds to tens of seconds per
  run), so this document carries the captured payloads verbatim rather than
  asking a future reader to re-run a model just to read it.
- **Class (ii) — static inspection of the installed `claude` binary**
  (`strings -a` against `~/.local/share/claude/versions/2.1.226`). Free,
  reproducible in seconds, and authoritative only about the *presence of
  machinery* — never about what the model will actually choose to call. The
  central mistake this document exists partly to correct (see §1 below) was
  drawing a behavioural conclusion from class-(ii) evidence alone; the
  inference rule that fixes it is stated once and applies everywhere: **absence
  from a class-(ii) inventory means "not advertised here," never "removed."**

**Standing warning.** Every claim below is pinned to CLI 2.1.220/2.1.226 *in
this configuration* (this machine's `tengu_*` gate-flag values, this model,
`ToolSearch` enabled). The CLI ships near-daily; a future reader relying on
any claim here must re-run the commands printed next to it first. This is not
hypothetical: while writing this document, re-running the class-(ii) `grep`
commands against the currently-installed 2.1.226 binary (file timestamp
2026-08-08, i.e. today, despite the unchanged version string — evidence the
binary itself was silently replaced by an updater between the plan's research
pass and now) reproduced every count except one, and that one turned out to be
a counting-method artifact, not drift — see the exact numbers in §4.

## 1. Two premises, and exactly how far each is wrong

The originating ticket described `TodoWrite` as the live checklist tool, with
a `todos` array on its `tool_use.input`, and assumed nested subagent frames are
"likely impossible" to recover without an upstream CLI change. Both premises
needed correction, by different amounts, and this document states the
correction up front so nobody who stops reading here walks away with the wrong
conclusion:

- **The nested-subagent premise was wrong, not scoped.** A live nested
  subagent transcript is achievable from wire data alone, today, with no
  sidecar row, no hook, no `agent_events`, and no upstream CLI change. §4.3's
  timestamped table is the proof: every nested frame from a running subagent
  carries `parent_tool_use_id` equal to the parent `Agent` tool_use's `id`,
  arrives *before* that tool_use's own `tool_result`, and is spread over real
  wall-clock time rather than flushed as a batch at the end. `frame.rs`
  classifies these frames correctly already and passes `parent_tool_use_id`
  through untouched; the reducer in `agent-conversation.ts` simply never reads
  the field (both traced in detail in §4.3). The earlier "likely impossible
  without an upstream change" framing is retracted below in §4.3 and
  corrected: recoverable, frontend-only.
- **The `TodoWrite` premise is true-but-unreachable, not false.** On CLI
  2.1.220/2.1.226 in this configuration, the model cannot reach `TodoWrite` —
  it is not advertised in `init.tools`, and (the load-bearing check) an
  explicit `ToolSearch select:TodoWrite` lookup misses. But `TodoWrite` has
  **not** been removed from the CLI: its input schema, its description, its
  `content`/`status`/`activeForm` element shape, and its "hasn't been used
  recently" reminder are all still compiled into the 2.1.226 binary (§4). What
  the model calls instead, on the wire, is a `TaskCreate`/`TaskUpdate`/
  `TaskList` family that shares that exact `activeForm` vocabulary — the
  renamed checklist, not a missing one. The checklist design in §5 targets that
  family, with a `TodoWrite` branch kept for compatibility rather than treated
  as dead.

Both corrections are graded by evidence class throughout (§4), and neither
licenses deleting anything: §4's `Glob`/`Grep` finding is the same shape as the
`TodoWrite` finding — both are deferred, not gone — so no existing
`TOOL_ARG_KEY` entry is touched anywhere in this document's design.

## 2. What renders today, and why it is wrong

The strongest argument that the follow-up is a bug fix and not a new feature
is a concrete mis-render that already happens, today, for every subagent call.
Walking it through the actual reducer code rather than asserting it:

A subagent's own prompt arrives on the wire as a `user`/`text` frame tagged
with `parent_tool_use_id` (§4.3's 4.459s row). `applyUserFrame`
(`frontend/src/lib/agent-conversation.ts:625-655`) does not look at
`parent_tool_use_id` — it reads every `user`-kind frame the same way and, unless
the text exactly repeats the previous user turn, opens a new **"You" turn**
(rendered as such by `Turn`, `agent-conversation.tsx:124-131`, via
`isUser ? "You" : "Claude"`). So the subagent's own prompt is attributed to the
human in the pane.

That new user turn then closes the running assistant turn, because
`appendAssistantBlocks` (`agent-conversation.ts:207-225`) only appends to the
*trailing* turn when it is already `role: "assistant"` — a `user` turn in
between forces the next assistant content to open a fresh turn. So the
subagent's own `Read`/`Bash` tool calls, which arrive next on the wire, open a
new "Claude" turn and read as the **top-level agent's own work**, indented no
differently from anything else in the conversation. Meanwhile the original
`Agent`/`Task` tool block sits at `running` (`block.endedAt === null`,
`ToolBlockRow`, `agent-conversation.tsx:96-99`) for the entire wall-clock
duration of the subagent's run — 18 seconds in the captured trace — with
nothing under it to show why.

This is a mis-attribution bug that exists on every subagent call today, not an
absent feature waiting to be built from scratch. §6's card design fixes it by
grouping on `parent_tool_use_id` instead of opening new top-level turns.

## 3. How the agent pane renders a tool today

One generic renderer handles every `tool_use`/`tool_result` pair, with no
per-tool-name branch anywhere:

- `ToolBlockRow` (`frontend/src/components/terminal/agent-conversation.tsx:70-113`)
  — twisty, `block.name`, `block.argSummary`, an optional diffstat chip,
  `running` or `formatDuration(endedAt - startedAt)`, and a foldable output
  pane.
- `Turn`'s block loop (`agent-conversation.tsx:133-152`) is the *only*
  dispatch point: `block.type === "tool"` → `<ToolBlockRow/>`, unconditionally.
  This is where both new renderers in §5/§6 plug in.
- `TOOL_ARG_KEY` (`frontend/src/lib/agent-conversation.ts:279-287`):
  ```ts
  const TOOL_ARG_KEY: Record<string, string> = {
    Bash: "command",
    Read: "file_path",
    Edit: "file_path",
    Write: "file_path",
    Glob: "pattern",   // :284
    Grep: "pattern",   // :285
    Task: "description", // :286
  };
  ```
  No `TodoWrite`, no `Agent`, no `Task*` (`TaskCreate`/`TaskUpdate`/`TaskList`)
  entry.
- `toolArgSummary` (`agent-conversation.ts:292-305`): keyed lookup by tool name,
  else the **first string value found in `input` by object key order**
  (`:300-304`), else `""`.
- `ConvToolBlock` (`agent-conversation.ts:58-71`) already carries everything a
  timing-aware card needs: `id`, `name`, `argSummary`, `input`, `diffstat`,
  `output`, `startedAt`, `endedAt`, `isError`. `startedAt` is set when the
  `tool_use` block is first seen (`blocksFromAssistantContent`,
  `agent-conversation.ts:371-401`); `endedAt` is filled in later by
  `withToolResult` (`:250-273`), which finds the block by scanning every
  assistant turn for `block.id === toolUseId` (`:262`).
- **A `tool_result` frame carries no tool name.** `applyToolResult`
  (`agent-conversation.ts:605-621`) reads only
  `message.content[0].tool_use_id` (the read is at `:613`), `.content`, and
  `.is_error` — nothing else. Any renderer that needs to know *which tool* a
  result belongs to has to go through `withToolResult`'s `block.id ===
  toolUseId` scan (`:262`) and read `block.name` off the matched block, the way
  `withToolResult` already does for the generic pane. This is the mechanism §5
  builds the checklist on.
- `ConversationState` (`agent-conversation.ts:113-167`) has no subagent field
  of any kind today, and `applyFrame`'s reducer switch
  (`agent-conversation.ts:888-923`) never inspects `parent_tool_use_id` — that
  field is not read anywhere in this file. Confirmed repo-wide:
  `rg -n parent_tool_use_id` (excluding this document's own prose, which
  necessarily quotes the field many times as evidence) returns **exactly one
  hit** in application source, `frame.rs:479`, and that hit is a `null` inside
  a test fixture. This is the load-bearing proof that the field is received on
  the wire (§4.3) and discarded, not merely unused in one place; a second hit
  anywhere outside this document would mean the source has changed since this
  claim was made and the document is stale.
- The only production caller of the reducer,
  `frontend/src/stores/agent-session-store.ts:108-111`, returns
  `{ panes: { ...state.panes, [paneId]: next } }` at `:136` — it spreads
  whatever `applyFrame` returns, so adding new `ConversationState` fields needs
  no store change.

## 4. What the wire actually carries

### 4.1 `TodoWrite` is unreachable in this configuration; `Task*` is what gets called

**Primary evidence — class (i), reproduced live twice: once during the
plan's research pass, and again first-hand while writing this document
(2026-08-08).** `ToolSearch`'s exact-name lookup (`select:<name>`) is the
mechanism by which a *deferred* tool becomes callable; missing there means the
name is unreachable even via lazy discovery. Run live, in this session, right
now:

```
tool_use   ToolSearch {"query": "select:TodoWrite", "max_results": 3}
tool_result "No matching deferred tools found"

tool_use   ToolSearch {"query": "todo task list tracking", "max_results": 5}
tool_result [{"type":"tool_reference","tool_name":"TaskList", ...},
             {"type":"tool_reference","tool_name":"TaskCreate", ...},
             {"type":"tool_reference","tool_name":"TaskGet", ...},
             {"type":"tool_reference","tool_name":"TaskUpdate", ...},
             {"type":"tool_reference","tool_name":"CronList", ...}]
```

The exact-name miss plus the model's own fallback resolving to the `Task*`
family is the load-bearing finding, reproduced on both CLI 2.1.220 and
2.1.226, and independently again today outside either of those captures. It is
a claim about what the model can call **in this configuration, on these
versions** — not a claim that `TodoWrite` has been removed from the product.

A bonus first-hand capture from today's reproduction: `ToolSearch` returns full
JSON schemas for the resolved tools, confirming `TaskCreate`'s fields
(`subject`, `description`, `activeForm?`, `metadata?`), `TaskUpdate`'s
(`taskId`, `status` ∈ `pending|in_progress|completed|deleted`, plus `subject`/
`description`/`activeForm`/`owner`/`metadata`/`addBlocks`/`addBlockedBy`), and
`TaskGet`'s (`taskId`). Note `deleted` as a fourth status value not present in
the plan's original wire capture (§4.2 below only observed
`pending`/`in_progress`/`completed`) — recorded as an open question in §9.

**Secondary evidence — class (i), weaker, explicitly not an inventory.** The
`system/init` frame's advertised `tools` list omits `TodoWrite`:

```
claude --print --output-format stream-json --verbose \
  --dangerously-skip-permissions --disallowedTools ToolSearch -- "reply with just OK" < /dev/null
```

`system/init` → `tools` (non-MCP entries): `Task, Bash, CronCreate, CronDelete,
CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, Monitor,
NotebookEdit, PushNotification, Read, RemoteTrigger, ReportFindings,
ScheduleWakeup, SendMessage, ShareOnboardingGuide, Skill, TaskCreate, TaskGet,
TaskList, TaskOutput, TaskStop, TaskUpdate, WebFetch, WebSearch, Workflow,
Write`.

**Why this list is not a registry inventory.** The same capture also omits
`Glob` and `Grep`, which are unquestionably live tool names on 2.1.226 (the
counts and the read-only tool set are below, in this same section).
An earlier line of reasoning treated `--disallowedTools ToolSearch` as removing
lazy discovery and therefore making `init.tools` complete — that inference is
wrong, and this same capture disproves it. The CLI has an explicit deferral
mechanism that explains the omission. Class (ii), independently re-extracted
from the installed 2.1.226 binary today (`isDeferredTool`, exported as
`MDs.isDeferredTool`, internal name `kZ`):

```js
function kZ(e){
  if(e.alwaysLoad===!0) return !1;
  if(iwu().includes(e.name)) return !1;      // never-defer allowlist, gate-driven
  if(e.isMcp===!0) return !0;
  if(e.name===XT) return !1;                 // XT = TOOL_SEARCH_TOOL_NAME itself
  /* … several more per-tool escape hatches, each name-specific … */
  return e.shouldDefer===!0
}
```

`iwu()` is populated from a remote gate flag read as
`nt("tengu_non_deferrable_builtins", null)` — so which names appear in
`init.tools` is **configuration-dependent by construction**, not a fixed
property of the version. Corroborating: the context-usage breakdown literally
pushes a row named `"System tools (deferred)"` with `isDeferred:!0` (found
verbatim in the 2.1.226 binary: `if(M>0)ae.push({name:"System tools
(deferred)",tokens:M,color:"inactive",isDeferred:!0})`), sitting next to an
`"MCP tools (deferred)"` row built the same way. A non-MCP built-in carrying
`shouldDefer:!0` is *withheld from the advertised list*, not removed.

Locally re-runnable in seconds, no paid call
(`V=~/.local/share/claude/versions/2.1.226`), independently re-run today with
these results:

| command (`LC_ALL=C strings -a $V \| grep -c -a '<pattern>'`) | plan's original count | reproduced today |
|---|---|---|
| `'"Glob"'` | 10 | **10** |
| `'"Grep"'` | 11 | **11** |
| `'isDeferredTool'` | 5 | **5** |
| `'System tools (deferred)'` | 2 | **2** |
| `'shouldDefer:!0'` | 47 | **34*** |
| `'tengu_non_deferrable_builtins'` | 2 | **2** |
| `'turnsSinceLastTodoWrite'` | 3 | **3** |
| `-F 'name:"TodoWrite"'` | 0 (non-probative) | **0** (non-probative) |

`*` The one discrepancy is a counting-method artifact, not drift, and is worth
recording exactly so a future reader does not chase a phantom regression:
`grep -c` counts matching **lines**, and in this build several extracted
strings each contain the literal `shouldDefer:!0` more than once (28 lines with
1 occurrence, 2 with 2, 2 with 3, 1 with 4, 1 with 5 — `28+4+6+4+5=47`). The
literal **occurrence** count, via `LC_ALL=C strings -a $V | grep -a -o
'shouldDefer:!0' | wc -l` or equivalently `LC_ALL=C grep -c -a -o
'shouldDefer:!0' $V`, is exactly **47**, matching the plan's original figure.
Both commands and both numbers are recorded here so neither a `-c` nor a `-o`
re-run looks like a failed reproduction.

**Deeper machinery confirmed today, beyond what the original research
captured.** The read-only tool set that lists `Glob`/`Grep`/`TodoWrite` and the
whole `Task*`/`Agent` family side by side, found verbatim:

```js
new Set(["Read","Glob","Grep","NotebookRead","Skill","AskUserQuestion","Task",
         "TaskCreate","TaskGet","TaskList","TaskUpdate","TaskStop","TaskOutput",
         "Agent","TodoWrite"])
```

And `TodoWrite`'s tool definition itself, found and extracted today (variable
names as compiled, `F5p` is the tool object):

```js
kYb = ve(()=>Ko({ todos: cwt().describe("The updated todo list") }))
F5p = Hi({
  name: Gz,                       // Gz === "TodoWrite" (see below) — hoisted, not inline
  ...
  shouldDefer: !0,
  isEnabled(){ return !hL() && !wse() },   // gated by TWO conditions, not one
  userFacingName(){ return "" },
  ...
})
```

`isEnabled` reads a gate flag through `wse()`:
```js
function wse(){
  try{ let e = nt("tengu_vellum_ash", []);
       if(!Array.isArray(e) || e.length===0) return !1;
       let t = ls(); return e.some((r)=>r.length>0 && t.includes(r)) }
  catch{ return !1 }
}
```
— i.e. `TodoWrite` is disabled unless the current context matches an allowlist
read from the `tengu_vellum_ash` gate flag (the second condition, `hL()`, was
not traced further; not needed for this document's conclusion). This is
strictly stronger evidence for "feature-flagged, not deleted" than a static
schema string alone: there is a literal `isEnabled` predicate, wired to a named
remote flag, standing between the tool and callability.

The description prompt (short variant), extracted verbatim and matching the
plan's transcription exactly:

```
Create and update a task list for the current session. The list is rendered
to the user as your working plan.

- Each todo has `content`, `status` ("pending" | "in_progress" | "completed"),
  and `activeForm` (present-tense label shown while in progress).
- Send the full list each call; it replaces the previous one.
- Keep one item `in_progress` at a time and mark it `completed` when done.
```

and the reminder, with its counter:

```
The TodoWrite tool hasn't been used recently. If you're working on tasks that
would benefit from tracking progress, consider using the TodoWrite tool to
track progress. Also consider cleaning up the todo list if has become stale
and no longer matches what you are working on. Only use it if it's relevant
to the current work. This is just a gentle reminder - ignore if not
applicable.
```

**One grep that looks probative and is not:**
`LC_ALL=C grep -c -a -F 'name:"TodoWrite"' $V` → `0`. Confirmed today. In
minified output a tool's `name` field is routinely a hoisted constant, not an
inline string literal — verified today by extracting the constant itself:
`Gz="TodoWrite"` appears once, standalone, elsewhere in the same file (the same
pattern the plan predicted for `Agent`/`Task`, whose hoisted constants are
`_i`/`Y4`). A zero on `name:"TodoWrite"` therefore means nothing about
whether the tool exists; it only means the source got minified the way
minifiers always hoist repeated string literals. Stating this explicitly here
so a future reader does not re-derive the broken inference from that grep.

⇒ Three things this document commits to, in this order and no stronger:
1. On CLI 2.1.220/2.1.226 in this configuration, the model **cannot reach**
   `TodoWrite`: not advertised in `init.tools`, and `ToolSearch
   select:TodoWrite` misses (verified live, twice, independently).
2. `TodoWrite` is nevertheless **present, gated by an explicit `isEnabled`
   predicate tied to a named remote flag**, not deleted.
3. The checklist (§5) is designed on the `Task*` family, with a `TodoWrite`
   branch retained as compatibility, evidenced by the schema/description/
   element-shape strings above rather than recalled from memory.

### 4.2 The checklist is now `TaskCreate`/`TaskUpdate`/`TaskList`, and it is incremental

Captured payloads, class (i), 2.1.220, a multi-step chore prompt; identical
shapes reproduced on 2.1.226 in the plan's original research pass:

```jsonc
tool_use TaskCreate {"subject":"Read a.txt",
                     "description":"Read /private/tmp/cn-wire-220/a.txt contents.",
                     "activeForm":"Reading a.txt"}
tool_result          "Task #1 created successfully: Read a.txt"

tool_use TaskCreate {"subject":"Create b.txt uppercased", "description":"…",
                     "activeForm":"Creating b.txt"}
tool_result          "Task #2 created successfully: Create b.txt uppercased"

tool_use TaskUpdate {"taskId":"1","status":"completed"}
tool_result          "Updated task #1 status"

tool_use TaskUpdate {"taskId":"2","status":"in_progress"}
tool_result          "Updated task #2 status"

tool_use TaskList   {}
tool_result          "#1 [in_progress] first thing\n#2 [pending] second thing"
```

`activeForm` is the same field name `TodoWrite`'s own `todos[]` element carries
(§4.1's `content`/`status`/`activeForm` element-shape string) — that shared
vocabulary is what identifies the `Task*` family as the renamed checklist, not
a guess. Status vocabulary observed on the wire: `pending`, `in_progress`,
`completed` — the three states the original ticket asked the renderer to show,
and exactly the three named in `TodoWrite`'s own description string. (Today's
`ToolSearch`-returned schema for `TaskUpdate` also lists a fourth value,
`deleted`, not seen on this wire capture — flagged as an open question in §9,
not asserted as wire behaviour.)

Three consequences that shape the design in §5:

1. **There is no single frame carrying the whole list.** The `todos`-array
   design the ticket assumed is not available for the `Task*` family — a
   checklist has to be *accumulated* across many `TaskCreate`/`TaskUpdate`
   frames. This is reducer work in `agent-conversation.ts`, not only a
   renderer branch in `agent-conversation.tsx`.
2. **`TaskUpdate.taskId` (`"1"`) is a display index assigned by the CLI and
   reported only in `TaskCreate`'s result text** (`"Task #1 created
   successfully: <subject>"`). Correlating an update to its subject therefore
   needs either that result string parsed, or `TaskList`'s
   `#N [status] subject` lines, or creation order — ranked in §5's design.
3. **The ticket's stated symptom — an empty `argSummary` — is real, but lands
   on a different tool than the ticket named.** `TaskList {}` has no string
   value at all → `""` via the fallback at `agent-conversation.ts:300-304`.
   `TaskCreate` accidentally renders `subject`, and `TaskUpdate` accidentally
   renders `"1"`, both purely because they happen to be the first string key —
   luck, not design.

### 4.3 The central question: nested subagent activity IS recoverable, live. Premise refuted.

Two independent live runs (class i), the second with per-frame arrival
timestamps taken from a monotonic clock as the lines came off `claude`'s
stdout. Prompt: launch one `general-purpose` subagent that reads a file, runs
`sleep 5`, and reports.

```
  0.529s  system       init
  3.009s  assistant                text                    ptui=None
  4.370s  assistant                tool_use:Agent          ptui=None
  4.380s  rate_limit_event
  4.457s  system       task_started                        ptui=None
  4.459s  user                     text                    ptui=toolu_01UFzAvjNBmfGPYURwAuQ3GK
  6.913s  system       task_progress                       ptui=None
  6.916s  assistant                tool_use:Read           ptui=toolu_01UFzAvjNBmfGPYURwAuQ3GK
  7.051s  user                     tool_result             ptui=toolu_01UFzAvjNBmfGPYURwAuQ3GK
  8.718s  system       task_progress                       ptui=None
  8.719s  assistant                tool_use:Bash           ptui=toolu_01UFzAvjNBmfGPYURwAuQ3GK
 12.439s  system       task_started                        ptui=None      ← local_bash, different task_id
 14.496s  system       task_notification                   ptui=None      ← local_bash completed
 14.577s  user                     tool_result             ptui=toolu_01UFzAvjNBmfGPYURwAuQ3GK
 21.180s  system       task_progress                       ptui=None
 21.182s  assistant                tool_use:Bash           ptui=toolu_01UFzAvjNBmfGPYURwAuQ3GK
 21.375s  user                     tool_result             ptui=toolu_01UFzAvjNBmfGPYURwAuQ3GK
 22.622s  system       task_updated                        ptui=None
 22.622s  system       task_notification                   ptui=None
 22.686s  user                     tool_result             ptui=None      ← the Agent call's own result
 24.513s  assistant                text                    ptui=None
 24.617s  result       success
```

`ptui` = `parent_tool_use_id`. **This table proves a live nested subagent
transcript is achievable from wire data alone**:

- The subagent's own frames arrive **spread over 18 wall-clock seconds**
  (4.459s → 21.375s), all **before** the `Agent` call's own `tool_result` at
  22.686s. The 6-second stall between the nested `Bash` at 8.719s and its
  result at 14.577s is the `sleep 5` — the gap proves these are streamed as
  they happen, not flushed as a batch at the end; ordering alone would not
  have proved this, the timestamps do.
- Every nested frame carries `parent_tool_use_id` equal to the `Agent`
  `tool_use.id`. Top-level frames carry `null`/absent. That single field is a
  complete, unambiguous attribution key. Corroborated in the binary: the CLI
  itself filters on it to find top-level messages
  (`findLast(o=>o.type==="assistant" && !o.parent_tool_use_id && …)`).
- `classify` in `src-tauri/src/agent/frame.rs:55-99` already classifies these
  nested frames correctly regardless of nesting — it switches purely on the
  top-level frame `type` and, for `assistant`/`user`, the block types inside
  `message.content` (`assistant` + `tool_use` block → `ToolUse`; `user` +
  `tool_result` block → `ToolResult`; `frame.rs:60-98`), never on
  `parent_tool_use_id`, so nesting depth has no effect on classification. And
  `AgentFrame::parsed` (`frame.rs:149-159`) stores the **entire** parsed frame
  verbatim as `raw`, `parent_tool_use_id` included. **No Rust change is
  needed.** The information is on the frontend's doorstep today and is thrown
  away by a reducer that never reads the field — see §2's mis-render
  walkthrough for exactly how.

⇒ The ticket's framing — "likely impossible without an upstream change to how
the claude CLI emits data" — is **wrong** for CLI 2.1.220/2.1.226 in this
configuration, and is retracted here. A live nested transcript is achievable
client-side, frontend-only, today. §8 states the boundaries that remain real
after this correction.

The `Agent` tool_use itself, captured verbatim:

```jsonc
tool_use Agent  id=toolu_01UFzAvjNBmfGPYURwAuQ3GK
// input keys, in wire order:
{"description":"inspect seed",
 "prompt":"Read the file seed.txt … report just the number of lines.",
 "subagent_type":"general-purpose",
 "run_in_background":false}
```

Two sharp findings here:
- **The wire's `tool_use.name` is `Agent`, while `init.tools` advertises
  `Task`.** `TOOL_ARG_KEY` has `Task` (`agent-conversation.ts:286`), not
  `Agent`, so the subagent card cannot be built on that mapping alone — it
  must accept both names. Corroborated in the binary by the alias map, found
  verbatim today: `{Task:"Agent",KillShell:"TaskStop",KillBash:"TaskStop",
  AgentOutputTool:"TaskOutput"}` and the guard
  `if(e!=="Agent"&&e!=="Task")return;` (found together, adjacent, in the
  2.1.226 binary); and in this repo by `agent_service.py`'s
  `tool_name IN ('Agent','Task')` at `app/services/agent_service.py:1048` and
  `:1116` (both the invocation-summary query and `list_agent_invocations`).
- **`Agent` renders its `description` today only by luck.** No `TOOL_ARG_KEY`
  entry for `Agent`, so `toolArgSummary`'s first-string fallback fires, and
  `description` happens to be the first key in the wire's input object. If the
  CLI ever reorders those keys, a multi-kilobyte `prompt` string lands in a
  one-line row instead.

### 4.4 The `system task_*` frames: a ready-made live progress feed, currently discarded

Raw, class (i), minus `uuid`/`session_id`/`prompt` for brevity:

```jsonc
{"type":"system","subtype":"task_started","task_id":"a17f08215cfc54690",
 "tool_use_id":"toolu_01UFz…","description":"inspect seed",
 "subagent_type":"general-purpose","task_type":"local_agent"}

{"type":"system","subtype":"task_progress","task_id":"a17f08215cfc54690",
 "tool_use_id":"toolu_01UFz…","description":"Reading seed.txt",
 "subagent_type":"general-purpose","last_tool_name":"Read",
 "usage":{"total_tokens":11619,"tool_uses":1,"duration_ms":2455}}

{"type":"system","subtype":"task_started","task_id":"bh47diyyp",
 "tool_use_id":"toolu_013EA…","description":"Sleep for 5 seconds",
 "task_type":"local_bash"}                                   // NOT a subagent

{"type":"system","subtype":"task_notification","task_id":"bh47diyyp",
 "tool_use_id":"toolu_013EA…","status":"completed","output_file":"",
 "summary":"Sleep for 5 seconds"}

{"type":"system","subtype":"task_updated","task_id":"a17f08215cfc54690",
 "patch":{"status":"completed","end_time":1786216403489}}

{"type":"system","subtype":"task_notification","task_id":"a17f08215cfc54690",
 "tool_use_id":"toolu_01UFz…","status":"completed",
 "output_file":"/private/tmp/claude-501/…/tasks/a17f08215cfc54690.output",
 "summary":"2","usage":{"total_tokens":13914,"tool_uses":3,"duration_ms":18166}}
```

- `task_type` discriminates: `"local_agent"` (carries `subagent_type`) vs
  `"local_bash"` (a slow shell command, no `subagent_type`). A renderer that
  assumed one `task_started`/`task_notification` pair per `Agent` call would
  mis-attribute the `sleep` — the timestamped table in §4.3 contains exactly
  that trap at 12.439s/14.496s. Filter on `task_type === "local_agent"` and
  correlate by `tool_use_id`; never by arrival order.
- `task_progress.description` is a live human-readable activity phrase
  ("Reading seed.txt") plus cumulative `usage.tool_uses`, `usage.total_tokens`,
  `usage.duration_ms` — a complete progress line without touching nested
  frames at all, a strictly smaller first slice than the full nested
  transcript.
- `task_updated.patch.end_time` (epoch ms) and `task_notification.summary`
  (the subagent's answer) both arrive **before** the `Agent` tool_result.
- `applySystem` (`agent-conversation.ts:773-826`) drops all four subtypes
  today — it only handles `status`, `permission_denied`, `thinking_tokens`.

### 4.5 One more unclassified frame

`{"type":"rate_limit_event", …}` appeared in every capture. `classify` falls
through its `_` arm to `AgentFrameKind::Unknown` (`frame.rs:97`), and
`applyFrame`'s `"unknown"` case returns state unchanged
(`agent-conversation.ts:918-919`). Harmless and correct as-is; recorded so a
future reader does not chase it.

## 5. Renderer 1 — the live checklist

**New reducer state** on `ConversationState` (`agent-conversation.ts:113-167`):

```ts
checklist: Array<{
  index: number;                                   // the CLI's #N, ordered
  subject: string;
  activeForm: string | null;
  status: "pending" | "in_progress" | "completed";
}>
```

Ordered by `index`. Empty array when no `TaskCreate` has fired yet.

**Where it is populated.** A `TaskCreate`/`TaskUpdate`/`TaskList` branch that
must fire on **`tool_result`** (inside `applyToolResult`,
`agent-conversation.ts:605-621`), not only on `tool_use` — because the `#N`
index and the `TaskList` snapshot live in the *result* text, not the input.
This is a change of shape from what the ticket assumed (which needed only the
`tool_use.input.todos` array).

The sharp implementation detail from §3: **a `tool_result` frame carries no
tool name** — only `tool_use_id` (`agent-conversation.ts:613`). The reducer
must identify a `Task*` result exactly the way `withToolResult` already finds
its block: scan for `block.id === toolUseId` (`:262`) and read `block.name`
off the matched block. An implementer told only "fire the checklist logic on
the result" will look for a name on the result frame itself and not find one —
this is worth stating explicitly so nobody rediscovers it the hard way.

**The `TodoWrite` compatibility branch:** map `input.todos` (each element's
evidenced shape is `content`/`status`/`activeForm`, per §4.1's description
string) onto the same `checklist` element shape, whole-list snapshot on every
`tool_use`. Retaining this branch costs one `case` and covers other
configurations, older CLIs, and any future un-flagging of `tengu_vellum_ash`;
its payload shape is evidenced (§4.1), not guessed. The sidecar's
`_TODO_QUERY` (`app/services/session_hud_service.py:126-131`) still keys on
the literal name `TodoWrite`, so that name stays live in this codebase's
vocabulary regardless of what the model currently calls.

**The render.** One checklist component at the existing dispatch point
(`agent-conversation.tsx:133-152`), reusing `agent-conversation.module.css`,
with pending/in-progress/completed affordances. The honesty rule — quoted from
`agent-session-hud.tsx:10-16`'s contract, and mirrored by
`session_hud_service.py`'s explicit `(None, None)`-not-`(0, 0)` rule at
`:144-153` — applies here unchanged: an empty checklist renders **nothing**,
never `0/0`, never a placeholder.

The one-line `n/m` summary this feeds is the same figure the shell pane's HUD
cell already shows (`session-hud.tsx:198-213`), just sourced from the wire
directly instead of from a sidecar `agent_events` row.

**Explicit statement, as the originating ticket required:** this checklist is
**fully achievable from wire data alone — no sidecar row, no hook, no
`agent_events` table** — because `frame.rs:149-159` passes the whole frame
through as `raw` and `ipc.ts:320-325` hands that `raw` to the reducer
unmodified. Unlike the old shell-pane HUD cell (§7), nothing here depends on a
hooks pipeline that an agent pane does not have.

## 6. Renderer 2 — the subagent card

**Dispatch.** Matches tool name `Agent` **or** `Task` (§4.3's wire-name
finding). Both names get entries in `TOOL_ARG_KEY`
(`agent-conversation.ts:279-287`) — `description` for each — which makes
`argSummary` deliberate instead of order-dependent luck (§4.3's second sharp
finding). This is an **addition** to the map; no existing entry is removed
(the `Glob`/`Grep` anti-recommendation below).

**Card content:** `Subagent: <description> (<subagent_type>) — running /
completed in Xs`, where `description`/`subagent_type` come from the `tool_use`
input (or, once seen, from the corroborating `task_started` frame), and the
duration comes from the existing `startedAt`/`endedAt` pair
(`ConvToolBlock`, `agent-conversation.ts:58-71`) — the same timing already
tracked generically for every tool. `task_updated.patch.end_time` and
`task_notification.usage.duration_ms` (§4.4) are available as the CLI's own
cross-check on that duration, not as a replacement for it.

**The live line**, while running, from `task_progress`: `description`,
`last_tool_name`, `usage.tool_uses`, `usage.total_tokens` (§4.4) — a complete
one-line status without needing the nested transcript at all.

**The nested transcript**, collapsed by default: nested frames (any frame
whose `raw.parent_tool_use_id` equals this card's `tool_use.id`) rendered
underneath the card instead of opening new top-level turns — this is the fix
for §2's mis-attribution bug, not new functionality bolted on top of it.

**Correlation strategy, ranked, and committed to rather than left as options**
(this is the recommendation this document makes, not a menu):
1. **Card membership:** correlate by `tool_use.id` ↔ `task_*.tool_use_id` ↔
   nested frames' `parent_tool_use_id`. Exact, and the only key present in all
   three frame families.
2. **Checklist item identity (§5):** accumulate from `TaskCreate`/
   `TaskUpdate`, keying items by the `#N` parsed out of `TaskCreate`'s result
   string (`/^Task #(\d+) created successfully: /`), and treat a `TaskList`
   `tool_result` (`#N [status] subject` lines) as an **authoritative
   resynchronisation** whenever one appears. Parsing a result string is
   brittle in isolation, but `TaskList` gives a periodic ground truth, and
   creation-order indexing alone breaks the moment the CLI skips or reuses an
   index.
3. **Never correlate by arrival order.** §4.4's `local_bash` interleave
   (`task_started` for the `sleep` fires *while* the subagent's own `task_id`
   is still open) is the captured counter-example — the `task_type ===
   "local_agent"` filter (§4.4) is what actually discriminates, not sequence
   position.

## 7. Context: why the shell pane got this for free, and what does not carry over

**Different medium, not a missing feature.** `terminal-pane.tsx:257-263`
base64-decodes each PTY chunk and writes the raw bytes straight to `xterm.js`
(`termRef.current?.write(bytes)`) — the real interactive `claude` TUI draws
its own checklist in that byte stream, so the shell pane inherits it for free.
The agent pane spawns `claude` with `--print --input-format stream-json
--output-format stream-json --verbose --include-partial-messages
--permission-prompt-tool stdio --session-id …`
(`src-tauri/src/agent/mod.rs:245-261`) and gets structured JSON messages
instead of a rendered TUI. Building the checklist and the card is the price of
that structured mode, not a regression from it.

**The `todo_done`/`todo_total` HUD cell does not carry over,** and there is a
sharper finding underneath the obvious one. `session-hud.tsx:198-213` renders
the cell from `app/services/session_hud_service.py`'s `_TODO_QUERY`
(`:126-131`) and `_todo_progress` (`:133-157`), which reads
`agent_events` rows written by Claude Code's own hooks. An agent pane has
**no** row in `agent_sessions`/`agent_runs` at all — `agent/mod.rs` never talks
to the sidecar — so `<SessionHud/>` would render empty there even before
considering the tool-name question; `agent-session-hud.tsx:10-16` documents
this and is why the agent pane has its own sibling strip reading the wire
directly instead. **Additional finding, scoped and filed as a follow-up, not
fixed here:** that same query keys on the literal string `tool_name =
'TodoWrite'`, and §4.1 shows the model is not calling that tool in this
captured configuration — so the shell pane's own HUD cell very likely reads
empty too, on current CLI configurations, for the same underlying reason as
the agent pane's checklist gap. It degrades safely today (`_todo_progress`
returns `(None, None)`, never `(0, 0)`, per the explicit rule at
`session_hud_service.py:144-153`), so this is not urgent — but it should not be
"fixed" by renaming the query to `Task*` without first confirming against a
live hook stream, since hooks and the model's own tool choice are two
different mechanisms and this document has no evidence about the hook side.

**`AgentInvocationRow` is post-hoc and hooks-dependent, not live.**
`list_agent_invocations` (`app/services/agent_service.py:1065-1122`) joins
`PreToolUse`/`PostToolUse` rows in `agent_events` on `tool_use_id`, which an
agent pane never writes (same reason as above — no sidecar row). Its `WHERE
pre.tool_name IN ('Agent','Task')` clauses (`:1049`, `:1117`) are independent
corroboration of §4.3's wire-name finding: this repo's own analytics code
already had to handle both names.

**The constellation ceiling does not move.** Command Center's
`useConstellationLayout` (`frontend/src/components/command-center/use-constellation-layout.ts:28-73`)
has exactly three node kinds — `HubNode` (`id: "hub"`), `ProjectNode`
(`id: "p:<name>"`), `SessionNode` (`parentId: ProjectNode.id`) — with no
parent/child concept below a session. A 4th tier for subagents is a real
capability, but it is out of scope here; see §8/B3.

## 8. Boundaries

Refuting "nested activity is impossible" (§4.3) without naming what is *still*
true would leave a follow-up ticket over-promising. Three boundaries replace
it:

- **B1 (soft) — one level of nesting only.** The captured data has a subagent
  that itself calls tools, not a subagent that calls another subagent.
  `parent_tool_use_id` is a single scalar, so a *tree* deeper than one level
  cannot be reconstructed from that field alone without correlating `task_id`
  chains that were not captured here. Design for depth 1; do not promise
  arbitrary depth (§9 records this as open, not resolved).
- **B2 (hard, and the real one) — everything here is ephemeral pane state.**
  The checklist and the subagent card are both reduced in the frontend and die
  with the pane, because an agent pane has no sidecar row at all
  (`agent-session-hud.tsx:10-16`). Nothing nested is queryable, historical, or
  visible outside the live pane. This is a permanent property of the current
  architecture, not something either renderer can fix.
- **B3 (hard, the ceiling) — Command Center's constellation is a fixed 3-tier
  schema.** A genuine 4th tier for subagents needs a subagent row in
  `agent_events`/`agent_sessions` — a new migration; the highest stem in
  `migrations/` today is `003_agent_sessions_context_tokens.sql`, so the next
  one would be `004_` under the append-only rule — plus sidecar and SSE
  plumbing to fill it, plus a `parentId` chain `use-constellation-layout.ts`
  does not have. Named and costed here; **explicitly out of scope** for any
  follow-up from this document.

## 9. Open questions

Each of these is uncaptured by the runs behind this document and must stay an
open question, not an assertion, until someone captures it:

- **`run_in_background: true` on the `Agent` call.** Present in the captured
  input shape (§4.3) but always `false` in every run taken. Whether the
  `tool_result` returns immediately while `task_notification` arrives much
  later — which would leave a card "completed" while its subagent is still
  working — is unknown. Capture with the same prompt and
  `"run_in_background": true` forced, then diff against §4.3's table.
  Not fixed here.
- **A subagent tool call that needs permission.** The pane runs
  `--permission-prompt-tool stdio` (`agent/mod.rs:258-259`); every capture used
  `--dangerously-skip-permissions`, so whether a nested `can_use_tool`
  `control_request` carries any parent linkage is unknown.
  `applyPermission` (`agent-conversation.ts:716-732`) reads no parent field
  today. A permission dialog that cannot say which subagent is asking is a
  real UX hazard if this turns out to lack linkage — flagged, not fixed.
- **Depth-2 nesting** (a subagent that itself calls `Agent`/`Task`).
  Uncaptured; see B1 above.
- **`TaskUpdate`'s `deleted` status**, seen only in today's `ToolSearch`
  schema capture (§4.1), never on the wire in either wire-capture session
  (§4.2 observed only `pending`/`in_progress`/`completed`). Whether the model
  ever actually emits `"status":"deleted"` on the wire, and what the checklist
  should do with it (drop the item? render it struck through?) is unknown.
- **A configuration where `TodoWrite` is reachable** — a different value for
  `tengu_vellum_ash`/whatever `hL()` gates, an older CLI, or an interactive TUI
  session. Not reproducible here (§4.1), but explicitly *expected to exist*,
  which is why §5's compatibility branch is retained rather than treated as
  legacy cruft. No claim is made about which configurations still emit it.

## 10. Hand-off: follow-up implementation ticket

**Layer: frontend only.** No Rust change (`frame.rs` already classifies
nested frames correctly and passes `parent_tool_use_id` through in `raw`,
§4.3), no sidecar change, no migration, no new dependency, and no four-way
feature-flag mirror (this is pane rendering behaviour, not a nav-level
feature).

**Files:**
- `frontend/src/lib/agent-conversation.ts` — reducer changes: new `checklist`
  state, the `TaskCreate`/`TaskUpdate`/`TaskList`/`TodoWrite` branches, and
  **added** `TOOL_ARG_KEY` entries for `Agent` and the `Task*` names.
- `frontend/src/components/terminal/agent-conversation.tsx` — two new
  components wired in at the existing block-loop dispatch point (`:133-152`):
  the checklist and the subagent card.
- `frontend/src/components/terminal/agent-conversation.module.css` — styles
  for both.
- `frontend/src/lib/__tests__/agent-conversation.test.ts` — new tests (below).

`frontend/src/stores/agent-session-store.ts:108-136` needs **no change**: it
spreads whatever the reducer returns.

**Explicit non-change:** `TOOL_ARG_KEY`'s existing `Glob`/`Grep`→`pattern`
entries (`agent-conversation.ts:284-285`) stay exactly as they are. §4.1 shows
both names are deferred from `init.tools`, not removed, and both still get
called after `ToolSearch` discovery — deleting either mapping would silently
regress `argSummary` for two tools that remain live. The follow-up **adds**
`Agent`/`Task*` keys and removes nothing.

**Tests the follow-up must add**, each pinning one property:
- A nested frame (`parent_tool_use_id` set) attributes to its parent card and
  never opens a top-level "You" turn.
- A `local_bash` `task_started`/`task_notification` pair never creates a
  subagent card (the `task_type === "local_agent"` filter, §6/§4.4).
- A checklist accumulates across `TaskCreate`/`TaskUpdate` frames and resyncs
  from a `TaskList` result.
- A `Task*` `tool_result` is recognised via `tool_use_id` → `block.name`
  lookup (`agent-conversation.ts:262`), not via a name on the result frame
  itself (there isn't one, `:613`).
- An empty checklist renders nothing (the honesty rule, §5).
- A `TodoWrite` `tool_use.input.todos` array still populates the checklist
  (the compatibility branch, §5).

**Tests that must keep passing unchanged:**
`agent-conversation.test.ts:504` and `:721` both exercise system-subtype
inertness using `hook_started`, so adding `task_*` subtype handling to
`applySystem` cannot break them. `:644` pins `toolArgSummary`'s first-string
fallback using `WebFetch`, so adding `Agent`/`Task*` keys to `TOOL_ARG_KEY`
must not change its behaviour for tools that still have no entry. (Test count
at the time of writing: **45** `it(` cases in that file.)

**Suggested split: checklist first, subagent card second.** The checklist
(§5) is smaller — one accumulator, no correlation subtleties beyond parsing a
result string — and delivers value on its own (every multi-step chore session
gets a live progress list). The subagent card (§6) needs the
`parent_tool_use_id` grouping and the `task_type` discrimination, which is
where the actual complexity and the actual regression risk (mis-attributing a
`local_bash` task) live. Shipping the checklist first also gives the second
ticket a smaller diff to review against.

## Order

Do the checklist (§5) first — it is self-contained, fixes a real "empty
argSummary" symptom on its own, and needs no correlation logic beyond parsing
one result string. The subagent card (§6) follows, since it depends on the
same `TOOL_ARG_KEY` additions and is the one that actually resolves §2's
mis-attribution bug. The 4th-tier constellation work (§8/B3) is explicitly not
next — it is only worth opening once the pane-local renderers have shipped and
someone has decided the data is worth persisting outside the pane.
