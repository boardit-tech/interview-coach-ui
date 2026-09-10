// ── Who may start a sitting, and what it costs ───────────────────────────────
//
// Decided 2026-09-08, subscription step removed 2026-09-09 (no individual has
// one any more; B2B seats will be a DB row written by a webhook, never a live
// Stripe query). Order for a NEW story:
//   1. purchases (our DB) — soonest-expiring unbound allowance with room. Spends it.
//   2. legacy credit — until blast day converts the remaining holders.
// Nothing here talks to Stripe, so a Stripe outage cannot block a start.
// A RESUME spends nothing; it checks the story's own purchase window, with a
// 1-hour grace after expiry for a story that already has a sitting.

export const GRACE_MS = 60 * 60 * 1000;

export type BlockReason = 'no_stories' | 'window_ended' | 'no_purchase';

export type StartDecision =
  | { ok: true; via: 'purchase'; purchaseId: string }
  | { ok: true; via: 'credit' }   // caller performs the deduct (it needs the session id)
  | { ok: false; reason: BlockReason };

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
  hasCredit: boolean
): Promise<StartDecision> {
  const { purchase, reason } = await findAllowance(supabase);
  if (purchase) return { ok: true, via: 'purchase', purchaseId: purchase.id };
  if (hasCredit) return { ok: true, via: 'credit' };
  return { ok: false, reason };
}

// Window for a story that has no purchase attached (decided 2026-09-09):
//   * legacy (migrated, carries the old session_id pointer): already past its
//     window — free to read, $6 to reopen, complete or not. No special rules.
//   * built on a legacy CREDIT (no session_id): 60 days from creation, same as
//     a bundle story. Goes away with 5.5.
const LEGACY_CREDIT_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
export function windowWithoutPurchase(story: { session_id?: string | null; created_at?: string; updated_at?: string }): string {
  if (story.session_id) return story.updated_at ?? story.created_at ?? new Date(0).toISOString();
  return new Date(new Date(story.created_at ?? Date.now()).getTime() + LEGACY_CREDIT_WINDOW_MS).toISOString();
}

/**
 * A resume is free; the only question is whether the story's window is open.
 */
export async function decideResume(
  supabase: any,
  story: { id: string; purchase_id: string | null; session_id?: string | null; created_at?: string; updated_at?: string }
): Promise<ResumeDecision> {
  if (!story.purchase_id) {
    const expiresAt = windowWithoutPurchase(story);
    const expires = new Date(expiresAt).getTime();
    const now = Date.now();
    if (story.session_id || now >= expires + GRACE_MS) {
      return { ok: false, reason: 'story_expired', expiredAt: expiresAt };
    }
    return { ok: true, expiresAt, inGrace: now >= expires };
  }

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

// Everything a page needs about the user's purchases, in ONE parallel read:
// used by getPlanSummary and storyExpiries so a page load does not fetch the
// purchases table twice, serially.
export interface PurchaseSnapshot {
  purchases: Array<{ id: string; stories_allowed: number; expires_at: string; revoked_at: string | null; for_story_id: string | null }>;
  usedCount: Map<string, number>;
}
export async function loadPurchases(supabase: any): Promise<PurchaseSnapshot> {
  const [{ data: purchases }, { data: used }] = await Promise.all([
    supabase
      .from('purchases')
      .select('id, stories_allowed, expires_at, revoked_at, for_story_id')
      .order('expires_at', { ascending: true }),
    supabase.from('story_consumptions').select('purchase_id'),
  ]);
  const usedCount = new Map<string, number>();
  for (const c of used ?? []) usedCount.set(c.purchase_id, (usedCount.get(c.purchase_id) ?? 0) + 1);
  return { purchases: purchases ?? [], usedCount };
}

export async function getPlanSummary(supabase: any, snap?: PurchaseSnapshot): Promise<PlanSummary> {
  const { purchases, usedCount } = snap ?? await loadPurchases(supabase);
  const all = purchases.filter(p => !p.revoked_at);
  if (all.length === 0) return { storiesLeft: 0, poolExpiresAt: null, hasAnyPurchase: false, allExpired: false };

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
  stories: Array<{ id: string; purchase_id: string | null; status: string; session_id?: string | null; created_at?: string; updated_at?: string }>,
  snap?: PurchaseSnapshot
): Promise<Map<string, { expiresAt: string; expired: boolean }>> {
  const out = new Map<string, { expiresAt: string; expired: boolean }>();
  const now = Date.now();
  // Stories with no purchase: legacy = expired; credit-built = 60 days from creation.
  for (const s of stories) {
    if (s.purchase_id) continue;
    const expiresAt = windowWithoutPurchase(s);
    const expired = !!s.session_id || now >= new Date(expiresAt).getTime() + GRACE_MS;
    out.set(s.id, { expiresAt, expired });
  }
  if (!stories.some(s => s.purchase_id)) return out;
  const { purchases } = snap ?? await loadPurchases(supabase);
  const byId = new Map<string, any>(purchases.map((p: any) => [p.id, p]));
  for (const s of stories) {
    const p = s.purchase_id ? byId.get(s.purchase_id) : null;
    if (!p) continue;
    const t = new Date(p.expires_at).getTime();
    out.set(s.id, { expiresAt: p.expires_at, expired: !!p.revoked_at || now >= t + GRACE_MS });
  }
  return out;
}
