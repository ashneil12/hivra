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
// bootId changed (or appeared, or disappeared) it signs in again. An unchanged
// bootId, or a gateway that never had one (older runtimes), never reloads a
// loaded frame. A surface whose check failed recovers by itself once a later
// probe succeeds.
//
// Each sign-in is a new `generation`, and hosts key their iframe on it: the
// bootstrap is POSTed into a freshly mounted frame with the same name, never
// into the loaded one. Navigating a frame that has already loaded a document
// adds a joint session history entry, so Back would reload the surface (and
// end a terminal's shell, or trip ttyd's leave prompt) instead of leaving the
// page. The first navigation of a new frame replaces its initial about:blank
// and adds none.
//
// Runtimes that serve their own interface at `nativeSurface` (DeepSeek) answer
// 503 there until their process is up. A surface for that path waits, polling
// with backoff, for `nativeReady: true` before it bootstraps, and goes back to
// waiting whenever a loaded one reports itself down. The wait is bounded: a
// gateway that stays unreachable is reported as unreachable, and a start that
// takes longer than the limit is reported as failed, with Try again.

import { useEffect, useRef, useState } from "react";
import { clientLog } from "@/lib/client/logger";

export type SurfaceAccessStatus =
  | "checking"
  | "starting"
  | "stalled"
  | "ready"
  | "upgrade-required"
  | "unavailable";
type ProbeStatus = "starting" | "ready" | "upgrade-required" | "unavailable";

export const SURFACE_RECHECK_INTERVAL_MS = 30_000;
/** Delays between probes while waiting for a runtime or after a failed probe. */
export const SURFACE_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/**
 * How long a native interface may take to start before the wait is reported as
 * failed. DeepSeek gives its own start 90 s (deepseek-harness/runtime-process.cjs)
 * and systemd retries it 5 s later, so this covers one failed attempt and most
 * of a second.
 */
export const SURFACE_NATIVE_START_LIMIT_MS = 180_000;
/**
 * How long a gateway may stay unreachable during that wait before it is
 * reported as unreachable. A restart (RestartSec=5 plus node start-up) fits.
 */
export const SURFACE_UNREACHABLE_GRACE_MS = 20_000;
// focus and visibilitychange usually fire together; one probe answers both.
const EVENT_PROBE_THROTTLE_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;
// Opaque on this side; the shape check only keeps junk out of comparisons.
const BOOT_ID = /^[A-Za-z0-9_-]{8,128}$/;

interface RuntimeProbe {
  status: ProbeStatus;
  bootId: string | null;
  agentKind: string | null;
  /** Why the check failed, for diagnostics only. Never carries the token. */
  failure: string | null;
}

interface SurfaceAccess {
  key: string;
  token: string;
  status: Exclude<SurfaceAccessStatus, "checking">;
  bootId: string | null;
  agentKind: string | null;
  /** Sign-ins made for this key; each one mounts a new frame. */
  generation: number;
  /** When the current wait for a native interface began. */
  waitingSince: number | null;
  /** First failed probe of an unbroken run of failures during that wait. */
  unreachableSince: number | null;
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

function unavailableProbe(failure: string | null): RuntimeProbe {
  return { status: "unavailable", bootId: null, agentKind: null, failure };
}

function classifyRuntime(metadata: unknown, pathname: string): RuntimeProbe {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return unavailableProbe("metadata is not a JSON object");
  }
  const record = metadata as Record<string, unknown>;
  const agentKind = typeof record.agentKind === "string" ? record.agentKind : null;
  if (record.surfaceAuth === "post-cookie-v1") {
    const bootId = typeof record.bootId === "string" && BOOT_ID.test(record.bootId) ? record.bootId : null;
    const waitingForNative = typeof record.nativeSurface === "string" && record.nativeSurface === pathname
      && record.nativeReady !== true;
    return { status: waitingForNative ? "starting" : "ready", bootId, agentKind, failure: null };
  }
  // A runtime that names itself but not this protocol needs an update; never
  // fall back to an older, URL-token handshake.
  return agentKind
    ? { status: "upgrade-required", bootId: null, agentKind, failure: null }
    : unavailableProbe("metadata names neither an agent nor surfaceAuth");
}

