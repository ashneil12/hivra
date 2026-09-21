import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { log } from "@/lib/logger";
import { ensureManagedVeniceWalletAccount } from "@/lib/billing/managed-venice-wallets";
import { generateManagedVenicePlaintextKey, hashManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import { grantManagedVeniceStarterCredit, isManagedVeniceStarterCreditEnabled } from "@/lib/venice/managed-venice-starter-credit";
import { publicLlmConfig, readStoredLlmConfig, VENICE_DIRECT_BASE_URL } from "./agent-llm";
import { validateHivraChatOrigin } from "./agent-host-result";
import { applyGuestLlmApplication, expectedGuestLlmReceipt, inspectGuestLlmApplication,
  type GuestLlmApplication, type GuestLlmDelivery, type GuestLlmTarget } from "./guest-llm-transport";
import { createModelKeyStore, modelKeyBinding, type ModelKeyAgent, type ModelKeyOperation, type ModelKeyStore } from "./model-key-store";
import { ModelKeySelectionSchema as Selection } from "./model-key-selection";
import { readAgentProviderDirectAccess } from "./provider-direct-access";

const Id = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);

export type ModelKeyProblem = "invalid_request" | "not_found" | "computer_not_ready" | "unsupported_runtime"
  | "guest_upgrade_required" | "guest_unavailable" | "operation_conflict" | "pending_change"
  | "stored_setting_unavailable" | "save_unconfirmed" | "configuration_unavailable";
const MESSAGES: Record<ModelKeyProblem, string> = {
  invalid_request: "Check the model settings and API key before saving.",
  not_found: "Computer not found.",
  computer_not_ready: "Wait for the computer to be running and its current operation to finish.",
  unsupported_runtime: "This runtime does not support this model-key delivery path. Its native sign-in is still available.",
  guest_upgrade_required: "This computer needs the model-settings guest update before keys can be changed here.",
  guest_unavailable: "The computer could not confirm its model-settings endpoint. No new key was sent.",
  operation_conflict: "That request belongs to a different change. Refresh the saved model settings.",
  pending_change: "A model change is already pending. Resume that change before submitting another.",
  stored_setting_unavailable: "The saved change could not be safely reconstructed. Its credential evidence has been retained.",
  save_unconfirmed: "The result could not be confirmed. Refresh the saved model settings before submitting another change.",
  configuration_unavailable: "Model-key storage or the selected provider is not configured. No new key was sent.",
};
export class ModelKeyError extends Error {
  constructor(readonly code: ModelKeyProblem) { super(MESSAGES[code]); }
}
export type ModelKeyOutcome = { operationId: string; status: "applied" | "pending"; reason?: string };

function target(a: ModelKeyAgent): GuestLlmTarget {
  if (a.type !== "codex") throw new ModelKeyError("unsupported_runtime");
  const direct = readAgentProviderDirectAccess(a);
  const hostname = direct?.hostname ?? (a.cf_hostname && a.cf_tunnel_id ? a.cf_hostname : null);
  if (a.status !== "running" || a.desired_state !== "running" || a.operation_id || !hostname
    || !a.api_token || !/^[a-f0-9]{64}$/.test(a.api_token)
    || validateHivraChatOrigin(a.chat_url, hostname) !== `https://${hostname}`) {
    throw new ModelKeyError("computer_not_ready");
  }
  return { hostname, apiToken: a.api_token, runtime: "codex" };
}
function requestDigest(token: string, id: string, selection: z.infer<typeof Selection>): string {
  return createHmac("sha256", token).update("hivra-model-request-v1\0" + id + "\0" + JSON.stringify(selection)).digest("hex");
}
function requireScope(userId: string, agentId: string, operationId?: string) {
  if (!userId.trim() || userId.length > 256 || !Id.safeParse(agentId).success
    || (operationId !== undefined && !Id.safeParse(operationId).success)) throw new ModelKeyError("invalid_request");
}

