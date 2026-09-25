// Request-field checks for managed-Venice media requests.
//
// The spend gate (media-spend-gate.ts) holds and charges from the fields Hivra
// reads; Venice runs whatever fields IT reads. Those must be the same request,
// or a caller can be held for a cheap model or tier and served an expensive
// one. So, before any hold, mediaPricingFieldError checks that:
//   * a pricing field may appear at most once. Multipart parsers disagree on
//     which copy of a repeated field wins (FormData.get takes the first, a map
//     built with forEach keeps the last, and Venice's parser is unknown);
//   * a pricing field must be a plain value: a text part in multipart, and a
//     string, number or boolean in JSON (model ids must be strings). Never a
//     file, array or object;
//   * `model` and its deprecated alias `modelId` may not name different
//     models. Whichever one is present is the model that gets priced.
// Then, for every endpoint the price catalog bills, planMediaRequest builds
// the body that is priced and forwarded:
//   * options Venice charges extra for that the catalog doesn't price
//     (`enable_web_search`, `enhance_prompt`, `quality`, style references) are
//     refused with a 400 when switched on;
//   * a tier field (resolution, scale) must map to a published tier; it is
//     rewritten to that tier's exact value, so Venice runs the tier charged,
//     and anything else is refused with a 400;
//   * only the fields Venice documents for the endpoint are forwarded. Any
//     other field is dropped, so an undocumented or newly added option can't
//     add to the bill (and a name like `model[0]` can't reach a parser that
//     might expand it).
//
// JSON bodies are re-serialized after parsing, so a repeated JSON key reaches
// Venice as the single value that was priced.

import { log } from "@/lib/logger";
import {
  describeVeniceMultimodalTiers,
  resolveVeniceMultimodalPrice,
  resolveVeniceMultimodalTier,
  veniceMultimodalTierRequestValue,
} from "./multimodal-pricing";

/** Every request field that decides what a media request costs. */
export const MEDIA_PRICING_FIELDS = [
  "model",
  "modelId",
  "scale",
  "enhance",
  "resolution",
  "variants",
  "duration",
] as const;

const MODEL_FIELDS = new Set<string>(["model", "modelId"]);
const JSON_SCALAR_TYPES = new Set(["string", "number", "boolean"]);

export type MediaFields = FormData | Record<string, unknown>;

// Duck-typed so a FormData from any fetch implementation counts.
export function isMediaForm(fields: MediaFields): fields is FormData {
  return typeof (fields as FormData).getAll === "function" && typeof (fields as FormData).get === "function";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Why this request's pricing fields can't be billed as sent, or null when
 * they can. Callers answer a non-null result with a 400 and never forward.
 */
export function mediaPricingFieldError(fields: MediaFields): string | null {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return "The request body must be a JSON object or a multipart form.";
  }
  const seen = new Map<string, unknown>();
  for (const name of MEDIA_PRICING_FIELDS) {
    if (isMediaForm(fields)) {
      const values = fields.getAll(name);
      if (values.length === 0) continue;
      if (values.length > 1) {
        return `Send "${name}" once. Hivra can't bill a request that gives it more than once.`;
      }
      if (typeof values[0] !== "string") return `"${name}" must be a text field, not a file.`;
      seen.set(name, values[0]);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(fields, name)) continue;
    const value = fields[name];
    if (value === null || value === undefined) continue;
    if (MODEL_FIELDS.has(name) ? typeof value !== "string" : !JSON_SCALAR_TYPES.has(typeof value)) {
      return MODEL_FIELDS.has(name)
        ? `"${name}" must be a string.`
        : `"${name}" must be a single string, number or boolean.`;
    }
    seen.set(name, value);
  }

  const model = text(seen.get("model"));
  const modelId = text(seen.get("modelId"));
  if (model && modelId && model !== modelId) {
    return '"model" and "modelId" name different models. Send one of them.';
  }
  return null;
}

