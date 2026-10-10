import { MEDIA_REQUEST_POLICIES, planMediaRequest } from "@/lib/venice/media-request-fields";
import { VENICE_MULTIMODAL_PRICES } from "@/lib/venice/multimodal-pricing";

jest.mock("@/lib/logger", () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Venice must run only what the catalog priced. The request policies decide
// what is forwarded, so they have to cover every endpoint the catalog bills.
describe("managed-Venice media request policies", () => {
  it("has a request policy for every endpoint the price catalog bills", () => {
    const billed = new Set(VENICE_MULTIMODAL_PRICES.map((price) => price.endpoint));
    for (const endpoint of billed) {
      expect(MEDIA_REQUEST_POLICIES[endpoint]).toBeDefined();
    }
  });

  it("forwards every tier field the catalog prices by", () => {
    for (const price of VENICE_MULTIMODAL_PRICES) {
      if (!price.tierMetadataKey) continue;
      expect(MEDIA_REQUEST_POLICIES[price.endpoint].forward.has(price.tierMetadataKey)).toBe(true);
    }
  });

  it("never forwards an option it refuses as unpriced", () => {
    for (const policy of Object.values(MEDIA_REQUEST_POLICIES)) {
      for (const option of Object.keys(policy.unpricedOptions)) {
        expect(policy.forward.has(option)).toBe(false);
      }
    }
  });
});

describe("planMediaRequest", () => {
  it("rewrites a JSON tier to the value Venice spells and drops undocumented fields", () => {
    const plan = planMediaRequest({
      endpoint: "/api/v1/image/generate",
      model: "nano-banana-2",
      fields: { model: "nano-banana-2", prompt: "a cat", resolution: " 4k ", surprise: true },
      source: "test",
    });
    expect(plan).toEqual({
      ok: true,
      fields: { model: "nano-banana-2", prompt: "a cat", resolution: "4K" },
      dropped: ["surprise"],
    });
  });

  it("rebuilds a form with its file parts, the tier sent as charged, and nothing else", async () => {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array([7, 7])], { type: "image/png" }), "photo.png");
    form.append("scale", "3");
    form.append("enhance", "true");
    form.append("model[0]", "something-dearer");
    const plan = planMediaRequest({ endpoint: "/api/v1/image/upscale", model: "venice-upscaler", fields: form, source: "test" });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.fields).not.toBe(form);
    expect([...new Set(Array.from(plan.fields.keys()))].sort()).toEqual(["image", "scale"]);
    expect(plan.fields.getAll("scale")).toEqual(["4"]);
    const image = plan.fields.get("image") as File;
    expect(image.name).toBe("photo.png");
    expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([7, 7]);
    expect(plan.dropped.sort()).toEqual(["enhance", "model[0]"]);
  });

  it("leaves an absent tier absent (Venice's default is the cheapest tier)", () => {
    const plan = planMediaRequest({
      endpoint: "/api/v1/image/edit",
      model: "nano-banana-2-edit",
      fields: { model: "nano-banana-2-edit", prompt: "x", image: "aGk=", resolution: "" },
      source: "test",
    });
    expect(plan).toMatchObject({ ok: true, fields: { model: "nano-banana-2-edit", prompt: "x", image: "aGk=" } });
    if (plan.ok) expect(plan.fields).not.toHaveProperty("resolution");
  });

  it.each([
    ["/api/v1/image/upscale", "venice-upscaler", { scale: "1" }],
    ["/api/v1/image/upscale", "venice-upscaler", { scale: 6 }],
    ["/api/v1/image/generate", "nano-banana-2", { resolution: "8K" }],
    ["/api/v1/image/edit", "nano-banana-2-edit", { resolution: "4 K" }],
  ])("refuses %s %s %j: not a published tier", (endpoint, model, fields) => {
    const plan = planMediaRequest({ endpoint, model, fields: { model, ...fields }, source: "test" });
    expect(plan.ok).toBe(false);
  });

  it.each([
    ["/api/v1/image/generate", { enable_web_search: true }],
    ["/api/v1/image/generate", { enhance_prompt: "TRUE" }],
    ["/api/v1/image/generate", { quality: "low" }],
    ["/api/v1/image/generate", { style_references: [{ image: "https://example.com/a.png" }] }],
    ["/api/v1/image/edit", { enhance_prompt: 1 }],
  ])("refuses %s with an option Venice bills extra for: %j", (endpoint, extra) => {
    const plan = planMediaRequest({
      endpoint,
      model: "qwen-image-2",
      fields: { model: "qwen-image-2", prompt: "x", ...extra },
      source: "test",
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain(Object.keys(extra)[0]);
  });

  it("refuses an extra-cost option sent twice in a form if either copy is on", () => {
    const form = new FormData();
    form.append("prompt", "x");
    form.append("enhance_prompt", "false");
    form.append("enhance_prompt", "true");
    const plan = planMediaRequest({ endpoint: "/api/v1/image/edit", model: "firered-image-edit", fields: form, source: "test" });
    expect(plan.ok).toBe(false);
  });

  it("passes an endpoint without a policy through untouched (the gate refuses it as unpriced)", () => {
    const fields = { model: "some-video", prompt: "x", duration: "5s" };
    const plan = planMediaRequest({ endpoint: "/api/v1/video/queue", model: "some-video", fields, source: "test" });
    expect(plan).toEqual({ ok: true, fields, dropped: [] });
  });
});
