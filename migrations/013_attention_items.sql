-- attention_items (epic #153 / #162): the one place a condition that wants a
-- human is recorded, so "is anything waiting on me?" is a single query rather
-- than five screens.
--
-- Today the four conditions this table collects are each buried somewhere
-- else, in a shape only that screen understands: a session that went quiet
-- mid-work is a row in the sessions list that looks exactly like a session
-- that finished cleanly, a failed scheduled run is a `schedule_runs.status`
-- nobody reads until they open Schedules, a crossed budget threshold is a
-- notification that has already scrolled away, and a blocked task is a column
-- on the Work board. None of them roll up, so the answer to "anything waiting?"
-- is four clicks and a judgement call.
--
-- What a row *is*
-- ---------------
-- One row is one *condition*, not one event. The condition is named by
-- `dedup_key` — `session_stalled:<session_id>`, `task_blocked:<task_id>`,
-- `inbox_backlog` — and the row is the ledger of that condition's life: when
-- it was first seen, how many refreshes have seen it since (`seen_count`),
-- whether it is still current (`state`), and how it ended (`resolution`). A
-- refresh that finds the same condition a second time must therefore *not*
-- mint a second row; that is what the partial unique index below enforces.
--
-- NO `lane` column, deliberately
-- ------------------------------
-- Every other table this epic adds carries the lane that wrote it, because
-- their rows are *observations*: a token count, a branch name, a compaction
-- boundary — facts one lane saw and another lane might contradict, which is
-- what `session_field_provenance` (012) exists to arbitrate. An attention item
-- is not an observation. It is a *derived judgement* over whatever the ledger
-- already holds, computed here in `attention_service` from rows the lanes have
-- already reconciled. Asking which lane produced it is a category error: the
-- answer is always "none of them, this module did", and a column whose value
-- is constant is a column that will eventually be filled in wrongly. The
-- producer that computed it is `kind`, which is the question anyone actually
-- asks.
--
-- `state`, and why muting is a state rather than a flag
-- ----------------------------------------------------
-- `open` — current, and on the page. `resolved` — the condition went away (or
-- someone dealt with it); kept, not deleted, because "resolved today, median
-- 3m" is a number the page shows and because a condition that resolves and
-- returns is a different and more interesting thing than one that never left.
-- `muted` — still true, deliberately not shown until `muted_until`. Three
-- values rather than `open` + a `muted` boolean, because the states are
-- mutually exclusive and a boolean pair admits the nonsense fourth
-- combination (resolved *and* muted) that every reader would then have to
-- decide what to do with.
--
-- The partial unique index: upsert-then-recur
-- ------------------------------------------
-- `idx_attention_live_dedup` is UNIQUE over `dedup_key` but only where the row
-- is **not resolved**. That single predicate buys both halves of the behaviour
-- this table needs, without any read-modify-write race in the service:
--
--   * A condition that is still true on the next refresh collides with its own
--     live row, so the write becomes `ON CONFLICT DO UPDATE` — `seen_count` is
--     bumped and `last_seen_at` moves. A session that has been stalled for an
--     hour is one row that has been seen 120 times, not 120 rows.
--   * A condition that was resolved and then becomes true again does *not*
--     collide (the old row is excluded from the index), so it mints a NEW row
--     with `seen_count = 1`. That is the honest record: the second occurrence
--     is a new occurrence, and flipping the old row back to `open` would
--     silently destroy the fact that it had ended and rewrite its age.
--
-- The predicate is `state <> 'resolved'` rather than `state = 'open'` on
-- purpose. Were it the latter, muting an item would take it out of the index
-- and the very next refresh would mint a duplicate `open` row for the
-- condition the user just asked to be quiet about — which is precisely the
-- opposite of what mute means.
--
-- The five P2-forward columns
-- ---------------------------
-- `hook_event`, `requires_response`, `response_json`, `responded_at` and
-- `expires_at` are unused by P1 and are here anyway, because P2's blocking
-- sources (`PermissionRequest`, `Notification`, `Elicitation`) are *rows in
-- this table* written from a hook handler. Adding them now costs five nullable
-- columns; adding them later costs a migration that has to run against a
-- populated table while a hook is trying to write to it. They record the hook
-- that raised the item, whether it is waiting on an answer, the answer, when
-- it was given, and when the item stops being worth answering — the last one
-- because a permission prompt whose session has already moved on must age out
-- rather than sit on the page forever.
--
-- No foreign keys, following `session_field_provenance` (012) and
-- `session_project_costs`. `session_id`, `project_id`, `task_id` and
-- `schedule_id` are subject pointers, all nullable, and a row must outlive its
-- subject: an item that says "this session stalled" is still the truth after
-- the session row is pruned, and the P2 writers run inside hook handlers where
-- an FK check is one more way for a hook to fail. Referential nulls are
-- handled in the read path, which LEFT JOINs and degrades to a plain title.
--
-- No CHECK constraints on `kind`, `severity` or `state`, for the reason 009,
-- 010, 011, 012 and 014 all give: SQLite's `ALTER TABLE ADD COLUMN` CHECK
-- support is version-dependent and all three vocabularies still widen (P2 adds
-- three producers and the `blocking` severity's first real source).
-- Enforcement is in the service layer — `attention_service.KINDS`,
-- `SEVERITIES` and `STATES` gate every write.
--
-- No rows are inserted by this file: every row is derived, so a freshly
-- migrated database ships this table empty and the clean-slate invariant
-- holds.

CREATE TABLE IF NOT EXISTS attention_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Which producer computed this row: session_stalled | schedule_failed |
    -- budget_threshold | task_blocked | inbox_backlog (P2 adds more).
    kind              TEXT    NOT NULL,
    -- blocking (something cannot continue) | stalled (nothing is moving) |
    -- queued (wants you eventually). Drives the page's grouping and the rail.
    severity          TEXT    NOT NULL DEFAULT 'queued',
    state             TEXT    NOT NULL DEFAULT 'open',
    -- Stable name of the *condition*, not of this row. See the index below.
    dedup_key         TEXT    NOT NULL,
    seen_count        INTEGER NOT NULL DEFAULT 1,
    title             TEXT    NOT NULL,
    -- One line of context under the title. Enrichment, never a precondition:
    -- a producer that could not enrich still produces its item.
    detail            TEXT,
    -- Subject pointers. Nullable, no FKs; see the header.
    session_id        TEXT,
    project_id        INTEGER,
    task_id           INTEGER,
    schedule_id       INTEGER,
    -- Producer-specific extras the page reads but never filters on.
    payload_json      TEXT,
    first_seen_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at       TIMESTAMP,
    -- Why it ended. P1 writes only 'condition_cleared' (the producer stopped
    -- seeing it); P2 adds the human verbs.
    resolution        TEXT,
    muted_until       TIMESTAMP,
    -- ── P2-forward (unused by P1; see the header) ──
    hook_event        TEXT,
    requires_response INTEGER NOT NULL DEFAULT 0,
    response_json     TEXT,
    responded_at      TIMESTAMP,
    expires_at        TIMESTAMP
);

-- Upsert-then-recur. UNIQUE over live rows only, so a recurring condition
-- collides with itself (bump `seen_count`) while a resolved-then-recurring
-- condition does not (mint a new row with `seen_count = 1`).
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_live_dedup
    ON attention_items(dedup_key) WHERE state <> 'resolved';

-- The page's own read: open items, grouped by severity, oldest first.
CREATE INDEX IF NOT EXISTS idx_attention_state_severity
    ON attention_items(state, severity, first_seen_at);

-- The refresh's auto-resolve sweep: "which of MY kind's live rows did this
-- pass not see again". Producer-scoped so one producer's sweep can never
-- resolve another producer's items.
CREATE INDEX IF NOT EXISTS idx_attention_kind_state
    ON attention_items(kind, state);
