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
