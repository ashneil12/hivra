"use client";

import { useCallback, useEffect, useState } from "react";

// Readiness poll cadence. Mirrors WebuiIframe's handoff polling: the same
// /webui-login-url route is the source of truth for "the workspace is actually
// connectable" (it probes the gateway + SPA shell and only mints a login URL
// once they answer). We clamp the server's retryAfterMs into a sane window and
// stop hammering after the deadline — the manual "open it now" escape hatch
// stays available the whole time, so the user is never trapped.
const POLL_MIN_MS = 2500;
const POLL_MAX_MS = 8000;
const POLL_DEFAULT_MS = 4000;
const POLL_DEADLINE_MS = 12 * 60 * 1000;

function clampPollDelay(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return POLL_DEFAULT_MS;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.floor(value)));
}

export type HermesWorkspaceReadiness = {
  /** The login URL route minted a real login URL: the workspace answers. */
  ready: boolean;
  /** Checks are running now. False once they stopped at their deadline. */
  checking: boolean;
  /** Start another bounded round of checks after they stopped. */
  recheck: () => void;
};

/** Whether a new Hermes agent's workspace answers: the login URL route has
 * probed its gateway and chat and minted a real login URL. Observed state
 * only; a pending answer, a non-ready body or any error keeps it not ready.
 * Checks stop after a bounded window and say so, so a screen never claims a
 * check that is no longer running. */
export function useHermesWorkspaceReadiness(instanceId: string | null | undefined): HermesWorkspaceReadiness {
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [stopped, setStopped] = useState<{ instanceId: string; round: number } | null>(null);
  const ready = Boolean(instanceId) && readyFor === instanceId;
  const gaveUp = !ready && Boolean(instanceId) && stopped?.instanceId === instanceId && stopped.round === round;

  useEffect(() => {
    if (!instanceId || ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const next = (delay: number) => {
      if (Date.now() < deadline) timer = setTimeout(poll, delay);
      else setStopped({ instanceId, round });
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}/webui-login-url`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (cancelled) return;
        const body = (await res.json().catch(() => null)) as
          | { url?: unknown; retryAfterMs?: unknown }
          | null;
        if (cancelled) return;
        if (res.ok && body && typeof body.url === "string") {
          setReadyFor(instanceId);
          return;
        }
        next(clampPollDelay(body?.retryAfterMs));
      } catch {
        if (cancelled) return;
        next(POLL_MAX_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [instanceId, ready, round]);

  const recheck = useCallback(() => setRound(value => value + 1), []);
  return { ready, checking: Boolean(instanceId) && !ready && !gaveUp, recheck };
}

/** True once a new Hermes agent's workspace answers (see useHermesWorkspaceReadiness). */
export function useHermesWorkspaceReady(instanceId: string | null | undefined): boolean {
  return useHermesWorkspaceReadiness(instanceId).ready;
}
