/**
 * Regression: Venice must never run a managed media request that costs more
 * than Hivra charged for it.
 *
 * Second review of the spend gate found three ways it could:
 *   1. `nano-banana-2-edit` is priced by resolution on Venice (1K $0.10,
 *      2K $0.14, 4K $0.19) but the catalog charged a flat $0.10, so a 4K edit
 *      cost Hivra $0.19 and the user $0.10.
 *   2. A tier value the catalog didn't recognise (`scale: "3"`, `"4.0"`,
 *      `"04"`) was held at the top tier but charged at the cheapest, while
 *      Venice ran it as sent.
 *   3. Options Venice bills extra for (`enable_web_search`, `enhance_prompt`)
 *      were forwarded without being priced.
 * A third review found the other side of it: 4. the Hermes agent's image
 * plugin offers four models the catalog didn't price, so a paying user who
 * picked one got a 402 on every image. They are now priced at Venice's tiers.
 * These tests run the real routes and wallet code against an in-memory DB.
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
import { POST as audioSpeech } from "../audio/speech/route";
import { POST as augmentSearch } from "../augment/search/route";
import { POST as augmentScrape } from "../augment/scrape/route";
import { POST as passthrough } from "../[...path]/route";

const USER_ID = "user_billed_as_run_fixture";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const BASE = "https://hivra.test/api/managed-venice/v1";
const STARTING_BALANCE = 1_000_000; // $1.00

function jsonReq(path: string, body: unknown) {
  return new Request(`${BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function formReq(path: string, entries: Array<[string, string]>) {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  form.set("image", new Blob([new Uint8Array([4, 2])], { type: "image/png" }), "x.png");
  return new Request(`${BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer hven_live_fixture" },
    body: form,
  }) as unknown as NextRequest;
}

/** Call the catch-all the way Next does for `${suffix}`. */
function viaPassthrough(suffix: string, req: NextRequest) {
  return passthrough(req, { params: Promise.resolve({ path: suffix.split("/") }) });
}

