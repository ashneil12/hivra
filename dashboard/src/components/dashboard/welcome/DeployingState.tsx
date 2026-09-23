'use client';

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Cpu,
  KeyRound,
  Loader2,
  RadioTower,
  Server,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { AnimateIn } from "@/components/ui/animate-in";
import { STYLES } from "@/components/dashboard/welcome/styles";

// Track W (web dejargonization): all copy on this screen is consumer
// language — a non-technical person watching the wait must never see infra
// vocabulary (compute/credentials/gateway/runtime/VM/Caddy). The step
// structure and timer logic are unchanged; only the words moved.
function buildDeploymentSteps(name: string): Array<{
  label: string;
  title: string;
  detail: string;
  Icon: LucideIcon;
}> {
  return [
    {
      label: "Computer",
      title: `Setting up ${name}'s computer`,
      detail: `A private computer, reserved just for ${name}.`,
      Icon: Cpu,
    },
    {
      label: "Workspace",
      title: "Creating a private, secure workspace",
      detail: "Locking everything down so only you have access.",
      Icon: KeyRound,
    },
    {
      label: "Skills",
      title: `Installing ${name}'s skills`,
      detail: `Adding everything ${name} needs to browse, write, and get work done.`,
      Icon: Server,
    },
    {
      label: "Wake up",
      title: `Waking ${name} up…`,
      detail: `Final checks — ${name} will say hello in a moment.`,
      Icon: RadioTower,
    },
  ];
}

