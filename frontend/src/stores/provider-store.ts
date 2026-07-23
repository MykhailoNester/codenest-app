import { useSyncExternalStore } from "react";

interface ProviderStoreState {
  activeProviderId: number | null;
}

const STORAGE_KEY = "codenest:active-provider-id";

function readInitial(): ProviderStoreState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return { activeProviderId: null };
    const parsed = JSON.parse(raw);
    if (typeof parsed === "number") return { activeProviderId: parsed };
    return { activeProviderId: null };
  } catch {
    return { activeProviderId: null };
  }
}

let state: ProviderStoreState =
  typeof window === "undefined" ? { activeProviderId: null } : readInitial();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  try {
    if (state.activeProviderId == null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(state.activeProviderId),
      );
    }
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

function getSnapshot(): ProviderStoreState {
  return state;
}

export function setActiveProvider(id: number | null): void {
  if (state.activeProviderId === id) return;
  state = { activeProviderId: id };
  persist();
  emit();
}

export function useProviderStore(): ProviderStoreState & {
  setActiveProvider: (id: number | null) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snap, setActiveProvider };
}

export function useActiveProviderId(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => state.activeProviderId,
    () => state.activeProviderId,
  );
}
