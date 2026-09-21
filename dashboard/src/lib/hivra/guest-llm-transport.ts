import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { validateHivraChatOrigin } from "./agent-host-result";

export const GUEST_LLM_APPLICATION_PROTOCOL = "hivra-llm-apply-v1" as const;
const MAX_RESPONSE_BYTES = 8192;
const DEADLINE_MS = 12000;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const OperationId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const Model = z.string().regex(/^[A-Za-z0-9._:\/\[\]-]{1,64}$/).nullable();
const Payload = z.object({
  provider: z.literal("venice"),
  baseUrl: z.string().max(2048).regex(/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._\/-]*)?$/)
    .refine(value => {
      try {
        const url = new URL(value);
        return !url.hostname.endsWith(".") && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    }).transform(value => value.replace(/\/+$/, "")),
  apiKey: z.string().regex(/^[\x21-\x7e]{8,256}$/),
  model: Model,
}).strict().nullable();
const Target = z.object({
  hostname: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  apiToken: Digest,
  runtime: z.literal("codex"),
}).strict();
const Application = z.object({
  target: Target,
  operationId: OperationId,
  expectedStateDigest: Digest,
  payload: Payload,
}).strict();
const Receipt = z.object({
  protocol: z.literal(GUEST_LLM_APPLICATION_PROTOCOL),
  stateDigest: Digest,
  operationId: OperationId.nullable(),
  payloadDigest: Digest.nullable(),
  provider: z.literal("venice").nullable(),
  model: Model,
}).strict().refine(value => (value.operationId === null) === (value.payloadDigest === null)
  && (value.provider !== null || value.model === null));
const ResponseReceipt = z.object({ ok: z.literal(true) }).merge(Receipt.innerType()).strict()
  .transform(value => Receipt.parse({ protocol: value.protocol, stateDigest: value.stateDigest,
    operationId: value.operationId, payloadDigest: value.payloadDigest, provider: value.provider, model: value.model }));

export type GuestLlmTarget = z.infer<typeof Target>;
export type GuestLlmApplication = z.input<typeof Application>;
export type GuestLlmReceipt = z.infer<typeof Receipt>;
type UnsentReason = "invalid_request" | "unsupported_guest" | "unavailable" | "state_conflict" | "operation_conflict";
export type GuestLlmInspection = { ok: true; receipt: GuestLlmReceipt }
  | { ok: false; reason: "invalid_request" | "unsupported_guest" | "unavailable" };
export type GuestLlmDelivery = { status: "applied"; receipt: GuestLlmReceipt; writeAttempted: boolean }
  | { status: "not_sent"; reason: UnsentReason }
  | { status: "unconfirmed"; reason: "delivery_unconfirmed" };

class UnsupportedGuest extends Error {}

function mac(apiToken: string, domain: string, value: string) {
  return createHmac("sha256", apiToken).update(GUEST_LLM_APPLICATION_PROTOCOL + "\0" + domain + "\0" + value).digest("hex");
}

/** Server-only parity with the guest's canonical JSON record. This is not a
 * receipt until the exact authenticated guest response matches it. */
export function expectedGuestLlmReceipt(raw: GuestLlmApplication): GuestLlmReceipt {
  const input = Application.parse(raw);
  const payloadDigest = mac(input.target.apiToken, "payload", JSON.stringify({
    operationId: input.operationId, previousStateDigest: input.expectedStateDigest, payload: input.payload,
  }));
  const record = { ...(input.payload || { provider: null }), _hivraApplication: {
    protocol: GUEST_LLM_APPLICATION_PROTOCOL, operationId: input.operationId,
    previousStateDigest: input.expectedStateDigest, payloadDigest,
  } };
  return { protocol: GUEST_LLM_APPLICATION_PROTOCOL,
    stateDigest: mac(input.target.apiToken, "state", "record:" + JSON.stringify(record) + "\n"),
    operationId: input.operationId, payloadDigest, provider: input.payload?.provider ?? null, model: input.payload?.model ?? null };
}

function matches(actual: GuestLlmReceipt, expected: GuestLlmReceipt) {
  return actual.operationId === expected.operationId && actual.provider === expected.provider && actual.model === expected.model
    && actual.payloadDigest !== null && expected.payloadDigest !== null
    && timingSafeEqual(Buffer.from(actual.payloadDigest, "hex"), Buffer.from(expected.payloadDigest, "hex"))
    && timingSafeEqual(Buffer.from(actual.stateDigest, "hex"), Buffer.from(expected.stateDigest, "hex"));
}

