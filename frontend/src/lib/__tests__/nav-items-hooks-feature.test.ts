/**
 * The `hooks` nav slug, in all four places it has to appear (#171).
 *
 * AGENTS.md's "Frontend chrome renders only from known-good state" rule is not
 * advisory: a slug missing from `KNOWN_FEATURES_ORDERED` never appears in the
 * Settings → Features list, so it can never be switched on, and a slug missing
 * from the sidecar's `KNOWN_FEATURES` is stripped from the resolved map on
 * every read — either way the page is unreachable and nothing says why.
 *
 * The two frontend constants are checked by importing them. The two Python
 * constants are checked by reading `app/services/settings_service.py` as text,
 * which is the only way one vitest process can see the other half of a mirror
 * that has no runtime link. It is a coarse check on purpose: it asks whether
 * the slug is present in each list, which is exactly the failure mode that
 * makes the page unreachable.
 */

// prettier-ignore
// @ts-expect-error -- node builtins are outside this project's type roots
import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";
import {
  FEATURE_DEFAULTS,
  FEATURES,
  KNOWN_FEATURES_ORDERED,
  NAV_ITEMS,
} from "../nav-items";

const readFile = readFileSync as (path: string, encoding: "utf8") => string;
declare const process: { cwd(): string };

/** Vitest's cwd is the vite root (`frontend`); the sidecar is its sibling. */
const SETTINGS_SERVICE = `${process.cwd()}/../app/services/settings_service.py`;

describe("nav-items — the hooks feature", () => {
  it("is in FEATURE_DEFAULTS", () => {
    expect(
      Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, "hooks"),
    ).toBe(true);
  });

  it("is in KNOWN_FEATURES_ORDERED, which drives the Features toggle list", () => {
    expect(KNOWN_FEATURES_ORDERED).toContain("hooks");
  });

  it("gates exactly the /hooks nav slug", () => {
    expect(FEATURES["hooks"]).toEqual(["hooks"]);
  });

  it("has a nav item with a route and an icon key that exists", () => {
    const item = NAV_ITEMS.find((n) => n.slug === "hooks");
    expect(item).toBeTruthy();
    expect(item?.path).toBe("/hooks");
    // `Icon` renders null for a name it does not know, so an invented key would
    // draw nothing at all rather than fail.
    expect(item?.icon).toBe("zap");
  });
});

describe("settings_service.py — the sidecar half of the mirror", () => {
  const source = readFile(SETTINGS_SERVICE, "utf8");

  it("carries the slug in KNOWN_FEATURES", () => {
    const block = source.slice(
      source.indexOf("KNOWN_FEATURES: frozenset[str]"),
      source.indexOf("_RETIRED_FEATURES"),
    );
    expect(block).toContain('"hooks"');
  });

  it("carries the slug in _FEATURES_DEFAULT with the same default as the client", () => {
    const start = source.indexOf("_FEATURES_DEFAULT: dict[str, bool]");
    const block = source.slice(
      start,
      source.indexOf("def _validate_features_setting"),
    );
    expect(block).toMatch(/"hooks":\s*True/);
    expect(FEATURE_DEFAULTS["hooks"]).toBe(true);
  });
});
