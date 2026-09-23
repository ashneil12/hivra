'use client';

import { useEffect, useState } from "react";
import {
  Cpu,
  KeyRound,
  Loader2,
  MessageCircle,
  Server,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { AnimateIn } from "@/components/ui/animate-in";
import { STYLES } from "@/components/dashboard/welcome/styles";

// Track W (web dejargonization): all copy on this screen is consumer
// language — a non-technical person watching the wait must never see infra
// vocabulary (compute/credentials/gateway/runtime/VM/Caddy).
//
// This screen covers one opaque provision request: nothing reports progress
// until it answers, so the list below describes what the request sets up and
// never marks any part active or done. The celebration screen that replaces
// this one shows the observed result.
function buildIncludedItems(name: string): Array<{
  label: string;
  title: string;
  detail: string;
  Icon: LucideIcon;
}> {
  return [
    {
      label: "Computer",
      title: `A private computer for ${name}`,
      detail: `Reserved just for ${name}.`,
      Icon: Cpu,
    },
    {
      label: "Workspace",
      title: `A workspace for ${name}`,
      detail: `Where ${name}'s files, tools and settings live.`,
      Icon: KeyRound,
    },
    {
      label: "Skills",
      title: `${name}'s skills`,
      detail: `Everything ${name} needs to get work done.`,
      Icon: Server,
    },
    {
      label: "Hello",
      title: `A first hello from ${name}`,
      detail: "You can start chatting once its computer is running.",
      Icon: MessageCircle,
    },
  ];
}

function buildSecurityFacts(name: string): Array<{ label: string; detail: string }> {
  return [
    { label: "Private", detail: `A private computer just for ${name} — nothing is shared.` },
    { label: "Protected", detail: `Your data stays locked inside ${name}'s workspace.` },
  ];
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function DeployingState({ agentName }: { agentName?: string | null } = {}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const name = (agentName ?? "").trim() || "your agent";
  const displayName = (agentName ?? "").trim() || "Your agent";
  const items = buildIncludedItems(name);
  const securityFacts = buildSecurityFacts(name);

  // Elapsed time is the only thing on this screen that changes: it is real
  // (wall clock since the request started), unlike a timed step list.
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <AnimateIn>
      <section
        role="status"
        aria-live="polite"
        aria-label="Setting up your agent"
        style={STYLES.deployingCard}
      >
        <div style={STYLES.deployingHeroPane}>
          <div style={STYLES.deployingStatusRow}>
            <div style={STYLES.deployingIconWrap}>
              <Loader2
                size={30}
                aria-hidden="true"
                style={{ animation: "spin 1.5s linear infinite", color: "var(--gold-leaf)" }}
              />
            </div>
            <span className="mono" style={STYLES.deployingKicker}>
              Request pending
            </span>
          </div>
          <h2 className="serif" style={STYLES.deployingTitle}>
            Getting {name} ready…
          </h2>
          <p style={STYLES.deployingSubtitle}>
            Hivra is creating {name}&apos;s computer. This is a pending request, not installation
            progress. Keep this page open; it changes as soon as Hivra answers. This typically
            takes 2-4 minutes.
          </p>

          <div style={STYLES.deployingStatsGrid} aria-label="Setup summary">
            {[
              ["Agent", displayName],
              ["Ready in", "2-4 min"],
              ["Elapsed", formatElapsed(elapsedMs)],
            ].map(([label, value]) => (
              <div key={label} style={STYLES.deployingStatCell}>
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
                What&apos;s included
              </span>
              <p style={STYLES.deployingSectionCopy}>
                This request sets up everything below. Nothing is shown as done until Hivra
                confirms it.
              </p>
            </div>
            <span className="mono" style={STYLES.deployingEtaPill}>
              2-4 min
            </span>
          </div>

          <ul style={{ ...STYLES.deployingSteps, listStyle: "none", margin: 0, padding: 0 }}>
            {items.map(({ label, title, detail, Icon }) => (
              <li key={label} data-testid="deploying-included-item" style={STYLES.deployingStep}>
                <div style={STYLES.deployingStepIcon}>
                  <Icon size={18} aria-hidden="true" />
                </div>
                <div style={STYLES.deployingStepBody}>
                  <span className="mono" style={STYLES.deployingStepLabel}>
                    {label}
                  </span>
                  <span style={STYLES.deployingStepTitle}>{title}</span>
                  <span style={STYLES.deployingStepDetail}>{detail}</span>
                </div>
              </li>
            ))}
          </ul>

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
