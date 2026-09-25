import path from "path";

type AccountDeletionFilterSource = "userId" | "email" | "instanceIds";

export interface AccountDeletionTable {
  table: string;
  filterColumn: string;
  source: AccountDeletionFilterSource;
  reason: string;
  optionalIfMissing?: boolean;
}

export interface AccountDeletionTableCount {
  table: string;
  filterColumn: string;
  count: number;
}

export interface AccountDeletionConfirmation {
  userId: string;
  confirmationUserId: string | null | undefined;
}

const DEFAULT_OPS_SECRET_ENV_RELATIVE_PATH = ".config/hermesdeploy/ops-secrets.env";

export function resolveOpsSecretEnvPath(
  env: Record<string, string | undefined> = process.env,
  homeDir = process.env.HOME || ""
): string {
  const configured = env.HERMES_OPS_SECRET_ENV_PATH?.trim();
  if (configured) return configured;
  return path.join(homeDir, DEFAULT_OPS_SECRET_ENV_RELATIVE_PATH);
}

export const ACCOUNT_DELETION_TABLES: AccountDeletionTable[] = [
  {
    table: "hermes_chat_stream_jobs",
    filterColumn: "user_id",
    source: "userId",
    reason: "queued and in-flight chat completions",
  },
  {
    table: "instance_bankr_wallet_recipients",
    filterColumn: "user_id",
    source: "userId",
    reason: "per-agent Bankr wallet recipient history before wallet deletion",
  },
  {
    table: "instance_bankr_wallets",
    filterColumn: "user_id",
    source: "userId",
    reason: "per-agent Bankr wallets and encrypted agent wallet API keys",
  },
  {
    table: "instance_metering_events",
    filterColumn: "instance_id",
    source: "instanceIds",
    reason: "handled separately from the user's instance ids",
  },
  {
    table: "vm_response_seconds_daily",
    filterColumn: "instance_id",
    source: "instanceIds",
    reason: "handled separately from the user's instance ids",
  },
  // Hivra agent activity (content-free lifecycle events and run/tool records)
  // and per-computer reporter state. Neither has an FK to the account, so they
  // would otherwise survive deletion. See src/lib/ops/activity-retention.ts.
  {
    table: "hivra_agent_events",
    filterColumn: "user_id",
    source: "userId",
    reason: "Hivra agent activity: lifecycle events and run/tool trace records",
  },
  {
    table: "hivra_activity_collectors",
    filterColumn: "user_id",
    source: "userId",
    reason: "Hivra activity reporter state per computer",
    // Newer than hivra_agent_events; a database without it has nothing to delete.
    optionalIfMissing: true,
  },
  // Server setup commands and their receipts. Receipts
  // (infrastructure_server_enrollment_events) go by cascade from their
  // enrollment; the service role can't delete them directly.
  {
    table: "infrastructure_server_enrollments",
    filterColumn: "user_id",
    source: "userId",
    reason: "server setup commands, observed addresses and their receipts",
    // Newer than the other tables; a database without it has nothing to delete.
    optionalIfMissing: true,
  },
  // A computer's last usage read (Manage › Overview). Keyed to the account,
  // and computers are soft-deleted, so the row would otherwise survive.
  {
    table: "hivra_computer_usage",
    filterColumn: "user_id",
    source: "userId",
    reason: "Hivra computer usage reads (CPU, memory, disk, uptime) per computer",
    // Newer than the activity tables; a database without it has nothing to delete.
    optionalIfMissing: true,
  },
  {
    table: "hermes_conversations",
    filterColumn: "user_id",
    source: "userId",
    reason: "chat session mirrors; messages cascade from conversations",
  },
  {
    table: "profiles",
    filterColumn: "user_id",
    source: "userId",
    reason: "agent profiles, prompts, memory, and avatar references",
  },
  {
    table: "llm_usage_events",
    filterColumn: "user_id",
    source: "userId",
    reason: "LLM usage ledger rows tied to the account",
  },
  {
    table: "compute_usage_events",
    filterColumn: "user_id",
    source: "userId",
    reason: "compute usage rows tied to the account",
  },
  {
    table: "credit_ledger_entries",
    filterColumn: "user_id",
    source: "userId",
    reason: "credit accounting entries before deleting credit_accounts",
  },
  {
    table: "credit_reservations",
    filterColumn: "user_id",
    source: "userId",
    reason: "reserved credits before deleting credit_accounts",
  },
  {
    table: "crypto_topup_reconciliation_items",
    filterColumn: "user_id",
    source: "userId",
    reason: "USDC top-up manual-review queue rows before payment transaction cleanup",
  },
  {
    table: "payment_transactions",
    filterColumn: "user_id",
    source: "userId",
    reason: "app-side payment transaction rows",
  },
  {
    table: "managed_venice_reservations",
    filterColumn: "user_id",
    source: "userId",
    reason: "managed Venice spend reservations before usage/proxy cleanup",
  },
  {
    table: "managed_venice_usage_events",
    filterColumn: "user_id",
    source: "userId",
    reason: "managed Venice usage rows tied to the account",
  },
  {
    table: "managed_venice_reconciliation_items",
    filterColumn: "user_id",
    source: "userId",
    reason: "managed Venice reconciliation queue rows before key/account cleanup",
  },
  {
    table: "managed_venice_proxy_keys",
    filterColumn: "user_id",
    source: "userId",
    reason: "managed Venice proxy keys and hashed key material",
  },
  {
    table: "managed_venice_token_quotes",
    filterColumn: "user_id",
    source: "userId",
    reason: "managed Venice token deposit quote rows",
  },
  {
    table: "managed_venice_token_lots",
    filterColumn: "user_id",
    source: "userId",
    reason: "$HermesOS managed Venice FIFO lots before wallet account deletion",
  },
  {
    table: "managed_venice_card_ledger_entries",
    filterColumn: "user_id",
    source: "userId",
    reason: "managed Venice card wallet ledger entries before wallet account deletion",
  },
  {
    table: "managed_venice_wallet_accounts",
    filterColumn: "user_id",
    source: "userId",
    reason: "managed Venice wallet account after dependent rows",
  },
  {
    table: "crypto_wallet_sweeps",
    filterColumn: "user_id",
    source: "userId",
    reason: "crypto sweep audit rows",
  },
  {
    table: "crypto_deposit_receipts",
    filterColumn: "user_id",
    source: "userId",
    reason: "crypto deposit receipt rows",
  },
  {
    table: "bankr_withdrawals",
    filterColumn: "user_id",
    source: "userId",
    reason: "Bankr withdrawal attempts",
  },
  {
    table: "bankr_deposit_wallet_credentials",
    filterColumn: "user_id",
    source: "userId",
    reason: "encrypted Bankr deposit-wallet credentials",
  },
  {
    table: "deposit_quotes",
    filterColumn: "user_id",
    source: "userId",
    reason: "crypto deposit quote rows",
  },
  // Children first: reconciliation items reference quotes and subscriptions,
  // and subscriptions reference the quote that paid for them.
  {
    table: "yearly_token_reconciliation_items",
    filterColumn: "user_id",
    source: "userId",
    reason: "yearly token payment reconciliation items",
  },
  {
    table: "yearly_token_subscriptions",
    filterColumn: "user_id",
    source: "userId",
    reason: "yearly token subscription rows",
  },
  {
    table: "yearly_token_quotes",
    filterColumn: "user_id",
    source: "userId",
    reason: "yearly token subscription quotes",
  },
  {
    table: "token_tier_qualifications",
    filterColumn: "user_id",
    source: "userId",
    reason: "token tier qualification history",
  },
  {
    table: "token_holding_snapshots",
    filterColumn: "user_id",
    source: "userId",
    reason: "token holding snapshots",
  },
  {
    table: "wallet_verification_challenges",
    filterColumn: "user_id",
    source: "userId",
    reason: "wallet verification challenges",
  },
  {
    table: "user_wallets",
    filterColumn: "user_id",
    source: "userId",
    reason: "wallet addresses linked to the user",
  },
  {
    table: "user_withdraw_addresses",
    filterColumn: "user_id",
    source: "userId",
    reason: "stored withdrawal destination",
  },
  {
    table: "user_api_keys",
    filterColumn: "user_id",
    source: "userId",
    reason: "encrypted provider API keys",
  },
  {
    table: "user_vault_profiles",
    filterColumn: "user_id",
    source: "userId",
    reason: "legacy vault profile rows",
    optionalIfMissing: true,
  },
  {
    table: "user_vault",
    filterColumn: "user_id",
    source: "userId",
    reason: "legacy vault rows",
    optionalIfMissing: true,
  },
  {
    table: "signup_risk_assessments",
    filterColumn: "user_id",
    source: "userId",
    reason: "signup abuse/risk signals",
  },
  {
    table: "stripe_checkout_session_activations",
    filterColumn: "user_id",
    source: "userId",
    reason: "checkout replay protection rows",
  },
  {
    table: "hermes_trial_usage",
    filterColumn: "user_id",
    source: "userId",
    reason: "trial usage records",
  },
  {
    table: "hermes_subscriptions",
    filterColumn: "user_id",
    source: "userId",
    reason: "app-side subscription rows",
  },
  {
    table: "credit_accounts",
    filterColumn: "user_id",
    source: "userId",
    reason: "credit account after dependent ledger/reservation rows",
  },
  {
    table: "hermes_instances",
    filterColumn: "user_id",
    source: "userId",
    reason: "instance rows after provider teardown and dependent rows",
  },
  {
    table: "ops_events",
    filterColumn: "user_id",
    source: "userId",
    reason: "ops/audit events linked to the user",
  },
  {
    table: "reservations",
    filterColumn: "clerk_user_id",
    source: "userId",
    reason: "waitlist rows linked after signup",
  },
];

