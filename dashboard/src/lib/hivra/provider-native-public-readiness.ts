import "server-only";

import { z } from "zod";
import { directSslipSafeFetch, ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { parseProviderNativeAccess, type ProviderNativeAccess } from "@/lib/infrastructure/provider-native-worker";

type Input = { access: ProviderNativeAccess; sessionCookie: string };
const Meta = z.object({ agentKind: z.literal("deepseek-harness"), surfaceAuth: z.literal("post-cookie-v1"),
  nativeSurface: z.literal("/"), nativeReady: z.literal(true) });

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  let size = 0;
  const chunks: Uint8Array[] = [];
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

function checkedSessionCookie(value: unknown): string {
  return z.string().regex(/^__Host-hivra_auth=[a-f0-9]{64}$/).parse(value);
}

/** Private readiness probe for the immutable native access binding. It checks
 * the actual cookie-authenticated document and terminal HTTP surfaces, not the
 * legacy /api/model contract. NOT browser-rendering, tools or model-reply proof.
 *
 * The pinned local SSH probe must mint and return the opaque guest session only
 * after verifying the root-owned service. This function never receives or sends
 * the management bearer/model key, and never creates a second session. No
 * redirects/retries, external body-selected routes or credentials in a URL.
 * Caller retains the original lifecycle operation and rechecks it before CAS.
 */
export async function verifyProviderNativePublicRuntime(raw: Input, fetcher: typeof ssrfSafeFetch = ssrfSafeFetch,
  directFetcher: typeof directSslipSafeFetch = directSslipSafeFetch): Promise<boolean> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const input = structuredClone(raw), access = parseProviderNativeAccess(input.access), cookie = checkedSessionCookie(input.sessionCookie);
    const origin = `https://${access.hostname}`, transport = access.mode === "direct-https" ? directFetcher : fetcher;
    if (!checkOutboundUrlSafety(origin).ok) return false;
    const request = async (path: string, options: RequestInit = {}, limit = 0) => {
      const response = await transport(origin + path, { ...options, method: options.method ?? "GET", redirect: "manual",
        credentials: "omit", cache: "no-store", signal: controller.signal, headers: options.headers ?? {} });
      if (controller.signal.aborted || response.redirected || (response.url && response.url !== origin + path)) {
        await response.body?.cancel(); throw new Error();
      }
      const text = limit ? await boundedText(response, limit) : "";
      if (!limit) await response.body?.cancel();
      return { status: response.status, headers: response.headers, text };
    };
    // All public contracts and unauthenticated native/shell gates must agree
    // before relaying the opaque, least-privilege browser session.
    const [health, metadata, rootGate, terminalGate, boxGate, vncGate] = await Promise.all([
      request("/healthz", {}, 8192), request("/api/meta", {}, 8192), request("/"),
      request("/terminal/"), request("/box-terminal/"), request("/vnc/"),
    ]);
    if (health.status !== 200 || health.text !== "ok" || metadata.status !== 200 || !Meta.safeParse(JSON.parse(metadata.text)).success
      || [rootGate, terminalGate, boxGate, vncGate].some(result => result.status !== 401)
      || [health, metadata, rootGate, terminalGate, boxGate, vncGate].some(result => result.headers.has("set-cookie"))) return false;
    const headers = { Cookie: cookie, Origin: origin };
    const [native, terminal, boxTerminal, vnc, management] = await Promise.all([
      request("/", { headers }, 1024 * 1024), request("/terminal/", { headers }), request("/box-terminal/", { headers }),
      request("/vnc/", { headers }), request("/api/browser/status", { headers }),
    ]);
    // Keep the native session distinct from computer-management authority.
    // The base tag is the pinned upstream document contract, not render proof.
    return !controller.signal.aborted && native.status === 200 && terminal.status === 200 && boxTerminal.status === 200 && vnc.status === 200
      && management.status === 401 && /^text\/html(?:;|$)/i.test(native.headers.get("content-type") ?? "")
      && /<base\s+href=["']\/["']\s*\/?\s*>/i.test(native.text)
      && [native, terminal, boxTerminal, vnc, management].every(result => !result.headers.has("set-cookie"))
      && !native.text.includes(cookie.slice(cookie.indexOf("=") + 1));
  } catch { return false; }
  finally { clearTimeout(timeout); controller.abort(); }
}
