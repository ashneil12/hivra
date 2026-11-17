/**
 * @jest-environment node
 */
import {
  AgentPrivateOnlyKeyNotFoundError,
  MANAGED_VENICE_PRIVATE_ONLY_CODE,
  checkManagedVeniceAgentPrivateOnly,
  isModelFreeManagedVeniceEndpoint,
  managedVenicePrivateOnlyModelFilter,
  managedVenicePrivateOnlyResponse,
  readAgentPrivateOnly,
  resolveManagedVeniceAgentPrivateOnlyConfig,
  setManagedVeniceAgentPrivateOnly,
} from "@/lib/venice/agent-private-only";
import { _resetVeniceModelPrivacyCacheForTests } from "@/lib/venice/model-privacy-live";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

type Row = Record<string, unknown>;

function fakeDb(rows: Row[]) {
  function from() {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const matching = () => rows.filter(r => filters.every(f => f(r)));
    const chain: Record<string, unknown> = {
      select: () => {
        if (!patch) return chain;
        const hit = matching();
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null });
      },
      update: (p: Row) => { patch = p; return chain; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return chain; },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
    };
    return chain;
  }
  return { from };
}

const ON = { MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED: "true" };
const KEY_ON = { id: "key-1", userId: "u1", privateModelsOnly: true };
const KEY_OFF = { id: "key-1", userId: "u1", privateModelsOnly: false };
const CHAT = "/api/v1/chat/completions";

const originalFetch = global.fetch;
const model = (id: string, privacy: string, type = "text") => ({ id, type, model_spec: { privacy } });

