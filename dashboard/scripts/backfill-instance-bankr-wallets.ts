import { loadEnvConfig } from "@next/env";

import { getBankrWalletForInstance } from "../src/lib/billing/bankr-instance-wallets";
import { preinstallBankrSuiteForInstance } from "../src/lib/services/instance-service";
import { supabaseAdmin } from "../src/lib/supabase";
import { planInstanceBankrBackfill } from "./bankr-backfill-plan";

loadEnvConfig(process.cwd());

type Args = {
  dryRun: boolean;
  pageSize: number;
  limit: number | null;
  delayMs: number;
};

type InstanceRow = {
  id: string;
  user_id: string;
  name: string | null;
  status: string;
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
      if (!Number.isFinite(value) || value <= 0) throw new Error("--page-size must be positive");
      args.pageSize = Math.min(Math.floor(value), 500);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--limit must be positive");
      args.limit = Math.floor(value);
      index += 1;
      continue;
    }
    if (arg === "--delay-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error("--delay-ms must be non-negative");
      args.delayMs = Math.floor(value);
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
      "Usage: backfill:instance-bankr-wallets [options]",
      "",
      "Seeds the Bankr skills onto running Hermes instances that already have an active agent wallet.",
      "It never creates or retries a wallet: Hivra no longer provisions agent wallets (users connect their own Bankr account).",
      "",
      "Options:",
      "  --dry-run         List instances without writing to DB or calling Bankr",
      "  --page-size <n>   Supabase page size (default 100, max 500)",
      "  --limit <n>       Stop after processing N instances",
      "  --delay-ms <n>    Delay between instances (default 50)",
      "  --help, -h        Show this help",
      "",
    ].join("\n")
  );
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadInstances(from: number, to: number): Promise<InstanceRow[]> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, name, status")
    .neq("status", "deleted")
    .order("created_at", { ascending: true })
    .range(from, to);

  if (error) {
    throw new Error(error.message || "Failed to load Hermes instances");
  }

  return (data || []) as InstanceRow[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!supabaseAdmin) throw new Error("Database not configured");

  process.stdout.write(
    `[backfill-instance-bankr-wallets] starting${args.dryRun ? " (DRY RUN)" : ""}${args.limit ? ` limit=${args.limit}` : ""}\n`
  );

  let processed = 0;
  let skipped = 0;
  let seeded = 0;
  let seedErrors = 0;
  let offset = 0;

  while (true) {
    const remaining = args.limit ? Math.max(0, args.limit - processed) : null;
    if (remaining === 0) break;
    const pageSize = remaining ? Math.min(args.pageSize, remaining) : args.pageSize;
    const rows = await loadInstances(offset, offset + pageSize - 1);
    if (rows.length === 0) break;

    for (const row of rows) {
      processed += 1;
      const existing = await getBankrWalletForInstance({ instanceId: row.id });
      const action = planInstanceBankrBackfill({
        instance: row,
        wallet: existing,
      });

      if (action === "skip") {
        skipped += 1;
        process.stdout.write(`[backfill-instance-bankr-wallets] SKIP instance=${row.id} (${row.name || "unnamed"})\n`);
        continue;
      }

      if (args.dryRun) {
        process.stdout.write(`[backfill-instance-bankr-wallets] WOULD_SEED_SKILLS instance=${row.id} user=${row.user_id}\n`);
        continue;
      }

      try {
        const seedResult = await preinstallBankrSuiteForInstance({
          instanceId: row.id,
          userId: row.user_id,
        });
        seeded += 1;
        process.stdout.write(
          `[backfill-instance-bankr-wallets] SEEDED_SKILLS instance=${row.id} count=${seedResult.count}\n`
        );
      } catch (err) {
        seedErrors += 1;
        process.stdout.write(
          `[backfill-instance-bankr-wallets] ERROR instance=${row.id}: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }

      await delay(args.delayMs);
    }

    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  process.stdout.write(
    `[backfill-instance-bankr-wallets] done processed=${processed} skipped=${skipped} seeded=${seeded} seedErrors=${seedErrors}\n`
  );
  if (seedErrors > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`[backfill-instance-bankr-wallets] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