function png() {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } });
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("managed-Venice media: Venice runs only what Hivra charged for", () => {
  const realFetch = global.fetch;
  const envBefore = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockMemory = createManagedVeniceSpendWorld();
    mockMemory.fundCard(USER_ID, STARTING_BALANCE);
    mockVerifyKey.mockResolvedValue({ id: KEY_ID, userId: USER_ID, status: "active", defaultWalletType: "card" });
    process.env.VENICE_API_KEY = "server-key-fixture";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED;
    delete process.env.MANAGED_VENICE_MULTIMODAL_MARKUP;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    fetchMock = jest.fn(async () => png());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...envBefore };
  });

  function charged() {
    const [reservation] = mockMemory.reservations();
    expect(reservation?.status).toBe("captured");
    const [usage] = mockMemory.usageEvents();
    expect(usage?.charged_micro_usd).toBe(reservation.captured_micro_usd);
    expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(STARTING_BALANCE - Number(reservation.captured_micro_usd));
    return Number(reservation.captured_micro_usd);
  }

  function sentForm(): FormData {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchMock.mock.calls[0][1].body;
    expect(body).toBeInstanceOf(FormData);
    return body as FormData;
  }

  function sentJson(): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
  }

  function refusedBeforeVenice(res: Response, status = 400) {
    expect(res.status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockMemory.reservations()).toHaveLength(0);
    expect(mockMemory.cardBalanceMicroUsd(USER_ID)).toBe(STARTING_BALANCE);
  }

  describe("finding 1: nano-banana-2-edit is billed by the resolution Venice runs", () => {
    it.each([
      ["4K", 190_000],
      ["2K", 140_000],
      ["1K", 100_000],
    ])("images/edit (multipart) at %s charges %i", async (resolution, expected) => {
      const res = await imagesEdit(
        formReq("images/edit", [["model", "nano-banana-2-edit"], ["prompt", "make it blue"], ["resolution", resolution]])
      );
      expect(res.status).toBe(200);
      expect(charged()).toBe(expected);
      expect(sentForm().get("resolution")).toBe(resolution);
    });

    it("the catch-all image/edit (JSON) at 4K charges $0.19", async () => {
      const res = await viaPassthrough(
        "image/edit",
        jsonReq("image/edit", { model: "nano-banana-2-edit", prompt: "make it blue", image: "aGk=", resolution: "4K" })
      );
      expect(res.status).toBe(200);
      expect(charged()).toBe(190_000);
      expect(sentJson().resolution).toBe("4K");
    });

    it("the agent's image_edit call (model picked for nano-banana-2) is billed at the tier it asked for", async () => {
      // tools/image_edit_tool.py: model, prompt, aspect_ratio, resolution, output_format + the image file.
      const res = await imagesEdit(
        formReq("images/edit", [
          ["model", "nano-banana-2-edit"],
          ["prompt", "move the subject left"],
          ["aspect_ratio", "16:9"],
          ["resolution", "2K"],
          ["output_format", "webp"],
        ])
      );
      expect(res.status).toBe(200);
      expect(charged()).toBe(140_000);
      const sent = sentForm();
      expect([...new Set(Array.from(sent.keys()))].sort()).toEqual(
        ["aspect_ratio", "image", "model", "output_format", "prompt", "resolution"].sort()
      );
    });

    it("no resolution is Venice's 1K default: held at 4K, charged at 1K", async () => {
      fetchMock.mockImplementationOnce(async () => {
        expect(mockMemory.reservations()[0].reserved_micro_usd).toBe(190_000);
        return png();
      });
      const res = await imagesEdit(formReq("images/edit", [["model", "nano-banana-2-edit"], ["prompt", "x"]]));
      expect(res.status).toBe(200);
      expect(charged()).toBe(100_000);
      expect(sentForm().get("resolution")).toBeNull();
    });
  });

  describe("finding 2: a tier value is billed as the tier Venice runs, or refused", () => {
    it.each([
      ["3", 80_000, "4"],
      ["4.0", 80_000, "4"],
      ["04", 80_000, "4"],
      ["4x", 80_000, "4"],
      ["2.0", 20_000, "2"],
      [" 2 ", 20_000, "2"],
    ])("images/upscale scale %j charges %i and forwards scale %j", async (scale, expected, forwarded) => {
      const res = await imagesUpscale(formReq("images/upscale", [["scale", scale]]));
      expect(res.status).toBe(200);
      expect(charged()).toBe(expected);
      expect(sentForm().getAll("scale")).toEqual([forwarded]);
    });

    it.each([
      [{ scale: "4.0" }, 80_000, 4],
      [{ scale: 3 }, 80_000, 4],
      [{ scale: "3" }, 80_000, 4],
      [{ scale: 2 }, 20_000, 2],
    ])("the catch-all image/upscale (JSON) %j charges %i and forwards scale %j", async (fields, expected, forwarded) => {
      const res = await viaPassthrough("image/upscale", jsonReq("image/upscale", { image: "aGk=", ...fields }));
      expect(res.status).toBe(200);
      expect(charged()).toBe(expected);
      expect(sentJson().scale).toBe(forwarded);
    });

    it("the catch-all image/upscale (multipart) scale 3 charges the 4x tier", async () => {
      const res = await viaPassthrough("image/upscale", formReq("image/upscale", [["scale", "3"]]));
      expect(res.status).toBe(200);
      expect(charged()).toBe(80_000);
      expect(sentForm().getAll("scale")).toEqual(["4"]);
    });

    it.each(["1", "0", "-4", "5", "4.5", "banana", "Infinity", "NaN", "true"])(
      "images/upscale scale %j is refused before any hold",
      async (scale) => {
        refusedBeforeVenice(await imagesUpscale(formReq("images/upscale", [["scale", scale]])));
      }
    );

    it.each([{ scale: 1 }, { scale: 8 }, { scale: true }, { scale: "big" }])(
      "the catch-all image/upscale (JSON) %j is refused before any hold",
      async (fields) => {
        refusedBeforeVenice(await viaPassthrough("image/upscale", jsonReq("image/upscale", { image: "aGk=", ...fields })));
      }
    );

    it.each([
      ["4k", 190_000, "4K"],
      [" 2K ", 140_000, "2K"],
      ["1k", 100_000, "1K"],
    ])("images/generate nano-banana-2 resolution %j charges %i and forwards %j", async (resolution, expected, forwarded) => {
      fetchMock.mockResolvedValueOnce(okJson({ id: "req_fixture", images: ["b64"] }));
      const res = await imagesGenerate(jsonReq("images/generate", { model: "nano-banana-2", prompt: "a cat", resolution }));
      expect(res.status).toBe(200);
      expect(charged()).toBe(expected);
      expect(sentJson().resolution).toBe(forwarded);
    });

    it.each(["8K", "0.5K", "4096", "4 K", "high"])(
      "images/generate nano-banana-2 resolution %j is refused before any hold",
      async (resolution) => {
        refusedBeforeVenice(
          await imagesGenerate(jsonReq("images/generate", { model: "nano-banana-2", prompt: "a cat", resolution }))
        );
      }
    );

    it("a numeric resolution is refused before any hold", async () => {
      refusedBeforeVenice(
        await imagesGenerate(jsonReq("images/generate", { model: "nano-banana-2", prompt: "a cat", resolution: 4 }))
      );
    });

    it("the catch-all image/generate refuses an unknown resolution", async () => {
      refusedBeforeVenice(
        await viaPassthrough(
          "image/generate",
          jsonReq("image/generate", { model: "nano-banana-2", prompt: "a cat", resolution: "8K" })
        )
      );
    });

    it("images/edit nano-banana-2-edit refuses an unknown resolution", async () => {
      refusedBeforeVenice(
        await imagesEdit(formReq("images/edit", [["model", "nano-banana-2-edit"], ["prompt", "x"], ["resolution", "8K"]]))
      );
    });

    it("a flat-priced model keeps its resolution untouched", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ id: "req_fixture", images: ["b64"] }));
      const res = await imagesGenerate(jsonReq("images/generate", { model: "qwen-image-2", prompt: "a cat", resolution: "2K" }));
      expect(res.status).toBe(200);
      expect(charged()).toBe(50_000);
      expect(sentJson().resolution).toBe("2K");
    });
  });

  describe("finding 3: options Venice bills extra for are refused, and only known fields are forwarded", () => {
    const generate = (extra: Record<string, unknown>) =>
      jsonReq("images/generate", { model: "nano-banana-2", prompt: "a cat", resolution: "1K", ...extra });

    it.each<[string, Record<string, unknown>]>([
      ["enable_web_search: true", { enable_web_search: true }],
      ["enable_web_search: 'true'", { enable_web_search: "true" }],
      ["enable_web_search: 1", { enable_web_search: 1 }],
      ["enhance_prompt: true", { enhance_prompt: true }],
      ["enhance_prompt: 'yes'", { enhance_prompt: "yes" }],
      ["quality: 'high'", { quality: "high" }],
      ["style_references", { style_references: [{ image: "https://example.com/ref.png" }] }],
    ])("images/generate with %s is refused before any hold", async (_label, extra) => {
      const res = await imagesGenerate(generate(extra));
      refusedBeforeVenice(res);
      const body = (await res.json()) as { error?: string | { message?: string } };
      expect(JSON.stringify(body)).toContain(Object.keys(extra)[0]);
    });

    it.each<[string, Record<string, unknown>]>([
      ["enable_web_search", { enable_web_search: true }],
      ["enhance_prompt", { enhance_prompt: true }],
    ])("the catch-all image/generate with %s is refused before any hold", async (_label, extra) => {
      refusedBeforeVenice(await viaPassthrough("image/generate", generate(extra)));
    });

    it("images/edit (multipart) with enhance_prompt=true is refused before any hold", async () => {
      refusedBeforeVenice(
        await imagesEdit(
          formReq("images/edit", [["model", "nano-banana-2-edit"], ["prompt", "x"], ["enhance_prompt", "true"]])
        )
      );
    });

    it("the catch-all image/edit refuses enhance_prompt as JSON and as multipart", async () => {
      refusedBeforeVenice(
        await viaPassthrough(
          "image/edit",
          jsonReq("image/edit", { model: "firered-image-edit", prompt: "x", image: "aGk=", enhance_prompt: true })
        )
      );
      refusedBeforeVenice(
        await viaPassthrough(
          "image/edit",
          formReq("image/edit", [["model", "firered-image-edit"], ["prompt", "x"], ["enhance_prompt", "1"]])
        )
      );
    });

    it("the flags switched off are fine, and are not forwarded", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ id: "req_fixture", images: ["b64"] }));
      const res = await imagesGenerate(generate({ enable_web_search: false, enhance_prompt: "false", quality: null }));
      expect(res.status).toBe(200);
      expect(charged()).toBe(100_000);
      const sent = sentJson();
      expect(sent).not.toHaveProperty("enable_web_search");
      expect(sent).not.toHaveProperty("enhance_prompt");
      expect(sent).not.toHaveProperty("quality");
    });

    it("forwards the agent's image_generate payload unchanged", async () => {
      // plugins/image_gen/venice: _build_payload for a resolution-family model.
      const payload = {
        model: "nano-banana-2",
        prompt: "a lighthouse at dusk",
        safe_mode: true,
        format: "webp",
        return_binary: false,
        aspect_ratio: "16:9",
        resolution: "2K",
        negative_prompt: "blurry",
        style_preset: "Cinematic",
        seed: 42,
      };
      fetchMock.mockResolvedValueOnce(okJson({ id: "req_fixture", images: ["b64"] }));
      const res = await imagesGenerate(jsonReq("images/generate", payload));
      expect(res.status).toBe(200);
      expect(charged()).toBe(140_000);
      expect(sentJson()).toEqual(payload);
    });

    it("drops fields Venice doesn't document instead of forwarding them", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ id: "req_fixture", images: ["b64"] }));
      const res = await imagesGenerate(
        generate({ enable_x_search: true, some_future_billed_option: "on", inpaint: { strength: 50 } })
      );
      expect(res.status).toBe(200);
      expect(sentJson()).toEqual({ model: "nano-banana-2", prompt: "a cat", resolution: "1K" });
    });

    it("drops bracketed or unknown multipart field names", async () => {
      const res = await viaPassthrough(
        "image/edit",
        formReq("image/edit", [
          ["model", "firered-image-edit"],
          ["prompt", "x"],
          ["model[0]", "nano-banana-pro-edit"],
          ["resolution[]", "4K"],
        ])
      );
      expect(res.status).toBe(200);
      expect(charged()).toBe(40_000);
      expect([...new Set(Array.from(sentForm().keys()))].sort()).toEqual(["image", "model", "prompt"]);
    });

    it("upscale forwards only Venice's upscale fields", async () => {
      // tools/image_edit_tool.py image_upscale sends scale + enhance (+ legacy enhance options).
      const res = await imagesUpscale(
        formReq("images/upscale", [
          ["scale", "2"],
          ["enhance", "false"],
          ["replication", "0.350"],
          ["creativity", "0.01"],
        ])
      );
      expect(res.status).toBe(200);
      expect(charged()).toBe(20_000);
      const sent = sentForm();
      expect([...new Set(Array.from(sent.keys()))].sort()).toEqual(["creativity", "image", "scale"]);
    });

    it("audio/speech forwards the agent's Venice TTS payload unchanged and drops unknown fields", async () => {
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200, headers: { "Content-Type": "audio/mpeg" } }));
      const payload = { model: "tts-kokoro", input: "hello there", voice: "af_sky", response_format: "mp3", speed: 1, language: "en" };
      const res = await audioSpeech(jsonReq("audio/speech", { ...payload, voice_clone_sample: "aGk=" }));
      expect(res.status).toBe(200);
      expect(sentJson()).toEqual(payload);
    });

    it("augment/search and augment/scrape forward only their documented fields", async () => {
      fetchMock.mockResolvedValueOnce(okJson({ results: [] }));
      let res = await augmentSearch(
        jsonReq("augment/search", { query: "hivra", limit: 5, search_provider: "brave", pages: 10 })
      );
      expect(res.status).toBe(200);
      expect(sentJson()).toEqual({ query: "hivra", limit: 5, search_provider: "brave" });

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(okJson({ content: "# page" }));
      res = await augmentScrape(
        jsonReq("augment/scrape", { url: "https://example.com", urls: ["https://a.example", "https://b.example"] })
      );
      expect(res.status).toBe(200);
      expect(sentJson()).toEqual({ url: "https://example.com" });
    });
  });

  // Third review: the agent's image plugin offers nano-banana-pro,
  // gpt-image-2, venice-sd35 and grok-imagine-image next to qwen-image-2.
  // None was priced, so picking one was a 402 on every managed image.
  // Payloads are plugins/image_gen/venice _build_payload for each sizing
  // family, sent to image/generate on the catch-all like the agent does.
  describe("finding 4: the agent's image models are billed at the tier Venice runs, not refused", () => {
    const agentPayload = (model: string, sizing: Record<string, unknown>) => ({
      model,
      prompt: "a lighthouse at dusk",
      safe_mode: true,
      format: "webp",
      return_binary: false,
      ...sizing,
    });

    it.each<[string, Record<string, unknown>, number, number]>([
      ["qwen-image-2", { aspect_ratio: "16:9" }, 50_000, 50_000],
      ["grok-imagine-image", { aspect_ratio: "9:16" }, 40_000, 30_000],
      ["venice-sd35", { width: 1280, height: 720 }, 10_000, 10_000],
      ["nano-banana-pro", { aspect_ratio: "1:1", resolution: "1K" }, 180_000, 180_000],
      ["nano-banana-pro", { aspect_ratio: "1:1", resolution: "4K" }, 350_000, 350_000],
      ["gpt-image-2", { aspect_ratio: "1:1", resolution: "1K" }, 270_000, 270_000],
      ["gpt-image-2", { aspect_ratio: "16:9", resolution: "2K" }, 510_000, 510_000],
    ])("%s %j: held %i, charged %i, forwarded unchanged", async (model, sizing, held, expected) => {
      const payload = agentPayload(model, sizing);
      fetchMock.mockImplementationOnce(async () => {
        expect(mockMemory.reservations()[0].reserved_micro_usd).toBe(held);
        return okJson({ id: "req_fixture", images: ["b64"] });
      });
      const res = await viaPassthrough("image/generate", jsonReq("image/generate", payload));
      expect(res.status).toBe(200);
      expect(charged()).toBe(expected);
      expect(sentJson()).toEqual(payload);
    });

    it("gpt-image-2 with a quality setting is refused before any hold", async () => {
      refusedBeforeVenice(
        await viaPassthrough(
          "image/generate",
          jsonReq("image/generate", agentPayload("gpt-image-2", { resolution: "1K", quality: "high" }))
        )
      );
    });

    it("grok-imagine-image at 4K, a tier Venice doesn't publish for it, is refused before any hold", async () => {
      refusedBeforeVenice(
        await viaPassthrough(
          "image/generate",
          jsonReq("image/generate", agentPayload("grok-imagine-image", { resolution: "4K" }))
        )
      );
    });
  });
});