export const ACCOUNT_DELETION_EMAIL_TABLES: AccountDeletionTable[] = [
  {
    table: "reservations",
    filterColumn: "email",
    source: "email",
    reason: "waitlist rows submitted before Clerk signup",
  },
];

const CLERK_USER_ID_RE = /^user_[A-Za-z0-9]+$/;

export function assertConfirmedAccountDeletion(input: AccountDeletionConfirmation): void {
  if (!CLERK_USER_ID_RE.test(input.userId)) {
    throw new Error("Expected a Clerk user id like user_123 before deleting account data.");
  }

  if (input.confirmationUserId !== input.userId) {
    throw new Error("Account deletion confirmation does not match the target user id.");
  }
}

/**
 * This script tears down Hermes instances but not Hivra computers, whose
 * teardown runs through the product delete flow (verified VM destroy, tunnel,
 * DNS and key revocation). Deleting the login while a Hivra computer still
 * runs would strand it, so an apply refuses until every computer is deleted.
 */
export function assertNoLiveHivraComputers(input: { apply: boolean; liveComputerIds: string[] }): void {
  if (!input.apply || input.liveComputerIds.length === 0) return;
  throw new Error(
    `User still has ${input.liveComputerIds.length} Hivra computer(s) that are not deleted ` +
    `(${input.liveComputerIds.join(", ")}). Delete them through the Hivra delete flow first, then re-run.`
  );
}

