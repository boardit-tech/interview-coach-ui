import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSession, startSession } from '$lib/server/interview';
import { decideNewStory, decideResume } from '$lib/server/entitlement';

// Start a sitting on a story.
//
//   { }                          -> new story + first session
//   { storyId }                  -> resume: new session on an existing story
//   { storyId, takeover: true }  -> resume, evicting a session another tab holds
//
// Entitlement (5.1, decided 2026-09-08/09): an allowance from purchases is
// spent when a STORY is created, never on resume; see $lib/server/entitlement.
// A resume only checks the story's own window (with a 1-hour grace) and spends
// nothing. Session credits and subscriptions no longer start anything.
export const POST: RequestHandler = async ({ locals, request }) => {
  const authSession = await locals.getSession();
  if (!authSession) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = authSession.user.id;

  // The current client posts with no body; tolerate that.
  let body: { storyId?: string; takeover?: boolean } = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const resumed = !!body.storyId;

  const coachSession = createSession(body.storyId ?? null);

  // ── Entitlement + story row ──────────────────────────────────────────────
  let storyId: string;
  let storyState: { starSections: any; starStatus: any; question: string | null; status: string } | null = null;

  if (resumed) {
    // Ownership is enforced by RLS: a story that isn't ours reads as "not found".
    const { data: story, error: storyErr } = await locals.supabase
      .from('stories')
      .select('id, status, star_sections, star_status, extracted_question, purchase_id, created_at, updated_at')
      .eq('id', body.storyId)
      .single();
    if (storyErr || !story) {
      return json({ error: 'story_not_found' }, { status: 404 });
    }
    const resume = await decideResume(locals.supabase, story);
    if (!resume.ok) {
      // Window closed and the grace hour has passed. The client offers the $6
      // finish-this-story purchase.
      return json({ error: 'story_expired', expiredAt: resume.expiredAt }, { status: 402 });
    }
    storyId = story.id;
    storyState = {
      starSections: story.star_sections ?? null,
      starStatus: story.star_status ?? null,
      question: story.extracted_question ?? null,
      status: story.status,
    };
  } else {
    // Determine entitlement server-side (authoritative — never trust the client).
    const decision = await decideNewStory(locals.supabase);
    if (!decision.ok) {
      return json({ error: decision.reason }, { status: 402 });
    }

    const { data: story, error: storyErr } = await locals.supabase
      .from('stories')
      .insert({ user_id: userId, status: 'in_progress' })
      .select('id')
      .single();
    if (storyErr || !story) {
      console.error('Failed to create story:', storyErr?.message);
      return json({ error: 'start_failed' }, { status: 500 });
    }
    storyId = story.id;

    {
      const { error: consumeErr } = await locals.supabase.rpc('consume_story', {
        p_story_id: storyId,
        p_purchase_id: decision.purchaseId,
        p_reason: 'story_started',
      });
      if (consumeErr) {
        // Raced (two tabs spending the last allowance) or the purchase changed
        // under us. Don't leave a free story behind.
        console.error('consume_story failed:', consumeErr.message);
        await undoStart(locals.supabase, storyId);
        const reason = /exhausted/.test(consumeErr.message) ? 'no_stories'
          : /expired/.test(consumeErr.message) ? 'window_ended' : 'start_failed';
        return json({ error: reason }, { status: reason === 'start_failed' ? 500 : 402 });
      }
    }
  }

  // ── One-tab lock ─────────────────────────────────────────────────────────
  // Claimed for new stories too, so the very first sitting is protected from a
  // second tab the same way a resumed one is.
  const { data: holder, error: claimErr } = await locals.supabase.rpc('claim_story_session', {
    p_story_id: storyId,
    p_session_id: coachSession.id,
    p_takeover: !!body.takeover,
  });
  if (claimErr) {
    console.error('claim_story_session failed:', claimErr.message);
    await undoStart(locals.supabase, resumed ? null : storyId);
    return json({ error: 'start_failed' }, { status: 500 });
  }
  if (holder !== coachSession.id) {
    // Another live session holds this story. The client offers takeover.
    return json({ error: 'story_locked', heldBy: holder }, { status: 409 });
  }

  // Any earlier sitting on this story still marked 'started' died without
  // reporting (crash, closed tab). Its work is already persisted per turn; only
  // its status is stale. Decision 2026-09-07: everything that ended without
  // finishing is 'abandoned' — including takeover.
  if (resumed) {
    await locals.supabase
      .from('session_logs')
      .update({ status: 'abandoned' })
      .eq('story_id', storyId)
      .eq('status', 'started');
  }

  try {
    // Log session start BEFORE startSession so loadSession can find it on cold start
    const { error: insertError } = await locals.supabase.from('session_logs').insert({
      user_id: userId,
      session_id: coachSession.id,
      story_id: storyId,
      status: 'started',
    });
    if (insertError) console.error('Failed to log session start:', insertError.message);

    const firstMessage = await startSession(coachSession.id, locals.supabase, { resumed });

    return json({
      sessionId: coachSession.id,
      storyId,
      resumed,
      message: firstMessage,
      // Stored state so the sidebar fills before the first turn.
      starSections: storyState?.starSections ?? null,
      starStatus: storyState?.starStatus ?? null,
      question: storyState?.question ?? null,
      storyStatus: storyState?.status ?? 'in_progress',
    });
  } catch (err: any) {
    console.error('Error starting session:', err);
    await undoStart(locals.supabase, resumed ? null : storyId);
    return json({ error: 'start_failed' }, { status: 500 });
  }
};

// Start failed after a NEW story row was created. Remove it so no zero-session
// in_progress story lingers on the dashboard. (consume_story is the last step
// before the session insert, so an orphan row never carries a consumption.)
async function undoStart(supabase: any, newStoryId: string | null) {
  if (!newStoryId) return;
  const { error } = await supabase.from('stories').delete().eq('id', newStoryId);
  if (error) console.error('Failed to remove orphan story:', error.message);
}
