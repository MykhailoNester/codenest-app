/**
 * Hooks — what is actually on each Claude Code hook event (#171).
 *
 * The frontend surface for work already merged: the effective-hooks read
 * (#169) and the write-through install with its dry run (#170). It adds no
 * endpoint and owns no state; everything on it is a rendering of two responses.
 *
 * The framing the whole page turns on
 * ----------------------------------
 * **Hooks merge, and every one of them runs.** A hook block declared in one
 * place never stands in for a block declared in another — the harness collects
 * them from all eight contributors and runs all of them. So the question this
 * page answers is never "which file supplies this event's hooks"; it is "how
 * many separate processes sit on this event's critical path, and which file put
 * each one there". Five hooks on `PreToolUse` means five processes spawned
 * before every single tool call, whether or not whoever added the fifth knew
 * about the other four.
 *
 * The settings resolution order (user, project, project-local, `--settings`,
 * managed policy) decides a *scalar* setting — a model name, a permission mode.
 * It has no bearing on how hooks accumulate, and no copy on this page may imply
 * it does. `__tests__/hooks-page.test.tsx` greps this file and `hooks-copy.ts`
 * for that vocabulary, the same guard `tests/sidecar/test_effective_hooks.py`
 * holds the sidecar modules to.
 *
 * Three things the page must get right, all of them ways it could lie
 * -------------------------------------------------------------------
 * * **Eight sources, not seven, and the empty ones stay on screen.** Five
 *   settings scopes plus plugin `hooks.json`, skill frontmatter and agent
 *   definitions. A bucket that vanished when empty would make an event look as
 *   if it had fewer possible origins than it has.
 * * **`--settings` renders as unknown, never as zero.** The path is chosen in
 *   the argv of the process that ran the hook, which the sidecar never sees. It
 *   arrives with `observable: false` and `count: 0`; printing that 0 would
 *   assert something the report explicitly says it cannot know. It is also why
 *   every total on this page is a floor.
 * * **No duration, anywhere.** Hook timing is not derivable from hooks or
 *   transcripts and needs the harness to emit it. `timeout_seconds` is the
 *   ceiling a config file declares and is labelled as configured, never as how
 *   long anything took.
 *
 * Scope is one config home and at most one project, not a union
 * ------------------------------------------------------------
 * A session runs with one `CLAUDE_CONFIG_DIR` inside one repository, and that
 * pair is the real hook set. Scanning every config home at once would add up
 * hooks no single session ever runs, and the page's central number would stop
 * being true of anything.
 */

import { useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useEffectiveHooks,
  useHookInstallPlan,
  useInstallHooks,
  useProjects,
  useProviders,
  type EffectiveHookEvent,
  type EffectiveHooksReport,
  type HookInstallReport,
  type HookInstallResult,
} from "../lib/api";
import { DeckShell } from "../components/deck/deck-shell";
import { DeckGrid, DeckGroup, DeckHead, DeckLine } from "../components/deck/deck-grid";

const COLS_SOURCE = "14px 220px minmax(0, 1fr) 90px";
const COLS_HOOK = "14px minmax(0, 1fr) 320px 90px";
import {
  commandLabel,
  redactionNote,
  timeoutLabel,
  CONTRIBUTOR_SOURCE_COUNT,
  eventTotal,
  eventTotalLabel,
  planHeadline,
  planSummary,
  scanCopy,
  scanIsIncomplete,
  staleFindings,
} from "./hooks-copy";

/** The sidecar resolves an empty config home to `~/.claude`. */
const DEFAULT_CONFIG_HOME = "";
const DEFAULT_CONFIG_HOME_LABEL = "~/.claude (default)";

function configHomeLabel(home: string): string {
  return home === DEFAULT_CONFIG_HOME ? DEFAULT_CONFIG_HOME_LABEL : home;
}

