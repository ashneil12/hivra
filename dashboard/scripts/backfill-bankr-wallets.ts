import { loadEnvConfig } from "@next/env";
import { createClerkClient } from "@clerk/backend";

import {
  ensureBankrDepositWalletForUser,
} from "../src/lib/billing/bankr-deposit-wallets";
import {
  getBankrPartnerConfig,
} from "../src/lib/billing/bankr-wallets";

loadEnvConfig(process.cwd());

type Args = {
  dryRun: boolean;
  pageSize: number;
  limit: number | null;
  delayMs: number;
};

type UserSummary = {
  id: string;
  email: string | null;
};

type Outcome = "provisioned" | "existing" | "not_configured" | "error";

type RunStats = {
  processed: number;
  provisioned: number;
  existing: number;
  notConfigured: number;
  errors: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    pageSize: 100,
    limit: null,
    delayMs: 50,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--page-size") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("`--page-size` must be a positive number");
      }
      args.pageSize = Math.min(value, 500);
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("`--limit` must be a positive number");
      }
      args.limit = value;
      index += 1;
      continue;
    }

    if (arg === "--delay-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("`--delay-ms` must be a non-negative number");
      }
      args.delayMs = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: backfill:bankr-wallets [options]",
      "",
      "Provisions Bankr deposit wallets (credit_deposit + hermesos_lock)",
      "for every existing Clerk user. Idempotent — safe to re-run.",
      "",
      "Options:",
      "  --dry-run         List users without calling Bankr or writing to DB",
      "  --page-size <n>   Clerk user page size (default 100, max 500)",
      "  --limit <n>       Stop after processing N users",
      "  --delay-ms <n>    Delay between users to avoid rate-limiting Bankr (default 50)",
      "  --help, -h        Show this help",
      "",
    ].join("\n")
  );
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function summariseEmail(user: { emailAddresses?: Array<{ emailAddress: string | null }> }): string | null {
  const first = user.emailAddresses?.[0]?.emailAddress;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

async function provisionForUser(userId: string, dryRun: boolean): Promise<{ outcome: Outcome; reason?: string }> {
  if (dryRun) {
    return { outcome: "existing", reason: "dry-run" };
  }

  try {
    const [creditResult, lockResult] = await Promise.all([
      ensureBankrDepositWalletForUser({
        userId,
        purpose: "credit_deposit",
        makePrimary: true,
      }),
      ensureBankrDepositWalletForUser({
        userId,
        purpose: "hermesos_lock",
        makePrimary: false,
      }),
    ]);

    if (creditResult.status === "not_configured" || lockResult.status === "not_configured") {
      return { outcome: "not_configured" };
    }

    if (creditResult.status === "existing" && lockResult.status === "existing") {
      return { outcome: "existing" };
    }

    return { outcome: "provisioned" };
  } catch (err) {
    return {
      outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY must be set in the environment.");
  }

  const partnerConfig = getBankrPartnerConfig();
  if (!partnerConfig.configured && !args.dryRun) {
    throw new Error(
      "Bankr partner key is not configured. Set BANKR_PARTNER_KEY (or BANKR_PARTNER_API_KEY) before running this backfill, or pass --dry-run to preview."
    );
  }

  const clerk = createClerkClient({ secretKey: clerkSecretKey });

  process.stdout.write(
    `[backfill-bankr-wallets] starting${args.dryRun ? " (DRY RUN)" : ""} pageSize=${args.pageSize}${args.limit ? ` limit=${args.limit}` : ""}\n`
  );

  const stats: RunStats = {
    processed: 0,
    provisioned: 0,
    existing: 0,
    notConfigured: 0,
    errors: 0,
  };

  let offset = 0;
  let totalKnown: number | null = null;

  while (true) {
    const remainingForLimit = args.limit ? Math.max(0, args.limit - stats.processed) : null;
    if (remainingForLimit === 0) break;

    const limitForPage = remainingForLimit
      ? Math.min(args.pageSize, remainingForLimit)
      : args.pageSize;

    const page = await clerk.users.getUserList({
      limit: limitForPage,
      offset,
      orderBy: "+created_at",
    });

    if (totalKnown === null) {
      totalKnown = typeof page.totalCount === "number" ? page.totalCount : null;
    }

    if (page.data.length === 0) break;

    for (const user of page.data) {
      const summary: UserSummary = {
        id: user.id,
        email: summariseEmail(user),
      };

      const { outcome, reason } = await provisionForUser(summary.id, args.dryRun);
      stats.processed += 1;

      if (outcome === "provisioned") stats.provisioned += 1;
      if (outcome === "existing") stats.existing += 1;
      if (outcome === "not_configured") stats.notConfigured += 1;
      if (outcome === "error") stats.errors += 1;

      const tag =
        outcome === "provisioned"
          ? "PROVISIONED"
          : outcome === "existing"
          ? "EXISTING"
          : outcome === "not_configured"
          ? "NOT_CONFIGURED"
          : "ERROR";

      process.stdout.write(
        `[backfill-bankr-wallets] ${tag} user=${summary.id}${summary.email ? ` <${summary.email}>` : ""}${reason ? ` (${reason})` : ""}\n`
      );

      if (outcome === "not_configured") {
        process.stdout.write(
          "[backfill-bankr-wallets] aborting — partner key returned not_configured. Check BANKR_PARTNER_KEY.\n"
        );
        printSummary(stats, totalKnown, args.dryRun);
        process.exit(2);
      }

      if (args.delayMs > 0) {
        await delay(args.delayMs);
      }
    }

    offset += page.data.length;

    if (remainingForLimit !== null && stats.processed >= args.limit!) break;
    if (page.data.length < limitForPage) break;
  }

  printSummary(stats, totalKnown, args.dryRun);
}

function printSummary(stats: RunStats, totalKnown: number | null, dryRun: boolean): void {
  process.stdout.write(
    [
      `[backfill-bankr-wallets] done${dryRun ? " (DRY RUN)" : ""}`,
      `  processed=${stats.processed}`,
      `  provisioned=${stats.provisioned}`,
      `  existing=${stats.existing}`,
      `  not_configured=${stats.notConfigured}`,
      `  errors=${stats.errors}`,
      totalKnown !== null ? `  total_clerk_users=${totalKnown}` : null,
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

main().catch((err) => {
  process.stderr.write(`[backfill-bankr-wallets] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
