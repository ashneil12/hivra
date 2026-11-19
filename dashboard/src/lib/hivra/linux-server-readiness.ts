import "server-only";

import { z } from "zod";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";

/** What a Linux computer without a desktop (profile `ubuntu-server`) says about
 * itself on its public gateway. It has a terminal and files, no chat and no
 * login, and it is never the linux-desktop kind. */
const Meta = z.object({
  agentKind: z.literal("linux-server"),
  resourceKind: z.literal("computer"),
  surfaceAuth: z.literal("post-cookie-v1"),
}).passthrough();

const META_LIMIT = 16 * 1024;
const META_TIMEOUT_MS = 8000;

export const LINUX_SERVER_WRONG_KIND_MESSAGE =
  "This computer's connection service reported the wrong kind of computer, so Hivra did not mark it ready. Delete it and launch again.";

export type LinuxServerReadinessVerdict =
  | { ok: true }
  /** The gateway answered, and what it said is not this kind of computer. The
   * operation must fail: waiting will not change the answer. */
  | { ok: false; retryable: false; failureCode: "wrong_kind"; ownerMessage: string }
  /** No usable answer yet (network, status, size or shape). The computer is
   * not marked ready, and the next check tries again. */
  | { ok: false; retryable: true; failureCode: "meta_unavailable" };

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("body_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Readiness for a Linux computer without a desktop: its gateway's public
 * `/api/meta` must answer as a `linux-server` computer. It needs no desktop
 * capability receipt, because it has no desktop. Nothing is sent but a GET, and
 * no credential or session is used.
 *
 * `chatUrl` is the host-validated gateway origin (named tunnel hostname).
 */
export async function verifyLinuxServerPublicRuntime(
  chatUrl: string,
  fetcher: typeof ssrfSafeFetch = ssrfSafeFetch,
): Promise<LinuxServerReadinessVerdict> {
  const unavailable = { ok: false, retryable: true, failureCode: "meta_unavailable" } as const;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    const origin = new URL(chatUrl);
    if (origin.protocol !== "https:" || origin.origin !== chatUrl || !checkOutboundUrlSafety(origin.origin).ok) return unavailable;
    const url = `${origin.origin}/api/meta`;
    const response = await fetcher(url, {
      method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal,
    });
    if (controller.signal.aborted || response.redirected || response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return unavailable;
    }
    const body: unknown = JSON.parse(await boundedText(response, META_LIMIT));
    if (Meta.safeParse(body).success) return { ok: true };
    // Only a gateway that names its own kind can be the wrong kind; anything
    // else is not a usable answer yet.
    const named = typeof body === "object" && body !== null && typeof (body as { agentKind?: unknown }).agentKind === "string";
    return named
      ? { ok: false, retryable: false, failureCode: "wrong_kind", ownerMessage: LINUX_SERVER_WRONG_KIND_MESSAGE }
      : unavailable;
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
