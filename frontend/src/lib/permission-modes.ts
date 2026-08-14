/**
 * The permission modes offered for a *live* switch, in ascending order of how
 * much they let the agent do unasked. Deliberately not `agent::PERMISSION_MODES`
 * verbatim: that list is the spawn-time flag surface and includes
 * `bypassPermissions`, which the CLI refuses over the control channel unless the
 * session was launched with `--dangerously-skip-permissions` (verified against
 * CLI 2.1.220). Offering it here would be a control that fails every time it is
 * used, so it is left to the spawn path.
 *
 * `manual` is the CLI's `--help` spelling of the mode it applies as `default`,
 * which is why {@link modeSelectValue} has to treat the two as one option.
 *
 * Moved out of `components/terminal/agent-composer.tsx` (D5 in
 * `launch-composer-ui`'s plan) so the launch composer can offer the exact same
 * option set without importing a terminal component's module graph — the
 * running agent composer and the launch composer both read this file, and it
 * is the one source of truth for the list.
 */
export const LIVE_PERMISSION_MODES: ReadonlyArray<{
  value: string;
  label: string;
  title: string;
}> = [
  {
    value: "plan",
    label: "plan",
    title: "Plan mode — the agent researches and proposes, and may not edit or run anything.",
  },
  {
    value: "manual",
    label: "ask",
    title: "Ask for everything the CLI would normally ask about (the default).",
  },
  {
    value: "acceptEdits",
    label: "auto-edit",
    title: "File edits apply without asking; everything else still asks.",
  },
  {
    value: "auto",
    label: "auto",
    title:
      "The CLI decides what is safe to run unasked. Some installs gate this mode off, in which case the switch is refused.",
  },
  {
    value: "dontAsk",
    // Deliberately not ordered last and deliberately not described as "allow
    // everything": `dontAsk` is a *deny* mode. The CLI documents it as
    // "Don't prompt for permissions, deny if not pre-approved" (2.1.220), and
    // it auto-denies through the same path as a deny rule — so on a session
    // with no allow rules it refuses every Bash call without ever asking.
    // The old wording ("stop asking altogether") read as bypassPermissions and
    // sent people here for the opposite of what they wanted.
    label: "don't ask (deny)",
    title:
      "Never prompts — and denies anything your permission rules don't already allow. For a session that just runs things, pick auto-edit, auto, or restart with full access.",
  },
];

/**
 * Which option to select for the mode the session reports. The CLI normalises
 * `manual` to `default` and reports the applied value, so a session running
 * `default` must light up the `manual` option rather than falling through to
 * "no selection".
 */
export function modeSelectValue(applied: string | null): string {
  if (applied === null) return "";
  if (applied === "default") return "manual";
  return LIVE_PERMISSION_MODES.some((m) => m.value === applied) ? applied : "";
}
