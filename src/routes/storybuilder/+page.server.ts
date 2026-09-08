import type { PageServerLoad } from './$types';

// When the page opens with ?story=, the lobby shows what's about to be resumed
// (question, progress) before the mic turns on. RLS scopes the read to the
// user's own stories; a foreign or missing id simply yields null and the lobby
// falls back to a fresh start.
export const load: PageServerLoad = async ({ locals, url }) => {
  const storyId = url.searchParams.get('story');
  if (!storyId) return { resumeStory: null };

  const session = await locals.getSession();
  if (!session) return { resumeStory: null };

  const { data } = await locals.supabase
    .from('stories')
    .select('id, status, question, extracted_question, star_sections, updated_at')
    .eq('id', storyId)
    .single();
  if (!data) return { resumeStory: null };

  const green = ['situation', 'task', 'action', 'result'].filter(k => !!data.star_sections?.[k]).length;
  return {
    resumeStory: {
      id: data.id,
      status: data.status as 'in_progress' | 'complete',
      question: data.question || data.extracted_question || null,
      green,
      updatedAt: data.updated_at,
    },
  };
};
