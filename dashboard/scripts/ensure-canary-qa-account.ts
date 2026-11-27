/**
 * Ensure or repair the standing Canary QA account (see e2e/README.md).
 *
 *   CANARY_QA_EMAIL=… CLERK_SECRET_KEY=sk_test_… \
 *   CANARY_QA_SUPABASE_URL=… CANARY_QA_SUPABASE_SERVICE_ROLE_KEY=… \
 *   npm run qa:canary-account
 *
 * Refuses sk_live_ keys and any Supabase project other than Canary. Never
 * prints the address or a key.
 */
import { ensureCanaryQaAccount } from './lib/repair-canary-qa-account';
import { canaryQaCreditMicroUsd, readCanaryQaEmail } from '../e2e/canary-qa/config';

async function main() {
  const env = process.env;
  const result = await ensureCanaryQaAccount({
    email: readCanaryQaEmail(env),
    clerkSecretKey: env.CLERK_SECRET_KEY ?? '',
    supabaseUrl: env.CANARY_QA_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || '',
    serviceRoleKey: env.CANARY_QA_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    creditMicroUsd: canaryQaCreditMicroUsd(env),
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        clerkUser: result.createdClerkUser ? 'created' : 'existing',
        userId: result.userId,
        plan: result.plan,
        creditBeforeUsd: result.creditBeforeMicroUsd / 1_000_000,
        creditAfterUsd: result.creditAfterMicroUsd / 1_000_000,
        activeAgents: result.activeAgents,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
