# One workspace, many projects — scaling plan

Three problems with the "one workspace links every connected project" model,
split into tickets. Written 2026-07-31.

The model itself is not in question: one `<app-data>/workspace/.claude/` holds
links to every enabled agent, skill and command across every active project, so
a single `claude` session can reach all of them. Everything below is about what
breaks as the number of projects grows, and about honouring that same model on
Windows.

---

## Strand A — name collisions across projects

### What already works

Collisions are handled at two levels today:

* **Within one project** (`project_scanner_service.py:170-181`): two agent files
  declaring the same frontmatter `name` are stored as `name` and
  `name--<file-stem>`, and the second is flagged `has_name_mismatch`.
* **Filenames in the shared workspace** (`command_center_service._collect_desired_links`):
  the first project to claim `code-reviewer.md` keeps it; later ones are linked
  as `<project-slug>--code-reviewer.md`, then `<slug>--code-reviewer-<row_id>.md`.
  Org agents are collected first, so they always win. `UNIQUE(project_id, name)`
  and `UNIQUE INDEX uq_project_agents_link_path` keep the DB honest.

### The gap

**Claude Code resolves an agent by its frontmatter `name:`, not by its
filename.** Renaming the *link* therefore does not disambiguate anything: both
`code-reviewer.md` and `miragold--code-reviewer.md` still declare
`name: code-reviewer`, so the CLI sees two agents with one name and silently
picks one. The user gets no signal, and which one wins is not something this app
controls.

Worse, the winner is positional — `ORDER BY p.id, pa.id`, i.e. import order.
Remove the project that happened to be imported first and a *different* agent
silently starts answering to `code-reviewer`.

A symlink cannot fix this: the link and its target are the same bytes, so the
`name:` field cannot differ between them.

### A1 — Detect and surface the conflict; link only one *(implemented)*

Make the invisible visible and make the CLI's view unambiguous, without
touching content.

* Group the desired agent links by effective invocable name. Link the winner;
  exclude the shadowed ones from the workspace entirely rather than linking a
  file the CLI will ignore anyway.
* Report them: bootstrap and `regenerate_workspace_links` return a
  `conflicts` list (`name`, winner project, shadowed project), and a read
  endpoint exposes it so the UI can say *"miragold's `code-reviewer` is shadowed
  by codenest-app's — rename or disable one"*.
* Winner stays "org agents first, then lowest project id", which is the current
  behaviour; A2 makes it a choice.

Not a full fix — the user still has to act — but it converts undefined CLI
behaviour into a reported, deterministic one. Cheap: no schema change.

### A2 — Namespaced materialisation for conflicting agents

The real fix, and the only one that lets two same-named agents coexist.

For a conflicting agent, write a real file into the workspace instead of a link,
with the frontmatter `name` rewritten to `<project-slug>-<name>` and the body
copied verbatim. `link_type` gains a `'copy'` value (migration `004_`), and the
row records the namespaced name so the UI can show what to invoke.

Costs that must be designed for, not discovered:

* **Staleness.** A copy does not track its source. Needs a re-materialise on
  project rescan, and ideally on the `fswatch` watcher already running for the
  navigator.
* **The "DB is the source of truth, links must re-resolve to canonical paths"
  rule** (`symlink_service.py` docstring) is deliberately broken for these rows —
  the reason belongs in that docstring.
* **Frontmatter rewriting is content surgery** on a file the user owns. It must
  round-trip unknown keys untouched, and it must never write back into the
  project.

### A3 — Skills and commands

Same shape, different resolution: a skill is a *directory* whose name is the
invocable handle (`.claude/skills/<name>/SKILL.md`), and a command is
`.claude/commands/<name>.md`. Both are resolved by that path segment, so
slug-prefixing the workspace entry — which
`_collect_desired_links` already does — *does* disambiguate them, unlike agents.

So the work here is smaller and different: the prefixed name is what the user
must type, and nothing currently tells them that. Surface the effective handle
per skill/command in the UI. Verify the claim about `SKILL.md` frontmatter first:
if a skill's own `name:` field wins over its directory name, A3 collapses into A2.

---

## Strand B — Windows

The single-workspace model must hold on Windows: one workspace, links into every
project, same functionality.

### What already works

`app/services/symlink_service.py` is written for this: symlink first, then
hardlink for files, then a directory junction (`_winapi.CreateJunction`, falling
back to `mklink /J`), never a copy. `link_type` already accepts `'junction'` and
the schema's CHECK constraints allow it. The sidecar is portable Python.

