import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stripe, saveCustomerId } from '$lib/server/billing';

// Grant on the success redirect (no webhook — decided 2026-09-08). Idempotent:
// grant_purchase keys on the Stripe checkout session id, so a refreshed or
// replayed success URL cannot grant twice. Everything is read from Stripe's
// copy of the session, never from the URL.
export const GET: RequestHandler = async ({ url, locals }) => {
    const session = await locals.getSession();
    if (!session) {
        throw redirect(303, '/login');
    }

    const sessionId = url.searchParams.get('session_id');
    if (!sessionId) {
        throw redirect(303, '/storybuilder');
    }

    let landing = '/storybuilder';
    try {
        const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
        const meta = checkoutSession.metadata ?? {};

        if (checkoutSession.customer && meta.user_id === session.user.id) {
            const customerId = typeof checkoutSession.customer === 'string'
                ? checkoutSession.customer
                : checkoutSession.customer.id;
            await saveCustomerId(locals.supabase, session.user.id, customerId);
        }

        const kind = meta.kind;
        const storiesAllowed = parseInt(meta.stories_allowed || '0', 10);
        const forStoryId = meta.for_story_id || null;

        if (
            checkoutSession.payment_status === 'paid' &&
            meta.user_id === session.user.id &&
            (kind === 'bundle' || kind === 'single_story' || kind === 'finish_story') &&
            storiesAllowed > 0
        ) {
            const { data: purchaseId, error: grantErr } = await locals.supabase.rpc('grant_purchase', {
                p_kind: kind,
                p_stories_allowed: storiesAllowed,
                p_stripe_session_id: sessionId,
                p_for_story_id: forStoryId,
            });
            if (grantErr) console.error('grant_purchase failed:', grantErr.message);

            // A finish_story purchase is spent immediately on the story it was
            // bought for, and the user lands back in that story. (Replay-safe:
            // the partial unique index allows one 'completed' per story, and a
            // second resume_after_expiry against an exhausted purchase raises,
            // which we swallow.)
            if (kind === 'finish_story' && forStoryId && purchaseId) {
                const { error: consumeErr } = await locals.supabase.rpc('consume_story', {
                    p_story_id: forStoryId,
                    p_purchase_id: purchaseId,
                    p_reason: 'resume_after_expiry',
                });
                if (consumeErr && !/exhausted/.test(consumeErr.message)) {
                    console.error('consume_story (finish) failed:', consumeErr.message);
                }
                landing = `/storybuilder?story=${forStoryId}`;
            }
        }
    } catch (err) {
        console.error('Error confirming purchase:', err);
    }

    throw redirect(303, landing);
};
