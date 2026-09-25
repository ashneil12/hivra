// In-code price source for managed-Venice MULTIMODAL (non-chat) usage.
//
// This is the table whose absence made MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED
// a structural no-op (F176): multimodal rows land in `managed_venice_usage_events`
// with cost 0 / status='reconciliation_required' and nothing could settle them.
// `settleManagedVeniceMultimodalUsage` (proxy-settlement.ts) now prices rows
// against this catalog when — and only when — the flag is on.
//
// PRICES ARE VENICE LIST PRICES, checked against https://docs.venice.ai/overview/pricing
// and Venice's GET /models pricing on VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT.
// Where the two disagree the catalog takes the higher price, so Venice can
// never bill Hivra more than Hivra charges. Same discipline as the chat
// catalog in pricing.ts: keep in lockstep with Venice, re-pull on any re-price.
// What we charge users is `list price × markup` (markup defaults to 1.0 —
// pass-through at cost — and is operator-tunable via
// MANAGED_VENICE_MULTIMODAL_MARKUP without a deploy).
//
// FAIL-SAFE CONTRACT (the invariant every consumer must preserve):
//   * An (endpoint, model) pair not in this catalog is NEVER guessed at.
//     `computeVeniceMultimodalCost` returns { priced: false, reason:
//     "unpriced_operation" } and the settlement pass skips the row, leaving it
//     `reconciliation_required` for offline/manual settlement.
//   * A priced operation whose unit quantity can't be derived from the usage
//     row's metadata (e.g. TTS with no recorded character count) returns
//     { priced: false, reason: "missing_quantity" } — skipped, never floored
//     to a guessed quantity.
//   * Tier-priced entries (image resolution, upscale factor) fall back to
//     their cheapest published tier only when the tier field is ABSENT, which
//     is what Venice runs by default (1K, 2x). A tier value that is present
//     but isn't a published tier is `invalid_tier`: the managed proxy refuses
//     the request before it reaches Venice, and settlement skips such a row
//     instead of charging a floor Venice may not have run
//     (resolveVeniceMultimodalTier).

export const VENICE_MULTIMODAL_PRICING_CATALOG_UPDATED_AT = "2026-09-25";

// Mirror of the chat catalog's staleness window (pricing.ts). Venice re-prices
// multimodal models more often than chat; anything older than this should be
// re-checked against docs.venice.ai before trusting a settlement run.
export const VENICE_MULTIMODAL_PRICING_CATALOG_MAX_AGE_DAYS = 30;

/**
 * Operator markup over Venice list price. 1.0 = bill users exactly what
 * Venice bills us. Ash decides the real margin later; changing it is an env
 * edit (MANAGED_VENICE_MULTIMODAL_MARKUP), not a code change.
 */
export const VENICE_MULTIMODAL_DEFAULT_MARKUP = 1.0;

export function resolveVeniceMultimodalMarkup(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.MANAGED_VENICE_MULTIMODAL_MARKUP?.trim();
  if (!raw) return VENICE_MULTIMODAL_DEFAULT_MARKUP;
  const parsed = Number(raw);
  // Reject nonsense (0, negatives, NaN, Infinity) rather than billing with it.
  if (!Number.isFinite(parsed) || parsed <= 0) return VENICE_MULTIMODAL_DEFAULT_MARKUP;
  return parsed;
}

/**
 * The billing unit of a priced multimodal operation. Every price in the
 * catalog states its unit here — a price without a unit is meaningless.
 */
export type VeniceMultimodalUnit =
  // One generated / edited / upscaled image. Quantity = metadata.variants
  // when the route recorded it (dedicated image routes do), else 1 — Venice's
  // own default variant count, so a floor, never an overcharge.
  | "per_image"
  // One million input characters (TTS). Quantity REQUIRES metadata.inputLength;
  // rows without it are skipped (missing_quantity), never floored.
  | "per_million_characters"
  // One successful request, flat (web search, web scrape).
  | "per_request";

