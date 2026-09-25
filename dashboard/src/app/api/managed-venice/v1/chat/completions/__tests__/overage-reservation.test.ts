/**
 * Regression: a managed-Venice chat request must never be able to spend more
 * than the wallet hold it was admitted with (security review 2026-09, Medium
 * "Managed-Venice overage — no max_tokens reservation").
 *
 * Before the fix a request without `max_tokens` held only 4,096 output tokens,
 * while Venice's published contract lets it run to the model's maximum
 * (128,000 on claude-opus-4-8, about 31x more). The overage debit at capture
 * then failed on a small wallet, so Hivra paid for the difference.
 *
 * These tests run the REAL authorize/reserve/capture code against an in-memory
 * wallet, with a Venice fake that always generates as many tokens as the
 * forwarded request allows (see test-utils/fake-venice-inference.ts).
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
import { log } from "@/lib/logger";

let mockMemory: ManagedVeniceSpendWorld;
const mockVerifyKey = jest.fn();
// "live": every row as the live /v1/models refresh builds it, output limit
// confirmed by Venice. "fallback": the static catalog alone, which is what the
// proxy prices with while that refresh fails.
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
import { POST as internalAuthorize } from "@/app/api/managed-venice/internal/authorize/route";

const USER_ID = "user_chat_overage_fixture";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
// claude-opus-4-8: 1,000,000-token context, 128,000 max output, $6 / $30 per 1M.
const PREMIUM = "claude-opus-4-8";
const USD = 1_000_000;

function chatReq(body: unknown) {
  return new Request("https://hivra.test/api/managed-venice/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const shortChat = (extra: Record<string, unknown> = {}) => ({
  model: PREMIUM,
  messages: [{ role: "user", content: "Write the word 'again' forever." }],
  ...extra,
});

async function drain(res: Response) {
  if (!res.body) return;
  const reader = res.body.getReader();
  while (!(await reader.read()).done) {
    /* read to the end so settlement runs */
  }
}

