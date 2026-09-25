/**
 * Regression: every paid managed-Venice media route must hold wallet funds
 * BEFORE it forwards to Venice with Hivra's upstream key.
 *
 * Before the spend gate, each of these routes verified the proxy key and then
 * called Venice straight away, so a free account with a $0 wallet could mint a
 * key and generate images/videos/audio on Hivra's Venice credits. These tests
 * run the real wallet code against an in-memory database.
 */
import { NextRequest } from "next/server";

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

import { POST as imagesGenerate } from "../images/generate/route";
import { POST as imagesEdit } from "../images/edit/route";
import { POST as imagesUpscale } from "../images/upscale/route";
import { POST as imagesMultiEdit } from "../images/multi-edit/route";
import { POST as imagesBackgroundRemove } from "../images/background-remove/route";
import { POST as videosQueue } from "../videos/queue/route";
import { POST as audioQueue } from "../audio/queue/route";
import { POST as audioSpeech } from "../audio/speech/route";
import { POST as audioTranscriptions } from "../audio/transcriptions/route";
import { POST as embeddings } from "../embeddings/route";
import { POST as augmentSearch } from "../augment/search/route";
import { POST as augmentScrape } from "../augment/scrape/route";

const USER_ID = "user_spend_gate_fixture";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const BASE = "https://hivra.test/api/managed-venice/v1";

type Handler = (req: NextRequest) => Promise<Response>;

function jsonReq(path: string, body: unknown) {
  return new Request(`${BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Multipart with repeatable entries, so a test can send a field twice. */
function entriesReq(path: string, entries: Array<[string, string | Blob]>, fileField = "image") {
  const form = new FormData();
  for (const [name, value] of entries) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, `${name}.bin`);
  }
  form.set(fileField, new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "x.png");
  return new Request(`${BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture" },
    body: form,
  }) as unknown as NextRequest;
}

