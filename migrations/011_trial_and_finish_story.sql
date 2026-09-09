-- 011: Phase 5 schema. Three additions to the purchases ledger (008):
--   * kind 'finish_story'  — the $6 post-expiry upsell, always bound to one story
--   * source 'trial'       — the free welcome story every new signup gets
--   * for_story_id         — which story a finish_story purchase is for
-- plus the trigger that grants the welcome story on profile creation.
-- Additive; safe on prod. Nothing reads these until the 5.1/5.2 code lands.

-- ── purchases: widen the enums ──────────────────────────────────────────────
alter table public.purchases drop constraint if exists purchases_kind_check;
alter table public.purchases
  add constraint purchases_kind_check check (kind in ('bundle', 'single_story', 'finish_story'));

alter table public.purchases drop constraint if exists purchases_source_check;
alter table public.purchases
  add constraint purchases_source_check check (source in ('stripe', 'manual', 'trial'));

-- ── purchases.for_story_id ──────────────────────────────────────────────────
-- A finish_story purchase is bound to the story it was bought for and is never
-- in the pool. A single_story ($9) or bundle is always poolable — the kind
-- itself says which, and this column names the story.
alter table public.purchases
  add column if not exists for_story_id uuid references public.stories(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchases_finish_needs_story') then
    alter table public.purchases
      add constraint purchases_finish_needs_story
      check ((kind = 'finish_story') = (for_story_id is not null));
  end if;
end $$;
create index if not exists purchases_for_story_idx on public.purchases (for_story_id) where for_story_id is not null;

-- ── expiry default: finish_story gets 30 days like a single ─────────────────
create or replace function public.purchases_default_expiry()
returns trigger language plpgsql as $$
begin
  if new.expires_at is null then
    new.expires_at := new.created_at + case new.kind
      when 'bundle'       then interval '60 days'
      when 'single_story' then interval '30 days'
      when 'finish_story' then interval '30 days'
    end;
  end if;
  return new;
end $$;

-- ── welcome story on signup ─────────────────────────────────────────────────
-- Every NEW profile gets one free story, 30 days from signup. A trigger rather
-- than app code: it can't be skipped by a code path, and purchases has no client
-- INSERT policy. Existing users are deliberately untouched — they're covered by
-- the blast-day conversion (see migrations/parked/).
create or replace function public.grant_welcome_story()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.purchases (user_id, kind, stories_allowed, source, note)
  values (new.id, 'single_story', 1, 'trial', 'welcome story');
  return new;
end $$;

drop trigger if exists on_profile_created_welcome_story on public.profiles;
create trigger on_profile_created_welcome_story
  after insert on public.profiles
  for each row execute function public.grant_welcome_story();

-- ── ledger view: name the story a finish_story purchase is for ──────────────
create or replace view public.user_ledger
with (security_invoker = true) as
  select user_id, created_at as at, 'credit'::text as ledger, reason as kind,
         delta as delta_credits, null::int as delta_stories,
         coalesce(session_id, reference) as detail, id as ref_id
    from public.credit_transactions
union all
  select p.user_id, p.created_at, 'story', 'grant:' || p.kind || ':' || p.source,
         null, p.stories_allowed,
         coalesce(p.stripe_session_id, p.note)
           || case when p.for_story_id is not null
                   then ' · for: ' || coalesce((select coalesce(s.question, s.extracted_question) from public.stories s where s.id = p.for_story_id), p.for_story_id::text)
                   else '' end
           || ' · expires ' || to_char(p.expires_at, 'YYYY-MM-DD'),
         p.id
    from public.purchases p
union all
  select user_id, revoked_at, 'story', 'revoke:' || kind,
         null, -stories_allowed, revoke_reason, id
    from public.purchases where revoked_at is not null
union all
  select user_id, created_at, 'story', 'consume:' || reason,
         null, -1, 'story ' || story_id::text, id
    from public.story_consumptions;

-- ── verify ──────────────────────────────────────────────────────────────────
-- select count(*) from pg_trigger where tgname = 'on_profile_created_welcome_story';  -- 1
-- select count(*) from information_schema.columns where table_name='purchases' and column_name='for_story_id'; -- 1
-- select count(*) from purchases where source = 'trial';  -- 0 (no signups yet)
