-- 012: the two ledger writes, as SECURITY DEFINER RPCs (purchases and
-- story_consumptions have no client INSERT policy — decided 2026-09-07).
-- Ships with 5.1 (/api/start calls consume_story) and 5.2 (checkout success
-- calls grant_purchase). Same shape as the credit RPCs: auth.uid() ownership,
-- row lock for atomicity, idempotency where a replay is possible.

-- ── consume_story ───────────────────────────────────────────────────────────
-- Spend one allowance from p_purchase_id on p_story_id. Atomic: locks the
-- purchase row, re-checks it is live and has room, inserts the consumption,
-- stamps stories.purchase_id. Returns the consumption id.
-- Raises: 'purchase_exhausted' | 'purchase_expired' | 'purchase_revoked' |
--         'purchase_bound_elsewhere' | 'not found'.
create or replace function public.consume_story(
  p_story_id    uuid,
  p_purchase_id uuid,
  p_reason      text   -- 'story_started' | 'resume_after_expiry'
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid      uuid := auth.uid();
  v_allowed  int;
  v_used     int;
  v_expires  timestamptz;
  v_revoked  timestamptz;
  v_for      uuid;
  v_id       uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_reason not in ('story_started', 'resume_after_expiry') then
    raise exception 'bad reason';
  end if;

  -- Ownership of the story.
  if not exists (select 1 from public.stories where id = p_story_id and user_id = v_uid) then
    raise exception 'story not found';
  end if;

  select stories_allowed, expires_at, revoked_at, for_story_id
    into v_allowed, v_expires, v_revoked, v_for
    from public.purchases
   where id = p_purchase_id and user_id = v_uid
     for update;
  if not found then raise exception 'purchase not found'; end if;
  if v_revoked is not null then raise exception 'purchase_revoked'; end if;
  if v_expires <= now() then raise exception 'purchase_expired'; end if;
  if v_for is not null and v_for <> p_story_id then raise exception 'purchase_bound_elsewhere'; end if;

  select count(*) into v_used from public.story_consumptions where purchase_id = p_purchase_id;
  if v_used >= v_allowed then raise exception 'purchase_exhausted'; end if;

  insert into public.story_consumptions (user_id, story_id, purchase_id, reason)
  values (v_uid, p_story_id, p_purchase_id, p_reason)
  returning id into v_id;

  update public.stories
     set purchase_id = p_purchase_id, updated_at = now()
   where id = p_story_id;

  return v_id;
end $$;

-- ── grant_purchase ──────────────────────────────────────────────────────────
-- Record a paid purchase. Idempotent on the Stripe checkout session id: a
-- replayed success redirect returns the existing row instead of a second grant.
-- expires_at is filled by the purchases_default_expiry trigger.
create or replace function public.grant_purchase(
  p_kind              text,   -- 'bundle' | 'single_story' | 'finish_story'
  p_stories_allowed   int,
  p_stripe_session_id text,
  p_for_story_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stripe_session_id is null then raise exception 'stripe session required'; end if;

  select id into v_id from public.purchases where stripe_session_id = p_stripe_session_id;
  if found then return v_id; end if;   -- replay

  if p_for_story_id is not null
     and not exists (select 1 from public.stories where id = p_for_story_id and user_id = v_uid) then
    raise exception 'story not found';
  end if;

  insert into public.purchases (user_id, kind, stories_allowed, source, stripe_session_id, for_story_id)
  values (v_uid, p_kind, p_stories_allowed, 'stripe', p_stripe_session_id, p_for_story_id)
  returning id into v_id;

  return v_id;
end $$;

-- verify:
-- select proname from pg_proc where proname in ('consume_story','grant_purchase');  -- 2 rows
