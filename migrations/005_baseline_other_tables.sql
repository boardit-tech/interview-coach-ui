-- 005: baseline for the four tables 001 did not capture: profiles, stories,
-- credit_transactions, support_requests. Recorded verbatim from prod on 2026-09-07
-- (column listing + pg_policies / pg_indexes / pg_constraint / pg_get_functiondef).
-- Idempotent: safe to run against prod, where all of this already exists.
--
-- Known gaps this baseline does NOT capture:
--   * Triggers. deduct_credit/refund_credit/grant_purchase_credits all call
--     set_config('app.credit_rpc','on'), which implies a trigger on profiles that
--     rejects direct credit writes unless that setting is on. Its body is not in
--     the repo yet — see 006.
--   * RLS is ENABLED on all four tables (verified in dashboard 2026-08-19); the
--     enable statements below are included for completeness.

-- ── profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  credits                integer not null default 0,
  created_at             timestamptz not null default now(),
  email                  text,
  last_stripe_session_id text,
  stripe_customer_id     text
);
create index if not exists profiles_stripe_customer_id_idx on public.profiles (stripe_customer_id);
alter table public.profiles enable row level security;

-- ── stories ─────────────────────────────────────────────────────────────────
-- Today: one row per SAVED story, written once by /storybuilder/api/save at the
-- end of a session. session_id is a loose text pointer (no FK, no index) — the
-- 1 story : 1 session shape that Phase 2 inverts.
create table if not exists public.stories (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  question         text,
  full_story       text,
  talking_points   jsonb,
  created_at       timestamptz not null default now(),
  strength_signals jsonb,
  flags            jsonb,
  session_id       text,
  tier             text
);
alter table public.stories enable row level security;

-- ── credit_transactions ─────────────────────────────────────────────────────
create table if not exists public.credit_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  session_id    text,
  delta         integer not null,
  reason        text not null,
  balance_after integer not null,
  created_at    timestamptz not null default now(),
  reference     text
);
create index if not exists credit_transactions_user_created_idx
  on public.credit_transactions (user_id, created_at desc);
alter table public.credit_transactions enable row level security;

-- ── support_requests ────────────────────────────────────────────────────────
create table if not exists public.support_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id),          -- note: NO cascade, unlike the others
  user_email  text,
  topic       text not null,
  session_id  text,
  description text not null,
  status      text default 'open',
  created_at  timestamptz default now()
);
alter table public.support_requests enable row level security;

-- ── RLS policies (verbatim names; guarded because CREATE POLICY has no IF NOT EXISTS) ──
do $$
begin
  -- profiles
  if not exists (select 1 from pg_policies where tablename='profiles' and policyname='Users can read own profile') then
    create policy "Users can read own profile" on public.profiles for select using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where tablename='profiles' and policyname='Service can insert profiles') then
    create policy "Service can insert profiles" on public.profiles for insert with check (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where tablename='profiles' and policyname='Users can update own profile') then
    create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
  end if;

  -- stories
  if not exists (select 1 from pg_policies where tablename='stories' and policyname='Users can read own stories') then
    create policy "Users can read own stories" on public.stories for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='stories' and policyname='Users can insert own stories') then
    create policy "Users can insert own stories" on public.stories for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='stories' and policyname='Users can update own stories') then
    create policy "Users can update own stories" on public.stories for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='stories' and policyname='Users can delete own stories') then
    create policy "Users can delete own stories" on public.stories for delete using (auth.uid() = user_id);
  end if;

  -- credit_transactions: read-only from the client; all writes go through the
  -- SECURITY DEFINER RPCs below.
  if not exists (select 1 from pg_policies where tablename='credit_transactions' and policyname='Users can read own credit transactions') then
    create policy "Users can read own credit transactions" on public.credit_transactions for select using (auth.uid() = user_id);
  end if;

  -- support_requests
  if not exists (select 1 from pg_policies where tablename='support_requests' and policyname='Users can view own support requests') then
    create policy "Users can view own support requests" on public.support_requests for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='support_requests' and policyname='Users can insert own support requests') then
    create policy "Users can insert own support requests" on public.support_requests for insert with check (auth.uid() = user_id);
  end if;
end $$;

-- ── Credit ledger RPCs (verbatim) ───────────────────────────────────────────
-- Legacy $3/session path. Kept alive until existing credit holders are migrated
-- to the story-allowance model, then deleted.

CREATE OR REPLACE FUNCTION public.deduct_credit(p_session_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_new integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  perform set_config('app.credit_rpc', 'on', true);

  update public.profiles
    set credits = credits - 1
    where id = v_uid and credits > 0
    returning credits into v_new;

  if v_new is null then
    return -1;
  end if;

  insert into public.credit_transactions (user_id, session_id, delta, reason, balance_after)
    values (v_uid, p_session_id, -1, 'session_start', v_new);

  return v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refund_credit(p_session_id text, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_new integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  perform set_config('app.credit_rpc', 'on', true);

  update public.profiles
    set credits = credits + 1
    where id = v_uid
    returning credits into v_new;

  if v_new is null then
    return -1;
  end if;

  insert into public.credit_transactions (user_id, session_id, delta, reason, balance_after)
    values (v_uid, p_session_id, 1, coalesce(p_reason, 'manual_refund'), v_new);

  return v_new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.grant_purchase_credits(p_amount integer, p_stripe_session_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_new integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  perform set_config('app.credit_rpc', 'on', true);

  update public.profiles
    set credits = credits + p_amount,
        last_stripe_session_id = p_stripe_session_id
    where id = v_uid
      and coalesce(last_stripe_session_id, '') is distinct from coalesce(p_stripe_session_id, '')
    returning credits into v_new;

  if v_new is null then
    return -1;  -- replay of an already-applied stripe session
  end if;

  insert into public.credit_transactions (user_id, session_id, delta, reason, balance_after, reference)
    values (v_uid, null, p_amount, 'purchase', v_new, p_stripe_session_id);

  return v_new;
end;
$function$;
