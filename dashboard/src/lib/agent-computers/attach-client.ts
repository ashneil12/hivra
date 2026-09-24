// Browser calls for adding an agent to a computer (design 5.8). Each mutation
// is one request with its own request id, reused when the same review is
// sent again, so a double click or a retry is the same claim, never a second
// install. Client-safe.

import type { AttachGateView } from "./attach-routes";
import type { AttachGrants } from "./attach-plan";

export type AttachGate = AttachGateView;
export type AttachGateAttachment = AttachGateView["attachments"][number];

export type AttachGateResult =
  | { state: "ready"; gate: AttachGate }
  /** Attach is not offered on this deployment, or this is not the owner's computer. */
  | { state: "not_offered" }
  | { state: "unavailable"; message: string };

/** The browser's fetch, looked up when a call is made, never at import. */
function resolveFetch(fetcher?: typeof fetch): typeof fetch | null {
  return fetcher ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
}

async function readJson(response: Response): Promise<{ success?: boolean; data?: unknown; error?: string } | null> {
  try { return await response.json(); } catch { return null; }
}

export async function fetchAttachGate(computerId: string, fetcher?: typeof fetch): Promise<AttachGateResult> {
  const request = resolveFetch(fetcher);
  if (!request) return { state: "unavailable", message: "Couldn't check what this computer can take." };
  try {
    const response = await request(`/api/hivra/computers/${encodeURIComponent(computerId)}/agents`, { cache: "no-store" });
    if (response.status === 404) return { state: "not_offered" };
    const payload = await readJson(response);
    if (!response.ok || payload?.success !== true || !payload.data) {
      return { state: "unavailable", message: payload?.error || "Couldn't check what this computer can take." };
    }
    return { state: "ready", gate: payload.data as AttachGate };
  } catch {
    return { state: "unavailable", message: "Couldn't check what this computer can take." };
  }
}

export type AttachMutationResult = { ok: true; operationId: string } | { ok: false; status: number; message: string; reason?: string };

async function mutate(url: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>,
  fetcher?: typeof fetch): Promise<AttachMutationResult> {
  const request = resolveFetch(fetcher);
  if (!request) return { ok: false, status: 0, message: "Couldn't reach Hivra. Nothing was changed." };
  try {
    const response = await request(url, { method, credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await readJson(response);
    const data = payload?.data as { operationId?: unknown } | undefined;
    if (response.status === 202 && payload?.success === true && typeof data?.operationId === "string") {
      return { ok: true, operationId: data.operationId };
    }
    const reason = typeof (payload as { reason?: unknown } | null)?.reason === "string" ? (payload as { reason: string }).reason : undefined;
    return { ok: false, status: response.status, message: payload?.error || "This step could not be started. Nothing was changed.", reason };
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach Hivra. Nothing was changed." };
  }
}

export function addAgentToComputer(computerId: string, input: { grants: AttachGrants; reviewSha256: string; requestId: string },
  fetcher?: typeof fetch) {
  return mutate(`/api/hivra/computers/${encodeURIComponent(computerId)}/agents`, "POST",
    { grants: { workspace: input.grants.workspace }, reviewSha256: input.reviewSha256, requestId: input.requestId }, fetcher);
}

export function changeAttachedAgentAccess(computerId: string, attachmentId: string,
  input: { grants: AttachGrants; reviewSha256: string; requestId: string }, fetcher?: typeof fetch) {
  return mutate(`/api/hivra/computers/${encodeURIComponent(computerId)}/agents/${encodeURIComponent(attachmentId)}`, "PATCH",
    { grants: { workspace: input.grants.workspace }, reviewSha256: input.reviewSha256, requestId: input.requestId }, fetcher);
}

export function removeAttachedAgent(computerId: string, attachmentId: string, input: { reviewSha256: string; requestId: string },
  fetcher?: typeof fetch) {
  return mutate(`/api/hivra/computers/${encodeURIComponent(computerId)}/agents/${encodeURIComponent(attachmentId)}`, "DELETE",
    { reviewSha256: input.reviewSha256, requestId: input.requestId }, fetcher);
}

export interface OwnerAttachedAgentRow {
  id: string;
  phase: "claimed" | "dispatched" | "attached";
  agentName: string;
  computerId: string;
  computerName: string;
  computerStatus: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The owner's agents added to their computers, whether attach is offered here
 * at all, and which of their computers can take one (the server decides). */
export async function fetchOwnerAttachedAgents(fetcher?: typeof fetch):
Promise<{ enabled: boolean; agents: OwnerAttachedAgentRow[]; eligibleComputerIds: string[] } | null> {
  const request = resolveFetch(fetcher);
  if (!request) return null;
  try {
    const response = await request("/api/hivra/attached-agents", { cache: "no-store" });
    if (response.status === 404) return { enabled: false, agents: [], eligibleComputerIds: [] };
    const payload = await readJson(response);
    const data = payload?.data as { enabled?: unknown; agents?: unknown; eligibleComputerIds?: unknown } | undefined;
    if (!response.ok || payload?.success !== true || !Array.isArray(data?.agents)) return null;
    const eligible = Array.isArray(data.eligibleComputerIds)
      ? data.eligibleComputerIds.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [];
    return { enabled: data?.enabled === true, agents: data.agents as OwnerAttachedAgentRow[], eligibleComputerIds: eligible };
  } catch {
    return null;
  }
}

/** Hosts a device sign-in link from an attached agent may point at (T28). */
export const TRUSTED_SIGN_IN_HOSTS = Object.freeze(["auth.openai.com", "chatgpt.com", "platform.openai.com"]);

export function isTrustedSignInLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && TRUSTED_SIGN_IN_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}
