-- 010: schema + lock RPCs for Phase 3 (server-side resume). Additive only.
-- Nothing reads these until the Phase 3 code lands; safe to apply now.

-- ── stories ─────────────────────────────────────────────────────────────────
alter table public.stories
  -- green/yellow/null per section, so yellow survives between sessions (007
  -- only carries green text in star_sections).
  add column if not exists star_status jsonb,
  -- Experience segments for the extractor: [{from, to|null, active}] turn ranges
  -- over the STORY transcript. The extractor is sent only the active segment's
  -- turns; the coach always gets everything. Frozen once any section is green.
  add column if not exists experience_segments jsonb not null default '[]'::jsonb;

-- ── session_logs ────────────────────────────────────────────────────────────
alter table public.session_logs
  -- Consecutive off_topic flags from the extractor. 1 = log, 2 = redirect line,
  -- 3 = end session. Reset to 0 on any on-topic turn.
  add column if not exists off_topic_strikes integer not null default 0;

-- ── one-tab lock ────────────────────────────────────────────────────────────
-- A story is held by at most one session. The lock is considered stale after
-- 90s without a heartbeat (two missed 30s beats — shorter than the 3-min idle
-- close so a crashed tab frees up fast). A second tab may take over explicitly.
--
-- Both RPCs are SECURITY DEFINER with an ownership check on auth.uid(), same
-- shape as the credit RPCs. Heartbeats themselves are a plain UPDATE from the
-- endpoint (RLS-scoped), no RPC needed.

create or replace function public.claim_story_session(
  p_story_id  uuid,
  p_session_id text,
  p_takeover  boolean default false
)
returns text   -- the session id that holds the lock AFTER this call
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_holder text;
  v_beat   timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Row lock so two tabs claiming at once serialize.
  select active_session_id, last_heartbeat_at
    into v_holder, v_beat
    from public.stories
   where id = p_story_id and user_id = v_uid
     for update;

  if not found then
    raise exception 'story not found';
  end if;

  if v_holder is null
     or v_holder = p_session_id
     or p_takeover
     or v_beat is null
     or v_beat < now() - interval '90 seconds'
  then
    update public.stories
       set active_session_id = p_session_id,
           last_heartbeat_at = now(),
           updated_at        = now()
     where id = p_story_id;
    return p_session_id;
  end if;

  -- Held by a live session and no takeover requested.
  return v_holder;
end $$;

create or replace function public.release_story_session(
  p_story_id   uuid,
  p_session_id text
)
returns boolean  -- true if this call released it, false if someone else held it
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  update public.stories
     set active_session_id = null,
         last_heartbeat_at = null,
         updated_at        = now()
   where id = p_story_id
     and user_id = v_uid
     and active_session_id = p_session_id;

  return found;
end $$;

-- ── verify ──────────────────────────────────────────────────────────────────
-- select column_name from information_schema.columns
--  where table_name='stories' and column_name in ('star_status','experience_segments');   -- 2 rows
-- select proname from pg_proc where proname in ('claim_story_session','release_story_session'); -- 2 rows