function formReq(path: string, fields: Record<string, string>, fileField = "image") {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  form.set(fileField, new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "x.png");
  return new Request(`${BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture" },
    body: form,
  }) as unknown as NextRequest;
}

const PAID_ROUTES: Array<[string, Handler, () => NextRequest]> = [
  ["images/generate", imagesGenerate, () => jsonReq("images/generate", { model: "qwen-image-2", prompt: "a cat" })],
  ["images/edit", imagesEdit, () => formReq("images/edit", { model: "firered-image-edit", prompt: "make it blue" })],
  ["images/upscale", imagesUpscale, () => formReq("images/upscale", { scale: "2" })],
  [
    "images/multi-edit",
    imagesMultiEdit,
    () => jsonReq("images/multi-edit", { modelId: "firered-image-edit", prompt: "merge", images: ["aGk="] }),
  ],
  [
    "images/background-remove",
    imagesBackgroundRemove,
    () => jsonReq("images/background-remove", { image_url: "https://example.com/x.png" }),
  ],
  ["videos/queue", videosQueue, () => jsonReq("videos/queue", { model: "wan-2.5-preview-text-to-video", prompt: "waves", duration: "5s" })],
  ["audio/queue", audioQueue, () => jsonReq("audio/queue", { model: "elevenlabs-music", prompt: "calm piano" })],
  ["audio/speech", audioSpeech, () => jsonReq("audio/speech", { model: "tts-kokoro", input: "hello there", voice: "af_sky" })],
  ["audio/transcriptions", audioTranscriptions, () => formReq("audio/transcriptions", { model: "whisper-1" }, "file")],
  ["embeddings", embeddings, () => jsonReq("embeddings", { model: "text-embedding-bge-m3", input: "hello" })],
  ["augment/search", augmentSearch, () => jsonReq("augment/search", { query: "hivra" })],
  ["augment/scrape", augmentScrape, () => jsonReq("augment/scrape", { url: "https://example.com" })],
];

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("managed-Venice paid media routes: hold before forward", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let fetchMock: jest.Mock;

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
    delete process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED;
    delete process.env.MANAGED_VENICE_MULTIMODAL_MARKUP;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    fetchMock = jest.fn(async () => okJson({ id: "req_fixture", images: ["b64"] }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  it.each(PAID_ROUTES)("%s: a $0-balance key gets 402 and Venice is never called", async (_path, handler, build) => {
    const res = await handler(build());

    expect(res.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockMemory.reservations()).toHaveLength(0);
    expect(mockMemory.usageEvents()).toHaveLength(0);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(typeof body.error?.message).toBe("string");
  });

  it.each(PAID_ROUTES)("%s: the billing-off flag does not open the gate for a $0 wallet", async (_path, handler, build) => {
    process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "false";
    const res = await handler(build());
    expect(res.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("images/generate with a funded card wallet", () => {
    beforeEach(() => {
      mockMemory.fundCard(USER_ID, 1_000_000); // $1.00
    });

    it.each([
      ["unset", undefined],
      ["false", "false"],
    ])(
      "holds the estimate before forwarding, then charges the catalog price with the billing flag %s",
      async (_label, flag) => {
        if (flag !== undefined) process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = flag;
        fetchMock.mockImplementationOnce(async () => {
          // The hold must already exist when Venice is called.
          const active = mockMemory.reservations().filter((row) => row.status === "active");
          expect(active).toHaveLength(1);
          expect(active[0].reserved_micro_usd).toBe(50_000);
          return okJson({ id: "req_fixture", images: ["b64"] });
        });

        const res = await imagesGenerate(jsonReq("images/generate", { model: "qwen-image-2", prompt: "a cat" }));

        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [reservation] = mockMemory.reservations();
        expect(reservation.status).toBe("captured");
        expect(reservation.captured_micro_usd).toBe(50_000);
        expect(reservation.endpoint).toBe("/api/v1/image/generate");
        const [usage] = mockMemory.usageEvents();
        expect(usage.status).toBe("recorded");
        expect(usage.charged_micro_usd).toBe(50_000);
        expect(usage.reference_id).toBe(reservation.reference_id);
        expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(950_000);
      }
    );

    it("captures the priced charge in-request when multimodal billing is on", async () => {
      process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";

      const res = await imagesGenerate(jsonReq("images/generate", { model: "qwen-image-2", prompt: "a cat", variants: 2 }));

      expect(res.status).toBe(200);
      const [reservation] = mockMemory.reservations();
      expect(reservation.status).toBe("captured");
      expect(reservation.reserved_micro_usd).toBe(100_000);
      expect(reservation.captured_micro_usd).toBe(100_000);
      const [usage] = mockMemory.usageEvents();
      expect(usage.status).toBe("recorded");
      expect(usage.charged_micro_usd).toBe(100_000);
      expect(usage.actual_cost_micro_usd).toBe(100_000);
      expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(900_000);
      const events = mockMemory.tables.managed_venice_financial_events;
      expect(events.map((row) => row.event_type)).toEqual(["usage_capture"]);
      expect(events[0].amount_micro_usd).toBe(100_000);
    });

    it("refuses when the wallet cannot cover the conservative estimate", async () => {
      // 6 x $0.19 (4K) = $1.14 > the $1.00 balance.
      const res = await imagesGenerate(
        jsonReq("images/generate", { model: "nano-banana-2", prompt: "a cat", variants: 6, resolution: "4K" })
      );
      expect(res.status).toBe(402);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });

    it("holds an unrecorded tier at its most expensive price but charges the published floor", async () => {
      process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";
      fetchMock.mockImplementationOnce(async () => {
        expect(mockMemory.reservations()[0].reserved_micro_usd).toBe(190_000);
        return okJson({ id: "req_fixture", images: ["b64"] });
      });

      const res = await imagesGenerate(jsonReq("images/generate", { model: "nano-banana-2", prompt: "a cat" }));

      expect(res.status).toBe(200);
      const [reservation] = mockMemory.reservations();
      expect(reservation.captured_micro_usd).toBe(100_000);
      expect(reservation.released_micro_usd).toBe(90_000);
      expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(900_000);
    });

    it("releases the hold when Venice returns an error", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ error: "boom" }, 500));

      const res = await imagesGenerate(jsonReq("images/generate", { model: "qwen-image-2", prompt: "a cat" }));

      expect(res.status).toBe(500);
      const [reservation] = mockMemory.reservations();
      expect(reservation.status).toBe("released");
      expect(mockMemory.usageEvents()).toHaveLength(0);
      expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(1_000_000);
    });

    it("releases the hold when the Venice request throws", async () => {
      process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";
      fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

      const res = await imagesGenerate(jsonReq("images/generate", { model: "qwen-image-2", prompt: "a cat" }));

      expect(res.status).toBe(502);
      const [reservation] = mockMemory.reservations();
      expect(reservation.status).toBe("released");
      expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(1_000_000);
    });

    it("fails closed for a model with no known price, even with funds", async () => {
      const res = await imagesGenerate(jsonReq("images/generate", { model: "some-new-model", prompt: "a cat" }));
      expect(res.status).toBe(402);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });
  });

  // Review finding: with the billing flag off, a successful request released
  // its hold, so one small top-up bought unlimited media on Hivra's key.
  it("a $0.05 card wallet gets one $0.05 image, then 402s: one top-up does not buy unlimited media", async () => {
    mockMemory.fundCard(USER_ID, 50_000);
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await imagesGenerate(jsonReq("images/generate", { model: "qwen-image-2", prompt: `cat ${i}` }));
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(200);
    expect(new Set(statuses.slice(1))).toEqual(new Set([402]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(0);
  });

  // Review finding: the dedicated multipart routes priced the FIRST copy of a
  // repeated field (formData.get) but forwarded every copy, and ignored the
  // deprecated `modelId` alias, so Venice could run a different model or tier
  // than the one held.
  describe("the request Hivra prices is the request Venice receives", () => {
    beforeEach(() => {
      mockMemory.fundCard(USER_ID, 1_000_000);
    });

    it.each<[string, Handler, Array<[string, string | Blob]>]>([
      ["images/upscale scale twice", imagesUpscale, [["scale", "2"], ["scale", "4"]]],
      ["images/upscale enhance twice", imagesUpscale, [["scale", "2"], ["enhance", "false"], ["enhance", "true"]]],
      ["images/upscale scale as a file", imagesUpscale, [["scale", new Blob(["4"])]]],
      [
        "images/edit model twice",
        imagesEdit,
        [["prompt", "x"], ["model", "firered-image-edit"], ["model", "nano-banana-2-edit"]],
      ],
      [
        "images/edit model vs modelId",
        imagesEdit,
        [["prompt", "x"], ["model", "firered-image-edit"], ["modelId", "nano-banana-pro-edit"]],
      ],
      ["images/edit modelId twice", imagesEdit, [["prompt", "x"], ["modelId", "seedream-v4-edit"], ["modelId", "nano-banana-pro-edit"]]],
      ["images/edit resolution twice", imagesEdit, [["prompt", "x"], ["resolution", "1K"], ["resolution", "4K"]]],
      ["images/edit model as a file", imagesEdit, [["prompt", "x"], ["model", new Blob(["nano-banana-pro-edit"])]]],
    ])("%s is refused with 400 before any hold or fetch", async (_label, handler, entries) => {
      const res = await handler(entriesReq(_label.split(" ")[0], entries));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });

    it("images/edit prices the model named by modelId when model is absent", async () => {
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/png" } }));
      const res = await imagesEdit(entriesReq("images/edit", [["prompt", "x"], ["modelId", "seedream-v4-edit"]]));
      expect(res.status).toBe(200);
      const [reservation] = mockMemory.reservations();
      expect(reservation.model).toBe("seedream-v4-edit");
      expect(reservation.reserved_micro_usd).toBe(50_000);
    });

    it("images/edit refuses a modelId the catalog can't price instead of pricing the default model", async () => {
      const res = await imagesEdit(entriesReq("images/edit", [["prompt", "x"], ["modelId", "nano-banana-pro-edit"]]));
      expect(res.status).toBe(402);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("images/upscale forwards exactly the one scale it priced", async () => {
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/png" } }));
      const res = await imagesUpscale(entriesReq("images/upscale", [["scale", "4"]]));
      expect(res.status).toBe(200);
      const sent = fetchMock.mock.calls[0][1].body as FormData;
      expect(sent.getAll("scale")).toEqual(["4"]);
      expect(mockMemory.reservations()[0].reserved_micro_usd).toBe(80_000);
    });

    it.each<[string, Handler, () => NextRequest]>([
      [
        "images/generate",
        imagesGenerate,
        () => jsonReq("images/generate", { model: "qwen-image-2", modelId: "nano-banana-2", prompt: "a cat" }),
      ],
      [
        "images/multi-edit",
        imagesMultiEdit,
        () => jsonReq("images/multi-edit", { model: "nano-banana-2-edit", modelId: "firered-image-edit", prompt: "x", images: ["aGk="] }),
      ],
      [
        "images/generate",
        imagesGenerate,
        () => jsonReq("images/generate", { model: "qwen-image-2", prompt: "a cat", variants: [4] }),
      ],
      [
        "images/generate",
        imagesGenerate,
        () => jsonReq("images/generate", { model: "nano-banana-2", prompt: "a cat", resolution: { tier: "4K" } }),
      ],
    ])("%s refuses a JSON body whose pricing fields disagree or aren't plain values", async (_path, handler, build) => {
      const res = await handler(build());
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockMemory.reservations()).toHaveLength(0);
    });
  });

  it("videos/queue fails closed while video has no list price, even for a funded wallet", async () => {
    mockMemory.fundCard(USER_ID, 50_000_000);
    const res = await videosQueue(jsonReq("videos/queue", { model: "wan-2.5-preview-text-to-video", prompt: "waves" }));
    expect(res.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("audio/speech holds by input length and captures the TTS charge when billing is on", async () => {
    process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED = "true";
    mockMemory.fundHermesos(USER_ID, 1_000_000);
    mockVerifyKey.mockResolvedValue({ id: KEY_ID, userId: USER_ID, status: "active", defaultWalletType: "hermesos" });
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([9, 9]), { status: 200, headers: { "Content-Type": "audio/mpeg" } }));

    const input = "x".repeat(10_000); // 10k chars x $3.50 / 1M = $0.035
    const res = await audioSpeech(jsonReq("audio/speech", { model: "tts-kokoro", input, voice: "af_sky" }));

    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([9, 9]);
    const [reservation] = mockMemory.reservations();
    expect(reservation.status).toBe("captured");
    expect(reservation.captured_micro_usd).toBe(35_000);
    expect(mockMemory.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(965_000);
  });
});
