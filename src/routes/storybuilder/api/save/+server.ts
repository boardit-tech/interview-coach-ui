import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Persist the end-of-session summary onto the story.
//
// A story row now exists from the first sitting (created by /api/start), so this
// UPDATES it rather than inserting. `status` flips to 'complete' only when the
// assessment produced a full story, which assessSession gates on all four
// sections being green. A reopened complete story stays complete. Sessions with
// no story (pre-resumability) keep the old insert path.
//
// No ledger write here: the story point is spent at first session start
// (decided 2026-09-08), so completion is a status change and nothing more.
export const POST: RequestHandler = async ({ locals, request }) => {
  const session = await locals.getSession();
  if (!session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { session_id, question, full_story, talking_points, strength_signals, flags, tier } = await request.json();

    const summary = {
      question: question || null,
      full_story: full_story || null,
      talking_points: talking_points || null,
      strength_signals: strength_signals || null,
      flags: flags || null,
      tier: tier || null,
    };

    // Which story does this sitting belong to?
    let storyId: string | null = null;
    if (session_id) {
      const { data: log } = await locals.supabase
        .from('session_logs')
        .select('story_id')
        .eq('session_id', session_id)
        .single();
      storyId = log?.story_id ?? null;
    }

    if (storyId) {
      const { data: current } = await locals.supabase
        .from('stories')
        .select('status')
        .eq('id', storyId)
        .single();
      const complete = current?.status === 'complete' || !!full_story;

      const { error } = await locals.supabase
        .from('stories')
        .update({
          ...summary,
          status: complete ? 'complete' : 'in_progress',
          updated_at: new Date().toISOString(),
        })
        .eq('id', storyId);

      if (error) {
        console.error('Error updating story:', error);
        return json({ error: 'Failed to save story' }, { status: 500 });
      }
      return json({ id: storyId, saved: true, status: complete ? 'complete' : 'in_progress' });
    }

    // Legacy: a session with no story row. Insert one, as before.
    const { data, error } = await locals.supabase.from('stories').insert({
      user_id: session.user.id,
      session_id: session_id || null,
      ...summary,
    }).select('id').single();

    if (error) {
      console.error('Error saving story:', error);
      return json({ error: 'Failed to save story' }, { status: 500 });
    }

    return json({ id: data.id, saved: true, status: 'complete' });
  } catch (err: any) {
    console.error('Save story error:', err);
    return json({ error: 'Failed to save story' }, { status: 500 });
  }
};
