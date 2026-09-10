import type { PageServerLoad } from './$types';
import { getPlanSummary, storyExpiries, loadPurchases } from '$lib/server/entitlement';

export const load: PageServerLoad = async ({ locals, parent, depends }) => {
    // Lets the summary page call invalidate('app:stories') so a newly saved story
    // shows up without a hard refresh.
    depends('app:stories');

    const [parentData, session] = await Promise.all([parent(), locals.getSession()]);
    if (!session) {
        return { recentStories: [], totalStories: 0, completedStories: 0, inProgressStories: 0, totalSessions: 0 };
    }

    const userId = session.user.id;

    // One round of parallel reads. These were serial before (about nine hops from
    // the edge to Supabase, ~150ms each) and made every Dashboard load take 1-2s.
    const [
        { data: recentStories },
        { count: completedStories },
        { count: inProgressStories },
        { count: totalSessions },
        { data: recentSessions },
        snap,
    ] = await Promise.all([
        locals.supabase
            .from('stories')
            .select('id, question, created_at, tier, status, extracted_question, star_sections, updated_at, purchase_id')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .limit(3),
        locals.supabase.from('stories').select('id', { count: 'exact', head: true })
            .eq('user_id', userId).eq('status', 'complete'),
        locals.supabase.from('stories').select('id', { count: 'exact', head: true })
            .eq('user_id', userId).eq('status', 'in_progress'),
        locals.supabase.from('session_logs').select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
        locals.supabase
            .from('session_logs')
            .select('session_id, status, created_at, duration_ms')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(10),
        loadPurchases(locals.supabase),
    ]);
    const totalStories = (completedStories || 0) + (inProgressStories || 0);

    const plan = await getPlanSummary(locals.supabase, snap);
    const expiries = await storyExpiries(locals.supabase, recentStories || [], snap);
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
