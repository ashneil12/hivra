"use client";

// OnboardingChecklist — the day-one activation guide on the main dashboard.
//
// Shown while the user's FIRST deployment is younger than 14 days and the
// checklist isn't finished (and not dismissed). Every item derives live state
// from data that already exists — no new tables:
//   ① deploy   — any Hermes instance / Hivra box exists (always true here:
//                visibility requires a deployment, so the first tick is free).
//   ② message  — localStorage `hermes:first_message_sent:*` (HivraChat stamps
//                it on the first successful send) OR `first_usage_at` on a
//                Hermes row (stamped write-once by the usage-harvest cron).
//   ③ telegram — a running box reports its Telegram bot connected (the same
//                /api/telegram/status probe the HivraTelegram tab uses).
//   ④ browser  — Pro feature; locked on Free → UpgradePaywallModal('browser').
//   ⑤ cron     — Pro feature; locked on Free → UpgradePaywallModal('cron').
//
// Dismiss persists in localStorage, with a short inline Undo. Funnel instrumentation:
// `onboarding_checklist_item_clicked` {item, locked} + `onboarding_checklist_dismissed`
// (+ `onboarding_checklist_dismiss_undone` when Undo restores it).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, ChevronRight, Globe, Lock, MessageSquareText, Rocket, Send, X } from "lucide-react";
import posthog from "posthog-js";

import {
  fetchPlan,
  listAgentsResult,
  telegramStatus,
  type HivraAgent,
  type PlanInfo,
} from "@/lib/hivra/agent-api";
import { UpgradePaywallModal, type PaywallFeature } from "@/components/billing/UpgradePaywallModal";

const ONBOARDING_CHECKLIST_DISMISSED_KEY = "hermes:onboarding_checklist_dismissed";
const FIRST_MESSAGE_KEY_PREFIX = "hermes:first_message_sent:";
const ACK_KEY_PREFIX = "hermes:onboarding_checklist_done:";
const MAX_FIRST_DEPLOY_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const UNDO_WINDOW_MS = 8000;

/** The slice of an instance the checklist needs (matches /api/instances?summary=true). */
export interface OnboardingChecklistInstance {
  id: string;
  status: string;
  created_at?: string | null;
  first_usage_at?: string | null;
}

type ItemId = "deploy" | "message" | "telegram" | "browser" | "cron";
type ItemState = "done" | "pending" | "locked";

function readLocalFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeLocalFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Privacy mode / quota — the checklist just won't remember.
  }
}

function clearLocalFlag(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable — the in-memory state still restores the checklist.
  }
}

function hasFirstMessageMarker(): boolean {
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(FIRST_MESSAGE_KEY_PREFIX)) return true;
    }
  } catch {
    // Storage unavailable — fall back to first_usage_at only.
  }
  return false;
}

// Funnel observability must never break the checklist itself.
function capture(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Best-effort instrumentation only.
  }
}

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  color: "var(--text-muted)",
};