async function prepareManaged(userId: string, encrypt: typeof encryptSecret) {
  const plaintext = generateManagedVenicePlaintextKey();
  const hash = hashManagedVeniceProxyKey(plaintext); // Fail before credit/account side effects if custody is unconfigured.
  const encryptedKey = encrypt(plaintext);
  const account = await ensureManagedVeniceWalletAccount(userId);
  // Keep the existing flag-gated, one-per-owner starter policy. This is not a
  // wallet fallback: the exact selected wallet is always stored and used.
  if (isManagedVeniceStarterCreditEnabled()) {
    try { await grantManagedVeniceStarterCredit({ userId }); }
    catch {
      // Match the existing best-effort starter policy, without logging raw
      // database errors that can contain credential or wallet details.
      log.warn("Model-key starter credit could not be granted", {
        source: "hivra/model-key-coordinator", failureType: "starter_credit_unavailable", userId,
      });
    }
  }
  return { plaintext, encryptedKey, record: { id: randomUUID(), accountId: account.id, hash, prefix: plaintext.slice(0, 14) } };
}
type ManagedCandidate = Awaited<ReturnType<typeof prepareManaged>>;
type Dependencies = {
  store?: ModelKeyStore;
  inspect?: typeof inspectGuestLlmApplication;
  deliver?: (application: GuestLlmApplication, signal: AbortSignal, notAfter: number, wallNotAfter: number) => Promise<GuestLlmDelivery>;
  encrypt?: typeof encryptSecret;
  decrypt?: typeof decryptSecret;
  prepareManaged?: (userId: string) => Promise<ManagedCandidate>;
  managedBaseUrl?: () => string;
};

/** Authenticated routes supply the owner. This coordinator never accepts a
 * browser-supplied computer token, recipient, provider URL or wallet fallback. */
