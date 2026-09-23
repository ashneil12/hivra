"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Check, Cpu, KeyRound, Loader2, RadioTower, Send, Server, type LucideIcon } from "lucide-react";

import { STYLES } from "@/components/dashboard/welcome/styles";
import { ConfettiBurst } from "@/components/ui/ConfettiBurst";
import {
  buildHermesEntranceVariants,
  buildHermesStaggerVariants,
  buildHermesSurfaceVariants,
} from "@/components/ui/motion";

// The first three steps complete during Phase 1 (the synchronous POST). The
// final "Online" step boots for minutes afterwards on Phase 2 — it keeps
// spinning here until the readiness poll below confirms the workspace is
// actually reachable, at which point it flips to done. Labels are consumer
// language (Track W): no Instance/Gateway/WebUI on the happy path.
const BOOT_STEPS: Array<{ label: string; Icon: LucideIcon }> = [
  { label: "Computer", Icon: Cpu },
  { label: "Workspace", Icon: KeyRound },
  { label: "Skills", Icon: Server },
  { label: "Online", Icon: RadioTower },
];

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

/**
 * Post-Phase-1 "deploy accepted, now booting" beat — a genuine two-part screen.
 *
 * Phase 1 (the POST) only ACCEPTS the deploy — the VM/runtime then boots for a
 * few minutes on Phase 2. We split the wait into two honest beats:
 *
 *   Part 1 — Booting/Connecting (ready === false). The deploy was accepted, so
 *     the first three steps read done and the WebUI step spins. We poll
 *     /webui-login-url (the same readiness contract WebuiIframe uses) until the
 *     workspace is actually reachable. No Telegram prompt yet — pushing the user
 *     to connect Telegram (or open the agent) here lands them on a "Preparing
 *     your workspace…" spinner because nothing is up to talk to. A quiet "open
 *     it now" escape hatch stays available for the impatient.
 *
 *   Part 2 — Connected (ready === true). The gateway answered and a login URL
 *     was minted, so the workspace genuinely works. The WebUI step flips to
 *     done, confetti fires (the real milestone), and "Start chatting" is the
 *     primary action — it lands straight in a live chat. Telegram is offered
 *     as a secondary option (connecting it from here actually works), never
 *     as the step that stands between the user and their first chat.
 *
 * There is no auto-redirect in either phase — the user moves on themselves.
 */