export function OnboardingChecklist({
  instances,
  includeHivra = true,
}: {
  instances: OnboardingChecklistInstance[];
  /** Whether the Hivra boxes lane is available here (canary surface). */
  includeHivra?: boolean;
}) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<boolean>(() => readLocalFlag(ONBOARDING_CHECKLIST_DISMISSED_KEY));
  // Dismissal is permanent, so a mis-tap gets a brief chance to take it back.
  const [undoable, setUndoable] = useState(false);
  // The window closed while Undo held focus; the row goes once focus moves on.
  const [undoExpired, setUndoExpired] = useState(false);
  // Only a keyboard dismiss moves focus to Undo; pointer users get the timed row.
  const [focusUndo, setFocusUndo] = useState(false);
  const undoButton = useRef<HTMLButtonElement>(null);
  const dismissButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [acks, setAcks] = useState<{ browser: boolean; cron: boolean }>(() => ({
    browser: readLocalFlag(`${ACK_KEY_PREFIX}browser`),
    cron: readLocalFlag(`${ACK_KEY_PREFIX}cron`),
  }));
  const [localFirstMessage, setLocalFirstMessage] = useState<boolean>(() => hasFirstMessageMarker());
  const [agents, setAgents] = useState<HivraAgent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(!includeHivra);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [telegramConnected, setTelegramConnected] = useState<boolean | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<Extract<PaywallFeature, "browser" | "cron"> | null>(null);
  // Render-stable "now" for the 14-day freshness window. Date.now() is impure
  // in render (react-hooks/purity), so it's captured once, off the render
  // phase, via a resolved microtask.
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
      if (alive) setNowMs(Date.now());
    });
    return () => {
      alive = false;
    };
  }, []);

  // Load the Hivra boxes + the user's real plan once. Both helpers swallow
  // failures (empty list / FREE_PLAN), so a blip degrades to "pending"/"locked"
  // instead of breaking the dashboard.
  useEffect(() => {
    if (!includeHivra) return;
    let alive = true;
    void listAgentsResult().then((res) => {
      if (!alive) return;
      setAgents(res.agents.filter((agent) => agent.status !== "deleted"));
      setAgentsLoaded(true);
      // HivraChat stamps the first-message marker per box; re-scan now in case
      // the send happened in another tab since the mount-time scan.
      if (hasFirstMessageMarker()) setLocalFirstMessage(true);
    });
    return () => {
      alive = false;
    };
  }, [includeHivra]);

  useEffect(() => {
    if (!undoable) return;
    const timer = window.setTimeout(() => {
      // Removing the focused Undo would drop keyboard and screen-reader users
      // onto <body>, so it stays until they move on.
      if (undoButton.current && document.activeElement === undoButton.current) setUndoExpired(true);
      else setUndoable(false);
    }, UNDO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [undoable]);

  // Undo unmounts the focused button; hand focus back to the restored
  // checklist's dismiss button instead of <body>.
  useEffect(() => {
    if (dismissed || !restoreFocus.current) return;
    restoreFocus.current = false;
    dismissButton.current?.focus();
  }, [dismissed]);

  useEffect(() => {
    let alive = true;
    void fetchPlan().then((p) => {
      if (alive) setPlan(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ③ — ask up to three running boxes whether their Telegram bot is connected
  // (the same status endpoint the HivraTelegram tab reads). Hermes-only users
  // have no box to probe, so the item simply stays pending for them.
  useEffect(() => {
    if (!agentsLoaded) return;
    const candidates = agents.filter((agent) => agent.status === "running" && agent.chat_url).slice(0, 3);
    if (candidates.length === 0) return;
    let alive = true;
    void Promise.all(
      candidates.map((agent) => telegramStatus(agent.chat_url as string, agent.api_token)),
    ).then((statuses) => {
      if (alive) setTelegramConnected(statuses.some((status) => status.connected));
    });
    return () => {
      alive = false;
    };
  }, [agentsLoaded, agents]);

  const totalDeployments = instances.length + agents.length;

  // "First deployment" age: the earliest created_at across both lanes. If no
  // row carries a parseable created_at we can't establish freshness — hide.
  const firstDeployAtMs = useMemo(() => {
    const stamps = [...instances, ...agents]
      .map((row) => (row.created_at ? Date.parse(row.created_at) : Number.NaN))
      .filter((ms) => Number.isFinite(ms));
    return stamps.length > 0 ? Math.min(...stamps) : null;
  }, [instances, agents]);

  const firstMessageDone =
    localFirstMessage ||
    instances.some((instance) => Boolean(instance.first_usage_at)) ||
    agents.some((agent) => Boolean(agent.first_usage_at));
  const isFreePlan = !plan?.subscribed || plan.key === "free";

  // Navigation targets: prefer a running Hivra box (richest surface), then any
  // box, then the Hermes lane.
  const targetBox = agents.find((agent) => agent.status === "running") ?? agents[0] ?? null;
  const targetInstance = instances[0] ?? null;

  const items: {
    id: ItemId;
    label: string;
    detail: string;
    icon: React.ReactNode;
    state: ItemState;
    pro?: boolean;
    onActivate: () => void;
  }[] = [
    {
      id: "deploy",
      label: "Deploy your agent",
      detail: "Your agent is live on its own machine.",
      icon: <Rocket size={14} />,
      state: totalDeployments > 0 ? "done" : "pending",
      onActivate: () => {
        if (targetBox) router.push(`/dashboard/agent/${targetBox.id}`);
        else if (targetInstance) router.push(`/dashboard/instances/${targetInstance.id}`);
        else router.push("/dashboard/welcome");
      },
    },
    {
      id: "message",
      label: "Send your first message",
      detail: "Open the chat and give it a real task.",
      icon: <MessageSquareText size={14} />,
      state: firstMessageDone ? "done" : "pending",
      onActivate: () => {
        if (targetBox) router.push(`/dashboard/agent/${targetBox.id}`);
        else router.push("/dashboard/chat");
      },
    },
    {
      id: "telegram",
      label: "Connect a channel (Telegram)",
      detail: "Get pinged when work is done — chat from your phone.",
      icon: <Send size={14} />,
      state: telegramConnected === true ? "done" : "pending",
      onActivate: () => {
        if (targetBox) router.push(`/dashboard/agent/${targetBox.id}?tab=telegram`);
        // surface=chat keeps the instance page from honoring a stored "tui"
        // surface preference and redirecting away before the connect modal opens.
        else if (targetInstance) router.push(`/dashboard/instances/${targetInstance.id}?surface=chat&connect=telegram`);
      },
    },
    {
      id: "browser",
      label: "Enable web browsing",
      detail: "Your agent gets a live Chrome it can drive.",
      icon: <Globe size={14} />,
      state: isFreePlan ? "locked" : acks.browser ? "done" : "pending",
      pro: true,
      onActivate: () => {
        if (isFreePlan) {
          setPaywallFeature("browser");
          return;
        }
        setAcks((current) => ({ ...current, browser: true }));
        writeLocalFlag(`${ACK_KEY_PREFIX}browser`);
        if (targetBox) router.push(`/dashboard/agent/${targetBox.id}?tab=browser`);
        else if (targetInstance) router.push(`/dashboard/instances/${targetInstance.id}`);
      },
    },
    {
      id: "cron",
      label: "Add a scheduled task",
      detail: "Recurring reports and monitors, on autopilot.",
      icon: <CalendarClock size={14} />,
      state: isFreePlan ? "locked" : acks.cron ? "done" : "pending",
      pro: true,
      onActivate: () => {
        if (isFreePlan) {
          setPaywallFeature("cron");
          return;
        }
        setAcks((current) => ({ ...current, cron: true }));
        writeLocalFlag(`${ACK_KEY_PREFIX}cron`);
        if (targetBox) router.push(`/dashboard/agent/${targetBox.id}`);
        else router.push("/dashboard/chat");
      },
    },
  ];

  const doneCount = items.filter((item) => item.state === "done").length;
  const allDone = doneCount === items.length;

  const fresh =
    firstDeployAtMs !== null && nowMs !== null && nowMs - firstDeployAtMs < MAX_FIRST_DEPLOY_AGE_MS;
  const visible = !dismissed && agentsLoaded && totalDeployments > 0 && fresh && !allDone;

  if (dismissed && undoable) {
    return (
      <div
        role="status"
        data-testid="onboarding-checklist-undo"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          border: "1px solid var(--etched-border)",
          padding: "0 0 0 clamp(1rem, 3vw, 1.4rem)",
          marginBottom: 18,
        }}
      >
        <span className="mono" style={monoLabel}>
          Checklist hidden
        </span>
        <button
          ref={undoButton}
          type="button"
          onClick={() => {
            clearLocalFlag(ONBOARDING_CHECKLIST_DISMISSED_KEY);
            restoreFocus.current = true;
            setDismissed(false);
            setUndoable(false);
            setUndoExpired(false);
            capture("onboarding_checklist_dismiss_undone", { plan: plan?.key ?? null });
          }}
          onBlur={() => {
            if (undoExpired) setUndoable(false);
          }}
          // After a keyboard dismiss focus lands here with the dismiss button
          // gone; the name says what was hidden, since the status text is often
          // not announced.
          aria-label="Undo hiding the checklist"
          autoFocus={focusUndo}
          className="mono"
          style={{
            ...monoLabel,
            minHeight: 44,
            padding: "0 16px",
            border: "none",
            borderLeft: "1px solid var(--etched-border)",
            background: "transparent",
            color: "var(--ink-black)",
            cursor: "pointer",
          }}
        >
          Undo
        </button>
      </div>
    );
  }

  if (!visible) {
    return paywallFeature ? (
      <UpgradePaywallModal
        feature={paywallFeature}
        currentPlan={plan?.key ?? null}
        onClose={() => setPaywallFeature(null)}
      />
    ) : null;
  }

  const dismiss = (event: React.MouseEvent<HTMLButtonElement>) => {
    writeLocalFlag(ONBOARDING_CHECKLIST_DISMISSED_KEY);
    setDismissed(true);
    setUndoable(true);
    setUndoExpired(false);
    // Enter/Space activation reports detail 0; a pointer click counts its clicks.
    setFocusUndo(event.detail === 0);
    capture("onboarding_checklist_dismissed", {
      done_count: doneCount,
      plan: plan?.key ?? null,
    });
  };

  const onItemClick = (item: (typeof items)[number]) => {
    capture("onboarding_checklist_item_clicked", {
      item: item.id,
      locked: item.state === "locked",
      plan: plan?.key ?? null,
    });
    item.onActivate();
  };

  return (
    <section
      data-testid="onboarding-checklist"
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: "clamp(1rem, 3vw, 1.4rem)",
        marginBottom: 18,
        position: "relative",
      }}
    >
      <button
        ref={dismissButton}
        type="button"
        onClick={dismiss}
        aria-label="Dismiss checklist"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 44,
          height: 44,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: "var(--text-muted)",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <X size={14} />
      </button>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div className="mono" style={{ ...monoLabel, letterSpacing: "0.18em" }}>
            Getting started
          </div>
          <h3 className="serif" style={{ margin: "6px 0 0", fontSize: "clamp(1.35rem, 3.5vw, 1.7rem)", fontWeight: 400, lineHeight: 1.1, color: "var(--ink-black)" }}>
            First steps
          </h3>
        </div>
        {/* Clear the 44px dismiss target whatever the card padding is. */}
        <span className="mono" style={{ ...monoLabel, marginLeft: "auto", paddingRight: "calc(48px - clamp(1rem, 3vw, 1.4rem))" }}>
          {doneCount} of {items.length} done
        </span>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {items.map((item) => {
          const done = item.state === "done";
          const locked = item.state === "locked";
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`onboarding-item-${item.id}`}
              data-state={item.state}
              onClick={() => onItemClick(item)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                textAlign: "left",
                border: "1px solid var(--etched-border)",
                background: done ? "rgba(255,255,255,0.015)" : "rgba(255,255,255,0.03)",
                padding: "10px 12px",
                cursor: "pointer",
                minWidth: 0,
                opacity: done ? 0.66 : 1,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  flexShrink: 0,
                  border: `1px solid ${done ? "var(--gold-leaf)" : "var(--etched-border)"}`,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: done ? "var(--gold-leaf)" : "var(--text-muted)",
                }}
              >
                {done ? <Check size={13} /> : locked ? <Lock size={11} /> : item.icon}
              </span>
              <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 1 }}>
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: "var(--ink-black)",
                    textDecoration: done ? "line-through" : "none",
                    textDecorationColor: "var(--text-muted)",
                  }}
                >
                  {item.label}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>{item.detail}</span>
              </span>
              {item.pro ? (
                <span
                  className="mono"
                  style={{
                    ...monoLabel,
                    fontSize: 9,
                    color: locked ? "var(--gold-leaf)" : "var(--text-muted)",
                    border: "1px solid var(--etched-border)",
                    padding: "3px 6px",
                    flexShrink: 0,
                  }}
                >
                  Pro
                </span>
              ) : null}
              <ChevronRight size={14} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
            </button>
          );
        })}
      </div>

      {paywallFeature ? (
        <UpgradePaywallModal
          feature={paywallFeature}
          currentPlan={plan?.key ?? null}
          onClose={() => setPaywallFeature(null)}
        />
      ) : null}
    </section>
  );
}
