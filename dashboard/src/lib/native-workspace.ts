import type { DashboardResource } from "@/components/layout/dashboard-resources";
import { normalizeNativeDashboardRoute } from "@/lib/native-route-grammar";

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
 * local dashboard route (native-route-grammar): a root-relative /dashboard path
 * with no guest URLs, credentials, fragments or unrecognized queries. */
export function nativeDashboardHref(value: unknown): string | null {
  return typeof value === "string" ? normalizeNativeDashboardRoute(value) : null;
}
