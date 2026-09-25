// Pricing-field checks for managed-Venice media requests.
//
// The spend gate (media-spend-gate.ts) holds and charges from the fields Hivra
// reads; Venice runs whatever fields IT reads. Those must be the same request,
// or a caller can be held for a cheap model or tier and served an expensive
// one. So, before any hold:
//   * a pricing field may appear at most once. Multipart parsers disagree on
//     which copy of a repeated field wins (FormData.get takes the first, a map
//     built with forEach keeps the last, and Venice's parser is unknown);
//   * a pricing field must be a plain value: a text part in multipart, and a
//     string, number or boolean in JSON (model ids must be strings). Never a
//     file, array or object;
//   * `model` and its deprecated alias `modelId` may not name different
//     models. Whichever one is present is the model that gets priced.
//
// JSON bodies are re-serialized after parsing, so a repeated JSON key reaches
// Venice as the single value that was priced.

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

type MediaFields = FormData | Record<string, unknown>;

// Duck-typed so a FormData from any fetch implementation counts.
function isForm(fields: MediaFields): fields is FormData {
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
    if (isForm(fields)) {
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
  const read = (name: string) => (isForm(fields) ? fields.get(name) : fields[name]);
  return text(read("model")) ?? text(read("modelId"));
}
