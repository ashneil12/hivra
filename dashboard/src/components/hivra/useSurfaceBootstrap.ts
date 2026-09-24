"use client";

// Keeps an embedded computer surface (terminal, live browser, native agent
// interface) signed in for as long as it is on screen.
//
// A surface signs in with the box's `surfaceAuth: post-cookie-v1` handshake:
// probe the public /api/meta (never send a bearer to an unverified runtime),
// then POST the token to /auth/bootstrap from a hidden form whose target is
// the surface's own frame, so the credential never lands in a URL.
//
// The box gateway keeps those sessions only in memory. After it restarts
// (runtime update, crash, service restart) the frame's cookie is dead and each
// reconnect is a 401 while the dashboard still shows the surface as ready.
// Gateways that advertise a per-process `bootId` make that visible: while the
// surface is mounted and active it re-probes /api/meta on window focus, the
// `online` event, the page becoming visible and every 30 s, and when the
// bootId changed it re-submits its bootstrap form into the same frame, which
// re-authenticates and reloads to the same destination. An unchanged bootId,
// or a gateway that has none (older runtimes), never reloads a loaded frame.
// A surface whose check failed recovers by itself once a later probe succeeds.
//
// Runtimes that serve their own interface at `nativeSurface` (DeepSeek) answer
// 503 there until their process is up. A surface for that path waits, polling
// with backoff, for `nativeReady: true` before it bootstraps.

import { useEffect, useRef, useState } from "react";

export type SurfaceAccessStatus = "checking" | "starting" | "ready" | "upgrade-required" | "unavailable";
type SettledStatus = Exclude<SurfaceAccessStatus, "checking">;

export const SURFACE_RECHECK_INTERVAL_MS = 30_000;
/** Delays between probes while waiting for a runtime or after a failed probe. */
export const SURFACE_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
// focus and visibilitychange usually fire together; one probe answers both.
const EVENT_PROBE_THROTTLE_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;
// Opaque on this side; the shape check only keeps junk out of comparisons.
const BOOT_ID = /^[A-Za-z0-9_-]{8,128}$/;

interface RuntimeProbe {
  status: SettledStatus;
  bootId: string | null;
  agentKind: string | null;
}

interface SurfaceAccess extends RuntimeProbe {
  key: string;
  token: string;
  /** Bootstrap submissions made into the frame for this key. */
  generation: number;
}

export interface SurfaceEndpoints {
  origin: string;
  bootstrapUrl: string;
  metadataUrl: string;
  /** Local path + query the bootstrap redirects the frame to. */
  destination: string;
  pathname: string;
}

/** A malformed stored surface URL fails closed (null) instead of navigating. */
export function surfaceEndpoints(url: string): SurfaceEndpoints | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.searchParams.has("token") ||
      /[\s;*'"]/.test(parsed.origin)
    ) {
      return null;
    }
    return {
      origin: parsed.origin,
      bootstrapUrl: `${parsed.origin}/auth/bootstrap`,
      metadataUrl: `${parsed.origin}/api/meta`,
      destination: `${parsed.pathname}${parsed.search}`,
      pathname: parsed.pathname,
    };
  } catch {
    return null;
  }
}

function classifyRuntime(metadata: unknown, pathname: string): RuntimeProbe {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { status: "unavailable", bootId: null, agentKind: null };
  }
  const record = metadata as Record<string, unknown>;
  const agentKind = typeof record.agentKind === "string" ? record.agentKind : null;
  if (record.surfaceAuth === "post-cookie-v1") {
    const bootId = typeof record.bootId === "string" && BOOT_ID.test(record.bootId) ? record.bootId : null;
    const waitingForNative = typeof record.nativeSurface === "string" && record.nativeSurface === pathname
      && record.nativeReady !== true;
    return { status: waitingForNative ? "starting" : "ready", bootId, agentKind };
  }
  // A runtime that names itself but not this protocol needs an update; never
  // fall back to an older, URL-token handshake.
  return { status: agentKind ? "upgrade-required" : "unavailable", bootId: null, agentKind };
}

