/**
 * Regression: a managed-Venice Responses request (Codex) must never be able to
 * spend more than its wallet hold (security review 2026-09, Medium
 * "Managed-Venice overage"). Codex does not send `max_output_tokens`, so the
 * old 4,096-token hold covered 1/31 of what Venice could generate.
 *
 * Real authorize/reserve/capture against an in-memory wallet; the Venice fake
 * generates as many tokens as the forwarded request allows.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceSpendWorld,
  type ManagedVeniceSpendWorld,
} from "@/test-utils/managed-venice-spend-world";
import {
  createWorstCaseVenice,
  expectEveryCallCoveredByItsHold,
} from "@/test-utils/fake-venice-inference";
import { VENICE_CHAT_MODEL_PRICES } from "@/lib/venice/pricing";

let mockMemory: ManagedVeniceSpendWorld;
const mockVerifyKey = jest.fn();
// "live": rows as the live /v1/models refresh builds them (output limit
// confirmed by Venice). "fallback": the static catalog alone.
let mockPricingSource: "live" | "fallback" = "live";

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));
jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: (...args: unknown[]) => mockVerifyKey(...args),
}));
jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: jest.fn(async () =>
    mockPricingSource === "live"
      ? {
          map: new Map(
            VENICE_CHAT_MODEL_PRICES.map((entry) => [
              entry.model,
              { ...entry, maxOutputTokensSource: "venice_live" },
            ])
          ),
          source: "merged",
          fetchedAt: Date.now(),
          liveModelCount: VENICE_CHAT_MODEL_PRICES.length,
        }
      : {
          map: new Map(VENICE_CHAT_MODEL_PRICES.map((entry) => [entry.model, entry])),
          source: "fallback",
          fetchedAt: Date.now(),
          liveModelCount: 0,
        }
  ),
}));
jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { POST } from "../route";

const USER_ID = "user_responses_overage_fixture";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const USD = 1_000_000;

// A Codex-shaped turn: stateless input, instructions, a client tool, no cap.
const codexTurn = (extra: Record<string, unknown> = {}) => ({
  model: "claude-opus-4-8",
  instructions: "You are Codex.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Keep going." }] }],
  tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
  store: false,
  ...extra,
});

function responsesReq(text: string) {
  return new Request("https://hivra.test/api/managed-venice/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture", "Content-Type": "application/json" },
    body: text,
  }) as unknown as NextRequest;
}

describe("managed-Venice Responses: the hold covers everything the request can spend", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let venice: ReturnType<typeof createWorstCaseVenice>;

  beforeEach(() => {
    mockPricingSource = "live";
    mockMemory = createManagedVeniceSpendWorld();
    mockVerifyKey.mockResolvedValue({
      id: KEY_ID,
      userId: USER_ID,
      status: "active",
      defaultWalletType: "card",
    });
    process.env.VENICE_API_KEY = "server-key-fixture";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    venice = createWorstCaseVenice();
    global.fetch = venice.fetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  it("no max_output_tokens, $1 wallet: Venice is told to stop where the wallet runs out", async () => {
    mockMemory.fundCard(USER_ID, 1 * USD);

    const res = await POST(responsesReq(JSON.stringify(codexTurn())));
    await res.text();

    expect(res.status).toBe(200);
    const forwarded = venice.calls[0].body;
    expect(typeof forwarded.max_output_tokens).toBe("number");
    expect(forwarded.max_output_tokens as number).toBeLessThan(128_000);
    expect(forwarded.max_output_tokens as number).toBeGreaterThanOrEqual(4_096);
    // Only the cap changed.
    expect({ ...forwarded, max_output_tokens: undefined }).toEqual({
      ...codexTurn(),
      max_output_tokens: undefined,
    });
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("no max_output_tokens, well-funded wallet: holds the model maximum and forwards the bytes as sent", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);
    // Odd spacing on purpose: the body must reach Venice byte for byte.
    const text = JSON.stringify(codexTurn(), null, 1);

    const res = await POST(responsesReq(text));
    await res.text();

    expect(res.status).toBe(200);
    expect(venice.calls[0].rawBody).toBe(text);
    expect(venice.calls[0].completionTokens).toBe(128_000);
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("a max_output_tokens the wallet cannot cover is lowered to what it can", async () => {
    mockMemory.fundCard(USER_ID, 1 * USD);

    const res = await POST(responsesReq(JSON.stringify(codexTurn({ max_output_tokens: 100_000 }))));
    await res.text();

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_output_tokens as number).toBeLessThan(100_000);
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("a wallet that cannot cover even a short answer gets 402 and Venice is never called", async () => {
    mockMemory.fundCard(USER_ID, 100_000);

    const res = await POST(responsesReq(JSON.stringify(codexTurn())));

    expect(res.status).toBe(402);
    expect(venice.calls).toHaveLength(0);
    expect(mockMemory.reservations()).toHaveLength(0);
  });

  // Review of #166: while live pricing is down the catalog maximum is only a
  // guess (it listed zai-org-glm-5-1 at 24,000 against Venice's 80,000), so
  // the cap the hold covers is always written, even when it equals that guess.
  it("while live pricing is down, no max_output_tokens: the held cap is written into the request", async () => {
    mockPricingSource = "fallback";
    venice = createWorstCaseVenice({ veniceMaxOutputTokens: { "claude-opus-4-8": 256_000 } });
    global.fetch = venice.fetch as unknown as typeof fetch;
    mockMemory.fundCard(USER_ID, 20 * USD);

    const res = await POST(responsesReq(JSON.stringify(codexTurn())));
    await res.text();

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_output_tokens).toBe(128_000);
    expect({ ...venice.calls[0].body, max_output_tokens: undefined }).toEqual({
      ...codexTurn(),
      max_output_tokens: undefined,
    });
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });
});
