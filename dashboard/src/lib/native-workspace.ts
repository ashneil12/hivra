import type { DashboardResource } from "@/components/layout/dashboard-resources";

export type NativeWorkspaceMessage = {
  version: 1;
  kind: "workspace";
  ownerKey: string | null;
  resources: DashboardResource[];
  loading: boolean;
  errors: { hermes: string | null; hivra: string | null };
} | {
  version: 1;
  kind: "surfaces";
  pathname: string;
  active: string;
  surfaces: { id: string; label: string }[];
};

type WorkspaceHandler = { postMessage: (message: NativeWorkspaceMessage) => void };
type NativeWorkspaceWindow = Window & {
  __HIVRA_NATIVE_WORKSPACE__?: { version?: unknown };
  webkit?: { messageHandlers?: { hivraWorkspace?: WorkspaceHandler } };
};

/** The native host injects this capability only into its exact trusted origin.
 * The marker alone (including in an ordinary browser) never enables the bridge.
 * The host independently checks the origin and main frame on every message. */
export function nativeWorkspaceHandler(): WorkspaceHandler | null {
  if (typeof window === "undefined" || window !== window.top) return null;
  const host = window as NativeWorkspaceWindow;
  const handler = host.webkit?.messageHandlers?.hivraWorkspace;
  return host.__HIVRA_NATIVE_WORKSPACE__?.version === 1 && typeof handler?.postMessage === "function"
    ? handler : null;
}

export function postNativeWorkspace(message: NativeWorkspaceMessage): void {
  try { nativeWorkspaceHandler()?.postMessage(message); }
  catch { /* A disconnected native window must not interrupt the work surface. */ }
}

/** Keep native shell state to catalog metadata; never spread an API object. */
export function workspaceMetadata(resources: DashboardResource[]): DashboardResource[] {
  return resources.map(({ uid, id, source, kind, name, description, status, href }) => ({
    uid, id, source, kind, name, description, status, href,
  }));
}

export function clearNativeWorkspace(): void {
  postNativeWorkspace({ version: 1, kind: "workspace", ownerKey: null, resources: [], loading: false,
    errors: { hermes: null, hivra: null } });
}

/** App-owned navigation still crosses a trust boundary. Return only a canonical
 * local dashboard route: no guest URLs, credentials, fragments or auth queries. */
export function nativeDashboardHref(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\#]/u.test(value)) return null;
  if (!value.startsWith("/") && !/^https?:\/\//.test(value)) return null;
  if (value.startsWith("//")) return null;
  try {
    // Validate before URL normalization, which otherwise conceals traversal.
    const rawPath = value.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const decoded = decodeURIComponent(rawPath).replace(/\/$/, "");
    // Encoded separators and repeated decoding differ across routers/servers.
    if (/%(?:2f|5c)/i.test(rawPath) || decoded.includes("%") || /[\\\s#?]/u.test(decoded)
      || [...decoded].some(char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159))
      || decoded.split("/").slice(1).some(part => !part || part === "." || part === "..")) return null;
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    const pathname = decoded.split("/").map(part => encodeURIComponent(part)).join("/");
    if (pathname !== "/dashboard" && !pathname.startsWith("/dashboard/")) return null;
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) return null;
    if (keys.length === 0) return pathname;
    if (pathname === "/dashboard/launch" && keys.length === 2 && keys.includes("kind") && keys.includes("start")) {
      const kind = url.searchParams.get("kind");
      return (kind === "agent" || kind === "computer") && url.searchParams.get("start") === "1"
        ? `${pathname}?kind=${kind}&start=1` : null;
    }
    const tab = url.searchParams.get("tab");
    if (/^\/dashboard\/agent\/[^/]+$/.test(pathname) && keys.length === 2
      && keys.includes("tab") && keys.includes("open")) {
      const open = url.searchParams.get("open");
      return tab === "desktop" && (open === "fast" || open === "native")
        ? `${pathname}?tab=desktop&open=${open}` : null;
    }
    return pathname !== "/dashboard/launch" && keys.length === 1 && keys[0] === "tab" && tab && /^[a-z][a-z0-9_-]{0,63}$/.test(tab)
      ? `${pathname}?tab=${tab}` : null;
  } catch { return null; }
}
