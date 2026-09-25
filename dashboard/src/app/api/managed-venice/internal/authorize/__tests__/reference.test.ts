/**
 * The Cloudflare Worker chooses each hold's reference before it authorizes,
 * so it can release the hold even when the authorize response is lost
 * (security review 2026-09, #167). Runs the real authorize and reservation
 * code against the in-memory ledger.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceMemoryDb,
  type ManagedVeniceMemoryDb,
} from "@/test-utils/managed-venice-memory-db";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-internal-secret";
const REFERENCE = "8a2b3c4d-1111-4222-8333-944455556666";

let mockMemory: ManagedVeniceMemoryDb;

jest.mock("@/lib/supabase", () => ({
  supabase: null,
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));

jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: jest.fn(async () => ({
    id: "22222222-2222-4222-8222-222222222222",
    userId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    defaultWalletType: "card",
  })),
}));

jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: jest.fn(async () => ({ map: new Map(), source: "fallback", liveModelCount: 0 })),
}));

import { POST } from "../route";

const chatBody = { model: "venice-uncensored-1-2", messages: [{ role: "user", content: "hello" }], max_completion_tokens: 100 };

function authorize(payload: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/managed-venice/internal/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-managed-venice-internal-secret": SECRET },
      body: JSON.stringify(payload),
    }) as unknown as NextRequest
  );
}

describe("/api/managed-venice/internal/authorize: the Worker's reference", () => {
  beforeEach(() => {
    process.env.MANAGED_VENICE_INTERNAL_SECRET = SECRET;
    process.env.VENICE_API_KEY = "venice_fixture_upstream_key";
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_reservations: [],
      managed_venice_card_ledger_entries: [
        { user_id: USER_ID, amount_micro_usd: 1_000_000, source: "stripe", reason: "stripe_topup", reference_id: "t1" },
      ],
      managed_venice_usage_events: [],
      managed_venice_proxy_keys: [{ id: KEY_ID, user_id: USER_ID, status: "active" }],
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.MANAGED_VENICE_INTERNAL_SECRET;
    delete process.env.VENICE_API_KEY;
    jest.restoreAllMocks();
  });

  it("holds the request under the reference the Worker chose", async () => {
    const res = await authorize({ plaintextKey: "hven_live_fixture", body: chatBody, referenceId: REFERENCE });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, referenceId: REFERENCE });
    expect(mockMemory.tables.managed_venice_reservations).toEqual([
      expect.objectContaining({ reference_id: REFERENCE, status: "active" }),
    ]);
  });

  it("refuses a reference that already has a hold, so no request runs without one", async () => {
    await authorize({ plaintextKey: "hven_live_fixture", body: chatBody, referenceId: REFERENCE });
    mockMemory.tables.managed_venice_reservations[0].status = "captured";

    const again = await authorize({ plaintextKey: "hven_live_fixture", body: chatBody, referenceId: REFERENCE });

    expect(again.status).toBe(409);
    expect(mockMemory.tables.managed_venice_reservations).toHaveLength(1);
  });

  it("refuses a reference that is not a UUID", async () => {
    const res = await authorize({ plaintextKey: "hven_live_fixture", body: chatBody, referenceId: "ref_1" });
    expect(res.status).toBe(400);
    expect(mockMemory.tables.managed_venice_reservations).toHaveLength(0);
  });

  it("still generates a reference for an older Worker that sends none", async () => {
    const res = await authorize({ plaintextKey: "hven_live_fixture", body: chatBody });
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.referenceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
