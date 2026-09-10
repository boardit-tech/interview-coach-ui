import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { endSession } from '$lib/server/interview';

/**
 * A session ending with zero user turns is usually speech recognition failing, not a
 * user who left — and it is otherwise invisible: no error surfaces, and the app still
 * SPOKE two or three times (idle check-ins) at someone who was never heard.
 *
 * But "zero turns" alone would also fire for anyone who opens a session out of
 * curiosity and never speaks, which is not a bug and not worth paging over. So we
 * require corroboration that the mic was actually attempted:
 *
 *   sttError  — the browser reported a fault ('not-allowed', 'audio-capture', 'network')
 *   sawSpeech — audio reached the browser but produced no transcript (silent failure)
 *
 * Neither present means nothing tried and nothing broke. Stay quiet.
 */
function shouldAlert(sttError: string | null, sawSpeech: boolean): boolean {
  return Boolean(sttError) || sawSpeech;
}

async function alertDeadSession(
  sessionId: string,
  userEmail: string | undefined,
  sttError: string | null,
  sawSpeech: boolean,
) {
  if (!env.ALERT_SLACK_WEBHOOK) return;
  const cause = sttError
    ? `browser reported \`${sttError}\``
    : 'speech detected but no transcript — silent STT failure';
  try {
    await fetch(env.ALERT_SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🎙️ *Session ended with zero user turns*\n• User: ${userEmail ?? 'unknown'}\n• Session: \`${sessionId}\`\n• Cause: ${cause}`,
      }),
    });
  } catch (err: any) {
    console.error('Dead-session alert failed:', err.message);
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const session = await locals.getSession();
  if (!session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { sessionId, starSectionsFilled, sttError, sawSpeech } = await request.json();
    if (!sessionId) {
      return json({ error: 'sessionId is required' }, { status: 400 });
    }

    let result: any;
    try {
      result = await endSession(sessionId, locals.supabase);
    } catch (endErr: any) {
      console.error('endSession failed:', endErr.message);
      // Still mark session as completed in DB even if session state is gone
      const { error: logError } = await locals.supabase.from('session_logs')
        .update({ status: 'completed' })
        .eq('session_id', sessionId);
      if (logError) console.error('Failed to update session log:', logError.message);
      return json({ completed: true, durationMs: null });
    }

    // Update session log with completed status and duration
    // (cost is already tracked per-call via increment_session_usage RPC)
    const updateData: Record<string, any> = {
      status: 'completed',
      duration_ms: result.durationMs,
      star_sections_filled: starSectionsFilled ?? null,
      // 1.6b — persist the browser's STT diagnosis for every session, not just the
      // zero-turn ones that alert. Lets us size the mobile-STT problem from the table.
      stt_error: sttError ?? null,
    };
    const { error: logError } = await locals.supabase.from('session_logs')
      .update(updateData)
      .eq('session_id', sessionId);

    if (logError) console.error('Failed to update session log:', logError.message);

    // Never let alerting delay or fail the user's session end.
    if (shouldAlert(sttError ?? null, !!sawSpeech)) {
      const { data: log } = await locals.supabase
        .from('session_logs')
        .select('conversation_history')
        .eq('session_id', sessionId)
        .single();
      const userTurns = (log?.conversation_history ?? []).filter(
        (m: any) => m?.role === 'user'
      ).length;
      if (userTurns === 0) {
        void alertDeadSession(sessionId, session.user.email, sttError ?? null, !!sawSpeech);
      }
    }

    return json(result);
  } catch (err: any) {
    console.error('Error ending session:', err);
    return json({ error: 'Failed to end session' }, { status: 500 });
  }
};
