"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "framer-motion";

// Public, signed-out surfaces whose liveness this page reflects. Paths are
// same-origin so the checks are plain relative fetches — no cross-origin, no
// CORS, and (with credentials omitted below) no authenticated request.
const SURFACES = [
  { key: "website", label: "Website", path: "/", hint: "hivra.cloud" },
  { key: "sign-in", label: "Sign-in", path: "/sign-in", hint: "/sign-in" },
  { key: "get-started", label: "Get started", path: "/get-started", hint: "/get-started" },
  { key: "changelog", label: "Changelog", path: "/changelog", hint: "/changelog" },
] as const;

type SurfaceKey = (typeof SURFACES)[number]["key"];
type Status = "checking" | "operational" | "degraded" | "down";

// A check that takes longer than this is healthy-but-slow → Degraded; one that
// blows the hard timeout (or errors) is Down.
const SLOW_MS = 2_500;
const TIMEOUT_MS = 8_000;
const REFRESH_MS = 60_000;

interface SurfaceState {
  status: Status;
  checkedAt: number | null;
}

const STATUS_META: Record<Status, { label: string; fg: string; dot: string }> = {
  operational: { label: "Operational", fg: "#15803d", dot: "#16a34a" },
  degraded: { label: "Degraded", fg: "#b45309", dot: "#d97706" },
  down: { label: "Down", fg: "#dc2626", dot: "#dc2626" },
  checking: { label: "Checking…", fg: "var(--text-muted)", dot: "var(--text-muted)" },
};

const OVERALL_COPY: Record<Status, { title: string; body: string }> = {
  operational: { title: "All systems operational", body: "Every public surface responded normally." },
  degraded: { title: "Some systems degraded", body: "A public surface is slow or returning errors." },
  down: { title: "Major outage", body: "A public surface is unreachable right now." },
  checking: { title: "Checking systems…", body: "Pinging each public surface from your browser." },
};

