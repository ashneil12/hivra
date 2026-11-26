import { createHash } from 'node:crypto';

import { ensureCanaryQaAccount } from '../e2e/canary-qa/account';
import {
  assertCanaryQaBaseUrl,
  assertCanaryQaClerkKey,
  assertCanaryQaSupabaseUrl,
  canaryQaCreditMicroUsd,
  readCanaryQaEmail,
} from '../e2e/canary-qa/config';

const email = 'qa-fixture+clerk_test@example.com';
const fixtureHost = 'fixture-project.supabase.co';
const fixtureHash = createHash('sha256').update(fixtureHost).digest('hex');

describe('standing Canary QA account guards', () => {
  it('reads the address only from env and requires a Clerk test address on a reserved domain', () => {
    expect(() => readCanaryQaEmail({})).toThrow(/CANARY_QA_EMAIL is not set/);
    expect(() => readCanaryQaEmail({ CANARY_QA_EMAIL: 'qa@example.com' })).toThrow(/not a Clerk test address/);
    expect(() => readCanaryQaEmail({ CANARY_QA_EMAIL: 'qa+clerk_test@hivra.cloud' })).toThrow(/reserved example domain/);
    expect(readCanaryQaEmail({ CANARY_QA_EMAIL: ' QA-Fixture+clerk_test@Example.com ' })).toBe(email);
  });

  it('refuses live and unrecognised Clerk keys', () => {
    expect(() => assertCanaryQaClerkKey('sk_live_abc')).toThrow(/live Clerk secret key/);
    expect(() => assertCanaryQaClerkKey('')).toThrow(/sk_test_/);
    expect(() => assertCanaryQaClerkKey('pk_test_abc')).toThrow(/sk_test_/);
    expect(() => assertCanaryQaClerkKey('sk_test_abc')).not.toThrow();
  });

  it('refuses every Supabase project but Canary', () => {
    expect(() => assertCanaryQaSupabaseUrl('https://some-other-project.supabase.co')).toThrow(/only the Canary project/);
    expect(() => assertCanaryQaSupabaseUrl(`https://${fixtureHost}`)).toThrow(/only the Canary project/);
    expect(() => assertCanaryQaSupabaseUrl(`http://${fixtureHost}`, fixtureHash)).toThrow(/only the Canary project/);
    expect(() => assertCanaryQaSupabaseUrl(undefined)).toThrow(/missing or invalid/);
    expect(assertCanaryQaSupabaseUrl(`https://${fixtureHost}/`, fixtureHash)).toBe(`https://${fixtureHost}`);
  });

  it('refuses production and look-alike app hosts', () => {
    expect(() => assertCanaryQaBaseUrl('https://hivra.cloud')).toThrow(/refusing to target/);
    expect(() => assertCanaryQaBaseUrl('https://canary.hermesos.cloud.evil.test')).toThrow(/refusing to target/);
    expect(assertCanaryQaBaseUrl('https://canary.hermesos.cloud/')).toBe('https://canary.hermesos.cloud');
  });

  it('caps the credit reset', () => {
    expect(canaryQaCreditMicroUsd({})).toBe(2_000_000);
    expect(canaryQaCreditMicroUsd({ CANARY_QA_CREDIT_USD: '0' })).toBe(0);
    expect(() => canaryQaCreditMicroUsd({ CANARY_QA_CREDIT_USD: '50' })).toThrow(/capped/);
    expect(() => canaryQaCreditMicroUsd({ CANARY_QA_CREDIT_USD: '-1' })).toThrow(/from 0/);
  });

  it('makes no request with a live key or a non-Canary database', async () => {
    const fetchImpl = jest.fn();
    const base = { email, serviceRoleKey: 'service', creditMicroUsd: 0, fetchImpl: fetchImpl as unknown as typeof fetch };
    await expect(
      ensureCanaryQaAccount({ ...base, clerkSecretKey: 'sk_live_abc', supabaseUrl: `https://${fixtureHost}` }),
    ).rejects.toThrow(/live Clerk secret key/);
    await expect(
      ensureCanaryQaAccount({ ...base, clerkSecretKey: 'sk_test_abc', supabaseUrl: 'https://prod-like.supabase.co' }),
    ).rejects.toThrow(/only the Canary project/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