async function probeRuntime(metadataUrl: string, pathname: string, signal: AbortSignal): Promise<RuntimeProbe> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, PROBE_TIMEOUT_MS);
  let stage = "request";
  try {
    // Nonsecret runtime metadata only: no credentials, no bearer. An old or
    // unreachable runtime must never fall back to putting it in a URL.
    const response = await fetch(metadataUrl, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) return unavailableProbe(`metadata answered HTTP ${response.status}`);
    stage = "metadata body";
    return classifyRuntime(await response.json(), pathname);
  } catch (error) {
    // The surface went away: nothing to report.
    if (signal.aborted) return unavailableProbe(null);
    if (timedOut) return unavailableProbe(`no answer within ${PROBE_TIMEOUT_MS / 1_000} s`);
    // Network, CORS and TLS failures all surface here as a bare TypeError.
    return unavailableProbe(`${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

// Surfaces retry on their own, so a stuck one must leave a trail (DevTools and
// ops events): one line when the check starts failing or its reason changes,
// not one per retry. Origin and reason only; the probe never carries the token.
function reportProbe(probe: RuntimeProbe, origin: string, lastFailure: { current: string | null }) {
  if (probe.failure === lastFailure.current) return;
  lastFailure.current = probe.failure;
  if (!probe.failure) return;
  clientLog.warn("computer surface check failed", {
    // An allow-listed client source, so the ops event is accepted for everyone.
    source: "client.diagnostic",
    surface: "computer-surface",
    failureType: "hivra_surface_metadata_unavailable",
    origin,
    reason: probe.failure,
  });
}

function firstAccess(key: string, token: string, probe: RuntimeProbe, now: number): SurfaceAccess {
  return {
    key,
    token,
    status: probe.status,
    bootId: probe.bootId,
    agentKind: probe.agentKind,
    generation: probe.status === "ready" ? 1 : 0,
    waitingSince: probe.status === "starting" ? now : null,
    unreachableSince: null,
  };
}

/** The next state after a background re-probe; the same object when nothing changes. */
function advance(previous: SurfaceAccess, probe: RuntimeProbe, now: number): SurfaceAccess {
  const agentKind = probe.agentKind ?? previous.agentKind;
  const signIn = (): SurfaceAccess => ({
    ...previous,
    status: "ready",
    bootId: probe.bootId,
    agentKind,
    generation: previous.generation + 1,
    waitingSince: null,
    unreachableSince: null,
  });
  const wait = (): SurfaceAccess => ({
    ...previous,
    status: "starting",
    bootId: probe.bootId,
    agentKind,
    waitingSince: now,
    unreachableSince: null,
  });

  switch (previous.status) {
    case "ready":
      // A native interface that reports itself down is showing its 503 in the
      // frame, whatever the bootId says (older gateways have none): wait for
      // it again, then sign in afresh.
      if (probe.status === "starting") return wait();
      // Otherwise only a different gateway process invalidates the frame's
      // session. A failed probe (network blip, gateway mid-restart) or an
      // unchanged bootId leaves the loaded surface and its own reconnect
      // alone. A bootId that appears (update) or disappears (rollback to an
      // older runtime) is a different process too; a gateway that never had
      // one never reloads.
      if (probe.status !== "ready" || probe.bootId === previous.bootId) return previous;
      return signIn();
    case "starting":
    case "stalled": {
      if (probe.status === "ready") return signIn();
      if (probe.status === "upgrade-required") {
        return { ...previous, status: "upgrade-required", bootId: null, agentKind, waitingSince: null, unreachableSince: null };
      }
      // A gateway restart takes seconds. One that stays unreachable is
      // reported as unreachable, not as an interface that is still starting.
      const unreachableSince = probe.status === "unavailable" ? previous.unreachableSince ?? now : null;
      if (unreachableSince !== null && now - unreachableSince >= SURFACE_UNREACHABLE_GRACE_MS) {
        return { ...previous, status: "unavailable", waitingSince: null, unreachableSince: null };
      }
      // Never claim progress indefinitely. Past the limit the wait is reported
      // as failed (a crash-looping start keeps answering "not ready"), and a
      // later ready answer still opens the surface.
      const overdue = previous.waitingSince !== null && now - previous.waitingSince >= SURFACE_NATIVE_START_LIMIT_MS;
      const status = previous.status === "stalled" || overdue ? "stalled" : "starting";
      if (status === previous.status && unreachableSince === previous.unreachableSince) return previous;
      return { ...previous, status, agentKind, unreachableSince };
    }
    default:
      // No frame on screen (unreachable, outdated gateway): a failed probe
      // keeps the current message, and any successful answer moves on.
      if (probe.status === "unavailable" || probe.status === previous.status) return previous;
      if (probe.status === "ready") return signIn();
      if (probe.status === "starting") return wait();
      return { ...previous, status: probe.status, bootId: null, agentKind, waitingSince: null, unreachableSince: null };
  }
}

/** Status copy while a runtime starts its own interface, and once it has not. */
export function nativeStartCopy(agentKind: string | null) {
  const name = agentKind === "deepseek-harness" ? "DeepSeek" : null;
  return {
    starting: {
      title: `Starting ${name ?? "the agent"}…`,
      detail: `${name ?? "The agent"} is still starting on this computer. It opens here as soon as it’s ready.`,
    },
    stalled: {
      title: `${name ?? "The agent"} hasn’t started`,
      detail: `${name ?? "The agent"} didn’t finish starting on this computer. Check its status in Manage, then try again.`,
    },
  };
}

export function useSurfaceBootstrap({ url, token, active = true }: { url: string; token: string | null; active?: boolean }) {
  const endpoints = surfaceEndpoints(url);
  const origin = endpoints?.origin ?? "";
  const metadataUrl = endpoints?.metadataUrl ?? "";
  const bootstrapUrl = endpoints?.bootstrapUrl ?? "";
  const destination = endpoints?.destination ?? "";
  const pathname = endpoints?.pathname ?? "";
  const formRef = useRef<HTMLFormElement>(null);
  const lastProbeAt = useRef(0);
  const lastFailure = useRef<string | null>(null);
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
      reportProbe(probe, origin, lastFailure);
      setAccess(firstAccess(probeKey, token, probe, Date.now()));
    });
    return () => controller.abort();
  }, [metadataUrl, origin, pathname, probeKey, token]);

  // Each generation signs its own, newly mounted frame in (hosts key the
  // iframe on it). The bearer only ever travels in this POST body.
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
    // backoff. An outdated gateway needs an update first and a failed start
    // needs attention, so those are left to the regular checks.
    const unsettled = status === "starting" || status === "unavailable";
    const probe = () => {
      if (disposed) return;
      if (inFlight) { again = true; return; }
      window.clearTimeout(retry);
      const controller = new AbortController();
      inFlight = controller;
      void probeRuntime(metadataUrl, pathname, controller.signal).then((result) => {
        if (disposed) return;
        const now = Date.now();
        lastProbeAt.current = now;
        reportProbe(result, origin, lastFailure);
        setAccess((previous) => previous && previous.key === probeKey && previous.token === token
          ? advance(previous, result, now) : previous);
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
  }, [active, metadataUrl, origin, pathname, probeKey, status, token]);

  const copy = nativeStartCopy(current?.agentKind ?? null);
  return {
    status,
    /** Key for the surface's iframe: a new frame for every sign-in. */
    generation,
    starting: copy.starting,
    stalled: copy.stalled,
    origin,
    bootstrapUrl,
    destination,
    formRef,
    retry: () => setProbeVersion((version) => version + 1),
  };
}
