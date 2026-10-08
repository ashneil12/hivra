import "server-only";

import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";

// Whether a computer's gateway can serve an agent added to it (design 5.4,
// 5.8). The gateway says so in its public metadata from provisioner release
// 2026.09.24.3 on (`attachedAgents: "hivra-attached-agent-v1"`). A computer
// made before that keeps its older gateway until its owner runs Manage →
// Update connection service: bundle sync never replaces a running computer's gateway.
// Adding Codex there would be refused by the computer after the download, so
// the gate says it first. This is the gate's early answer, not authority: the
// computer checks its own gateway again before it starts anything.

export const ATTACHED_AGENTS_PROTOCOL = "hivra-attached-agent-v1";
const DEADLINE_MS = 5_000;
const MAX_BYTES = 8192;

/** current: the gateway serves attached agents. update_required: it answered
 * and does not. unavailable: it did not answer (the claim and the computer judge). */
export type AttachedGatewayProtocol = "current" | "update_required" | "unavailable";

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

/** Reads GET <chat_url origin>/api/meta without credentials; never follows a redirect. */
export async function readAttachedGatewayProtocol(chatUrl: string | null | undefined,
  fetcher: typeof ssrfSafeFetch = ssrfSafeFetch): Promise<AttachedGatewayProtocol> {
  if (typeof chatUrl !== "string" || chatUrl.length > 2048) return "unavailable";
  let origin: string;
  try {
    const parsed = new URL(chatUrl.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "unavailable";
    origin = parsed.origin;
  } catch { return "unavailable"; }
  if (!checkOutboundUrlSafety(origin).ok) return "unavailable";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const response = await fetcher(`${origin}/api/meta`, { method: "GET", redirect: "manual", cache: "no-store",
      credentials: "omit", headers: { Accept: "application/json" }, signal: controller.signal });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      return "unavailable";
    }
    const meta = await boundedJson(response);
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "unavailable";
    const record = meta as Record<string, unknown>;
    return record.resourceKind === "computer" && record.attachedAgents === ATTACHED_AGENTS_PROTOCOL ? "current" : "update_required";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}
