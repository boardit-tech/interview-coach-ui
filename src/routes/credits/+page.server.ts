import Stripe from 'stripe';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

import {
    VITE_STRIPE_ID_60_DAY_BUNDLE,
    VITE_STRIPE_ID_SINGLE_STORY,
    VITE_STRIPE_ID_FINISH_STORY,
} from '$env/static/private';
import { resolveCustomerId } from '$lib/server/billing';

// One-time purchases only for individuals (decided 2026-09-08). The monthly
// subscription is gone from this page; the Stripe subscription CHECK stays in
// /api/start as the seed of future coach seats.
export type Kind = 'bundle' | 'single_story' | 'finish_story';

export type Choice = {
    kind: Kind;
    price: number;
    label: string;
    description: string;
    features: string[];
    stripeID: string;
    storiesAllowed: number;
};

const stripe = new Stripe(import.meta.env['VITE_STRIPE_SECRET_KEY'], {
    apiVersion: '2023-08-16',
});

const OFFERINGS: Record<Kind, Choice> = {
    bundle: {
        kind: 'bundle',
        price: 79,
        label: '60-day story bundle',
        description: 'Up to 15 interview-ready stories within 60 days of purchase.',
        features: [
            'Unlimited coaching sessions per story',
            'Every story saved to your Story Bank, yours to keep',
            'Come back any time to sharpen a finished story',
        ],
        storiesAllowed: 15,
        stripeID: VITE_STRIPE_ID_60_DAY_BUNDLE,
    },
    single_story: {
        kind: 'single_story',
        price: 9,
        label: 'Single story',
        description: 'One interview-ready story for one question, within 30 days of purchase.',
        features: [
            'Unlimited coaching sessions to complete it',
            'Saved to your Story Bank, yours to keep',
        ],
        storiesAllowed: 1,
        stripeID: VITE_STRIPE_ID_SINGLE_STORY,
    },
    // Never listed. Offered only from an expired in-progress story (lobby and
    // Story Bank card), and bound to that story at purchase.
    finish_story: {
        kind: 'finish_story',
        price: 6,
        label: 'Finish this story',
        description: 'Reopen one story you already started, for another 30 days.',
        features: ['Unlimited sessions to finish it'],
        storiesAllowed: 1,
        stripeID: VITE_STRIPE_ID_FINISH_STORY,
    },
};

export const load: PageServerLoad = async ({ locals, url }) => {
    const session = await locals.getSession();
    const finishStoryId = url.searchParams.get('finish');

    // "Your plan": every purchase with its usage, plus any legacy credits.
    let plan: Array<{
        id: string; kind: Kind; source: string; storiesAllowed: number; used: number;
        expiresAt: string; expired: boolean; revoked: boolean; forStory: string | null; note: string | null;
    }> = [];
    let credits = 0;
    let finishStory: { id: string; question: string | null } | null = null;

    if (session) {
        const [{ data: purchases }, { data: consumptions }, { data: profile }] = await Promise.all([
            locals.supabase
                .from('purchases')
                .select('id, kind, source, stories_allowed, expires_at, revoked_at, for_story_id, note')
                .order('expires_at', { ascending: true }),
            locals.supabase.from('story_consumptions').select('purchase_id'),
            locals.supabase.from('profiles').select('credits').eq('id', session.user.id).single(),
        ]);
        const used = new Map<string, number>();
        for (const c of consumptions ?? []) used.set(c.purchase_id, (used.get(c.purchase_id) ?? 0) + 1);
        const now = Date.now();
        plan = (purchases ?? []).map((p: any) => ({
            id: p.id,
            kind: p.kind,
            source: p.source,
            storiesAllowed: p.stories_allowed,
            used: used.get(p.id) ?? 0,
            expiresAt: p.expires_at,
            expired: new Date(p.expires_at).getTime() <= now,
            revoked: !!p.revoked_at,
            forStory: p.for_story_id,
            note: p.note,
        }));
        credits = profile?.credits ?? 0;

        if (finishStoryId) {
            const { data: s } = await locals.supabase
                .from('stories')
                .select('id, question, extracted_question')
                .eq('id', finishStoryId)
                .single();
            if (s) finishStory = { id: s.id, question: s.question || s.extracted_question || null };
        }
    }

    return {
        offerings: [OFFERINGS.bundle, OFFERINGS.single_story],
        finishOffering: OFFERINGS.finish_story,
        finishStory,
        plan,
        credits,
    };
};

export const actions: Actions = {
    purchase: async ({ request, locals, url }) => {
        const session = await locals.getSession();
        if (!session) {
            throw redirect(301, '/login');
        }

        const form = await request.formData();
        const kind = form.get('kind')?.toString() as Kind | undefined;
        const forStoryId = form.get('forStoryId')?.toString() || null;
        if (!kind || !OFFERINGS[kind]) throw redirect(303, '/credits');
        if ((kind === 'finish_story') !== !!forStoryId) throw redirect(303, '/credits');

        const chosen = OFFERINGS[kind];
        const baseUrl = url.origin;

        // Reuse this user's existing Stripe customer when we know it. Passing
        // customer_email instead creates a NEW customer on every checkout, which
        // produces duplicates that break subscription lookups.
        const existingCustomerId = await resolveCustomerId(
            locals.supabase,
            session.user.id,
            session.user.email || ''
        );

        const checkoutSession = await stripe.checkout.sessions.create({
            line_items: [{ price: chosen.stripeID, quantity: 1 }],
            mode: 'payment',
            success_url: `${baseUrl}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: forStoryId ? `${baseUrl}/storybuilder?story=${forStoryId}` : `${baseUrl}/credits`,
            allow_promotion_codes: true,
            ...(existingCustomerId
                ? { customer: existingCustomerId }
                : { customer_email: session.user.email, customer_creation: 'always' as const }),
            // Everything the success handler needs, from Stripe — never from the URL.
            metadata: {
                user_id: session.user.id,
                kind: chosen.kind,
                stories_allowed: String(chosen.storiesAllowed),
                for_story_id: forStoryId ?? '',
            },
        });

        throw redirect(303, checkoutSession.url || '/credits');
    },
};