// Read-only liveness probe: a successful, prompt response is Operational; a
// non-2xx or slow response is Degraded; a network failure or timeout is Down.
// `credentials: "omit"` guarantees the ping carries no session cookie, so the
// status page never issues an authenticated request.
async function probe(path: string): Promise<Status> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(path, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (!res.ok) return "degraded";
    if (elapsedMs > SLOW_MS) return "degraded";
    return "operational";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

interface ProbeResult {
  key: SurfaceKey;
  status: Status;
  checkedAt: number;
}

// Probe every surface in parallel. Pure (no React) so both the mount effect and
// the manual re-check can share it and only touch state once results resolve.
async function probeAll(): Promise<ProbeResult[]> {
  return Promise.all(
    SURFACES.map(async (s) => ({ key: s.key, status: await probe(s.path), checkedAt: Date.now() }))
  );
}

function mergeResults(
  prev: Record<SurfaceKey, SurfaceState>,
  results: ProbeResult[]
): Record<SurfaceKey, SurfaceState> {
  const next = { ...prev };
  for (const r of results) next[r.key] = { status: r.status, checkedAt: r.checkedAt };
  return next;
}

function worstStatus(states: Record<SurfaceKey, SurfaceState>): Status {
  const all = SURFACES.map((s) => states[s.key].status);
  if (all.includes("down")) return "down";
  if (all.includes("degraded")) return "degraded";
  if (all.includes("checking")) return "checking";
  return "operational";
}

// websiteHint is derived once on the client and never changes afterward, so the
// external store has nothing to subscribe to.
const subscribeNoop = () => () => {};

function initialStates(): Record<SurfaceKey, SurfaceState> {
  return Object.fromEntries(
    SURFACES.map((s) => [s.key, { status: "checking" as Status, checkedAt: null }])
  ) as Record<SurfaceKey, SurfaceState>;
}

export default function StatusPageContent() {
  const reduceMotion = useReducedMotion();
  const [states, setStates] = useState<Record<SurfaceKey, SurfaceState>>(initialStates);
  const [lastRun, setLastRun] = useState<number | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  // The website surface hint is the current host so it reads correctly on
  // canary/preview deployments (not a hardcoded prod domain). useSyncExternalStore
  // serves the SURFACES literal for SSR + the initial hydration render, then swaps
  // to window.location.host on the client — no hydration mismatch and no
  // synchronous setState inside an effect.
  const websiteHint = useSyncExternalStore(
    subscribeNoop,
    () => window.location.host || SURFACES[0].hint,
    () => SURFACES[0].hint
  );

  // Initial check on mount + a light 60s auto-refresh so the page stays live.
  // Probes are awaited before any setState (mirrors the /stats live-poll
  // effect), so the effect body never writes state synchronously.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const results = await probeAll();
      if (!alive) return;
      setStates((prev) => mergeResults(prev, results));
      setLastRun(Date.now());
      setIsChecking(false);
    };
    void tick();
    const id = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Manual re-check: flip the rows back to "checking" for instant feedback, then
  // re-probe. setState inside an event handler is unrestricted.
  const handleRerun = () => {
    if (isChecking) return;
    setIsChecking(true);
    setStates((prev) =>
      Object.fromEntries(
        SURFACES.map((s) => [s.key, { status: "checking" as Status, checkedAt: prev[s.key].checkedAt }])
      ) as Record<SurfaceKey, SurfaceState>
    );
    void probeAll().then((results) => {
      setStates((prev) => mergeResults(prev, results));
      setLastRun(Date.now());
      setIsChecking(false);
    });
  };

  const overall = worstStatus(states);
  const overallMeta = STATUS_META[overall];
  const overallCopy = OVERALL_COPY[overall];

  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "clamp(3rem, 8vw, 6rem) 2rem 6rem",
      }}
    >
      <header style={{ textAlign: "center", marginBottom: "3rem" }}>
        <span
          className="mono"
          style={{
            display: "block",
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            color: "var(--gold-leaf)",
            fontWeight: 700,
            marginBottom: "1.25rem",
          }}
        >
          System status
        </span>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            marginBottom: "0.85rem",
          }}
        >
          <motion.span
            aria-hidden="true"
            animate={
              reduceMotion || overall === "operational"
                ? undefined
                : { opacity: [0.35, 1, 0.35] }
            }
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: overallMeta.dot,
              boxShadow: `0 0 10px ${overallMeta.dot}`,
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          <h1
            className="serif"
            style={{
              fontSize: "clamp(1.6rem, 4vw, 2.5rem)",
              fontWeight: 300,
              lineHeight: 1.15,
              color: "var(--ink-black)",
              margin: 0,
            }}
          >
            {overallCopy.title}
          </h1>
        </div>

        <p
          style={{
            fontSize: "1rem",
            lineHeight: 1.6,
            color: "var(--text-secondary)",
            maxWidth: 480,
            margin: "0 auto",
          }}
        >
          {overallCopy.body}
        </p>
      </header>

      <section
        aria-label="Public surface status"
        style={{
          borderTop: "1px solid var(--etched-border)",
          borderBottom: "1px solid var(--etched-border)",
          marginBottom: "1.75rem",
        }}
      >
        {SURFACES.map((surface, i) => {
          const state = states[surface.key];
          const meta = STATUS_META[state.status];
          return (
            <div
              key={surface.key}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "1.1rem 1rem",
                borderTop: i === 0 ? "none" : "1px solid var(--etched-border)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  className="serif"
                  style={{
                    fontSize: "1.05rem",
                    color: "var(--ink-black)",
                    lineHeight: 1.2,
                  }}
                >
                  {surface.label}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.04em",
                    color: "var(--text-muted)",
                    marginTop: 3,
                  }}
                >
                  {surface.key === "website" ? websiteHint : surface.hint}
                  {state.checkedAt != null && (
                    <>
                      {" · checked "}
                      <time dateTime={new Date(state.checkedAt).toISOString()}>
                        {new Date(state.checkedAt).toLocaleTimeString()}
                      </time>
                    </>
                  )}
                </div>
              </div>

              <span
                role="status"
                aria-label={`${surface.label}: ${meta.label}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: meta.dot,
                    display: "inline-block",
                  }}
                />
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    fontWeight: 700,
                    color: meta.fg,
                  }}
                >
                  {meta.label}
                </span>
              </span>
            </div>
          );
        })}
      </section>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <p
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: "var(--text-muted)",
            fontWeight: 600,
            margin: 0,
          }}
        >
          {lastRun != null ? (
            <>
              Last checked{" "}
              <time dateTime={new Date(lastRun).toISOString()}>
                {new Date(lastRun).toLocaleTimeString()}
              </time>
            </>
          ) : (
            "Checking…"
          )}
        </p>
        <button
          type="button"
          onClick={handleRerun}
          disabled={isChecking}
          className="mono"
          style={{
            border: "1px solid var(--etched-border)",
            background: "transparent",
            color: "var(--text-secondary)",
            cursor: isChecking ? "default" : "pointer",
            opacity: isChecking ? 0.5 : 1,
            padding: "8px 16px",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            fontWeight: 700,
          }}
        >
          {isChecking ? "Checking…" : "Re-run checks"}
        </button>
      </div>

      <p
        style={{
          marginTop: "2.5rem",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--text-muted)",
          textAlign: "center",
        }}
      >
        Checks run in your browser against public pages only — no account data is
        read and nothing is stored.
      </p>
    </main>
  );
}
