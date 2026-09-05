-- 002: instrumentation columns
--
-- NOT YET APPLIED. Prod change — there is no staging environment; localhost and
-- production share one Supabase project.
--
-- All additive and nullable, so this can be applied before any code reads it.

-- The browser's own STT diagnosis, captured in rec.onerror and sent with /api/end.
-- 'not-allowed' | 'audio-capture' | 'network' distinguish a broken mic from a user
-- who simply left — otherwise identical in a session that ends with no turns.
alter table public.session_logs add column if not exists stt_error text;

-- Anthropic reports cached input in fields separate from input_tokens. total_cost is
-- already corrected for them (src/lib/server/usage.ts), but the volume breakdown has
-- nowhere to live, so the token columns still under-report actual input.
alter table public.session_logs add column if not exists cache_creation_tokens bigint default 0;
alter table public.session_logs add column if not exists cache_read_tokens bigint default 0;

-- Speech volume. Cost folds into total_cost via increment_session_tts_usage (003);
-- this is the quantity, which is what you would tune against — TTS has no cache and
-- no discount, so characters map linearly to dollars.
alter table public.session_logs add column if not exists tts_characters bigint default 0;
