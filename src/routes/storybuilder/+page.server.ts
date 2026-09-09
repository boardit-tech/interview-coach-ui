import type { PageServerLoad } from './$types';
import { getPlanSummary, storyExpiries } from '$lib/server/entitlement';
import { hasActiveSubscription } from '$lib/server/billing';

// The lobby needs two things before the mic turns on: what's about to be resumed
// (question, progress, whether its window has closed), and whether a NEW story
// can be started at all (stories left, when the window ends). RLS scopes every
// read to the user's own rows.
export const load: PageServerLoad = async ({ locals, url }) => {
  const session = await locals.getSession();
  if (!session) return { resumeStory: null, plan: null, credits: 0, subscriber: false };

  // Legacy subscribers (two accounts, until blast day) bypass the allowance
  // gates below. Looked up here — not in the root layout — so it costs a Stripe
  // round trip only on this page. Any failure reads as "not a subscriber"; the
  // authoritative check is in /api/start.
  let subscriber = false;
  try {
    subscriber = await hasActiveSubscription(locals.supabase, session.user.id, session.user.email || '');
  } catch { /* fail open for display only */ }

  const storyId = url.searchParams.get('story');

  const [plan, { data: profile }, storyRes] = await Promise.all([
    getPlanSummary(locals.supabase),
    locals.supabase.from('profiles').select('credits').eq('id', session.user.id).single(),
    storyId
      ? locals.supabase
          .from('stories')
          .select('id, status, question, extracted_question, star_sections, updated_at, purchase_id')
          .eq('id', storyId)
          .single()
      : Promise.resolve({ data: null }),
  ]);

  let resumeStory = null;
  const data = storyRes.data;
  if (data) {
    const exp = (await storyExpiries(locals.supabase, [data])).get(data.id) ?? null;
    resumeStory = {
      id: data.id,
      status: data.status as 'in_progress' | 'complete',
      question: data.question || data.extracted_question || null,
      green: ['situation', 'task', 'action', 'result'].filter(k => !!data.star_sections?.[k]).length,
      updatedAt: data.updated_at,
      expiresAt: exp?.expiresAt ?? null,
      expired: exp?.expired ?? false,
    };
  }

  return { subscriber, resumeStory, plan, credits: profile?.credits ?? 0 };
};
