'use client';

import { useEffect, useState, useRef, useCallback, useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  AlertTriangle,
  Bot,
  Check,
  Loader2,
  MessageSquareText,
  Pencil,
  RotateCcw,
  ServerCog,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useUser } from "@clerk/nextjs";
import { TelemetryGrid } from "@/components/TelemetryGrid";
import { SafePortal } from "@/components/ui/SafePortal";
import { buildHermesFadeSlideVariants } from "@/components/ui/motion";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { readStoredJson, writeStoredJsonIfChanged } from "@/lib/client-storage";
import { pollWhenVisible } from "@/lib/poll-when-visible";
import { clientLog } from "@/lib/client/logger";
import type { InstanceFailureAlert } from "@/lib/failure-ownership";
import { PendingPromptBadge } from "@/components/dashboard/PendingPromptBadge";
import { AgentActivityDigest } from "@/components/dashboard/command-center/AgentActivityDigest";
import { AgentUsageSummary } from "@/components/dashboard/AgentUsageSummary";
import { OnboardingChecklist } from "@/components/dashboard/OnboardingChecklist";
import { ManagedVeniceCreditsPocket } from "@/components/dashboard/command-center/ManagedVeniceCreditsPocket";
import { AgentMemoryCard } from "@/components/dashboard/command-center/AgentMemoryCard";
import { HivraAgentsPanel } from "@/components/dashboard/command-center/HivraAgentsPanel";
import { DismissibleCredits } from "@/components/dashboard/command-center/DismissibleCredits";
import { isWebfreeBackend } from "@/lib/types/instance";
import {
  requestManagedVeniceSummary,
  type ManagedVeniceWalletSummaryPayload,
} from "@/lib/billing/managed-venice-client";
import {
  requestInstanceActivityDigest,
} from "@/lib/command-center/activity-client";
import type { InstanceActivityDigest } from "@/lib/command-center/activity";
import { buildAgentLaunchHref } from "@/lib/hivra/launch-navigation";

interface Instance {
  id: string;
  name: string;
  status: string;
  lifecycle_state?: string | null;
  paused_reason?: string | null;
  provider: string;
  backend?: string | null;
  public_ipv4?: string | null;
  host_id?: string;
  cpu_limit?: number;
  ram_limit?: number;
  created_at?: string | null;
  /** First observed agent session (read-only; stamped by the usage harvest). */
  first_usage_at?: string | null;
  config?: { model?: string; [key: string]: unknown };
  updateAlert?: {
    title: string;
    message: string;
    lastSeenAt: string;
    reason?: string;
    runType: "manual" | "scheduled";
  } | null;
  failureAlert?: InstanceFailureAlert | null;
  /**
   * Server-driven "your agent is blocked waiting for you" signal, sourced from
   * instance_pending_prompts by GET /api/instances. Replaces the retired
   * ApprovalBadge's per-card poll of a nonexistent agent endpoint.
   */
  pendingPrompt?: {
    promptId: string;
    kind: "approval" | "clarify";
    summary: string | null;
    surface: string | null;
    createdAt: string | null;
    expiresAt: string | null;
  } | null;
}

interface AgentProfile {
  name: string;
  display_name?: string;
}

interface Host {
  id: string;
  name: string;
  status: string;
  total_cpu: number;
  total_ram: number;
  used_cpu: number;
  used_ram: number;
  agent_count: number;
}

interface UsageData {
  subscribed: boolean;
  plan: {
    maxCpuPerAgent: number;
    maxRamPerAgent: number;
    totalCpu: number;
    totalRam: number;
  };
  usage: {
    usedCpu: number;
    usedRam: number;
  };
}

type CommandCenterV2FlagResponse = {
  success?: boolean;
  data?: {
    enabled?: boolean;
  };
  error?: string;
};

// Touch sizing for the legacy command center. Inline styles size desktop, so
// these rules use !important: card actions are always visible (and labelled)
// without hover, action buttons reach 44px on coarse pointers, and the host
// instance indent collapses on narrow phones.
/** Where an account with no agents starts: Launch, agents first. */
const FIRST_LAUNCH_HREF = buildAgentLaunchHref();

const HERMES_DASHBOARD_TOUCH_CSS = `
.hermes-card-action-label { display: none; }
@media (hover: none) {
  .hermes-card-action { opacity: 1 !important; }
  .hermes-card-action-label { display: inline; }
}
@media (pointer: coarse) {
  .hermes-touch-btn,
  .hermes-card-action { min-height: 44px !important; }
  .hermes-card-action { min-width: 44px !important; }
}
@media (max-width: 480px) {
  .hermes-host-indent { margin-left: 0 !important; padding-left: 12px !important; }
}`;

// Hover lift only for a real mouse; touch "hover" sticks after a tap.
function mouseHoverHandlers(setHovered: (hovered: boolean) => void) {
  return {
    onPointerEnter: (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse") setHovered(true);
    },
    onPointerLeave: () => setHovered(false),
  };
}

const TOUCH_ACTION_TEXT: CSSProperties = {
  minHeight: 40,
  fontSize: 11,
};

const CARD_ACTION_STYLE: CSSProperties = {
  border: "1px solid var(--etched-border)",
  padding: "0 10px",
  minWidth: 40,
  minHeight: 40,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  transition: "all 0.2s ease",
};

function interpolate(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replace(`{${key}}`, String(value)),
    template,
  );
}

function StatusDot({ status }: { status: string }) {
  const { copy } = useLocale();
  const statusCopy = copy.dashboard.commandCenter.status;
  const normalizedStatus = status.toLowerCase() as keyof typeof statusCopy;
  const label = statusCopy[normalizedStatus] ?? status;
  const colors: Record<string, string> = {
    running: "#22c55e",
    provisioning: "var(--yellow)",
    redeploying: "var(--yellow)",
    stopped: "#9ca3af",
    error: "#ef4444",
    failed: "#ef4444",
  };
  const glow: Record<string, string> = {
    running: "0 0 10px #22c55e",
    provisioning: "0 0 8px var(--yellow)",
    redeploying: "0 0 8px var(--yellow)",
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: colors[normalizedStatus] || "#9ca3af",
        boxShadow: glow[normalizedStatus] || "none",
        display: "inline-block",
      }} />
      <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.7 }}>{label}</span>
    </div>
  );
}

function isColdStorageRestorableInstance(instance: Instance): boolean {
  return (
    instance.lifecycle_state === "cold_archived" ||
    instance.lifecycle_state === "pending_deletion" ||
    instance.paused_reason === "cold_archived"
  );
}

function isColdStorageRestoringInstance(instance: Instance): boolean {
  return instance.lifecycle_state === "restoring";
}

function StartRestoreButton({
  loading,
  onClick,
  compact = false,
}: {
  loading: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={loading}
      className="hermes-touch-btn"
      style={{
        border: "1px solid rgba(29, 78, 216, 0.26)",
        background: loading ? "rgba(29, 78, 216, 0.08)" : "#1d4ed8",
        color: loading ? "#1d4ed8" : "#ffffff",
        padding: compact ? "8px 10px" : "9px 12px",
        cursor: loading ? "not-allowed" : "pointer",
        fontFamily: "var(--font-mono), monospace",
        ...TOUCH_ACTION_TEXT,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontWeight: 800,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        opacity: loading ? 0.78 : 1,
        whiteSpace: "nowrap",
      }}
    >
      <RotateCcw size={13} />
      {loading ? "Starting restore" : "Start restore"}
    </button>
  );
}

