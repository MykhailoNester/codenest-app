/**
 * launch-seed.ts — types and hooks for the task-launch feature.
 *
 * The `LaunchSeed` shape mirrors `app/models/launch.py:LaunchSeed`.
 * The hooks consume the sidecar endpoints added in migration 024.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchSidecar, type SidecarError } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceKind = "task" | "inbox";
export type PromptFanout = "primary" | "every" | "none";
export type LaunchTarget = "embedded" | "popout";

/** Identifies a task or inbox item as a launch source. */
export interface LaunchSource {
  kind: SourceKind;
  id: number;
}

export interface LaunchSeedSource {
  kind: SourceKind;
  id: number;
  title: string;
  url: string;
}

export interface LaunchSeedProject {
  id: number;
  name: string;
  path: string | null;
}

/** One toggleable block of the seeded prompt. Mirrors
 *  `app/models/launch.py:LaunchPromptSection`. `id` is typed `string`, not a
 *  union, so a newer sidecar's extra section (e.g. subtasks, task #27) renders
 *  from an unchanged frontend. `tokens` is an approximation — render it with a
 *  tilde. */
export interface LaunchPromptSection {
  id: string;
  label: string;
  text: string;
  tokens: number;
  default_on: boolean;
}

/** Full launch seed returned by GET /api/v1/launch/seed. */
export interface LaunchSeed {
  source: LaunchSeedSource;
  project: LaunchSeedProject | null;
  prompt: string;
  /** Ordered; `prompt` is the join of the entries with `default_on`. */
  sections: LaunchPromptSection[];
  provider_id: number;
  model: string | null;
  rows: number;
  cols: number;
  target: LaunchTarget;
  profile_id: number | null;
  extra_args: string | null;
  prompt_fanout: PromptFanout;
  has_override: boolean;
}

// ---------------------------------------------------------------------------
// Query hook
// ---------------------------------------------------------------------------

/**
 * Fetch the launch seed for a given source.
 * Disabled when `source` is null.
 * staleTime=0 ensures the seed is re-fetched each time the modal opens,
 * so the latest saved override is always reflected.
 */
export function useLaunchSeed(
  source: LaunchSource | null,
): UseQueryResult<LaunchSeed, SidecarError> {
  return useQuery<LaunchSeed, SidecarError>({
    queryKey:
      source !== null
        ? ["launch-seed", source.kind, source.id]
        : ["launch-seed", null],
    queryFn: () => {
      if (source === null) {
        return Promise.reject(new Error("no source"));
      }
      return fetchSidecar<LaunchSeed>(
        `/api/v1/launch/seed?source_kind=${source.kind}&source_id=${source.id}`,
      );
    },
    enabled: source !== null,
    staleTime: 0,
    retry: false,
  });
}
