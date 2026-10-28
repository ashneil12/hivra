"use client";

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { pollWhenVisible } from "@/lib/poll-when-visible";

import { ActionLinks, type ActionLink } from "@/components/public-editorial/ActionLinks";
import styles from "./status-page.module.css";

// Public, signed-out surfaces whose liveness this page reflects. Paths are
// same-origin so the checks are plain relative fetches: no cross-origin, no
// CORS, and (with credentials omitted below) no authenticated request.
const SURFACES = [
  { key: "website", label: "Website", path: "/", hint: "hivra.cloud" },
  { key: "sign-in", label: "Sign-in page", path: "/sign-in", hint: "/sign-in" },
  { key: "get-started", label: "Get started", path: "/get-started", hint: "/get-started" },
  { key: "changelog", label: "Changelog", path: "/changelog", hint: "/changelog" },
] as const;

type SurfaceKey = (typeof SURFACES)[number]["key"];
type Status = "checking" | "operational" | "degraded" | "down";

// A check that takes longer than this is healthy but slow, so Degraded; one that
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

// The checks load four public pages from the visitor's browser. They say nothing about agents, computers,
// provisioning, billing or whether signing in works, so the headline names pages, not "systems" or an outage.
const OVERALL_COPY: Record<Status, { title: string; body: string }> = {
  operational: {
    title: "Public pages operational",
    body: "The public pages listed below responded normally. This does not check agents, computers or whether sign-in works.",
  },
  degraded: { title: "Some public pages degraded", body: "A public page is slow or returning errors." },
  down: { title: "A public page is not responding", body: "A public page is unreachable right now." },
  checking: { title: "Checking public pages…", body: "Pinging each public page from your browser." },
};

const LINKS: readonly ActionLink[] = [
  { label: "Return to Hivra", href: "/", kind: "primary" },
  { label: "Security reporting", href: "/security", kind: "secondary" },
];

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
  // to window.location.host on the client: no hydration mismatch and no
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
    const id = setInterval(pollWhenVisible(() => void tick()), REFRESH_MS);
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
    <main id="main-content">
      <header className={styles.masthead}>
        <h1>How Hivra is running.</h1>
        <p>
          This page reflects the current health of Hivra&rsquo;s public pages, checked live from your browser. The
          summary below comes from those checks, not from a fixed message.
        </p>
      </header>

      <div className={styles.live}>
        <div
          className={styles.summary}
          role="status"
          aria-live="polite"
          data-state={overall}
          style={{ "--state-dot": overallMeta.dot } as CSSProperties}
        >
          <motion.span
            aria-hidden="true"
            className={styles.dot}
            animate={
              reduceMotion || overall === "operational"
                ? undefined
                : { opacity: [0.35, 1, 0.35] }
            }
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
          <div>
            <p className={styles.summaryTitle}>{overallCopy.title}</p>
            <p className={styles.summaryBody}>{overallCopy.body}</p>
          </div>
        </div>

        <p className={styles.behaviour}>
          A page that answers slowly or with an error is marked Degraded, and one that does not answer is marked Down.
          The summary above follows the worst result.
        </p>

        <section aria-label="Public surface status" className={styles.checks}>
          {SURFACES.map((surface) => {
            const state = states[surface.key];
            const meta = STATUS_META[state.status];
            return (
              <div key={surface.key} className={styles.row}>
                <div className={styles.rowName}>
                  <div className={`serif ${styles.surface}`}>{surface.label}</div>
                  <div className={`mono ${styles.surfaceMeta}`}>
                    {surface.key === "website" ? websiteHint : surface.hint}
                    {state.checkedAt != null && (
                      <>
                        {" · "}
                        <span className={styles.checkedAt}>
                          {"checked "}
                          <time dateTime={new Date(state.checkedAt).toISOString()}>
                            {new Date(state.checkedAt).toLocaleTimeString()}
                          </time>
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <span
                  role="status"
                  aria-label={`${surface.label}: ${meta.label}`}
                  className={styles.state}
                >
                  <span aria-hidden="true" className={styles.stateDot} style={{ background: meta.dot }} />
                  <span className={`mono ${styles.stateLabel}`} style={{ color: meta.fg }}>
                    {meta.label}
                  </span>
                </span>
              </div>
            );
          })}
        </section>

        <div className={styles.controls}>
          <p className={`mono ${styles.lastChecked}`}>
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
            className={`mono ${styles.rerun}`}
          >
            {isChecking ? "Checking…" : "Re-run checks"}
          </button>
        </div>

        <p className={styles.method}>
          Checks run in your browser against public pages only. No account data is
          read and nothing is stored.
        </p>
      </div>

      <p className={styles.prose}>
        We would rather explain a disruption plainly than hide it behind a vague uptime percentage.
      </p>
      <p className={styles.prose}>
        Need help with a specific agent? Contact <a href="mailto:info@hivra.cloud">info@hivra.cloud</a> and include
        the identifier of the agent or computer and the approximate time of the problem. Never include credentials or
        private keys in a support message.
      </p>

      <ActionLinks items={LINKS} />
    </main>
  );
}