function InstanceCard({
  instance,
  restoreLoading = false,
  restoreError,
  onStartColdRestore,
}: {
  instance: Instance;
  restoreLoading?: boolean;
  restoreError?: string;
  onStartColdRestore?: (instance: Instance) => void;
}) {
  const router = useRouter();
  const { copy } = useLocale();
  const dashboardCopy = copy.dashboard.commandCenter;
  const [hovered, setHovered] = useState(false);
  const reduceMotion = Boolean(useReducedMotion());
  const cardVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 18 });

  // Inline rename. We keep a local displayName so the card updates instantly on
  // save without a parent refetch; the list refetch on next load reconciles it.
  const [displayName, setDisplayName] = useState(instance.name);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(instance.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const beginRename = () => {
    setNameError(null);
    setNameDraft(displayName);
    setRenaming(true);
  };
  const cancelRename = () => {
    setRenaming(false);
    setNameError(null);
  };
  const submitRename = async () => {
    const next = nameDraft.trim();
    if (!next || next === displayName) {
      setRenaming(false);
      setNameError(null);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const res = await fetch(`/api/instances/${instance.id}/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNameError(json?.error || "Couldn't rename. Try again.");
        return;
      }
      setDisplayName(json?.data?.name || next);
      setRenaming(false);
    } catch {
      setNameError("Couldn't rename. Check your connection and try again.");
    } finally {
      setSavingName(false);
    }
  };

  const avatarSrc = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(displayName)}&texture=camo01,camo02,circuits,dots,grunge01,grunge02&top=antenna,antennaCrooked,bulb01,glowingBulb01,glowingBulb02,lights,radar&mouth=diagram,grill01,grill02,grill03,smile01,smile02,square01,square02`;
  const showColdRestore = isColdStorageRestorableInstance(instance);
  const showColdRestoring = isColdStorageRestoringInstance(instance);

  return (
    <motion.div
      variants={cardVariants}
      onClick={() => router.push(`/dashboard/instances/${instance.id}`)}
      {...mouseHoverHandlers(setHovered)}
      style={{
        background: "var(--bg-surface)",
        border: `1px solid ${hovered ? "var(--ink-black)" : "var(--etched-border)"}`,
        boxShadow: hovered ? "0 8px 30px -8px rgba(0,0,0,0.12)" : "0 4px 20px -5px rgba(0,0,0,0.05)",
        transform: hovered ? "translateY(-3px)" : "translateY(0)",
        transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        padding: "clamp(1.25rem, 4vw, 2rem)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        minHeight: 200,
      }}
    >
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: "2rem" }}>
          <StatusDot status={instance.status} />
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <PendingPromptBadge pendingPrompt={instance.pendingPrompt} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                beginRename();
              }}
              className="hermes-card-action mono"
              style={{
                ...CARD_ACTION_STYLE,
                background: hovered ? "var(--ink-black)" : "transparent",
                color: hovered ? "var(--bg-surface)" : "var(--ink-black)",
                opacity: hovered ? 1 : 0.2,
              }}
              title="Rename agent"
              aria-label="Rename agent"
            >
              <Pencil size={14} aria-hidden="true" />
              <span className="hermes-card-action-label">Rename</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/dashboard/instances/${instance.id}/console`);
              }}
              className="hermes-card-action mono"
              style={{
                ...CARD_ACTION_STYLE,
                background: hovered ? "var(--ink-black)" : "transparent",
                color: hovered ? "var(--bg-surface)" : "var(--ink-black)",
                opacity: hovered ? 1 : 0.2,
              }}
              title={dashboardCopy.actions.advancedConsole}
              aria-label={dashboardCopy.actions.advancedConsole}
            >
              <Settings size={14} aria-hidden="true" />
              <span className="hermes-card-action-label">{dashboardCopy.actions.advancedConsole}</span>
            </button>
            <span className="mono" style={{ fontSize: 10.5, padding: "4px 8px", background: "transparent", border: "1px solid var(--etched-border)", color: "var(--ink-black)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              {instance.provider}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: '1rem' }}>
          <div style={{ width: 44, height: 44, border: '1px solid var(--etched-border)', overflow: 'hidden', flexShrink: 0 }}>
             <Image src={avatarSrc} alt={displayName} width={44} height={44} unoptimized style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            {renaming ? (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}
              >
                <input
                  autoFocus
                  value={nameDraft}
                  maxLength={60}
                  disabled={savingName}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); submitRename(); }
                    if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                  }}
                  className="serif"
                  style={{
                    fontSize: "1.1rem", fontWeight: 500, padding: "2px 6px", width: "100%",
                    minWidth: 0, maxWidth: 200, border: "1px solid var(--ink-black)",
                    background: "var(--bg-surface)", color: "var(--ink-black)",
                  }}
                />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); submitRename(); }}
                  disabled={savingName}
                  title="Save"
                  aria-label="Save name"
                  style={{ background: "var(--ink-black)", color: "var(--bg-surface)", border: "none", padding: "4px", cursor: savingName ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 40, minHeight: 40, flexShrink: 0 }}
                >
                  {savingName ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={13} />}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); cancelRename(); }}
                  disabled={savingName}
                  title="Cancel"
                  aria-label="Cancel rename"
                  style={{ background: "transparent", color: "var(--ink-black)", border: "1px solid var(--etched-border)", padding: "4px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 40, minHeight: 40, flexShrink: 0 }}
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <h4 className="serif" style={{ fontSize: "1.25rem", fontWeight: 500, marginBottom: 4, lineHeight: 1.3, textDecorationLine: hovered ? "underline" : "none", textUnderlineOffset: 4, textDecorationThickness: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</h4>
            )}
            {nameError ? (
              <p className="mono" style={{ fontSize: 10, color: "#b91c1c", marginBottom: 4, whiteSpace: "normal" }}>{nameError}</p>
            ) : null}
            <p className="mono" style={{ fontSize: 10, opacity: 0.4 }}>{dashboardCopy.instance.idPrefix}{dashboardCopy.labelSeparator}{instance.id.split('-')[0]}</p>
            {instance.public_ipv4 ? (
              <p className="mono" style={{ fontSize: 10, opacity: 0.6, marginTop: 6, wordBreak: "break-all" }}>
                {instance.public_ipv4}
              </p>
            ) : null}
          </div>
        </div>
        {instance.updateAlert ? (
          <div
            className="mono"
            style={{
              display: "grid",
              gap: 6,
              padding: "10px 12px",
              border: "1px solid rgba(180, 83, 9, 0.28)",
              background: "rgba(245, 158, 11, 0.08)",
              color: "#92400e",
            }}
          >
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>
              {dashboardCopy.alerts.updateTitle}
            </span>
            <span style={{ fontSize: 11, lineHeight: 1.6, textTransform: "none", letterSpacing: "normal" }}>
              {instance.updateAlert.runType === "scheduled"
                ? dashboardCopy.alerts.scheduledUpdateFailed
                : dashboardCopy.alerts.manualUpdateFailed}
            </span>
          </div>
        ) : null}
        {showColdRestore || showColdRestoring ? (
          <div
            data-testid="dashboard-cold-storage-restore"
            style={{
              display: "grid",
              gap: 10,
              padding: "10px 12px",
              border: "1px solid rgba(29, 78, 216, 0.24)",
              background: "rgba(59, 130, 246, 0.08)",
              color: "#1d4ed8",
              marginTop: instance.updateAlert ? 10 : 0,
            }}
          >
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800 }}>
              Cold storage
            </span>
            <span style={{ fontSize: 11, lineHeight: 1.6, color: "rgba(17, 24, 39, 0.74)" }}>
              {showColdRestoring
                ? "Restore is already running. Chat history and settings will come back when the agent is online."
                : "Your data is safe. Start restore to bring this agent back online."}
            </span>
            {showColdRestore && onStartColdRestore ? (
              <StartRestoreButton
                compact
                loading={restoreLoading}
                onClick={() => onStartColdRestore(instance)}
              />
            ) : null}
            {restoreError ? (
              <span style={{ fontSize: 11, lineHeight: 1.5, color: "#b91c1c" }}>
                {restoreError}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--etched-border)", paddingTop: "1rem", marginTop: "2rem" }}>
        <div style={{ display: "flex", gap: "1rem", opacity: 0.5 }}>
          <span className="mono" style={{ fontSize: 10, textTransform: "uppercase" }}>
            {/* Free-tier default (credit_base): 0.5 CPU / 1024 MB — see tier-specs.ts */}
            {instance.cpu_limit ? `${instance.cpu_limit} CPU` : "0.5 CPU"}
          </span>
          <span className="mono" style={{ fontSize: 10, textTransform: "uppercase" }}>
            {instance.ram_limit ? `${Math.round(instance.ram_limit / 1024)}GB` : "1GB"}
          </span>
        </div>
        <ArrowRight size={14} style={{ opacity: hovered ? 1 : 0.3, transition: "all 0.3s ease", transform: hovered ? "translateX(4px)" : "translateX(0)" }} />
      </div>
    </motion.div>
  );
}

function FailureSummaryBanner({ instances }: { instances: Instance[] }) {
  const router = useRouter();
  const { copy } = useLocale();
  const dashboardCopy = copy.dashboard.commandCenter;

  if (instances.length === 0) return null;

  return (
    <motion.div
      data-testid="dashboard-failure-alerts"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      style={{
        display: "grid",
        gap: 12,
        padding: "18px 20px",
        marginBottom: "2rem",
        border: "1px solid rgba(185, 28, 28, 0.24)",
        background: "rgba(254, 242, 242, 0.72)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <AlertTriangle size={16} style={{ color: "#b91c1c" }} />
        <span
          className="mono"
          style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: "#b91c1c", fontWeight: 700 }}
        >
          {dashboardCopy.alerts.activeFailureTitle}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: "var(--ink-black)" }}>
        {dashboardCopy.alerts.activeFailurePrefix} {instances.length} {instances.length === 1 ? dashboardCopy.alerts.activeFailureSingular : dashboardCopy.alerts.activeFailurePlural} {dashboardCopy.alerts.activeFailureSuffix}
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        {instances.map((instance) => {
          const alert = instance.failureAlert;
          if (!alert) return null;
          return (
            <button
              key={instance.id}
              type="button"
              onClick={() => router.push(`/dashboard/instances/${instance.id}/console`)}
              style={{
                border: "1px solid rgba(185, 28, 28, 0.22)",
                background: "rgba(255,255,255,0.72)",
                color: "var(--ink-black)",
                padding: "10px 12px",
                cursor: "pointer",
                display: "grid",
                gap: 4,
                textAlign: "left",
              }}
            >
              <span className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b91c1c" }}>
                {instance.name} · {alert.ownerLabel} · {alert.phaseLabel}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{alert.title}</span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {dashboardCopy.alerts.recoveryPrefix}: {alert.recoveryLabel}
              </span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

function ProfileCard({ profile, instance, isPrimary }: { profile: AgentProfile; instance: Instance; isPrimary?: boolean }) {
  const router = useRouter();
  const { copy } = useLocale();
  const dashboardCopy = copy.dashboard.commandCenter;
  const [hovered, setHovered] = useState(false);
  const reduceMotion = Boolean(useReducedMotion());
  const cardVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 18 });
  const seed = profile.name === 'default' ? instance.name : profile.name;
  const avatarSrc = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}&texture=camo01,camo02,circuits,dots,grunge01,grunge02&top=antenna,antennaCrooked,bulb01,glowingBulb01,glowingBulb02,lights,radar&mouth=diagram,grill01,grill02,grill03,smile01,smile02,square01,square02`;

  return (
    <motion.div
      variants={cardVariants}
      onClick={() => router.push(`/dashboard/chat?profile=${profile.name}`)}
      {...mouseHoverHandlers(setHovered)}
      style={{
        background: "var(--bg-surface)",
        border: `1px solid ${hovered ? "var(--ink-black)" : "var(--etched-border)"}`,
        boxShadow: hovered ? "0 8px 30px -8px rgba(0,0,0,0.12)" : "0 4px 20px -5px rgba(0,0,0,0.05)",
        transform: hovered ? "translateY(-3px)" : "translateY(0)",
        transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        padding: "clamp(1.25rem, 4vw, 2rem)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        minHeight: 200,
      }}
    >
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem" }}>
          <StatusDot status="running" />
          <span className="mono" style={{ fontSize: 10.5, padding: "4px 8px", background: "transparent", border: "1px solid var(--etched-border)", color: "var(--ink-black)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            {dashboardCopy.instance.profileNode}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: '1rem' }}>
          <div style={{ width: 44, height: 44, border: '1px solid var(--etched-border)', overflow: 'hidden', flexShrink: 0 }}>
             <Image src={avatarSrc} alt={profile.name} width={44} height={44} unoptimized style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h4 className="serif" style={{ fontSize: "1.25rem", fontWeight: 500, marginBottom: 4, lineHeight: 1.3, textDecorationLine: hovered ? "underline" : "none", textUnderlineOffset: 4, textDecorationThickness: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile.display_name || profile.name}</h4>
            <p className="mono" style={{ fontSize: 10, opacity: 0.4, textTransform: "uppercase" }}>{dashboardCopy.instance.hostInstancePrefix}{dashboardCopy.labelSeparator}{instance.name}</p>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--etched-border)", paddingTop: "1rem", marginTop: "2rem" }}>
        <div style={{ display: "flex", gap: "1rem", opacity: 0.5 }}>
           <span className="mono" style={{ fontSize: 10, textTransform: "uppercase" }}>{isPrimary ? dashboardCopy.instance.primaryAgent : dashboardCopy.instance.secondaryAgent}</span>
        </div>
        <ArrowRight size={14} style={{ opacity: hovered ? 1 : 0.3, transition: "all 0.3s ease", transform: hovered ? "translateX(4px)" : "translateX(0)" }} />
      </div>
    </motion.div>
  );
}




function NodeAllocationModal({ host, hostInstances, usageData, onClose, onSuccess, onDeleted }: { host: Host, hostInstances: Instance[], usageData: UsageData | null, onClose: () => void, onSuccess: () => void, onDeleted: () => void }) {
  const { copy } = useLocale();
  const dashboardCopy = copy.dashboard.commandCenter;
  const [allocs, setAllocs] = useState<Record<string, { cpu: number, ramGb: number }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const canConfirm = inputText === dashboardCopy.allocation.deleteConfirmationPhrase;

  const handleDeleteNode = async () => {
    if (!canConfirm) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/hosts/${host.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? dashboardCopy.allocation.failedToRemoveHost);
      onDeleted();
      onClose();
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  useEffect(() => {
    const init: Record<string, { cpu: number, ramGb: number }> = {};
    if (hostInstances) {
      hostInstances.forEach(inst => {
        // Free-tier default (credit_base): 0.5 CPU / 1024 MB — see tier-specs.ts
        init[inst.id] = { cpu: inst.cpu_limit || 0.5, ramGb: Math.round((inst.ram_limit || 1024) / 1024) };
      });
    }
    setAllocs(init);
  }, [hostInstances]);

  const handleSave = async () => {
    let sumCpu = 0;
    let sumRamGb = 0;
    Object.values(allocs).forEach(a => { sumCpu += a.cpu; sumRamGb += a.ramGb; });
    
    if (sumCpu > host.total_cpu) {
      setError(interpolate(dashboardCopy.allocation.cpuCapacityError, { allocated: sumCpu, capacity: host.total_cpu }));
      return;
    }
    if (sumRamGb * 1024 > host.total_ram) {
      setError(
        interpolate(dashboardCopy.allocation.memoryCapacityError, {
          allocated: sumRamGb,
          capacity: Math.floor(host.total_ram / 1024),
        }),
      );
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await Promise.all(
        hostInstances.map(inst => {
          const alloc = allocs[inst.id];
          // PATCH /api/instances/[id] — NOT .../resize. The resize route takes
          // no body: it re-applies the row's resource_tier spec and would snap
          // every agent to the tier max, silently discarding the per-agent
          // split entered above. This route honours an explicit size and
          // enforces the plan cap / pool budget / host capacity on the way in.
          return fetch(`/api/instances/${inst.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cpuLimit: alloc.cpu, ramLimit: alloc.ramGb * 1024 }),
          }).then(async r => {
            const data = await r.json();
            if (!data.success) throw new Error(`${inst.name}: ${data.error}`);
          });
        })
      );
      onSuccess();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  const updateAlloc = (id: string, field: "cpu" | "ramGb", val: number) => {
    setAllocs(prev => ({
      ...prev,
      [id]: { ...prev[id], [field]: val }
    }));
  };

  let maxCpuPerAgent = 8;
  let maxRamGbPerAgent = 16;
  if (usageData && usageData.subscribed) {
     maxCpuPerAgent = usageData.plan.maxCpuPerAgent;
     maxRamGbPerAgent = Math.floor(usageData.plan.maxRamPerAgent / 1024);
  }

  let sumCpu = 0;
  let sumRamGb = 0;
  Object.values(allocs).forEach(a => { sumCpu += a.cpu; sumRamGb += a.ramGb; });
  const cpuPct = Math.min(100, (sumCpu / host.total_cpu) * 100);
  const ramPct = Math.min(100, ((sumRamGb * 1024) / host.total_ram) * 100);

  return (
    <SafePortal>
      <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}>
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--etched-border)", padding: "clamp(1.25rem, 5vw, 2.5rem)", width: 560, maxWidth: "90vw", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 40px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem", gap: "1rem" }}>
          <div style={{ minWidth: 0 }}>
            <h4 className="serif" style={{ fontSize: "clamp(1.2rem, 5vw, 1.5rem)", fontWeight: 400, marginBottom: "0.25rem", wordBreak: "break-word" }}>{dashboardCopy.allocation.nodeAllocationPrefix}{dashboardCopy.labelSeparator}{host.name}</h4>
            <p className="mono" style={{ fontSize: 10, opacity: 0.5 }}>{dashboardCopy.instance.idPrefix}{dashboardCopy.labelSeparator}{host.id.split('-')[0]}</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.5, padding: "0" }}><X size={20} /></button>
        </div>

        <div style={{ marginBottom: "2rem", padding: "1.5rem", background: "rgba(0,0,0,0.02)", border: "1px solid var(--etched-border)" }}>
           <h5 className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: "1rem" }}>{dashboardCopy.allocation.projectedNodeUsage}</h5>
           <div style={{ marginBottom: "1rem" }}>
             <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
               <span className="mono" style={{ opacity: 0.6 }}>{dashboardCopy.allocation.cpuAllocated}</span>
               <span className="mono" style={{ fontWeight: 700, color: sumCpu > host.total_cpu ? "#ef4444" : "var(--ink-black)" }}>{sumCpu} / {host.total_cpu} {sumCpu === 1 ? dashboardCopy.instance.coreSingular : dashboardCopy.instance.corePlural}</span>
             </div>
             <div style={{ width: "100%", height: 4, background: "var(--etched-border)" }}>
               <div style={{ width: `${cpuPct}%`, height: "100%", background: sumCpu > host.total_cpu ? "#ef4444" : "var(--ink-black)", transition: "width 0.3s ease" }} />
             </div>
           </div>
           <div>
             <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
               <span className="mono" style={{ opacity: 0.6 }}>{dashboardCopy.allocation.memoryAllocated}</span>
               <span className="mono" style={{ fontWeight: 700, color: sumRamGb * 1024 > host.total_ram ? "#ef4444" : "var(--ink-black)" }}>{sumRamGb} / {Math.floor(host.total_ram/1024)} GB</span>
             </div>
             <div style={{ width: "100%", height: 4, background: "var(--etched-border)" }}>
               <div style={{ width: `${ramPct}%`, height: "100%", background: sumRamGb * 1024 > host.total_ram ? "#ef4444" : "var(--ink-black)", transition: "width 0.3s ease" }} />
             </div>
           </div>
        </div>

        {hostInstances.length === 0 && (
          <p className="mono" style={{ fontSize: 11, opacity: 0.5, textAlign: "center", marginBottom: "2rem" }}>{dashboardCopy.allocation.noActiveAgents}</p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "2rem", marginBottom: "2rem" }}>
          {hostInstances.map(inst => {
            const alloc = allocs[inst.id];
            if (!alloc) return null;
            return (
              <div key={inst.id} style={{ borderLeft: "2px solid var(--ink-black)", paddingLeft: "1.5rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                   <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} />
                   <h5 className="serif" style={{ fontSize: "1.1rem", fontWeight: 500 }}>{inst.name}</h5>
                   <span className="mono" style={{ fontSize: 10.5, opacity: 0.4 }}>{inst.id.split('-')[0]}</span>
                </div>
                
                <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <label className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", fontWeight: 700, opacity: 0.7 }}>{dashboardCopy.allocation.cpuAllocation}</label>
                      <span className="mono" style={{ fontSize: 10 }}>{alloc.cpu} {alloc.cpu === 1 ? dashboardCopy.instance.coreSingular : dashboardCopy.instance.corePlural}</span>
                    </div>
                    <input type="range" min="1" max={Math.min(host.total_cpu, maxCpuPerAgent)} step="1" value={alloc.cpu} onChange={e => updateAlloc(inst.id, "cpu", Number(e.target.value))} style={{ width: "100%", cursor: "pointer", accentColor: "var(--ink-black)" }} />
                  </div>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <label className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", fontWeight: 700, opacity: 0.7 }}>{dashboardCopy.allocation.memoryAllocation}</label>
                      <span className="mono" style={{ fontSize: 10 }}>{alloc.ramGb} GB</span>
                    </div>
                    <input type="range" min="1" max={Math.min(Math.floor(host.total_ram/1024), maxRamGbPerAgent)} step="1" value={alloc.ramGb} onChange={e => updateAlloc(inst.id, "ramGb", Number(e.target.value))} style={{ width: "100%", cursor: "pointer", accentColor: "var(--ink-black)" }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div style={{ marginBottom: "1.5rem" }}>
            <ErrorBanner
              error={error}
              context={{
                source: "client.diagnostic",
                route: "/api/instances",
                metadata: { surface: "InstanceCreateModal" },
              }}
            />
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
          <button onClick={onClose} disabled={loading || deleting} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono), monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, opacity: 0.6 }}>{dashboardCopy.actions.cancel}</button>
          <button onClick={handleSave} disabled={loading || deleting || hostInstances.length === 0} style={{ background: "var(--ink-black)", color: "var(--bg-surface)", border: "none", padding: "10px 20px", cursor: loading || hostInstances.length === 0 ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, display: "flex", alignItems: "center", gap: 8, opacity: hostInstances.length === 0 ? 0.5 : 1 }}>
            {loading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : null}
            {loading ? dashboardCopy.actions.applying : dashboardCopy.actions.applyChanges}
          </button>
        </div>

        {/* ── Danger Zone ── */}
        <div style={{ borderTop: "1px dashed rgba(239,68,68,0.3)", paddingTop: "1.5rem", marginTop: "2.5rem" }}>
          <h5 className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", color: "#ef4444", marginBottom: "1rem" }}>{dashboardCopy.allocation.dangerZone}</h5>
          {!confirmOpen ? (
            <button
              onClick={() => { setConfirmOpen(true); setInputText(""); setDeleteError(null); }}
              disabled={deleting}
              style={{
                width: "100%",
                border: "1px solid rgba(239,68,68,0.5)",
                background: "transparent",
                color: "#ef4444",
                padding: "8px 12px",
                cursor: deleting ? "not-allowed" : "pointer",
                fontFamily: "var(--font-mono), monospace",
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                opacity: deleting ? 0.5 : 1,
              }}
            >
              {deleting ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
              {deleting ? dashboardCopy.actions.removing : dashboardCopy.actions.removeNode}
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, color: "var(--ink-black)", lineHeight: 1.5, opacity: 0.7 }}>
                {dashboardCopy.allocation.deletePromptPrefix} <strong style={{ color: "#ef4444" }}>{dashboardCopy.allocation.deleteConfirmationPhrase}</strong> {dashboardCopy.allocation.deletePromptSuffix}
              </div>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="please delete"
                autoFocus
                style={{
                  width: "100%",
                  border: "1px solid var(--etched-border)",
                  background: "var(--bg-surface)",
                  padding: "8px 10px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono), monospace",
                  boxSizing: "border-box",
                }}
              />
              {deleteError && (
                <div style={{ fontSize: 11, color: "#ef4444", display: "flex", alignItems: "flex-start", gap: 6 }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                  {deleteError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleDeleteNode}
                  disabled={!canConfirm || deleting}
                  style={{
                    flex: 1,
                    border: "1px solid #ef4444",
                    background: "#ef4444",
                    color: "#fff",
                    padding: "8px 12px",
                    fontSize: 11,
                    fontFamily: "var(--font-mono), monospace",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    cursor: !canConfirm || deleting ? "not-allowed" : "pointer",
                    opacity: !canConfirm || deleting ? 0.5 : 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                  }}
                >
                  {deleting ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : null}
                  {deleting ? dashboardCopy.actions.removing : dashboardCopy.actions.confirmRemove}
                </button>
                <button
                  onClick={() => { setConfirmOpen(false); setInputText(""); setDeleteError(null); }}
                  disabled={deleting}
                  style={{
                    flex: 1,
                    border: "1px solid var(--etched-border)",
                    background: "var(--bg-surface)",
                    color: "var(--ink-black)",
                    padding: "8px 12px",
                    fontSize: 11,
                    fontFamily: "var(--font-mono), monospace",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    cursor: deleting ? "not-allowed" : "pointer",
                    opacity: deleting ? 0.5 : 1,
                  }}
                >
                  {dashboardCopy.actions.cancel}
                </button>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </SafePortal>
  );
}

// ─── Host Card ───────────────────────────────────────────────────────────────
function HostCard({
  host,
  cpuPct,
  ramPct,
}: {
  host: Host;
  cpuPct: number;
  ramPct: number;
}) {
  const { copy } = useLocale();
  const dashboardCopy = copy.dashboard.commandCenter;
  const reduceMotion = Boolean(useReducedMotion());
  const cardVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 18 });

  return (
    <motion.div
      variants={cardVariants}
      style={{
        border: "1px solid var(--etched-border)",
        background: "var(--bg-surface)",
        padding: "clamp(1.25rem, 4vw, 2rem)",
        transition: "opacity 0.3s ease",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
        <StatusDot status={host.status} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* <button
            onClick={(e) => {
              e.stopPropagation();
              onAllocationClick();
            }}
            title={dashboardCopy.actions.manageAllocation}
            style={{
              background: "transparent",
              color: "var(--ink-black)",
              border: "1px solid var(--etched-border)",
              padding: "4px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s ease",
            }}
          >
            <Sliders size={14} />
          </button> */}
          <span className="mono" style={{ fontSize: 10.5, textTransform: "uppercase", opacity: 0.5 }}>
            {host.id.split("-")[0]}
          </span>
        </div>
      </div>

      <h4 className="serif" style={{ fontSize: "1.25rem", fontWeight: 500, marginBottom: "0.5rem" }}>
        {host.name}
      </h4>
      <p className="mono" style={{ fontSize: 10, opacity: 0.5, marginBottom: "2rem" }}>
        {host.agent_count} {host.agent_count === 1 ? dashboardCopy.instance.activeAgentSingular : dashboardCopy.instance.activeAgentPlural}
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
          <span className="mono" style={{ opacity: 0.6 }}>{dashboardCopy.allocation.cpuAllocated}</span>
          <span className="mono" style={{ fontWeight: 700 }}>{host.used_cpu} / {host.total_cpu} {host.used_cpu === 1 ? dashboardCopy.instance.coreSingular : dashboardCopy.instance.corePlural}</span>
        </div>
        <div style={{ width: "100%", height: 4, background: "var(--etched-border)" }}>
          <div style={{ width: `${Math.min(100, cpuPct)}%`, height: "100%", background: "var(--ink-black)", transition: "width 0.5s ease" }} />
        </div>
      </div>

      <div style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
          <span className="mono" style={{ opacity: 0.6 }}>{dashboardCopy.allocation.memoryAllocated}</span>
          <span className="mono" style={{ fontWeight: 700 }}>{host.used_ram} / {host.total_ram} MB</span>
        </div>
        <div style={{ width: "100%", height: 4, background: "var(--etched-border)" }}>
          <div style={{ width: `${Math.min(100, ramPct)}%`, height: "100%", background: "var(--ink-black)", transition: "width 0.5s ease" }} />
        </div>
      </div>
    </motion.div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

function PrimaryAgentPanel({
  instance,
  digest,
  activityLoading,
  activityError,
  restoreLoading,
  restoreError,
  onOpenChat,
  onOpenConsole,
  onStartColdRestore,
}: {
  instance: Instance;
  digest: InstanceActivityDigest | null;
  activityLoading: boolean;
  activityError: string | null;
  restoreLoading: boolean;
  restoreError?: string;
  onOpenChat: () => void;
  onOpenConsole: () => void;
  onStartColdRestore: () => void;
}) {
  const model = typeof instance.config?.model === "string" ? instance.config.model : null;
  const showColdRestore = isColdStorageRestorableInstance(instance);
  const showColdRestoring = isColdStorageRestoringInstance(instance);

  return (
    <section
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: "clamp(1rem, 3vw, 1.4rem)",
        display: "grid",
        gap: 16,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.64 }}>
            Primary Agent
          </div>
          <h3 className="serif" style={{ fontSize: "clamp(1.6rem, 4vw, 2.15rem)", margin: "6px 0 8px", fontWeight: 400, lineHeight: 1.1 }}>
            {instance.name}
          </h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <StatusDot status={instance.status} />
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", opacity: 0.62 }}>
              {instance.provider}{model ? ` · ${model}` : ""}
            </span>
          </div>
          {showColdRestore || showColdRestoring ? (
            <div
              style={{
                marginTop: 12,
                display: "grid",
                gap: 6,
                color: "#1d4ed8",
                maxWidth: 560,
              }}
            >
              <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 800 }}>
                Cold storage
              </span>
              <span style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.55 }}>
                {showColdRestoring
                  ? "Restore is already running. Chat history and settings will come back when the agent is online."
                  : "Your data is safe. Start restore to bring this agent back online."}
              </span>
              {restoreError ? (
                <span style={{ color: "#b91c1c", fontSize: 12, lineHeight: 1.45 }}>
                  {restoreError}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {showColdRestore ? (
            <StartRestoreButton
              loading={restoreLoading}
              onClick={onStartColdRestore}
            />
          ) : null}
          <button
            type="button"
            onClick={onOpenChat}
            className="hermes-touch-btn"
            style={{
              border: "1px solid var(--ink-black)",
              background: "var(--ink-black)",
              color: "var(--bg-surface)",
              padding: "9px 12px",
              cursor: "pointer",
              fontFamily: "var(--font-mono), monospace",
              ...TOUCH_ACTION_TEXT,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              fontWeight: 800,
              display: "inline-flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <MessageSquareText size={13} /> Open Chat
          </button>
          <button
            type="button"
            onClick={onOpenConsole}
            className="hermes-touch-btn"
            style={{
              border: "1px solid var(--etched-border)",
              background: "transparent",
              color: "var(--ink-black)",
              padding: "9px 12px",
              cursor: "pointer",
              fontFamily: "var(--font-mono), monospace",
              ...TOUCH_ACTION_TEXT,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              fontWeight: 800,
              display: "inline-flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <ServerCog size={13} /> Advanced Console
          </button>
        </div>
      </div>

      <AgentActivityDigest digest={digest} loading={activityLoading} error={activityError} />

      <AgentUsageSummary instanceId={instance.id} />
    </section>
  );
}

function FleetOverview({
  instances,
  activityByInstanceId,
}: {
  instances: Instance[];
  activityByInstanceId: Record<string, InstanceActivityDigest>;
}) {
  const runningCount = instances.filter((instance) => instance.status === "running").length;
  const attentionCount = instances.filter((instance) => {
    const digest = activityByInstanceId[instance.id];
    return Boolean(instance.failureAlert || instance.updateAlert || digest?.attentionItems.length);
  }).length;

  return (
    <section
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: "clamp(1rem, 3vw, 1.4rem)",
        display: "grid",
        gap: 16,
        minWidth: 0,
      }}
    >
      <div>
        <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.64 }}>
          Fleet Signal
        </div>
        <h3 className="serif" style={{ fontSize: "clamp(1.6rem, 4vw, 2.15rem)", margin: "6px 0 8px", fontWeight: 400, lineHeight: 1.1 }}>
          {runningCount} running · {attentionCount} need attention
        </h3>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {instances.slice(0, 5).map((instance) => {
          const digest = activityByInstanceId[instance.id];
          return (
            <div
              key={instance.id}
              style={{
                borderTop: "1px solid var(--etched-border)",
                paddingTop: 10,
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{instance.name}</strong>
                <div className="mono" style={{ fontSize: 10, opacity: 0.58, textTransform: "uppercase", marginTop: 4 }}>
                  {instance.provider}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 10, opacity: 0.72, textTransform: "uppercase", textAlign: "right" }}>
                {digest?.headline ?? instance.status}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function activityHeadline(instance: Instance, digest: InstanceActivityDigest | undefined) {
  if (!digest) return `${instance.name} is ${instance.status}`;
  return `${instance.name} is ${digest.headline.toLowerCase()}`;
}

function latestSessionLine(digest: InstanceActivityDigest | undefined) {
  const latest = digest?.recentSessions?.[0];
  if (!latest) return "No recent WebUI sessions yet";
  const parts = [latest.title];
  if (latest.model) parts.push(latest.model);
  if (typeof latest.messageCount === "number") {
    parts.push(`${latest.messageCount} ${latest.messageCount === 1 ? "message" : "messages"}`);
  }
  return parts.join(" · ");
}

function PilotMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: "16px",
        display: "grid",
        gap: 10,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.62 }}>
          {label}
        </span>
        <span style={{ color: "var(--gold-leaf)", display: "inline-flex" }}>{icon}</span>
      </div>
      <strong className="serif" style={{ fontSize: "clamp(1.55rem, 4vw, 2.1rem)", fontWeight: 400, lineHeight: 1 }}>
        {value}
      </strong>
      <span style={{ color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>{detail}</span>
    </div>
  );
}

function AgentSignalRow({
  instance,
  digest,
  loading,
  error,
  restoreLoading,
  restoreError,
  onOpenAgent,
  onOpenChat,
  onOpenConsole,
  onStartColdRestore,
}: {
  instance: Instance;
  digest: InstanceActivityDigest | undefined;
  loading: boolean;
  error: string | undefined;
  restoreLoading: boolean;
  restoreError?: string;
  onOpenAgent: () => void;
  onOpenChat: () => void;
  onOpenConsole: () => void;
  onStartColdRestore: () => void;
}) {
  const model = typeof instance.config?.model === "string" ? instance.config.model : null;
  const managedVeniceEnabled =
    typeof instance.config?.managedVenice === "object" &&
    instance.config?.managedVenice !== null &&
    (instance.config.managedVenice as { enabled?: unknown }).enabled === true;
  const showColdRestore = isColdStorageRestorableInstance(instance);

  return (
    <article
      data-testid="command-center-v2-agent-row"
        style={{
          borderTop: "1px solid var(--etched-border)",
          padding: "18px 0",
          display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
        gap: 18,
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0, display: "grid", gap: 8 }}>
        <StatusDot status={instance.status} />
        <button
          type="button"
          onClick={onOpenAgent}
          className="serif"
          style={{
            border: 0,
            background: "transparent",
            color: "var(--ink-black)",
            padding: 0,
            textAlign: "left",
            cursor: "pointer",
            fontSize: "clamp(1.15rem, 3vw, 1.45rem)",
            fontWeight: 500,
            lineHeight: 1.15,
          }}
        >
          {instance.name}
        </button>
        <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", opacity: 0.58 }}>
          {instance.provider}{model ? ` · ${model}` : ""}{managedVeniceEnabled ? " · Managed Venice" : ""}
        </span>
      </div>

      <div style={{ minWidth: 0, display: "grid", gap: 7 }}>
        <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.58 }}>
          Current Status
        </div>
        <strong style={{ fontSize: 15, lineHeight: 1.35 }}>
          {showColdRestore ? "Paused in cold storage" : loading ? "Refreshing status" : error || activityHeadline(instance, digest)}
        </strong>
        <span style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.55 }}>
          {showColdRestore
            ? "Start restore to bring chat history and settings back online."
            : digest?.detail || latestSessionLine(digest)}
        </span>
        {restoreError ? (
          <span style={{ color: "#b91c1c", fontSize: 12, lineHeight: 1.45 }}>
            {restoreError}
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-start" }}>
        {showColdRestore ? (
          <StartRestoreButton
            loading={restoreLoading}
            onClick={onStartColdRestore}
          />
        ) : null}
        <button
          type="button"
          onClick={onOpenChat}
          className="hermes-touch-btn"
          style={{
            border: "1px solid var(--ink-black)",
            background: "var(--ink-black)",
            color: "var(--bg-surface)",
            padding: "9px 12px",
            cursor: "pointer",
            fontFamily: "var(--font-mono), monospace",
            ...TOUCH_ACTION_TEXT,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 800,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <MessageSquareText size={13} /> Chat
        </button>
        <button
          type="button"
          onClick={onOpenConsole}
          className="hermes-touch-btn"
          style={{
            border: "1px solid var(--etched-border)",
            background: "transparent",
            color: "var(--ink-black)",
            padding: "9px 12px",
            cursor: "pointer",
            fontFamily: "var(--font-mono), monospace",
            ...TOUCH_ACTION_TEXT,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 800,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <ServerCog size={13} /> Advanced Console
        </button>
      </div>
    </article>
  );
}

function timeOfDayGreeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Agent-presence element + personal greeting. A soft pulsing brand-red orb
 * (Hivra accent, NOT paioclaw orange) sitting next to a time-of-day greeting
 * that addresses the user by first name when Clerk knows it, falling back to a
 * name-less greeting otherwise. Purely additive / decorative — it never gates
 * or alters the surface below it.
 */
function AgentPresenceGreeting() {
  const { user, isLoaded } = useUser();
  const reduceMotion = Boolean(useReducedMotion());
  const [now, setNow] = useState<Date | null>(null);

  // Defer the clock read to the client so SSR/hydration stay stable, and keep
  // the greeting honest if the dashboard stays open across an hour boundary.
  // The first read is queued (not set synchronously in the effect body) to
  // satisfy react-hooks/set-state-in-effect; behavior is unchanged (client-only,
  // post-mount), and the interval callback is already deferred.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setNow(new Date());
    });
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const firstName = isLoaded ? user?.firstName?.trim() || null : null;
  const greeting = timeOfDayGreeting(now ?? undefined);
  const headline = firstName ? `${greeting}, ${firstName}` : `${greeting}`;

  return (
    <div
      data-testid="agent-presence-greeting"
      style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, minWidth: 0 }}
    >
      <span
        aria-hidden
        style={{
          position: "relative",
          width: 12,
          height: 12,
          flexShrink: 0,
          display: "inline-flex",
        }}
      >
        {/* Soft expanding halo — the "presence" pulse. Skipped under reduced motion. */}
        {!reduceMotion ? (
          <motion.span
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background: "var(--gold-leaf)",
            }}
            initial={{ opacity: 0.45, scale: 1 }}
            animate={{ opacity: 0, scale: 2.6 }}
            transition={{ duration: 2.4, ease: "easeOut", repeat: Infinity }}
          />
        ) : null}
        {/* Solid core orb with a gentle breathing glow. */}
        <motion.span
          style={{
            position: "relative",
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "var(--gold-leaf)",
            boxShadow: "0 0 10px var(--gold-leaf)",
          }}
          animate={
            reduceMotion
              ? undefined
              : { boxShadow: ["0 0 6px var(--gold-leaf)", "0 0 16px var(--gold-leaf)", "0 0 6px var(--gold-leaf)"] }
          }
          transition={{ duration: 2.4, ease: "easeInOut", repeat: Infinity }}
        />
      </span>
      <div style={{ minWidth: 0 }}>
        <p
          className="serif"
          style={{
            margin: 0,
            fontSize: "clamp(1.05rem, 3vw, 1.35rem)",
            fontWeight: 400,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {headline}
        </p>
        <span
          className="mono"
          style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.55 }}
        >
          Your agents are standing by
        </span>
      </div>
    </div>
  );
}

function CommandCenterV2Surface({
  instances,
  hosts,
  loading,
  error,
  managedVeniceSummary,
  managedVeniceSummaryLoading,
  managedVeniceSummaryError,
  activityByInstanceId,
  activityErrorsByInstanceId,
  activityLoadingByInstanceId,
  failureFlaggedInstances,
  updateFlaggedInstances,
  restoreLoadingByInstanceId,
  restoreErrorByInstanceId,
  onOpenAgent,
  onOpenChat,
  onOpenConsole,
  onStartColdRestore,
  onTopUpCredits,
  onManageCredits,
  onDeployAgent,
  showHivra,
}: {
  instances: Instance[];
  hosts: Host[];
  loading: boolean;
  error: string | null;
  managedVeniceSummary: ManagedVeniceWalletSummaryPayload | null;
  managedVeniceSummaryLoading: boolean;
  managedVeniceSummaryError: string | null;
  activityByInstanceId: Record<string, InstanceActivityDigest>;
  activityErrorsByInstanceId: Record<string, string>;
  activityLoadingByInstanceId: Record<string, boolean>;
  failureFlaggedInstances: Instance[];
  updateFlaggedInstances: Instance[];
  restoreLoadingByInstanceId: Record<string, boolean>;
  restoreErrorByInstanceId: Record<string, string>;
  onOpenAgent: (instanceId: string) => void;
  onOpenChat: (instanceId: string) => void;
  onOpenConsole: (instanceId: string) => void;
  onStartColdRestore: (instance: Instance) => void;
  onTopUpCredits: () => void;
  onManageCredits: () => void;
  onDeployAgent: () => void;
  showHivra: boolean;
}) {
  const runningCount = instances.filter((instance) => instance.status === "running").length;
  const activeStreams = Object.values(activityByInstanceId).reduce(
    (total, digest) => total + (digest.activeStreams || 0),
    0
  );
  const attentionCount =
    failureFlaggedInstances.length +
    updateFlaggedInstances.length +
    Object.values(activityByInstanceId).reduce(
      (total, digest) => total + digest.attentionItems.length,
      0
    );

  // Hivra boxes count toward "Agents Online" too (reported up from the panel).
  const [hivraCounts, setHivraCounts] = useState({ running: 0, total: 0 });
  const onlineRunning = runningCount + (showHivra ? hivraCounts.running : 0);
  const onlineTotal = instances.length + (showHivra ? hivraCounts.total : 0);

  return (
    <div
      data-testid="command-center-v2"
      style={{
        maxWidth: 1180,
        margin: "1rem auto 5rem",
        padding: "clamp(1rem, 5vw, 3rem)",
        paddingTop: "calc(var(--dashboard-page-safe-top, env(safe-area-inset-top, 0px)) + clamp(1rem, 5vw, 3rem))",
        paddingBottom: "5rem",
        position: "relative",
        zIndex: 1,
      }}
    >
      <style>{HERMES_DASHBOARD_TOUCH_CSS}</style>
      <header
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
          gap: 24,
          alignItems: "end",
          marginBottom: "clamp(1.5rem, 6vw, 3rem)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <AgentPresenceGreeting />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--gold-leaf)", display: "inline-block" }} />
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.28em", opacity: 0.68 }}>
              Command Center Pilot
            </span>
          </div>
          <h2 className="serif" style={{ fontSize: "clamp(2.6rem, 8vw, 4.4rem)", fontWeight: 300, lineHeight: 1.02, margin: 0 }}>
            Command <em>Center</em>.
          </h2>
          <p style={{ margin: "14px 0 0", maxWidth: 680, color: "var(--text-secondary)", fontSize: 15, lineHeight: 1.7 }}>
            Real-time agent signal and fleet controls in one operating surface.
          </p>
        </div>
      </header>

      <FailureSummaryBanner instances={failureFlaggedInstances} />

      {/* Day-one activation checklist — sits above the agents list while the
          user's first deployment is fresh (<14d) and steps remain. */}
      <OnboardingChecklist instances={instances} includeHivra={showHivra} />

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 18 }}>
        <PilotMetric icon={<Bot size={17} />} label="Agents Online" value={`${onlineRunning}/${onlineTotal}`} detail={`${attentionCount} items need attention`} />
        <PilotMetric icon={<Activity size={17} />} label="Live Work" value={`${activeStreams}`} detail="Active WebUI streams right now" />
      </section>

      {showHivra ? (
        <HivraAgentsPanel
          hermesInstances={instances.map((i) => ({
            id: i.id,
            name: i.name,
            provider: i.provider,
            model: typeof i.config?.model === "string" ? i.config.model : null,
            status: i.status,
          }))}
          onOpenInstance={(iid) => onOpenAgent(iid)}
          onOpenConsole={(iid) => onOpenConsole(iid)}
          onCounts={setHivraCounts}
        />
      ) : null}

      <main style={{ display: "grid", gridTemplateColumns: showHivra ? "minmax(260px, 440px) minmax(0, 1fr)" : "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 18, alignItems: "start" }}>
        {showHivra ? null : (
        <section
          style={{
            border: "1px solid var(--etched-border)",
            background: "rgba(255,255,255,0.035)",
            padding: "clamp(1rem, 3vw, 1.5rem)",
            minWidth: 0,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
            <div>
              <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", opacity: 0.58 }}>
                Agent Activity
              </div>
              <h3 className="serif" style={{ margin: "6px 0 0", fontSize: "clamp(1.55rem, 4vw, 2.1rem)", fontWeight: 400 }}>
                Active agents
              </h3>
            </div>
          </div>

          {loading ? (
            <div style={{ minHeight: 180, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Loader2 size={20} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} />
            </div>
          ) : error ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 0", color: "#b91c1c" }}>
              <AlertTriangle size={17} /> {error}
            </div>
          ) : instances.length === 0 ? (
            <div style={{ padding: "18px 0", display: "grid", gap: 14, justifyItems: "start" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>No agents yet.</span>
              <a
                href={FIRST_LAUNCH_HREF}
                onClick={(event) => {
                  event.preventDefault();
                  onDeployAgent();
                }}
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 44,
                  padding: "0 16px",
                  border: "1px solid var(--ink-black)",
                  background: "var(--ink-black)",
                  color: "var(--bg-surface)",
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  textDecoration: "none",
                }}
              >
                Launch an agent <ArrowRight size={14} aria-hidden="true" />
              </a>
            </div>
          ) : (
            instances.map((instance) => (
              <AgentSignalRow
                key={instance.id}
                instance={instance}
                digest={activityByInstanceId[instance.id]}
                loading={Boolean(activityLoadingByInstanceId[instance.id])}
                error={activityErrorsByInstanceId[instance.id]}
                restoreLoading={Boolean(restoreLoadingByInstanceId[instance.id])}
                restoreError={restoreErrorByInstanceId[instance.id]}
                onOpenAgent={() => onOpenAgent(instance.id)}
                onOpenChat={() => onOpenChat(instance.id)}
                onOpenConsole={() => onOpenConsole(instance.id)}
                onStartColdRestore={() => onStartColdRestore(instance)}
              />
            ))
          )}
        </section>
        )}

        <aside style={{ display: "grid", gap: 14, minWidth: 0, maxWidth: showHivra ? 460 : undefined }}>
          {showHivra ? (
            <DismissibleCredits
              summary={managedVeniceSummary}
              loading={managedVeniceSummaryLoading}
              error={managedVeniceSummaryError}
              onTopUp={onTopUpCredits}
              onManage={onManageCredits}
            />
          ) : (
            <ManagedVeniceCreditsPocket
              summary={managedVeniceSummary}
              loading={managedVeniceSummaryLoading}
              error={managedVeniceSummaryError}
              onTopUp={onTopUpCredits}
              onManage={onManageCredits}
            />
          )}

          {/* Read-only surfacing of account-level shared memory (Wave 5.1) so
              users see what their agents already know about them. Display only;
              editing lives at /dashboard/settings/memory. */}
          <AgentMemoryCard />
        </aside>

      </main>

      {hosts.length > 0 ? (
        <section style={{ marginTop: 18, border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.03)", padding: "clamp(1rem, 3vw, 1.4rem)" }}>
          <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", opacity: 0.58, marginBottom: 12 }}>
            Capacity
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {hosts.map((host) => {
              const cpuPct = host.total_cpu ? Math.round((host.used_cpu / host.total_cpu) * 100) : 0;
              const ramPct = host.total_ram ? Math.round((host.used_ram / host.total_ram) * 100) : 0;
              return (
                <div key={host.id} style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 12, display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <strong>{host.name}</strong>
                    <StatusDot status={host.status} />
                  </div>
                  <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", opacity: 0.58 }}>
                    {host.agent_count} agents · CPU {cpuPct}% · RAM {ramPct}%
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {!showHivra && instances.length === 1 ? (
        <section style={{ marginTop: 18 }}>
          <TelemetryGrid
            instanceId={instances[0].id}
            provider={instances[0].provider}
            model={instances[0].config?.model}
          />
        </section>
      ) : null}

    </div>
  );
}

export function HermesDashboardPage() {
  const router = useRouter();
  const { copy } = useLocale();
  const dashboardCopy = copy.dashboard.commandCenter;
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allocationHost, setAllocationHost] = useState<Host | null>(null);
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [mounted, setMounted] = useState(false);
  const { user, isLoaded } = useUser();
  const userId = user?.id;

  const [hosts, setHosts] = useState<Host[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const fetchedProfilesRef = useRef(false);
  const [managedVeniceSummary, setManagedVeniceSummary] =
    useState<ManagedVeniceWalletSummaryPayload | null>(null);
  const [managedVeniceSummaryLoading, setManagedVeniceSummaryLoading] = useState(false);
  const [managedVeniceSummaryError, setManagedVeniceSummaryError] = useState<string | null>(null);
  // Pinned false: the Hivra surfaces are served by the workspace view now, and
  // this component is only reached when the workspace shell is disabled — which
  // is exactly the Hermes-only environments. Kept as state rather than deleted
  // because it still gates the HivraAgentsPanel render and two layout ternaries
  // below; those are dead here, but they are prod-untestable and leave with a
  // separate change rather than this one.
  const showHivra = false;
  const [activityByInstanceId, setActivityByInstanceId] =
    useState<Record<string, InstanceActivityDigest>>({});
  const [activityErrorsByInstanceId, setActivityErrorsByInstanceId] = useState<Record<string, string>>({});
  const [activityLoadingByInstanceId, setActivityLoadingByInstanceId] = useState<Record<string, boolean>>({});
  const [restoreLoadingByInstanceId, setRestoreLoadingByInstanceId] = useState<Record<string, boolean>>({});
  const [restoreErrorByInstanceId, setRestoreErrorByInstanceId] = useState<Record<string, string>>({});
  const [commandCenterV2Enabled, setCommandCenterV2Enabled] = useState(false);

  const fetchInstancesAndHosts = useCallback(async () => {
    if (!userId) return;
    try {
      setError(null);
      const [resInst, resHosts, resUsage] = await Promise.all([
        fetch("/api/instances?summary=true"),
        fetch("/api/hosts"),
        fetch("/api/billing/usage")
      ]);
      const [dataInst, dataHosts, dataUsage] = await Promise.all([
        resInst.json(),
        resHosts.json(),
        resUsage.json()
      ]);

      let discoveredInstances: Instance[] = [];
      if (dataInst.success) {
        setInstances(dataInst.data);
        writeStoredJsonIfChanged(localStorage, `dashboard_instances_${userId}`, dataInst.data);
        discoveredInstances = dataInst.data;
      }
      else setError(dataInst.error);

      if (dataHosts.success) {
         setHosts(dataHosts.data);
         writeStoredJsonIfChanged(localStorage, `dashboard_hosts_${userId}`, dataHosts.data);
      }

      if (dataUsage.success && dataUsage.data.subscribed) {
        setUsageData(dataUsage.data);
        writeStoredJsonIfChanged(localStorage, `dashboard_usage_${userId}`, dataUsage.data);
      }

      // If exactly 1 instance AND it's currently running, aggressively load
      // its profiles to make the dashboard profile-centric. We deliberately
      // skip the fetch on paused/stopped/provisioning/redeploying/deleted
      // rows — the route returns 400 "Instance is not currently running"
      // for those and the poll loop would otherwise hit the API every
      // ~10s for the entire lifetime of the open tab (observed: 130+
      // warn/hour per paused instance on the production error dashboard).
      // Cached profiles from the previous running state remain visible.
      const onlyInstance =
        discoveredInstances.length === 1 ? discoveredInstances[0] : null;
      if (onlyInstance && onlyInstance.status === "running") {
         if (!fetchedProfilesRef.current) {
            setLoadingProfiles(true);
         }
         try {
           const pRes = await fetch(`/api/instances/${onlyInstance.id}/profiles`);
           const pData = await pRes.json();
           if (pData.success) {
             setProfiles(pData.data || []);
             writeStoredJsonIfChanged(localStorage, `dashboard_profiles_${userId}`, pData.data || []);
             fetchedProfilesRef.current = true;
           }
         } finally {
           setLoadingProfiles(false);
         }
      }

    } catch (err) {
      clientLog.error("failed to load dashboard operations", err, {
        source: "dashboard.operations",
        route: "/dashboard",
        userId,
        failureType: "dashboard_operations_load_failed",
      });
      setError(dashboardCopy.errors.failedToLoadOperations);
    } finally {
      setLoading(false);
    }
  }, [dashboardCopy.errors.failedToLoadOperations, userId]);

  const startColdStorageRestore = useCallback(async (instance: Instance) => {
    const instanceId = instance.id;
    let responseStatus: number | null = null;
    let responsePayload: Record<string, unknown> | null = null;

    setRestoreLoadingByInstanceId((previous) => ({ ...previous, [instanceId]: true }));
    setRestoreErrorByInstanceId((previous) => {
      const next = { ...previous };
      delete next[instanceId];
      return next;
    });

    try {
      const response = await fetch(`/api/instances/${instanceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      responseStatus = response.status;
      responsePayload = await response.json().catch(() => null);

      if (!response.ok || responsePayload?.success !== true) {
        const message =
          typeof responsePayload?.error === "string"
            ? responsePayload.error
            : "Unable to start cold-storage restore.";
        throw new Error(message);
      }

      clientLog.info("cold-storage restore requested from dashboard", {
        source: "dashboard.cold-storage-restore",
        route: "/dashboard",
        instanceId,
        responseStatus,
        lifecycleState: instance.lifecycle_state ?? null,
        pausedReason: instance.paused_reason ?? null,
      });

      setInstances((previous) =>
        previous.map((row) =>
          row.id === instanceId
            ? { ...row, status: "provisioning", lifecycle_state: "restoring" }
            : row
        )
      );
      await fetchInstancesAndHosts();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to start cold-storage restore.";

      setRestoreErrorByInstanceId((previous) => ({
        ...previous,
        [instanceId]: message,
      }));
      clientLog.error("cold-storage restore action failed", error, {
        source: "dashboard.cold-storage-restore",
        route: "/dashboard",
        instanceId,
        responseStatus,
        lifecycleState: instance.lifecycle_state ?? null,
        pausedReason: instance.paused_reason ?? null,
        responseError:
          typeof responsePayload?.error === "string"
            ? responsePayload.error
            : null,
        failureType:
          typeof responsePayload?.failureType === "string"
            ? responsePayload.failureType
            : null,
      });
    } finally {
      setRestoreLoadingByInstanceId((previous) => ({
        ...previous,
        [instanceId]: false,
      }));
    }
  }, [fetchInstancesAndHosts]);

  useEffect(() => {
    if (!isLoaded) return;

    if (!userId) {
      setCommandCenterV2Enabled(false);
      return;
    }

    let cancelled = false;
    const loadCommandCenterGate = async () => {
      let status: number | null = null;
      try {
        const response = await fetch("/api/features/command-center-v2", {
          cache: "no-store",
        });
        status = response.status;
        const payload = (await response.json()) as CommandCenterV2FlagResponse;
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "feature_flag_request_failed");
        }
        if (!cancelled) {
          setCommandCenterV2Enabled(Boolean(payload.data?.enabled));
        }
      } catch (error) {
        if (!cancelled) {
          setCommandCenterV2Enabled(false);
          clientLog.warn("failed to load Command Center v2 gate", {
            source: "dashboard.command-center-v2",
            route: "/dashboard",
            status,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    };

    void loadCommandCenterGate();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, userId]);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let isMounted = true;
    let consecutiveFailures = 0;
    setMounted(true);

    // Defensive cleanup: an earlier version fell back to a literal "anon"
    // cache key while Clerk was hydrating, which leaked the previous signed-in
    // user's agents to the next one on refresh. Purge those orphaned keys for
    // anyone still carrying them.
    if (typeof window !== "undefined") {
      try {
        ["dashboard_instances_anon", "dashboard_hosts_anon", "dashboard_usage_anon", "dashboard_profiles_anon"].forEach(
          (k) => localStorage.removeItem(k)
        );
      } catch {
        // localStorage may throw in privacy mode / over quota
      }
    }

    if (!isLoaded || !userId) {
      return () => { isMounted = false; };
    }

    const cachedInst = readStoredJson<Instance[]>(localStorage, `dashboard_instances_${userId}`);
    const cachedHosts = readStoredJson<Host[]>(localStorage, `dashboard_hosts_${userId}`);
    const cachedUsage = readStoredJson<UsageData>(localStorage, `dashboard_usage_${userId}`);
    const cachedProfiles = readStoredJson<AgentProfile[]>(localStorage, `dashboard_profiles_${userId}`);
    if (cachedInst) {
       setInstances(cachedInst);
       if (cachedHosts) setHosts(cachedHosts);
       if (cachedUsage) setUsageData(cachedUsage);
       if (cachedProfiles) setProfiles(cachedProfiles);
       setLoading(false);
    }

    const poll = async () => {
      if (!isMounted) return;
      try {
        await fetchInstancesAndHosts();
        consecutiveFailures = 0; // reset on success
      } catch {
        consecutiveFailures += 1;
      }

      if (isMounted) {
        // Exponential backoff: 10s, 20s, 40s... up to 120s max
        const backoffMs = Math.min(10000 * Math.pow(2, consecutiveFailures), 120000);
        timeoutId = setTimeout(poll, backoffMs);
      }
    };

    poll();

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [isLoaded, userId, fetchInstancesAndHosts]);

  const liveWebUIInstances = useMemo(
    () => instances.filter((instance) => instance.status === "running" && isWebfreeBackend(instance.backend)),
    [instances],
  );
  const liveWebUIInstanceIds = useMemo(
    () => liveWebUIInstances.map((instance) => instance.id).join("|"),
    [liveWebUIInstances],
  );

  useEffect(() => {
    if (!mounted || !userId) return;

    let cancelled = false;
    const refreshManagedVeniceSummary = async () => {
      if (cancelled) return;
      setManagedVeniceSummaryLoading(true);
      const result = await requestManagedVeniceSummary();
      if (cancelled) return;
      if (result.ok) {
        setManagedVeniceSummary(result.summary);
        setManagedVeniceSummaryError(null);
      } else {
        setManagedVeniceSummaryError(result.message);
      }
      setManagedVeniceSummaryLoading(false);
    };

    void refreshManagedVeniceSummary();
    const interval = window.setInterval(pollWhenVisible(refreshManagedVeniceSummary), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [mounted, userId]);

  useEffect(() => {
    if (!mounted || !userId || liveWebUIInstances.length === 0) {
      return;
    }

    let cancelled = false;
    const targetInstances = liveWebUIInstances;
    const refreshActivity = async () => {
      if (cancelled) return;
      const loadingPatch = Object.fromEntries(targetInstances.map((instance) => [instance.id, true]));
      setActivityLoadingByInstanceId((previous) => ({ ...previous, ...loadingPatch }));

      const results = await Promise.all(
        targetInstances.map(async (instance) => ({
          instanceId: instance.id,
          result: await requestInstanceActivityDigest(instance.id),
        })),
      );
      if (cancelled) return;

      setActivityByInstanceId((previous) => {
        const next = { ...previous };
        for (const { instanceId, result } of results) {
          if (result.ok) next[instanceId] = result.digest;
        }
        return next;
      });
      setActivityErrorsByInstanceId((previous) => {
        const next = { ...previous };
        for (const { instanceId, result } of results) {
          if (result.ok) delete next[instanceId];
          else next[instanceId] = result.message;
        }
        return next;
      });
      setActivityLoadingByInstanceId((previous) => {
        const next = { ...previous };
        for (const instance of targetInstances) {
          next[instance.id] = false;
        }
        return next;
      });
    };

    void refreshActivity();
    const interval = window.setInterval(pollWhenVisible(refreshActivity), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [mounted, userId, liveWebUIInstanceIds, liveWebUIInstances]);

  // Empty state: an account with no agents opens Launch, the one place to
  // start an agent or a computer. A new account turns its Free plan on
  // there; nothing redirects back here, so there is no loop.
  const showOnboarding =
    !loading &&
    mounted &&
    !error &&
    instances.length === 0 &&
    !showHivra &&
    !commandCenterV2Enabled;
  const flaggedInstances = instances.filter((instance) => Boolean(instance.updateAlert));
  const failureFlaggedInstances = instances.filter((instance) => Boolean(instance.failureAlert));
  const primaryInstance = mounted && instances.length === 1 ? instances[0] : null;

  useEffect(() => {
    if (!showOnboarding) return;
    router.replace(FIRST_LAUNCH_HREF);
  }, [showOnboarding, router]);

  if (showOnboarding) {
    return null;
  }

  // Don't flash the legacy V1 dashboard before the V2/Hivra flags resolve.
  // showHivra is set in a mount effect; on canary the unified surface always
  // wins, so render a neutral loader until we know which surface to show.
  if (!mounted) {
    return (
      <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 size={20} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} />
      </div>
    );
  }

  // The Hivra branch that used to sit here has moved to the workspace view,
  // which `/dashboard` renders instead when the workspace shell is enabled.
  // Hivra is canary-only (by hostname — see isHivraEnabled), so this component
  // is the whole product wherever it runs, and `showHivra` is now always false.
  // Left in place rather than ripped out: it also gates the HivraAgentsPanel
  // render and two layout ternaries below, and prod has no way to exercise
  // those paths. Removing them is a separate, testable change.

  if (commandCenterV2Enabled) {
    return (
      <CommandCenterV2Surface
        instances={instances}
        hosts={hosts}
        loading={loading}
        error={error}
        managedVeniceSummary={managedVeniceSummary}
        managedVeniceSummaryLoading={managedVeniceSummaryLoading}
        managedVeniceSummaryError={managedVeniceSummaryError}
        activityByInstanceId={activityByInstanceId}
        activityErrorsByInstanceId={activityErrorsByInstanceId}
        activityLoadingByInstanceId={activityLoadingByInstanceId}
        failureFlaggedInstances={failureFlaggedInstances}
        updateFlaggedInstances={flaggedInstances}
        restoreLoadingByInstanceId={restoreLoadingByInstanceId}
        restoreErrorByInstanceId={restoreErrorByInstanceId}
        onOpenAgent={(instanceId) => router.push(`/dashboard/instances/${instanceId}`)}
        onOpenChat={(instanceId) => router.push(`/dashboard/instances/${instanceId}?surface=chat`)}
        onOpenConsole={(instanceId) => router.push(`/dashboard/instances/${instanceId}/console`)}
        onStartColdRestore={startColdStorageRestore}
        onTopUpCredits={() => router.push("/dashboard/billing?managedVenice=deposit&wallet=hermesos")}
        onManageCredits={() => router.push("/dashboard/billing#managed-venice")}
        onDeployAgent={() => router.push(FIRST_LAUNCH_HREF)}
        showHivra={false}
      />
    );
  }

  return (
      <div style={{ maxWidth: 960, margin: "1rem auto 5rem", padding: "clamp(1rem, 5vw, 3rem)", paddingTop: "calc(var(--dashboard-page-safe-top, env(safe-area-inset-top, 0px)) + clamp(1rem, 5vw, 3rem))", paddingBottom: "5rem", position: "relative", zIndex: 1 }}>
      <style>{HERMES_DASHBOARD_TOUCH_CSS}</style>
      {/* Header */}
      <motion.header initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 24, marginBottom: "clamp(2rem, 8vw, 4rem)" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ink-black)", display: "inline-block", flexShrink: 0 }} />
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.3em", opacity: 0.6, lineHeight: 1.5 }}>{dashboardCopy.phase}</span>
          </div>
          <h2 className="serif" style={{ fontSize: "clamp(2.5rem, 8vw, 3.5rem)", fontWeight: 300, lineHeight: 1.1 }}>{dashboardCopy.titlePrefix}{dashboardCopy.titleSeparator}<em>{dashboardCopy.titleEmphasis}</em>{dashboardCopy.titleSuffix}</h2>
        </div>
      </motion.header>

      <FailureSummaryBanner instances={failureFlaggedInstances} />

      {/* Day-one activation checklist (legacy surface: Hermes lane only). */}
      <OnboardingChecklist instances={instances} includeHivra={false} />

      {flaggedInstances.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          style={{
            display: "grid",
            gap: 12,
            padding: "18px 20px",
            marginBottom: "2rem",
            border: "1px solid rgba(180, 83, 9, 0.28)",
            background: "rgba(245, 158, 11, 0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <AlertTriangle size={16} style={{ color: "#92400e" }} />
            <span
              className="mono"
              style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", color: "#92400e", fontWeight: 700 }}
            >
              {dashboardCopy.alerts.updateTitle}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: "var(--ink-black)" }}>
            {dashboardCopy.alerts.updateSummaryPrefix} {flaggedInstances.length} {flaggedInstances.length === 1 ? dashboardCopy.alerts.updateSummarySingular : dashboardCopy.alerts.updateSummaryPlural} {dashboardCopy.alerts.updateSummarySuffix}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {flaggedInstances.map((instance) => (
              <button
                key={instance.id}
                type="button"
                onClick={() => router.push(`/dashboard/instances/${instance.id}`)}
                style={{
                  border: "1px solid rgba(180, 83, 9, 0.28)",
                  background: "rgba(255,255,255,0.6)",
                  color: "#92400e",
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {instance.name}
              </button>
            ))}
          </div>
        </motion.div>
      ) : null}

      {mounted && !loading && !error && instances.length > 0 ? (
        <section style={{ display: "grid", gap: 16, marginBottom: "2rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", opacity: 0.58 }}>
                Operations Cockpit
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 16 }}>
            {primaryInstance ? (
              <PrimaryAgentPanel
                instance={primaryInstance}
                digest={activityByInstanceId[primaryInstance.id] ?? null}
                activityLoading={Boolean(activityLoadingByInstanceId[primaryInstance.id])}
                activityError={activityErrorsByInstanceId[primaryInstance.id] ?? null}
                restoreLoading={Boolean(restoreLoadingByInstanceId[primaryInstance.id])}
                restoreError={restoreErrorByInstanceId[primaryInstance.id]}
                onOpenChat={() => router.push(`/dashboard/instances/${primaryInstance.id}?surface=chat`)}
                onOpenConsole={() => router.push(`/dashboard/instances/${primaryInstance.id}/console`)}
                onStartColdRestore={() => startColdStorageRestore(primaryInstance)}
              />
            ) : (
              <FleetOverview
                instances={instances}
                activityByInstanceId={activityByInstanceId}
              />
            )}

            <ManagedVeniceCreditsPocket
              summary={managedVeniceSummary}
              loading={managedVeniceSummaryLoading}
              error={managedVeniceSummaryError}
              onTopUp={() => router.push("/dashboard/billing?managedVenice=deposit&wallet=hermesos")}
              onManage={() => router.push("/dashboard/billing")}
            />
          </div>
        </section>
      ) : null}

      {/* Agents Grid */}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: "2rem" }}>
        <h3 className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.6, margin: 0, alignSelf: "center" }}>
          {mounted && instances.length === 1 ? dashboardCopy.sections.activeAgents : dashboardCopy.sections.activeCoreInstances}
        </h3>
        
        {mounted && instances.length === 1 && (
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => router.push(`/dashboard/instances/${instances[0].id}/console`)}
              className="hermes-touch-btn"
              style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "1px solid var(--etched-border)", padding: "6px 12px", cursor: "pointer", fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", color: "var(--ink-black)", ...TOUCH_ACTION_TEXT }}
            >
              <Settings size={12} /> {dashboardCopy.actions.coreConsole}
            </button>
          </div>
        )}
      </div>

      {mounted && instances.length === 1 && (
         <TelemetryGrid
           instanceId={instances[0].id}
           provider={instances[0].provider}
           model={instances[0].config?.model}
         />
      )}

      {/* Advanced Mode Toggle Logic */}
      {mounted && instances.length > 1 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "4rem", marginBottom: "4rem" }}>
          {hosts.map(host => {
            const hostInsts = instances.filter(i => i.host_id === host.id);
            const cpuPct = (host.used_cpu / host.total_cpu) * 100;
            const ramPct = (host.used_ram / host.total_ram) * 100;
            return (
              <div key={host.id} style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
                <HostCard
                  host={host}
                  cpuPct={cpuPct}
                  ramPct={ramPct}
                />
                
                {hostInsts.length > 0 && (
                  <div className="hermes-host-indent" style={{ borderLeft: "2px solid var(--etched-border)", marginLeft: "1rem", paddingLeft: "1.5rem" }}>
                    <motion.div initial="hidden" animate="visible" variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.08 } } }} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))", gap: "1.5rem" }}>
                      {hostInsts.map((inst) => (
                        <InstanceCard
                          key={inst.id}
                          instance={inst}
                          restoreLoading={Boolean(restoreLoadingByInstanceId[inst.id])}
                          restoreError={restoreErrorByInstanceId[inst.id]}
                          onStartColdRestore={startColdStorageRestore}
                        />
                      ))}
                    </motion.div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <motion.div initial="hidden" animate="visible" variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: "2rem", marginBottom: "4rem" }}>
          {loading ? (
          <div style={{ gridColumn: "1 / -1", height: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Loader2 size={20} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
          </div>
        ) : error ? (
          <div style={{ gridColumn: "1 / -1", padding: "1.5rem", display: "flex", alignItems: "center", gap: 12, border: "1px solid #ef4444", background: "transparent" }}>
            <AlertTriangle size={16} style={{ color: "#ef4444", flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: "var(--ink-black)", fontWeight: 500 }}>{error}</span>
          </div>
        ) : instances.length === 0 ? null : instances.length === 1 ? (
          loadingProfiles ? (
             <div style={{ gridColumn: "1 / -1", height: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span className="mono" style={{ opacity: 0.5, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.2em' }}>{dashboardCopy.instance.fetchingProfiles}</span>
             </div>
          ) : profiles && profiles.length > 0 ? (
             profiles.map((p, idx) => <ProfileCard key={p.name} profile={p} instance={instances[0]} isPrimary={idx === 0} />)
          ) : (
             <InstanceCard
               key={instances[0].id}
               instance={instances[0]}
               restoreLoading={Boolean(restoreLoadingByInstanceId[instances[0].id])}
               restoreError={restoreErrorByInstanceId[instances[0].id]}
               onStartColdRestore={startColdStorageRestore}
             />
          )
        ) : null}
      </motion.div>
      )}

      {/* Hosts Grid - shown only in normal mode */}
      {hosts.length > 0 && mounted && instances.length <= 1 && (
        <>
          <motion.h3 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.6, marginBottom: "2rem" }}>{dashboardCopy.sections.infrastructureNodes}</motion.h3>
          <motion.div initial="hidden" animate="visible" variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.2 } } }} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: "2rem" }}>
            {hosts.map(host => {
              const cpuPct = (host.used_cpu / host.total_cpu) * 100;
              const ramPct = (host.used_ram / host.total_ram) * 100;
              return (
                <HostCard
                  key={host.id}
                  host={host}
                  cpuPct={cpuPct}
                  ramPct={ramPct}
                />
              );
            })}
          </motion.div>
        </>
      )}

      {allocationHost && (
        <NodeAllocationModal
          host={allocationHost}
          hostInstances={instances.filter(i => i.host_id === allocationHost.id)}
          usageData={usageData}
          onClose={() => setAllocationHost(null)}
          onSuccess={() => {
            setAllocationHost(null);
            fetchInstancesAndHosts();
          }}
          onDeleted={() => {
            fetchInstancesAndHosts();
          }}
        />
      )}
    </div>
  );
}
