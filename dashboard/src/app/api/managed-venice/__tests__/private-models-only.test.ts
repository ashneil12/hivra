/**
 * "Private models only": an agent whose owner turned the setting on can reach
 * only models Venice marks private, on every route its managed inference key
 * can call. A refusal must come before any wallet hold and before anything is
 * sent to Venice.
 *
 * Real authorize/reserve code against an in-memory wallet and a fake Venice.
 * The privacy of each model is fixed here so the tests do not depend on
 * Venice's live list.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceSpendWorld,
  type ManagedVeniceSpendWorld,
} from "@/test-utils/managed-venice-spend-world";
import { createWorstCaseVenice } from "@/test-utils/fake-venice-inference";
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
jest.mock("@/lib/venice/model-privacy-live", () => {
  const { venicePrivacyFor } = jest.requireActual("@/lib/venice/model-privacy");
  const media: Record<string, string> = {
    "text-embedding-3-small": "anonymized",
    "text-embedding-bge-m3": "private",
  };
  const lookup = (id: string) => media[id] ?? venicePrivacyFor(id);
  return {
    resolveVeniceModelPrivacy: jest.fn(async (id: string) => lookup(id)),
    getVeniceModelPrivacyLookup: jest.fn(async () => lookup),
  };
});
jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { POST as chat } from "../v1/chat/completions/route";
import { POST as responses } from "../v1/responses/route";
import { POST as anthropic } from "../anthropic/v1/messages/route";
import { POST as embeddings } from "../v1/embeddings/route";
import { GET as models } from "../v1/models/route";
import { POST as internalAuthorize } from "../internal/authorize/route";

const USER_ID = "user_private_only_fixture";
const KEY_ID = "55555555-5555-4555-8555-555555555555";
const USD = 1_000_000;
const SECRET = "internal-secret-fixture";
// In Hivra's catalog: the first is private on Venice, the second is anonymized.
const PRIVATE = "deepseek-v4-1-flash";
const ANONYMIZED = "claude-opus-4-8";
const CODE = "managed_venice_private_models_only";

const post = (path: string, body: unknown, headers: Record<string, string> = { Authorization: "Bearer hven_live_fixture" }) =>
  new Request(`https://hivra.test/api/managed-venice/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

const chatBody = (model: string) => ({ model, messages: [{ role: "user", content: "hello" }], max_tokens: 16 });
const responsesBody = (model: string) => ({
  model,
  max_output_tokens: 16,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
});
const anthropicBody = (model: string) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] });

describe("private models only, on every managed route", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let venice: ReturnType<typeof createWorstCaseVenice>;

  function useKey(privateModelsOnly: boolean) {
    mockVerifyKey.mockResolvedValue({
      id: KEY_ID,
      userId: USER_ID,
      status: "active",
      defaultWalletType: "card",
      privateModelsOnly,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockMemory = createManagedVeniceSpendWorld();
    mockMemory.fundCard(USER_ID, 50 * USD);
    useKey(true);
    process.env.VENICE_API_KEY = "server-key-fixture";
    process.env.MANAGED_VENICE_INTERNAL_SECRET = SECRET;
    process.env.MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED = "true";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    venice = createWorstCaseVenice();
    global.fetch = venice.fetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  function expectNothingHeldOrSent() {
    expect(mockMemory.reservations()).toHaveLength(0);
    expect(venice.calls).toHaveLength(0);
  }

  it("chat: refuses an anonymized model with a 400, before any hold or upstream call", async () => {
    const res = await chat(post("v1/chat/completions", chatBody(ANONYMIZED)));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; type: string; param: string; message: string } };
    expect(json.error).toMatchObject({ code: CODE, type: "invalid_request_error", param: "model" });
    expect(json.error.message).toContain(`Venice does not mark "${ANONYMIZED}" as private`);
    expectNothingHeldOrSent();
  });

  it("chat: a private model goes through as usual", async () => {
    const res = await chat(post("v1/chat/completions", chatBody(PRIVATE)));
    expect(res.status).toBe(200);
    expect(venice.calls).toHaveLength(1);
    expect(venice.calls[0].body.model).toBe(PRIVATE);
  });

  it("Responses: refuses an anonymized model before any hold", async () => {
    const res = await responses(post("v1/responses", responsesBody(ANONYMIZED)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(CODE);
    expectNothingHeldOrSent();
  });

  // The Worker relays a 400 from authorize to the agent as it is. It would
  // turn a 403 into a 502 "proxy misconfigured", so the refusal must not be one.
  it("the off-Vercel Worker's authorize call is refused the same way, with a status the Worker relays", async () => {
    const res = await internalAuthorize(post(
      "internal/authorize",
      { plaintextKey: "hven_live_fixture", body: chatBody(ANONYMIZED), acceptsBodyPatch: true },
      { "x-managed-venice-internal-secret": SECRET },
    ));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(CODE);
    expectNothingHeldOrSent();
  });

  it("Anthropic format: refuses an anonymized model with a permission error", async () => {
    const res = await anthropic(post("anthropic/v1/messages", anthropicBody(ANONYMIZED), { "x-api-key": "hven_live_fixture" }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(json).toMatchObject({ type: "error", error: { type: "permission_error" } });
    expect(json.error.message).toContain("private models only");
    expectNothingHeldOrSent();
  });

  it("Anthropic format: a private model goes through", async () => {
    const res = await anthropic(post("anthropic/v1/messages", anthropicBody(PRIVATE), { "x-api-key": "hven_live_fixture" }));
    expect(res.status).toBe(200);
    expect(venice.calls).toHaveLength(1);
  });

  it("media: refuses an anonymized embedding model before any hold", async () => {
    const res = await embeddings(post("v1/embeddings", { model: "text-embedding-3-small", input: "hello" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(CODE);
    expectNothingHeldOrSent();
  });

  it("the model list the agent sees holds private models only", async () => {
    const list = async () => {
      const res = await models(new Request("https://hivra.test/api/managed-venice/v1/models", {
        headers: { Authorization: "Bearer hven_live_fixture" },
      }) as unknown as NextRequest);
      return ((await res.json()) as { data: Array<{ id: string; model_spec: { privacy: string } }> }).data;
    };
    const restricted = await list();
    expect(restricted.length).toBeGreaterThan(10);
    expect(restricted.some((m) => m.id === PRIVATE)).toBe(true);
    expect(restricted.some((m) => m.id === ANONYMIZED)).toBe(false);
    expect(restricted.every((m) => m.model_spec.privacy !== "anonymized")).toBe(true);

    useKey(false);
    const whole = await list();
    expect(whole.some((m) => m.id === ANONYMIZED)).toBe(true);
    expect(whole.length).toBeGreaterThan(restricted.length);
  });

  it("a per-type model list from Venice is narrowed the same way", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "text-embedding-bge-m3", type: "embedding" }, { id: "text-embedding-3-small", type: "embedding" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const res = await models(new Request("https://hivra.test/api/managed-venice/v1/models?type=embedding", {
      headers: { Authorization: "Bearer hven_live_fixture" },
    }) as unknown as NextRequest);
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(json.object).toBe("list");
    expect(json.data.map((m) => m.id)).toEqual(["text-embedding-bge-m3"]);
  });

  it("an agent without the setting is not restricted", async () => {
    useKey(false);
    const res = await chat(post("v1/chat/completions", chatBody(ANONYMIZED)));
    expect(res.status).toBe(200);
    expect(venice.calls[0].body.model).toBe(ANONYMIZED);
  });

  it("with the feature off, a stored setting restricts nothing and the model list is whole", async () => {
    delete process.env.MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED;
    const res = await chat(post("v1/chat/completions", chatBody(ANONYMIZED)));
    expect(res.status).toBe(200);
    const { resolveVeniceModelPrivacy } = jest.requireMock("@/lib/venice/model-privacy-live");
    expect(resolveVeniceModelPrivacy).not.toHaveBeenCalled();
    const listed = await models(new Request("https://hivra.test/api/managed-venice/v1/models", {
      headers: { Authorization: "Bearer hven_live_fixture" },
    }) as unknown as NextRequest);
    expect(((await listed.json()) as { data: Array<{ id: string }> }).data.some((m) => m.id === ANONYMIZED)).toBe(true);
  });
});
