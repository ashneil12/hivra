/**
 * One-time managed-Venice STARTER CREDIT (Batch 3 — first-session honesty).
 *
 * Grants a small one-time credit (default $0.50) to a user's managed-Venice
 * CARD wallet on their FIRST managed deploy, so the deploy doesn't dead-end at
 * a $0 funding wall before the agent has done anything. The grant:
 *
 *   - is flag-gated OFF by default (HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED),
 *   - is abuse-gated by REUSING the existing signup risk-assessment row — a
 *     'block' or 'require_card' decision (and no card on file) refuses the grant,
 *   - is granted exactly ONCE per user account, deduped on the card-ledger
 *     unique (source, reference_id, reason) and the financial-event idempotency
 *     key, both keyed on a PER-USER reference 'managed_venice_starter:<userId>',
 *   - reuses the same card-ledger + financial-event accounting path as
 *     grantManagedVeniceCardTopUpCredit, but records a dedicated
 *     'starter_grant' financial event (see the widened CHECK in
 *     20260613150000_managed_venice_financial_events_starter_grant.sql).
 *
 * WHY THE REFERENCE IS PER-USER (2026-07-08 fix):
 * The card ledger's unique index is (source, reference_id, reason) with NO
 * user_id. This module used to write the CONSTANT reference for every user, so
 * the FIRST user granted permanently consumed the only slot in that index:
 * every subsequent user's insert raised 23505, which the race handler below
 * reads as "already granted" and swallows. The grant is best-effort and never
 * throws, so all later users silently received nothing — a global cap of
 * exactly one starter credit for the entire system.
 *
 * Embedding the userId in reference_id fixes this WITHOUT a schema change: the
 * SAME unique index now enforces exactly-one-grant-per-user (the tuple
 * ('system', 'managed_venice_starter:<userId>', 'admin_adjustment') is unique
 * per user), so the concurrent-deploy race guard is preserved for free.
 *
 * Best-effort by design: every failure path returns a structured result and
 * NEVER throws into the deploy hot path. A failed/blocked grant must not block
 * a deploy.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { getRiskAssessment } from "@/lib/abuse/repository";
import { ensureManagedVeniceWalletAccount } from "@/lib/billing/managed-venice-wallets";
import { appendManagedVeniceFinancialEvent } from "@/lib/billing/managed-venice-financial-events";

// Minimal Supabase client surface (mirrors the private SupabaseLike in
// managed-venice-wallets.ts). Defined locally so this module stays within the
// venice/* scope without exporting a new symbol from the billing layer.
type SupabaseLike = { from: (table: string) => unknown };

const LOG_SOURCE = "managed-venice-starter-credit";

/**
 * Reference PREFIX for the starter grant. The ledger reference_id and the
 * financial-event idempotency key are both `${PREFIX}:${userId}`.
 */
export const MANAGED_VENICE_STARTER_GRANT_REFERENCE = "managed_venice_starter";

/**
 * Reference prefix used by the one-off ops backfill on 2026-06-25, which
 * granted six users their starter credit directly in SQL to work around the
 * global-cap bug. Those rows are real grants and MUST be treated as
 * "already granted" so this fix does not hand those users a second $0.50.
 */
const MANAGED_VENICE_STARTER_BACKFILL_REFERENCE = "managed_venice_starter_backfill";

const STARTER_LEDGER_SOURCE = "system";
const STARTER_LEDGER_REASON = "admin_adjustment";
const STARTER_LEDGER_ACTOR = "managed_venice_starter_grant";

/**
 * The canonical per-user starter-grant reference. Used verbatim as BOTH the
 * card-ledger reference_id and the financial-event idempotency key.
 *
 * This string is IDEMPOTENCY-CRITICAL and must stay byte-stable: every
 * starter_grant financial event ever written (including the seven pre-fix rows)
 * carries exactly `managed_venice_starter:<userId>` as its idempotency key, and
 * managed_venice_financial_events.idempotency_key is uniquely indexed. Changing
 * the shape would make already-granted users look ungranted to the event layer.
 */
export function managedVeniceStarterGrantReference(userId: string): string {
  return `${MANAGED_VENICE_STARTER_GRANT_REFERENCE}:${userId}`;
}

/**
 * Every ledger reference under which THIS user may already hold a starter
 * grant. The query is scoped by user_id, so the bare legacy constant can only
 * ever match the single pre-fix user who actually consumed it.
 *
 *   1. `managed_venice_starter:<userId>`          — current, per-user.
 *   2. `managed_venice_starter`                   — legacy constant (one user).
 *   3. `managed_venice_starter_backfill:<userId>` — ops backfill (six users).
 */
function starterGrantLedgerReferences(userId: string): string[] {
  return [
    managedVeniceStarterGrantReference(userId),
    MANAGED_VENICE_STARTER_GRANT_REFERENCE,
    `${MANAGED_VENICE_STARTER_BACKFILL_REFERENCE}:${userId}`,
  ];
}

function readBoolEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readMicroUsdEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

/** Risky behaviour: default OFF. Flip via Vercel env (no code change). */
export function isManagedVeniceStarterCreditEnabled(): boolean {
  return readBoolEnv("HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED");
}

/** Default $0.50 = 500_000 microUSD; override via env without a deploy. */
export function getManagedVeniceStarterCreditMicroUsd(): number {
  return readMicroUsdEnv("HERMES_MANAGED_VENICE_STARTER_CREDIT_MICRO_USD", 500_000);
}

export type StarterCreditResult =
  | { granted: true; amountMicroUsd: number }
  | {
      granted: false;
      reason:
        | "flag_disabled"
        | "abuse_blocked"
        | "already_granted"
        | "db_unavailable"
        | "error";
    };