export function DeployedCelebration({
  agentName,
  emoji,
  onContinue,
  onConnectTelegram,
  instanceId,
  engineName,
}: {
  agentName: string;
  /** The chosen persona's signature emoji, shown beside the name so the deploy
   *  card reflects the persona the user picked instead of a generic form. */
  emoji?: string | null;
  /** Engine the agent runs on (e.g. "Hermes Agent") — stated at the moment of
   *  success so catalog breadth reads as credibility, not a hidden detail. */
  engineName?: string | null;
  onContinue: () => void;
  /** When provided, the connected phase offers Telegram as a secondary action
   *  beneath "Start chatting". */
  onConnectTelegram?: () => void;
  /** The just-created instance id. Drives the readiness poll that flips this
   *  screen from "booting" to "connected". Omit to skip the poll (the screen
   *  then stays in the booting beat with the open-now escape hatch). */
  instanceId?: string;
  /** @deprecated Consumer copy no longer surfaces the hardware spec; kept for
   *  call-site compatibility. */
  cpu?: number;
  /** @deprecated See `cpu`. */
  ramMb?: number;
  /** @deprecated No longer auto-redirects; kept for call-site compatibility. */
  autoContinueMs?: number;
}) {
  const reduceMotion = useReducedMotion();
  // Prefix the name with the persona emoji when present (e.g. "🛠️ Pike").
  const displayName = emoji ? `${emoji} ${agentName}` : agentName;

  // ── Readiness poll ────────────────────────────────────────────────────────
  // false = still booting (Part 1); true = workspace is reachable (Part 2).
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!instanceId || ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + POLL_DEADLINE_MS;

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
        // Ready only when the route minted a real login URL — that means the
        // gateway + SPA shell answered the probes. A 202 pending, a non-ready
        // body, or any transient error all mean "still booting" → keep polling.
        if (res.ok && body && typeof body.url === "string") {
          setReady(true);
          return;
        }
        if (Date.now() < deadline) {
          timer = setTimeout(poll, clampPollDelay(body?.retryAfterMs));
        }
      } catch {
        if (cancelled) return;
        if (Date.now() < deadline) {
          timer = setTimeout(poll, POLL_MAX_MS);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [instanceId, ready]);

  const surface = buildHermesSurfaceVariants(Boolean(reduceMotion), { offset: 16 });
  const stagger = buildHermesStaggerVariants(Boolean(reduceMotion), 0.08, 0.12);
  const item = buildHermesEntranceVariants(Boolean(reduceMotion), { offset: 14 });

  return (
    <motion.section
      role="status"
      aria-live="polite"
      aria-label={ready ? "Your agent is live" : "Deploy accepted — your agent is waking up"}
      initial="hidden"
      animate="visible"
      variants={surface}
      style={{
        ...STYLES.deployingCard,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 0,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Confetti is the payoff for the wait — it fires when the workspace is
          actually live (Part 2), not the moment the deploy was merely accepted. */}
      {ready ? <ConfettiBurst originY={0.28} /> : null}

      {/* Success halo — the deploy was accepted; the agent is now booting. */}
      <div
        style={{
          position: "relative",
          width: 92,
          height: 92,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "1.4rem",
        }}
      >
        {!reduceMotion &&
          [0, 0.6].map((delay) => (
            <motion.span
              key={delay}
              aria-hidden="true"
              initial={{ opacity: 0.85, scale: 0.7 }}
              animate={{ opacity: 0, scale: 1.85 }}
              transition={{ duration: 1.8, delay, repeat: Infinity, ease: "easeOut" }}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: "2px solid var(--gold-leaf)",
              }}
            />
          ))}
        <motion.span
          initial={reduceMotion ? { scale: 1 } : { scale: 0 }}
          animate={{ scale: 1 }}
          transition={
            reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 16, delay: 0.1 }
          }
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--gold-leaf)",
            color: "var(--vellum-bg)",
            boxShadow: "0 8px 24px rgba(255, 44, 45,0.4)",
          }}
        >
          <Check size={36} strokeWidth={2.4} aria-hidden="true" />
        </motion.span>
      </div>

      <motion.div variants={stagger} initial="hidden" animate="visible" style={{ maxWidth: 520 }}>
        <motion.span
          variants={item}
          className="mono"
          style={{
            display: "block",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            color: "var(--gold-leaf)",
            fontWeight: 700,
          }}
        >
          {ready ? "Now live" : "Deploy accepted"}
        </motion.span>

        <motion.h2
          variants={item}
          className="serif"
          style={{
            fontSize: "2.3rem",
            lineHeight: 1.05,
            fontWeight: 300,
            margin: "0.6rem 0 0.5rem",
            color: "var(--ink-black)",
          }}
        >
          {ready ? "Connected — you're live" : "Deployed — waking up now"}
        </motion.h2>

        <motion.p
          variants={item}
          style={{ fontSize: "1rem", lineHeight: 1.6, color: "var(--text-secondary)", margin: "0 0 1.6rem" }}
        >
          {ready ? (
            <>
              <strong style={{ color: "var(--ink-black)", fontWeight: 700 }}>{displayName}</strong> is up
              and connected{engineName ? <> — running on the {engineName} engine</> : null} — ready
              whenever you are.
            </>
          ) : (
            <>
              <strong style={{ color: "var(--ink-black)", fontWeight: 700 }}>{displayName}</strong> now
              has a private computer of its own{engineName ? (
                <> — running on the {engineName} engine</>
              ) : null} — and is waking up. This usually
              takes about 3 minutes. Sit tight; we&apos;ll connect you the moment it&apos;s ready.
            </>
          )}
        </motion.p>

        {/* Steps — first three done from Phase 1; the "Online" step spins
            until the readiness poll confirms the workspace is reachable. */}
        <motion.div
          variants={item}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.6rem",
            justifyContent: "center",
            marginBottom: "1.8rem",
          }}
        >
          {BOOT_STEPS.map(({ label, Icon }) => {
            const done = label !== "Online" || ready;
            return (
              <span
                key={label}
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "0.5rem 0.75rem",
                  border: done ? "1px solid var(--gold-leaf)" : "1px solid var(--etched-border)",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: done ? "var(--ink-black)" : "var(--text-secondary)",
                }}
              >
                <Icon
                  size={13}
                  aria-hidden="true"
                  style={{ color: done ? "var(--gold-leaf)" : "var(--text-secondary)" }}
                />
                {label}
                {done ? (
                  <Check
                    size={13}
                    strokeWidth={2.6}
                    aria-hidden="true"
                    style={{ color: "var(--gold-leaf)" }}
                  />
                ) : (
                  <Loader2
                    size={13}
                    aria-hidden="true"
                    style={{ color: "var(--text-secondary)", animation: "spin 1s linear infinite" }}
                  />
                )}
              </span>
            );
          })}
        </motion.div>

        <motion.div variants={item} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          {ready ? (
            <>
              {/* Part 2: the workspace is live, so chatting is the primary action. */}
              <button
                type="button"
                onClick={onContinue}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "0.9rem 1.7rem",
                  border: "1px solid var(--gold-leaf)",
                  background: "var(--gold-leaf)",
                  color: "var(--vellum-bg)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                Start chatting
                <ArrowRight size={15} aria-hidden="true" />
              </button>
              {onConnectTelegram ? (
                // Telegram is optional and secondary: it never stands between
                // the user and their first chat.
                <button
                  type="button"
                  onClick={onConnectTelegram}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "0.5rem 0.6rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  <Send size={13} aria-hidden="true" />
                  Also chat from Telegram
                </button>
              ) : null}
            </>
          ) : (
            <>
              {/* Part 1: still booting. The hero is the live status; opening is a
                  quiet escape hatch (lands on the instance's own boot screen). */}
              <p
                className="mono"
                style={{
                  margin: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--text-secondary)",
                }}
              >
                <Loader2
                  size={13}
                  aria-hidden="true"
                  style={{ color: "var(--gold-leaf)", animation: "spin 1s linear infinite" }}
                />
                Connecting your workspace
              </p>
              <button
                type="button"
                onClick={onContinue}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "0.5rem 0.6rem",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Skip for now — open {agentName}
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            </>
          )}
        </motion.div>
      </motion.div>
    </motion.section>
  );
}
