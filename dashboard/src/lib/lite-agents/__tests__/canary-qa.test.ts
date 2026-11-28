import { encryptSecret } from "@/lib/crypto";
import { GET, POST } from "@/app/api/lite-agents/[...path]/route";

const mockAuth = jest.fn();
const mockSettings = jest.fn();
const mockOwnerFilter = jest.fn();
const mockFrom = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: string) => mockFrom(table) } }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: jest.fn(() => null),
  RATE_LIMIT_PRESETS: { messageWrite: {}, settingsWrite: {} },
}));

const owner = "user_litefixture";
const worker = "https://lite-agent-canary.fixture.workers.dev";
const secret = "cd".repeat(32);
const now = Date.parse("2026-01-01T09:00:00Z");
const canary = {
  VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
  VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
};
const request = () => GET(new Request("https://canary.hermesos.cloud/api/lite-agents/me"), {
  params: Promise.resolve({ path: ["me"] }),
});
const settings = (overrides: Record<string, unknown> = {}) => ({
  data: {
    enabled: true, credential_mode: "encrypted", owner_id: owner, expires_at: "2026-01-01T10:00:00Z",
    worker_origin: worker, signing_secret_enc: encryptSecret(secret), ...overrides,
  },
  error: null,
});

let upstream: jest.SpiedFunction<typeof fetch>;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(now);
  jest.replaceProperty(process, "env", { NODE_ENV: "test", ...canary, ENCRYPTION_KEY: "ab".repeat(32) });
  mockAuth.mockResolvedValue({ userId: owner });
  mockSettings.mockResolvedValue(settings());
  mockFrom.mockReturnValue({
    select: () => ({ eq: () => ({
      eq: (column: string, owner: string) => {
        mockOwnerFilter(column, owner);
        return { maybeSingle: () => mockSettings() };
      },
    }) }),
  });
  upstream = jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ signed: true }));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("signs only the configured standing owner's request to the exact Canary Worker", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ signed: true });
  expect(mockFrom).toHaveBeenCalledWith("hivra_canary_lite_qa_settings");
  expect(mockOwnerFilter).toHaveBeenCalledWith("owner_id", owner);
  expect(upstream).toHaveBeenCalledWith(worker + "/v1/me", expect.objectContaining({
    headers: expect.objectContaining({ "x-hivra-account": owner, "x-hivra-signature": expect.stringMatching(/^[0-9a-f]{64}$/) }),
    redirect: "error",
  }));
  expect(JSON.stringify(upstream.mock.calls)).not.toContain(secret);
});

it("never looks up QA settings or calls the Worker from non-Canary Git", async () => {
  process.env.VERCEL_GIT_COMMIT_REF = "main";
  expect((await request()).status).toBe(404);
  expect(mockAuth).not.toHaveBeenCalled();
  expect(mockFrom).not.toHaveBeenCalled();
  expect(upstream).not.toHaveBeenCalled();
});

it("keeps unsigned requests hidden without reading settings", async () => {
  mockAuth.mockResolvedValue({ userId: null });
  expect((await request()).status).toBe(404);
  expect(mockFrom).not.toHaveBeenCalled();
  expect(upstream).not.toHaveBeenCalled();
});

it.each([
  { enabled: false },
  { owner_id: "user_unrelated" },
  { expires_at: "2026-01-01T09:00:00Z" },
  { expires_at: "2026-01-02T09:00:01Z" },
  { worker_origin: "http://lite-agent-canary.fixture.workers.dev" },
  { worker_origin: "https://lite-agent-canary.fixture.workers.dev/path" },
  { worker_origin: "https://lite-agent.fixture.workers.dev" },
  { signing_secret_enc: "invalid-envelope" },
])("fails closed for an unusable settings row: %j", async (overrides) => {
  mockSettings.mockResolvedValue(settings(overrides));
  expect((await request()).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});

it("does not fall back to deployment env on canonical Canary on a missing row or read error", async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT: "1", HIVRA_LITE_AGENT_URL: worker, HIVRA_LITE_AGENT_SECRET: secret,
  });
  mockSettings.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { code: "42501" } });
  expect((await request()).status).toBe(404);
  expect((await request()).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});

it("preserves the existing opt-in deployment-env route outside canonical Canary", async () => {
  Object.assign(process.env, {
    VERCEL_GIT_COMMIT_REF: "main", NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT: "1",
    HIVRA_LITE_AGENT_URL: worker, HIVRA_LITE_AGENT_SECRET: secret,
  });
  expect((await request()).status).toBe(200);
  expect(mockFrom).not.toHaveBeenCalled();
});

it("requires an explicit inference route in managed QA and preserves the legacy preview elsewhere", async () => {
  const agent = "00000000-0000-4000-8000-000000000004";
  const session = "00000000-0000-4000-8000-000000000005";
  const send = (path: string) => POST(new Request("https://canary.hermesos.cloud/api/lite-agents", {
    method: "POST", body: JSON.stringify({ content: "hello" }),
  }), { params: Promise.resolve({ path: ["agents", agent, "sessions", session, path] }) });

  expect((await send("managed-messages")).status).toBe(404);
  expect((await send("own-key-messages")).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
  mockSettings.mockResolvedValue(settings({
    managed_enabled: true, managed_model: "venice-uncensored-1-2", managed_proxy_key_id: agent,
    managed_proxy_key_enc: encryptSecret("hven_live_" + "a".repeat(43)),
  }));
  expect((await send("messages")).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  expect((await send("managed-messages")).status).toBe(200);
  expect((await send("own-key-messages")).status).toBe(200);

  Object.assign(process.env, {
    VERCEL_GIT_COMMIT_REF: "main", NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT: "1",
    HIVRA_LITE_AGENT_URL: worker, HIVRA_LITE_AGENT_SECRET: secret,
  });
  expect((await send("managed-messages")).status).toBe(404);
  expect((await send("own-key-messages")).status).toBe(404);
  expect((await send("messages")).status).toBe(200);
});
