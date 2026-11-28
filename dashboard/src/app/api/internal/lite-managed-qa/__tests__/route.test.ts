import { POST } from "../route";
import { encryptSecret } from "@/lib/crypto";
import { liteSignatureHeaders, LITE_MANAGED_QA_CALLBACK_PATH, LITE_MANAGED_QA_SIGNATURE_VERSION } from "@/lib/lite-agents/signing";

const mockVerify = jest.fn();
const mockSummary = jest.fn();
const mockPricing = jest.fn();
const mockGrant = jest.fn();
const mockReserve = jest.fn();
const mockCapture = jest.fn();
const mockRelease = jest.fn();
const mockReconcile = jest.fn();
const mockSettings = jest.fn();
const mockClaim = jest.fn();
const OWNER = "user_litefixture";
const KEY_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-000000000002";
const SECRET = "cd".repeat(32);
const PROXY_KEY = "hven_live_" + "a".repeat(43);
const MODEL = "venice-uncensored-1-2";
const NOW = Date.parse("2026-01-01T09:00:00Z");

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from(table: string) {
  if (table === "hivra_canary_lite_qa_settings") {
    return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => mockSettings() }) }) }) };
  }
  if (table === "hivra_canary_lite_managed_qa_requests") return { insert: (input: unknown) => mockClaim(input) };
  throw new Error("Unexpected table");
} } }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/venice/proxy-keys", () => ({ verifyManagedVeniceProxyKey: () => mockVerify() }));
jest.mock("@/lib/billing/managed-venice-wallets", () => ({
  ...jest.requireActual("@/lib/billing/managed-venice-wallets"),
  getManagedVeniceWalletSummary: () => mockSummary(),
}));
jest.mock("@/lib/venice/cost-estimator", () => ({
  ...jest.requireActual("@/lib/venice/cost-estimator"),
  estimateChatCompletionCost: () => ({ estimatedCostMicroUsd: 10, reservedCostMicroUsd: 11 }),
}));
jest.mock("@/lib/venice/live-pricing", () => ({ getVenicePricingMap: () => mockPricing() }));
jest.mock("@/lib/venice/promo/service", () => ({ tryGrantLaunchCredit: () => mockGrant() }));
jest.mock("@/lib/venice/proxy-settlement", () => ({
  loadManagedVeniceReservationOwner: jest.fn(async () => null),
  reserveManagedVeniceChatRequest: (input: unknown) => mockReserve(input),
  captureManagedVeniceChatUsage: (input: unknown) => mockCapture(input),
  releaseManagedVeniceChatReservationOrFile: (input: unknown) => mockRelease(input),
  markManagedVeniceReconciliationRequired: (input: unknown) => mockReconcile(input),
  captureManagedVeniceObservedOutput: jest.fn(),
}));

function request({ content = "Say hello", owner = OWNER, ageMs = 0, version = LITE_MANAGED_QA_SIGNATURE_VERSION,
  mutate = false }: { content?: string; owner?: string; ageMs?: number; version?: string; mutate?: boolean } = {}) {
  const text = JSON.stringify({ requestId: REQUEST, content, model: "must-not-override", stream: true, tools: ["ignored"] });
  return new Request("https://canary.hermesos.cloud" + LITE_MANAGED_QA_CALLBACK_PATH, {
    method: "POST", headers: liteSignatureHeaders(SECRET, "POST", LITE_MANAGED_QA_CALLBACK_PATH, owner, text, NOW - ageMs, version),
    body: mutate ? text.replace("Say hello", "different") : text,
  });
}

