/**
 * @jest-environment node
 */

const mockLoadReservation = jest.fn();
const mockReleaseReservation = jest.fn();

jest.mock("@/lib/billing/managed-venice-wallets", () => ({
  loadManagedVeniceReservation: (...args: unknown[]) => mockLoadReservation(...args),
  releaseManagedVeniceReservation: (...args: unknown[]) => mockReleaseReservation(...args),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import {
  SWEEPABLE_RECONCILIATION_REASONS,
  sweepStaleManagedVeniceReservations,
  pruneTerminalManagedVeniceReservations,
} from "../reservation-sweep";

type Item = {
  id: string;
  user_id: string;
  reason: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  // populated by closeItem updates
  resolved_at?: string;
  operator_notes?: string;
};

function createFakeDb(items: Item[]) {
  function selectChain() {
    const predicates: Array<(row: Item) => boolean> = [];
    const chain = {
      select: (_cols?: string) => chain,
      eq: (col: string, val: string) => {
        predicates.push((row) => (row as Record<string, unknown>)[col] === val);
        return chain;
      },
      in: (col: string, vals: readonly string[]) => {
        predicates.push((row) => vals.includes((row as Record<string, unknown>)[col] as string));
        return chain;
      },
      lt: (col: string, val: string) => {
        predicates.push((row) => String((row as Record<string, unknown>)[col]) < val);
        return chain;
      },
      order: () => chain,
      limit: async (n: number) => ({
        data: items.filter((row) => predicates.every((p) => p(row))).slice(0, n),
        error: null,
      }),
    };
    return chain;
  }

  function updateChain(patch: Record<string, unknown>) {
    return {
      eq: async (col: string, val: string) => {
        for (const row of items) {
          if ((row as Record<string, unknown>)[col] === val) {
            Object.assign(row, patch);
          }
        }
        return { error: null };
      },
    };
  }

  return {
    from: () => ({
      select: (cols?: string) => selectChain().select(cols),
      update: (patch: Record<string, unknown>) => updateChain(patch),
    }),
  };
}

function openItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_1",
    user_id: "user_1",
    reason: "managed_venice_missing_stream_usage",
    status: "open",
    metadata: { referenceId: "ref_1" },
    created_at: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockLoadReservation.mockReset();
  mockReleaseReservation.mockReset();
});

describe("sweepStaleManagedVeniceReservations", () => {
  it("releases an active held reservation and closes the item as ignored", async () => {
    const items = [openItem()];
    mockLoadReservation.mockResolvedValue({ status: "active", reserved_micro_usd: 250 });
    mockReleaseReservation.mockResolvedValue({ released: true, releasedMicroUsd: 250 });

    const summary = await sweepStaleManagedVeniceReservations({}, createFakeDb(items));

    expect(mockReleaseReservation).toHaveBeenCalledWith(
      { userId: "user_1", referenceId: "ref_1" },
      expect.anything()
    );
    expect(summary.releasedReservations).toBe(1);
    expect(summary.totalReleasedMicroUsd).toBe(250);
    expect(summary.results[0].disposition).toBe("released_stale_reservation");

    expect(items[0].status).toBe("ignored");
    expect(items[0].resolved_at).toBeDefined();
    expect((items[0].metadata as Record<string, unknown>).sweep).toMatchObject({
      disposition: "released_stale_reservation",
      releasedMicroUsd: 250,
      referenceId: "ref_1",
    });
    // Original metadata is preserved.
    expect((items[0].metadata as Record<string, unknown>).referenceId).toBe("ref_1");
  });

  it("does not release a reservation that was already captured", async () => {
    const items = [openItem()];
    mockLoadReservation.mockResolvedValue({ status: "captured", reserved_micro_usd: 250 });

    const summary = await sweepStaleManagedVeniceReservations({}, createFakeDb(items));

    expect(mockReleaseReservation).not.toHaveBeenCalled();
    expect(summary.releasedReservations).toBe(0);
    expect(summary.results[0].disposition).toBe("reservation_already_captured");
    expect(items[0].status).toBe("ignored");
  });

  it("closes an item whose reservation no longer exists", async () => {
    const items = [openItem()];
    mockLoadReservation.mockResolvedValue(null);

    const summary = await sweepStaleManagedVeniceReservations({}, createFakeDb(items));

    expect(mockReleaseReservation).not.toHaveBeenCalled();
    expect(summary.results[0].disposition).toBe("reservation_not_found");
    expect(items[0].status).toBe("ignored");
  });

  it("closes an item with no referenceId without touching reservations", async () => {
    const items = [openItem({ metadata: { model: "deepseek-v4-flash" } })];

    const summary = await sweepStaleManagedVeniceReservations({}, createFakeDb(items));

    expect(mockLoadReservation).not.toHaveBeenCalled();
    expect(summary.results[0].disposition).toBe("missing_reference_id");
    expect(items[0].status).toBe("ignored");
  });

  it("treats a lost release race as already released", async () => {
    const items = [openItem()];
    mockLoadReservation.mockResolvedValue({ status: "active", reserved_micro_usd: 250 });
    mockReleaseReservation.mockResolvedValue({ released: false });

    const summary = await sweepStaleManagedVeniceReservations({}, createFakeDb(items));

    expect(summary.releasedReservations).toBe(0);
    expect(summary.results[0].disposition).toBe("reservation_already_released");
    expect(items[0].status).toBe("ignored");
  });

  it("ignores items that are not stale, not open, or have an out-of-scope reason", async () => {
    const items = [
      openItem({ id: "fresh", created_at: new Date().toISOString() }),
      openItem({ id: "closed", status: "ignored" }),
      openItem({ id: "overage", reason: "managed_venice_overage_uncovered" }),
    ];
    mockLoadReservation.mockResolvedValue({ status: "active", reserved_micro_usd: 250 });
    mockReleaseReservation.mockResolvedValue({ released: true, releasedMicroUsd: 250 });

    const summary = await sweepStaleManagedVeniceReservations({}, createFakeDb(items));

    expect(summary.scanned).toBe(0);
    expect(mockLoadReservation).not.toHaveBeenCalled();
  });

  it("scopes the sweep to the missing-usage / settlement-failure reasons", () => {
    expect([...SWEEPABLE_RECONCILIATION_REASONS]).toEqual([
      "managed_venice_missing_stream_usage",
      "managed_venice_stream_settlement_failed",
      "managed_venice_missing_usage",
    ]);
    expect(SWEEPABLE_RECONCILIATION_REASONS).not.toContain("managed_venice_overage_uncovered");
  });
});

function createPruneDb(
  rows: Array<{ id: string; status: string; updated_at: string }>
) {
  const deleted: string[] = [];
  const db = {
    from: () => ({
      select: () => {
        const preds: Array<(r: { [k: string]: unknown }) => boolean> = [];
        const chain = {
          in: (col: string, vals: readonly string[]) => {
            preds.push((r) => vals.includes(r[col] as string));
            return chain;
          },
          lt: (col: string, val: string) => {
            preds.push((r) => String(r[col]) < val);
            return chain;
          },
          limit: async (n: number) => ({
            data: rows.filter((r) => preds.every((p) => p(r))).slice(0, n),
            error: null,
          }),
        };
        return chain;
      },
      delete: () => ({
        in: async (_col: string, ids: string[]) => {
          deleted.push(...ids);
          return { error: null };
        },
      }),
    }),
  };
  return { db, deleted };
}

describe("pruneTerminalManagedVeniceReservations", () => {
  it("deletes only terminal rows older than the retention window, never active holds", async () => {
    const old = "2026-01-01T00:00:00.000Z";
    const recent = new Date().toISOString();
    const rows = [
      { id: "r1", status: "released", updated_at: old },
      { id: "r2", status: "captured", updated_at: old },
      { id: "r3", status: "active", updated_at: old }, // active is never pruned
      { id: "r4", status: "released", updated_at: recent }, // inside retention window
    ];
    const { db, deleted } = createPruneDb(rows);

    const summary = await pruneTerminalManagedVeniceReservations(
      { retentionDays: 30, limit: 100 },
      db as unknown as Parameters<typeof pruneTerminalManagedVeniceReservations>[1]
    );

    expect(summary.pruned).toBe(2);
    expect(deleted.sort()).toEqual(["r1", "r2"]);
  });

  it("returns pruned:0 and issues no delete when nothing is old enough", async () => {
    const { db, deleted } = createPruneDb([
      { id: "r1", status: "released", updated_at: new Date().toISOString() },
    ]);
    const summary = await pruneTerminalManagedVeniceReservations(
      {},
      db as unknown as Parameters<typeof pruneTerminalManagedVeniceReservations>[1]
    );
    expect(summary.pruned).toBe(0);
    expect(deleted).toEqual([]);
  });
});
