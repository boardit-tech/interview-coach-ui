import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
    // Lets any page call invalidate('app:credits') to force a fresh balance
    // instead of rendering a cached one (e.g. after a purchase or a refund).
    depends('app:credits');

    const protectedRoutes = ['storybuilder', 'credits', 'stories', 'dashboard'];
    const firstSegment = url.pathname.split('/').filter(Boolean)[0];

    const session = await locals.getSession();

    if (!session && protectedRoutes.includes(firstSegment)) {
        redirect(302, '/login');
    }

    if (session) {
        const user = session.user;
        const email = user.email || '';
        const name = user.user_metadata?.full_name || user.user_metadata?.name || email.split('@')[0];

        // Only the profile row here. The Stripe subscription lookup used to run on
        // EVERY navigation (customer resolve + subscriptions list, serial) and cost
        // 1-2s per page change. Individuals no longer have subscriptions; the two
        // pages that still care (/storybuilder lobby, /credits legacy card) do their
        // own lookup until 5.5 removes it.
        let credits = 0;
        try {
            const { data: profile } = await locals.supabase
                .from('profiles')
                .select('credits')
                .eq('id', user.id)
                .single();
            credits = profile?.credits || 0;
        } catch (err) {
            console.error('Error loading profile:', err);
        }

        return {
            loggedIn: true,
            username: name,
            credits,
        };
    }

    return {
        loggedIn: false,
        username: '',
        credits: 0,
    };
};
