@AGENTS.md

## Claude Code notes

- Before finishing any task, run `make check-all` and report its result.
- Database schema changes: plan first. Migrations are append-only and stem-recorded — re-read
  the "Hard rules" section in AGENTS.md before touching `migrations/`.
- Packaged-app debugging: the prod DB lives in
  `~/Library/Application Support/com.codenest.dashboard/` and survives reinstalls — wipe that
  directory to test a clean first run. That wipe is safe for real dev task data: the `work`
  profile keeps its own root (see below).
- Check `.env.local` before touching data: when it pins `CODENEST_ENV=work`, `pnpm tauri:dev`
  opens the persistent workboard at
  `~/Library/Application Support/com.codenest.dev/codenest.db`. Treat it as real data — it is
  not the demo DB and `make seed-demo` never writes to it. To run against demo instead for a
  one-off, prefix the command: `CODENEST_ENV=demo pnpm tauri:dev` (the shell wins over the file).
