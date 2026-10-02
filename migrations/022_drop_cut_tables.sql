-- Drop the tables left behind by the feature cut (#274 / #275, phase C).
--
-- The owner decided on 2026-09-29 that codenest-app is an agent-supervision
-- console, not a dashboard. #274 deleted the pages and #275 the routers and
-- services; these eight tables are what remained — no reader, no writer, in
-- any layer. Each was verified before this file was written: the only
-- surviving references were the factory-reset wipe list and the
-- `integration_catalog` reference-data seed, both removed in the same commit.
--
-- This is the one irreversible step of the cut. Deleting a page is a `git
-- revert`; dropping a table destroys whatever rows an installed copy holds,
-- and migrations here are append-only so there is no going back down. It is
-- separated from #274/#275 for exactly that reason and was not run until the
-- owner approved it explicitly.
--
-- Not dropped, though `design/review.html` listed them: `documents` (the
-- shipped `orion-ops` org agent writes to it), `library_items` (the
-- `@library:<slug>` resolver in the composer and omni-bar reads it),
-- `insight_runs` (the background insights tick still writes it, and Needs You
-- surfaces the result), `otlp_metric_series` / `otlp_span_stats` (Budgets,
-- Projects, cost reconciliation and the Session Inspector all read them), and
-- `mcp_servers` / `mcp_server_project_scopes` (still read by the Projects
-- detail panel — their writer is gone, which is a product decision on the
-- board rather than something to settle with a DROP).
--
-- `IF EXISTS` on every statement: a database that never ran the baseline far
-- enough to create one of these, or that already dropped it by hand, must
-- still apply this file. The runner uses `executescript`, so one failure
-- would abort the rest.
--
-- Children before parents, so no drop leaves a dangling reference:
-- `parallel_run_attempts` references `parallel_runs`.

DROP TABLE IF EXISTS parallel_run_attempts;
DROP TABLE IF EXISTS parallel_runs;
DROP TABLE IF EXISTS marketplace_installs;
DROP TABLE IF EXISTS plugins;
DROP TABLE IF EXISTS sync_snapshots;
DROP TABLE IF EXISTS sync_targets;
DROP TABLE IF EXISTS preview_visits;
DROP TABLE IF EXISTS integration_catalog;
