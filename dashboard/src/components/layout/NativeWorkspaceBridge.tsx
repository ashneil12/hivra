"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { clearNativeWorkspace, nativeDashboardHref, nativeWorkspaceHandler, postNativeWorkspace, workspaceMetadata } from "@/lib/native-workspace";
import { useDashboardResources } from "./useDashboardResources";

const NativeWorkspaceContext = createContext({ enabled: false, pathname: "", ownerKey: null as string | null, clearSurfaces: () => {} });
const subscribe = () => () => {};
const nativeSnapshot = () => Boolean(nativeWorkspaceHandler());
const serverSnapshot = () => false;

export function useNativeWorkspaceEnabled() {
  return useSyncExternalStore(subscribe, nativeSnapshot, serverSnapshot);
}

export function useNativeWorkspace() { return useContext(NativeWorkspaceContext); }

function clearSurfaces(pathname: string) {
  postNativeWorkspace({ version: 1, kind: "surfaces", pathname, active: "", surfaces: [] });
}

function NativeResources({ ownerKey, pathname }: { ownerKey: string; pathname: string }) {
  const { resources, loading, errors, refresh } = useDashboardResources(ownerKey, pathname);
  useEffect(() => {
    postNativeWorkspace({ version: 1, kind: "workspace", ownerKey, resources: workspaceMetadata(resources), loading,
      errors: { hermes: errors.hermes, hivra: errors.hivra } });
  }, [ownerKey, resources, loading, errors.hermes, errors.hivra]);
  useEffect(() => {
    const handleRefresh = (event: Event) => {
      if (!nativeWorkspaceHandler()) return;
      event.preventDefault();
      refresh();
    };
    window.addEventListener("hivra:refresh", handleRefresh);
    window.addEventListener("pageshow", handleRefresh);
    return () => {
      window.removeEventListener("hivra:refresh", handleRefresh);
      window.removeEventListener("pageshow", handleRefresh);
    };
  }, [refresh]);
  return null;
}

export function NativeWorkspaceProvider({ enabled, pathname, ownerKey, children }: {
  enabled: boolean; pathname: string | null; ownerKey: string; children: ReactNode;
}) {
  // Both Clerk and the existing self-host auth shim expose this identity. Never
  // read, forward or persist a token, and never attribute an old server tree to
  // a newly switched client account.
  const auth = useAuth();
  const router = useRouter();
  const authenticatedOwner = auth.isLoaded && auth.isSignedIn && auth.userId === ownerKey ? ownerKey : null;
  const route = pathname ?? "/dashboard";
  const currentRoute = useRef(route);
  const clearCurrentSurfaces = useCallback(() => clearSurfaces(currentRoute.current), []);
  const value = useMemo(() => ({ enabled, pathname: route, ownerKey: authenticatedOwner, clearSurfaces: clearCurrentSurfaces }), [enabled, route, authenticatedOwner, clearCurrentSurfaces]);

  useLayoutEffect(() => {
    currentRoute.current = route;
    if (!enabled) return;
    // Layout phase runs before a newly mounted surface advertises its controls.
    clearSurfaces(route);
    if (auth.isLoaded && !authenticatedOwner) clearNativeWorkspace();
  }, [enabled, route, auth.isLoaded, authenticatedOwner]);

  useEffect(() => {
    if (!enabled) return;
    // A document reload or closing one retained web view is not account signout.
    // Only the loaded auth state above can invalidate all native resource tabs.
    window.addEventListener("pagehide", clearCurrentSurfaces);
    return () => { window.removeEventListener("pagehide", clearCurrentSurfaces); clearCurrentSurfaces(); };
  }, [enabled, clearCurrentSurfaces]);

  useEffect(() => {
    if (!enabled || !authenticatedOwner) return;
    const navigate = (event: Event) => {
      if (!nativeWorkspaceHandler()) return;
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const href = nativeDashboardHref((detail as { href?: unknown }).href, window.location.origin);
      if (href) {
        // The native caller dispatches a cancelable event: cancellation confirms
        // that React accepted it; an absent listener permits a normal URL load.
        event.preventDefault();
        router.push(href);
      }
    };
    window.addEventListener("hivra:navigate", navigate);
    return () => window.removeEventListener("hivra:navigate", navigate);
  }, [enabled, authenticatedOwner, router]);

  return <NativeWorkspaceContext.Provider value={value}>
    {enabled && authenticatedOwner && <NativeResources key={authenticatedOwner} ownerKey={authenticatedOwner} pathname={route} />}
    {children}
  </NativeWorkspaceContext.Provider>;
}

/** Keep the web surface's actual onSelect path, including its existing guards. */
export function useNativeWorkspaceSurfaces<T extends string>(surfaces: { id: T; label: string }[], active: T, onSelect: (id: T) => void) {
  const { enabled, pathname, ownerKey, clearSurfaces: clearCurrentSurfaces } = useNativeWorkspace();
  const serialized = JSON.stringify(surfaces.map(({ id, label }) => ({ id, label })));
  useEffect(() => {
    if (!enabled || !ownerKey) return;
    const metadata: { id: T; label: string }[] = JSON.parse(serialized);
    const publish = () => postNativeWorkspace({ version: 1, kind: "surfaces", pathname, active, surfaces: metadata });
    publish();
    // Restoring a cached document does not remount React, so restore the controls
    // cleared by pagehide. A native refresh can also re-request this metadata.
    window.addEventListener("pageshow", publish);
    window.addEventListener("hivra:refresh", publish);
    return () => {
      window.removeEventListener("pageshow", publish);
      window.removeEventListener("hivra:refresh", publish);
    };
  }, [enabled, pathname, ownerKey, active, serialized]);
  useEffect(() => {
    if (enabled && ownerKey) return clearCurrentSurfaces;
  }, [enabled, ownerKey, clearCurrentSurfaces]);
  useEffect(() => {
    if (!enabled || !ownerKey) return;
    const metadata: { id: T; label: string }[] = JSON.parse(serialized);
    const select = (event: Event) => {
      if (!nativeWorkspaceHandler()) return;
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const request = detail as { pathname?: unknown; id?: unknown };
      if (request.pathname !== pathname) return;
      const surface = metadata.find(item => item.id === request.id);
      if (surface) {
        event.preventDefault();
        onSelect(surface.id);
      }
    };
    window.addEventListener("hivra:select-surface", select);
    return () => window.removeEventListener("hivra:select-surface", select);
  }, [enabled, pathname, ownerKey, serialized, onSelect]);
  return enabled;
}
