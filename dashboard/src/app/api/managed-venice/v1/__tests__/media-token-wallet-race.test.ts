/**
 * Regression: concurrent media requests on a token ($HermesOS lot) wallet must
 * each be paid for.
 *
 * Capturing a hold debits the user's token lots. The debit read the active
 * lots, then wrote each lot's new remaining value as an absolute number,
 * filtered only by the lot id. Ten images/generate calls captured at the same
 * time all read the same $1.00 lot and all wrote $0.95: Venice ran ten images
 * on Hivra's key, the wallet paid for one, every hold closed as captured (so
 * the balance was free again) and the burst could be repeated.
 *
 * These tests run the real routes, spend gate and wallet code against the
 * in-memory DB. Its update(...).select() returns only the rows the filters
 * still matched when the write ran, like PostgREST, and its reads and writes
 * resolve asynchronously, so requests sent together interleave the way
 * concurrent requests do.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceSpendWorld,
  type ManagedVeniceSpendWorld,
} from "@/test-utils/managed-venice-spend-world";

let mockMemory: ManagedVeniceSpendWorld;
const mockVerifyKey = jest.fn();

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));
jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: (...args: unknown[]) => mockVerifyKey(...args),
}));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

import { POST as imagesGenerate } from "../images/generate/route";
import { POST as passthrough } from "../[...path]/route";

const USER_ID = "user_token_race_fixture";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const BASE = "https://hivra.test/api/managed-venice/v1";
const QWEN_IMAGE_MICRO_USD = 50_000; // qwen-image-2, $0.05 per image

function jsonReq(path: string, body: unknown) {
  return new Request(`${BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// The Hermes agent's image plugin posts its default model to image/generate,
// which lands on the catch-all.
function agentImage() {
  return passthrough(
    jsonReq("image/generate", {
      model: "qwen-image-2",
      prompt: "a lighthouse at dusk",
      safe_mode: true,
      format: "webp",
      return_binary: false,
      aspect_ratio: "1:1",
    }),
    { params: Promise.resolve({ path: ["image", "generate"] }) }
  );
}

function dashboardImage() {
  return imagesGenerate(jsonReq("images/generate", { model: "qwen-image-2", prompt: "a lighthouse at dusk" }));
}

function lots() {
  return mockMemory.tables.managed_venice_token_lots;
}

function lotValues() {
  return lots().map((lot) => Number(lot.remaining_value_micro_usd));
}

describe("managed-Venice media on a token wallet: concurrent requests are each charged", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockMemory = createManagedVeniceSpendWorld();
    mockVerifyKey.mockResolvedValue({ id: KEY_ID, userId: USER_ID, status: "active", defaultWalletType: "hermesos" });
    process.env.VENICE_API_KEY = "server-key-fixture";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED;
    delete process.env.MANAGED_VENICE_MULTIMODAL_MARKUP;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ id: "req_fixture", images: ["b64"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  function expectEveryRequestCharged(count: number) {
    expect(fetchMock).toHaveBeenCalledTimes(count);
    const reservations = mockMemory.reservations();
    expect(reservations).toHaveLength(count);
    for (const reservation of reservations) {
      expect(reservation).toMatchObject({ status: "captured", captured_micro_usd: QWEN_IMAGE_MICRO_USD });
    }
    expect(mockMemory.usageEvents()).toHaveLength(count);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  }

  it.each([
    ["the agent's image/generate (catch-all)", agentImage],
    ["images/generate", dashboardImage],
  ])("ten concurrent %s calls on a $1.00 lot debit $0.50, not $0.05", async (_label, send) => {
    mockMemory.fundHermesos(USER_ID, 1_000_000);

    const responses = await Promise.all(Array.from({ length: 10 }, () => send()));

    expect(responses.map((res) => res.status)).toEqual(Array(10).fill(200));
    expectEveryRequestCharged(10);
    expect(lotValues()).toEqual([500_000]);
    // The token amount shrinks with the value (the spend world seeds 1 raw unit per micro-USD).
    expect(lots()[0]).toMatchObject({ remaining_token_amount_raw: "500000", status: "active" });
  });

  it("a second burst spends the rest of the lot instead of starting from a full balance again", async () => {
    mockMemory.fundHermesos(USER_ID, 1_000_000);

    await Promise.all(Array.from({ length: 10 }, () => agentImage()));
    await Promise.all(Array.from({ length: 10 }, () => agentImage()));

    expectEveryRequestCharged(20);
    expect(lots()[0]).toMatchObject({ remaining_value_micro_usd: 0, remaining_token_amount_raw: "0", status: "depleted" });

    // The wallet is empty now, so the next image is refused before Venice.
    const refused = await agentImage();
    expect(refused.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("concurrent captures that span two lots debit them oldest first, to the cent", async () => {
    mockMemory.fundHermesos(USER_ID, 200_000);
    mockMemory.fundHermesos(USER_ID, 400_000);

    const responses = await Promise.all(Array.from({ length: 10 }, () => agentImage()));

    expect(responses.map((res) => res.status)).toEqual(Array(10).fill(200));
    expectEveryRequestCharged(10);
    expect(lotValues()).toEqual([0, 100_000]);
    expect(lots().map((lot) => lot.status)).toEqual(["depleted", "active"]);
  });
});
