import { useSyncExternalStore } from "react";

interface ProfileStoreState {
  activeProfileId: number | null;
}

let state: ProfileStoreState = { activeProfileId: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ProfileStoreState {
  return state;
}

export function setActiveProfile(id: number | null): void {
  if (state.activeProfileId === id) return;
  state = { activeProfileId: id };
  emit();
}

export function useProfileStore(): ProfileStoreState & {
  setActiveProfile: (id: number | null) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snap, setActiveProfile };
}

export function useActiveProfileId(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => state.activeProfileId,
    () => state.activeProfileId,
  );
}
