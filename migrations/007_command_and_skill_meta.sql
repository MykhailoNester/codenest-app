-- Frontmatter meta for project commands and skills: what a `/` menu row says.
--
-- The composer's slash menu offers a project's own `.claude/commands/` entries
-- alongside the three built-ins (#47), and a row that carries only a name is
-- barely worth offering — `/ship` tells you nothing about what it ships. Claude
-- Code commands already declare `description:` and `argument-hint:` in their
-- frontmatter (every command in this repo does), so the scan that discovers the
-- file reads them and they land here, exactly as `project_agents.description`
-- has always worked.
--
-- `argument_hint` is commands-only on purpose: it is the CLI's own frontmatter
-- key (`argument-hint`), and a skill declares no arguments to hint at. Skills
-- get `description` alone, which is what the `@`-menu's skill rows have been
-- showing as an empty meta since the catalog landed (#44 left a TODO in
-- `command_center_service._workspace_invocables` pointing here).
--
-- Both columns are nullable with no default: a command file with no frontmatter
-- is still a perfectly invocable command, and NULL is how the catalog says "no
-- description" today. Plain ADD COLUMN, so no table rebuild and no data motion
-- — nothing about the existing columns, constraints or indexes changes.

ALTER TABLE project_commands ADD COLUMN description   TEXT;
ALTER TABLE project_commands ADD COLUMN argument_hint TEXT;

ALTER TABLE project_skills   ADD COLUMN description   TEXT;
