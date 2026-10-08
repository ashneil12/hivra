export type ChatReadiness = "provider_configured" | "native_connected" | "sign_in_required" | "upgrade_required" | "unavailable";

/** The runtime's own sign-in state. Never rejects: any failure is unavailable. */
async function inspectNativeLogin(base: string, options: RequestInit): Promise<ChatReadiness> {
  try {
    const response = await fetch(`${base}/api/login/status`, options);
    if (!response.ok) return "unavailable";
    const state = await response.json();
    return state?.loggedIn === true ? "native_connected" : state?.loggedIn === false ? "sign_in_required" : "unavailable";
  } catch { return "unavailable"; }
}

/** Inspect the running computer, not the saved control-plane summary. A
 * configured provider allows a first message; it is not proof of inference. */
export async function inspectChatReadiness(boxUrl: string, kind: string, token?: string | null): Promise<ChatReadiness> {
  const base = boxUrl.replace(/\/$/, "");
  try {
    const options = { cache: "no-store" as const, headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      redirect: "error" as const, signal: AbortSignal.timeout(10000) };
    if (kind !== "codex") return await inspectNativeLogin(base, options);
    // Codex asks both questions at once, so opening the page waits for one
    // round trip to the computer instead of two. The sign-in answer counts
    // only when no alternative provider is configured.
    const provider = fetch(`${base}/api/llm`, options);
    const nativeLogin = inspectNativeLogin(base, options);
    const response = await provider;
    // A reachable guest that returns 404 here predates the live provider
    // capability entirely. That is a deterministic upgrade boundary, not an
    // unknown connection failure. Authentication and transient server
    // failures remain unavailable so they are never misrepresented as an
    // outdated runtime.
    if (response.status === 404) return "upgrade_required";
    if (!response.ok) return "unavailable";
    const state = await response.json();
    if (!state || state.agentKind !== "codex") return "unavailable";
    // Earlier guests can store the key but still spawn Codex with the removed
    // Chat Completions protocol. Presence alone is not a usable connection.
    if (state.provider === "venice") return state.providerChatProtocol === "responses-v1" ? "provider_configured" : "upgrade_required";
    if (state.provider !== null) return "unavailable";
    return await nativeLogin;
  } catch { return "unavailable"; }
}