describe("managed-Venice chat: the hold covers everything the request can spend", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let venice: ReturnType<typeof createWorstCaseVenice>;

  beforeEach(() => {
    jest.clearAllMocks();
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

  const expectSpendCoveredByHold = () => expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);

  it.each([
    ["non-streaming", {}],
    ["streaming", { stream: true }],
  ])(
    "%s, no max_tokens, $1 wallet: Venice is told to stop where half the wallet runs out",
    async (_label, extra) => {
      mockMemory.fundCard(USER_ID, 1 * USD);

      const res = await POST(chatReq(shortChat(extra)));
      await drain(res);

      expect(res.status).toBe(200);
      expect(venice.calls).toHaveLength(1);
      const forwarded = venice.calls[0].body;
      // The worst case (128,000 tokens, about $4.22 with the buffer) does not
      // fit a $1 wallet, so the request is forwarded with an explicit cap the
      // wallet can pay for instead of Venice's 128,000-token default.
      expect(typeof forwarded.max_completion_tokens).toBe("number");
      expect(forwarded.max_completion_tokens as number).toBeLessThan(128_000);
      expect(forwarded.max_completion_tokens as number).toBeGreaterThanOrEqual(4_096);
      // It is the largest cap half the wallet covers: the other half stays
      // free for a request running at the same time.
      const [hold] = mockMemory.reservations();
      expect(Number(hold.reserved_micro_usd)).toBeLessThanOrEqual(0.5 * USD);
      expect(Number(hold.reserved_micro_usd)).toBeGreaterThan(0.499 * USD);
      expect(log.info).toHaveBeenCalledWith(
        "Managed Venice chat output cap lowered to what the wallet covers",
        expect.objectContaining({
          failureType: "managed_venice_output_cap_lowered_to_balance",
          outputCap: forwarded.max_completion_tokens,
          modelMaxOutputTokens: 128_000,
        })
      );
      expectSpendCoveredByHold();
    }
  );

  it("no max_tokens, well-funded wallet: holds the model maximum and forwards the body unchanged", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await POST(chatReq(shortChat()));
    await drain(res);

    expect(res.status).toBe(200);
    const forwarded = venice.calls[0].body;
    expect(forwarded).not.toHaveProperty("max_completion_tokens");
    expect(forwarded).not.toHaveProperty("max_tokens");
    expect(venice.calls[0].completionTokens).toBe(128_000);
    expectSpendCoveredByHold();
  });

  it("a cap above the model maximum is forwarded as the model maximum", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await POST(chatReq(shortChat({ max_tokens: 1_000_000 })));
    await drain(res);

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_tokens).toBe(128_000);
    expectSpendCoveredByHold();
  });

  it("two cap fields that disagree are both forwarded as the reserved cap", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await POST(chatReq(shortChat({ max_completion_tokens: 100, max_tokens: 100_000 })));
    await drain(res);

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_completion_tokens).toBe(100);
    expect(venice.calls[0].body.max_tokens).toBe(100);
    expectSpendCoveredByHold();
  });

  it("n choices: the hold covers every choice", async () => {
    mockMemory.fundCard(USER_ID, 1 * USD);

    const res = await POST(chatReq(shortChat({ n: 3 })));
    await drain(res);

    expect(res.status).toBe(200);
    expectSpendCoveredByHold();
  });

  it("an explicit cap the wallet cannot cover is lowered to what it can", async () => {
    mockMemory.fundCard(USER_ID, 1 * USD);

    const res = await POST(chatReq(shortChat({ max_tokens: 64_000 })));
    await drain(res);

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_tokens as number).toBeLessThan(64_000);
    expect(venice.calls[0].body).not.toHaveProperty("max_completion_tokens");
    expectSpendCoveredByHold();
  });

  it("a wallet that cannot cover even a short answer gets 402 and Venice is never called", async () => {
    // $0.10 covers about 3,000 output tokens on this model: below the floor.
    mockMemory.fundCard(USER_ID, 100_000);

    const res = await POST(chatReq(shortChat()));

    expect(res.status).toBe(402);
    expect(venice.calls).toHaveLength(0);
    expect(mockMemory.reservations()).toHaveLength(0);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("managed_venice_insufficient_balance");
    expect(body.error?.message).toContain("Top up LLM credits");
    expect(body.error?.message).not.toMatch(/held/i);
  });

  // Review of #166 (required fix 1): the lowered cap took the whole wallet, so
  // a second request at the same time got a 402. Probe: a $2 wallet, two
  // uncapped claude-opus-4-8 requests at once. Canary admitted both (each held
  // $0.135); #166 held $1.99997 for the first and refused the second. Two
  // Hermes chats on one wallet, or a side call overlapping the main one, hit it.
  describe("requests running at the same time on one wallet", () => {
    async function waitUntil(condition: () => boolean) {
      for (let tick = 0; tick < 500 && !condition(); tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(condition()).toBe(true);
    }

    /** Starts `first`, waits until it is at Venice with its hold active, then runs `second`. */
    async function overlap(first: () => Promise<Response>, second: () => Promise<Response>) {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      venice = createWorstCaseVenice({ beforeRespond: () => gate });
      global.fetch = venice.fetch as unknown as typeof fetch;

      const firstRes = first();
      await waitUntil(() => venice.calls.length === 1);
      let secondDone = false;
      const secondRes = second().finally(() => {
        secondDone = true;
      });
      await waitUntil(() => secondDone || venice.calls.length === 2);
      open();
      return Promise.all([firstRes, secondRes]);
    }

    it("a $2 wallet runs two uncapped premium requests at once, each with a cap it can pay for", async () => {
      mockMemory.fundCard(USER_ID, 2 * USD);

      const [first, second] = await overlap(
        () => POST(chatReq(shortChat())),
        () => POST(chatReq(shortChat({ stream: true })))
      );
      await drain(first);
      await drain(second);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(venice.calls).toHaveLength(2);
      const [firstCap, secondCap] = venice.calls.map((call) => call.body.max_completion_tokens as number);
      expect(firstCap).toBeGreaterThanOrEqual(4_096);
      expect(secondCap).toBeGreaterThanOrEqual(4_096);
      expect(secondCap).toBeLessThan(firstCap);
      const [firstHold, secondHold] = mockMemory.reservations().map((row) => Number(row.reserved_micro_usd));
      // Neither hold takes more than half of what was free when it was made.
      expect(firstHold).toBeLessThanOrEqual(1 * USD);
      expect(secondHold).toBeLessThanOrEqual((2 * USD - firstHold) / 2);
      expectSpendCoveredByHold();
    });

    it("a wallet above the worst case still leaves room for a second request", async () => {
      // $4.30 covers the 128,000-token worst case (about $4.22) once, with
      // almost nothing left: the first hold must not take it all.
      mockMemory.fundCard(USER_ID, 4_300_000);

      const [first, second] = await overlap(
        () => POST(chatReq(shortChat())),
        () => POST(chatReq(shortChat()))
      );
      await drain(first);
      await drain(second);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expectSpendCoveredByHold();
    });

    it("a request refused because the balance is held (not spent) gets a 402 that says so", async () => {
      // $0.20 covers one short answer (4,096 tokens, about $0.135) at a time.
      mockMemory.fundCard(USER_ID, 200_000);

      const [first, second] = await overlap(
        () => POST(chatReq(shortChat())),
        () => POST(chatReq(shortChat()))
      );
      await drain(first);

      expect(first.status).toBe(200);
      expect(second.status).toBe(402);
      expect(venice.calls).toHaveLength(1);
      const body = (await second.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe("managed_venice_insufficient_balance");
      expect(body.error?.message).toMatch(/held by requests still running/i);
      expect(body.error?.message).toMatch(/retry/i);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("held"),
        expect.objectContaining({ failureType: "managed_venice_balance_held", heldMicroUsd: expect.any(Number) })
      );
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
    ["string", "100"],
  ])("rejects a %s max_tokens with 400, not a 500", async (_label, value) => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await POST(chatReq(shortChat({ max_tokens: value })));

    expect(res.status).toBe(400);
    expect(venice.calls).toHaveLength(0);
    expect(mockMemory.reservations()).toHaveLength(0);
  });

  it("treats max_tokens: null as absent", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await POST(chatReq(shortChat({ max_tokens: null })));
    await drain(res);

    expect(res.status).toBe(200);
    expectSpendCoveredByHold();
  });
});

