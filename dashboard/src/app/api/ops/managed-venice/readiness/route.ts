import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { getManagedVeniceTreasuryAddress } from "@/lib/billing/managed-venice-token-sweep";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";

const ROUTE = "/api/ops/managed-venice/readiness";
const SOURCE = "ops/managed-venice/readiness";

type CheckStatus = "ok" | "warning" | "blocked";

type ReadinessCheck = {
  key: string;
  label: string;
  status: CheckStatus;
  message: string;
};

type QueryError = { message?: string } | null;

type DbSelectChain = {
  select: (...args: unknown[]) => DbSelectChain;
  limit: (count: number) => Promise<{ data: unknown; error: QueryError }>;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

const MANAGED_VENICE_TABLES = [
  "managed_venice_wallet_accounts",
  "managed_venice_card_ledger_entries",
  "managed_venice_proxy_keys",
  "managed_venice_token_quotes",
  "managed_venice_usage_events",
  "managed_venice_financial_events",
  "managed_venice_platform_state",
];

function addCheck(
  checks: ReadinessCheck[],
  params: {
    key: string;
    label?: string;
    status: CheckStatus;
    message: string;
  }
) {
  checks.push({
    key: params.key,
    label: params.label ?? params.key,
    status: params.status,
    message: params.message,
  });
}

function requireEnvCheck(
  checks: ReadinessCheck[],
  blockers: string[],
  key: string,
  message: string
) {
  if (process.env[key]?.trim()) {
    addCheck(checks, {
      key,
      status: "ok",
      message,
    });
    return;
  }

  blockers.push(key);
  addCheck(checks, {
    key,
    status: "blocked",
    message: `${key} is not configured.`,
  });
}

function upstreamKeyCheck(checks: ReadinessCheck[], blockers: string[]) {
  const resolved = resolveManagedVeniceUpstreamKey({ endpoint: ROUTE });
  if (resolved) {
    addCheck(checks, {
      key: "VENICE_UPSTREAM_KEYS",
      status: "ok",
      message:
        resolved.source === "pool"
          ? `Managed Venice inference key pool is configured (${resolved.poolSize} keys).`
          : "Legacy server-side Venice API key is configured.",
    });
    return;
  }

  blockers.push("VENICE_UPSTREAM_KEYS");
  addCheck(checks, {
    key: "VENICE_UPSTREAM_KEYS",
    status: "blocked",
    message: "MANAGED_VENICE_INFERENCE_KEYS or VENICE_API_KEY is not configured.",
  });
}

function optionalEnvWarning(
  checks: ReadinessCheck[],
  warnings: string[],
  key: string,
  message: string
) {
  if (process.env[key]?.trim()) {
    addCheck(checks, { key, status: "ok", message });
    return;
  }

  warnings.push(key);
  addCheck(checks, {
    key,
    status: "warning",
    message: `${key} is not configured; previews will fall back to the default app URL.`,
  });
}

function readTreasuryAddress(checks: ReadinessCheck[], blockers: string[]) {
  try {
    const treasuryAddress = getManagedVeniceTreasuryAddress(process.env);
    if (treasuryAddress) {
      addCheck(checks, {
        key: "MANAGED_VENICE_TREASURY_BASE_ADDRESS",
        status: "ok",
        message: "Managed Venice treasury sweep destination is configured.",
      });
      return;
    }
  } catch (error) {
    log.warn("Managed Venice treasury address is invalid", {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "managed_venice_readiness_invalid_treasury_address",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }

  blockers.push("MANAGED_VENICE_TREASURY_BASE_ADDRESS");
  addCheck(checks, {
    key: "MANAGED_VENICE_TREASURY_BASE_ADDRESS",
    status: "blocked",
    message:
      "Managed Venice treasury sweep destination is not configured. Set MANAGED_VENICE_TREASURY_BASE_ADDRESS or a Hermes treasury fallback.",
  });
}

function settlementSecretCheck(checks: ReadinessCheck[], blockers: string[]) {
  if (
    process.env.MANAGED_VENICE_SETTLEMENT_SECRET?.trim() ||
    process.env.BILLING_SETTLEMENT_SECRET?.trim()
  ) {
    addCheck(checks, {
      key: "MANAGED_VENICE_SETTLEMENT_SECRET",
      status: "ok",
      message: "Settlement webhook/shared-secret path is configured.",
    });
    return;
  }

  blockers.push("MANAGED_VENICE_SETTLEMENT_SECRET");
  addCheck(checks, {
    key: "MANAGED_VENICE_SETTLEMENT_SECRET",
    status: "blocked",
    message: "Managed Venice settlement secret is not configured.",
  });
}

async function probeTable(db: SupabaseLike, tableName: string): Promise<ReadinessCheck> {
  const { error } = await (db.from(tableName) as DbSelectChain)
    .select("id")
    .limit(1);

  if (error) {
    log.warn("Managed Venice readiness table probe failed", {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "managed_venice_readiness_table_probe_failed",
      tableName,
      errorMessage: error.message || "Unknown table probe error",
    });
    return {
      key: tableName,
      label: tableName,
      status: "blocked",
      message: error.message || `${tableName} is not reachable.`,
    };
  }

  return {
    key: tableName,
    label: tableName,
    status: "ok",
    message: `${tableName} is reachable.`,
  };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing managed Venice readiness check",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "managed_venice_readiness_cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const checks: ReadinessCheck[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  upstreamKeyCheck(checks, blockers);
  requireEnvCheck(
    checks,
    blockers,
    "MANAGED_VENICE_PROXY_KEY_PEPPER",
    "Managed Venice proxy-key hashing pepper is configured."
  );
  settlementSecretCheck(checks, blockers);
  requireEnvCheck(checks, blockers, "STRIPE_SECRET_KEY", "Stripe card top-ups can create checkout sessions.");
  optionalEnvWarning(checks, warnings, "NEXT_PUBLIC_APP_URL", "App URL is configured for WebUI top-up links.");
  readTreasuryAddress(checks, blockers);

  if (!supabaseAdmin) {
    blockers.push("SUPABASE_SERVICE_ROLE_KEY");
    addCheck(checks, {
      key: "SUPABASE_SERVICE_ROLE_KEY",
      status: "blocked",
      message: "Supabase admin client is not configured.",
    });
  } else {
    const db = supabaseAdmin;
    const tableChecks = await Promise.all(
      MANAGED_VENICE_TABLES.map((tableName) => probeTable(db, tableName))
    );
    for (const check of tableChecks) {
      checks.push(check);
      if (check.status === "blocked") blockers.push(check.key);
    }
  }

  return apiSuccess({
    ready: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    blockers,
    warnings,
    checks,
  });
}
