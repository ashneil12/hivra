/**
 * Regression: the Anthropic Messages shim (Claude Code on managed Venice) must
 * never forward an output cap its wallet hold does not cover (security review
 * 2026-09, Medium "Managed-Venice overage"). Claude Code sends a large
 * max_tokens; above the model maximum, or above what the wallet covers, it is
 * written down before the request reaches Venice.
 *
 * Real reserve/capture against an in-memory wallet; the Venice fake generates
 * as many tokens as the forwarded request allows.
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

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));
jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: (...args: unknown[]) => mockVerifyKey(...args),
}));
jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: jest.fn(async () => ({
    map: new Map(VENICE_CHAT_MODEL_PRICES.map((entry) => [entry.model, entry])),
    source: "fallback",
    fetchedAt: Date.now(),
    liveModelCount: 0,
  })),
}));
jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { POST } from "../route";

const USER_ID = "user_anthropic_overage_fixture";
const KEY_ID = "44444444-4444-4444-8444-444444444444";
const USD = 1_000_000;

const claudeCodeTurn = (extra: Record<string, unknown> = {}) => ({
  model: "claude-opus-4-8",
  max_tokens: 32_000,
  system: "You are Claude Code.",
  messages: [{ role: "user", content: "Keep going." }],
  ...extra,
});

function messagesReq(body: unknown) {
  return new Request("https://hivra.test/api/managed-venice/anthropic/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "hven_live_fixture", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("managed-Venice Anthropic shim: the hold covers everything the request can spend", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let venice: ReturnType<typeof createWorstCaseVenice>;

  beforeEach(() => {
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

  it("a max_tokens above the model maximum is forwarded as the model maximum", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await POST(messagesReq(claudeCodeTurn({ max_tokens: 200_000 })));
    await res.text();

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_tokens).toBe(128_000);
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it.each([
    ["non-streaming", {}],
    ["streaming", { stream: true }],
  ])("%s, $1 wallet: max_tokens is lowered to what the wallet covers", async (_label, extra) => {
    mockMemory.fundCard(USER_ID, 1 * USD);

    const res = await POST(messagesReq(claudeCodeTurn({ max_tokens: 64_000, ...extra })));
    await res.text();

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_tokens as number).toBeLessThan(64_000);
    expect(venice.calls[0].body.max_tokens as number).toBeGreaterThanOrEqual(4_096);
    expect(venice.calls[0].body).not.toHaveProperty("max_completion_tokens");
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("a wallet that cannot cover even a short answer gets an Anthropic 402", async () => {
    mockMemory.fundCard(USER_ID, 100_000);

    const res = await POST(messagesReq(claudeCodeTurn()));
    const body = (await res.json()) as { type?: string; error?: { type?: string } };

    expect(res.status).toBe(402);
    expect(body.error?.type).toBe("billing_error");
    expect(venice.calls).toHaveLength(0);
    expect(mockMemory.reservations()).toHaveLength(0);
  });

  it("two Claude Code turns at once on a small wallet both run; a third refused while funds are held says so", async () => {
    // Review of #166: the lowered cap took the whole wallet, so a second
    // request at the same time got a "top up" 402 although nothing was spent.
    // $0.40 on claude-opus-4-8: the first turn may hold half ($0.20), the
    // second the 4,096-token floor (about $0.135), and a third finds $0.065.
    mockMemory.fundCard(USER_ID, 400_000);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    venice = createWorstCaseVenice({ beforeRespond: () => gate });
    global.fetch = venice.fetch as unknown as typeof fetch;
    const settle = async (predicate: () => boolean) => {
      for (let tick = 0; tick < 500 && !predicate(); tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const first = POST(messagesReq(claudeCodeTurn()));
    await settle(() => venice.calls.length === 1);
    const second = POST(messagesReq(claudeCodeTurn()));
    await settle(() => venice.calls.length === 2);
    // By now the two holds leave less than one short answer free.
    const holds = mockMemory.reservations().map((row) => Number(row.reserved_micro_usd));
    expect(holds).toHaveLength(2);
    const third = await POST(messagesReq(claudeCodeTurn()));
    open();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    await firstRes.text();
    await secondRes.text();

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(third.status).toBe(402);
    const body = (await third.json()) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe("billing_error");
    expect(body.error?.message).toMatch(/held by requests still running/i);
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("a malformed max_tokens is a 400, not a 500", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await POST(messagesReq(claudeCodeTurn({ max_tokens: "lots" })));

    expect(res.status).toBe(400);
    expect(venice.calls).toHaveLength(0);
  });
});
