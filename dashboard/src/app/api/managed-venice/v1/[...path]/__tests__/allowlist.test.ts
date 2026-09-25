/**
 * Regression: the managed-Venice catch-all may only forward an explicit
 * allowlist, and paid operations it forwards must hold wallet funds first.
 *
 * Before the allowlist, the catch-all forwarded ANY path and method to
 * api.venice.ai with Hivra's upstream key — including Venice account
 * management (api_keys, api_keys/rate_limits, billing) — and forwarded paid
 * generation (image/generate, video/queue, ...) with no balance check.
 */
import { NextRequest } from "next/server";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";

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

import { GET, POST } from "../route";

const USER_ID = "user_passthrough_fixture";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://hivra.test/api/managed-venice/v1/";
const matchCatchAll = getRouteMatcher(getRouteRegex("/api/managed-venice/v1/[...path]"));

function request(method: string, rawSuffix: string, body?: BodyInit, contentType = "application/json") {
  const headers: Record<string, string> = { Authorization: "Bearer hven_live_fixture" };
  if (body !== undefined && typeof body === "string") headers["Content-Type"] = contentType;
  return new Request(ORIGIN + rawSuffix, { method, headers, body }) as unknown as NextRequest;
}

function multipartRequest(suffix: string, entries: Array<[string, string | Blob]>) {
  const form = new FormData();
  for (const [name, value] of entries) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, `${name}.bin`);
  }
  form.set("image", new Blob([new Uint8Array([7, 7, 7])], { type: "image/png" }), "x.png");
  return new Request(ORIGIN + suffix, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture" },
    body: form,
  }) as unknown as NextRequest;
}

function rawRequest(suffix: string, body: string, contentType: string | null) {
  const headers: Record<string, string> = { Authorization: "Bearer hven_live_fixture" };
  if (contentType !== null) headers["Content-Type"] = contentType;
  const req = new Request(ORIGIN + suffix, { method: "POST", headers, body });
  // A string body makes fetch default the type to text/plain; drop it to test "no type".
  if (contentType === null) req.headers.delete("content-type");
  return req as unknown as NextRequest;
}

/** Segments exactly as Next decodes them for the catch-all. */
function segmentsFor(rawSuffix: string): string[] {
  const match = matchCatchAll("/api/managed-venice/v1/" + rawSuffix.split("?")[0]);
  if (!match) throw new Error(`catch-all did not match ${rawSuffix}`);
  return match.path as string[];
}

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

