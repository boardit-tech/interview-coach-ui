import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env['VITE_STRIPE_SECRET_KEY'], {
  apiVersion: '2023-08-16',
});

export { stripe };

/**
 * Resolve the user's Stripe customer id.
 *
 * Prefers the id stored on their profile — passing `customer_email` to Checkout
 * makes Stripe mint a NEW customer per checkout, so an email lookup can return a
 * customer that doesn't hold the subscription. Falls back to the email lookup for
 * users who purchased before we started storing the id (self-heals on their next
 * checkout), and in that case scans ALL matching customers rather than just the
 * first, so an existing duplicate can't hide an active subscription.
 */
export async function resolveCustomerId(
  supabase: any,
  userId: string,
  email: string
): Promise<string | null> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();

  // NOTE: a stored id is only valid in the Stripe mode that created it. Test-mode and
  // live-mode ids look identical, and the database is shared across localhost/preview/
  // production — so never sign into production with an email used for sandbox testing
  // (and vice versa), or the stored id won't resolve in the other mode.
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;

  if (!email) return null;
  const customers = await stripe.customers.list({ email: email.trim().toLowerCase(), limit: 100 });
  if (customers.data.length === 0) return null;

  // Prefer a customer that actually has an active subscription.
  for (const c of customers.data) {
    const subs = await stripe.subscriptions.list({ customer: c.id, status: 'active', limit: 1 });
    if (subs.data.length > 0) return c.id;
  }
  return customers.data[0].id;
}

/** Persist the customer id so future checkouts and lookups reuse it. */
export async function saveCustomerId(supabase: any, userId: string, customerId: string) {
  const { error } = await supabase
    .from('profiles')
    .update({ stripe_customer_id: customerId })
    .eq('id', userId);
  if (error) console.error('Failed to save stripe_customer_id:', error.message);
}