export interface ClerkDeletionPolicyInput {
  apply: boolean;
  skipClerk: boolean;
  acceptOrphanRisk: boolean;
}

/**
 * Guard against the Fixture Customer A / Fixture Customer B incident (2026-05-07): destroying a live
 * user's instances + DB rows while leaving their Clerk login intact.
 *
 * Combining `--apply` with `--skip-clerk` will tear down provider resources
 * but never call Clerk, leaving the user able to log back in to a half-
 * destroyed account. Require the operator to ack the orphan risk in writing
 * (`--accept-orphan-risk`) so the consequence is recorded in shell history
 * and isn't reachable through a typo or default-flag mistake.
 *
 * Dry runs and apply-with-Clerk runs always pass.
 */
export function assertClerkDeletionPolicy(input: ClerkDeletionPolicyInput): void {
  if (!input.apply) return;
  if (!input.skipClerk) return;
  if (input.acceptOrphanRisk) return;
  throw new Error(
    "--skip-clerk with --apply will destroy the user's instances/DB rows while leaving their login intact (orphan account). Re-run with --accept-orphan-risk if that is intended."
  );
}

/**
 * Resolve CLERK_SECRET_KEY from the supplied env or throw with a recovery
 * hint. Centralised so the script and any future code path that needs to
 * delete a Clerk user fail closed identically — silently skipping Clerk
 * deletion was the proximate cause of the Fixture Customer A / Fixture Customer B incident.
 */
export function requireClerkSecretKey(
  env: Record<string, string | undefined> = process.env
): string {
  const value = env.CLERK_SECRET_KEY?.trim();
  if (!value) {
    throw new Error(
      "CLERK_SECRET_KEY missing — refusing to proceed. Either set CLERK_SECRET_KEY in your ops secrets, or re-run with --skip-clerk --accept-orphan-risk if you understand the user will keep their login."
    );
  }
  return value;
}

export function extractStorageObjectPath(url: string | null | undefined, bucket: string): string | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const marker = `/storage/v1/object/`;
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0) return null;

  const storagePath = parsed.pathname.slice(markerIndex + marker.length);
  const parts = storagePath.split("/").filter(Boolean);
  if (parts.length < 3) return null;

  const visibilityOrAction = parts[0];
  if (visibilityOrAction !== "public" && visibilityOrAction !== "sign") return null;
  if (parts[1] !== bucket) return null;

  const objectPath = parts.slice(2).join("/");
  if (!objectPath) return null;

  try {
    return decodeURIComponent(objectPath);
  } catch {
    return objectPath;
  }
}

export function isMissingOptionalAccountDeletionTableError(
  spec: AccountDeletionTable,
  error: { code?: string; details?: string; hint?: string; message?: string } | null | undefined
): boolean {
  if (!spec.optionalIfMissing || !error) return false;

  const tableName = spec.table.toLowerCase();
  const text = [error.code, error.message, error.details, error.hint]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  if (!text.includes(tableName)) return false;

  return (
    text.includes("could not find the table") ||
    text.includes("schema cache") ||
    text.includes("undefined_table") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

export function buildDeletionTableSummary(counts: AccountDeletionTableCount[]): string {
  if (counts.length === 0) return "no matching app database rows";
  return counts
    .map((entry) => `${entry.table}(${entry.filterColumn})=${entry.count}`)
    .join(", ");
}
