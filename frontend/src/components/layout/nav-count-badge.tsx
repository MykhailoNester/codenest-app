import { type ReactElement } from "react";

/**
 * The count that rides on the right-hand edge of a nav row.
 *
 * Built by #165 (epic #153) with no live data source on purpose: the design's
 * whole argument for it is that the window edge should answer "anything
 * waiting?" without a click, and the first real number is the Needs You count
 * that #162 wires in. Shipping the component now means #162 adds a hook and a
 * prop rather than a hook, a prop, a stylesheet and a render path.
 *
 * `count == null` renders nothing at all rather than a zero. A rail badge
 * showing `0` reads as "I checked, and there is nothing" — which is a claim
 * this component cannot make while no producer exists behind it, and which is
 * also wrong for a page whose designed empty state is the good outcome.
 */
export type NavCountTone = "neutral" | "warn" | "hot";

export function NavCountBadge({
  count,
  tone = "neutral",
  label,
}: {
  count: number | null | undefined;
  tone?: NavCountTone;
  /**
   * Accessible name. Pass the singular/plural form the caller wants read out —
   * the badge itself has no idea what it is counting, and "3" alone tells a
   * screen reader nothing.
   */
  label?: string;
}): ReactElement | null {
  if (count == null || count <= 0) return null;
  return (
    <span
      className={`d3-nav__count${tone === "neutral" ? "" : ` is-${tone}`}`}
      aria-label={label}
      // The count is decoration for sighted users when `label` is supplied —
      // the label already carries the meaning, so the digits would be read
      // twice without this.
      aria-hidden={label ? undefined : true}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
