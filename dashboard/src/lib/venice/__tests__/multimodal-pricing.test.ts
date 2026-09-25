import {
  VENICE_MULTIMODAL_PRICES,
  applyVeniceMultimodalMarkup,
  computeVeniceMultimodalCost,
  computeVeniceMultimodalHoldCost,
  resolveVeniceMultimodalMarkup,
  resolveVeniceMultimodalPrice,
  resolveVeniceMultimodalTier,
  veniceMultimodalTierRequestValue,
} from "@/lib/venice/multimodal-pricing";

// Ground truth: every distinct (endpoint, model) pair observed in prod
// `managed_venice_usage_events` with status='reconciliation_required'
// (snapshot 2026-07-08, 237 rows / 12 users). The catalog must either price
// a key or DELIBERATELY skip it — silently unclassified real usage is how the
// F176 leak stays open. When a new key shows up in prod, add it here and
// decide which bucket it belongs in.
const REAL_PROD_USAGE_KEYS: Array<{
  endpoint: string;
  model: string;
  classification: "priced" | "unpriced_operation";
  // Metadata shaped like the real rows for that key.
  metadata?: Record<string, unknown>;
}> = [
  // Priced — image generation.
  {
    endpoint: "/api/v1/image/generate",
    model: "qwen-image-2",
    classification: "priced",
  },
  {
    endpoint: "/api/v1/image/generate",
    model: "nano-banana-2",
    classification: "priced",
  },
  // Priced — image editing.
  {
    endpoint: "/api/v1/image/edit",
    model: "seedream-v4-edit",
    classification: "priced",
  },
  {
    endpoint: "/api/v1/image/edit",
    model: "nano-banana-2-edit",
    classification: "priced",
  },
  {
    endpoint: "/api/v1/image/edit",
    model: "firered-image-edit",
    classification: "priced",
  },
  // Priced — TTS (real rows always carry inputLength; the dedicated route
  // records it whenever the request body is well-formed).
  {
    endpoint: "/api/v1/audio/speech",
    model: "tts-kokoro",
    classification: "priced",
    metadata: { inputLength: 235, voice: "af_sky" },
  },
  // Deliberately unpriced — no published Venice list price.
  {
    endpoint: "/api/v1/augment/text-parser",
    model: "passthrough:augment/text-parser",
    classification: "unpriced_operation",
  },
  {
    endpoint: "/api/v1/crypto/rpc/base-mainnet",
    model: "passthrough:crypto/rpc/base-mainnet",
    classification: "unpriced_operation",
  },
  // Deliberately unpriced — Venice video pricing is variable (quote API only).
  {
    endpoint: "/api/v1/video/queue",
    model: "seedance-2-0-fast-image-to-video",
    classification: "unpriced_operation",
  },
  {
    endpoint: "/api/v1/video/queue",
    model: "wan-2-7-image-to-video",
    classification: "unpriced_operation",
  },
  {
    endpoint: "/api/v1/video/queue",
    model: "happyhorse-1-0-text-to-video",
    classification: "unpriced_operation",
  },
  // Deliberately unpriced — STT is per audio second and rows carry no duration.
  {
    endpoint: "/api/v1/video/transcriptions",
    model: "passthrough:video/transcriptions",
    classification: "unpriced_operation",
  },
  // Deliberately unpriced — the request body's model was unparseable, so the
  // per-model edit price is unknowable.
  {
    endpoint: "/api/v1/image/edit",
    model: "passthrough:image/edit",
    classification: "unpriced_operation",
  },
];

