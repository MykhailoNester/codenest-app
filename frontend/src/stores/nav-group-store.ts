import { useSyncExternalStore } from "react";
import type { NavGroup } from "../lib/nav-items";

// Explicit open/closed overrides per group. A group missing from this map
// falls back to its `defaultOpen` (see NAV_GROUPS) — so we only persist what
// the user has actively toggled, and changing a group's default later still
// takes effect for users who never touched it.
type Overrides = Partial<Record<NavGroup, boolean>>;

const STORAGE_KEY = "codenest:nav-groups";

function readInitial(): Overrides {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Overrides;
    return {};
  } catch {
    return {};
  }
}

let state: Overrides = typeof window === "undefined" ? {} : readInitial();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — ignore
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Overrides {
  return state;
}

function isOpen(group: NavGroup, defaultOpen: boolean): boolean {
  const override = state[group];
  return override === undefined ? defaultOpen : override;
}

function toggle(group: NavGroup, defaultOpen: boolean): void {
  // Negate the *effective* state so the first click always does the
  // visually-expected thing, even before any override exists.
  state = { ...state, [group]: !isOpen(group, defaultOpen) };
  persist();
  emit();
}

export function useNavGroups(): {
  isOpen: (group: NavGroup, defaultOpen: boolean) => boolean;
  toggle: (group: NavGroup, defaultOpen: boolean) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    isOpen: (group, defaultOpen) =>
      snap[group] === undefined ? defaultOpen : (snap[group] as boolean),
    toggle,
  };
}