/**
 * The model a media request names: `model`, else its deprecated alias
 * `modelId`. Call only after `mediaPricingFieldError` returned null, so the
 * two can't disagree.
 */
export function mediaModelField(fields: MediaFields): string | null {
  const read = (name: string) => (isMediaForm(fields) ? fields.get(name) : fields[name]);
  return text(read("model")) ?? text(read("modelId"));
}

// ── Per-endpoint request policy ──────────────────────────────────────────────

type OptionCheck = (value: unknown) => boolean;

/** A boolean option that costs extra when on. Off = absent, false, "false", "0", "". */
const switchedOn: OptionCheck = (value) => {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return !(text === "" || text === "false" || text === "0");
  }
  return true;
};

/** Any value at all (a file, a list, a string that isn't blank). */
const present: OptionCheck = (value) =>
  !(value === undefined || value === null || (typeof value === "string" && !value.trim()));

/** Anything but an absent value or an empty list. */
const nonEmpty: OptionCheck = (value) => present(value) && !(Array.isArray(value) && value.length === 0);

export interface MediaRequestPolicy {
  /** Fields forwarded to Venice. Every other field is dropped. */
  forward: ReadonlySet<string>;
  /**
   * Venice options that add charges the catalog doesn't price. A request
   * that switches one on is refused before any hold.
   */
  unpricedOptions: Readonly<Record<string, OptionCheck>>;
}

function policy(forward: string[], unpricedOptions: Record<string, OptionCheck> = {}): MediaRequestPolicy {
  return { forward: new Set(forward), unpricedOptions };
}

/**
 * One policy per endpoint the price catalog bills (multimodal-pricing.ts;
 * a test keeps the two in step). Field lists are Venice's OpenAPI request
 * schemas (api.venice.ai/doc/api/swagger.yaml, 2026-09-25) minus the options
 * Venice bills extra for, which are listed under unpricedOptions instead.
 */
export const MEDIA_REQUEST_POLICIES: Readonly<Record<string, MediaRequestPolicy>> = {
  "/api/v1/image/generate": policy(
    [
      "model",
      "prompt",
      "negative_prompt",
      "width",
      "height",
      "aspect_ratio",
      "resolution",
      "variants",
      "format",
      "return_binary",
      "seed",
      "safe_mode",
      "hide_watermark",
      "cfg_scale",
      "steps",
      "lora_strength",
      "style_preset",
      "embed_exif_metadata",
      "disable_prompt_optimization_thinking",
      "anon_user_id",
    ],
    {
      // "If web search is used, additional credits are getting charged."
      enable_web_search: switchedOn,
      // "Additional credits are charged when a rewrite is generated."
      enhance_prompt: switchedOn,
      // "Higher values can increase the final request charge."
      quality: present,
      // Reference images; per-image input fees are not in the catalog.
      style_references: nonEmpty,
    }
  ),
  "/api/v1/image/edit": policy(
    [
      "model",
      "modelId",
      "prompt",
      "image",
      "aspect_ratio",
      "resolution",
      "output_format",
      "safe_mode",
      "disable_prompt_optimization_thinking",
      "anon_user_id",
    ],
    { enhance_prompt: switchedOn, quality: present }
  ),
  // Venice's upscale takes image, scale and creativity. The agent's
  // image_upscale tool also sends the retired enhance options; they are
  // dropped, and a scale below 2 (its old enhance-only mode) is refused by the
  // tier check.
  "/api/v1/image/upscale": policy(["image", "scale", "creativity"]),
  "/api/v1/audio/speech": policy([
    "model",
    "input",
    "voice",
    "response_format",
    "speed",
    "streaming",
    "language",
    "prompt",
    "temperature",
    "top_p",
  ]),
  "/api/v1/augment/search": policy(["query", "limit", "search_provider"]),
  // One URL per request is what the catalog bills.
  "/api/v1/augment/scrape": policy(["url"]),
};

