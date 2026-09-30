import { holdManagedVeniceMediaSpend, sendManagedVeniceMediaRequest } from "@/lib/venice/media-spend-gate";
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
const NANO = { endpoint: "/api/v1/image/generate", model: "nano-banana-2", metadata: {} };

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
    world.failNext({ table: "managed_venice_reservations", op: "insert" });
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

  // Second review: an unrecognised tier was held at the top tier but charged
  // at the cheapest. Routes normalise tiers first; the gate is the backstop.
  it.each([
    ["/api/v1/image/upscale", "venice-upscaler", { scale: "1" }, "scale"],
    ["/api/v1/image/generate", "nano-banana-2", { resolution: "8K" }, "resolution"],
    ["/api/v1/image/edit", "nano-banana-2-edit", { resolution: 4 }, "resolution"],
  ])("refuses %s %s with an unpublished tier (400) before any hold", async (endpoint, model, metadata, param) => {
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend(
      { key: KEY, operation: { endpoint, model, metadata }, source: "test" },
      world.db
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: { code: string; param: string } };
    expect(body.error).toMatchObject({ code: "managed_venice_invalid_tier", param });
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

  // Review finding: with the flag off, settle() released the hold and wrote a
  // charged=0 row, so a funded wallet was never charged for media.
  it.each([["unset", undefined], ["false", "false"], ["true", "true"]])(
    "captures the catalog price on a 2xx whatever the billing flag says (%s)",
    async (_label, flag) => {
      if (flag !== undefined) process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = flag;
      world.fundCard(USER_ID, 1_000_000);
      const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: QWEN, source: "test" }, world.db);
      if (!result.ok) throw new Error("expected a hold");

      await result.hold.complete({ ok: true, upstreamStatus: 200, upstreamRequestId: "req_1" });

      expect(world.reservations()[0]).toMatchObject({ status: "captured", captured_micro_usd: 50_000 });
      expect(world.usageEvents()).toEqual([
        expect.objectContaining({ status: "recorded", charged_micro_usd: 50_000, upstream_request_id: "req_1" }),
      ]);
      expect(world.cardBalanceMicroUsd(USER_ID)).toBe(950_000);
    }
  );

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
  // #160 review: media holds had no expiry. A hold now says when it goes stale
  // and what a success costs, so the stale-hold sweep can settle it without
  // re-pricing (lib/venice/reservation-sweep.ts).
  it("gives the hold an expiry and records the price a success is charged", async () => {
    world.fundCard(USER_ID, 1_000_000);
    const before = Date.now();
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: NANO, source: "test" }, world.db);
    if (!result.ok) throw new Error("expected a hold");

    const row = world.reservations()[0];
    // Held at the 4K ceiling; a success is charged Venice's 1K default.
    expect(row).toMatchObject({
      reserved_micro_usd: 190_000,
      metadata: expect.objectContaining({ captureOnSuccessMicroUsd: 100_000, captureOnSuccessListMicroUsd: 100_000 }),
    });
    const expiresAt = Date.parse(String(row.expires_at));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  // #160 review: a 2xx whose body could not be read released the hold, though
  // Venice had already run (and billed) the request.
  it("captures the priced amount when Venice answered 2xx but its body could not be read", async () => {
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: NANO, source: "test" }, world.db);
    if (!result.ok) throw new Error("expected a hold");
    const broken = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    jest.spyOn(broken, "arrayBuffer").mockRejectedValue(new TypeError("terminated"));

    const sent = await sendManagedVeniceMediaRequest({
      hold: result.hold,
      mode: "buffer",
      fetchFailureType: "managed_venice_image_upstream_fetch_failed",
      send: async () => broken,
    });

    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.response.status).toBe(502);
    expect(world.reservations()[0]).toMatchObject({ status: "captured", captured_micro_usd: 100_000 });
    expect(world.cardBalanceMicroUsd(USER_ID)).toBe(900_000);
    expect(world.usageEvents()).toEqual([
      expect.objectContaining({
        status: "recorded",
        charged_micro_usd: 100_000,
        upstream_status: 200,
        metadata: expect.objectContaining({ upstreamBodyUnreadable: true }),
      }),
    ]);
  });

  it("still releases when a non-2xx body could not be read", async () => {
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: NANO, source: "test" }, world.db);
    if (!result.ok) throw new Error("expected a hold");
    const broken = new Response("{}", { status: 503 });
    jest.spyOn(broken, "arrayBuffer").mockRejectedValue(new TypeError("terminated"));

    const sent = await sendManagedVeniceMediaRequest({
      hold: result.hold,
      mode: "buffer",
      fetchFailureType: "managed_venice_image_upstream_fetch_failed",
      send: async () => broken,
    });

    expect(sent.ok).toBe(false);
    expect(world.reservations()[0].status).toBe("released");
    expect(world.cardBalanceMicroUsd(USER_ID)).toBe(1_000_000);
  });

  it("files a reconciliation item when the release itself fails, so the sweep can release it", async () => {
    world.fundCard(USER_ID, 1_000_000);
    const result = await holdManagedVeniceMediaSpend({ key: KEY, operation: NANO, source: "test" }, world.db);
    if (!result.ok) throw new Error("expected a hold");
    world.failNext({ table: "managed_venice_reservations", op: "update" });

    await result.hold.complete({ ok: false, upstreamStatus: 400 });

    expect(world.reservations()[0].status).toBe("active");
    expect(world.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: "managed_venice_media_release_failed",
        status: "open",
        metadata: expect.objectContaining({
          referenceId: result.hold.referenceId,
          releaseReason: "upstream_non_2xx",
          upstreamStatus: 400,
        }),
      }),
    ]);
  });
});
