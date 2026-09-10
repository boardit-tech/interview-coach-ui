import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// NOTE: The primary deduct flow now lives in /api/start (a credit per STORY),
// which call the atomic deduct_credit / refund_credit RPCs directly. This endpoint
// remains for any direct/manual use and is kept atomic + error-checked for safety.
export const POST: RequestHandler = async ({ locals, request }) => {
    const session = await locals.getSession();
    if (!session) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { action, sessionId } = await request.json();

    if (action !== 'deduct' && action !== 'refund') {
        return json({ error: 'Invalid action' }, { status: 400 });
    }

    if (action === 'deduct') {
        const { data, error } = await locals.supabase.rpc('deduct_credit', {
            p_session_id: sessionId || null,
        });
        if (error) {
            console.error('deduct_credit RPC failed:', error.message);
            return json({ error: 'deduct_failed' }, { status: 500 });
        }
        if (data === -1) {
            return json({ error: 'No credits remaining' }, { status: 402 });
        }
        return json({ credits: data });
    }

    const { data, error } = await locals.supabase.rpc('refund_credit', {
        p_session_id: sessionId || null,
        p_reason: 'manual_refund',
    });
    if (error) {
        console.error('refund_credit RPC failed:', error.message);
        return json({ error: 'refund_failed' }, { status: 500 });
    }
    return json({ credits: data });
};