export interface VeniceMultimodalPrice {
  /** `managed_venice_usage_events.endpoint`, e.g. "/api/v1/image/generate". */
  endpoint: string;
  /**
   * `managed_venice_usage_events.model`. `null` matches ANY model on the
   * endpoint — only legal where Venice's price is genuinely model-independent
   * (e.g. web search, where the recorded "model" is the search provider).
   */
  model: string | null;
  displayName: string;
  unit: VeniceMultimodalUnit;
  /** Venice LIST price per unit, in micro-USD (before markup). */
  microUsdPerUnit: number;
  /**
   * Published tiers keyed by a normalized tier token: image resolution
   * ("1k"/"2k"/"4k", lower-cased) or upscale factor ("2"/"4"). See
   * resolveVeniceMultimodalTier for how a request value maps to a tier.
   * `microUsdPerUnit` MUST be the cheapest tier: it is what an absent tier
   * field (Venice's default) settles at.
   */
  tiers?: Readonly<Record<string, number>>;
  /** Which metadata field carries the tier token. */
  tierMetadataKey?: "resolution" | "scale";
  /** Where this exact number came from / why an entry is shaped oddly. */
  notes?: string;
}

function usd(value: number): number {
  return Math.round(value * 1_000_000);
}

// Source for every number: https://docs.venice.ai/overview/pricing, re-checked
// 2026-09-25 (every entry below still matches it), plus Venice's GET /models
// pricing where that is higher (nano-banana-2-edit). Model ids are the exact
// strings observed in prod `managed_venice_usage_events.model` (verified
// against real usage rows) or, for not-yet-observed operations, the id our own
// proxy route records.
export const VENICE_MULTIMODAL_PRICES: readonly VeniceMultimodalPrice[] = [
  // ── Image generation (per image) ────────────────────────────────────────
  {
    endpoint: "/api/v1/image/generate",
    model: "qwen-image-2",
    displayName: "Qwen Image 2",
    unit: "per_image",
    microUsdPerUnit: usd(0.05),
  },
  {
    endpoint: "/api/v1/image/generate",
    model: "nano-banana-2",
    displayName: "Nano Banana 2",
    unit: "per_image",
    // Cheapest published tier (1K) is the base so passthrough rows — which
    // record no resolution — floor instead of guessing.
    microUsdPerUnit: usd(0.1),
    tiers: { "1k": usd(0.1), "2k": usd(0.14), "4k": usd(0.19) },
    tierMetadataKey: "resolution",
    notes: "Venice prices Nano Banana 2 by output resolution (1K/2K/4K).",
  },

  // ── Image editing (per edit == per image) ───────────────────────────────
  {
    endpoint: "/api/v1/image/edit",
    model: "seedream-v4-edit",
    displayName: "Seedream V4 Edit",
    unit: "per_image",
    microUsdPerUnit: usd(0.05),
  },
  {
    endpoint: "/api/v1/image/edit",
    model: "firered-image-edit",
    displayName: "FireRed Edit",
    unit: "per_image",
    microUsdPerUnit: usd(0.04),
  },
  {
    endpoint: "/api/v1/image/edit",
    model: "nano-banana-2-edit",
    displayName: "Nano Banana 2 Edit",
    unit: "per_image",
    microUsdPerUnit: usd(0.1),
    tiers: { "1k": usd(0.1), "2k": usd(0.14), "4k": usd(0.19) },
    tierMetadataKey: "resolution",
    notes:
      "Venice's GET /models prices it by output resolution like Nano Banana 2 " +
      "(1K/2K/4K); the docs pricing page still lists a flat $0.10, which is the " +
      "1K tier. Venice's default resolution for edits is 1K.",
  },
  {
    endpoint: "/api/v1/image/edit",
    model: "nano-banana-2-lite-edit",
    displayName: "Nano Banana 2 Lite Edit",
    unit: "per_image",
    microUsdPerUnit: usd(0.06),
  },

  // ── Image upscale (per image, tiered by scale factor) ───────────────────
  {
    endpoint: "/api/v1/image/upscale",
    // The dedicated upscale route records a fixed synthetic model id.
    model: "venice-upscaler",
    displayName: "Venice Upscale",
    unit: "per_image",
    microUsdPerUnit: usd(0.02),
    tiers: { "2": usd(0.02), "4": usd(0.08) },
    tierMetadataKey: "scale",
    notes:
      "2x $0.02 / 4x $0.08. Venice accepts a scale from 2 to 4 and defaults to 2x; " +
      "a factor between tiers is billed (and sent) as the next tier up.",
  },

  // ── TTS (per 1M input characters) ────────────────────────────────────────
  {
    endpoint: "/api/v1/audio/speech",
    model: "tts-kokoro",
    displayName: "Kokoro TTS",
    unit: "per_million_characters",
    microUsdPerUnit: usd(3.5),
    notes: "Quantity = metadata.inputLength (characters); required.",
  },

  // ── Web augmentation (flat per request) ──────────────────────────────────
  {
    endpoint: "/api/v1/augment/search",
    // The search route records the search PROVIDER (brave, ...) in the model
    // column; Venice's $10 / 1K requests price is provider-independent.
    model: null,
    displayName: "Venice Web Search",
    unit: "per_request",
    microUsdPerUnit: usd(0.01),
  },
  {
    endpoint: "/api/v1/augment/scrape",
    model: "venice-scrape",
    displayName: "Venice Web Scrape",
    unit: "per_request",
    microUsdPerUnit: usd(0.01),
    notes: "$10 per 1K URLs; our route bills one URL per request.",
  },
];