// Review of #166: the static catalog listed zai-org-glm-5-1 at 24,000 output
// tokens while Venice's live /v1/models said 80,000. The proxy wrote no cap when
// the cap it held equalled the catalog maximum, so while live pricing was down
// (the static catalog is cached for five minutes after a failed refresh) a
// request with no cap held 24,000 tokens and Venice ran it to 80,000: hold
// $0.145, bill $0.44, filed as managed_venice_overage_uncovered. A maximum
// Venice has not confirmed is only a guess, so the cap the hold covers is
// always written into the forwarded body.
describe("managed-Venice chat while live pricing is down: the catalog maximum is not trusted", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let venice: ReturnType<typeof createWorstCaseVenice>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPricingSource = "fallback";
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
    // Venice now lets this model run twice as long as the catalog says.
    venice = createWorstCaseVenice({ veniceMaxOutputTokens: { [PREMIUM]: 256_000 } });
    global.fetch = venice.fetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  it.each([
    ["non-streaming", {}],
    ["streaming", { stream: true }],
  ])("%s, no max_tokens, well-funded wallet: the held cap is written into the request", async (_label, extra) => {
    mockMemory.fundCard(USER_ID, 20 * USD);

    const res = await POST(chatReq(shortChat(extra)));
    await drain(res);

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_completion_tokens).toBe(128_000);
    expect(venice.calls[0].completionTokens).toBe(128_000);
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("a cap equal to the catalog maximum is forwarded as sent", async () => {
    mockMemory.fundCard(USER_ID, 20 * USD);

    const res = await POST(chatReq(shortChat({ max_tokens: 128_000 })));
    await drain(res);

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_tokens).toBe(128_000);
    expect(venice.calls[0].body).not.toHaveProperty("max_completion_tokens");
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });
});