export function HooksPage(): ReactElement {
  const providers = useProviders(true);
  const projects = useProjects();

  // Config homes offered: the default, plus whatever the configured providers
  // actually pin via CLAUDE_CONFIG_DIR. Deliberately not the sidecar's
  // `config-homes` discovery list — that globs every `~/.claude*` directory on
  // the machine, including ones nothing runs under.
  const configHomes = useMemo(() => {
    const seen = new Set<string>([DEFAULT_CONFIG_HOME]);
    for (const p of providers.data ?? []) {
      const home = (p.default_env["CLAUDE_CONFIG_DIR"] ?? "").trim();
      if (home) seen.add(home.replace(/\/+$/, ""));
    }
    return [...seen];
  }, [providers.data]);

  const projectRoots = useMemo(
    () =>
      (projects.data ?? [])
        .filter((p) => !p.is_workspace)
        .map((p) => ({
          name: p.name,
          root: (p.root_path ?? p.path ?? "").trim(),
        }))
        .filter((p) => p.root !== ""),
    [projects.data],
  );

  // Selection is an override over a derived default rather than state seeded
  // from a query — mirroring FeaturesTab, which avoids the effect→setState
  // cycle the repo lints against.
  const [configHomeOverride, setConfigHomeOverride] = useState<string | null>(
    null,
  );
  const [projectRootOverride, setProjectRootOverride] = useState<string | null>(
    null,
  );
  const configHome =
    configHomeOverride !== null && configHomes.includes(configHomeOverride)
      ? configHomeOverride
      : (configHomes[0] ?? DEFAULT_CONFIG_HOME);
  const projectRoot = projectRootOverride ?? "";

  const effective = useEffectiveHooks({
    config_homes: [configHome],
    project_roots: projectRoot ? [projectRoot] : [],
  });
  const plan = useHookInstallPlan([configHome]);

  return (
    <DeckShell
      title="hooks"
      crumb="the lane needs you depends on"
      actions={
        <span className="dk-actions">
          <button
            type="button"
            className="dk-btn"
            onClick={() => void plan.refetch()}
            disabled={plan.isFetching}
          >
            {plan.isFetching ? "verifying…" : "verify"}
          </button>
        </span>
      }
    >
      <>
        <header>
          <p className="dk-note sans">
            Hook blocks from every source are merged, and at event time every
            hook that was collected runs. So what matters is not where an
            event&rsquo;s hooks come from but how many separate programs sit on
            its critical path — and which file put each one there. There are{" "}
            {CONTRIBUTOR_SOURCE_COUNT} places a hook can come from; all{" "}
            {CONTRIBUTOR_SOURCE_COUNT} are listed on every event below,
            including the ones with nothing in them.
          </p>
        </header>

        <div className="dk-actions">
          <div className="dk-actions">
            <label className="dim" htmlFor="hooks-config-home">
              Config home
            </label>
            <select
              id="hooks-config-home"
              className="dk-rowsel"
              value={configHome}
              onChange={(e) => setConfigHomeOverride(e.target.value)}
            >
              {configHomes.map((home) => (
                <option key={home || "__default__"} value={home}>
                  {configHomeLabel(home)}
                </option>
              ))}
            </select>
          </div>
          <div className="dk-actions">
            <label className="dim" htmlFor="hooks-project-root">
              Project
            </label>
            <select
              id="hooks-project-root"
              className="dk-rowsel"
              value={projectRoot}
              onChange={(e) => setProjectRootOverride(e.target.value)}
            >
              <option value="">No project (config home only)</option>
              {projectRoots.map((p) => (
                <option key={p.root} value={p.root}>
                  {p.name} — {p.root}
                </option>
              ))}
            </select>
          </div>
          <div className="dk-actions">
            <button
              type="button"
              className="dk-btn"
              onClick={() => {
                void effective.refetch();
                void plan.refetch();
              }}
              disabled={effective.isFetching}
            >
              {effective.isFetching ? "Reading…" : "Re-read files"}
            </button>
          </div>
          <p className="dk-note sans">
            One config home and one project at a time: that pair is what a real
            session runs under. Adding several together would count hooks no
            single session ever runs.
          </p>
        </div>

        <StaleInstallBanner plan={plan.data} />

        {effective.isError ? (
          <div className="dk-note sans" style={{ borderLeft: "2px solid var(--warn)" }}>
            <div className="sub">
              Could not read the hook configuration
            </div>
            <div className="dim">{effective.error.message}</div>
          </div>
        ) : null}

        {effective.isPending ? (
          <div className="dk-note">Reading the config files…</div>
        ) : effective.data ? (
          <>
            <Counters report={effective.data} />
            <section>
              <h2 className="dk-group__h">Events</h2>
              <p className="dk-note sans">
                Every event this app ingests, with the number of hooks found on
                it. The number is a floor, not a ceiling: one of the{" "}
                {CONTRIBUTOR_SOURCE_COUNT} sources is a settings file named on
                the command line, which this app cannot read.
              </p>
              <div className="">
                {effective.data.events.map((event) => (
                  <EventRow key={event.event} event={event} />
                ))}
              </div>
            </section>

            <InstallCard
              configHome={configHome}
              planResult={plan.data?.results[0]}
            />

            <ScannedFiles report={effective.data} />
            <SourceLegend report={effective.data} />
          </>
        ) : null}
      </>
    </DeckShell>
  );
}