// A fetch/body implementation that ignores abort must not hold the caller's
// lifecycle lease indefinitely. Cancellation remains best-effort for a broken
// transport; every returned outcome stays conservative about possible writes.
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Guest request deadline")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    discard(response); throw new Error("Guest response type");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Guest response body");
  const chunks: Uint8Array[] = [];
  let size = 0, reads = 0;
  try {
    for (;;) {
      if (++reads > MAX_RESPONSE_BYTES * 2) throw new Error("Guest response chunk limit");
      const { value, done } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Guest response limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function transport(target: GuestLlmTarget, fetcher: typeof ssrfSafeFetch, parentSignal?: AbortSignal) {
  const origin = validateHivraChatOrigin(`https://${target.hostname}`, target.hostname);
  if (!origin || !checkOutboundUrlSafety(origin).ok) throw new Error("Invalid guest origin");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, DEADLINE_MS);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();
  const signal = controller.signal;
  const request = async (path: string, authenticated: boolean, body?: string) => {
    if (signal.aborted) throw new Error("Guest request deadline");
    const pending = fetcher(origin + path, { method: body === undefined ? "GET" : "POST",
      redirect: "manual", cache: "no-store", credentials: "omit", signal,
      headers: { Accept: "application/json", ...(authenticated ? { Authorization: `Bearer ${target.apiToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body }) }).then(response => {
      if (signal.aborted || response.redirected || (response.status >= 300 && response.status < 400)) {
        discard(response); throw new Error("Guest redirect or deadline");
      }
      return response;
    });
    return bounded(pending, signal);
  };
  const receipt = async (response: Response) => {
    if (response.status !== 200 || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")) {
      discard(response); throw new Error("Unconfirmed guest response");
    }
    return ResponseReceipt.parse(await json(response, signal));
  };
  return {
    async inspect() {
      const metadata = await request("/api/meta", false);
      if (metadata.status !== 200) { discard(metadata); throw new Error("Guest metadata unavailable"); }
      const compatible = z.object({ agentKind: z.literal(target.runtime), surfaceAuth: z.literal("post-cookie-v1"),
        llmApplication: z.literal(GUEST_LLM_APPLICATION_PROTOCOL) }).safeParse(await json(metadata, signal));
      if (!compatible.success) throw new UnsupportedGuest();
      const authGate = await request("/api/llm/application", false);
      discard(authGate);
      if (authGate.status !== 401) throw new Error("Missing guest authentication");
      return receipt(await request("/api/llm/application", true));
    },
    async apply(input: z.infer<typeof Application>) {
      return receipt(await request("/api/llm/application", true, JSON.stringify({ protocol: GUEST_LLM_APPLICATION_PROTOCOL,
        operationId: input.operationId, expectedStateDigest: input.expectedStateDigest, payload: input.payload })));
    },
    close() { clearTimeout(timeout); parentSignal?.removeEventListener("abort", abort); abort(); },
  };
}

/** Read-only observation, not mutation/ownership authority. The caller must
 * supply the original DB-journaled hostname and per-computer token, never a
 * browser/guest-selected URL or ambient operator credentials. */
export async function inspectGuestLlmApplication(raw: GuestLlmTarget, fetcher = ssrfSafeFetch,
  signal?: AbortSignal): Promise<GuestLlmInspection> {
  const parsed = Target.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_request" };
  let client: ReturnType<typeof transport> | undefined;
  try {
    client = transport(parsed.data, fetcher, signal);
    return { ok: true, receipt: await client.inspect() };
  } catch (error) { return { ok: false, reason: error instanceof UnsupportedGuest ? "unsupported_guest" : "unavailable" }; }
  finally { client?.close(); }
}

/** Deliver at most one POST. Admission must already durably bind this exact
 * operation, original allocation and encrypted payload, and exclude conflicting
 * lifecycle/model operations. Unknown replies MUST retain that journal/key.
 * Explicit reconciliation reuses the same operation; it never mints a key.
 * This transport has no DB authority and does not activate/revoke managed keys. */
export async function applyGuestLlmApplication(raw: GuestLlmApplication, fetcher = ssrfSafeFetch,
  signal?: AbortSignal): Promise<GuestLlmDelivery> {
  const parsed = Application.safeParse(raw);
  if (!parsed.success) return { status: "not_sent", reason: "invalid_request" };
  const input = parsed.data, expected = expectedGuestLlmReceipt(input);
  let client: ReturnType<typeof transport> | undefined, writeAttempted = false;
  try {
    client = transport(input.target, fetcher, signal);
    const observed = await client.inspect();
    if (matches(observed, expected)) return { status: "applied", receipt: observed, writeAttempted: false };
    if (observed.operationId === input.operationId) return { status: "not_sent", reason: "operation_conflict" };
    if (observed.stateDigest !== input.expectedStateDigest) return { status: "not_sent", reason: "state_conflict" };
    writeAttempted = true;
    const applied = await client.apply(input);
    if (!matches(applied, expected)) throw new Error("Guest receipt mismatch");
    return { status: "applied", receipt: applied, writeAttempted: true };
  } catch (error) {
    return writeAttempted ? { status: "unconfirmed", reason: "delivery_unconfirmed" }
      : { status: "not_sent", reason: error instanceof UnsupportedGuest ? "unsupported_guest" : "unavailable" };
  } finally { client?.close(); }
}
