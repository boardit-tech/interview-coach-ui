// ── Cost accounting ──
// Single owner of "what did this session cost". Every provider we pay for routes
// through here so pricing lives in one file rather than being re-derived in each
// module. Today that's Anthropic; TTS (Google) and STT (Deepgram) land here too.
//
// All of it accumulates onto the session row via the increment_session_usage RPC,
// so a session's total is the sum of every call made under its ID — including the
// end-of-session assessment, which lands after the user has already left.

// $ per 1M tokens.
const SONNET_INPUT_PRICE = 3.0;
const SONNET_OUTPUT_PRICE = 15.0;

// Anthropic bills cached input at a discount on read and a premium on write, and
// reports those tokens in SEPARATE fields — input_tokens excludes both. Costing
// only input_tokens (as this did until now) therefore billed all cached input at
// zero, and the error grows the better caching works.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// $ per 1M characters — Google Chirp3-HD, $0.00003/char, taken from the GCP console.
// Speech has no cache and no discount: every character is full price every time it is
// spoken, which makes it roughly half of a session's cost and the most expensive
// single thing the product does per minute.
const TTS_PRICE_PER_M_CHARS = 30.0;


export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Record one Anthropic call against a session. Fire-and-forget: a failure here
 * must never break the coaching turn it was measuring.
 *
 * Note the RPC still takes only a total cost — the per-bucket token breakdown
 * (cache read vs. write vs. fresh) has nowhere to be stored yet. Adding those
 * columns is a separate migration; until then the total is correct but not
 * decomposable.
 */
export async function recordLlmUsage(sessionId: string, usage: MessageUsage, supabase: any) {
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

  const cost =
    (usage.input_tokens * SONNET_INPUT_PRICE +
      cacheWriteTokens * SONNET_INPUT_PRICE * CACHE_WRITE_MULTIPLIER +
      cacheReadTokens * SONNET_INPUT_PRICE * CACHE_READ_MULTIPLIER +
      usage.output_tokens * SONNET_OUTPUT_PRICE) /
    1_000_000;

  const callCost = parseFloat(cost.toFixed(6));

  try {
    const { error } = await supabase.rpc('increment_session_usage', {
      p_session_id: sessionId,
      // Cached tokens are billed but not yet stored separately, so the token
      // counts below still under-report volume even though p_cost is now right.
      p_input_tokens: usage.input_tokens,
      p_output_tokens: usage.output_tokens,
      p_cost: callCost,
    });
    if (error) console.error('[usage] increment_session_usage failed:', error.message);
  } catch (err: any) {
    console.error('[usage] increment_session_usage exception:', err.message);
  }
}

/**
 * Record one TTS synthesis against a session. Google returns no usage object and bills
 * per character, so the text we sent IS the billable quantity.
 *
 * Folded into the same cost column as LLM spend rather than waiting on dedicated
 * tts_characters / tts_cost columns — a session's total becomes correct immediately and
 * the breakdown can be split out later. Token counts are 0 because none were used.
 *
 * Note this fires for speech the user never asked for: the idle check-ins and the
 * all-green hand-back line synthesize without a user turn. That is deliberate — a
 * session that spoke three times and heard nothing should not record as free.
 */
export async function recordTtsUsage(sessionId: string, characters: number, supabase: any) {
  if (!sessionId || !characters) return;

  const cost = (characters * TTS_PRICE_PER_M_CHARS) / 1_000_000;

  try {
    // Deliberately NOT increment_session_usage: that function unconditionally does
    // `api_calls = api_calls + 1`, so routing speech through it would count every TTS
    // render as an LLM call and roughly double a metric that currently means
    // "2 x turns + 1". TTS gets its own function that touches cost only.
    //
    // Until migrations/003 is applied this call fails with "function does not exist",
    // which is logged and swallowed — TTS still works, cost just is not recorded yet.
    const { error } = await supabase.rpc('increment_session_tts_usage', {
      p_session_id: sessionId,
      p_characters: characters,
      p_cost: parseFloat(cost.toFixed(6)),
    });
    if (error) console.error('[usage] TTS increment failed:', error.message);
  } catch (err: any) {
    console.error('[usage] TTS increment exception:', err.message);
  }
}