// ─── counters ────────────────────────────────────────────────────────────────

function Counters({ report }: { report: EffectiveHooksReport }): ReactElement {
  const found = report.events.reduce((sum, e) => sum + e.total, 0);
  const busiest = report.events.reduce<EffectiveHookEvent | null>(
    (best, e) => (best === null || e.total > best.total ? e : best),
    null,
  );
  const unreadable = report.sources.filter((s) => !s.observable);

  return (
    <div className="dk-bigs">
      <div className="dk-big">
        <div className="v">{found}</div>
        <div className="l">hooks found across {report.events.length} events</div>
      </div>
      <div className="dk-big">
        <div className="v">{busiest && busiest.total > 0 ? busiest.total : 0}</div>
        <div className="l">
          {busiest && busiest.total > 0 ? `busiest · ${busiest.event}` : "busiest event"}
        </div>
      </div>
      <div className="dk-big">
        <div className={unreadable.length > 0 ? "v" : "v na"}>{unreadable.length}</div>
        <div className={unreadable.length > 0 ? "l warn" : "l"}>
          {unreadable.length > 0
            ? `unreadable · ${unreadable.map((s2) => s2.label).join(", ")}`
            : "every source readable"}
        </div>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: EffectiveHookEvent }): ReactElement {
  const { found } = eventTotal(event);
  const contributions = event.by_source.flatMap((b) =>
    b.contributions.map((c) => ({ bucket: b, c })),
  );

  return (
    <DeckGroup
      label={event.event}
      count={eventTotalLabel(event)}
      note={event.tier}
      state={found === 0 ? "idle" : "run"}
      collapsible
      defaultOpen={false}
    >
      {/* Every source is listed, including the empty ones — the point of the
          page is which files sit on an event's critical path, and a source
          omitted because it was empty would read as a source that was checked
          and found clean. An unreadable one says so and never shows a number. */}
      <DeckGrid cols={COLS_SOURCE} label={`${event.event} sources`}>
        <DeckHead cells={["source", "contribution", "r hooks"]} />
        {event.by_source.map((bucket) => (
          <DeckLine
            key={bucket.source}
            state={!bucket.observable ? "fail" : bucket.count > 0 ? "run" : "idle"}
            cells={[
              { v: bucket.label, cls: "sub" },
              { v: bucket.observable ? (bucket.count === 0 ? "nothing" : `${bucket.count} found`) : "unknown — this app cannot read it" },
              { v: bucket.observable ? bucket.count || "—" : "unknown", cls: "r" },
            ]}
          />
        ))}
      </DeckGrid>

      {contributions.length === 0 ? (
        <div className="dk-note">
          Nothing was found on this event in any source this app can read.
        </div>
      ) : (
        <DeckGrid cols={COLS_HOOK} label={`${event.event} hooks`}>
          <DeckHead cells={["runs", "from", "r timeout"]} />
          {contributions.map(({ bucket, c }, i) => (
            <DeckLine
              key={`${bucket.source}-${i}-${c.origin}`}
              state={c.codenest_authored ? "done" : "run"}
              cells={[
                {
                  v: (
                    <>
                      <span className="mono">{commandLabel(c)}</span>{" "}
                      <span className="dk-tag">
                        {c.codenest_authored ? "written by this app" : c.hook_type}
                      </span>
                    </>
                  ),
                  title: redactionNote(c) ?? commandLabel(c),
                },
                {
                  v: `${bucket.label}${c.matcher ? ` · matcher ${c.matcher}` : ""} · ${c.origin}`,
                },
                { v: timeoutLabel(c) ?? "—", cls: "r" },
              ]}
            />
          ))}
        </DeckGrid>
      )}

      {/* Said out loud, because a page about what runs on your machine must not
          quietly hide a command's arguments without explaining that it did. */}
      {contributions.some((x) => redactionNote(x.c)) ? (
        <div className="dk-note sans">
          {contributions.map((x) => redactionNote(x.c)).find(Boolean)}
        </div>
      ) : null}
    </DeckGroup>
  );
}

