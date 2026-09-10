import type { PageServerLoad } from './$types';
import { storyExpiries, loadPurchases } from '$lib/server/entitlement';

export const load: PageServerLoad = async ({ locals, depends }) => {
    depends('app:stories');

    const session = await locals.getSession();
    if (!session) {
        return { stories: [] };
    }

    const [{ data: stories, error }, snap] = await Promise.all([
        locals.supabase
            .from('stories')
            .select('id, question, full_story, talking_points, strength_signals, flags, created_at, tier, status, extracted_question, star_sections, star_status, updated_at, purchase_id, session_id')
            .eq('user_id', session.user.id)
            .order('updated_at', { ascending: false }),
        loadPurchases(locals.supabase),
    ]);

    if (error) {
        console.error('Error loading stories:', error);
        return { stories: [] };
    }

    const expiries = await storyExpiries(locals.supabase, stories || [], snap);
    return {
        stories: (stories || []).map((s: any) => ({ ...s, expired: expiries.get(s.id)?.expired ?? false, expiresAt: expiries.get(s.id)?.expiresAt ?? null })),
    };
};