describe("Venice multimodal price catalog", () => {
  it("prices or deliberately skips every operation key observed in prod", () => {
    for (const key of REAL_PROD_USAGE_KEYS) {
      const result = computeVeniceMultimodalCost({
        endpoint: key.endpoint,
        model: key.model,
        metadata: key.metadata ?? { path: key.endpoint.replace("/api/v1/", ""), method: "POST" },
      });
      if (key.classification === "priced") {
        expect(result).toMatchObject({ priced: true });
      } else {
        expect(result).toEqual({ priced: false, reason: "unpriced_operation" });
      }
    }
  });

  it("declares a unit and a positive integer list price on every entry", () => {
    for (const price of VENICE_MULTIMODAL_PRICES) {
      expect(["per_image", "per_million_characters", "per_request"]).toContain(price.unit);
      expect(Number.isInteger(price.microUsdPerUnit)).toBe(true);
      expect(price.microUsdPerUnit).toBeGreaterThan(0);
      if (price.tiers) {
        expect(price.tierMetadataKey).toBeDefined();
        const tierValues = Object.values(price.tiers);
        for (const value of tierValues) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
        }
        // The base rate must be the cheapest tier so an unrecorded tier
        // floors conservatively instead of overcharging.
        expect(price.microUsdPerUnit).toBe(Math.min(...tierValues));
      }
    }
  });

  it("never guesses at an unknown operation key", () => {
    expect(
      computeVeniceMultimodalCost({
        endpoint: "/api/v1/some/new/endpoint",
        model: "brand-new-model",
      })
    ).toEqual({ priced: false, reason: "unpriced_operation" });
    expect(resolveVeniceMultimodalPrice("/api/v1/image/generate", "unknown-image-model")).toBeNull();
  });

  it("bills images per image, honoring recorded variant counts", () => {
    const single = computeVeniceMultimodalCost({
      endpoint: "/api/v1/image/generate",
      model: "qwen-image-2",
      metadata: { path: "image/generate", method: "POST" },
    });
    expect(single).toMatchObject({
      priced: true,
      unit: "per_image",
      quantity: 1,
      listCostMicroUsd: 50_000, // $0.05
    });

    const multi = computeVeniceMultimodalCost({
      endpoint: "/api/v1/image/generate",
      model: "qwen-image-2",
      metadata: { variants: 3 },
    });
    expect(multi).toMatchObject({ priced: true, quantity: 3, listCostMicroUsd: 150_000 });
  });

  it("prices resolution tiers; an absent tier is Venice's default (the cheapest)", () => {
    const at4k = computeVeniceMultimodalCost({
      endpoint: "/api/v1/image/generate",
      model: "nano-banana-2",
      metadata: { resolution: "4K" },
    });
    expect(at4k).toMatchObject({ priced: true, tier: "4k", listCostMicroUsd: 190_000 });

    const at2k = computeVeniceMultimodalCost({
      endpoint: "/api/v1/image/generate",
      model: "nano-banana-2",
      metadata: { resolution: "2k" },
    });
    expect(at2k).toMatchObject({ priced: true, tier: "2k", listCostMicroUsd: 140_000 });

    // No resolution sent: Venice runs its 1K default.
    for (const metadata of [{}, { resolution: null }, { resolution: " " }]) {
      const floored = computeVeniceMultimodalCost({
        endpoint: "/api/v1/image/generate",
        model: "nano-banana-2",
        metadata,
      });
      expect(floored).toMatchObject({ priced: true, tier: null, listCostMicroUsd: 100_000 });
    }

    // A resolution that isn't a published tier is never floored: Venice may
    // have run something dearer than the cheapest tier.
    expect(
      computeVeniceMultimodalCost({
        endpoint: "/api/v1/image/generate",
        model: "nano-banana-2",
        metadata: { resolution: "8K" },
      })
    ).toEqual({ priced: false, reason: "invalid_tier" });
  });

  // Second review: Venice's GET /models prices nano-banana-2-edit by
  // resolution; the catalog charged a flat $0.10 for a $0.19 4K edit.
  it("prices nano-banana-2-edit by resolution tier", () => {
    const edit = (metadata: Record<string, unknown>) =>
      computeVeniceMultimodalCost({ endpoint: "/api/v1/image/edit", model: "nano-banana-2-edit", metadata });
    expect(edit({ resolution: "4K" })).toMatchObject({ priced: true, tier: "4k", listCostMicroUsd: 190_000 });
    expect(edit({ resolution: "2K" })).toMatchObject({ priced: true, tier: "2k", listCostMicroUsd: 140_000 });
    expect(edit({ resolution: "1K" })).toMatchObject({ priced: true, tier: "1k", listCostMicroUsd: 100_000 });
    expect(edit({})).toMatchObject({ priced: true, tier: null, listCostMicroUsd: 100_000 });
  });

  // Second review: an unrecognised scale ("3", "4.0", "04") was held at 4x
  // but charged at 2x while Venice ran it as sent.
  it("maps an upscale factor to the published tier Venice bills, rounding up between tiers", () => {
    const upscale = (scale: unknown) =>
      computeVeniceMultimodalCost({ endpoint: "/api/v1/image/upscale", model: "venice-upscaler", metadata: { scale } });
    for (const scale of ["4", "4.0", "04", "4x", "4X", 4, "3", 3, 2.5, " 3 "]) {
      expect(upscale(scale)).toMatchObject({ priced: true, tier: "4", listCostMicroUsd: 80_000 });
    }
    for (const scale of ["2", "2.0", 2, "2x"]) {
      expect(upscale(scale)).toMatchObject({ priced: true, tier: "2", listCostMicroUsd: 20_000 });
    }
    for (const scale of ["1", 1, 0, -4, "5", 4.5, "banana", "Infinity", "NaN", true, ["4"], { v: 4 }]) {
      expect(upscale(scale)).toEqual({ priced: false, reason: "invalid_tier" });
    }
  });

  it("resolves tier request values the way Venice spells them", () => {
    const nano = resolveVeniceMultimodalPrice("/api/v1/image/generate", "nano-banana-2")!;
    const upscaler = resolveVeniceMultimodalPrice("/api/v1/image/upscale", "venice-upscaler")!;
    const qwen = resolveVeniceMultimodalPrice("/api/v1/image/generate", "qwen-image-2")!;

    expect(resolveVeniceMultimodalTier(nano, " 4k ")).toEqual({ kind: "tier", tier: "4k" });
    expect(resolveVeniceMultimodalTier(nano, 4)).toEqual({ kind: "invalid" });
    expect(resolveVeniceMultimodalTier(nano, "")).toEqual({ kind: "absent" });
    expect(resolveVeniceMultimodalTier(nano, undefined)).toEqual({ kind: "absent" });
    expect(veniceMultimodalTierRequestValue(nano, "4k")).toBe("4K");

    expect(resolveVeniceMultimodalTier(upscaler, "3")).toEqual({ kind: "tier", tier: "4" });
    expect(veniceMultimodalTierRequestValue(upscaler, "4")).toBe(4);

    // An entry without tiers ignores the field entirely.
    expect(resolveVeniceMultimodalTier(qwen, "8K")).toEqual({ kind: "absent" });
  });

  it("prices upscales by scale factor; no scale is Venice's 2x default", () => {
    // The upscale route records scale as a string form field.
    const fourX = computeVeniceMultimodalCost({
      endpoint: "/api/v1/image/upscale",
      model: "venice-upscaler",
      metadata: { scale: "4" },
    });
    expect(fourX).toMatchObject({ priced: true, tier: "4", listCostMicroUsd: 80_000 });

    const missingScale = computeVeniceMultimodalCost({
      endpoint: "/api/v1/image/upscale",
      model: "venice-upscaler",
      metadata: {},
    });
    expect(missingScale).toMatchObject({ priced: true, tier: null, listCostMicroUsd: 20_000 });
  });

  it("bills TTS per character count and refuses rows without one", () => {
    // Kokoro: $3.50 / 1M chars → 235 chars = ceil(235 × 3.5) = 823 µUSD.
    const priced = computeVeniceMultimodalCost({
      endpoint: "/api/v1/audio/speech",
      model: "tts-kokoro",
      metadata: { inputLength: 235 },
    });
    expect(priced).toMatchObject({
      priced: true,
      unit: "per_million_characters",
      quantity: 235,
      listCostMicroUsd: 823,
    });

    // A priced model with no derivable quantity is a SKIP, never a floor.
    const missing = computeVeniceMultimodalCost({
      endpoint: "/api/v1/audio/speech",
      model: "tts-kokoro",
      metadata: { voice: "af_sky" },
    });
    expect(missing).toEqual({ priced: false, reason: "missing_quantity" });
  });

  it("bills web search per request regardless of the recorded provider", () => {
    for (const provider of ["brave", "google", "anything-new"]) {
      const result = computeVeniceMultimodalCost({
        endpoint: "/api/v1/augment/search",
        model: provider,
        metadata: { queryLength: 30 },
      });
      expect(result).toMatchObject({
        priced: true,
        unit: "per_request",
        quantity: 1,
        listCostMicroUsd: 10_000, // $10 / 1K requests
      });
    }
  });

  it("applies markup with a never-round-to-zero ceiling", () => {
    expect(applyVeniceMultimodalMarkup(823, 1.0)).toBe(823);
    expect(applyVeniceMultimodalMarkup(823, 1.2)).toBe(988);
    expect(applyVeniceMultimodalMarkup(1, 1.0)).toBe(1);
    expect(() => applyVeniceMultimodalMarkup(-1, 1.0)).toThrow();
    expect(() => applyVeniceMultimodalMarkup(100, 0)).toThrow();
  });

  it("reads the markup factor from env with a safe 1.0 default", () => {
    expect(resolveVeniceMultimodalMarkup({})).toBe(1.0);
    expect(resolveVeniceMultimodalMarkup({ MANAGED_VENICE_MULTIMODAL_MARKUP: "1.5" })).toBe(1.5);
    expect(resolveVeniceMultimodalMarkup({ MANAGED_VENICE_MULTIMODAL_MARKUP: "0" })).toBe(1.0);
    expect(resolveVeniceMultimodalMarkup({ MANAGED_VENICE_MULTIMODAL_MARKUP: "-2" })).toBe(1.0);
    expect(resolveVeniceMultimodalMarkup({ MANAGED_VENICE_MULTIMODAL_MARKUP: "banana" })).toBe(1.0);
  });
});

