import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assessSession } from '$lib/server/claude';
import { getStoryContext } from '$lib/server/interview';

// Grounded end-of-session assessment. Produces the whole summary (per-section
// talking points + strong/missing, cited strengths/growth, and a full story only
// when all four sections are green) from what the user actually shared. Replaces
// the old generateStoryReport + talking-points + strength-signals trio.
//
// Reads the transcript and STAR state SERVER-SIDE. The client's copy only covers
// the current sitting; a story built across several sittings needs all of them.
export const POST: RequestHandler = async ({ locals, request }) => {
  const authSession = await locals.getSession();
  if (!authSession) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { sessionId, question: clientQuestion } = await request.json();
    if (!sessionId) {
      return json({ error: 'sessionId is required' }, { status: 400 });
    }

    const ctx = await getStoryContext(sessionId, locals.supabase);
    if (!ctx) {
      return json({ error: 'session_not_found' }, { status: 404 });
    }

    const assessment = await assessSession(
      ctx.transcript,
      ctx.starSections,
      ctx.starStatus,
      ctx.question ?? clientQuestion ?? null,
      sessionId,
      locals.supabase,
      ctx.targetCompany
    );

    return json({ assessment });
  } catch (err: any) {
    console.error('assess endpoint error:', err.message);
    return json({ error: 'assess_failed' }, { status: 500 });
  }
};