function buildSecurityFacts(name: string): Array<{ label: string; detail: string }> {
  return [
    { label: "Private", detail: `A private computer just for ${name} — nothing is shared.` },
    { label: "Protected", detail: `Your data stays locked inside ${name}'s workspace.` },
    { label: "Encrypted", detail: "Encrypted end to end, from your browser onward." },
  ];
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

// Cosmetic pacing for the timeline. The provision POST is one opaque call,
// so steps advance on a timer to make the wait read as progress; the final
// step stays active (spinning) until the celebration replaces this screen.
const STEP_ADVANCE_MS = [13000, 31000, 49000];

// Phone overrides for the inline STYLES (hence !important): tighten the hero
// so the live step timeline starts above the fold at 375x667, and keep the
// three setup facts on one row with long names wrapping inside their cell.
const DEPLOYING_PHONE_CSS = `
@media (max-width: 767px) {
  .welcome-deploying-card { padding: 1rem !important; margin-top: 1rem !important; gap: 1rem !important; }
  .welcome-deploying-status { margin-bottom: 1rem !important; }
  .welcome-deploying-icon { width: 48px !important; height: 48px !important; }
  .welcome-deploying-title { font-size: 1.6rem !important; margin-bottom: 0.75rem !important; }
  .welcome-deploying-subtitle { font-size: 14px !important; line-height: 1.6 !important; margin-bottom: 1rem !important; }
  .welcome-deploying-stats { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) !important; }
  .welcome-deploying-stat { padding: 0.65rem 0.75rem !important; gap: 6px !important; }
}
`;

export function DeployingState({ agentName }: { agentName?: string | null } = {}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const name = (agentName ?? "").trim() || "your agent";
  const displayName = (agentName ?? "").trim() || "Your agent";
  const steps = buildDeploymentSteps(name);
  const securityFacts = buildSecurityFacts(name);
  const cardRef = useRef<HTMLElement>(null);

  // The deploy tap usually happens at the bottom of a long form; open this
  // screen at its top instead of at the form's old scroll offset.
  useEffect(() => {
    const card = cardRef.current;
    const scroller = card?.closest("main");
    if (!card || !scroller) return;
    // Scroll the page, not the card: the card is still mid entrance animation.
    if (card.getBoundingClientRect().top < scroller.getBoundingClientRect().top) scroller.scrollTop = 0;
  }, []);

  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const timers = STEP_ADVANCE_MS.map((ms, i) =>
      window.setTimeout(() => setActiveStep((s) => Math.max(s, i + 1)), ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <AnimateIn>
      <style>{DEPLOYING_PHONE_CSS}</style>
      <section
        role="status"
        aria-live="polite"
        aria-label="Setting up your agent"
        ref={cardRef}
        className="welcome-deploying-card"
        style={STYLES.deployingCard}
      >
        <div style={STYLES.deployingHeroPane}>
          <div className="welcome-deploying-status" style={STYLES.deployingStatusRow}>
            <div className="welcome-deploying-icon" style={STYLES.deployingIconWrap}>
              <Loader2
                size={30}
                aria-hidden="true"
                style={{ animation: "spin 1.5s linear infinite", color: "var(--gold-leaf)" }}
              />
            </div>
            <span className="mono" style={STYLES.deployingKicker}>
              Setting up
            </span>
          </div>
          <h2 className="serif welcome-deploying-title" style={STYLES.deployingTitle}>
            Getting {name} ready…
          </h2>
          <p className="welcome-deploying-subtitle" style={STYLES.deployingSubtitle}>
            {displayName} is getting a private computer, a secure workspace, and everything
            needed to start working. This typically takes 2-4 minutes.
          </p>

          <div className="welcome-deploying-stats" style={STYLES.deployingStatsGrid} aria-label="Setup summary">
            {[
              ["Agent", displayName],
              ["Ready in", "2-4 min"],
              ["Elapsed", formatElapsed(elapsedMs)],
            ].map(([label, value]) => (
              <div key={label} className="welcome-deploying-stat" style={STYLES.deployingStatCell}>
                <span className="mono" style={STYLES.deployingStatLabel}>
                  {label}
                </span>
                <span
                  className={label === "Elapsed" ? "mono" : undefined}
                  style={STYLES.deployingStatValue}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div style={STYLES.deployingOperationsPane}>
          <div style={STYLES.deployingSectionHeader}>
            <div>
              <span className="mono" style={STYLES.deployingSectionLabel}>
                What&apos;s happening
              </span>
              <p style={STYLES.deployingSectionCopy}>Each step happens live while you wait.</p>
            </div>
            <span className="mono" style={STYLES.deployingEtaPill}>
              2-4 min
            </span>
          </div>

          <div style={STYLES.deployingSteps}>
            {steps.map(({ label, title, detail, Icon }, i) => {
              const status = i < activeStep ? "done" : i === activeStep ? "active" : "pending";
              return (
                <div
                  key={label}
                  data-testid="deploying-step"
                  data-step-status={status}
                  style={{
                    ...STYLES.deployingStep,
                    opacity: status === "pending" ? 0.45 : 1,
                    transition: "opacity 0.4s ease",
                  }}
                >
                  <div
                    style={{
                      ...STYLES.deployingStepIcon,
                      ...(status === "done"
                        ? { background: "var(--gold-leaf)", color: "var(--vellum-bg)" }
                        : null),
                    }}
                  >
                    <Icon size={18} aria-hidden="true" />
                  </div>
                  <div style={STYLES.deployingStepBody}>
                    <span className="mono" style={STYLES.deployingStepLabel}>
                      {label}
                    </span>
                    <span style={STYLES.deployingStepTitle}>{title}</span>
                    <span style={STYLES.deployingStepDetail}>{detail}</span>
                  </div>
                  <span
                    className="mono"
                    aria-hidden="true"
                    style={{
                      ...STYLES.deployingStepIndex,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                    }}
                  >
                    {status === "done" ? (
                      <Check size={15} aria-hidden="true" style={{ color: "var(--gold-leaf)" }} />
                    ) : status === "active" ? (
                      <Loader2
                        size={15}
                        aria-hidden="true"
                        style={{ color: "var(--gold-leaf)", animation: "spin 1s linear infinite" }}
                      />
                    ) : (
                      String(i + 1).padStart(2, "0")
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={STYLES.deployingSecurityPanel}>
            <div style={STYLES.deployingSecurityHeader}>
              <ShieldCheck size={15} aria-hidden="true" />
              <span className="mono" style={STYLES.deployingSectionLabel}>
                Secure by default
              </span>
            </div>
            <ul style={STYLES.deployingSecurityList}>
              {securityFacts.map(({ label, detail }) => (
                <li key={label} style={STYLES.deployingSecurityItem}>
                  <span className="mono" style={STYLES.deployingSecurityItemLabel}>
                    {label}
                  </span>
                  <span style={STYLES.deployingSecurityItemDetail}>{detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </AnimateIn>
  );
}
