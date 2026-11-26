/**
 * The few Stripe calls the trial-to-Pro journey makes, in test mode only. A
 * live key is refused before any call.
 */
const API = 'https://api.stripe.com/v1';

export function assertTestKey(key: string): void {
  if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
    throw new Error('[trial-journey] the Stripe key must be a test-mode key (sk_test_… or rk_test_…). A live key is refused.');
  }
}

async function stripe(key: string, method: string, path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
  assertTestKey(key);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && res.status !== 404) {
    throw new Error(`[trial-journey] Stripe ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  trial_end: number | null;
  metadata: Record<string, string>;
}

export async function getSubscription(key: string, id: string): Promise<StripeSubscription> {
  return (await stripe(key, 'GET', `/subscriptions/${encodeURIComponent(id)}`)) as unknown as StripeSubscription;
}

/** Ends the trial now: Stripe charges the test card and the paid event reaches the webhook. */
export async function endTrialNow(key: string, id: string): Promise<StripeSubscription> {
  return (await stripe(key, 'POST', `/subscriptions/${encodeURIComponent(id)}`, { trial_end: 'now' })) as unknown as StripeSubscription;
}

/** Every subscription the customer has had, canceled ones included. */
export async function listSubscriptions(key: string, customer: string): Promise<StripeSubscription[]> {
  const body = await stripe(key, 'GET', `/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`);
  return ((body.data as StripeSubscription[] | undefined) ?? []);
}

/** Total the customer has paid across their invoices, in cents. */
export async function amountPaidCents(key: string, customer: string): Promise<number> {
  const body = await stripe(key, 'GET', `/invoices?customer=${encodeURIComponent(customer)}&limit=100`);
  return ((body.data as { amount_paid?: number }[] | undefined) ?? []).reduce((sum, invoice) => sum + (invoice.amount_paid ?? 0), 0);
}

export async function cancelSubscription(key: string, id: string): Promise<void> {
  const result = await stripeCleanupRequest(key, 'DELETE', 'subscriptions', id);
  if (result && result.status !== 'canceled') throw new Error('Stripe subscription cancellation not confirmed');
}

export async function deleteCustomer(key: string, id: string): Promise<void> {
  const result = await stripeCleanupRequest(key, 'DELETE', 'customers', id);
  if (result && result.deleted !== true) throw new Error('Stripe customer deletion not confirmed');
}

async function stripeCleanupRequest(
  key: string,
  method: 'GET' | 'DELETE',
  resource: 'customers' | 'subscriptions',
  id: string,
): Promise<Record<string, unknown> | null> {
  assertTestKey(key);
  const label = `Stripe ${method} ${resource}/${id}`;
  const res = await fetch(`${API}/${resource}/${encodeURIComponent(id)}`, {
    method,
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new Error(`${label}: request failed`); });
  const body = await res.json().catch(() => null);
  if (res.status === 404 && body?.error?.code === 'resource_missing') return null;
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  if (body?.id !== id) throw new Error(`${label}: resource identity not confirmed`);
  return body;
}

export async function removeOwnedStripeBilling(
  key: string,
  userId: string,
  customerId?: string | null,
  subscriptionId?: string | null,
): Promise<void> {
  if (!customerId) {
    if (subscriptionId) throw new Error('Stripe subscription has no customer reference');
    return;
  }
  const customer = await stripeCleanupRequest(key, 'GET', 'customers', customerId);
  const customerPresent = customer && customer.deleted !== true;
  const metadata = customer?.metadata as { clerk_user_id?: string } | undefined;
  if (customerPresent && metadata?.clerk_user_id !== userId) {
    throw new Error('Stripe customer ownership not confirmed');
  }
  if (subscriptionId) {
    const subscription = await stripeCleanupRequest(key, 'GET', 'subscriptions', subscriptionId);
    if (subscription && subscription.customer !== customerId) throw new Error('Stripe subscription ownership not confirmed');
    if (subscription && subscription.status !== 'canceled') {
      if (!customerPresent) throw new Error('Stripe subscription is not canceled but its customer is missing');
      await cancelSubscription(key, subscriptionId);
    }
  }
  if (customerPresent) await deleteCustomer(key, customerId);
}
