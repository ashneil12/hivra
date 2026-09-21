"use client";

// Gateway auto-wake Phase 1: the signed-in owner's wake flow.
//
// Honest progress by design — the wake takes ~70s and the UI says so, counts
// the seconds, and never shows a spinner-forever: every phase has copy, a
// bounded wait, and a way out (retry / dashboard). Flow:
//
//   1. GET /api/instances/[id]/wake        → status + box URL
//      already running → redirect straight to the box.
//   2. POST /api/instances/[id] {action:'start', wakeSource, wakeId}
//      429 (admission deferred) → show "queued", auto-retry after the
//      server-suggested delay. 402/409 → terminal card with the reason.
//   3. Poll GET /api/instances/[id]/health (JSON mode; it owns the gateway
//      probe + the DB promote-to-running flip) until isReady.
//   4. GET /api/instances/[id]/wake?wake_id&elapsed_ms → emits the
//      wake_succeeded telemetry server-side, then redirect to the box.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

const EXPECTED_WAKE_SECONDS = 70;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 4 * 60_000;
// Cold-storage restores rebuild the VM from the archive first (~2-3 min).
const COLD_RESTORE_MAX_WAIT_MS = 8 * 60_000;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

type Phase =
  | "checking"
  | "waking"
  | "queued"
  | "booting"
  | "redirecting"
  | "blocked"
  | "timeout"
  | "failed"
  | "not_found";

interface WakeStatus {
  status: string | null;
  lifecycleState: string | null;
  running: boolean;
  wakeable: boolean;
  boxUrl: string | null;
}

function mintWakeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `wake_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function WakeFlow({
  instanceId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
}: {
  instanceId: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [detail, setDetail] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);

  const cancelledRef = useRef(false);
  const startedAtRef = useRef<number>(0);
  const wakeIdRef = useRef<string>("");
  const boxUrlRef = useRef<string | null>(null);

  const goToBox = useCallback((boxUrl: string | null) => {
    if (boxUrl) {
      window.location.replace(boxUrl);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    startedAtRef.current = Date.now();
    wakeIdRef.current = mintWakeId();
    setElapsedSeconds(0);
    setPhase("checking");
    setDetail(null);

    const ticker = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1_000);

    const elapsedMs = () => Date.now() - startedAtRef.current;

    const fetchWakeStatus = async (withWakeId: boolean): Promise<WakeStatus | "not_found" | null> => {
      const query = withWakeId
        ? `?wake_id=${encodeURIComponent(wakeIdRef.current)}&elapsed_ms=${elapsedMs()}`
        : "";
      const res = await fetch(`/api/instances/${instanceId}/wake${query}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (res.status === 404) return "not_found";
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { data?: WakeStatus } | null;
      return json?.data ?? null;
    };

    const requestStart = async (): Promise<"started" | "terminal"> => {
      // Bounded 429 retry loop: each deferral waits the server-suggested
      // delay, capped by the overall wall clock.
      for (;;) {
        if (cancelledRef.current) return "terminal";
        const res = await fetch(`/api/instances/${instanceId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "start",
            wakeSource: "wake_page",
            wakeId: wakeIdRef.current,
          }),
        });
        if (res.ok) return "started";

        const body = (await res.json().catch(() => null)) as
          | { error?: string; retryAfterSeconds?: number }
          | null;

        if (res.status === 429) {
          if (elapsedMs() >= maxWaitMs) {
            setPhase("timeout");
            return "terminal";
          }
          setPhase("queued");
          const retryAfter = Math.max(
            5,
            Number(body?.retryAfterSeconds) || DEFAULT_RETRY_AFTER_SECONDS,
          );
          setDetail(
            `The host is waking other agents first. Retrying automatically in ${retryAfter} seconds.`,
          );
          await sleep(retryAfter * 1_000);
          if (cancelledRef.current) return "terminal";
          setPhase("waking");
          setDetail(null);
          continue;
        }

        setPhase("blocked");
        setDetail(
          body?.error ||
            "This agent can't be started right now. Open your dashboard for details.",
        );
        return "terminal";
      }
    };

    const pollUntilReady = async (deadlineMs: number): Promise<boolean> => {
      while (!cancelledRef.current && elapsedMs() < deadlineMs) {
        try {
          const res = await fetch(`/api/instances/${instanceId}/health`, {
            cache: "no-store",
            headers: { accept: "application/json" },
          });
          if (res.ok) {
            const health = (await res.json().catch(() => null)) as
              | { isReady?: boolean }
              | null;
            if (health?.isReady) return true;
          }
        } catch {
          // transient network blip — keep polling
        }
        await sleep(pollIntervalMs);
      }
      return false;
    };

    const run = async () => {
      const status = await fetchWakeStatus(false).catch(() => null);
      if (cancelledRef.current) return;

      if (status === "not_found") {
        setPhase("not_found");
        return;
      }
      if (!status) {
        setPhase("failed");
        setDetail("We couldn't look up this agent. Try again in a moment.");
        return;
      }

      boxUrlRef.current = status.boxUrl;

      if (status.running && status.boxUrl) {
        // Already awake — no wake to measure, just send them through.
        setPhase("redirecting");
        goToBox(status.boxUrl);
        return;
      }

      const isColdRestore =
        status.lifecycleState === "cold_archived" ||
        status.lifecycleState === "pending_deletion";
      const deadlineMs = isColdRestore ? COLD_RESTORE_MAX_WAIT_MS : maxWaitMs;

      if (status.status === "error") {
        setPhase("blocked");
        setDetail(
          "This agent hit an error and needs attention. Open your dashboard to recover it.",
        );
        return;
      }

      if (status.wakeable || isColdRestore) {
        setPhase("waking");
        if (isColdRestore) {
          setDetail(
            "This agent was archived to cold storage. Restoring takes about 2–3 minutes.",
          );
        }
        const outcome = await requestStart();
        if (outcome === "terminal" || cancelledRef.current) return;
        setDetail(null);
      }
      // Transitional rows (provisioning/redeploying) skip straight to polling.

      setPhase("booting");
      const ready = await pollUntilReady(deadlineMs);
      if (cancelledRef.current) return;
      if (!ready) {
        setPhase("timeout");
        return;
      }

      // Confirm + emit wake_succeeded server-side, refresh the box URL.
      const finalStatus = await fetchWakeStatus(true).catch(() => null);
      if (cancelledRef.current) return;
      const boxUrl =
        (finalStatus && finalStatus !== "not_found" && finalStatus.boxUrl) ||
        boxUrlRef.current;
      if (!boxUrl) {
        setPhase("failed");
        setDetail(
          "Your agent is awake, but we couldn't resolve its address. Open it from your dashboard.",
        );
        return;
      }
      setPhase("redirecting");
      goToBox(boxUrl);
    };

    void run();

    return () => {
      cancelledRef.current = true;
      clearInterval(ticker);
    };
  }, [instanceId, pollIntervalMs, maxWaitMs, retryNonce, goToBox]);

  const progressPercent =
    phase === "redirecting"
      ? 100
      : Math.min(95, Math.round((elapsedSeconds / EXPECTED_WAKE_SECONDS) * 100));

  const heading =
    phase === "checking"
      ? "Checking on your agent…"
      : phase === "queued"
        ? "Your agent is queued to wake"
        : phase === "redirecting"
          ? "Your agent is awake"
          : phase === "not_found"
            ? "We couldn't find this agent"
            : phase === "blocked"
              ? "This agent needs attention"
              : phase === "timeout"
                ? "This is taking longer than it should"
                : phase === "failed"
                  ? "Something went wrong"
                  : "Waking your agent";

  const isWorking =
    phase === "checking" || phase === "waking" || phase === "queued" || phase === "booting";

  return (
    <div data-testid="wake-flow">
      <h1 className="font-[family-name:var(--font-grotesk)] text-2xl font-medium">
        {heading}
      </h1>

      {isWorking && (
        <>
          <p className="mt-3 text-sm opacity-80">
            {phase === "queued"
              ? detail
              : `Parked agents take about ${EXPECTED_WAKE_SECONDS} seconds to come back. This page will send you to your agent the moment it answers.`}
          </p>
          {phase !== "queued" && detail && (
            <p className="mt-2 text-sm opacity-80">{detail}</p>
          )}
          <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-[var(--ink-black)]/10">
            <div
              className="h-full rounded-full bg-[#ff3a3b] transition-all duration-1000"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs tabular-nums opacity-60" data-testid="wake-elapsed">
            {elapsedSeconds}s elapsed
            {elapsedSeconds > EXPECTED_WAKE_SECONDS
              ? " — still working, some wakes run long"
              : ""}
          </p>
        </>
      )}

      {phase === "redirecting" && (
        <p className="mt-3 text-sm opacity-80">
          Taking you back to it now. If nothing happens,{" "}
          {boxUrlRef.current ? (
            <a href={boxUrlRef.current} className="underline">
              open your agent directly
            </a>
          ) : (
            <Link href="/dashboard" className="underline">
              open your dashboard
            </Link>
          )}
          .
        </p>
      )}

      {(phase === "blocked" || phase === "failed" || phase === "not_found") && (
        <p className="mt-3 text-sm opacity-80">
          {phase === "not_found"
            ? "It may have been deleted, or it belongs to a different account."
            : detail}
        </p>
      )}

      {phase === "timeout" && (
        <p className="mt-3 text-sm opacity-80">
          The wake was requested, but the agent hasn&apos;t answered yet. You
          can retry, or check its status from your dashboard.
        </p>
      )}

      {(phase === "timeout" || phase === "failed") && (
        <button
          type="button"
          onClick={() => setRetryNonce((n) => n + 1)}
          className="mt-6 mr-3 inline-block rounded-lg bg-[#ff3a3b] px-4 py-2 text-sm font-medium text-white"
        >
          Try again
        </button>
      )}

      {!isWorking && phase !== "redirecting" && (
        <Link
          href="/dashboard"
          className={`mt-6 inline-block rounded-lg px-4 py-2 text-sm font-medium ${
            phase === "timeout" || phase === "failed"
              ? "border border-[var(--ink-black)]/20"
              : "bg-[#ff3a3b] text-white"
          }`}
        >
          Go to dashboard
        </Link>
      )}
    </div>
  );
}