// DELIBERATELY UNPRICED (fail-safe skip; enumerate so tests + the settlement
// coverage report can distinguish "known, can't price yet" from "never seen"):
//   * /api/v1/video/queue (all models) — Venice video pricing is variable by
//     resolution × duration with no published list price (quote API only), and
//     queue-time rows don't reliably record either. Never guess.
//   * /api/v1/video/transcriptions, /api/v1/audio/transcriptions — STT is
//     priced per audio second; recorded rows carry no duration.
//   * /api/v1/augment/text-parser — no published list price on Venice's
//     pricing page as of the catalog snapshot.
//   * /api/v1/crypto/rpc/* — no published list price (Venice ships RPC access
//     without a metered rate today); do not bill without a source.
//   * passthrough rows whose model body was unparseable (model =
//     "passthrough:<path>") on model-priced endpoints — the model is unknown,
//     so the price is unknowable.
//   * embeddings / music (audio/queue) — priceable per Venice's page, but the
//     exact model ids haven't been observed in prod usage; entries land when
//     real rows name them.

type CatalogKey = string;

function exactKey(endpoint: string, model: string): CatalogKey {
  return `${endpoint} ${model}`;
}

const EXACT_PRICES = new Map<CatalogKey, VeniceMultimodalPrice>();
const ENDPOINT_WILDCARD_PRICES = new Map<string, VeniceMultimodalPrice>();
for (const price of VENICE_MULTIMODAL_PRICES) {
  if (price.model === null) {
    ENDPOINT_WILDCARD_PRICES.set(price.endpoint, price);
  } else {
    EXACT_PRICES.set(exactKey(price.endpoint, price.model), price);
  }
}

export function resolveVeniceMultimodalPrice(
  endpoint: string,
  model: string
): VeniceMultimodalPrice | null {
  return (
    EXACT_PRICES.get(exactKey(endpoint, model)) ??
    ENDPOINT_WILDCARD_PRICES.get(endpoint) ??
    null
  );
}

export type VeniceMultimodalSkipReason = "unpriced_operation" | "missing_quantity" | "invalid_tier";

/**
 * How a request's tier field maps onto an entry's published tiers.
 *   absent  - the field wasn't sent (or is empty): Venice runs its default,
 *             which is the cheapest tier (1K, 2x).
 *   tier    - a published tier, as the normalized key into `price.tiers`.
 *   invalid - sent, but not a value Hivra can price. Never floored: the
 *             managed proxy refuses it, and settlement skips such a row.
 */
export type VeniceMultimodalTierResolution =
  | { kind: "absent" }
  | { kind: "tier"; tier: string }
  | { kind: "invalid" };

function publishedScaleTiers(price: VeniceMultimodalPrice): number[] {
  return Object.keys(price.tiers ?? {})
    .map(Number)
    .filter((factor) => Number.isFinite(factor))
    .sort((a, b) => a - b);
}

/**
 * Map a request value (resolution or scale) onto one of `price`'s published
 * tiers.
 *   * resolution: a string, compared case-insensitively ("4K", "4k", " 4K ").
 *   * scale: a number or numeric string ("3", "4.0", "04", "4x"). Venice
 *     accepts any factor from its lowest to its highest tier (2 to 4) and
 *     bills per published tier, so a factor between tiers maps UP to the next
 *     published tier; the managed proxy then sends that tier to Venice, so
 *     what runs is what was charged.
 * An entry without tiers always resolves to `absent`.
 */
