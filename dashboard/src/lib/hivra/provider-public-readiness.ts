import "server-only";

import { z } from "zod";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { validateHivraChatOrigin } from "./agent-host-result";

const Input = z.object({ hostname: z.string().min(1).max(253), apiToken: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.enum(["claude", "codex", "aeon", "openclaw", "agent-zero"]) }).strict();

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) throw new Error();
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Read-only public checks for the hostname journaled by named-tunnel creation,
 * never a URL selected by a browser or returned by the guest. Credentials are
 * sent only to that exact HTTPS origin, after its unauthenticated metadata and
 * auth gate match; DNS is checked at connection time and redirects are never followed.
 * A native login/redirect is separate from the user's agent-provider login.
 */
export async function verifyProviderPublicRuntime(raw: z.infer<typeof Input>, fetcher: typeof ssrfSafeFetch = ssrfSafeFetch): Promise<boolean> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const input = Input.parse(structuredClone(raw));
    const origin = validateHivraChatOrigin(`https://${input.hostname}`, input.hostname);
    if (!origin || !checkOutboundUrlSafety(origin).ok) return false;
    const get = async (path: string, authenticated = false, body = false) => {
      const response = await fetcher(origin + path, { method: "GET", redirect: "manual", cache: "no-store", signal: controller.signal,
        headers: authenticated ? { Authorization: `Bearer ${input.apiToken}` } : {} });
      if (controller.signal.aborted || response.redirected) { await response.body?.cancel(); throw new Error(); }
      if (body) return { status: response.status, text: await boundedText(response) };
      await response.body?.cancel();
      return { status: response.status, text: "" };
    };
    const [health, metadata, unauthenticated] = await Promise.all([
      get("/healthz", false, true), get("/api/meta", false, true), get("/api/model"),
    ]);
    const meta: unknown = JSON.parse(metadata.text);
    const summary = z.object({ agentKind: z.literal(input.runtime), surfaceAuth: z.literal("post-cookie-v1") }).safeParse(meta);
    if (health.status !== 200 || health.text !== "ok" || metadata.status !== 200 || !summary.success || unauthenticated.status !== 401) return false;
    const native = { aeon: "/aeon/", openclaw: "/openclaw/", "agent-zero": "/agent-zero/" };
    const nativePath = input.runtime in native ? native[input.runtime as keyof typeof native] : null;
    const [authenticated, terminal, boxTerminal, dashboard] = await Promise.all([
      get("/api/model", true, true), get("/terminal/", true), get("/box-terminal/", true),
      nativePath ? get(nativePath, true) : null,
    ]);
    const model = z.object({ agentKind: z.literal(input.runtime), model: z.string().max(4096).nullable() }).safeParse(JSON.parse(authenticated.text));
    return !controller.signal.aborted && authenticated.status === 200 && model.success
      && terminal.status === 200 && boxTerminal.status === 200
      && (!dashboard || [200, 301, 302, 303, 307, 308, 401, 403].includes(dashboard.status));
  } catch { return false; }
  finally { clearTimeout(timeout); controller.abort(); }
}
