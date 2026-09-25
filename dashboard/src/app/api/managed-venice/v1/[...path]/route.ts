import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
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
// management (api_keys*, billing*, characters, ...), unknown or new paths,
// case/encoding variants, alternate methods — is refused and never fetched.
// Paid operations are forwarded only under a wallet hold (media-spend-gate.ts);
// one the price catalog can't price is refused with a 402.
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
    // Venice's documented default edit model when the field is omitted.
    operation: (fields) => ({
      model: stringField(fields, "model") ?? stringField(fields, "modelId") ?? "firered-image-edit",
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
      model: stringField(fields, "modelId") ?? stringField(fields, "model") ?? "firered-image-edit",
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

async function readBodyFields(bodyBuf: ArrayBuffer, contentType: string): Promise<BodyFields> {
  if (!bodyBuf.byteLength) return {};
  const type = contentType.toLowerCase();
  try {
    if (type.includes("application/json")) {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBuf)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as BodyFields) : {};
    }
    if (type.includes("multipart/form-data")) {
      // Parse a copy so the original bytes (and boundary) forward untouched.
      const form = await new Response(bodyBuf, { headers: { "Content-Type": contentType } }).formData();
      const fields: BodyFields = {};
      form.forEach((value, name) => {
        if (typeof value === "string") fields[name] = value;
      });
      return fields;
    }
  } catch {
    // Unparseable body: priced as if no fields were sent; Venice will 400 it.
  }
  return {};
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

  // Raw bytes so JSON *and* multipart/form-data (voice clone, document
  // parser, image edit) keep their boundaries intact. GET has no body.
  const reqContentType = req.headers.get("content-type") || "";
  const bodyBuf = method === "POST" ? await req.arrayBuffer() : undefined;

  let operation: { model: string; metadata: Record<string, unknown> } | null = null;
  if (rule.kind === "metered") {
    const described = rule.operation(await readBodyFields(bodyBuf ?? new ArrayBuffer(0), reqContentType));
    if ("error" in described) return apiError(described.error, 400);
    operation = described;
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
  if (reqContentType) headers["Content-Type"] = reqContentType;
  const send = () =>
    fetch(upstreamUrl, { method, headers, body: bodyBuf, redirect: "error" });

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
