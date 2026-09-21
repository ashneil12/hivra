"use client";

// Client hooks for the BYO-Composio connect UX (MCP-consumer-key model):
//   useComposioKey()     — hasKey / paste / remove the user's Composio key
//   useComposioConnect() — enabled flag + launch(slug): opens the hosted Composio
//                          OAuth popup for an app DIRECTLY (the server turns the
//                          slug into a login link via the Tool Router's
//                          COMPOSIO_MANAGE_CONNECTIONS — no "ask the agent" hop).
//
// Both gate on NEXT_PUBLIC_COMPOSIO_CONNECT_ENABLED.

import { useCallback, useEffect, useState } from "react";

import { isComposioConnectFlagOn } from "@/lib/composio/config";

// ── key management ─────────────────────────────────────────────────────────
export interface UseComposioKey {
  enabled: boolean;
  loading: boolean;
  hasKey: boolean;
  keyPreview: string | null;
  /** Save (validate + store) a pasted key. Resolves { ok, message? }. */
  save: (key: string) => Promise<{ ok: boolean; message?: string }>;
  /** Remove the stored key. */
  remove: () => Promise<boolean>;
  refresh: () => void;
}

export function useComposioKey(): UseComposioKey {
  const enabled = isComposioConnectFlagOn();
  const [loading, setLoading] = useState<boolean>(enabled);
  const [hasKey, setHasKey] = useState(false);
  const [keyPreview, setKeyPreview] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    fetch("/api/account/composio/key", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setHasKey(Boolean(j?.data?.hasKey));
        setKeyPreview(j?.data?.keyPreview ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(
    async (key: string): Promise<{ ok: boolean; message?: string }> => {
      try {
        const res = await fetch("/api/account/composio/key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
          cache: "no-store",
        });
        const j = (await res.json().catch(() => null)) as
          | { data?: { hasKey?: boolean; keyPreview?: string | null }; error?: string; message?: string }
          | null;
        if (res.ok && j?.data?.hasKey) {
          setHasKey(true);
          setKeyPreview(j.data.keyPreview ?? null);
          return { ok: true };
        }
        return { ok: false, message: j?.error || j?.message || "That key was rejected." };
      } catch {
        return { ok: false, message: "Couldn't save the key. Try again." };
      }
    },
    [],
  );

  const remove = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/account/composio/key", { method: "DELETE", cache: "no-store" });
      if (res.ok) {
        setHasKey(false);
        setKeyPreview(null);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  return { enabled, loading, hasKey, keyPreview, save, remove, refresh };
}

// ── connect launcher ───────────────────────────────────────────────────────
export interface UseComposioConnect {
  enabled: boolean;
  /** Slug currently being launched (for a per-tile spinner), or null. */
  launching: string | null;
  /** Open the hosted Composio OAuth for a toolkit slug. Resolves { ok, message? }. */
  launch: (toolkitSlug: string) => Promise<{ ok: boolean; message?: string }>;
}

export function useComposioConnect(): UseComposioConnect {
  const enabled = isComposioConnectFlagOn();
  const [launching, setLaunching] = useState<string | null>(null);

  const launch = useCallback(
    async (toolkitSlug: string): Promise<{ ok: boolean; message?: string }> => {
      if (!enabled) return { ok: false };
      const slug = toolkitSlug.trim().toLowerCase();
      if (!slug) return { ok: false };
      // Open a blank popup SYNCHRONOUSLY (on the click) so it isn't blocked, then
      // point it at the login link once the server returns it.
      const popup =
        typeof window !== "undefined"
          ? window.open("", "composio_connect", "width=560,height=720")
          : null;
      setLaunching(slug);
      try {
        const res = await fetch("/api/account/composio/connect-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolkitSlug: slug }),
          cache: "no-store",
        });
        const j = (await res.json().catch(() => null)) as
          | { data?: { redirectUrl?: string }; error?: string; message?: string }
          | null;
        const url = j?.data?.redirectUrl;
        if (!res.ok || !url) {
          popup?.close();
          return { ok: false, message: j?.error || j?.message || "Couldn't start that connection." };
        }
        if (popup) popup.location.href = url;
        else if (typeof window !== "undefined") window.location.href = url;
        return { ok: true };
      } catch {
        popup?.close();
        return { ok: false, message: "Couldn't start that connection." };
      } finally {
        setLaunching(null);
      }
    },
    [enabled],
  );

  return { enabled, launching, launch };
}

// ── connected apps ─────────────────────────────────────────────────────────
export interface UseComposioConnectedApps {
  /** Toolkit slugs the user has an ACTIVE connection for (lowercase). */
  apps: Set<string>;
  loading: boolean;
  refresh: () => void;
}

export function useComposioConnectedApps(): UseComposioConnectedApps {
  const enabled = isComposioConnectFlagOn();
  const [apps, setApps] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(enabled);

  const refresh = useCallback(() => {
    if (!enabled) return;
    fetch("/api/account/composio/connected-apps", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        const list = j?.data?.apps;
        if (Array.isArray(list)) {
          setApps(new Set(list.filter((s: unknown): s is string => typeof s === "string")));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [enabled]);

  useEffect(() => {
    refresh();
    if (!enabled || typeof window === "undefined") return;
    // The OAuth completes in a popup; when the user returns to this tab, re-check.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refresh]);

  return { apps, loading, refresh };
}
