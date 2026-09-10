import type { PageServerLoad } from './$types';
import { getPlanSummary, storyExpiries, loadPurchases } from '$lib/server/entitlement';

// The lobby needs two things before the mic turns on: what's about to be resumed
// (question, progress, whether its window has closed), and whether a NEW story
// can be started at all (stories left, when the window ends). RLS scopes every
// read to the user's own rows.
export const load: PageServerLoad = async ({ locals, url }) => {
  const session = await locals.getSession();
  if (!session) return { resumeStory: null, plan: null };

  const storyId = url.searchParams.get('story');

  const [snap, storyRes] = await Promise.all([
    loadPurchases(locals.supabase),
    storyId
      ? locals.supabase
          .from('stories')
          .select('id, status, question, extracted_question, star_sections, created_at, updated_at, purchase_id')
          .eq('id', storyId)
          .single()
      : Promise.resolve({ data: null }),
  ]);

  const plan = await getPlanSummary(locals.supabase, snap);
  let resumeStory = null;
  const data = storyRes.data;
  if (data) {
    const exp = (await storyExpiries(locals.supabase, [data], snap)).get(data.id) ?? null;
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

  return { resumeStory, plan };
};