type StarterCreditDb = SupabaseLike;

type LedgerError = { message?: string; code?: string } | null;

interface CardLedgerInsertChain {
  then: Promise<{ error: LedgerError }>["then"];
}

interface CardLedgerSelectChain {
  eq: (column: string, value: unknown) => CardLedgerSelectChain;
  in: (column: string, values: readonly unknown[]) => CardLedgerSelectChain;
  limit: (count: number) => CardLedgerSelectChain;
  maybeSingle: () => Promise<{ data: unknown; error: LedgerError }>;
}

interface CardLedgerTable {
  insert: (row: Record<string, unknown>) => CardLedgerInsertChain;
  select: (columns: string) => CardLedgerSelectChain;
}

function ledgerTable(db: StarterCreditDb): CardLedgerTable {
  return db.from("managed_venice_card_ledger_entries") as CardLedgerTable;
}

/** Postgres unique-violation, however the driver surfaces it. */
function isUniqueViolation(error: LedgerError): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  return /duplicate key|unique|23505/i.test(error.message ?? "");
}

/**
 * Reuse the existing signup risk-assessment row as the abuse gate. We do NOT
 * compute a fresh assessment here (the provisioning gate already did that on
 * the deploy path) — we only refuse the FREEBIE when the row already says the
 * account is untrusted. A 'block' decision, or a 'require_card' decision with
 * no card on file, refuses the grant. No row at all → don't refuse (the deploy
 * itself already passed the gate, fail-open mirrors that posture).
 */
async function isAbuseBlockedForStarterCredit(userId: string): Promise<boolean> {
  const assessment = await getRiskAssessment(userId);
  if (!assessment) return false;
  if (assessment.card_satisfied_at) return false;
  if (assessment.decision === "block") return true;
  if (assessment.decision === "require_card") return true;
  return false;
}

/**
 * Grant the one-time starter credit. Returns a structured result and never
 * throws — call sites treat any non-granted result as a no-op.
 */
export async function grantManagedVeniceStarterCredit(
  params: { userId: string },
  db: StarterCreditDb | null | undefined = supabaseAdmin as StarterCreditDb | null
): Promise<StarterCreditResult> {
  if (!isManagedVeniceStarterCreditEnabled()) {
    return { granted: false, reason: "flag_disabled" };
  }

  const userId = params.userId?.trim();
  if (!userId) {
    return { granted: false, reason: "error" };
  }

  if (!db) {
    log.warn("starter credit skipped — db unavailable", {
      source: LOG_SOURCE,
      failureType: "managed_venice_starter_credit_db_unavailable",
      userId,
    });
    return { granted: false, reason: "db_unavailable" };
  }

  const amountMicroUsd = getManagedVeniceStarterCreditMicroUsd();
  const grantReference = managedVeniceStarterGrantReference(userId);

  try {
    if (await isAbuseBlockedForStarterCredit(userId)) {
      log.info("starter credit refused by abuse gate", {
        source: LOG_SOURCE,
        failureType: "managed_venice_starter_credit_abuse_blocked",
        userId,
      });
      return { granted: false, reason: "abuse_blocked" };
    }

    const account = await ensureManagedVeniceWalletAccount(userId, db);
    const table = ledgerTable(db);

    // Dedupe: one grant per user, across EVERY reference shape this user could
    // already hold one under (current per-user, legacy constant, ops backfill).
    // Always scoped by user_id, so the bare legacy constant cannot mask a grant
    // for anyone but the single user who actually holds that row.
    const { data: existing, error: existingError } = await table
      .select("id")
      .eq("user_id", userId)
      .eq("source", STARTER_LEDGER_SOURCE)
      .eq("reason", STARTER_LEDGER_REASON)
      .in("reference_id", starterGrantLedgerReferences(userId))
      // limit(1) keeps maybeSingle() safe if a user somehow holds two shapes.
      .limit(1)
      .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message || "Failed to read starter-credit ledger");
    }
    if (existing) {
      return { granted: false, reason: "already_granted" };
    }

    const { error: insertError } = await table.insert({
      account_id: account.id,
      user_id: userId,
      amount_micro_usd: amountMicroUsd,
      source: STARTER_LEDGER_SOURCE,
      actor: STARTER_LEDGER_ACTOR,
      reason: STARTER_LEDGER_REASON,
      reference_id: grantReference,
      metadata: { grant: "managed_venice_starter" },
    });

    if (insertError) {
      // Unique (source, reference_id, reason) lost a race. reference_id now
      // embeds the userId, so this can only be a concurrent grant for THIS user.
      if (isUniqueViolation(insertError)) {
        return { granted: false, reason: "already_granted" };
      }
      throw new Error(insertError.message || "Failed to insert starter-credit ledger entry");
    }

    await appendManagedVeniceFinancialEvent(
      {
        userId,
        accountId: account.id,
        walletType: "card",
        eventType: "starter_grant",
        referenceId: grantReference,
        // Byte-stable with every pre-fix event row — see the helper's docblock.
        idempotencyKey: grantReference,
        amountMicroUsd,
        metadata: { grant: "managed_venice_starter" },
      },
      db
    );

    log.info("managed Venice starter credit granted", {
      source: LOG_SOURCE,
      failureType: "managed_venice_starter_credit_granted",
      userId,
      amountMicroUsd,
    });

    return { granted: true, amountMicroUsd };
  } catch (err) {
    log.error("managed Venice starter credit grant failed", err, {
      source: LOG_SOURCE,
      failureType: "managed_venice_starter_credit_failed",
      userId,
    });
    return { granted: false, reason: "error" };
  }
}