describe("off-Vercel Worker authorize: only a Worker that applies the patch gets a lower cap", () => {
  const envBefore = { ...process.env };
  const SECRET = "internal-secret-fixture";

  beforeEach(() => {
    jest.clearAllMocks();
    mockPricingSource = "live";
    mockMemory = createManagedVeniceSpendWorld();
    mockVerifyKey.mockResolvedValue({
      id: KEY_ID,
      userId: USER_ID,
      status: "active",
      defaultWalletType: "card",
    });
    process.env.VENICE_API_KEY = "server-key-fixture";
    process.env.MANAGED_VENICE_INTERNAL_SECRET = SECRET;
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
  });

  afterEach(() => {
    process.env = { ...envBefore };
  });

  function authorizeReq(payload: Record<string, unknown>) {
    return new Request("https://hivra.test/api/managed-venice/internal/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-managed-venice-internal-secret": SECRET },
      body: JSON.stringify({ plaintextKey: "hven_live_fixture", ...payload }),
    }) as unknown as NextRequest;
  }

  it("an older Worker (no acceptsBodyPatch) is refused rather than given a cap it would drop", async () => {
    mockMemory.fundCard(USER_ID, 1 * USD);

    const res = await internalAuthorize(authorizeReq({ body: shortChat() }));

    expect(res.status).toBe(402);
    expect(mockMemory.reservations()).toHaveLength(0);
  });

  it("an older Worker with enough balance holds the full worst case and gets an empty patch", async () => {
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await internalAuthorize(authorizeReq({ body: shortChat({ max_tokens: 1_000_000 }) }));
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.bodyPatch).toEqual({});
    const [hold] = mockMemory.reservations();
    // Forwarded unchanged, Venice stops at the model's 128,000-token maximum.
    expect(Number(hold.reserved_micro_usd)).toBeGreaterThanOrEqual(128_000 * 30);
  });

  it("an older Worker while live pricing is down holds up to the context window, since the catalog maximum is unconfirmed", async () => {
    // The older Worker forwards its own copy, so no cap can be written. The
    // only bound left on a request with no cap is the model's context window.
    // venice-uncensored-1-2: 128,000-token context, 8,192 catalog maximum, $0.90 per 1M output.
    mockPricingSource = "fallback";
    mockMemory.fundCard(USER_ID, 10 * USD);

    const res = await internalAuthorize(
      authorizeReq({
        body: { model: "venice-uncensored-1-2", messages: [{ role: "user", content: "Go on forever." }] },
      })
    );
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.bodyPatch).toEqual({});
    const [hold] = mockMemory.reservations();
    expect(Number(hold.reserved_micro_usd)).toBeGreaterThanOrEqual(Math.ceil(128_000 * 0.9));
  });

  it("a Worker that applies the patch while live pricing is down gets the held cap written", async () => {
    mockPricingSource = "fallback";
    mockMemory.fundCard(USER_ID, 20 * USD);

    const res = await internalAuthorize(authorizeReq({ body: shortChat(), acceptsBodyPatch: true }));
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.bodyPatch).toEqual({ max_completion_tokens: 128_000 });
  });

  it("a Worker that applies the patch gets the cap the wallet covers", async () => {
    mockMemory.fundCard(USER_ID, 1 * USD);

    const res = await internalAuthorize(authorizeReq({ body: shortChat(), acceptsBodyPatch: true }));
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.bodyPatch.max_completion_tokens).toBeGreaterThanOrEqual(4_096);
    expect(payload.bodyPatch.max_completion_tokens).toBeLessThan(128_000);
    const [hold] = mockMemory.reservations();
    expect(Number(hold.reserved_micro_usd)).toBeLessThanOrEqual(1 * USD);
    expect(Number(hold.reserved_micro_usd)).toBeGreaterThanOrEqual(
      payload.bodyPatch.max_completion_tokens * 30
    );
  });
});
