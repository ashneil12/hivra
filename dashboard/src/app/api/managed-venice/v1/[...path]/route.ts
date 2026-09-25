import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { mediaModelField, mediaPricingFieldError } from "@/lib/venice/media-request-fields";
import {
  holdManagedVeniceMediaSpend,
  readNumericField,
  sendManagedVeniceMediaRequest,
} from "@/lib/venice/media-spend-gate";
import { verifyManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";

// SCRIPTURE_ANCHOR: venice-passthrough | John 14:6 | Verse: I am the way, the truth, and the life.
//
// Passthrough for the Venice-native paths Hivra agents call that have no
// bespoke route. The Hermes agent's Venice plugins speak Venice's native,
// singular surface (`POST /image/generate`, `POST /video/queue`,
// `POST /audio/retrieve`, `GET /image/styles`, ...) against
// VENICE_BASE_URL=<managed proxy>, so those calls land here. The explicit
// routes (chat/completions, responses, models, embeddings, audio/queue,
// audio/speech, audio/transcriptions, augment/*, images/*, videos/*) win via
// Next's more-specific-route precedence and keep their own metering.
//
// Every request goes to Venice with HIVRA's upstream key, so this route only
// forwards an explicit ALLOWLIST (below). Anything else — Venice account
// management (api_keys*, billing*, ...), unknown or new paths, case/encoding
// variants, alternate methods — is refused and never fetched.
// Paid operations are forwarded only under a wallet hold (media-spend-gate.ts);
// one the price catalog can't price is refused with a 402. A paid request must
// be JSON or multipart that parses, its pricing fields must be unambiguous
// (media-request-fields.ts), and what is forwarded is rebuilt from the parsed
// fields, so Venice runs exactly the request that was priced.
const VENICE_API_BASE = "https://api.venice.ai/api/v1";

// Each segment must be plain lower-case path text. Next hands the catch-all
// DECODED segments, so this also rejects %2F / %5C / %2E%2E / %00 tricks,
// dot segments, empty segments (double or trailing slashes) and case variants.
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SEGMENTS = 4;

interface FreeRule {
  kind: "free";
  method: "GET" | "POST";
  path: string;
}

type BodyFields = Record<string, unknown>;

interface MeteredRule {
  kind: "metered";
  path: string;
  /** Catalog key for the hold (Venice's endpoint label). */
  endpoint: (segments: string[]) => string;
  /** Model + pricing metadata from the request body, or a 400 message. */
  operation: (fields: BodyFields) => { model: string; metadata: Record<string, unknown> } | { error: string };
}

function stringField(fields: BodyFields, name: string): string | null {
  const value = fields[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredModel(fields: BodyFields, metadata: Record<string, unknown> = {}) {
  const model = stringField(fields, "model");
  return model ? { model, metadata } : { error: "Model is required." };
}

// Free paths, each evidenced by a caller in the Hermes agent fork
// (ashneil12/vanilla-hermes-agent) that uses VENICE_BASE_URL:
const FREE_RULES: FreeRule[] = [
  // Model discovery (plugins/model-providers/venice, video_gen `models?type=`).
  // Normally served by the dedicated /v1/models route; kept for parity.
  { kind: "free", method: "GET", path: "models" },
  // tools/venice_extras_tool.py list_styles.
  { kind: "free", method: "GET", path: "image/styles" },
  // tools/venice_extras_tool.py network list.
  { kind: "free", method: "GET", path: "crypto/rpc/networks" },
  // tools/venice_characters_tool.py: Venice's public persona list.
  { kind: "free", method: "GET", path: "characters" },
  // Job polling — the generation was held/billed at queue time.
  // plugins/video_gen/venice, tools/audio_generate_tool.py.
  { kind: "free", method: "POST", path: "video/retrieve" },
  { kind: "free", method: "POST", path: "audio/retrieve" },
  // Free price previews — tools/venice_extras_tool.py.
  { kind: "free", method: "POST", path: "video/quote" },
  { kind: "free", method: "POST", path: "audio/quote" },
];

const fixedEndpoint = (path: string) => () => `/api/v1/${path}`;

// Paid POST paths the agent calls here. Forwarded only under a wallet hold;
// the ones with no catalog price are refused by the gate (402) until priced.
const METERED_RULES: MeteredRule[] = [
  {
    kind: "metered",
    path: "image/generate",
    endpoint: fixedEndpoint("image/generate"),
    operation: (fields) =>
      requiredModel(fields, {
        resolution: stringField(fields, "resolution"),
        aspectRatio: stringField(fields, "aspect_ratio"),
        variants: readNumericField(fields.variants),
      }),
  },
  {
    kind: "metered",
    path: "image/edit",
    endpoint: fixedEndpoint("image/edit"),
    // `modelId` is Venice's deprecated alias; firered is its documented
    // default when neither is sent.
    operation: (fields) => ({
      model: mediaModelField(fields) ?? "firered-image-edit",
      metadata: { resolution: stringField(fields, "resolution"), aspectRatio: stringField(fields, "aspect_ratio") },
    }),
  },
  {
    kind: "metered",
    path: "image/upscale",
    endpoint: fixedEndpoint("image/upscale"),
    operation: (fields) => ({
      model: "venice-upscaler",
      metadata: { scale: stringField(fields, "scale") ?? readNumericField(fields.scale), enhance: stringField(fields, "enhance") },
    }),
  },
  {
    kind: "metered",
    path: "image/multi-edit",
    endpoint: fixedEndpoint("image/multi-edit"),
    operation: (fields) => ({
      model: mediaModelField(fields) ?? "firered-image-edit",
      metadata: {},
    }),
  },
  {
    kind: "metered",
    path: "image/background-remove",
    endpoint: fixedEndpoint("image/background-remove"),
    operation: () => ({ model: "venice-bg-remover", metadata: {} }),
  },
  {
    kind: "metered",
    path: "video/queue",
    endpoint: fixedEndpoint("video/queue"),
    operation: (fields) =>
      requiredModel(fields, {
        duration: stringField(fields, "duration"),
        resolution: stringField(fields, "resolution"),
      }),
  },
  {
    kind: "metered",
    path: "video/transcriptions",
    endpoint: fixedEndpoint("video/transcriptions"),
    operation: (fields) => ({ model: stringField(fields, "model") ?? "passthrough:video/transcriptions", metadata: {} }),
  },
  {
    kind: "metered",
    path: "audio/voices",
    endpoint: fixedEndpoint("audio/voices"),
    operation: (fields) => ({ model: stringField(fields, "model") ?? "passthrough:audio/voices", metadata: {} }),
  },
  {
    kind: "metered",
    path: "augment/text-parser",
    endpoint: fixedEndpoint("augment/text-parser"),
    operation: () => ({ model: "passthrough:augment/text-parser", metadata: {} }),
  },
  {
    kind: "metered",
    // crypto/rpc/{network}; `networks` itself is the free GET above.
    path: "crypto/rpc/*",
    endpoint: (segments) => `/api/v1/crypto/rpc/${segments[2]}`,
    operation: () => ({ model: "passthrough:crypto/rpc", metadata: {} }),
  },
];

function pathMatches(rulePath: string, segments: string[]) {
  const parts = rulePath.split("/");
  return (
    parts.length === segments.length &&
    parts.every((part, index) => part === segments[index] || (part === "*" && segments[index] !== "networks"))
  );
}

function matchRule(method: string, segments: string[]): FreeRule | MeteredRule | null {
  if (method === "GET") {
    return FREE_RULES.find((rule) => rule.method === "GET" && pathMatches(rule.path, segments)) ?? null;
  }
  if (method === "POST") {
    return (
      FREE_RULES.find((rule) => rule.method === "POST" && pathMatches(rule.path, segments)) ??
      METERED_RULES.find((rule) => pathMatches(rule.path, segments)) ??
      null
    );
  }
  return null;
}

function readBearerKey(req: NextRequest) {
  const header = req.headers.get("authorization")?.trim() || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function refused(method: string, segments: string[]) {
  const shownPath = segments.every((segment) => SEGMENT.test(segment))
    ? segments.join("/").slice(0, 160)
    : "(invalid path)";
  const response = apiError(
    "This Venice API path is not available through Hivra's managed proxy.",
    404,
    undefined,
    undefined,
    {
      source: "managed-venice-passthrough",
      route: "/api/managed-venice/v1/[...path]",
      method,
      failureType: "managed_venice_passthrough_refused",
      metadata: { path: shownPath },
    }
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}

type MeteredBody =
  | { ok: true; fields: BodyFields; forward: { body: string | FormData; contentType: string | null } }
  | { ok: false; response: Response };

function bodyRefused(message: string, status: 400 | 415) {
  const response = apiError(message, status);
  response.headers.set("Cache-Control", "no-store");
  return { ok: false as const, response };
}

/**
 * Parse a PAID request's body and rebuild what gets forwarded from the parsed
 * fields. A body Hivra can't read is refused rather than priced as if it
 * named no fields, and the rebuilt body means Venice sees the same fields the
 * hold was priced from (one value per key, no parser differences).
 */
async function readMeteredBody(bodyBuf: ArrayBuffer, contentType: string): Promise<MeteredBody> {
  const mediaType = contentType.split(";")[0].trim().toLowerCase();

  if (mediaType === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBuf));
    } catch {
      return bodyRefused("Invalid JSON body.", 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return bodyRefused("The JSON body must be an object.", 400);
    }
    const fieldError = mediaPricingFieldError(parsed as BodyFields);
    if (fieldError) return bodyRefused(fieldError, 400);
    return {
      ok: true,
      fields: parsed as BodyFields,
      forward: { body: JSON.stringify(parsed), contentType: "application/json" },
    };
  }

  if (mediaType === "multipart/form-data") {
    let form: FormData;
    try {
      form = await new Response(bodyBuf, { headers: { "Content-Type": contentType } }).formData();
    } catch {
      return bodyRefused("Invalid multipart/form-data body.", 400);
    }
    const fieldError = mediaPricingFieldError(form);
    if (fieldError) return bodyRefused(fieldError, 400);
    const fields: BodyFields = {};
    form.forEach((value, name) => {
      if (typeof value === "string") fields[name] = value;
    });
    // fetch writes a fresh boundary for the rebuilt form.
    return { ok: true, fields, forward: { body: form, contentType: null } };
  }

  return bodyRefused("Paid Venice requests must be application/json or multipart/form-data.", 415);
}

async function handle(req: NextRequest, segments: string[]) {
  const method = req.method.toUpperCase();

  if (
    !segments.length ||
    segments.length > MAX_SEGMENTS ||
    !segments.every((segment) => SEGMENT.test(segment))
  ) {
    return refused(method, segments);
  }
  const rule = matchRule(method, segments);
  if (!rule) return refused(method, segments);

  const subPath = segments.join("/");
  const endpointLabel = rule.kind === "metered" ? rule.endpoint(segments) : `/api/v1/${subPath}`;

  const plaintextKey = readBearerKey(req);
  if (!plaintextKey) return apiError("Unauthorized", 401);
  const verifiedKey = await verifyManagedVeniceProxyKey({ plaintextKey });
  if (!verifiedKey) return apiError("Unauthorized", 401);

  // GET has no body. Free POSTs forward their raw bytes and type; paid ones
  // forward the body rebuilt from what was priced.
  const reqContentType = req.headers.get("content-type") || "";
  const bodyBuf = method === "POST" ? await req.arrayBuffer() : undefined;
  let forwardBody: ArrayBuffer | string | FormData | undefined = bodyBuf;
  let forwardContentType: string | null = reqContentType || null;

  let operation: { model: string; metadata: Record<string, unknown> } | null = null;
  if (rule.kind === "metered") {
    const parsed = await readMeteredBody(bodyBuf ?? new ArrayBuffer(0), reqContentType);
    if (!parsed.ok) return parsed.response;
    const described = rule.operation(parsed.fields);
    if ("error" in described) return apiError(described.error, 400);
    operation = described;
    forwardBody = parsed.forward.body;
    forwardContentType = parsed.forward.contentType;
  }

  const serverKey = resolveManagedVeniceUpstreamKey({
    proxyKeyId: verifiedKey.id,
    model: operation?.model ?? null,
    endpoint: endpointLabel,
  })?.key;
  if (!serverKey) {
    return apiError("Managed Venice is not configured.", 503, {
      failureType: "managed_venice_server_key_missing",
    });
  }

  // Query strings only ride along on free reads (e.g. `models?type=video`).
  let search = "";
  if (method === "GET") {
    try {
      search = new URL(req.url).search;
    } catch {
      search = "";
    }
  }
  const upstreamUrl = `${VENICE_API_BASE}/${subPath}${search}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serverKey}`,
    Accept: req.headers.get("accept") || "application/json",
  };
  if (forwardContentType) headers["Content-Type"] = forwardContentType;
  const send = () =>
    fetch(upstreamUrl, { method, headers, body: forwardBody, redirect: "error" });

  let upstream: Response;
  let upstreamBuf: ArrayBuffer;
  if (operation) {
    const gate = await holdManagedVeniceMediaSpend({
      key: verifiedKey,
      operation: { endpoint: endpointLabel, model: operation.model, metadata: { ...operation.metadata, method, path: subPath } },
      source: "managed-venice-passthrough",
    });
    if (!gate.ok) return gate.response;
    const sent = await sendManagedVeniceMediaRequest({
      hold: gate.hold,
      mode: "buffer",
      fetchFailureType: "managed_venice_passthrough_upstream_fetch_failed",
      send,
    });
    if (!sent.ok) return sent.response;
    upstream = sent.upstream;
    upstreamBuf = sent.body ?? new ArrayBuffer(0);
  } else {
    try {
      upstream = await send();
      // arrayBuffer keeps binary payloads (generated music/audio) byte-exact.
      upstreamBuf = await upstream.arrayBuffer();
    } catch (error) {
      return apiError(
        "Venice upstream request failed.",
        502,
        { failureType: "managed_venice_passthrough_upstream_fetch_failed" },
        undefined,
        { cause: error }
      );
    }
  }

  if (!upstream.ok) {
    log.warn("Managed Venice passthrough upstream non-2xx", {
      source: "managed-venice-passthrough",
      route: endpointLabel,
      method,
      failureType: "managed_venice_passthrough_upstream_non_2xx",
      upstreamStatus: upstream.status,
      userId: verifiedKey.userId,
      proxyKeyId: verifiedKey.id,
    });
  }

  return new Response(upstreamBuf, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") || "application/json" },
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  return handle(req, path || []);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  return handle(req, path || []);
}
