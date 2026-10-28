// Client-safe calls for Manage's links panel. A 404 means links aren't
// offered on this deployment, and the panel shows nothing.

export type KitState = "delivered" | "pending" | "failed" | "not_needed" | "not_supported" | "waiting_for_agent";

export interface LinksViewData {
  subject: { id: string; kind: "agent" | "computer"; available: boolean; reason?: string };
  links: { id: string; agentId: string; agentName: string; computerId: string; computerName: string; computerKind: string;
    createdAt: string; lastUsedAt: string | null }[];
  candidates: { id: string; name: string; kind: string; status?: string; linked: boolean; available: boolean; reason?: string }[];
  kit?: { state: KitState; message?: string };
}

export type LinksLoad =
  | { state: "not_offered" }
  | { state: "unavailable"; message: string }
  | { state: "ready"; view: LinksViewData };

type Fetcher = typeof fetch;
const resolveFetch = (fetcher?: Fetcher): Fetcher => fetcher ?? ((...args) => fetch(...args));

async function message(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" && payload.error ? payload.error : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchLinks(id: string, fetcher?: Fetcher): Promise<LinksLoad> {
  try {
    const response = await resolveFetch(fetcher)(`/api/hivra/agent-links?id=${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" });
    if (response.status === 404) return { state: "not_offered" };
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: LinksViewData; error?: string } | null;
    if (!response.ok || !payload?.success || !payload.data) {
      return { state: "unavailable", message: payload?.error || "Couldn't load linked computers and agents." };
    }
    return { state: "ready", view: payload.data };
  } catch {
    return { state: "unavailable", message: "Couldn't load linked computers and agents." };
  }
}

export type LinkMutation = { ok: true } | { ok: false; message: string };

async function send(url: string, method: "POST" | "DELETE", body: unknown, fallback: string, fetcher?: Fetcher): Promise<LinkMutation> {
  try {
    const response = await resolveFetch(fetcher)(url, {
      method, credentials: "same-origin", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return response.ok ? { ok: true } : { ok: false, message: await message(response, fallback) };
  } catch {
    return { ok: false, message: fallback };
  }
}

export function addLink(input: { agentId?: string; computerId?: string; all?: boolean; from: "agent" | "computer" }, fetcher?: Fetcher) {
  return send("/api/hivra/agent-links", "POST", input, "Couldn't link them right now. Nothing was changed.", fetcher);
}

export function removeLink(linkId: string, fetcher?: Fetcher) {
  return send(`/api/hivra/agent-links/${encodeURIComponent(linkId)}`, "DELETE", undefined, "Couldn't remove the link right now.", fetcher);
}

export function resendKit(agentId: string, fetcher?: Fetcher) {
  return send("/api/hivra/agent-links", "POST", { sync: true, agentId }, "Couldn't update the agent right now.", fetcher);
}
