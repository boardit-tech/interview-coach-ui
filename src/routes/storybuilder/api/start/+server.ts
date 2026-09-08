import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSession, startSession } from '$lib/server/interview';
import { hasActiveSubscription } from '$lib/server/billing';

// Start a sitting on a story.
//
//   { }                          -> new story + first session
//   { storyId }                  -> resume: new session on an existing story
//   { storyId, takeover: true }  -> resume, evicting a session another tab holds
//
// Entitlement bridge until Phase 5 (decided 2026-09-07): a credit is spent when a
// STORY is created, never on resume — which is also the Phase 5 conversion rule
// (one credit = one story). Legacy subscribers pass as before. Bundle purchases
// don't gate anything yet; their consumption fires at finalize (3.4 / Phase 5).
export const POST: RequestHandler = async ({ locals, request }) => {
  const authSession = await locals.getSession();
  if (!authSession) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = authSession.user.id;
  const email = authSession.user.email || '';

  // The current client posts with no body; tolerate that.
  let body: { storyId?: string; takeover?: boolean } = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const resumed = !!body.storyId;

  const coachSession = createSession(body.storyId ?? null);

  // ── Entitlement + story row ──────────────────────────────────────────────
  let deducted = false;
  let newCredits: number | null = null;
  let storyId: string;
  let storyState: { starSections: any; starStatus: any; question: string | null; status: string } | null = null;

  if (resumed) {
    // Ownership is enforced by RLS: a story that isn't ours reads as "not found".
    const { data: story, error: storyErr } = await locals.supabase
      .from('stories')
      .select('id, status, star_sections, star_status, extracted_question')
      .eq('id', body.storyId)
      .single();
    if (storyErr || !story) {
      return json({ error: 'story_not_found' }, { status: 404 });
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
    let subscriber = false;
    try {
      subscriber = await hasActiveSubscription(locals.supabase, userId, email);
    } catch (err: any) {
      // If Stripe is unreachable we cannot confirm entitlement. Fail closed rather
      // than risk giving a free story; the user can retry.
      console.error('Subscription check failed on start:', err.message);
      return json({ error: 'billing_unavailable' }, { status: 503 });
    }

    // Atomic credit deduction for non-subscribers. Happens BEFORE anything
    // expensive, so we never pay for Claude then fail to charge.
    if (!subscriber) {
      const { data: result, error: deductError } = await locals.supabase.rpc('deduct_credit', {
        p_session_id: coachSession.id,
      });
      if (deductError) {
        console.error('deduct_credit RPC failed:', deductError.message);
        return json({ error: 'deduct_failed' }, { status: 500 });
      }
      if (result === -1) {
        return json({ error: 'no_credits' }, { status: 402 });
      }
      deducted = true;
      newCredits = result;
    }

    const { data: story, error: storyErr } = await locals.supabase
      .from('stories')
      .insert({ user_id: userId, status: 'in_progress' })
      .select('id')
      .single();
    if (storyErr || !story) {
      console.error('Failed to create story:', storyErr?.message);
      if (deducted) await refund(locals.supabase, coachSession.id, 'start_failed');
      return json({ error: 'start_failed' }, { status: 500 });
    }
    storyId = story.id;
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
    await undoStart(locals.supabase, coachSession.id, deducted, resumed ? null : storyId);
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
      credits: newCredits, // null for subscribers and for resumes; new balance otherwise
      // Stored state so the sidebar fills before the first turn.
      starSections: storyState?.starSections ?? null,
      starStatus: storyState?.starStatus ?? null,
      question: storyState?.question ?? null,
      storyStatus: storyState?.status ?? 'in_progress',
    });
  } catch (err: any) {
    console.error('Error starting session:', err);
    await undoStart(locals.supabase, coachSession.id, deducted, resumed ? null : storyId);
    return json({ error: 'start_failed' }, { status: 500 });
  }
};

async function refund(supabase: any, sessionId: string, reason: string) {
  const { error } = await supabase.rpc('refund_credit', { p_session_id: sessionId, p_reason: reason });
  if (error) console.error('refund_credit RPC failed after start error:', error.message);
}

// Start failed after we charged and/or created a story row. Refund atomically,
// server-side, and remove a NEW story that never got a session so no zero-session
// in_progress story lingers on the dashboard. A resumed story is left alone.
async function undoStart(supabase: any, sessionId: string, deducted: boolean, newStoryId: string | null) {
  if (deducted) await refund(supabase, sessionId, 'start_failed');
  if (newStoryId) {
    const { error } = await supabase.from('stories').delete().eq('id', newStoryId);
    if (error) console.error('Failed to remove orphan story:', error.message);
  }
}
