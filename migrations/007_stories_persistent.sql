-- 007: a story becomes the persistent object; a session becomes a chunk of work
-- on it. Phase 2, step 1 of 3. Schema + backfill only — no code reads these
-- columns until Phase 3, so app behavior is unchanged after this runs.
--
-- Safe to run on prod: every change is additive, the backfill only SETs a new
-- nullable column, and the unique index was verified against the 2026-09-07
-- snapshot (79 session_logs rows, no duplicate session_id).

-- ── stories: coaching state + lifecycle ─────────────────────────────────────
alter table public.stories
  -- 'in_progress' | 'complete'. Default 'complete' so every existing row (all
  -- written at save time from a finished session) is correct with no backfill.
  -- Reopen-for-polish keeps a story 'complete'; entitlement gates the session.
  add column if not exists status text not null default 'complete',
  -- Moved up from session level so a resumed session starts where the last
  -- one ended instead of re-asking everything.
  add column if not exists star_sections      jsonb,
  add column if not exists extracted_question text,   -- locked forever once captured (off_topic guard)
  add column if not exists target_company     text,
  add column if not exists extracted_flags    jsonb,
  add column if not exists updated_at         timestamptz not null default now(),
  -- One-tab lock: null when no session is open; stale after ~90s without a beat.
  add column if not exists active_session_id  text,
  add column if not exists last_heartbeat_at  timestamptz,
  -- Provenance (which purchase this story was built under), NOT the ledger —
  -- consumption events live in story_consumptions (008). FK added in 008 once
  -- purchases exists.
  add column if not exists purchase_id        uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stories_status_check') then
    alter table public.stories
      add constraint stories_status_check check (status in ('in_progress', 'complete'));
  end if;
end $$;

-- ── session_logs: many sessions → one story ─────────────────────────────────
alter table public.session_logs
  add column if not exists story_id uuid references public.stories(id) on delete set null;

-- Postgres does not index the referencing side of a FK; Phase 3's "load all
-- sessions for this story" needs this.
create index if not exists session_logs_story_id_idx on public.session_logs (story_id);

-- Every per-turn lookup is by session_id and loadSession() calls .single() —
-- this index serves the lookup AND enforces the one-row assumption.
create unique index if not exists session_logs_session_id_key on public.session_logs (session_id);

-- ── backfill: link the 29 saved stories to the session that produced them ───
-- Decision 4 (2026-09-07): ONLY sessions that already have a story row. The
-- 20 completed-but-unsaved and 30 unfinished sessions are NOT resurrected as
-- in_progress stories; Yijun hands over specific ids for a selective Phase 5
-- data migration.
update public.session_logs sl
   set story_id = s.id
  from public.stories s
 where s.session_id = sl.session_id
   and sl.story_id is null;

-- ── verify (expect 29 / 29 / 0) ─────────────────────────────────────────────
-- select count(*) from session_logs where story_id is not null;
-- select count(*) from stories where status = 'complete';
-- select count(*) from stories s where not exists
--   (select 1 from session_logs where story_id = s.id);