### The gap — the Rust shell is POSIX-only

Every child-process path assumes Unix:

| Concern | Where | Windows equivalent |
|---|---|---|
| Process groups (`setsid`, `kill(-pid)`) | `scheduler/mod.rs:117-152,420`, `agent/mod.rs:383-386,612,1049-1053`, `sidecar/mod.rs:389-513` | Job Objects — one per child, terminate the job |
| `std::os::unix::process::CommandExt` | `sidecar/mod.rs:333` | `CommandExt` from `std::os::windows::process` |
| `PermissionsExt` (chmod +x) | `sidecar/mod.rs:314` | not needed; drop under `cfg` |
| `Command::new("open")` reveal | `commands/docs.rs:54` | `explorer /select,` |
| Default shell / `sh -c` | `pty/`, `agent/mod.rs:1329` | `pwsh`/`cmd` selection |
| Path separators | `agent_runs_service.resolve_project_id_for_cwd` compares `cwd.startswith(f"{path}/")` | separator-agnostic compare — **this is a live bug**, it would never match on Windows |
| PTY backend | `pty/mod.rs` | ConPTY (portable-pty already abstracts it — verify) |

### B1 — Cross-platform child lifecycle

Introduce one `process_group` module with `spawn_detached(cmd) -> Child` and
`kill_group(handle, graceful)`, `#[cfg]`-split: `setsid` + signals on Unix, a Job
Object per child on Windows. Every current `libc::` call site moves behind it.
This is the load-bearing ticket — the scheduler, the agent duplex and the sidecar
supervisor all depend on group-kill semantics for correct cleanup.

### B2 — Platform paths and shells

The table's remaining rows. Includes the `resolve_project_id_for_cwd` separator
bug, which is worth fixing on its own since it is a real defect today; and
case-insensitive path comparison, since Windows paths are case-insensitive and
project matching would otherwise miss.

### B3 — Prove it

`cargo check --target x86_64-pc-windows-msvc` in CI first (catches the `cfg`
gaps without a Windows runner), then a Windows job running `make check-all`.
Windows symlink creation needs Developer Mode or admin; the hardlink/junction
fallback must be exercised deliberately, not assumed — a test that forces the
fallback path is worth more than one that happens to run as admin.

---

## Strand C — the 5 s first fresh init

### What it is not (measured, this machine, dev build)

| Phase | Measured |
|---|---|
| `import app` + `create_app()` | 0.12 s |
| Migrations on an empty DB (2 files, 836 lines) | 0.017 s |
| `command_center_service.bootstrap` (workspace + 3 org agents + 3 links) | 0.024 s |
| Second `bootstrap` (idempotent path) | 0.004 s |
| Dev sidecar spawn → `/health` 200 | 0.38 s |
| `sidecar.tar.gz` extraction (15 MB → 34 MB) | 0.19 s |

Nothing on the sidecar side accounts for seconds. The startup poller is not at
fault either: `POLL_INTERVAL` is 100 ms and the kill-and-respawn loop that once
caused a ~20 s first launch is already gone (`sidecar/mod.rs:9-28`).

### Leading hypotheses

1. **First execution of the frozen sidecar binary.** Releases are ad-hoc signed
   and not notarised (`docs/faq.md`), so macOS verifies and scans binaries on
   first execution; a freshly extracted 34 MB PyInstaller tree with a bundled
   Python framework is a large first-exec cost, paid once and then cached. This
   fits "only the first time" better than anything else measured.
2. **First paint**, not the backend: in dev, Vite transforming ~1100 modules
   cold.
3. **Onboarding work** — provider probing, or the home-directory project scan
   (measured separately at 0.5 s for depth 4, 2.6 s for depth 5).

### C1 — Instrument the startup path *(do first)*

Attribution before optimisation. Emit monotonic marks — shell start, sidecar
spawn, first TCP connect, `/health` 200, bootstrap done, frontend first paint,
onboarding ready — and log them as one line. Cheap, permanent, and it turns "5 s
somewhere" into a number per phase. Every hypothesis above is testable in one
launch once this exists.

### C2 — Fix what C1 shows

Deliberately unscoped until C1 has run. If hypothesis 1 holds, the options are
pre-warming the extracted binary during the splash, extracting at install time
rather than first launch, or signing properly — very different tickets, and
picking one now would be guessing.

---

## Order

A1 and C1 first: both are small, and C1 is a prerequisite for C2 being anything
other than a guess. B2's separator bug is worth pulling forward on its own.
Then B1 (largest, gates all Windows work), A2, B3, A3, C2.