function StaleInstallBanner({
  plan,
}: {
  plan: HookInstallReport | undefined;
}): ReactElement | null {
  const findings = staleFindings(plan);
  if (findings.length === 0) return null;
  const alarming = findings.filter((f) => f.discardsPermissionDecisions);

  return (
    <>
      {alarming.map((f) => (
        <div
          key={`alarm-${f.settingsPath}`}
          className="dk-note sans" style={{ borderLeft: "2px solid var(--err)" }}
        >
          <div className="sub">
            Your permission decisions are being thrown away
          </div>
          <div className="dim">
            The <code>PreToolUse</code> hook in <code>{f.settingsPath}</code>{" "}
            was written by this app before it learned to read a hook&rsquo;s
            answer back. It still sends every tool call to the app, and the app
            still computes an answer — but the command discards its own output,
            so every standing permission rule you have written is computed and
            then thrown away. Nothing reports this: the hook is present and
            correctly targeted, so a verify pass grades it fine. Repair it
            below.
          </div>
          {f.events.length > 1 ? (
            <div className="dim">
              {f.events.length - 1} other hook
              {f.events.length === 2 ? "" : "s"} in the same file came from the
              same older version (
              {f.events.filter((e) => e !== "PreToolUse").join(", ")}). Those
              still do what they were written to do; repairing rewrites them
              too.
            </div>
          ) : null}
        </div>
      ))}
      {findings
        .filter((f) => !f.discardsPermissionDecisions)
        .map((f) => (
          <div
            key={`stale-${f.settingsPath}`}
            className="dk-note sans" style={{ borderLeft: "2px solid var(--warn)" }}
          >
            <div className="sub">
              Hooks this app wrote are in an older shape
            </div>
            <div className="dim">
              {f.events.join(", ")} in <code>{f.settingsPath}</code> came from
              an earlier version of this app. They still run; repairing them
              below rewrites them in place and touches nothing else in the file.
            </div>
          </div>
        ))}
    </>
  );
}

