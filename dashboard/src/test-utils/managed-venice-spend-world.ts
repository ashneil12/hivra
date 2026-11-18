/**
 * Managed-Venice wallet world for proxy spend tests.
 *
 * Wraps `createManagedVeniceMemoryDb` (real filtering/mutating tables, the
 * production unique indexes, append-only financial events) with the wallet
 * tables the proxy routes touch, so the REAL reservation / capture / release
 * code runs end to end. Tests mock `@/lib/supabase` to hand `db` to the code
 * under test.
 */

import { createManagedVeniceMemoryDb, type MemoryRow } from "./managed-venice-memory-db";

const SPEND_TABLES = [
  "managed_venice_card_ledger_entries",
  "managed_venice_reservations",
  "managed_venice_usage_events",
  "managed_venice_proxy_keys",
] as const;

export function createManagedVeniceSpendWorld() {
  const seed: Record<string, MemoryRow[]> = {};
  for (const name of SPEND_TABLES) seed[name] = [];
  const memory = createManagedVeniceMemoryDb(seed);
  // The per-agent daily limit guard, as migration 20261117233000 writes it.
  memory.addInsertGuard("managed_venice_reservations", (row, live) => {
    if (row.status !== "active") return null;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.agentDailyCapMicroUsd !== "number") return null;
    const keyOf = (r: MemoryRow) =>
      (r.proxy_key_id as string | null | undefined) ?? ((r.metadata as Record<string, unknown> | undefined)?.proxyKeyId as string | undefined) ?? null;
    const key = keyOf(row);
    if (!key) return null;
    const holds = live.managed_venice_reservations ?? [];
    if (holds.some((r) => r.reference_id === row.reference_id)) return null;
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const usage = live.managed_venice_usage_events ?? [];
    const sameKey = (r: MemoryRow) => r.user_id === row.user_id && keyOf(r) === key;
    const committed =
      usage.filter((u) => u.user_id === row.user_id && u.proxy_key_id === key && String(u.created_at) >= day)
        .reduce((sum, u) => sum + Number(u.charged_micro_usd ?? 0), 0) +
      holds.filter((r) => sameKey(r) && r.status === "active").reduce((sum, r) => sum + Number(r.reserved_micro_usd), 0) +
      holds.filter((r) => sameKey(r) && r.status === "captured" && String(r.captured_at) >= day &&
        !usage.some((u) => u.reference_id === r.reference_id))
        .reduce((sum, r) => sum + Number(r.captured_micro_usd ?? 0), 0);
    const requested = Number(row.reserved_micro_usd);
    if (committed + requested <= meta.agentDailyCapMicroUsd) return null;
    return {
      code: "P0001",
      message: `managed_venice_agent_spend_cap: cap=${meta.agentDailyCapMicroUsd} spent=${committed} requested=${requested}`,
    };
  });

  return {
    ...memory,
    /** Credit the card wallet as a Stripe top-up would. */
    fundCard(userId: string, amountMicroUsd: number) {
      memory.insertRow("managed_venice_card_ledger_entries", {
        user_id: userId,
        amount_micro_usd: amountMicroUsd,
        source: "stripe",
        reason: "stripe_topup",
        reference_id: `topup_${memory.tables.managed_venice_card_ledger_entries.length + 1}`,
      });
    },
    /** Add an active token lot worth `valueMicroUsd`. */
    fundHermesos(userId: string, valueMicroUsd: number) {
      memory.insertRow("managed_venice_token_lots", {
        user_id: userId,
        status: "active",
        remaining_value_micro_usd: valueMicroUsd,
        remaining_token_amount_raw: String(valueMicroUsd),
      });
    },
    cardBalanceMicroUsd(userId: string) {
      return memory.tables.managed_venice_card_ledger_entries
        .filter((row) => row.user_id === userId)
        .reduce((sum, row) => sum + Number(row.amount_micro_usd ?? 0), 0);
    },
    reservations() {
      return memory.tables.managed_venice_reservations;
    },
    usageEvents() {
      return memory.tables.managed_venice_usage_events;
    },
  };
}

export type ManagedVeniceSpendWorld = ReturnType<typeof createManagedVeniceSpendWorld>;
