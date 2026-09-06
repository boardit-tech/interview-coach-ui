-- 004: record the cache-token breakdown
--
-- NOT YET APPLIED. Prod change.
--
-- 002 added cache_creation_tokens and cache_read_tokens, but nothing writes them —
-- the accumulator only takes input/output/cost. total_cost is already correct (the
-- cache pricing is folded in on the app side), but the columns read as 0, which
-- looks like "caching is broken" to anyone querying the table.
--
-- The breakdown is also the only way to verify caching per session without exporting
-- Vercel logs: cache_read flat with cache_creation climbing is a one-glance diagnosis
-- of a broken cache, and total_cost alone cannot distinguish that from a session that
-- was just long. The extractor has no debug logging at all, so for that call these
-- columns are the only signal.
--
-- Postgres identifies a function by name + argument types, so adding parameters
-- creates a second overload rather than replacing the first — and a 4-argument call
-- would then be ambiguous. The old signature is dropped first. The new parameters
-- default to 0 so the currently-deployed code (which passes four arguments) keeps
-- working across the deploy window.
--
-- total_tokens is deliberately left as input + output. Cached input is real input and
-- arguably belongs in it, but that would change the column's meaning between old and
-- new rows; left for a separate decision.

drop function if exists public.increment_session_usage(text, integer, integer, numeric);

create or replace function public.increment_session_usage(
  p_session_id     text,
  p_input_tokens   integer,
  p_output_tokens  integer,
  p_cost           numeric,
  p_cache_creation bigint default 0,
  p_cache_read     bigint default 0
)
returns void
language plpgsql
security definer
as $function$
begin
  update session_logs set
    input_tokens          = coalesce(input_tokens, 0) + p_input_tokens,
    output_tokens         = coalesce(output_tokens, 0) + p_output_tokens,
    total_tokens          = coalesce(total_tokens, 0) + p_input_tokens + p_output_tokens,
    cache_creation_tokens = coalesce(cache_creation_tokens, 0) + p_cache_creation,
    cache_read_tokens     = coalesce(cache_read_tokens, 0) + p_cache_read,
    api_calls             = coalesce(api_calls, 0) + 1,
    total_cost            = coalesce(total_cost, 0) + p_cost
  where session_id = p_session_id;
end;
$function$;