function InstallCard({
  configHome,
  planResult,
}: {
  configHome: string;
  planResult: HookInstallResult | undefined;
}): ReactElement {
  const install = useInstallHooks();
  const [confirming, setConfirming] = useState(false);

  if (!planResult) {
    return (
      <section>
        <h2 className="dk-group__h">This app&rsquo;s own hooks</h2>
        <div className="dk-note">Checking what would change…</div>
      </section>
    );
  }

  const summary = planSummary(planResult);
  const applied = install.data?.results[0];

  return (
    <section>
      <h2 className="dk-group__h">This app&rsquo;s own hooks</h2>
      <p className="dk-note sans">
        A dry run of what installing or repairing would do to{" "}
        <code>{planResult.settings_path}</code>. Nothing below has been written.
      </p>
      {/*
        The only pointer to #179's surface, and it belongs here: this page is
        where a user learns that this app writes their settings.json, and the
        `env` block is the other thing it writes into the same file. The
        telemetry screen itself lives in Settings, which — unlike this page —
        cannot be switched off in Features, so the path to turning telemetry
        back off can never disappear. See `telemetry-tab.tsx`'s header.
      */}
      <p className="dk-note sans">
        This app writes one other thing into this same file: the environment
        variables that turn Claude Code telemetry on and point it here. Those
        live in Settings &rarr; Telemetry, with their own dry run, their own
        confirm and a real off switch.
      </p>
      <div className="dk-group">
        <div className="dim">{planHeadline(planResult)}</div>

        <div className="dim">
          {summary.ok} event{summary.ok === 1 ? "" : "s"} already current ·{" "}
          {summary.add} would be added · {summary.repair} would be rewritten ·{" "}
          {summary.conflict} left alone with a reason · {summary.left} hook
          {summary.left === 1 ? "" : "s"} this app did not write would be left
          exactly where they are
        </div>

        {summary.repair > 0 || summary.add > 0 || summary.conflict > 0 ? (
          <div className="">
            {planResult.events
              .filter((e) => e.action !== "ok")
              .map((e) => (
                <div key={e.event} className="dk-kv">
                  <div className="dim">
                    <span className="mono">{e.event}</span>
                    <span className="dk-tag">{e.action}</span>
                  </div>
                  {e.detail ? (
                    <div className="dim">{e.detail}</div>
                  ) : null}
                </div>
              ))}
          </div>
        ) : null}

        {planResult.status === "refused" ? (
          <div className="dim">
            This file cannot be written, so there is nothing to confirm.
          </div>
        ) : !summary.changes ? (
          <div className="dim">
            Nothing to do. Running the install would rewrite nothing.
          </div>
        ) : !confirming ? (
          <div className="dk-actions">
            <button
              type="button"
              className="dk-btn"
              onClick={() => setConfirming(true)}
            >
              {summary.repair > 0
                ? "Repair these hooks…"
                : "Install these hooks…"}
            </button>
          </div>
        ) : (
          <div className="dk-note sans" style={{ borderLeft: "2px solid var(--run)" }}>
            <div className="sub">
              Write to {planResult.settings_path}?
            </div>
            <div className="dim">
              This is the one file every hook every tool has ever installed
              lives in. A timestamped copy of the current contents is written
              beside it before anything changes, and the path of that copy is
              reported back here. Hooks this app did not write are not moved,
              rewritten or reordered.
            </div>
            <div className="dk-actions">
              <button
                type="button"
                className="dk-btn"
                disabled={install.isPending}
                onClick={() =>
                  install.mutate(
                    { config_homes: [configHome] },
                    {
                      onSuccess: (r) => {
                        setConfirming(false);
                        toast.success(
                          r.overall === "applied"
                            ? "settings.json updated"
                            : `Install finished: ${r.overall}`,
                        );
                      },
                      onError: (e) =>
                        toast.error(`Install failed: ${e.message}`),
                    },
                  )
                }
              >
                {install.isPending ? "Writing…" : "Yes, write the file"}
              </button>
              <button
                type="button"
                className="dk-btn"
                onClick={() => setConfirming(false)}
                disabled={install.isPending}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {applied ? (
          <div className="dim">
            {applied.status === "applied"
              ? `Written. Previous contents saved to ${applied.backup_path ?? "(no backup — the file did not exist)"}.`
              : `No write was needed (${applied.status}).`}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ─── scanned files ───────────────────────────────────────────────────────────

function ScannedFiles({
  report,
}: {
  report: EffectiveHooksReport;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const incomplete = scanIsIncomplete(report.scanned);

  return (
    <section>
      <h2 className="dk-group__h">Files read</h2>
      <p className="dk-note sans">
        {incomplete
          ? "Something in this scan could not be read, so the counts above are missing whatever it declared."
          : "Every file this scan opened, and how that went. A file that is missing and a file that is malformed both produce no hooks and mean very different things."}
      </p>
      <div className="dk-group">
        <div className="dk-actions">
          <button
            type="button"
            className="dk-btn"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open
              ? "Hide the file list"
              : `Show all ${report.scanned.length} files`}
          </button>
        </div>
        {open
          ? report.scanned.map((f, i) => {
              const copy = scanCopy(f);
              const toneState =
                copy.tone === "ok" ? "done" : copy.tone === "warn" ? "wait" : "idle";
              return (
                <div key={`${f.path}-${i}`} className="dk-kv">
                  <span className="dk-tag" data-s={toneState}>{copy.label}</span>
                  <span className="mono">{f.path}</span>
                  {f.detail ? (
                    <span className="dim">{f.detail}</span>
                  ) : null}
                </div>
              );
            })
          : null}
      </div>
    </section>
  );
}

// ─── the eight sources ───────────────────────────────────────────────────────

function SourceLegend({
  report,
}: {
  report: EffectiveHooksReport;
}): ReactElement {
  return (
    <section>
      <h2 className="dk-group__h">
        The {CONTRIBUTOR_SOURCE_COUNT} places a hook can come from
      </h2>
      <p className="dk-note sans">
        Five of them are settings files; the other three are not settings files
        at all, which is what makes them easy to miss. Each one adds to what the
        others declared.
      </p>
      <div>
        {/* `.dk-kv` is a two-column grid (96px label, then the value). Passing
            a third child put the note on an implicit row in the 96px column,
            where it wrapped one word per line. Path and note share the value
            cell instead, and the label is a `span` so `.dk-kv > span:first-child`
            actually styles it. */}
        {report.sources.map((s) => (
          <div key={s.slug} className="dk-kv">
            <span>
              {s.label}
              {s.observable ? "" : " — contribution unknown"}
            </span>
            <div>
              <div className="mono dim">{s.where}</div>
              <div className="dim">{s.note}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default HooksPage;
