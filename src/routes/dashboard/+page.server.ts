import type { PageServerLoad } from './$types';
import { getPlanSummary, storyExpiries } from '$lib/server/entitlement';

export const load: PageServerLoad = async ({ locals, parent, depends }) => {
    // Lets the summary page call invalidate('app:stories') so a newly saved story
    // shows up without a hard refresh.
    depends('app:stories');

    const parentData = await parent();
    const session = await locals.getSession();
    if (!session) {
        return { recentStories: [], totalStories: 0, completedStories: 0, inProgressStories: 0, totalSessions: 0 };
    }

    const userId = session.user.id;

    // Fetch recent stories (last 3)
    const { data: recentStories } = await locals.supabase
        .from('stories')
        .select('id, question, created_at, tier, status, extracted_question, star_sections, updated_at, purchase_id')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(3);

    // Counts by status — the recent list is capped at 3, so never count from it.
    const [{ count: completedStories }, { count: inProgressStories }] = await Promise.all([
        locals.supabase.from('stories').select('id', { count: 'exact', head: true })
            .eq('user_id', userId).eq('status', 'complete'),
        locals.supabase.from('stories').select('id', { count: 'exact', head: true })
            .eq('user_id', userId).eq('status', 'in_progress'),
    ]);
    const totalStories = (completedStories || 0) + (inProgressStories || 0);

    // Count total sessions
    const { count: totalSessions } = await locals.supabase
        .from('session_logs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

    // Fetch recent sessions for support form dropdown (last 10)
    const { data: recentSessions } = await locals.supabase
        .from('session_logs')
        .select('session_id, status, created_at, duration_ms')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

    const plan = await getPlanSummary(locals.supabase);
    const expiries = await storyExpiries(locals.supabase, recentStories || []);
    const storiesWithExpiry = (recentStories || []).map((s: any) => ({
        ...s,
        expired: expiries.get(s.id)?.expired ?? false,
    }));

    return {
        plan,
        recentStories: storiesWithExpiry,
        totalStories: totalStories || 0,
        completedStories: completedStories || 0,
        inProgressStories: inProgressStories || 0,
        totalSessions: totalSessions || 0,
        recentSessions: recentSessions || [],
        username: parentData.username || '',
    };
};