export type MediaRequestPlan<T extends MediaFields> =
  | { ok: true; fields: T; dropped: string[] }
  | { ok: false; error: string };

function valuesOf(fields: MediaFields, name: string): unknown[] {
  if (isMediaForm(fields)) return fields.getAll(name);
  return Object.prototype.hasOwnProperty.call(fields, name) ? [fields[name]] : [];
}

/**
 * Turn a parsed media request into exactly what Venice will be sent, or the
 * reason it can't be billed as sent (answer with a 400; never forward).
 *
 * Call after mediaPricingFieldError returned null (so each pricing field
 * appears at most once) and with the model that will be priced. The result
 * is a NEW body of the same kind (FormData stays FormData, file parts
 * included); price the request from it and forward it unchanged. An
 * endpoint with no policy (one the catalog doesn't bill, which the gate
 * refuses anyway) passes through untouched.
 */
export function planMediaRequest<T extends MediaFields>(params: {
  endpoint: string;
  model: string;
  fields: T;
  /** Log source, e.g. "managed-venice-image". */
  source: string;
}): MediaRequestPlan<T> {
  const { endpoint, model, fields, source } = params;
  const requestPolicy = MEDIA_REQUEST_POLICIES[endpoint];
  if (!requestPolicy) return { ok: true, fields, dropped: [] };

  for (const [name, isOn] of Object.entries(requestPolicy.unpricedOptions)) {
    if (valuesOf(fields, name).some(isOn)) {
      return {
        ok: false,
        error:
          `"${name}" adds Venice charges that Hivra can't bill on managed credits yet, ` +
          "so the request was not sent and nothing was charged. Remove it and try again.",
      };
    }
  }

  // The tier field is rewritten to the published tier's exact value, or
  // removed when blank, so Venice runs the tier that is charged.
  let tierName: string | null = null;
  let tierValue: string | number | null = null;
  const price = resolveVeniceMultimodalPrice(endpoint, model);
  if (price?.tiers && price.tierMetadataKey) {
    tierName = price.tierMetadataKey;
    const resolved = resolveVeniceMultimodalTier(price, valuesOf(fields, tierName)[0]);
    if (resolved.kind === "invalid") {
      return {
        ok: false,
        error:
          `"${tierName}" must be ${describeVeniceMultimodalTiers(price)} for ${model.slice(0, 80)} ` +
          "on Hivra credits, so the request was not sent and nothing was charged.",
      };
    }
    if (resolved.kind === "tier") tierValue = veniceMultimodalTierRequestValue(price, resolved.tier);
  }

  const dropped = new Set<string>();
  let planned: MediaFields;
  if (isMediaForm(fields)) {
    const form = new FormData();
    fields.forEach((value, name) => {
      if (!requestPolicy.forward.has(name)) {
        dropped.add(name);
      } else if (name !== tierName) {
        form.append(name, value);
      }
    });
    if (tierName && tierValue !== null) form.append(tierName, String(tierValue));
    planned = form;
  } else {
    const body: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (!requestPolicy.forward.has(name)) {
        dropped.add(name);
      } else if (name !== tierName) {
        body[name] = value;
      }
    }
    if (tierName && tierValue !== null) body[tierName] = tierValue;
    planned = body;
  }

  if (dropped.size > 0) {
    log.info("Managed Venice media request: fields Venice doesn't document were not forwarded", {
      source,
      route: endpoint,
      model,
      droppedFields: Array.from(dropped).slice(0, 20).map((name) => name.slice(0, 64)),
    });
  }
  return { ok: true, fields: planned as T, dropped: Array.from(dropped) };
}

/** String fields of a planned body, for recording pricing metadata. */
export function mediaTextFields(fields: MediaFields): Record<string, unknown> {
  if (!isMediaForm(fields)) return fields;
  const text: Record<string, unknown> = {};
  fields.forEach((value, name) => {
    if (typeof value === "string") text[name] = value;
  });
  return text;
}
