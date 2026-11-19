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
  await stripe(key, 'DELETE', `/subscriptions/${encodeURIComponent(id)}`).catch(() => undefined);
}

export async function deleteCustomer(key: string, id: string): Promise<void> {
  await stripe(key, 'DELETE', `/customers/${encodeURIComponent(id)}`).catch(() => undefined);
}
