-- 008: the story-allowance ledger. Phase 2, step 2 of 3. Schema only — no code
-- reads these tables until Phase 3 (entitlement RPCs) and Phase 5 (Stripe).
--
-- Model (decided 2026-09-07):
--   purchases          = PLUS side. Every allowance grant, Stripe or manual.
--   story_consumptions = MINUS side. Every allowance spent.
--   balance            = unexpired, unrevoked purchases − consumptions.
--   Rows are never edited; corrections are new rows. Refunds are a revoke on
--   the purchase (revoked_at), not a negative row. A mistaken consumption is
--   deleted in the dashboard — there is no UI for it.
--
-- RLS: SELECT own rows only. NO client INSERT/UPDATE/DELETE on either table —
-- writes go through SECURITY DEFINER RPCs (Phase 3) or the dashboard, which
-- bypasses RLS. That is how Yijun grants free bundles: insert a purchases row
-- with source='manual'.

-- ── purchases ───────────────────────────────────────────────────────────────
create table if not exists public.purchases (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  kind              text not null check (kind in ('bundle', 'single_story')),
  stories_allowed   integer not null check (stories_allowed > 0),
  source            text not null check (source in ('stripe', 'manual')),
  stripe_session_id text unique,                       -- replay protection; null for manual
  note              text,                              -- why a manual grant was made
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,              -- ALWAYS set: 60d bundle, 30d single
  revoked_at        timestamptz,                       -- Stripe refund / chargeback
  revoke_reason     text,
  constraint purchases_stripe_needs_session check (source <> 'stripe' or stripe_session_id is not null),
  constraint purchases_revoke_needs_reason  check (revoked_at is null or revoke_reason is not null)
);
create index if not exists purchases_user_created_idx on public.purchases (user_id, created_at desc);

-- expires_at is NOT NULL by decision, but a dashboard insert shouldn't require
-- doing date arithmetic by hand. If it's left blank, fill it from kind.
create or replace function public.purchases_default_expiry()
returns trigger language plpgsql as $$
begin
  if new.expires_at is null then
    new.expires_at := new.created_at + case new.kind
      when 'bundle'       then interval '60 days'
      when 'single_story' then interval '30 days'
    end;
  end if;
  return new;
end $$;
drop trigger if exists purchases_default_expiry on public.purchases;
create trigger purchases_default_expiry
  before insert on public.purchases
  for each row execute function public.purchases_default_expiry();

-- ── story_consumptions ──────────────────────────────────────────────────────
create table if not exists public.story_consumptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  story_id    uuid not null references public.stories(id) on delete cascade,
  purchase_id uuid not null references public.purchases(id),
  reason      text not null check (reason in ('completed', 'resume_after_expiry')),
  created_at  timestamptz not null default now()
);
create index if not exists story_consumptions_user_idx     on public.story_consumptions (user_id, created_at desc);
create index if not exists story_consumptions_purchase_idx on public.story_consumptions (purchase_id);
create index if not exists story_consumptions_story_idx    on public.story_consumptions (story_id);
-- A story completes once. Makes Phase 3's consume RPC idempotent by construction.
create unique index if not exists story_consumptions_one_completion
  on public.story_consumptions (story_id) where reason = 'completed';

-- ── stories.purchase_id FK (column added in 007, table exists now) ──────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stories_purchase_id_fkey') then
    alter table public.stories
      add constraint stories_purchase_id_fkey
      foreign key (purchase_id) references public.purchases(id) on delete set null;
  end if;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.purchases          enable row level security;
alter table public.story_consumptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='purchases' and policyname='Users can read own purchases') then
    create policy "Users can read own purchases" on public.purchases
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='story_consumptions' and policyname='Users can read own consumptions') then
    create policy "Users can read own consumptions" on public.story_consumptions
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- ── user_story_balance: the balance formula, codified ───────────────────────
-- Phase 3's entitlement RPC reads this. security_invoker so the caller's RLS
-- applies (a plain view would run as its owner and bypass RLS).
create or replace view public.user_story_balance
with (security_invoker = true) as
select
  u.user_id,
  coalesce(sum(p.stories_allowed) filter (where p.revoked_at is null and p.expires_at > now()), 0)::int as active_allowance,
  coalesce((select count(*) from public.story_consumptions c
             join public.purchases cp on cp.id = c.purchase_id
            where c.user_id = u.user_id and cp.revoked_at is null), 0)::int as consumed,
  max(p.expires_at) filter (where p.revoked_at is null) as latest_expiry
from (select distinct user_id from public.purchases) u
left join public.purchases p on p.user_id = u.user_id
group by u.user_id;

-- ── user_ledger: one place to look ──────────────────────────────────────────
-- Presentation only. Unions the legacy credit ledger with the new one so the
-- dashboard shows a single per-user history. Replaces nothing:
-- credit_transactions stays forever as money history and just stops receiving
-- rows after Phase 5.
create or replace view public.user_ledger
with (security_invoker = true) as
  select user_id, created_at as at, 'credit'::text as ledger, reason as kind,
         delta as delta_credits, null::int as delta_stories,
         coalesce(session_id, reference) as detail, id as ref_id
    from public.credit_transactions
union all
  select user_id, created_at, 'story', 'grant:' || kind || ':' || source,
         null, stories_allowed,
         coalesce(stripe_session_id, note) || ' · expires ' || to_char(expires_at, 'YYYY-MM-DD'), id
    from public.purchases
union all
  select user_id, revoked_at, 'story', 'revoke:' || kind,
         null, -stories_allowed, revoke_reason, id
    from public.purchases where revoked_at is not null
union all
  select user_id, created_at, 'story', 'consume:' || reason,
         null, -1, 'story ' || story_id::text, id
    from public.story_consumptions;

grant select on public.user_story_balance, public.user_ledger to authenticated;

-- ── verify ──────────────────────────────────────────────────────────────────
-- select count(*) from purchases;                       -- 0
-- select count(*) from user_ledger;                     -- 49 (= credit_transactions rows)
-- select * from user_story_balance;                     -- 0 rows until 009
