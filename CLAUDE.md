@AGENTS.md

## Claude Code notes

- The dev sidecar runs without `--reload`: after editing Python under `app/`, restart the app
  (`pnpm tauri:dev`); only the Vite frontend hot-reloads.
- Before finishing any task, run `make check-all` and report its result.
- Database schema changes: plan first. Migrations are append-only and stem-recorded — re-read
  the "Hard rules" section in AGENTS.md before touching `migrations/`.
- If you edit any file in `src-tauri/resources/org-agents/`, recompute its sha256 in
  `manifest.json` and bump the manifest `version` in the same change.
- Packaged-app debugging: the prod DB lives in
  `~/Library/Application Support/com.codenest.dashboard/` and survives reinstalls — wipe that
  directory to test a clean first run.