export function resolveVeniceMultimodalTier(
  price: VeniceMultimodalPrice,
  value: unknown
): VeniceMultimodalTierResolution {
  const tiers = price.tiers;
  if (!tiers || !price.tierMetadataKey) return { kind: "absent" };
  if (value === null || value === undefined) return { kind: "absent" };
  if (typeof value === "string" && !value.trim()) return { kind: "absent" };

  if (price.tierMetadataKey === "resolution") {
    if (typeof value !== "string") return { kind: "invalid" };
    const token = value.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(tiers, token) ? { kind: "tier", tier: token } : { kind: "invalid" };
  }

  const factor =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim().replace(/x$/i, ""))
        : Number.NaN;
  const published = publishedScaleTiers(price);
  if (!Number.isFinite(factor) || published.length === 0 || factor < published[0]) {
    return { kind: "invalid" };
  }
  const tier = published.find((candidate) => candidate >= factor);
  return tier === undefined ? { kind: "invalid" } : { kind: "tier", tier: String(tier) };
}

/** The published tier names of an entry, as Venice spells them ("1K, 2K, 4K"). */
export function describeVeniceMultimodalTiers(price: VeniceMultimodalPrice): string {
  if (price.tierMetadataKey === "scale") return publishedScaleTiers(price).join(" or ");
  return Object.keys(price.tiers ?? {})
    .map((tier) => tier.toUpperCase())
    .join(", ");
}

/**
 * The value to send Venice for a resolved tier: resolution as Venice spells
 * it ("4K"), scale as a number.
 */
export function veniceMultimodalTierRequestValue(price: VeniceMultimodalPrice, tier: string): string | number {
  return price.tierMetadataKey === "scale" ? Number(tier) : tier.toUpperCase();
}

export type VeniceMultimodalCostResult =
  | {
      priced: true;
      displayName: string;
      unit: VeniceMultimodalUnit;
      /** Unit count the row is billed for (chars for TTS, images, requests). */
      quantity: number;
      /** Normalized tier token that priced the row, when tiered. */
      tier: string | null;
      /** Effective list rate per unit after tier resolution, micro-USD. */
      microUsdPerUnit: number;
      /** Venice list cost for the row (pre-markup), micro-USD, ≥ 1. */
      listCostMicroUsd: number;
    }
  | { priced: false; reason: VeniceMultimodalSkipReason };

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * The per-unit rate for a row: its tier's price, or `whenAbsent` when the
 * tier field wasn't sent. Null for a tier value that isn't published.
 */
function resolveUnitRate(
  price: VeniceMultimodalPrice,
  metadata: Record<string, unknown>,
  whenAbsent: number
): { microUsdPerUnit: number; tier: string | null } | null {
  if (!price.tiers || !price.tierMetadataKey) {
    return { microUsdPerUnit: price.microUsdPerUnit, tier: null };
  }
  const resolved = resolveVeniceMultimodalTier(price, metadata[price.tierMetadataKey]);
  if (resolved.kind === "invalid") return null;
  if (resolved.kind === "tier") {
    return { microUsdPerUnit: price.tiers[resolved.tier], tier: resolved.tier };
  }
  return { microUsdPerUnit: whenAbsent, tier: null };
}

/**
 * Price one multimodal usage row. Pure — reads only its arguments — so the
 * settlement pass and tests share identical math.
 */
