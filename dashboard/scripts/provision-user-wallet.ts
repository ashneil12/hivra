/**
 * provision-user-wallet — single-user Bankr payment-address repair.
 *
 * Sister script to `backfill-bankr-wallets.ts` but scoped to ONE user. Use
 * when a user's credit_deposit payment address is missing or has no sweep
 * credential. It no longer creates `hermesos_lock` wallets: those held
 * users' tokens for a tier, and holding now happens in the user's own wallet.
 *
 * Usage:
 *   npm run provision:user-wallet -- --user-id user_2abc123
 *   npm run provision:user-wallet -- --email someone@example.com
 *   npm run provision:user-wallet -- --user-id user_2abc123 --dry-run
 *
 * Env required:
 *   CLERK_SECRET_KEY        (email lookup AND any future Clerk read)
 *   BANKR_PARTNER_KEY       (real provisioning — omit with --dry-run)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (DB writes)
 *
 * NOTE on env: `vercel env pull` masks RESEND_API_KEY and CLERK_SECRET_KEY,
 * so pass them inline if running against the prod env:
 *   CLERK_SECRET_KEY=sk_live_… BANKR_PARTNER_KEY=… npm run provision:user-wallet -- --email …
 */

import { loadEnvConfig } from "@next/env";
import { createClerkClient } from "@clerk/backend";

import {
  ensureBankrDepositWalletForUser,
  type BankrDepositWalletCredential,
} from "../src/lib/billing/bankr-deposit-wallets";
import { getBankrPartnerConfig } from "../src/lib/billing/bankr-wallets";

loadEnvConfig(process.cwd());

type Args = {
  userId: string | null;
  email: string | null;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { userId: null, email: null, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--user-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("`--user-id` requires a value (e.g. user_2abc123)");
      }
      args.userId = value;
      i += 1;
      continue;
    }

    if (arg === "--email") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("`--email` requires a value");
      }
      args.email = value;
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.userId && !args.email) {
    throw new Error("Pass either --user-id <clerk_id> or --email <addr>.");
  }
  if (args.userId && args.email) {
    throw new Error("Pass --user-id OR --email, not both.");
  }

  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: provision:user-wallet -- (--user-id <id> | --email <addr>) [--dry-run]",
      "",
      "Provisions the credit_deposit Bankr payment address (Hivra's own receipt",
      "address) for a single user. It never creates hermesos_lock wallets.",
      "Idempotent — re-runs no-op on already-provisioned rows.",
      "",
      "Options:",
      "  --user-id <id>    Clerk user id (e.g. user_2abc123)",
      "  --email <addr>    Look up the Clerk user by email and provision",
      "  --dry-run         Resolve the user but skip the actual provisioning",
      "  --help, -h        Show this help",
      "",
    ].join("\n")
  );
}

async function resolveUserIdFromEmail(email: string, clerkSecretKey: string): Promise<string> {
  const clerk = createClerkClient({ secretKey: clerkSecretKey });
  const page = await clerk.users.getUserList({
    emailAddress: [email],
    limit: 5,
  });
  if (page.data.length === 0) {
    throw new Error(`No Clerk user found for email ${email}.`);
  }
  if (page.data.length > 1) {
    const ids = page.data.map((u) => u.id).join(", ");
    throw new Error(
      `Multiple Clerk users matched email ${email}: ${ids}. Re-run with --user-id.`
    );
  }
  return page.data[0].id;
}

function summarise(label: string, credential: BankrDepositWalletCredential | null): string {
  if (!credential) return `${label}: <no credential returned>`;
  const addr = credential.normalizedEvmAddress || credential.evmAddress;
  return `${label}: ${addr} (purpose=${credential.purpose}, apiKeyStatus=${credential.apiKeyStatus})`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (args.email && !clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY required for --email lookup.");
  }

  const partnerConfig = getBankrPartnerConfig();
  if (!partnerConfig.configured && !args.dryRun) {
    throw new Error(
      "Bankr partner key is not configured. Set BANKR_PARTNER_KEY before running, or pass --dry-run."
    );
  }

  let userId = args.userId;
  if (!userId && args.email) {
    process.stdout.write(`[provision-user-wallet] resolving Clerk user for email=${args.email}…\n`);
    userId = await resolveUserIdFromEmail(args.email, clerkSecretKey!);
  }
  if (!userId) {
    throw new Error("Could not resolve a user id.");
  }

  process.stdout.write(
    `[provision-user-wallet] target user=${userId}${args.email ? ` <${args.email}>` : ""}${args.dryRun ? " (DRY RUN)" : ""}\n`
  );

  if (args.dryRun) {
    process.stdout.write("[provision-user-wallet] dry run — skipping ensureBankrDepositWalletForUser.\n");
    return;
  }

  // Only Hivra's own payment-receipt address. hermesos_lock wallets are no
  // longer created (holders move to their own wallet).
  const credit = await ensureBankrDepositWalletForUser({
    userId,
    purpose: "credit_deposit",
  });

  process.stdout.write(`[provision-user-wallet] credit_deposit status=${credit.status}\n`);
  if (credit.status === "not_configured") {
    process.stdout.write("[provision-user-wallet] credit_deposit returned not_configured — check BANKR_PARTNER_KEY.\n");
    process.exit(2);
  }
  process.stdout.write(`  ${summarise("credit_deposit", credit.credential)}\n`);

  const created = credit.status === "provisioned" || credit.status === "credential_created";
  process.stdout.write(
    `[provision-user-wallet] done — ${created ? "NEW credential(s) created" : "all credentials already existed"}.\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[provision-user-wallet] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
