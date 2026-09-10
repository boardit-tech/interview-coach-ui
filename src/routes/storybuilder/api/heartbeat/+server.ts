import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// One-tab lock heartbeat. The client calls this every ~30s while a session is
// open, and on tab-visible. It does two things:
//
//   1. Keeps the lock fresh (claim_story_session treats a lock as stale after
//      90s without a beat, so a crashed tab frees its story quickly).
//   2. Tells a tab that has been taken over. This is the FIRST and fastest layer
//      of takeover enforcement — a superseded tab learns on its next beat and
//      ends itself, before it ever tries to send a turn. (/api/respond is the
//      second layer; the 3-minute idle close is the third.)
//
// A plain RLS-scoped UPDATE, no RPC: the WHERE clause on active_session_id is
// the compare, and `found` is the result.
export const POST: RequestHandler = async ({ locals, request }) => {
  const authSession = await locals.getSession();
  if (!authSession) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sessionId?: string; storyId?: string } = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const { sessionId, storyId } = body;
  if (!sessionId || !storyId) {
    return json({ error: 'sessionId and storyId are required' }, { status: 400 });
  }

  const { data: beat, error } = await locals.supabase
    .from('stories')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', storyId)
    .eq('active_session_id', sessionId)
    .select('id');

  if (error) {
    console.error('heartbeat update failed:', error.message);
    // Don't tell a healthy tab it was replaced because of a transient DB error.
    return json({ ok: true, degraded: true });
  }

  if (beat && beat.length > 0) {
    return json({ ok: true });
  }

  // We no longer hold the lock. Find out who does (null = released normally).
  const { data: story } = await locals.supabase
    .from('stories')
    .select('active_session_id')
    .eq('id', storyId)
    .single();
  const heldBy = story?.active_session_id ?? null;

  if (heldBy && heldBy !== sessionId) {
    // Superseded by another tab. Mark this sitting the way every unfinished
    // sitting is marked (decision 2026-09-07: no separate 'superseded' status).
    await locals.supabase
      .from('session_logs')
      .update({ status: 'abandoned' })
      .eq('session_id', sessionId)
      .eq('status', 'started');
    return json({ ok: false, replaced: true, heldBy });
  }

  return json({ ok: false, replaced: false });
};