export function computeVeniceMultimodalCost(row: {
  endpoint: string;
  model: string;
  metadata?: Record<string, unknown> | null;
}): VeniceMultimodalCostResult {
  const price = resolveVeniceMultimodalPrice(row.endpoint, row.model);
  if (!price) return { priced: false, reason: "unpriced_operation" };

  const metadata = row.metadata ?? {};
  // An absent tier settles at the cheapest tier: that is what Venice runs.
  const rate = resolveUnitRate(price, metadata, price.microUsdPerUnit);
  if (!rate) return { priced: false, reason: "invalid_tier" };
  const { microUsdPerUnit, tier } = rate;

  switch (price.unit) {
    case "per_image": {
      // Dedicated image routes record the requested variant count; the
      // passthrough route doesn't. Venice's default is 1 variant, so 1 is a
      // floor for unrecorded counts — never an overcharge.
      const variants = readPositiveNumber(metadata.variants);
      const quantity =
        variants && Number.isInteger(variants) ? variants : 1;
      return {
        priced: true,
        displayName: price.displayName,
        unit: price.unit,
        quantity,
        tier,
        microUsdPerUnit,
        listCostMicroUsd: Math.max(1, quantity * microUsdPerUnit),
      };
    }
    case "per_million_characters": {
      const characters = readPositiveNumber(metadata.inputLength);
      if (characters === null) {
        return { priced: false, reason: "missing_quantity" };
      }
      return {
        priced: true,
        displayName: price.displayName,
        unit: price.unit,
        quantity: Math.ceil(characters),
        tier,
        microUsdPerUnit,
        listCostMicroUsd: Math.max(
          1,
          Math.ceil((Math.ceil(characters) * microUsdPerUnit) / 1_000_000)
        ),
      };
    }
    case "per_request":
      return {
        priced: true,
        displayName: price.displayName,
        unit: price.unit,
        quantity: 1,
        tier,
        microUsdPerUnit,
        listCostMicroUsd: Math.max(1, microUsdPerUnit),
      };
  }
}

function readPositiveQuantity(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    return readPositiveNumber(Number(value.trim()));
  }
  return readPositiveNumber(value);
}

/**
 * Conservative CEILING for a request that has not run yet: what the managed
 * proxy holds on the wallet BEFORE it forwards to Venice (see
 * media-spend-gate.ts). Same catalog and the same fail-safe contract as
 * `computeVeniceMultimodalCost` — an operation the catalog can't price is
 * never guessed at — but the rounding runs the other way:
 *   * an absent tier field holds at the MOST expensive published tier
 *     (settlement charges Venice's default, the cheapest); a tier value that
 *     isn't published is `invalid_tier`, never held or forwarded;
 *   * a variant count is rounded up, and numeric strings count (Venice
 *     coerces them), so a hold is never smaller than what Venice can bill.
 * The hold is released or captured down to the settlement price afterwards.
 */
export function computeVeniceMultimodalHoldCost(row: {
  endpoint: string;
  model: string;
  metadata?: Record<string, unknown> | null;
}): VeniceMultimodalCostResult {
  const price = resolveVeniceMultimodalPrice(row.endpoint, row.model);
  if (!price) return { priced: false, reason: "unpriced_operation" };

  const metadata = row.metadata ?? {};
  const rate = resolveUnitRate(
    price,
    metadata,
    Math.max(price.microUsdPerUnit, ...Object.values(price.tiers ?? {}))
  );
  if (!rate) return { priced: false, reason: "invalid_tier" };
  const { microUsdPerUnit, tier } = rate;

  switch (price.unit) {
    case "per_image": {
      const variants = readPositiveQuantity(metadata.variants);
      const quantity = variants ? Math.ceil(variants) : 1;
      return {
        priced: true,
        displayName: price.displayName,
        unit: price.unit,
        quantity,
        tier,
        microUsdPerUnit,
        listCostMicroUsd: Math.max(1, quantity * microUsdPerUnit),
      };
    }
    case "per_million_characters": {
      const characters = readPositiveNumber(metadata.inputLength);
      if (characters === null) return { priced: false, reason: "missing_quantity" };
      const quantity = Math.ceil(characters);
      return {
        priced: true,
        displayName: price.displayName,
        unit: price.unit,
        quantity,
        tier,
        microUsdPerUnit,
        listCostMicroUsd: Math.max(1, Math.ceil((quantity * microUsdPerUnit) / 1_000_000)),
      };
    }
    case "per_request":
      return {
        priced: true,
        displayName: price.displayName,
        unit: price.unit,
        quantity: 1,
        tier,
        microUsdPerUnit,
        listCostMicroUsd: Math.max(1, microUsdPerUnit),
      };
  }
}

/**
 * Apply the operator markup to a list cost. Ceil so we never round a
 * positive charge down to zero micro-dollars.
 */
export function applyVeniceMultimodalMarkup(
  listCostMicroUsd: number,
  markup: number
): number {
  if (!Number.isInteger(listCostMicroUsd) || listCostMicroUsd < 0) {
    throw new Error("listCostMicroUsd must be a non-negative integer");
  }
  if (!Number.isFinite(markup) || markup <= 0) {
    throw new Error("markup must be a positive finite number");
  }
  return Math.ceil(listCostMicroUsd * markup);
}