async function call(method: "GET" | "POST" | "HEAD", rawSuffix: string, body?: BodyInit, segments?: string[]) {
  const handler = method === "POST" ? POST : GET;
  return handler(request(method, rawSuffix, body), ctx(segments ?? segmentsFor(rawSuffix)));
}

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("/api/managed-venice/v1/[...path] allowlist", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockMemory = createManagedVeniceSpendWorld();
    mockVerifyKey.mockResolvedValue({ id: KEY_ID, userId: USER_ID, status: "active", defaultWalletType: "card" });
    process.env.VENICE_API_KEY = "server-key-fixture";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    fetchMock = jest.fn(async () => okJson({ ok: true }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  describe("Venice account management is never forwarded", () => {
    it.each([
      ["GET", "api_keys/rate_limits"],
      ["GET", "api_keys"],
      ["POST", "api_keys"],
      ["GET", "api_keys/rate_limits/log"],
      ["POST", "api_keys/generate_web3_key"],
      ["GET", "billing/usage"],
      ["GET", "billing/balance"],
      ["POST", "characters"],
      ["GET", "characters/some-slug"],
    ] as const)("%s %s is refused without calling Venice", async (method, suffix) => {
      const res = await call(method, suffix, method === "POST" ? JSON.stringify({ description: "x" }) : undefined);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });
  });

  describe("path tricks are rejected before any upstream call", () => {
    it.each([
      "api_keys%2Frate_limits",
      "API_KEYS/rate_limits",
      "Api_Keys",
      "image%2F..%2Fapi_keys",
      "image/%2e%2e/api_keys",
      "models%00",
      "image/generate%3B",
      "image/generate/extra",
      "image/styles/extra",
      "Image/Styles",
      "chat/Completions",
      "Chat/completions",
      "responses%2Fcompact",
      "embeddings%20",
      "image%5Cstyles",
    ])("%s", async (suffix) => {
      for (const method of ["GET", "POST"] as const) {
        const res = await call(method, suffix, method === "POST" ? "{}" : undefined);
        expect(res.status).toBe(404);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      [["image", "", "styles"]],
      [["", "image", "styles"]],
      [["image", "styles", ""]],
      [["image", ".", "styles"]],
      [["image", "..", "api_keys"]],
      [["image/../api_keys"]],
      [["image\\styles"]],
      [[]],
    ])("raw segments %j", async (segments) => {
      const res = await GET(request("GET", "image/styles"), ctx(segments));
      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an alternate method on an allowlisted GET path", async () => {
      const res = await call("POST", "image/styles", "{}");
      expect(res.status).toBe(404);
      const head = await GET(request("HEAD", "image/styles"), ctx(["image", "styles"]));
      expect(head.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses GET on a paid POST path", async () => {
      const res = await call("GET", "image/generate");
      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("allowlisted free paths still work", () => {
    it("GET image/styles forwards with the server key and bills nothing", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ data: ["Anime"] }));
      const res = await call("GET", "image/styles");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: ["Anime"] });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.venice.ai/api/v1/image/styles");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer server-key-fixture");
      expect(init.method).toBe("GET");
      expect(mockMemory.reservations()).toHaveLength(0);
      expect(mockMemory.usageEvents()).toHaveLength(0);
    });

    it("GET models keeps its query string", async () => {
      await call("GET", "models?type=video");
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.venice.ai/api/v1/models?type=video");
    });

    it.each(["video/retrieve", "audio/retrieve", "video/quote", "audio/quote"])(
      "POST %s is forwarded for a $0 wallet and not billed",
      async (suffix) => {
        const res = await call("POST", suffix, JSON.stringify({ queue_id: "q1", model: "m" }));
        expect(res.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe(`https://api.venice.ai/api/v1/${suffix}`);
        expect(fetchMock.mock.calls[0][1].method).toBe("POST");
        expect(mockMemory.reservations()).toHaveLength(0);
        expect(mockMemory.usageEvents()).toHaveLength(0);
      }
    );

    // The agent's venice_characters tool lists Venice's public personas with
    // GET {VENICE_BASE_URL}/characters (tools/venice_characters_tool.py).
    it("GET characters is forwarded and not billed", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ data: [{ name: "Fixture", slug: "fixture" }] }));
      const res = await call("GET", "characters");
      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.venice.ai/api/v1/characters");
      expect(fetchMock.mock.calls[0][1].method).toBe("GET");
      expect(mockMemory.reservations()).toHaveLength(0);
      expect(mockMemory.usageEvents()).toHaveLength(0);
    });

    it("GET crypto/rpc/networks is forwarded", async () => {
      const res = await call("GET", "crypto/rpc/networks");
      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.venice.ai/api/v1/crypto/rpc/networks");
    });

    it("still requires a valid proxy key", async () => {
      mockVerifyKey.mockResolvedValueOnce(null);
      const res = await call("GET", "image/styles");
      expect(res.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("paid operations need a wallet hold", () => {
    it.each([
      ["image/generate", JSON.stringify({ model: "qwen-image-2", prompt: "a cat" })],
      ["video/queue", JSON.stringify({ model: "wan-2.5-preview-text-to-video", prompt: "waves" })],
      ["image/multi-edit", JSON.stringify({ modelId: "firered-image-edit", prompt: "x", images: ["aGk="] })],
      ["image/background-remove", JSON.stringify({ image_url: "https://example.com/x.png" })],
      ["augment/text-parser", JSON.stringify({})],
      ["crypto/rpc/ethereum-mainnet", JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", id: 1 })],
    ])("a $0-balance key calling %s gets 402 and Venice is never called", async (suffix, body) => {
      const res = await call("POST", suffix, body);
      expect(res.status).toBe(402);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });

    it("a funded key reserves, forwards, then captures when billing is on", async () => {
      process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";
      mockMemory.fundCard(USER_ID, 1_000_000);
      fetchMock.mockImplementationOnce(async () => {
        expect(mockMemory.reservations().map((row) => row.status)).toEqual(["active"]);
        return okJson({ id: "req_1", images: ["b64"] });
      });

      const res = await call("POST", "image/generate", JSON.stringify({ model: "qwen-image-2", prompt: "a cat" }));

      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.venice.ai/api/v1/image/generate");
      const [reservation] = mockMemory.reservations();
      expect(reservation.status).toBe("captured");
      expect(reservation.captured_micro_usd).toBe(50_000);
      const [usage] = mockMemory.usageEvents();
      expect(usage.endpoint).toBe("/api/v1/image/generate");
      expect(usage.status).toBe("recorded");
      expect(usage.upstream_request_id).toBe("req_1");
      expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(950_000);
    });

    it("a multipart image/edit is priced from its form fields and forwarded as exactly those fields", async () => {
      mockMemory.fundCard(USER_ID, 1_000_000);
      const req = multipartRequest("image/edit", [
        ["model", "seedream-v4-edit"],
        ["prompt", "make it blue"],
      ]);
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "Content-Type": "image/png" } }));

      const res = await POST(req, ctx(["image", "edit"]));

      expect(res.status).toBe(200);
      const init = fetchMock.mock.calls[0][1];
      // Rebuilt from the parsed form: fetch writes its own boundary.
      expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      const sent = init.body as FormData;
      expect(sent).toBeInstanceOf(FormData);
      expect(sent.getAll("model")).toEqual(["seedream-v4-edit"]);
      expect(sent.get("prompt")).toBe("make it blue");
      const image = sent.get("image") as File;
      expect(image.name).toBe("x.png");
      expect(image.type).toBe("image/png");
      expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([7, 7, 7]);
      const [reservation] = mockMemory.reservations();
      expect(reservation.reserved_micro_usd).toBe(50_000);
      expect(reservation.model).toBe("seedream-v4-edit");
      expect(reservation.status).toBe("captured");
      expect(mockMemory.usageEvents()[0]).toMatchObject({ status: "recorded", charged_micro_usd: 50_000 });
    });

    it("a funded key is charged even with the billing flag off", async () => {
      mockMemory.fundCard(USER_ID, 1_000_000);
      const res = await call("POST", "image/generate", JSON.stringify({ model: "qwen-image-2", prompt: "a cat" }));
      expect(res.status).toBe(200);
      expect(mockMemory.reservations()[0]).toMatchObject({ status: "captured", captured_micro_usd: 50_000 });
      expect(mockMemory.usageEvents()[0]).toMatchObject({ status: "recorded", charged_micro_usd: 50_000 });
      expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(950_000);
    });

    it("upstream failure releases the hold", async () => {
      mockMemory.fundCard(USER_ID, 1_000_000);
      fetchMock.mockResolvedValueOnce(okJson({ error: "bad" }, 503));
      const res = await call("POST", "image/generate", JSON.stringify({ model: "qwen-image-2", prompt: "a cat" }));
      expect(res.status).toBe(503);
      expect(mockMemory.reservations()[0].status).toBe("released");
      expect(mockMemory.usageEvents()).toHaveLength(0);
    });
  });

  // Review finding: the passthrough priced the LAST copy of a repeated
  // multipart field and `model ?? modelId` / `modelId ?? model`, then
  // forwarded the original bytes, so Venice could run a different model or
  // tier than the one held.
  describe("the request Hivra prices is the request Venice receives", () => {
    beforeEach(() => {
      mockMemory.fundCard(USER_ID, 1_000_000);
    });

    it.each<[string, Array<[string, string | Blob]>]>([
      ["image/upscale", [["scale", "4"], ["scale", "2"]]],
      ["image/upscale", [["scale", "2"], ["enhance", "true"], ["enhance", "false"]]],
      ["image/edit", [["prompt", "x"], ["model", "firered-image-edit"], ["modelId", "nano-banana-pro-edit"]]],
      ["image/edit", [["prompt", "x"], ["model", "firered-image-edit"], ["model", "nano-banana-pro-edit"]]],
      ["image/edit", [["prompt", "x"], ["model", new Blob(["nano-banana-pro-edit"])]]],
      ["image/generate", [["prompt", "x"], ["model", "qwen-image-2"], ["variants", "1"], ["variants", "4"]]],
      ["image/generate", [["prompt", "x"], ["model", "nano-banana-2"], ["resolution", "1K"], ["resolution", "4K"]]],
      ["image/multi-edit", [["prompt", "x"], ["modelId", "firered-image-edit"], ["model", "nano-banana-2-edit"]]],
    ])("multipart %s %j is refused with 400 before any hold or fetch", async (suffix, entries) => {
      const res = await POST(multipartRequest(suffix, entries), ctx(suffix.split("/")));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });

    it.each([
      ["image/edit", { prompt: "x", model: "firered-image-edit", modelId: "nano-banana-pro-edit" }],
      ["image/multi-edit", { prompt: "x", modelId: "firered-image-edit", model: "nano-banana-2-edit", images: ["aGk="] }],
      ["image/generate", { prompt: "x", model: "qwen-image-2", modelId: "nano-banana-2" }],
      ["image/generate", { prompt: "x", model: "qwen-image-2", variants: [4] }],
      ["image/upscale", { image: "aGk=", scale: ["4"] }],
    ])("JSON %s %j is refused with 400 before any hold or fetch", async (suffix, body) => {
      const res = await call("POST", suffix, JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });

    it("a JSON body with a repeated key is forwarded as the one value that was priced", async () => {
      const raw = '{"model":"nano-banana-2","prompt":"a cat","model":"qwen-image-2"}';
      const res = await call("POST", "image/generate", raw);
      expect(res.status).toBe(200);
      const init = fetchMock.mock.calls[0][1];
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(typeof init.body).toBe("string");
      expect(init.body).not.toContain("nano-banana-2");
      expect(JSON.parse(init.body as string)).toEqual({ model: "qwen-image-2", prompt: "a cat" });
      expect(mockMemory.reservations()[0].model).toBe("qwen-image-2");
    });
  });

  // Review finding: a paid path with a body the passthrough couldn't parse
  // (urlencoded, text/plain JSON, broken JSON) was priced as if no fields were
  // sent — the default model — and then forwarded anyway.
  describe("paid paths need a body Hivra can read", () => {
    beforeEach(() => {
      mockMemory.fundCard(USER_ID, 1_000_000);
    });

    it.each([
      ["application/x-www-form-urlencoded", "model=nano-banana-pro-edit&prompt=x"],
      ["text/plain", JSON.stringify({ model: "nano-banana-pro-edit", prompt: "x" })],
      ["text/plain; x=application/json", JSON.stringify({ model: "nano-banana-pro-edit", prompt: "x" })],
      [null, JSON.stringify({ model: "nano-banana-pro-edit", prompt: "x" })],
    ])("image/edit with Content-Type %s is refused with 415", async (contentType, body) => {
      const res = await POST(rawRequest("image/edit", body, contentType), ctx(["image", "edit"]));
      expect(res.status).toBe(415);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });

    it.each([
      ["application/json", "{not json"],
      ["application/json", "[1, 2]"],
      ["application/json", "null"],
      ["application/json", ""],
      ["multipart/form-data; boundary=fixture", "not a multipart body"],
    ])("image/edit with %s body %j is refused with 400", async (contentType, body) => {
      const res = await POST(rawRequest("image/edit", body, contentType), ctx(["image", "edit"]));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });

    it("free POST paths still forward their body untouched", async () => {
      const body = "queue_id=q1";
      const res = await POST(rawRequest("audio/retrieve", body, "application/x-www-form-urlencoded"), ctx(["audio", "retrieve"]));
      expect(res.status).toBe(200);
      const init = fetchMock.mock.calls[0][1];
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
    });
  });
});