async function probeRuntime(metadataUrl: string, pathname: string, signal: AbortSignal): Promise<RuntimeProbe> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  const timeout = window.setTimeout(abort, PROBE_TIMEOUT_MS);
  try {
    // Nonsecret runtime metadata only: no credentials, no bearer. An old or
    // unreachable runtime must never fall back to putting it in a URL.
    const response = await fetch(metadataUrl, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) throw new Error(`Runtime metadata answered ${response.status}.`);
    return classifyRuntime(await response.json(), pathname);
  } catch {
    return { status: "unavailable", bootId: null, agentKind: null };
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

/** The next state after a background re-probe; the same object when nothing changes. */
function advance(previous: SurfaceAccess, probe: RuntimeProbe): SurfaceAccess {
  if (previous.status === "ready") {
    // Only a different gateway process invalidates the frame's session. A
    // failed probe (network blip, gateway mid-restart) or an unchanged or
    // absent bootId leaves the loaded surface and its own reconnect alone.
    if (probe.status !== "ready" && probe.status !== "starting") return previous;
    if (!probe.bootId || probe.bootId === previous.bootId) return previous;
    return probe.status === "ready"
      ? { ...previous, ...probe, generation: previous.generation + 1 }
      : { ...previous, ...probe };
  }
  // Waiting or failed: a failed probe keeps the current message, and any
  // successful answer moves on (to the frame once the runtime is ready).
  if (probe.status === "unavailable") return previous;
  if (probe.status === previous.status && probe.bootId === previous.bootId) return previous;
  return {
    ...previous,
    ...probe,
    agentKind: probe.agentKind ?? previous.agentKind,
    generation: probe.status === "ready" ? previous.generation + 1 : previous.generation,
  };
}

/** Status copy while a runtime is still starting its own interface. */
export function startingRuntimeCopy(agentKind: string | null): { title: string; detail: string } {
  const name = agentKind === "deepseek-harness" ? "DeepSeek" : null;
  return {
    title: `Starting ${name ?? "the agent"}…`,
    detail: `${name ?? "The agent"} is still starting on this computer. It opens here as soon as it’s ready.`,
  };
}

export function useSurfaceBootstrap({ url, token, active = true }: { url: string; token: string | null; active?: boolean }) {
  const endpoints = surfaceEndpoints(url);
  const metadataUrl = endpoints?.metadataUrl ?? "";
  const bootstrapUrl = endpoints?.bootstrapUrl ?? "";
  const destination = endpoints?.destination ?? "";
  const pathname = endpoints?.pathname ?? "";
  const formRef = useRef<HTMLFormElement>(null);
  const lastProbeAt = useRef(0);
  const [probeVersion, setProbeVersion] = useState(0);
  const [access, setAccess] = useState<SurfaceAccess | null>(null);
  const probeKey = `${metadataUrl}:${probeVersion}`;
  const current = access?.key === probeKey && access.token === token ? access : null;
  const status: SurfaceAccessStatus = !metadataUrl || !token ? "unavailable" : current?.status ?? "checking";
  const generation = current?.generation ?? 0;

  // First check for this surface, token and explicit retry.
  useEffect(() => {
    if (!metadataUrl || !token) return;
    const controller = new AbortController();
    void probeRuntime(metadataUrl, pathname, controller.signal).then((probe) => {
      if (controller.signal.aborted) return;
      lastProbeAt.current = Date.now();
      setAccess({ key: probeKey, token, ...probe, generation: probe.status === "ready" ? 1 : 0 });
    });
    return () => controller.abort();
  }, [metadataUrl, pathname, probeKey, token]);

  // Each new generation signs the same frame in again and reloads it to its
  // destination. The bearer only ever travels in this POST body.
  useEffect(() => {
    if (status !== "ready" || generation < 1 || !bootstrapUrl || !destination || !token) return;
    formRef.current?.requestSubmit();
  }, [status, generation, bootstrapUrl, destination, token]);

  // Background re-checks while mounted and active.
  useEffect(() => {
    if (!metadataUrl || !token || !active || status === "checking") return;
    let disposed = false;
    let inFlight: AbortController | null = null;
    let again = false;
    let attempt = 0;
    let retry: number | undefined;
    // Waiting for a runtime or for an unreachable gateway: keep asking with
    // backoff. An outdated gateway needs an update first, so it is left to the
    // regular checks.
    const unsettled = status === "starting" || status === "unavailable";
    const probe = () => {
      if (disposed) return;
      if (inFlight) { again = true; return; }
      window.clearTimeout(retry);
      const controller = new AbortController();
      inFlight = controller;
      void probeRuntime(metadataUrl, pathname, controller.signal).then((result) => {
        if (disposed) return;
        lastProbeAt.current = Date.now();
        setAccess((previous) => previous && previous.key === probeKey && previous.token === token
          ? advance(previous, result) : previous);
        // A failed probe on a loaded frame is often a gateway mid-restart:
        // look again soon so the new bootId is seen in seconds, not 30 s.
        if (unsettled || result.status === "unavailable") {
          const delay = SURFACE_RETRY_BACKOFF_MS[Math.min(attempt, SURFACE_RETRY_BACKOFF_MS.length - 1)];
          attempt += 1;
          retry = window.setTimeout(() => { if (document.visibilityState !== "hidden") probe(); }, delay);
        } else {
          attempt = 0;
        }
      }).finally(() => {
        if (inFlight === controller) inFlight = null;
        if (again && !disposed) { again = false; probe(); }
      });
    };
    const probeUnlessRecent = () => {
      if (Date.now() - lastProbeAt.current >= EVENT_PROBE_THROTTLE_MS) probe();
    };
    const onVisibility = () => { if (document.visibilityState === "visible") probeUnlessRecent(); };
    window.addEventListener("focus", probeUnlessRecent);
    // Not throttled: the probe just before going offline may have failed.
    window.addEventListener("online", probe);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") probe();
    }, SURFACE_RECHECK_INTERVAL_MS);
    // (Re)activation, e.g. a retained terminal's tab selected again, is when a
    // restart that happened out of view shows up. Right after a probe settled
    // this surface, an unsettled one just starts its backoff instead.
    if (Date.now() - lastProbeAt.current >= EVENT_PROBE_THROTTLE_MS) probe();
    else if (unsettled) {
      retry = window.setTimeout(() => { if (document.visibilityState !== "hidden") probe(); }, SURFACE_RETRY_BACKOFF_MS[0]);
      attempt = 1;
    }
    return () => {
      disposed = true;
      window.removeEventListener("focus", probeUnlessRecent);
      window.removeEventListener("online", probe);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
      window.clearTimeout(retry);
      inFlight?.abort();
    };
  }, [active, metadataUrl, pathname, probeKey, status, token]);

  return {
    status,
    starting: startingRuntimeCopy(current?.agentKind ?? null),
    origin: endpoints?.origin ?? "",
    bootstrapUrl,
    destination,
    formRef,
    retry: () => setProbeVersion((version) => version + 1),
  };
}
