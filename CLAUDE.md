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
  directory to test a clean first run. That wipe is safe for real dev task data: the `work`
  profile keeps its own root (see below).
- This machine runs `pnpm tauri:dev` under `CODENEST_ENV=work` via the gitignored `.env.local`,
  so the dev app opens the persistent workboard at
  `~/Library/Application Support/com.codenest.dev/codenest.db`. Treat it as real data — it is
  not the demo DB and `make seed-demo` never writes to it. To run against demo instead for a
  one-off, prefix the command: `CODENEST_ENV=demo pnpm tauri:dev` (the shell wins over the file).
