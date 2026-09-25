import { holdManagedVeniceMediaSpend } from "@/lib/venice/media-spend-gate";
import {
  createManagedVeniceSpendWorld,
  type ManagedVeniceSpendWorld,
} from "@/test-utils/managed-venice-spend-world";

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

const USER_ID = "user_gate_fixture";
const KEY = { id: "11111111-1111-4111-8111-111111111111", userId: USER_ID, defaultWalletType: "card" as const };
const QWEN = { endpoint: "/api/v1/image/generate", model: "qwen-image-2", metadata: {} };

describe("holdManagedVeniceMediaSpend", () => {
  const envBefore = { ...process.env };
  let world: ManagedVeniceSpendWorld;

  beforeEach(() => {
    world = createManagedVeniceSpendWorld();
    delete process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED;
    delete process.env.MANAGED_VENICE_MULTIMODAL_MARKUP;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    delete process.env.MANAGED_VENICE_MONTHLY_SPEND_CAP_USD;
  });

  afterEach(() => {
    process.env = { ...envBefore };
  });

  it("holds the post-markup ceiling", async () => {
    process.env.MANAGED_VENICE_MULTIMODAL_MARKUP = "1.5";
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: QWEN, source: "test" }, world.db);
    expect(result.ok).toBe(true);
    expect(world.reservations()[0]).toMatchObject({ status: "active", reserved_micro_usd: 75_000, wallet_type: "card" });
  });

  it("returns a 402 when the monthly spend cap would be crossed, before any hold", async () => {
    process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED = "true";
    process.env.MANAGED_VENICE_MONTHLY_SPEND_CAP_USD = "0.01";
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: QWEN, source: "test" }, world.db);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(402);
    expect(((await result.response.json()) as { error: { code: string } }).error.code).toBe(
      "managed_venice_spend_cap_reached"
    );
    expect(world.reservations()).toHaveLength(0);
  });

  it("fails closed (503, nothing held) when the balance can't be checked", async () => {
    world.fundCard(USER_ID, 1_000_000);
    world.failNext({ table: "managed_venice_reservations", op: "upsert" });
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: QWEN, source: "test" }, world.db);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
  });

  it("refuses an absurd quantity without touching the wallet", async () => {
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend(
      { key: KEY, operation: { ...QWEN, metadata: { variants: 1e300 } }, source: "test" },
      world.db
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(402);
    expect(world.reservations()).toHaveLength(0);
  });

  it("keeps the hold and files a non-pausing reconciliation item when capture fails after Venice succeeded", async () => {
    process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: QWEN, source: "test" }, world.db);
    if (!result.ok) throw new Error("expected a hold");
    world.failNext({ table: "managed_venice_card_ledger_entries", op: "insert" });

    await result.hold.complete({ ok: true, upstreamStatus: 200, upstreamRequestId: "req_1" });

    expect(world.reservations()[0].status).toBe("active");
    expect(world.usageEvents()).toHaveLength(0);
    expect(world.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        user_id: USER_ID,
        proxy_key_id: KEY.id,
        reason: "managed_venice_media_capture_failed",
        status: "open",
      }),
    ]);
    expect(world.tables.managed_venice_proxy_keys).toHaveLength(0);
  });

  it("releases the hold on a non-2xx and never writes a usage row", async () => {
    process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: QWEN, source: "test" }, world.db);
    if (!result.ok) throw new Error("expected a hold");

    await result.hold.complete({ ok: false, upstreamStatus: 429 });

    expect(world.reservations()[0].status).toBe("released");
    expect(world.usageEvents()).toHaveLength(0);
    expect(world.cardBalanceMicroUsd(USER_ID)).toBe(1_000_000);
  });

  it("charges a hermesos wallet from its token lots when billing is on", async () => {
    process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";
    world.fundHermesos(USER_ID, 60_000);
    const result = await holdManagedVeniceMediaSpend(
      { key: { ...KEY, defaultWalletType: "hermesos" }, operation: QWEN, source: "test" },
      world.db
    );
    if (!result.ok) throw new Error("expected a hold");

    await result.hold.complete({ ok: true, upstreamStatus: 200 });

    expect(world.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(10_000);
    expect(world.usageEvents()[0]).toMatchObject({ status: "recorded", charged_micro_usd: 50_000, wallet_type: "hermesos" });
  });
});