let fetchFixture: jest.SpiedFunction<typeof fetch>;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
  jest.replaceProperty(process, "env", {
    NODE_ENV: "test", VERCEL: "1", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "canary",
    VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
    ENCRYPTION_KEY: "ab".repeat(32), VENICE_API_KEY: "fixture-provider-only",
  });
  mockSettings.mockResolvedValue({ error: null, data: {
    enabled: true, owner_id: OWNER, expires_at: "2026-01-01T10:00:00Z", managed_enabled: true,
    worker_origin: "https://lite-agent-canary.fixture.workers.dev", signing_secret_enc: encryptSecret(SECRET),
    managed_model: MODEL, managed_proxy_key_id: KEY_ID, managed_proxy_key_enc: encryptSecret(PROXY_KEY),
  } });
  const claims = new Set<string>();
  mockClaim.mockImplementation(({ request_id }) => {
    if (claims.has(request_id)) return { error: { code: "23505" } };
    claims.add(request_id);
    return { error: null };
  });
  mockVerify.mockResolvedValue({ userId: OWNER, id: KEY_ID, defaultWalletType: "card" });
  mockSummary.mockResolvedValue({ card: { availableMicroUsd: 1000 } });
  mockPricing.mockResolvedValue({ map: new Map(), source: "fallback", liveModelCount: 0 });
  mockReserve.mockResolvedValue({ reservationId: "fixture-reservation", reservedMicroUsd: 11 });
  fetchFixture = jest.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    choices: [{ message: { content: "Hello" } }],
    usage: { prompt_tokens: 4, completion_tokens: 3 }, internal: "must-not-be-relayed",
  }));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("hides non-Canary, bad owner, stale and tampered requests before claiming or spending", async () => {
  process.env.VERCEL_GIT_COMMIT_REF = "main";
  expect((await POST(request())).status).toBe(404);
  process.env.VERCEL_GIT_COMMIT_REF = "canary";
  for (const options of [{ owner: "user_outside" }, { ageMs: 301_000 }, { version: "lite|v1" }, { mutate: true }]) {
    expect((await POST(request(options))).status).toBe(404);
  }
  expect(mockClaim).not.toHaveBeenCalled();
  expect(fetchFixture).not.toHaveBeenCalled();
});

it.each([
  { userId: "user_outside", id: KEY_ID, defaultWalletType: "card" },
  { userId: OWNER, id: "different", defaultWalletType: "card" },
  { userId: OWNER, id: KEY_ID, defaultWalletType: "hermesos" },
])("doesn't touch billing or provider for a mismatched key: %j", async (key) => {
  mockVerify.mockResolvedValue(key);
  expect((await POST(request())).status).toBe(502);
  expect(mockSummary).not.toHaveBeenCalled();
  expect(mockGrant).not.toHaveBeenCalled();
  expect(mockReserve).not.toHaveBeenCalled();
  expect(fetchFixture).not.toHaveBeenCalled();
});

it("empty card credits fail before pricing, hold, grants or provider", async () => {
  mockSummary.mockResolvedValue({ card: { availableMicroUsd: 0 } });
  const res = await POST(request());
  expect(res.status).toBe(402);
  expect(await res.json()).toEqual({ error: "managed_credits_required" });
  expect(mockPricing).not.toHaveBeenCalled();
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockGrant).not.toHaveBeenCalled();
  expect(fetchFixture).not.toHaveBeenCalled();
});

it("uses one bounded managed completion and one settlement across concurrent replays", async () => {
  const responses = await Promise.all([POST(request()), POST(request())]);
  expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
  expect(await responses.find((res) => res.ok)!.json()).toEqual({ text: "Hello" });
  expect((await POST(request({ content: "changed" }))).status).toBe(409);
  expect(mockReserve).toHaveBeenCalledTimes(1);
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(mockGrant).not.toHaveBeenCalled();
  expect(fetchFixture).toHaveBeenCalledTimes(1);
  const [url, init] = fetchFixture.mock.calls[0];
  expect(url).toBe("https://api.venice.ai/api/v1/chat/completions");
  expect(init?.redirect).toBe("error");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    model: MODEL, stream: false, max_tokens: 128, messages: [{ role: "user", content: "Say hello" }],
  });
  expect(JSON.parse(String(init?.body))).not.toHaveProperty("tools");
});

it("releases before billable usage and doesn't relay raw provider errors", async () => {
  fetchFixture.mockResolvedValue(Response.json({ error: "private upstream detail" }, { status: 503 }));
  const res = await POST(request());
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "managed_reply_failed" });
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(mockCapture).not.toHaveBeenCalled();
  expect(fetchFixture).toHaveBeenCalledTimes(1);
});

it("doesn't release ambiguous transport outcomes as free replies", async () => {
  fetchFixture.mockRejectedValue(new Error("fixture transport interrupted"));
  expect((await POST(request())).status).toBe(502);
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(mockRelease).not.toHaveBeenCalled();
  expect(mockCapture).not.toHaveBeenCalled();
});
