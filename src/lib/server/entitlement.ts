import { hasActiveSubscription } from './billing';

// ── Who may start a sitting, and what it costs ───────────────────────────────
//
// Decided 2026-09-08. Order for a NEW story:
//   1. purchases (our DB) — soonest-expiring unbound allowance with room. Spends it.
//   2. Stripe subscription — kept for future coach seats; the only step that can
//      fail closed, because it's the only one whose answer lives outside our DB.
//   3. legacy credit — until blast day converts the remaining holders.
// A RESUME spends nothing; it checks the story's own purchase window, with a
// 1-hour grace after expiry for a story that already has a sitting.

export const GRACE_MS = 60 * 60 * 1000;

export type BlockReason = 'no_stories' | 'window_ended' | 'no_purchase';

export type StartDecision =
  | { ok: true; via: 'purchase'; purchaseId: string }
  | { ok: true; via: 'subscription' }
  | { ok: true; via: 'credit' }   // caller performs the deduct (it needs the session id)
  | { ok: false; reason: BlockReason | 'billing_unavailable' };

export type ResumeDecision =
  | { ok: true; expiresAt: string | null; inGrace: boolean }
  | { ok: false; reason: 'story_expired'; expiredAt: string };

interface PurchaseRow {
  id: string;
  kind: string;
  stories_allowed: number;
  expires_at: string;
  revoked_at: string | null;
  for_story_id: string | null;
}

/** Live, unbound purchases with room, soonest-expiring first, plus a reason if none. */
export async function findAllowance(
  supabase: any
): Promise<{ purchase: PurchaseRow | null; reason: BlockReason }> {
  const { data: purchases, error } = await supabase
    .from('purchases')
    .select('id, kind, stories_allowed, expires_at, revoked_at, for_story_id')
    .is('revoked_at', null)
    .order('expires_at', { ascending: true });
  if (error) {
    console.error('findAllowance: purchases read failed:', error.message);
    return { purchase: null, reason: 'no_purchase' };
  }
  const all: PurchaseRow[] = purchases ?? [];
  if (all.length === 0) return { purchase: null, reason: 'no_purchase' };

  const { data: used } = await supabase
    .from('story_consumptions')
    .select('purchase_id');
  const usedCount = new Map<string, number>();
  for (const c of used ?? []) usedCount.set(c.purchase_id, (usedCount.get(c.purchase_id) ?? 0) + 1);

  const now = Date.now();
  const live = all.filter(p => new Date(p.expires_at).getTime() > now && !p.for_story_id);
  const withRoom = live.find(p => (usedCount.get(p.id) ?? 0) < p.stories_allowed);
  if (withRoom) return { purchase: withRoom, reason: 'no_stories' };

  // Nothing usable. Say why, so the client can show the right screen.
  return { purchase: null, reason: live.length > 0 ? 'no_stories' : 'window_ended' };
}

export async function decideNewStory(
  supabase: any,
  userId: string,
  email: string,
  hasCredit: boolean
): Promise<StartDecision> {
  const { purchase, reason } = await findAllowance(supabase);
  if (purchase) return { ok: true, via: 'purchase', purchaseId: purchase.id };

  try {
    if (await hasActiveSubscription(supabase, userId, email)) return { ok: true, via: 'subscription' };
  } catch (err: any) {
    // The one unknowable case. Deny rather than guess — a free story during a
    // Stripe outage is worse than a retry.
    console.error('Subscription check failed on start:', err.message);
    return { ok: false, reason: 'billing_unavailable' };
  }

  if (hasCredit) return { ok: true, via: 'credit' };
  return { ok: false, reason };
}

/**
 * A resume is free; the only question is whether the story's window is open.
 * Stories with no purchase_id (built under the credit bridge, or the 29 legacy
 * ones) are grandfathered: they were paid for under the old rules.
 */
export async function decideResume(
  supabase: any,
  story: { id: string; purchase_id: string | null }
): Promise<ResumeDecision> {
  if (!story.purchase_id) return { ok: true, expiresAt: null, inGrace: false };

  const { data: p } = await supabase
    .from('purchases')
    .select('expires_at, revoked_at')
    .eq('id', story.purchase_id)
    .single();
  if (!p) return { ok: true, expiresAt: null, inGrace: false };

  const expires = new Date(p.expires_at).getTime();
  const now = Date.now();
  if (p.revoked_at || now >= expires + GRACE_MS) {
    return { ok: false, reason: 'story_expired', expiredAt: p.expires_at };
  }
  return { ok: true, expiresAt: p.expires_at, inGrace: now >= expires };
}

// ── Read-only summaries for the UI ──────────────────────────────────────────

export interface PlanSummary {
  storiesLeft: number;          // unspent allowance across live unbound purchases
  poolExpiresAt: string | null; // when the soonest live purchase with room ends
  hasAnyPurchase: boolean;
  allExpired: boolean;          // had purchases, none live
}

export async function getPlanSummary(supabase: any): Promise<PlanSummary> {
  const { data: purchases } = await supabase
    .from('purchases')
    .select('id, stories_allowed, expires_at, revoked_at, for_story_id')
    .is('revoked_at', null)
    .order('expires_at', { ascending: true });
  const all = purchases ?? [];
  if (all.length === 0) return { storiesLeft: 0, poolExpiresAt: null, hasAnyPurchase: false, allExpired: false };

  const { data: used } = await supabase.from('story_consumptions').select('purchase_id');
  const usedCount = new Map<string, number>();
  for (const c of used ?? []) usedCount.set(c.purchase_id, (usedCount.get(c.purchase_id) ?? 0) + 1);

  const now = Date.now();
  let storiesLeft = 0;
  let poolExpiresAt: string | null = null;
  let anyLive = false;
  for (const p of all) {
    if (new Date(p.expires_at).getTime() <= now) continue;
    anyLive = true;
    if (p.for_story_id) continue;
    const room = p.stories_allowed - (usedCount.get(p.id) ?? 0);
    if (room > 0) {
      storiesLeft += room;
      if (!poolExpiresAt) poolExpiresAt = p.expires_at;
    }
  }
  return { storiesLeft, poolExpiresAt, hasAnyPurchase: true, allExpired: !anyLive };
}

/** For a list of stories, which are past their window (and the grace hour). */
export async function storyExpiries(
  supabase: any,
  stories: Array<{ id: string; purchase_id: string | null; status: string }>
): Promise<Map<string, { expiresAt: string; expired: boolean }>> {
  const ids = [...new Set(stories.map(s => s.purchase_id).filter(Boolean))] as string[];
  const out = new Map<string, { expiresAt: string; expired: boolean }>();
  if (ids.length === 0) return out;
  const { data: purchases } = await supabase
    .from('purchases').select('id, expires_at, revoked_at').in('id', ids);
  const byId = new Map<string, any>((purchases ?? []).map((p: any) => [p.id, p]));
  const now = Date.now();
  for (const s of stories) {
    const p = s.purchase_id ? byId.get(s.purchase_id) : null;
    if (!p) continue;
    const t = new Date(p.expires_at).getTime();
    out.set(s.id, { expiresAt: p.expires_at, expired: !!p.revoked_at || now >= t + GRACE_MS });
  }
  return out;
}
