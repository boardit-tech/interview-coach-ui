-- 001: baseline — session_logs as it exists in production, 2026-09-04
--
-- NOT A CHANGE. This records a table that was created by hand in the Supabase
-- dashboard and has never existed in the repo. Until now its shape could only be
-- inferred from how the code read it. Written with IF NOT EXISTS so applying it to
-- prod is a safe no-op; its purpose is to give later migrations a known starting
-- point, and to make it possible to stand up a second Supabase project as a real
-- dev environment (there is currently only one, shared by localhost and prod).
--
-- INCOMPLETE — still to capture: the other four tables (profiles, stories,
-- credit_transactions, support_requests). Their indexes are recorded at the bottom
-- of this file for reference, but their column definitions are not yet captured.

create table if not exists public.session_logs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  session_id            text not null,

  -- Accumulated by the increment_session_usage RPC, once per tracked call.
  api_calls             integer default 0,
  input_tokens          integer default 0,
  output_tokens         integer default 0,
  total_tokens          integer default 0,
  total_cost            numeric default 0,

  duration_ms           bigint,
  created_at            timestamptz not null default now(),

  -- 'started' | 'completed' | 'abandoned' | 'refunded' | 'glitch'
  status                text default 'started',
  star_sections_filled  integer,

  -- Session state. Under resumability these move to story level: a story spans
  -- sessions, and leaving them here means a resumed session starts from an empty
  -- STAR state and the coach re-asks everything.
  conversation_history  jsonb,
  star_sections         jsonb,
  extracted_question    text,
  extracted_flags       jsonb,
  target_company        text
);

alter table public.session_logs enable row level security;

-- Verified 2026-08-19. loadSession() queries by session_id with NO user_id filter,
-- so these policies — not the application code — are what prevent cross-user reads.
-- That becomes load-bearing once session IDs stop being ephemeral under resumability.
-- Postgres has no CREATE POLICY IF NOT EXISTS, so these are guarded individually.
-- Without the guards this file would abort on the first policy when run against the
-- existing project, which defeats the point of a baseline that is safe to re-run.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'session_logs'
                 and policyname = 'Users can read own session logs') then
    create policy "Users can read own session logs"
      on public.session_logs for select
      using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'session_logs'
                 and policyname = 'Service can insert session logs') then
    create policy "Service can insert session logs"
      on public.session_logs for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'session_logs'
                 and policyname = 'Users can update their own session logs') then
    create policy "Users can update their own session logs"
      on public.session_logs for update
      using (auth.uid() = user_id);
  end if;
end $$;

-- Indexes, as of 2026-09-04.
create index if not exists session_logs_user_id_idx    on public.session_logs using btree (user_id);
create index if not exists session_logs_created_at_idx on public.session_logs using btree (created_at desc);

-- NOTE — there is no index on session_id, yet loadSession() looks a session up by it
-- on EVERY turn (`.eq('session_id', sessionId)`), so each turn is a sequential scan.
-- Harmless at current row counts; worth adding before the table grows, and more so
-- under resumability where sessions are read back rather than living in memory:
--   create index on public.session_logs using btree (session_id);

-- Other tables' indexes, recorded here until their own baseline files exist:
--   profiles_pkey                       (id)
--   profiles_stripe_customer_id_idx     (stripe_customer_id)
--   stories_pkey                        (id)
--   support_requests_pkey               (id)
--   credit_transactions_pkey            (id)
--   credit_transactions_user_created_idx (user_id, created_at desc)

-- The usage accumulator, as it exists in production. Recorded verbatim because it was
-- created in the dashboard and has never been in the repo. Note the unconditional
-- api_calls increment — that is why TTS gets its own function in 003 rather than
-- reusing this one.
create or replace function public.increment_session_usage(
  p_session_id text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost numeric
)
returns void
language plpgsql
security definer
as $function$
begin
  update session_logs set
    input_tokens  = coalesce(input_tokens, 0) + p_input_tokens,
    output_tokens = coalesce(output_tokens, 0) + p_output_tokens,
    total_tokens  = coalesce(total_tokens, 0) + p_input_tokens + p_output_tokens,
    api_calls     = coalesce(api_calls, 0) + 1,
    total_cost    = coalesce(total_cost, 0) + p_cost
  where session_id = p_session_id;
end;
$function$;
