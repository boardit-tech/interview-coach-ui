-- 003: give TTS its own accumulator
--
-- NOT YET APPLIED. Depends on 002 (tts_characters column). Prod change.
--
-- Why a separate function rather than extending increment_session_usage: that one
-- ends with `api_calls = COALESCE(api_calls, 0) + 1` on every call. Speech is not an
-- LLM call, and routing it through there would inflate api_calls from its current
-- meaning (2 x turns + 1: one coach reply and one extraction per turn, plus the
-- end-of-session assessment) into something that silently mixes two different things.
--
-- Cost lands in the same total_cost column so a session's total stays correct in one
-- place; only the character count is tracked separately.

create or replace function public.increment_session_tts_usage(
  p_session_id text,
  p_characters bigint,
  p_cost numeric
)
returns void
language plpgsql
security definer
as $function$
begin
  update session_logs set
    tts_characters = coalesce(tts_characters, 0) + p_characters,
    total_cost     = coalesce(total_cost, 0) + p_cost
  where session_id = p_session_id;
end;
$function$;
