import {
  isManagedVeniceAutoRecoverEnabled,
  tryReactivateManagedVeniceKeysAfterTopUp,
  OVERAGE_PAUSE_REASON,
} from "@/lib/billing/managed-venice-auto-recover";

jest.mock("@/lib/billing/managed-venice-wallets", () => ({
  getManagedVeniceWalletSummary: jest.fn(),
}));
import { getManagedVeniceWalletSummary } from "@/lib/billing/managed-venice-wallets";
const mockSummary = getManagedVeniceWalletSummary as jest.Mock;

const summary = (hermesos: number, card: number) => ({
  hermesos: { availableMicroUsd: hermesos, reservedMicroUsd: 0, totalValueMicroUsd: hermesos, remainingTokenAmountRaw: "0" },
  card: { availableMicroUsd: card, reservedMicroUsd: 0, totalValueMicroUsd: card },
});

// Mock proxy-keys update chain; the reason-scoping regression below evaluates
// the actual filters rather than returning a preselected result.
function mockKeysDb(reactivatedIds: string[], onUpdate?: (patch: unknown) => void) {
  return {
    from: () => ({
      update: (patch: unknown) => { onUpdate?.(patch);
        const chain = { eq: () => chain, select: () => Promise.resolve({ data: reactivatedIds.map((id) => ({ id })), error: null }) };
        return chain;
      },
    }),
  };
}

beforeEach(() => mockSummary.mockReset());

describe("isManagedVeniceAutoRecoverEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    expect(isManagedVeniceAutoRecoverEnabled({})).toBe(false);
    expect(isManagedVeniceAutoRecoverEnabled({ MANAGED_VENICE_AUTO_RECOVER_ENABLED: "1" })).toBe(false);
    expect(isManagedVeniceAutoRecoverEnabled({ MANAGED_VENICE_AUTO_RECOVER_ENABLED: "true" })).toBe(true);
  });
});

describe("tryReactivateManagedVeniceKeysAfterTopUp", () => {
  const on = { MANAGED_VENICE_AUTO_RECOVER_ENABLED: "true" };

  it("no-ops (and never touches the wallet) when disabled", async () => {
    const db = { from: () => { throw new Error("should not query when disabled"); } };
    expect(await tryReactivateManagedVeniceKeysAfterTopUp("u", db, {})).toEqual({ reactivated: 0, reason: "disabled" });
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it("does not reactivate when there's still no spendable balance", async () => {
    mockSummary.mockResolvedValue(summary(0, 0));
    const db = mockKeysDb(["should-not-run"]);
    expect(await tryReactivateManagedVeniceKeysAfterTopUp("u", db, on)).toEqual({ reactivated: 0, reason: "no_balance" });
  });

  it("reactivates paused keys once the wallet is funded", async () => {
    mockSummary.mockResolvedValue(summary(0, 5_000_000));
    let patch: unknown;
    const db = mockKeysDb(["k1", "k2"], (p) => { patch = p; });
    expect(await tryReactivateManagedVeniceKeysAfterTopUp("u", db, on)).toEqual({ reactivated: 2, reason: "reactivated" });
    // Restores service only — flips status, clears the pause reason. No money moved.
    expect(patch).toMatchObject({ status: "active", paused_reason: null });
  });

  it("reports no_paused_keys when funded but nothing was paused", async () => {
    mockSummary.mockResolvedValue(summary(1_000, 0));
    const db = mockKeysDb([]);
    expect(await tryReactivateManagedVeniceKeysAfterTopUp("u", db, on)).toEqual({ reactivated: 0, reason: "no_paused_keys" });
  });

  it("exports the overage pause reason it recovers", () => {
    expect(OVERAGE_PAUSE_REASON).toBe("managed_venice_overage_uncovered");
  });

  it("leaves pending model changes, manual pauses and other owners untouched", async () => {
    mockSummary.mockResolvedValue(summary(0, 5_000_000));
    const rows = [
      { id: "overage", user_id: "u", status: "paused", paused_reason: OVERAGE_PAUSE_REASON },
      { id: "pending", user_id: "u", status: "paused", paused_reason: "Awaiting agent application" },
      { id: "manual", user_id: "u", status: "paused", paused_reason: "manual_review" },
      { id: "foreign", user_id: "other", status: "paused", paused_reason: OVERAGE_PAUSE_REASON },
    ];
    const filters: [string, unknown][] = [];
    const db = { from: () => ({ update: (patch: Record<string, unknown>) => {
      const chain = {
        eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
        select: async () => {
          const matched = rows.filter(row => filters.every(([key, value]) => row[key as keyof typeof row] === value));
          for (const row of matched) Object.assign(row, patch);
          return { data: matched.map(row => ({ id: row.id })), error: null };
        },
      };
      return chain;
    } }) };
    expect(await tryReactivateManagedVeniceKeysAfterTopUp("u", db, on)).toEqual({ reactivated: 1, reason: "reactivated" });
    expect(rows.map(row => row.status)).toEqual(["active", "paused", "paused", "paused"]);
    expect(filters).toContainEqual(["paused_reason", OVERAGE_PAUSE_REASON]);
  });
});
