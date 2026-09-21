import "server-only";

import { z } from "zod";
import { directSslipSafeFetch, ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { parseProviderDesktopAccess, type ProviderDesktopAccess } from "@/lib/infrastructure/provider-desktop-launch-contract";

const Meta = z.object({ agentKind: z.literal("linux-desktop"), resourceKind: z.literal("computer"),
  chatAvailable: z.literal(false), loginAvailable: z.literal(false), workspace: z.literal("Hivra"), surfaceAuth: z.literal("post-cookie-v1") });
type Input = { access: ProviderDesktopAccess; controlOrigin: string };

async function text(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error();
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Public ingress and unauthenticated access-gate checks only. No session is
 * minted, no controller lease is taken, and no credentials are sent. Running
 * computers still need the normal owner/PKCE broker flow for desktop access;
 * this is not authenticated session or rendering acceptance. */
export async function verifyProviderDesktopPublicRuntime(raw: Input, fetcher: typeof ssrfSafeFetch = ssrfSafeFetch,
  directFetcher: typeof directSslipSafeFetch = directSslipSafeFetch): Promise<boolean> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const input = structuredClone(raw), access = parseProviderDesktopAccess(input.access);
    const control = new URL(input.controlOrigin);
    if (control.protocol !== "https:" || control.origin !== input.controlOrigin || !checkOutboundUrlSafety(control.origin).ok) return false;
    const origin = `https://${access.hostname}`, transport = access.mode === "direct-https" ? directFetcher : fetcher;
    if (!checkOutboundUrlSafety(origin).ok) return false;
    const request = async (path: string, limit = 0) => {
      const response = await transport(origin + path, { method: "GET", redirect: "manual", credentials: "omit",
        cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted || response.redirected || (response.url && response.url !== origin + path)) {
        await response.body?.cancel(); throw new Error();
      }
      const body = limit ? await text(response, limit) : "";
      if (!limit) await response.body?.cancel();
      return { status: response.status, headers: response.headers, body };
    };
    const [health, metadata, handoff, root, media] = await Promise.all([
      request("/healthz", 4096), request("/api/meta", 4096), request("/desktop/handoff", 128 * 1024), request("/"),
      request("/desktop/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/"),
    ]);
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors ${control.origin}`;
    // Public ingress is the Hivra gateway, not the broker's private port: its
    // health is plain text and a computer deliberately has no root chat page.
    // Keep the broker framing requirement even if an older gateway strips it.
    return !controller.signal.aborted && health.status === 200 && health.body === "ok"
      && metadata.status === 200 && Meta.safeParse(JSON.parse(metadata.body)).success
      && handoff.status === 200 && /^text\/html(?:;|$)/i.test(handoff.headers.get("content-type") ?? "")
      && handoff.headers.get("content-security-policy") === csp
      && handoff.headers.get("cache-control") === "private, no-store"
      && handoff.headers.get("referrer-policy") === "no-referrer"
      && handoff.headers.get("x-content-type-options") === "nosniff"
      && handoff.body.includes(`const CONTROL_ORIGIN=${JSON.stringify(control.origin)};`)
      && handoff.body.includes("hivra.remote-desktop.handoff.v2")
      && root.status === 404 && media.status === 401
      && [health, metadata, handoff, root, media].every(result => !result.headers.has("set-cookie"));
  } catch { return false; }
  finally { clearTimeout(timeout); controller.abort(); }
}