export function createModelKeyCoordinator(deps: Dependencies = {}) {
  const store = deps.store ?? createModelKeyStore();
  const inspect = deps.inspect ?? inspectGuestLlmApplication;
  const encrypt = deps.encrypt ?? encryptSecret, decrypt = deps.decrypt ?? decryptSecret;
  const deliver = deps.deliver ?? ((application, signal, notAfter, wallNotAfter) => applyGuestLlmApplication(application,
    (...args: Parameters<typeof ssrfSafeFetch>) => {
      // Check at EACH network boundary, even if a suspended worker resumes
      // before its queued timeout callback has had a chance to run.
      if (performance.now() >= notAfter || Date.now() >= wallNotAfter) return Promise.reject(new ModelKeyError("computer_not_ready"));
      return ssrfSafeFetch(...args);
    }, signal));
  async function agent(userId: string, agentId: string) {
    const row = await store.agent(userId, agentId);
    if (!row || row.status === "deleted") throw new ModelKeyError("not_found");
    return row;
  }
  function application(a: ModelKeyAgent, j: ModelKeyOperation): GuestLlmApplication {
    try {
      if (!isDeepStrictEqual(j.binding, modelKeyBinding(a))) throw new Error("binding");
      const payload = j.payload ? { ...j.payload, apiKey: decrypt(j.encrypted_key ?? "") } : null;
      const input = { target: target(a), operationId: j.operation_id, expectedStateDigest: j.expected_state_digest, payload };
      if (!isDeepStrictEqual(expectedGuestLlmReceipt(input), j.expected_receipt)) throw new Error("receipt");
      return input;
    } catch { throw new ModelKeyError("stored_setting_unavailable"); }
  }
  async function resume(userId: string, agentId: string, operationId: string): Promise<ModelKeyOutcome> {
    requireScope(userId, agentId, operationId);
    const a = await agent(userId, agentId);
    const original = await store.operation(userId, agentId, operationId);
    if (!original || original.phase === "deleted") throw new ModelKeyError("operation_conflict");
    if (original.phase === "applied") {
      if (!original.is_current) throw new ModelKeyError("operation_conflict");
      return { operationId, status: "applied" };
    }
    target(a);
    application(a, original); // Reject corrupt custody before taking a lease.
    const started = performance.now();
    const lease = await store.claim(userId, agentId, operationId);
    if (!lease) return { operationId, status: "pending", reason: "computer_busy" };
    const input = application(a, lease);
    // Bound by both DB expiry and time since BEFORE the claim request. A slow
    // response or clock skew must never give a delayed worker a fresh window.
    const wallNotAfter = Date.parse(lease.lease_expires_at!) - 500;
    const duration = Math.min(15_000 - (performance.now() - started), wallNotAfter - Date.now());
    if (!Number.isFinite(duration) || duration <= 0) return { operationId, status: "pending", reason: "delivery_window_ended" };
    const notAfter = performance.now() + duration;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), duration);
    let result: GuestLlmDelivery;
    try { result = await deliver(input, controller.signal, notAfter, wallNotAfter); }
    catch { return { operationId, status: "pending", reason: "delivery_unconfirmed" }; }
    finally { clearTimeout(timer); controller.abort(); }
    if (result.status !== "applied") return { operationId, status: "pending", reason: result.reason };
    if (!isDeepStrictEqual(result.receipt, lease.expected_receipt)) return { operationId, status: "pending", reason: "delivery_unconfirmed" };
    // The guest may have applied even if this transaction times out. Keep the
    // same operation; an explicit resume will observe it without another mint.
    let settled = false;
    try { settled = await store.settle(userId, agentId, operationId, lease.lease_id!, result.receipt); }
    catch { /* A lost settlement acknowledgement is not a failed guest write. */ }
    return { operationId, status: settled ? "applied" : "pending", ...(settled ? {} : { reason: "settlement_unconfirmed" }) };
  }
  return {
    async summary(userId: string, agentId: string) {
      requireScope(userId, agentId);
      // Read pending first: settlement atomically removes it and updates the
      // agent. Reading the agent first could pair its old null setting with
      // the now-empty journal and falsely describe native sign-in. A retained
      // pending snapshot is conservative and can safely resume the same ID.
      const pending = await store.operation(userId, agentId), a = await agent(userId, agentId);
      return {
        llm: publicLlmConfig(readStoredLlmConfig(a.llm_config)),
        pending: pending ? { operationId: pending.operation_id, requested: publicLlmConfig(readStoredLlmConfig(pending.config)),
          createdAt: pending.created_at, applying: !!pending.lease_expires_at && Date.parse(pending.lease_expires_at) > Date.now() } : null,
      };
    },
    resume,
    async start(userId: string, agentId: string, operationId: string, raw: unknown): Promise<ModelKeyOutcome> {
      requireScope(userId, agentId, operationId);
      const parsed = Selection.safeParse(raw);
      if (!parsed.success) throw new ModelKeyError("invalid_request");
      const selection = parsed.data, a = await agent(userId, agentId), recipient = target(a);
      const binding = modelKeyBinding(a), digest = requestDigest(recipient.apiToken, operationId, selection);
      const existing = await store.operation(userId, agentId, operationId);
      if (existing) {
        if (existing.request_digest !== digest) throw new ModelKeyError("operation_conflict");
        return resume(userId, agentId, operationId);
      }
      if (await store.operation(userId, agentId)) throw new ModelKeyError("pending_change");
      let baseUrl: string | null = null;
      try {
        baseUrl = selection ? (selection.mode === "managed"
          ? (deps.managedBaseUrl ?? getManagedVeniceProxyBaseUrl)() : VENICE_DIRECT_BASE_URL).replace(/\/+$/, "") : null;
        // Validate all non-secret payload fields before generating a managed
        // credential or creating/granting anything in the owner's wallet.
        expectedGuestLlmReceipt({ target: recipient, operationId, expectedStateDigest: "0".repeat(64),
          payload: selection ? { provider: "venice", baseUrl: baseUrl!, model: selection.model, apiKey: "configuration-check" } : null });
      } catch { throw new ModelKeyError("configuration_unavailable"); }
      const observed = await inspect(recipient);
      if (!observed.ok) throw new ModelKeyError(observed.reason === "unsupported_guest" ? "guest_upgrade_required" : "guest_unavailable");
      let config: Record<string, unknown> | null = null, payload: GuestLlmApplication["payload"] = null;
      let encryptedKey: string | null = null, managedKey: ManagedCandidate["record"] | null = null;
      if (selection) {
        try {
          let plaintext: string;
          if (selection.mode === "managed") {
            const candidate = await (deps.prepareManaged ?? ((owner: string) => prepareManaged(owner, encrypt)))(userId);
            plaintext = candidate.plaintext; encryptedKey = candidate.encryptedKey; managedKey = candidate.record;
            config = { provider: "venice", mode: "managed", model: selection.model,
              proxyKeyId: managedKey.id, keyPrefix: managedKey.prefix, walletType: selection.walletType };
          } else {
            plaintext = selection.apiKey; encryptedKey = encrypt(plaintext);
            config = { provider: "venice", mode: "byok", model: selection.model };
          }
          payload = { provider: "venice", baseUrl: baseUrl!, model: selection.model, apiKey: plaintext };
        } catch { throw new ModelKeyError("configuration_unavailable"); }
      }
      const expectedReceipt = expectedGuestLlmReceipt({ target: recipient, operationId,
        expectedStateDigest: observed.receipt.stateDigest, payload });
      let result: string;
      try {
        result = await store.admit(userId, agentId, operationId, binding, { requestDigest: digest, config,
          payload: payload ? { provider: payload.provider, baseUrl: payload.baseUrl, model: payload.model } : null,
          encryptedKey, managedKey, expectedStateDigest: observed.receipt.stateDigest, expectedReceipt });
      } catch { throw new ModelKeyError("save_unconfirmed"); }
      if (result === "pending" || result === "applied") return resume(userId, agentId, operationId);
      if (result === "pending_conflict") throw new ModelKeyError("pending_change");
      if (result === "not_ready" || result === "target_changed") throw new ModelKeyError("computer_not_ready");
      if (result === "not_found") throw new ModelKeyError("not_found");
      throw new ModelKeyError(result === "invalid_request" ? "invalid_request" : "operation_conflict");
    },
  };
}
