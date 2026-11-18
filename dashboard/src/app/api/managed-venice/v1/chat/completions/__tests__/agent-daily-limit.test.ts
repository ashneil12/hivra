/**
 * An agent's daily limit on Hivra AI is a hard stop: holds count against it
 * while requests run, a request is sized down to what is left of the limit
 * (like a small wallet), and once too little is left it gets a 402 and Venice
 * is never called. The REAL authorize/reserve/capture code runs against an
 * in-memory wallet; the Venice fake always generates as much as it is allowed.
 * The database guard (migration 20261117233000) repeats the check atomically.
 */
import { NextRequest } from "next/server";

import { createManagedVeniceSpendWorld, type ManagedVeniceSpendWorld } from "@/test-utils/managed-venice-spend-world";
import { createWorstCaseVenice, expectEveryCallCoveredByItsHold } from "@/test-utils/fake-venice-inference";
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
    map: new Map(VENICE_CHAT_MODEL_PRICES.map((entry) => [entry.model, { ...entry, maxOutputTokensSource: "venice_live" }])),
    source: "merged",
    fetchedAt: Date.now(),
    liveModelCount: VENICE_CHAT_MODEL_PRICES.length,
  })),
}));
jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { POST } from "../route";

const USER_ID = "user_agent_limit_fixture";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
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

const chargedToday = () =>
  mockMemory.usageEvents()
    .filter((row) => row.proxy_key_id === KEY_ID)
    .reduce((sum, row) => sum + Number(row.charged_micro_usd ?? 0), 0);

describe("managed-Venice chat: an agent's daily limit is a hard stop", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let venice: ReturnType<typeof createWorstCaseVenice>;

  function withLimit(dailyUsd: number) {
    mockMemory.insertRow("managed_venice_proxy_keys", {
      id: KEY_ID,
      user_id: USER_ID,
      status: "active",
      metadata: { defaultWalletType: "card", spendCap: { dailyMicroUsd: dailyUsd * USD } },
    });
  }

  beforeEach(() => {
    // Only the clock is faked: the in-memory rows are stamped on 1 January.
    jest.useFakeTimers({
      now: new Date("2026-01-01T12:00:00.000Z"),
      doNotFake: ["setImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "nextTick", "queueMicrotask", "hrtime", "performance"],
    });
    jest.clearAllMocks();
    mockMemory = createManagedVeniceSpendWorld();
    mockVerifyKey.mockResolvedValue({ id: KEY_ID, userId: USER_ID, status: "active", defaultWalletType: "card" });
    process.env.VENICE_API_KEY = "server-key-fixture";
    process.env.MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED = "true";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    venice = createWorstCaseVenice();
    global.fetch = venice.fetch as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  it("a rich wallet with a $1 limit: the request is told to stop where half the limit runs out", async () => {
    mockMemory.fundCard(USER_ID, 50 * USD);
    withLimit(1);

    const res = await POST(chatReq(shortChat()));
    await drain(res);

    expect(res.status).toBe(200);
    expect(venice.calls[0].body.max_completion_tokens as number).toBeLessThan(128_000);
    const [hold] = mockMemory.reservations();
    expect(Number(hold.reserved_micro_usd)).toBeLessThanOrEqual(0.5 * USD);
    expect(hold.metadata).toMatchObject({ agentDailyCapMicroUsd: 1 * USD });
    expect(hold.proxy_key_id).toBe(KEY_ID);
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("an agent sending request after request never gets charged past its limit", async () => {
    mockMemory.fundCard(USER_ID, 50 * USD);
    withLimit(1);

    let refused = 0;
    for (let i = 0; i < 20; i += 1) {
      const res = await POST(chatReq(shortChat(i % 2 ? { stream: true } : {})));
      if (res.status === 402) {
        refused += 1;
        expect(await res.text()).toMatch(/daily inference limit/);
        continue;
      }
      expect(res.status).toBe(200);
      await drain(res);
    }

    expect(refused).toBeGreaterThan(0);
    expect(chargedToday()).toBeLessThanOrEqual(1 * USD);
    expectEveryCallCoveredByItsHold(mockMemory, venice, USER_ID);
  });

  it("requests running at the same time share the limit instead of each seeing all of it", async () => {
    mockMemory.fundCard(USER_ID, 50 * USD);
    withLimit(1);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    venice = createWorstCaseVenice({ beforeRespond: () => gate });
    global.fetch = venice.fetch as unknown as typeof fetch;

    // Five at once, all held before any answers.
    const pending = Array.from({ length: 5 }, () => POST(chatReq(shortChat())));
    for (let tick = 0; tick < 500 && mockMemory.reservations().length + 0 < 5; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    open();
    const results = await Promise.all(pending);
    for (const res of results) await drain(res);

    const held = mockMemory.reservations().reduce((sum, row) => sum + Number(row.reserved_micro_usd), 0);
    expect(held).toBeLessThanOrEqual(1 * USD);
    expect(chargedToday()).toBeLessThanOrEqual(1 * USD);
  });

  it("an agent with too little of its limit left gets a 402 and Venice is never called", async () => {
    mockMemory.fundCard(USER_ID, 50 * USD);
    withLimit(1);
    mockMemory.insertRow("managed_venice_usage_events", {
      user_id: USER_ID,
      proxy_key_id: KEY_ID,
      reference_id: "earlier_today",
      charged_micro_usd: 990_000,
      created_at: "2026-01-01T09:00:00.000Z",
    });

    const res = await POST(chatReq(shortChat()));

    expect(res.status).toBe(402);
    expect(await res.text()).toMatch(/daily inference limit of \$1\.00/);
    expect(venice.calls).toHaveLength(0);
    expect(mockMemory.reservations()).toHaveLength(0);
  });
});
