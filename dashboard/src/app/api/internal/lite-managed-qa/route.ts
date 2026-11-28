import { randomUUID, timingSafeEqual } from "node:crypto";

import { getExistingFundedManagedVeniceCardWallet } from "@/lib/billing/managed-venice-wallets";
import { readCanaryLiteManagedQaConfig } from "@/lib/lite-agents/canary-qa";
import {
  liteSignatureHeaders,
  LITE_MANAGED_QA_CALLBACK_PATH,
  LITE_MANAGED_QA_MAX_PROMPT,
  LITE_MANAGED_QA_SIGNATURE_VERSION,
} from "@/lib/lite-agents/signing";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { materializeLiteCanaryManagedQaKey } from "@/lib/venice/proxy-keys";
import { handleManagedVeniceChat } from "@/lib/venice/proxy-chat-route";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BODY_BYTES = 8 * 1024;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const respond = (status: number, body: { error: string } | { text: string }) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function readBody(request: Request): Promise<string | null> {
  if (!request.body || Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "";
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return raw + decoder.decode();
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      raw += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const hidden = () => respond(404, { error: "not_found" });
  const ownerId = request.headers.get("x-hivra-account") ?? "";
  const timestamp = request.headers.get("x-hivra-timestamp") ?? "";
  const signature = request.headers.get("x-hivra-signature") ?? "";
  if (!/^user_[A-Za-z0-9]{1,120}$/.test(ownerId) || !/^\d{1,12}$/.test(timestamp) ||
      !/^[0-9a-f]{64}$/.test(signature) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return hidden();
  const config = await readCanaryLiteManagedQaConfig(ownerId);
  if (!config || !supabaseAdmin) return hidden();
  const raw = await readBody(request).catch(() => null);
  if (raw === null) return respond(413, { error: "body_too_large" });
  const expected = liteSignatureHeaders(config.secret, "POST", LITE_MANAGED_QA_CALLBACK_PATH, ownerId, raw,
    Number(timestamp) * 1000, LITE_MANAGED_QA_SIGNATURE_VERSION)["x-hivra-signature"];
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) return hidden();

  let input: { requestId?: unknown; content?: unknown } | null;
  try {
    input = JSON.parse(raw);
  } catch {
    return respond(400, { error: "invalid_managed_request" });
  }
  const { requestId, content } = input ?? {};
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) ||
      typeof content !== "string" || !content.trim() || content.length > LITE_MANAGED_QA_MAX_PROMPT) {
    return respond(400, { error: "invalid_managed_request" });
  }

  if (config.mode === "trusted_permit" && config.expiresAt <= Date.now()) return hidden();
  try {
    const referenceId = randomUUID();
    const { error } = await supabaseAdmin.from("hivra_canary_lite_managed_qa_requests")
      .insert({ owner_id: ownerId, request_id: requestId, reference_id: referenceId });
    if (error?.code === "23505") return respond(409, { error: "managed_request_already_used" });
    if (error) throw new Error("lite_managed_qa_claim_failed");
    const liteCanaryQa = { ownerId, proxyKeyId: config.proxyKeyId };
    let credentials: Pick<Parameters<typeof handleManagedVeniceChat>[0], "plaintextKey" | "liteCanaryQa">;
    if (config.mode === "trusted_permit") {
      const accountId = await getExistingFundedManagedVeniceCardWallet(ownerId);
      if (!accountId) return respond(402, { error: "managed_credits_required" });
      const current = await readCanaryLiteManagedQaConfig(ownerId);
      if (current?.mode !== "trusted_permit" || current.gitSha !== config.gitSha ||
          current.proxyKeyId !== config.proxyKeyId || current.signerSha256 !== config.signerSha256 ||
          current.expiresAt !== config.expiresAt || current.workerOrigin !== config.workerOrigin ||
          current.model !== config.model) return hidden();
      const permitKey = await materializeLiteCanaryManagedQaKey(current, accountId);
      if (!permitKey) return hidden();
      credentials = { plaintextKey: null, liteCanaryQa: { ...liteCanaryQa, permitKey } };
    } else {
      credentials = { plaintextKey: config.proxyKey, liteCanaryQa };
    }
    const managed = await handleManagedVeniceChat({
      ...credentials,
      referenceId,
      body: { model: config.model, stream: false, max_tokens: 128, messages: [{ role: "user", content }] },
    });
    if (managed.status === 402) return respond(402, { error: "managed_credits_required" });
    if (!managed.ok) return respond(502, { error: "managed_reply_failed" });
    const reply = await managed.json().catch(() => null);
    const text: unknown = reply?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return respond(502, { error: "managed_reply_failed" });
    return respond(200, { text: text.trim() });
  } catch {
    log.warn("Lite managed Canary QA request failed", {
      source: "lite-canary-qa", failureType: "lite_managed_qa_request_failed",
    });
    return respond(502, { error: "managed_reply_failed" });
  }
}