describe("computeVeniceMultimodalHoldCost (pre-forward ceiling)", () => {
  const cost = (endpoint: string, model: string, metadata?: Record<string, unknown>) => {
    const result = computeVeniceMultimodalHoldCost({ endpoint, model, metadata });
    return result.priced ? result.listCostMicroUsd : result.reason;
  };

  it("never guesses an unpriced operation", () => {
    expect(cost("/api/v1/video/queue", "wan-2-7-image-to-video")).toBe("unpriced_operation");
    expect(cost("/api/v1/image/generate", "not-in-catalog")).toBe("unpriced_operation");
    expect(cost("/api/v1/crypto/rpc/base-mainnet", "passthrough:crypto/rpc")).toBe("unpriced_operation");
    expect(cost("/api/v1/audio/speech", "tts-kokoro", {})).toBe("missing_quantity");
  });

  it("holds an absent tier at the most expensive published tier and refuses an unpublished one", () => {
    expect(cost("/api/v1/image/generate", "nano-banana-2")).toBe(190_000);
    expect(cost("/api/v1/image/edit", "nano-banana-2-edit")).toBe(190_000);
    expect(cost("/api/v1/image/generate", "nano-banana-2", { resolution: "2K" })).toBe(140_000);
    expect(cost("/api/v1/image/upscale", "venice-upscaler", { scale: "3" })).toBe(80_000);
    expect(cost("/api/v1/image/upscale", "venice-upscaler", { scale: 2 })).toBe(20_000);
    expect(cost("/api/v1/image/generate", "nano-banana-2", { resolution: "8K" })).toBe("invalid_tier");
    expect(cost("/api/v1/image/upscale", "venice-upscaler", { scale: "1" })).toBe("invalid_tier");
  });

  it("rounds variant counts up and counts numeric strings", () => {
    expect(cost("/api/v1/image/generate", "qwen-image-2", { variants: 3 })).toBe(150_000);
    expect(cost("/api/v1/image/generate", "qwen-image-2", { variants: "4" })).toBe(200_000);
    expect(cost("/api/v1/image/generate", "qwen-image-2", { variants: 1.2 })).toBe(100_000);
    expect(cost("/api/v1/image/generate", "qwen-image-2", { variants: "lots" })).toBe(50_000);
  });

  it("is never below what settlement charges for the same request", () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["/api/v1/image/generate", "nano-banana-2", {}],
      ["/api/v1/image/generate", "nano-banana-2", { resolution: "4k", variants: 2 }],
      ["/api/v1/image/upscale", "venice-upscaler", { scale: "4x" }],
      ["/api/v1/image/upscale", "venice-upscaler", { scale: "3" }],
      ["/api/v1/image/upscale", "venice-upscaler", { scale: "4.0" }],
      ["/api/v1/image/upscale", "venice-upscaler", {}],
      ["/api/v1/image/edit", "nano-banana-2-edit", {}],
      ["/api/v1/image/edit", "nano-banana-2-edit", { resolution: "4K" }],
      ["/api/v1/audio/speech", "tts-kokoro", { inputLength: 12_345 }],
      ["/api/v1/augment/search", "venice-search-brave", {}],
    ];
    for (const [endpoint, model, metadata] of cases) {
      const hold = computeVeniceMultimodalHoldCost({ endpoint, model, metadata });
      const settled = computeVeniceMultimodalCost({ endpoint, model, metadata });
      expect(hold.priced && settled.priced).toBe(true);
      if (hold.priced && settled.priced) {
        expect(hold.listCostMicroUsd).toBeGreaterThanOrEqual(settled.listCostMicroUsd);
        // A tier that was sent is held and charged at the same tier.
        if (hold.tier !== null) expect(settled.tier).toBe(hold.tier);
      }
    }
  });
});