function veniceLists(data: unknown[]) {
  const fetchMock = jest.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const LIST = [
  model("kimi-k2-6", "private"),
  model("e2ee-glm-5-3-p", "private"),
  model("claude-opus-4-8", "anonymized"),
  model("tts-kokoro", "private", "tts"),
  model("tts-elevenlabs-turbo-v2-5", "anonymized", "tts"),
  model("upscaler", "private", "upscale"),
  model("text-embedding-3-small", "anonymized", "embedding"),
];

beforeEach(() => {
  _resetVeniceModelPrivacyCacheForTests();
  jest.clearAllMocks();
});
afterEach(() => { global.fetch = originalFetch; });

describe("config and stored setting", () => {
  it("is off unless the flag is exactly true", () => {
    expect(resolveManagedVeniceAgentPrivateOnlyConfig({})).toEqual({ enabled: false });
    expect(resolveManagedVeniceAgentPrivateOnlyConfig({ MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED: "1" })).toEqual({ enabled: false });
    expect(resolveManagedVeniceAgentPrivateOnlyConfig(ON)).toEqual({ enabled: true });
  });

  it("reads the setting defensively: only a stored true is on", () => {
    expect(readAgentPrivateOnly({ privateOnly: { enabled: true, updatedAt: "2026-11-17T10:00:00.000Z" } }))
      .toEqual({ enabled: true, updatedAt: "2026-11-17T10:00:00.000Z" });
    expect(readAgentPrivateOnly({ privateOnly: { enabled: "true" } }).enabled).toBe(false);
    expect(readAgentPrivateOnly({ privateOnly: true }).enabled).toBe(false);
    expect(readAgentPrivateOnly({ defaultWalletType: "card" })).toEqual({ enabled: false, updatedAt: null });
    expect(readAgentPrivateOnly(null)).toEqual({ enabled: false, updatedAt: null });
  });
});

describe("setManagedVeniceAgentPrivateOnly", () => {
  it("turns it on and off without dropping the key's other settings", async () => {
    const row: Row = { id: "key-1", user_id: "u1", metadata: { defaultWalletType: "card", spendCap: { dailyMicroUsd: 5_000_000 } } };
    const db = fakeDb([row]);
    const now = new Date("2026-11-17T12:00:00.000Z");
    expect(await setManagedVeniceAgentPrivateOnly({ userId: "u1", proxyKeyId: "key-1", enabled: true, now }, db))
      .toEqual({ enabled: true, updatedAt: now.toISOString() });
    expect(row.metadata).toEqual({
      defaultWalletType: "card",
      spendCap: { dailyMicroUsd: 5_000_000 },
      privateOnly: { enabled: true, updatedAt: now.toISOString() },
    });
    expect((await setManagedVeniceAgentPrivateOnly({ userId: "u1", proxyKeyId: "key-1", enabled: false, now }, db)).enabled).toBe(false);
    expect((row.metadata as Row).spendCap).toEqual({ dailyMicroUsd: 5_000_000 });
  });

  it("refuses a key that is not this owner's", async () => {
    const row: Row = { id: "key-1", user_id: "u1", metadata: {} };
    await expect(setManagedVeniceAgentPrivateOnly({ userId: "u2", proxyKeyId: "key-1", enabled: true }, fakeDb([row])))
      .rejects.toBeInstanceOf(AgentPrivateOnlyKeyNotFoundError);
    expect(row.metadata).toEqual({});
  });
});

describe("checkManagedVeniceAgentPrivateOnly", () => {
  it("allows everything, and looks nothing up, while the flag is off", async () => {
    const fetchMock = veniceLists(LIST);
    expect(await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "claude-opus-4-8", endpoint: CHAT, source: "t" }, {})).toEqual({ allowed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows everything, and looks nothing up, for a key without the setting", async () => {
    const fetchMock = veniceLists(LIST);
    expect(await checkManagedVeniceAgentPrivateOnly({ key: KEY_OFF, model: "claude-opus-4-8", endpoint: CHAT, source: "t" }, ON)).toEqual({ allowed: true });
    expect(await checkManagedVeniceAgentPrivateOnly({ key: { id: "k", userId: "u" }, model: "claude-opus-4-8", endpoint: CHAT, source: "t" }, ON)).toEqual({ allowed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows models Venice marks private, of any type", async () => {
    veniceLists(LIST);
    for (const [endpoint, id] of [[CHAT, "kimi-k2-6"], [CHAT, "e2ee-glm-5-3-p"], ["/api/v1/audio/speech", "tts-kokoro"]]) {
      expect(await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: id, endpoint, source: "t" }, ON)).toEqual({ allowed: true });
    }
  });

  it("refuses an anonymized model and says why", async () => {
    veniceLists(LIST);
    const verdict = await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "claude-opus-4-8", endpoint: CHAT, source: "managed-venice-chat" }, ON);
    expect(verdict).toMatchObject({ allowed: false, model: "claude-opus-4-8", privacy: "anonymized" });
    if (verdict.allowed) return;
    expect(verdict.message).toContain("private models only");
    expect(verdict.message).toContain('Venice does not mark "claude-opus-4-8" as private');
    expect(verdict.message).toContain("nothing was charged");
    const { log } = jest.requireMock("@/lib/logger");
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      failureType: "managed_venice_private_only_refused", proxyKeyId: "key-1", userId: "u1", model: "claude-opus-4-8", privacy: "anonymized",
    }));
  });

  it("refuses anonymized media models too", async () => {
    veniceLists(LIST);
    for (const [endpoint, id] of [["/api/v1/audio/speech", "tts-elevenlabs-turbo-v2-5"], ["/api/v1/embeddings", "text-embedding-3-small"]]) {
      expect((await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: id, endpoint, source: "t" }, ON)).allowed).toBe(false);
    }
  });

  it("refuses a model nobody states as private, and an operation that names no model", async () => {
    veniceLists(LIST);
    const unknown = await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "venice-bg-remover", endpoint: "/api/v1/image/background-remove", source: "t" }, ON);
    expect(unknown).toMatchObject({ allowed: false, privacy: null });
    if (!unknown.allowed) expect(unknown.message).toContain('could not confirm that "venice-bg-remover" is a private model');
    expect((await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: null, endpoint: "/api/v1/video/transcriptions", source: "t" }, ON)).allowed).toBe(false);
    expect((await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "  ", endpoint: CHAT, source: "t" }, ON)).allowed).toBe(false);
  });

  it("knows Hivra's own label for the upscaler", async () => {
    veniceLists(LIST);
    expect(await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "venice-upscaler", endpoint: "/api/v1/image/upscale", source: "t" }, ON)).toEqual({ allowed: true });
  });

  it("leaves operations with no model behind them alone", async () => {
    const fetchMock = veniceLists(LIST);
    for (const endpoint of ["/api/v1/augment/search", "/api/v1/augment/scrape", "/api/v1/augment/text-parser", "/api/v1/audio/voices", "/api/v1/crypto/rpc/base"]) {
      expect(isModelFreeManagedVeniceEndpoint(endpoint)).toBe(true);
      expect(await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "venice-search-brave", endpoint, source: "t" }, ON)).toEqual({ allowed: true });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isModelFreeManagedVeniceEndpoint(CHAT)).toBe(false);
    expect(isModelFreeManagedVeniceEndpoint("/api/v1/image/generate")).toBe(false);
  });

  it("when Venice cannot be reached, still allows what Hivra's catalog states as private and refuses the rest", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    expect((await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "deepseek-v4-1-flash", endpoint: CHAT, source: "t" }, ON)).allowed).toBe(true);
    expect((await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "tts-kokoro", endpoint: "/api/v1/audio/speech", source: "t" }, ON)).allowed).toBe(false);
  });

  it("shortens a very long model name in the message", async () => {
    veniceLists(LIST);
    const verdict = await checkManagedVeniceAgentPrivateOnly({ key: KEY_ON, model: "x".repeat(500), endpoint: CHAT, source: "t" }, ON);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.model).toHaveLength(80);
  });
});

describe("managedVenicePrivateOnlyResponse", () => {
  // Not a 403: the off-Vercel Worker reads a 403 from authorize as its own secret being wrong.
  it("is a 400 in the OpenAI error shape that is never cached", async () => {
    const response = managedVenicePrivateOnlyResponse({ message: "nope" });
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { message: "nope", type: "invalid_request_error", param: "model", code: MANAGED_VENICE_PRIVATE_ONLY_CODE } });
  });
});

describe("managedVenicePrivateOnlyModelFilter", () => {
  it("is null (serve the whole list) when the flag or the setting is off", async () => {
    veniceLists(LIST);
    expect(await managedVenicePrivateOnlyModelFilter(KEY_ON, {})).toBeNull();
    expect(await managedVenicePrivateOnlyModelFilter(KEY_OFF, ON)).toBeNull();
  });

  it("keeps only models known to be private", async () => {
    veniceLists(LIST);
    const keep = await managedVenicePrivateOnlyModelFilter(KEY_ON, ON);
    expect(keep).not.toBeNull();
    expect(["kimi-k2-6", "claude-opus-4-8", "tts-kokoro", "venice-upscaler", "never-heard-of-it"].filter(id => keep!(id)))
      .toEqual(["kimi-k2-6", "tts-kokoro", "venice-upscaler"]);
  });
});
