"use client";

// HivraManage — the settings page for one computer or agent (the Manage tab).
// One ManageLayout shell with sections: Overview (facts and power), Agents,
// Model & tools, Resources, Recovery, Private network, Updates and Advanced
// (details, history, export and the danger zone). Which sections and controls
// appear, and why others don't, comes from the server's capability map
// (agent.manage, lib/hivra/manage-capabilities.ts), never from guesses here.
// Sections stay mounted while hidden, so drafts survive switching.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Power, RefreshCw, Trash2, Check, Copy, ExternalLink, Loader2,
  AlertTriangle, Cpu, MemoryStick, Globe, Server, ShieldCheck, KeyRound, Wrench, LogIn,
} from "lucide-react";
import { CookieImportModal } from "@/components/instances/CookieImportModal";
import { ToolInstallPicker } from "./ToolInstallPicker";
import { AgentModelSettings } from "./AgentModelSettings";
import { ProviderResizePanel } from "./ProviderResizePanel";
import { HivraPrivateAccessPanel } from "./HivraPrivateAccessPanel";
import { GvisorComputerManage } from "./GvisorComputerManage";
import { ComputerAgentSlot, ComputerContractPanel } from "./ComputerContractPanel";
import { ManageLayout, ManageNotice, ManagePanel, type ManageFeedback } from "./ManageLayout";
import { useManageSection } from "./useManageSection";
import { ManageHeader } from "./manage/ManageHeader";
import { ManageDangerZone } from "./manage/ManageDangerZone";
import { CopyButton, ManageDetails, ManageFixedSize, ManageHistory, ManageNotAvailable } from "./manage/ManageAdvancedParts";
import { AgentSoftwareSlot, ComputerAgentsSlot, ManageHeaderChipsSlot } from "./manage/ManageExtensionSlots";
import {
  manageButtonDark as btnDark, manageButtonGhost as btnGhost, manageCard as card, manageError as errorStyle,
  manageLabel as label, manageMuted, manageValue as valStyle,
} from "./manage/manage-styles";

import {
  stopAgent, startAgent, restartAgent, updateAgentRuntime, resizeAgent, renameAgent, deleteAgent, browserToggle,
  listBoxChatRuns, getBoxModel, setBoxModel, getBoxRestrict, setBoxRestrict, listBoxMcp, addBoxMcp, removeBoxMcp,
  listAgentSnapshots, snapshotAgent, restoreAgentSnapshot, AgentActionError,
  type HivraAgent, type HivraAgentSnapshot, type PlanInfo, type BoxRestrict, type McpServer,
} from "@/lib/hivra/agent-api";
import { resizeFloor, hostingDisclaimer, MAX_CPU, MAX_RAM, type AgentDef } from "@/lib/hivra/agent-catalog";
import { catalogToolsUnavailableReason } from "@/lib/hivra/catalog-tool-availability";
import { UpgradePaywallModal } from "@/components/billing/UpgradePaywallModal";
import { PoolMeter } from "./PoolMeter";
import { resizeBudget } from "@/lib/hivra/resize-budget";
import { agentActivityPresentation } from "@/lib/hivra/agent-activity";
import { providerPowerMessage } from "@/lib/hivra/provider-power-contract";
import { getComputerTemplate, type ComputerTemplateDefinition } from "@/lib/hivra/computer-catalog";
import {
  COMPUTER_PLACEMENT_LABEL, agentComputerPairLabel, computerPlacementFor,
} from "@/lib/agent-computers/agent-surfaces";
import {
  capAvailable, capReason, capShown,
  type ManageCap, type ManageSectionId,
} from "@/lib/hivra/manage-sections";
import type { ChatReadiness } from "@/lib/hivra/chat-readiness";

// The server's resource-gate denial for browser-on-free (403 from launch/resize)
// and the client-side pre-check below both funnel into the same paywall modal.
const PAID_PLAN_DENIAL_RE = /requires a paid plan/i;

const CPU_OPTS = [0.5, 1, 2, 4, 6, MAX_CPU];
const RAM_OPTS = [1, 2, 4, 8, 16, 20, MAX_RAM];

function resourceOptions(base: readonly number[], ...saved: Array<number | null | undefined>): number[] {
  return Array.from(new Set([...base, ...saved.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)]))
    .sort((a, b) => a - b);
}

// Curated model choices per CLI. "Default" = clear the override (the CLI's own
// default / whatever the user's plan resolves). The claude values are CLI
// ALIASES — the CLI resolves them to the newest build, so this list doesn't go
// stale when Anthropic ships new versions. Codex ids are the ChatGPT-account
// allowlist; both CLIs also accept a custom id typed in the free-text field.
const MODEL_OPTS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "", label: "Default" },
    { value: "fable", label: "Fable" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [
    { value: "", label: "Default" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.1-codex-max", label: "Codex Max" },
    { value: "gpt-5.1-codex", label: "Codex" },
    { value: "gpt-5-codex", label: "Codex (5)" },
  ],
};

const LIFECYCLE_PROGRESS: Record<string, { title: string; detail: string; section: ManageSectionId }> = {
  start: {
    title: "Starting the computer…",
    detail: "Hivra is powering it on and waiting for the desktop connection. This normally takes under a minute.",
    section: "overview",
  },
  stop: {
    title: "Stopping the computer…",
    detail: "Hivra is shutting it down cleanly and confirming that it is off.",
    section: "overview",
  },
  restart: {
    title: "Restarting the computer…",
    detail: "The desktop will disconnect briefly while Hivra confirms the reboot.",
    section: "overview",
  },
  "runtime-update": {
    title: "Updating the connection service…",
    detail: "Hivra is updating it in place. The computer keeps running, and this page reconnects to it when the update finishes.",
    section: "updates",
  },
};

// Stop, Restart, Resize and Restore each power the computer off, which ends the
// chat replies a Claude Code / Codex computer is still writing, so Manage asks
// the computer first. A computer that does not answer within this window (or
// predates the run API) is not asked about.
const CHAT_RUNS_CHECK_MS = 4_000;
type RunEndingAction = "stop" | "restart" | "resize" | "restore";
const RUN_ENDING: Record<RunEndingAction, { effect: string; proceed: string }> = {
  stop: { effect: "Stopping the computer ends", proceed: "Stop anyway" },
  restart: { effect: "Restarting the computer ends", proceed: "Restart anyway" },
  resize: { effect: "Resizing restarts the computer, which ends", proceed: "Resize anyway" },
  restore: { effect: "Restoring stops the computer, which ends", proceed: "Restore anyway" },
};

function repliesInProgress(count: number): string {
  return count === 1
    ? "1 reply is still being written and will stop."
    : `${count} replies are still being written and will stop.`;
}

function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
      " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

function computerHostingDisclaimer(template: ComputerTemplateDefinition): string {
  return `${template.summary} It runs as an isolated VM with Hivra's authenticated access and lifecycle surfaces. Credentials may be stored on the computer. Hivra administrators retain infrastructure access on Hivra-managed hosts.`;
}

// Errors render beneath the control that failed, inside its section; when that
// section isn't open, a banner above the sections says so and opens it.
type ErrorSlot = "header" | "power" | "updates" | "restore" | "browser" | "model" | "permissions" | "tools" | "resources" | "danger";
const ERROR_SLOT: Record<string, ErrorSlot> = {
  rename: "header", start: "power", stop: "power", restart: "power", "runtime-update": "updates",
  snapshot: "restore", restore: "restore", browser: "browser", model: "model", restrict: "permissions",
  mcp: "tools", resize: "resources", destroy: "danger",
};
const SLOT_SECTION: Record<ErrorSlot, ManageSectionId | null> = {
  header: null, power: "overview", updates: "updates", restore: "recovery", browser: "model", model: "model",
  permissions: "model", tools: "model", resources: "resources", danger: "advanced",
};
function errorSlot(key: string): ErrorSlot | null {
  if (key.startsWith("mcp-")) return "tools";
  return ERROR_SLOT[key] ?? null;
}

const CHAT_READINESS_LINE: Record<ChatReadiness, string> = {
  native_connected: "Signed in",
  provider_configured: "Model connection set up in Model & tools",
  sign_in_required: "Not signed in yet: open Chat to sign in",
  upgrade_required: "Needs a connection service update (see Updates)",
  unavailable: "Couldn't check sign-in right now",
};

function SectionError({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [message]);
  return <div ref={ref} role="alert" style={errorStyle}>{message}</div>;
}

// Touch-visible permission hints and the stacked MCP row.
const MANAGE_CSS = `
.hm-choices { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hm-choice { display: contents; }
.hm-choice-hint { display: none; }
.hm-mcp-add { display: grid; gap: 8px; grid-template-columns: minmax(0, 110px) minmax(0, 1fr) auto; }
.hm-resource-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@container manage (min-width: 760px) {
  .hm-resource-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; }
}
@media (max-width: 767px), (pointer: coarse) {
  .hm-choices { display: grid; gap: 10px; }
  .hm-choice { display: grid; gap: 4px; justify-items: start; }
  .hm-choice-hint { display: block; font-size: 11.5px; line-height: 1.45; color: var(--text-muted); }
}
@media (max-width: 560px) {
  .hm-mcp-add { grid-template-columns: minmax(0, 1fr); }
  .hm-mcp-add > button { justify-self: start; }
}
`;

function Row({ icon, k, children }: { icon: React.ReactNode; k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 22, flexWrap: "wrap" }}>
      <span style={{ color: "var(--text-muted)", display: "inline-flex", width: 15 }}>{icon}</span>
      <span className="mono" style={{ ...label, width: 104 }}>{k}</span>
      <span style={{ flex: "1 1 180px", minWidth: 0 }}>{children}</span>
    </div>
  );
}

function CapReasonLine({ cap }: { cap: ManageCap | null | undefined }) {
  const reason = capReason(cap);
  return reason ? <div style={{ ...manageMuted, fontSize: 11.5 }}>{reason}</div> : null;
}

type HivraManageProps = {
  agent: HivraAgent;
  def?: AgentDef;
  onChanged: () => void;
  onDestroyed: () => void;
  /**
   * The computer's connection service restarted (a completed or unverified
   * in-place update). Its gateway keeps surface sign-ins only in memory, so the
   * page signs its embedded surfaces in again.
   */
  onConnectionServiceRestarted?: () => void;
  /** Live browser-automation state (from the box). null = unknown/loading. */
  browserOn?: boolean | null;
  onBrowserChange?: (enabled: boolean) => void;
  /** The user's plan (pool budget + per-agent caps). null = loading/unsubscribed. */
  plan?: PlanInfo | null;
  /** The agent's sign-in state, as the page already knows it. null = unknown. */
  chatReadiness?: ChatReadiness | null;
};

/** Keyed by the computer: another computer's drafts, secrets and confirmations never carry over. */
export function HivraManage(props: HivraManageProps) {
  if (props.agent.computer_substrate === "gvisor") {
    return <GvisorComputerManage key={props.agent.id} agent={props.agent} onChanged={props.onChanged} onDestroyed={props.onDestroyed} />;
  }
  return <HivraManageContent key={props.agent.id} {...props} />;
}

function HivraManageContent({
  agent, def, onChanged, onDestroyed, browserOn, onBrowserChange, plan, onConnectionServiceRestarted, chatReadiness = null,
}: HivraManageProps) {
  const manage = agent.manage;
  const [acting, setActing] = useState<string | null>(null);
  const [err, setErr] = useState<{ slot: ErrorSlot | null; message: string } | null>(null);
  // Locked-feature paywall (browser automation on Free). null = closed.
  const [paywallFeature, setPaywallFeature] = useState<"browser" | null>(null);
  const isFreePlan = agent.deployment_mode !== "self-managed" && Boolean(plan && (!plan.subscribed || plan.key === "free"));
  const managedPlanUnknown = agent.deployment_mode !== "self-managed" && !plan;

  const setModelSettingsBusy = useCallback((active: boolean) => setActing(active ? "llm" : null), []);
  // What the model, private network and Hetzner resize panels report, shown as
  // a banner while their section is closed.
  const [sectionFeedback, setSectionFeedback] = useState<Partial<Record<ManageSectionId, ManageFeedback>>>({});
  const reportModelFeedback = useCallback((feedback: ManageFeedback) => setSectionFeedback((current) => ({ ...current, model: feedback })), []);
  const reportNetworkFeedback = useCallback((feedback: ManageFeedback) => setSectionFeedback((current) => ({ ...current, network: feedback })), []);
  const reportResourcesFeedback = useCallback((feedback: ManageFeedback) => setSectionFeedback((current) => ({ ...current, resources: feedback })), []);

  // browser automation — local mirror of the box state (drives the resize floor)
  const [bOn, setBOn] = useState<boolean>(browserOn ?? Boolean(def?.browser));
  // Catalog support is not evidence that this computer's browser is running.
  // Keep the conservative resize floor, but do not present it as observed state.
  const browserStateKnown = typeof browserOn === "boolean";
  // Cookie import ("Log in with your accounts") — posts straight to the box.
  const [cookieOpen, setCookieOpen] = useState<boolean>(false);
  useEffect(() => { if (typeof browserOn === "boolean") setBOn(browserOn); }, [browserOn]);

  // model override — chat-CLI agents only. null = box default / not loaded yet.
  // modelSupported flips false when the box predates the /api/model endpoint
  // (old server.js) so we hide the section instead of showing a broken control.
  const isChatCli = def?.cliKind === "claude" || def?.cliKind === "codex";
  const [model, setModel] = useState<string | null>(null);
  const [modelSupported, setModelSupported] = useState(true);
  const [customModel, setCustomModel] = useState("");
  useEffect(() => {
    if (!isChatCli || !agent.chat_url) return;
    let alive = true;
    void getBoxModel(agent.chat_url, agent.api_token).then((r) => {
      if (!alive) return;
      if (r.error) { setModelSupported(false); return; }
      setModelSupported(true);
      setModel(r.model);
    });
    return () => { alive = false; };
  }, [isChatCli, agent.chat_url, agent.api_token]);

  // permission preset — same supported-detection pattern as the model section.
  const [restrict, setRestrict] = useState<BoxRestrict>("");
  const [restrictSupported, setRestrictSupported] = useState(true);
  useEffect(() => {
    if (!isChatCli || !agent.chat_url) return;
    let alive = true;
    void getBoxRestrict(agent.chat_url, agent.api_token).then((r) => {
      if (!alive) return;
      if (r.error) { setRestrictSupported(false); return; }
      setRestrictSupported(true);
      setRestrict(r.restrict);
    });
    return () => { alive = false; };
  }, [isChatCli, agent.chat_url, agent.api_token]);

  // MCP servers — list + add form state. Tools (curated bundles) install MCP
  // servers too, so the picker refreshes this same list on change.
  const [mcp, setMcp] = useState<McpServer[] | null>(null);
  const [mcpSupported, setMcpSupported] = useState(true);
  const [mcpName, setMcpName] = useState("");
  const [mcpCmd, setMcpCmd] = useState("");
  // Catalog installs need a Proxmox host path; elsewhere say so instead of
  // offering an install that can only fail. Advanced MCP talks to the box's
  // own API, so it stays offered whenever the box answers.
  const catalogToolsBlocked = catalogToolsUnavailableReason(agent.computer_substrate);
  const mcpCmdRef = useRef<HTMLInputElement>(null);
  const [mcpRemoveConfirm, setMcpRemoveConfirm] = useState<string | null>(null);
  // Deep link from the dashboard panel: ?tab=manage&tools=1 opens the picker
  // straight away, so "Tools" in the agent list is one click to the modal.
  const [toolsOpen, setToolsOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).get("tools") === "1"; } catch { return false; }
  });
  const [addAgentRequested] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).get("addAgent") === "1"; } catch { return false; }
  });
  const refreshMcp = useCallback(async () => {
    if (!isChatCli || !agent.chat_url) return;
    const r = await listBoxMcp(agent.chat_url, agent.api_token);
    if (r.error) { setMcpSupported(false); return; }
    setMcpSupported(true);
    setMcp(r.servers);
  }, [isChatCli, agent.chat_url, agent.api_token]);
  useEffect(() => {
    let alive = true;
    void (async () => { if (alive) await refreshMcp(); })();
    return () => { alive = false; };
  }, [refreshMcp]);

  // resize — floor depends on whether browser automation is on (+1 CPU / +2 GB)
  const floor = useMemo(() => resizeFloor(agent.type, bOn), [agent.type, bOn]);
  const [rcpu, setRcpu] = useState(Math.max(agent.cpu, floor.cpu));
  const [rram, setRram] = useState(Math.max(agent.ram, floor.ram));
  const [maximumCpu, setMaximumCpu] = useState(Math.max(agent.cpu_max ?? agent.cpu, agent.cpu, floor.cpu));
  const [maximumRam, setMaximumRam] = useState(Math.max(agent.ram_max ?? agent.ram, agent.ram, floor.ram));
  const cpuOptions = resourceOptions(CPU_OPTS, floor.cpu, agent.cpu, agent.cpu_max, rcpu, maximumCpu);
  const ramOptions = resourceOptions(RAM_OPTS, floor.ram, agent.ram, agent.ram_max, rram, maximumRam);
  useEffect(() => {
    const nextCpu = Math.max(agent.cpu, floor.cpu);
    const nextRam = Math.max(agent.ram, floor.ram);
    setRcpu(nextCpu);
    setRram(nextRam);
    setMaximumCpu(Math.max(agent.cpu_max ?? agent.cpu, nextCpu));
    setMaximumRam(Math.max(agent.ram_max ?? agent.ram, nextRam));
  }, [agent.cpu, agent.ram, agent.cpu_max, agent.ram_max, floor.cpu, floor.ram]);

  const budget = resizeBudget(agent, plan);
  const hasPlan = budget.showPool;
  const usedOtherCpu = budget.otherCpu;
  const usedOtherRam = budget.otherRam;
  const poolCpu = plan?.poolCpu ?? 0;
  const poolRam = plan?.poolRam ?? 0;
  const capCpu = budget.cpu;
  const capRam = budget.ram;
  const poolFull = hasPlan && (capCpu < floor.cpu || capRam < floor.ram);

  // destroy
  const deletionController = useRef<AbortController | null>(null);
  const [deletionProgress, setDeletionProgress] = useState<string | null>(null);
  useEffect(() => () => { deletionController.current?.abort(); }, [agent.id]);

  // restore points
  const [snapshots, setSnapshots] = useState<HivraAgentSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [snapshotMaximum, setSnapshotMaximum] = useState(manage?.restorePoints?.maximum ?? 5);
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);
  // Stop/Restart/Resize/Restore on a chat computer: which action is asking the
  // computer about replies in progress, and the confirmation when some are.
  const [repliesCheck, setRepliesCheck] = useState<RunEndingAction | null>(null);
  const [repliesConfirm, setRepliesConfirm] = useState<{ action: RunEndingAction; running: number; snapshotId?: string } | null>(null);
  // A confirmation belongs to the computer state it was asked about.
  useEffect(() => { setRepliesConfirm(null); }, [agent.id, agent.status]);

  // Restore points are listed only where the server keeps them: an older
  // computer without ownership checks is told why instead (manage.restorePoints).
  const restorePointsListed = manage
    ? capShown(manage.restorePoints)
    : agent.computer_substrate === "proxmox-kvm";
  const refreshSnapshots = useCallback(async () => {
    if (!restorePointsListed) {
      setSnapshots([]);
      setSnapshotsError(null);
      return;
    }
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const result = await listAgentSnapshots(agent.id);
      setSnapshots(result.snapshots);
      setSnapshotMaximum(result.maximum);
    } catch (error) {
      setSnapshotsError(error instanceof Error ? error.message : "Could not load restore points");
    } finally {
      setSnapshotsLoading(false);
    }
  }, [agent.id, restorePointsListed]);

  useEffect(() => {
    setRestoreConfirmId(null);
    void refreshSnapshots();
  }, [refreshSnapshots]);

  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setActing(key); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) {
      const message = (e as Error).message;
      setErr({ slot: errorSlot(key), message });
      // A resource-gate "browser on Free" 403 deserves the upgrade path, not
      // just a raw error banner.
      if (PAID_PLAN_DENIAL_RE.test(message)) setPaywallFeature("browser");
    }
    finally { setActing(null); }
  }, [onChanged]);

  // Only a running Claude Code / Codex computer writes chat replies.
  const repliesMayRun = isChatCli && Boolean(agent.chat_url) && agent.status === "running";
  // How many replies that computer is still writing, asked before an action
  // that powers it off. Any failure to answer (older runtime without the run
  // API, unreachable, slow) counts as none, so the action proceeds as before.
  const countRunningReplies = useCallback(async (action: RunEndingAction): Promise<number> => {
    if (!agent.chat_url) return 0;
    setRepliesCheck(action);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_RUNS_CHECK_MS);
    try {
      const runs = await listBoxChatRuns(agent.chat_url, agent.api_token, controller.signal);
      return runs ? runs.filter((r) => r.state === "running").length : 0;
    } finally {
      clearTimeout(timer);
      setRepliesCheck(null);
    }
  }, [agent.chat_url, agent.api_token]);

  // The update restarts only the computer's gateway, which drops the embedded
  // surfaces' sign-ins, so the page signs them in again once it is back. An
  // unverified outcome (502) may also have restarted it, or rolled it back.
  const updateConnectionService = useCallback(async () => {
    try {
      await updateAgentRuntime(agent.id);
    } catch (error) {
      if (error instanceof AgentActionError && error.status === 502) onConnectionServiceRestarted?.();
      throw error;
    }
    onConnectionServiceRestarted?.();
  }, [agent.id, onConnectionServiceRestarted]);

  const [copied, setCopied] = useState(false);
  const copyEndpoint = useCallback(async () => {
    if (!agent.chat_url) return;
    try { await navigator.clipboard.writeText(agent.chat_url); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
  }, [agent.chat_url]);

  const toggleBrowser = useCallback(async (next: boolean) => {
    if (!agent.chat_url || acting) return;
    if (next && managedPlanUnknown) {
      setErr({ slot: "browser", message: "Check your Hivra Cloud plan before enabling browser automation." });
      return;
    }
    // Browser automation is a paid feature — on Free, enabling it opens the
    // upgrade paywall instead of a request that the resource gate would 403.
    if (next && isFreePlan) {
      setPaywallFeature("browser");
      return;
    }
    setActing("browser"); setErr(null);
    try {
      const r = await browserToggle(agent.chat_url, next, agent.api_token);
      if (!r.ok) throw new Error(r.error || "Couldn't toggle browser automation");
      setBOn(next);
      onBrowserChange?.(next);
    } catch (e) {
      const message = (e as Error).message;
      setErr({ slot: "browser", message });
      if (PAID_PLAN_DENIAL_RE.test(message)) setPaywallFeature("browser");
    }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting, isFreePlan, managedPlanUnknown, onBrowserChange]);

  const applyModel = useCallback(async (next: string) => {
    if (!agent.chat_url || acting) return;
    setActing("model"); setErr(null);
    try {
      const r = await setBoxModel(agent.chat_url, next || null, agent.api_token);
      if (!r.ok) throw new Error(r.error || "Couldn't change the model");
      setModel(next || null);
      setCustomModel("");
    } catch (e) { setErr({ slot: "model", message: (e as Error).message }); }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting]);

  const applyRestrict = useCallback(async (next: BoxRestrict) => {
    if (!agent.chat_url || acting) return;
    setActing("restrict"); setErr(null);
    try {
      const r = await setBoxRestrict(agent.chat_url, next, agent.api_token);
      if (!r.ok) throw new Error(r.error || "Couldn't change permissions");
      setRestrict(next);
    } catch (e) { setErr({ slot: "permissions", message: (e as Error).message }); }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting]);

  const addMcp = useCallback(async () => {
    if (!agent.chat_url || acting) return;
    const name = mcpName.trim();
    const parts = mcpCmd.trim().split(/\s+/).filter(Boolean);
    if (!name || parts.length === 0) return;
    setActing("mcp"); setErr(null);
    try {
      const r = await addBoxMcp(agent.chat_url, name, parts[0], parts.slice(1), agent.api_token);
      if (!r.ok) throw new Error(r.error || "Couldn't add the MCP server");
      setMcpName(""); setMcpCmd("");
      const list = await listBoxMcp(agent.chat_url, agent.api_token);
      if (!list.error) setMcp(list.servers);
    } catch (e) { setErr({ slot: "tools", message: (e as Error).message }); }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting, mcpName, mcpCmd]);

  const dropMcp = useCallback(async (name: string) => {
    if (!agent.chat_url || acting) return;
    setActing("mcp-" + name); setErr(null);
    try {
      const r = await removeBoxMcp(agent.chat_url, name, agent.api_token);
      if (!r.ok) throw new Error(r.error || "Couldn't remove the MCP server");
      setMcp((prev) => (prev || []).filter((s) => s.name !== name));
      setMcpRemoveConfirm(null);
    } catch (e) { setErr({ slot: "tools", message: (e as Error).message }); }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting]);

  const savedMaximumCpu = agent.cpu_max ?? agent.cpu;
  const savedMaximumRam = agent.ram_max ?? agent.ram;
  const dirty = rcpu !== agent.cpu || rram !== agent.ram
    || maximumCpu !== savedMaximumCpu || maximumRam !== savedMaximumRam;
  const busy = acting !== null || repliesCheck !== null;
  const lifecyclePending = agent.status === "provisioning";
  const providerComputer = agent.computer_substrate === "provider-vm";
  const computerTemplate = agent.computer_profile && agent.computer_profile !== "linux-terminal" ? getComputerTemplate(agent.computer_profile) : undefined;
  const preparedComputer = computerTemplate?.launchMode === "prepared-canary";
  const isComputerOnly = manage ? manage.kind === "computer" : agent.type === "linux-desktop" || Boolean(agent.computer_profile);

  // What the server says this computer supports. An older server that sends
  // no map gets the controls this page offered before sections existed.
  const legacyPower = (): { start: ManageCap; stop: ManageCap; restart: ManageCap | null } => {
    const wait: ManageCap = { state: "blocked", code: "operation_in_progress", reason: "Wait for the current operation to finish." };
    const stopped = agent.status === "stopped";
    return {
      start: lifecyclePending ? wait : stopped ? { state: "available" } : { state: "blocked", code: "already_on", reason: "This computer is already on." },
      stop: lifecyclePending ? wait : stopped ? { state: "blocked", code: "already_stopped", reason: "This computer is already stopped." } : { state: "available" },
      restart: lifecyclePending ? wait : stopped ? { state: "blocked", code: "stopped", reason: "Start this computer first." } : { state: "available" },
    };
  };
  const power = manage?.power ?? legacyPower();
  const resizeKind = manage?.resize.kind
    ?? (providerComputer ? "hetzner-server-type" : preparedComputer ? "fixed" : "proxmox-envelope");
  const connectionUpdate: ManageCap | null = manage
    ? manage.connectionServiceUpdate
    : !providerComputer && !preparedComputer && agent.type !== "deepseek-harness"
      ? agent.status === "running" ? { state: "available" } : { state: "blocked", code: "not_running", reason: "Start this computer to update it." }
      : null;
  const placementLabel = manage?.placement.label ?? COMPUTER_PLACEMENT_LABEL[computerPlacementFor(agent)];
  const sections: ManageSectionId[] = manage?.sections ?? ["overview", "resources", "advanced"];
  const { selected, select, openAndFocus } = useManageSection(sections, Boolean(manage));

  const maximumCapCpu = budget.selfManaged
    ? MAX_CPU
    : budget.fixedSize ? capCpu : plan?.maxCpuPerAgent ?? capCpu;
  const maximumCapRam = budget.selfManaged
    ? MAX_RAM
    : budget.fixedSize ? capRam : plan?.maxRamPerAgent ?? capRam;
  const resizeAllowed = resizeKind === "proxmox-envelope" && (manage ? capAvailable(manage.resize.cap) : !lifecyclePending);
  const canResize = resizeAllowed && budget.ready && dirty
    && rcpu >= floor.cpu && rram >= floor.ram && rcpu <= capCpu && rram <= capRam
    && maximumCpu >= rcpu && maximumRam >= rram
    && maximumCpu <= maximumCapCpu && maximumRam <= maximumCapRam;

  // Sends an action that powers the computer off, with the values current when
  // it is sent (a confirmed resize uses the size selected at that moment).
  const sendRunEnding = (action: RunEndingAction, snapshotId?: string) => {
    if (action === "stop") void run("stop", () => stopAgent(agent.id));
    else if (action === "restart") void run("restart", () => restartAgent(agent.id));
    else if (action === "resize") {
      if (canResize) void run("resize", () => resizeAgent(agent.id, rcpu, rram, maximumCpu, maximumRam));
    } else if (snapshotId) {
      void run("restore", async () => {
        await restoreAgentSnapshot(agent.id, snapshotId);
        setRestoreConfirmId(null);
        await refreshSnapshots();
      });
    }
  };
  // Asks about replies in progress first and confirms only when some are.
  // Computers that cannot have any send straight away, as before.
  const requestRunEnding = async (action: RunEndingAction, snapshotId?: string) => {
    setRepliesConfirm(null);
    if (!repliesMayRun) {
      sendRunEnding(action, snapshotId);
      return;
    }
    const running = await countRunningReplies(action);
    if (running > 0) {
      setRepliesConfirm({ action, running, snapshotId });
      return;
    }
    sendRunEnding(action, snapshotId);
  };
  const confirmRunEnding = () => {
    if (!repliesConfirm) return;
    const { action, snapshotId } = repliesConfirm;
    setRepliesConfirm(null);
    sendRunEnding(action, snapshotId);
  };

  const errorFor = (slot: ErrorSlot) => (err && err.slot === slot ? <SectionError message={err.message} /> : null);
  // The replies-in-progress confirmation, shown next to the control that asked.
  const repliesDialog = (actions: readonly RunEndingAction[], snapshotId?: string) => {
    if (!repliesConfirm || !actions.includes(repliesConfirm.action)) return null;
    if (repliesConfirm.action === "restore" && repliesConfirm.snapshotId !== snapshotId) return null;
    const { action, running } = repliesConfirm;
    const them = running === 1 ? "it" : "them";
    const id = `hm-replies-${action}`;
    return (
      <div role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} style={{ display: "grid", gap: 10, padding: "12px 14px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.025)" }}>
        <div id={`${id}-title`} style={{ fontSize: 12.5, color: "var(--ink-black)", fontWeight: 700 }}>{repliesInProgress(running)}</div>
        <div id={`${id}-detail`} style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {RUN_ENDING[action].effect} {them} now. To keep {them}, cancel and wait until the chat finishes.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={confirmRunEnding} style={{ ...btnDark, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {RUN_ENDING[action].proceed}
          </button>
          <button type="button" onClick={() => setRepliesConfirm(null)} style={{ ...btnGhost, cursor: "pointer" }}>Cancel</button>
        </div>
      </div>
    );
  };
  const progressFor = (section: ManageSectionId) => acting && LIFECYCLE_PROGRESS[acting]?.section === section ? (
    <div role="status" aria-live="polite" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.025)" }}>
      <Loader2 size={15} aria-hidden="true" style={{ animation: "spin 1s linear infinite", flexShrink: 0, marginTop: 2 }} />
      <div>
        <div style={{ fontSize: 12.5, color: "var(--ink-black)", fontWeight: 700 }}>{LIFECYCLE_PROGRESS[acting].title}</div>
        <div style={{ marginTop: 3, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{LIFECYCLE_PROGRESS[acting].detail}</div>
      </div>
    </div>
  ) : null;

  // Restore points: the server's answer first, then this computer's state.
  const restorePointsUsable = manage ? capAvailable(manage.restorePoints) : true;
  const createRestorePointDisabled = busy || lifecyclePending || !["running", "stopped"].includes(agent.status)
    || snapshots.length >= snapshotMaximum || !restorePointsUsable;

  const chatModelSection = isChatCli && Boolean(agent.chat_url) && modelSupported;
  const veniceModelSection = Boolean(def?.llm?.providers.includes("venice"));
  const permissionsSection = isChatCli && Boolean(agent.chat_url) && restrictSupported;
  const toolsSection = isChatCli && Boolean(agent.chat_url);

  // Feedback from a section that isn't open: a banner that opens it.
  const errorSection = err?.slot ? SLOT_SECTION[err.slot] : null;
  const progressSection = acting ? LIFECYCLE_PROGRESS[acting]?.section ?? null : null;
  const notices = (
    <>
      {err && !err.slot ? <div role="alert" style={errorStyle}>{err.message}</div> : null}
      {err && errorSection && errorSection !== selected && sections.includes(errorSection)
        ? <ManageNotice kind="alert" message={err.message} section={errorSection} onOpen={openAndFocus} /> : null}
      {acting && progressSection && progressSection !== selected && sections.includes(progressSection)
        ? <ManageNotice kind="status" message={LIFECYCLE_PROGRESS[acting].title} section={progressSection} onOpen={openAndFocus} /> : null}
      {(Object.entries(sectionFeedback) as Array<[ManageSectionId, ManageFeedback]>).map(([section, feedback]) =>
        feedback && section !== selected && sections.includes(section)
          ? <ManageNotice key={section} kind={feedback.kind} message={feedback.message} section={section} onOpen={openAndFocus} /> : null)}
    </>
  );

  const productName = computerTemplate?.name || def?.name || "the agent";
  const statusLabel = lifecyclePending ? agentActivityPresentation(agent, productName).label : agent.status;
  const subtitle = isComputerOnly
    ? `${computerTemplate?.name ?? def?.name ?? "Computer"} · ${placementLabel}`
    : `${def?.name ?? agent.type} · ${agentComputerPairLabel(agent)}`;
  const powerUnavailable = power.start.state === "unavailable" && power.stop.state === "unavailable";
  const signInLine = !isComputerOnly && isChatCli && chatReadiness ? CHAT_READINESS_LINE[chatReadiness] : null;
  const disclaimer = computerTemplate
    ? computerHostingDisclaimer(computerTemplate)
    : def ? hostingDisclaimer(def, agent.deployment_mode === "self-managed" ? "self-managed" : "hivra-managed") : null;

  return (
    <ManageLayout
      label={isComputerOnly ? "Computer settings" : "Agent settings"}
      sections={sections.map((id) => ({ id, unsaved: id === "resources" && resizeKind === "proxmox-envelope" && dirty }))}
      selected={selected}
      onSelect={select}
      notice={notices}
      header={
        <ManageHeader
          eyebrow={isComputerOnly ? "Computer settings" : "Agent settings"}
          name={agent.name}
          status={agent.status}
          statusLabel={statusLabel}
          subtitle={subtitle}
          renaming={acting === "rename"}
          disabled={busy}
          onRename={(name) => void run("rename", () => renameAgent(agent.id, name))}
          error={errorFor("header")}
          chips={<ManageHeaderChipsSlot agent={agent} onOpenUpdates={() => openAndFocus("updates")} />}
        />
      }
    >
      <style>{MANAGE_CSS}</style>
      {paywallFeature ? (
        <UpgradePaywallModal
          feature={paywallFeature}
          currentPlan={plan?.key ?? null}
          onClose={() => setPaywallFeature(null)}
        />
      ) : null}

      {/* OVERVIEW — what this is, its size and where it runs, and power. */}
      <ManagePanel id="overview" selected={selected}>
        <div style={{ display: "grid", gap: 20 }}>
          <div style={card}>
            <div style={{ display: "grid", gap: 9, gridTemplateColumns: "minmax(0, 1fr)" }}>
              <Row icon={<Server size={14} />} k={isComputerOnly ? "Computer" : "Agent"}><span style={valStyle}>{computerTemplate ? computerTemplate.name : `${def?.name || agent.type} · ${def?.vendor || "—"}`}</span></Row>
              <Row icon={<Cpu size={14} />} k="Size">
                <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={valStyle}>{agent.cpu} CPU · {agent.ram} GB reserved · up to {agent.cpu_max ?? agent.cpu} CPU · {agent.ram_max ?? agent.ram} GB</span>
                  {sections.includes("resources") ? <button type="button" onClick={() => openAndFocus("resources")} className="mono" style={{ ...label, border: 0, background: "transparent", color: "var(--ink-black)", textDecoration: "underline", minHeight: 40, padding: 0, cursor: "pointer" }}>See resources</button> : null}
                </span>
              </Row>
              <Row icon={<Globe size={14} />} k="Where it runs"><span style={valStyle}>{placementLabel}</span></Row>
              {signInLine ? <Row icon={<LogIn size={14} />} k="Sign-in"><span style={valStyle}>{signInLine}</span></Row> : null}
            </div>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            <div className="mono" style={label}>Power</div>
            <div style={card}>
              {powerUnavailable ? (
                <div style={manageMuted}>{capReason(power.start)}</div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {agent.status === "stopped" ? (
                    <button type="button" disabled={busy || !capAvailable(power.start)} title={capReason(power.start) ?? undefined} onClick={() => void run("start", () => startAgent(agent.id))} style={{ ...btnDark, cursor: busy || !capAvailable(power.start) ? "default" : "pointer", opacity: busy || !capAvailable(power.start) ? 0.6 : 1 }}>
                      {acting === "start" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Power size={14} />} Start
                    </button>
                  ) : (
                    <button type="button" disabled={busy || !capAvailable(power.stop)} title={capReason(power.stop) ?? undefined} onClick={() => void requestRunEnding("stop")} style={{ ...btnGhost, cursor: busy || !capAvailable(power.stop) ? "default" : "pointer", opacity: busy || !capAvailable(power.stop) ? 0.6 : 1 }}>
                      {acting === "stop" || repliesCheck === "stop" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Power size={14} />} Stop
                    </button>
                  )}
                  {power.restart ? <button type="button" disabled={busy || !capAvailable(power.restart)} onClick={() => void requestRunEnding("restart")} style={{ ...btnGhost, cursor: busy || !capAvailable(power.restart) ? "default" : "pointer", opacity: busy || !capAvailable(power.restart) ? 0.5 : 1 }} title={agent.status === "stopped" ? "The computer is stopped. Use Start" : "Reboot the computer"}>
                    {acting === "restart" || repliesCheck === "restart" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Restart
                  </button> : null}
                </div>
              )}
              {repliesDialog(["stop", "restart"])}
              {errorFor("power")}
              {!powerUnavailable && lifecyclePending ? <CapReasonLine cap={power.stop} /> : null}
              {/* Only explains buttons that are there. */}
              {powerUnavailable ? null : <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Stop shuts down the computer; Start brings it back. Restart reboots in place. Stopping does not cancel your plan or any provider billing.
              </div>}
              {progressFor("overview")}
              {providerComputer && providerPowerMessage(agent.power_stage) ? <p
                role={["verification_unavailable", "request_uncertain", "failed"].includes(String(agent.power_stage)) ? "alert" : "status"}
                style={{ margin: 0, padding: "12px 14px", border: "1px solid var(--etched-border)", fontSize: 12, lineHeight: 1.6 }}
              >{providerPowerMessage(agent.power_stage)}</p> : null}
            </div>
          </div>

          {/* The agent and its computer as one pair (ATT-11), and what the agent
              knows about it. A computer without an agent shows an honest Agent
              slot, unless the Agents section offers adding one. */}
          {isComputerOnly ? (
            manage?.attachAgents ? null : <ComputerAgentSlot />
          ) : (
            <ComputerContractPanel agent={agent} runtimeName={def?.name || "This agent"} />
          )}
        </div>
      </ManagePanel>

      {/* AGENTS — the agents working on this computer (the attach work fills it). */}
      {sections.includes("agents") ? (
        <ManagePanel id="agents" selected={selected}>
          <ComputerAgentsSlot agent={agent} autoOpenAdd={addAgentRequested} />
        </ManagePanel>
      ) : null}

      {/* MODEL & TOOLS — agents only. */}
      {sections.includes("model") ? (
        <ManagePanel id="model" selected={selected}>
          <div style={{ display: "grid", gap: 20 }}>
            {/* BROWSER AUTOMATION (browser-capable agents only) */}
            {def?.browser ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="mono" style={label}>Browser automation</div>
                <div style={card}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>{!browserStateKnown ? "Not verified yet" : bOn ? "On" : "Off"}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, marginTop: 3 }}>
                        {!browserStateKnown
                          ? "Browser controls become available after this computer reports its browser status. Agent support alone does not mean the browser is running."
                          : bOn
                          ? "The agent has a live, self-hosted Chrome — the Browser tab works and it can browse the web. Reserves +1 CPU / +2 GB."
                          : providerComputer
                          ? "Browser automation is off. This agent still uses its whole cloud computer; turning the browser off does not resize the server or reduce provider billing."
                          : "No browser. The computer runs leaner and can resize down to the 0.5 CPU / 1 GB floor. The Browser tab and web automation are off until you turn this back on."}
                      </div>
                    </div>
                    {browserStateKnown ? <button
                      type="button"
                      role="switch"
                      aria-checked={bOn}
                      disabled={busy || lifecyclePending || (!bOn && managedPlanUnknown)}
                      onClick={() => void toggleBrowser(!bOn)}
                      title={bOn ? "Disable browser automation" : "Enable browser automation"}
                      // Transparent 56x44 hit area around the unchanged 48x27 track.
                      style={{ minWidth: 56, minHeight: 44, border: 0, background: "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: busy ? "default" : "pointer", flexShrink: 0, padding: 0 }}
                    >
                      <span aria-hidden="true" style={{ width: 48, height: 27, borderRadius: 14, border: "1px solid var(--etched-border)", background: bOn ? "var(--gold-leaf)" : "rgba(255,255,255,0.05)", position: "relative", display: "inline-block", boxSizing: "border-box" }}>
                        {acting === "browser" ? (
                          <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "var(--ink-black)", position: "absolute", top: 6, left: bOn ? 24 : 6 }} />
                        ) : (
                          <span style={{ position: "absolute", top: 3, left: bOn ? 24 : 3, width: 19, height: 19, borderRadius: "50%", background: bOn ? "var(--ink-black)" : "var(--text-muted)", transition: "left .15s ease" }} />
                        )}
                      </span>
                    </button> : null}
                  </div>
                  {errorFor("browser")}
                  {managedPlanUnknown ? <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                    Check your Hivra Cloud plan before enabling browser automation. You can still turn an existing browser off.
                    <div style={{ marginTop: 10 }}><button type="button" style={btnGhost} onClick={onChanged}>Check plan</button></div>
                  </div> : null}
                </div>
                {browserStateKnown && bOn && agent.chat_url ? (
                  <div style={{ ...card, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                      <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Log in with your accounts</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, marginTop: 3 }}>
                        Import cookies from your own browser so the agent is signed in to your sites — no passwords shared, and far fewer datacenter bot-checks (Cloudflare, CAPTCHAs).
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCookieOpen(true)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 7, flexShrink: 0, padding: "9px 14px", minHeight: 40, border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--vellum-bg, #f5f0e8)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer" }}
                    >
                      <KeyRound size={14} /> Import cookies
                    </button>
                  </div>
                ) : null}
                {cookieOpen && agent.chat_url ? (
                  <CookieImportModal
                    endpoint={`${agent.chat_url.replace(/\/$/, "")}/api/cookies/import`}
                    authToken={agent.api_token}
                    onClose={() => setCookieOpen(false)}
                  />
                ) : null}
              </div>
            ) : null}

            {/* MODEL (chat-CLI agents with a new-enough box) */}
            {chatModelSection ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="mono" style={label}>Model</div>
                <div style={card}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                    Which model {def?.name || "the agent"} uses, within your own {def?.vendor || "provider"} plan. Applies from the next message — running turns aren&apos;t interrupted.
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {(MODEL_OPTS[def?.cliKind || "claude"] || []).map((o) => {
                      const active = (model || "") === o.value;
                      return (
                        <button
                          key={o.value || "default"}
                          type="button"
                          disabled={busy}
                          onClick={() => { if (!active) void applyModel(o.value); }}
                          style={{
                            border: active ? "1px solid var(--ink-black)" : "1px solid var(--etched-border)",
                            background: active ? "var(--ink-black)" : "transparent",
                            color: active ? "var(--bg-surface)" : "var(--text-secondary)",
                            fontSize: 12, padding: "6px 11px", minHeight: 40, cursor: busy ? "default" : "pointer",
                            fontFamily: "var(--font-mono), monospace",
                          }}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                    {acting === "model" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "var(--text-muted)" }} /> : null}
                  </div>
                  {errorFor("model")}
                  {model && !(MODEL_OPTS[def?.cliKind || "claude"] || []).some((o) => o.value === model) ? (
                    <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>Current: {model}</div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={customModel}
                      onChange={(e) => setCustomModel(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && customModel.trim()) void applyModel(customModel.trim()); }}
                      placeholder={def?.cliKind === "codex" ? "Custom model id (e.g. gpt-5.1-codex)" : "Custom model id (e.g. claude-opus-4-8[1m])"}
                      aria-label="Custom model id"
                      autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done"
                      style={{ flex: 1, padding: "8px 10px", minHeight: 40, border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 12, fontFamily: "var(--font-mono), monospace", outline: "none", minWidth: 0 }}
                    />
                    <button
                      type="button"
                      disabled={busy || !customModel.trim()}
                      onClick={() => void applyModel(customModel.trim())}
                      style={{ ...btnGhost, opacity: busy || !customModel.trim() ? 0.5 : 1, cursor: busy || !customModel.trim() ? "default" : "pointer" }}
                    >
                      Set
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                    A model your account can&apos;t access fails on the next message with a clear error in chat — switch back here if that happens.
                  </div>
                </div>
              </div>
            ) : null}

            {veniceModelSection && def ? (
              <AgentModelSettings agentId={agent.id} agentName={def.name}
                ready={agent.status === "running" && !agent.activity} disabled={busy} onChanged={onChanged}
                onBusyChange={setModelSettingsBusy} onFeedbackChange={reportModelFeedback} />
            ) : null}

            {/* PERMISSIONS (chat-CLI agents with a new-enough box) */}
            {permissionsSection ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="mono" style={label}>Permissions</div>
                <div style={card}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                    How much the agent may do on its computer. Applies from the next message.
                  </div>
                  {/* A tap applies the preset at once, so touch layouts show each hint before the tap. */}
                  <div className="hm-choices">
                    {([
                      { value: "" as BoxRestrict, label: "Full access", hint: "Everything — shell, files, web. The default." },
                      { value: "limited" as BoxRestrict, label: "Limited", hint: def?.cliKind === "codex" ? "Sandboxed to its workspace — no system-wide changes." : "No shell commands — it can still read and edit files." },
                      { value: "readonly" as BoxRestrict, label: "Read-only", hint: "Look but don't touch — research and answers only." },
                    ]).map((o) => {
                      const active = restrict === o.value;
                      const hintId = `manage-restrict-hint-${o.value || "full"}`;
                      return (
                        <div key={o.value || "full"} className="hm-choice">
                          <button
                            type="button"
                            disabled={busy}
                            title={o.hint}
                            aria-pressed={active}
                            aria-describedby={hintId}
                            onClick={() => { if (!active) void applyRestrict(o.value); }}
                            style={{
                              border: active ? "1px solid var(--ink-black)" : "1px solid var(--etched-border)",
                              background: active ? "var(--ink-black)" : "transparent",
                              color: active ? "var(--bg-surface)" : "var(--text-secondary)",
                              fontSize: 12, padding: "6px 11px", minHeight: 40, cursor: busy ? "default" : "pointer",
                              fontFamily: "var(--font-mono), monospace",
                            }}
                          >
                            {o.label}
                          </button>
                          <span id={hintId} className="hm-choice-hint">{o.hint}</span>
                        </div>
                      );
                    })}
                    {acting === "restrict" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "var(--text-muted)" }} /> : null}
                  </div>
                  {errorFor("permissions")}
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                    {restrict === "readonly"
                      ? "The agent can read files and browse but won't run commands or change anything."
                      : restrict === "limited"
                        ? (def?.cliKind === "codex" ? "Sandboxed to its workspace — can edit project files but not the wider system." : "Shell commands are off; file reads and edits still work.")
                        : "The agent runs autonomously with full access to its own computer (it's single-tenant, yours alone)."}
                  </div>
                </div>
              </div>
            ) : null}

            {/* TOOLS + MCP SERVERS (chat-CLI agents with a new-enough box) */}
            {toolsSection && agent.chat_url ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="mono" style={label}>Tools</div>
                <div style={card}>
                  {catalogToolsBlocked ? (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                      {catalogToolsBlocked}
                    </div>
                  ) : <>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                    Attach a capability to {def?.name || "the agent"} — crypto research, deeper web search, and more. Each tool wires up its own connector (and credentials) on the computer; they load on the next message.
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={() => setToolsOpen(true)}
                      style={{ ...btnGhost, display: "inline-flex", alignItems: "center", gap: 7 }}
                    >
                      <Wrench size={13} /> Browse tools
                    </button>
                  </div>
                  </>}

                  {/* Connect any MCP server by hand: for tools not in the catalog yet. */}
                  {mcpSupported ? (
                  <details style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 12 }}>
                    <summary style={{ cursor: "pointer", fontSize: 11.5, color: "var(--text-muted)", userSelect: "none", padding: "11px 0" }}>
                      Advanced — connect a raw MCP server
                    </summary>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14, marginTop: 12 }}>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                        Any Model Context Protocol server, by command. Servers run on the computer and load on the next message.
                      </div>
                  {(mcp || []).length > 0 ? (
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
                      {(mcp || []).map((s) => {
                        const confirmingRemove = mcpRemoveConfirm === s.name;
                        const removeBtn: React.CSSProperties = { border: "1px solid var(--etched-border)", background: "transparent", minWidth: 40, minHeight: 40, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 10px", flexShrink: 0, cursor: busy ? "default" : "pointer", fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" };
                        return (
                          <div key={s.name} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 4, border: "1px solid var(--etched-border)", padding: "4px 4px 4px 10px" }}>
                            <span style={{ flex: "1 1 160px", minWidth: 0, display: "flex", alignItems: "center", gap: 10, minHeight: 40 }}>
                              <span className="mono" title={s.name} style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-black)", flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                              <span className="mono" style={{ fontSize: 11, color: confirmingRemove ? "#e06c5a" : "var(--text-muted)", flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{confirmingRemove ? "Remove?" : [s.command, ...s.args].join(" ")}</span>
                            </span>
                            {/* Two-step remove. The trash button becomes Cancel in place, so it keeps
                                focus and a double tap lands on Cancel; when the pair wraps to its own
                                line, the second tap lands on the prompt instead. */}
                            <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                              {confirmingRemove ? (
                                <button type="button" disabled={busy} onClick={() => void dropMcp(s.name)} aria-label={`Confirm remove ${s.name}`} style={{ ...removeBtn, color: "#e06c5a", borderColor: "rgba(192,57,43,0.5)" }}>
                                  {acting === "mcp-" + s.name ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={13} />} Remove
                                </button>
                              ) : null}
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setMcpRemoveConfirm(confirmingRemove ? null : s.name)}
                                aria-label={confirmingRemove ? `Cancel removing ${s.name}` : `Remove ${s.name}`}
                                style={confirmingRemove ? { ...removeBtn, color: "var(--ink-black)" } : { ...removeBtn, padding: 0, color: "#e06c5a" }}
                              >
                                {confirmingRemove ? "Cancel" : <Trash2 size={13} />}
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No MCP servers connected yet.</div>
                  )}
                  <div className="hm-mcp-add">
                    <input
                      value={mcpName}
                      onChange={(e) => setMcpName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); mcpCmdRef.current?.focus(); } }}
                      placeholder="name"
                      aria-label="MCP server name"
                      autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next"
                      style={{ padding: "8px 10px", minHeight: 40, border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 12, fontFamily: "var(--font-mono), monospace", outline: "none", minWidth: 0 }}
                    />
                    <input
                      ref={mcpCmdRef}
                      value={mcpCmd}
                      onChange={(e) => setMcpCmd(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void addMcp(); }}
                      placeholder="command, e.g. npx -y @modelcontextprotocol/server-github"
                      aria-label="MCP server command"
                      autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done"
                      style={{ padding: "8px 10px", minHeight: 40, border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 12, fontFamily: "var(--font-mono), monospace", outline: "none", minWidth: 0 }}
                    />
                    <button
                      type="button"
                      disabled={busy || !mcpName.trim() || !mcpCmd.trim()}
                      onClick={() => void addMcp()}
                      style={{ ...btnGhost, opacity: busy || !mcpName.trim() || !mcpCmd.trim() ? 0.5 : 1, cursor: busy || !mcpName.trim() || !mcpCmd.trim() ? "default" : "pointer" }}
                    >
                      {acting === "mcp" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : "Add"}
                    </button>
                  </div>
                  {errorFor("tools")}
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                        Servers that need API keys read them from the command&apos;s environment — include them as <span className="mono">KEY=value</span> from the Terminal if needed.
                      </div>
                    </div>
                  </details>
                  ) : null}
                </div>
                {toolsOpen && !catalogToolsBlocked ? (
                  <ToolInstallPicker
                    agentId={agent.id}
                    boxUrl={agent.chat_url}
                    token={agent.api_token}
                    onClose={() => setToolsOpen(false)}
                    onChanged={() => void refreshMcp()}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </ManagePanel>
      ) : null}

      {/* RESOURCES — always shown: size is a fact even when it can't change. */}
      {sections.includes("resources") ? (
        <ManagePanel id="resources" selected={selected}>
          <section id="resources" style={{ display: "grid", gap: 16, scrollMarginTop: 72 }}>
            {resizeKind === "hetzner-server-type" ? (
              <ProviderResizePanel agent={agent} onChanged={onChanged} onFeedbackChange={reportResourcesFeedback} />
            ) : resizeKind === "fixed" ? (
              <ManageFixedSize
                size={`${fmtNum(agent.cpu)} CPU / ${fmtNum(agent.ram)} GB`}
                reason={capReason(manage?.resize.cap) ?? `This prepared ${computerTemplate?.name ?? ""} computer can't be resized yet.`}
              />
            ) : (
              <div style={card}>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                  Reserved CPU counts against your pool, but shared CPU scheduling does not provide dedicated physical cores or guaranteed performance. Reserved memory is guaranteed to this computer. Maximums are hard ceilings it can burst to only while the host has spare capacity.
                </div>
                {hasPlan ? (
                  <PoolMeter
                    planName={plan?.name}
                    cpu={{ othersUsed: usedOtherCpu, selected: rcpu, total: poolCpu }}
                    ram={{ othersUsed: usedOtherRam, selected: rram, total: poolRam }}
                  />
                ) : null}
                <div className="hm-resource-grid">
                  <fieldset aria-label="Reserved CPU" style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
                    <legend className="mono" style={{ ...label, marginBottom: 7 }}><Cpu size={12} /> Reserved CPU</legend>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {cpuOptions.map((n) => {
                      const disabled = !resizeAllowed || n < floor.cpu || n > capCpu;
                      return (
                        <button key={`c${n}`} type="button" disabled={disabled} aria-pressed={rcpu === n} onClick={() => { setRcpu(n); setMaximumCpu(current => Math.max(current, n)); }} style={{ border: "1px solid var(--etched-border)", background: rcpu === n ? "var(--gold-leaf)" : "transparent", color: rcpu === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", minHeight: 40, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} CPU</button>
                      );
                    })}
                    </div>
                  </fieldset>
                  <fieldset aria-label="Maximum CPU" style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
                    <legend className="mono" style={{ ...label, marginBottom: 7 }}><Cpu size={12} /> Maximum CPU</legend>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {cpuOptions.filter(n => n >= rcpu).map((n) => {
                        const disabled = !resizeAllowed || n > maximumCapCpu;
                        return <button key={`mc${n}`} type="button" disabled={disabled} aria-pressed={maximumCpu === n} onClick={() => setMaximumCpu(n)} style={{ border: "1px solid var(--etched-border)", background: maximumCpu === n ? "var(--gold-leaf)" : "transparent", color: maximumCpu === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", minHeight: 40, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} CPU</button>;
                      })}
                    </div>
                  </fieldset>
                  <fieldset aria-label="Reserved memory" style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
                    <legend className="mono" style={{ ...label, marginBottom: 7 }}><MemoryStick size={12} /> Reserved memory</legend>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {ramOptions.map((n) => {
                      const disabled = !resizeAllowed || n < floor.ram || n > capRam;
                      return (
                        <button key={`r${n}`} type="button" disabled={disabled} aria-pressed={rram === n} onClick={() => { setRram(n); setMaximumRam(current => Math.max(current, n)); }} style={{ border: "1px solid var(--etched-border)", background: rram === n ? "var(--gold-leaf)" : "transparent", color: rram === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", minHeight: 40, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} GB</button>
                      );
                    })}
                    </div>
                  </fieldset>
                  <fieldset aria-label="Maximum memory" style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
                    <legend className="mono" style={{ ...label, marginBottom: 7 }}><MemoryStick size={12} /> Maximum memory</legend>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {ramOptions.filter(n => n >= rram).map((n) => {
                        const disabled = !resizeAllowed || n > maximumCapRam;
                        return <button key={`mr${n}`} type="button" disabled={disabled} aria-pressed={maximumRam === n} onClick={() => setMaximumRam(n)} style={{ border: "1px solid var(--etched-border)", background: maximumRam === n ? "var(--gold-leaf)" : "transparent", color: maximumRam === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", minHeight: 40, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} GB</button>;
                      })}
                    </div>
                  </fieldset>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <button type="button" disabled={busy || !canResize} onClick={() => { if (canResize) void requestRunEnding("resize"); }} style={{ ...btnDark, background: canResize ? "var(--ink-black)" : "transparent", color: canResize ? "var(--bg-surface)" : "var(--text-muted)", cursor: busy || !canResize ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
                    {acting === "resize" || repliesCheck === "resize" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : null}
                    {dirty ? `Apply · ${fmtNum(rcpu)} CPU / ${fmtNum(rram)} GB reserved · ${fmtNum(maximumCpu)} CPU / ${fmtNum(maximumRam)} GB max` : "Apply"}
                  </button>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    {!budget.ready ? "Couldn’t verify your available Hivra Cloud capacity. Refresh before resizing."
                      : budget.selfManaged ? `On your own server you can choose up to ${MAX_CPU} CPU / ${MAX_RAM} GB. Host capacity is checked before applying; your Hivra Cloud plan does not limit this computer.`
                      : budget.fixedSize ? `This managed dashboard has a fixed ${fmtNum(capCpu)} CPU / ${fmtNum(capRam)} GB allocation. It uses an agent slot, not your compute pool.`
                      : hasPlan
                      ? poolFull
                        ? `Your ${plan?.name} pool is fully used by your other agents. Shrink another computer to grow this one.`
                        : `Min ${fmtNum(floor.cpu)} CPU / ${fmtNum(floor.ram)} GB · up to ${fmtNum(capCpu)} CPU / ${fmtNum(capRam)} GB for this computer on ${plan?.name}.`
                      : `Min for ${def?.name || "this agent"}: ${floor.cpu} CPU / ${floor.ram} GB · max ${MAX_CPU} / ${MAX_RAM} GB.`}
                  </span>
                  {!budget.ready ? <button type="button" style={btnGhost} onClick={onChanged}>Refresh capacity</button> : null}
                </div>
                {manage && !capAvailable(manage.resize.cap) ? <CapReasonLine cap={manage.resize.cap} /> : null}
                {repliesDialog(["resize"])}
                {errorFor("resources")}
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Resizing reboots the computer (a brief reconnect; the chat reattaches automatically).</div>
              </div>
            )}
          </section>
        </ManagePanel>
      ) : null}

      {/* RECOVERY — restore points and folder recovery, where the server keeps them. */}
      {sections.includes("recovery") ? (
        <ManagePanel id="recovery" selected={selected}>
          <div style={{ display: "grid", gap: 20 }}>
            {restorePointsListed ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="mono" style={label}>Restore points</div>
                <div style={card}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Same-host recovery</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, marginTop: 3 }}>
                        Capture this computer in place. Restore points stay on the same host until you destroy the computer; they are not an off-host backup.
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={createRestorePointDisabled}
                      onClick={() => void run("snapshot", async () => {
                        await snapshotAgent(agent.id);
                        await refreshSnapshots();
                      })}
                      style={{ ...btnDark, cursor: createRestorePointDisabled ? "default" : "pointer", opacity: createRestorePointDisabled ? 0.5 : 1 }}
                    >
                      {acting === "snapshot" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <ShieldCheck size={14} />}
                      Create restore point
                    </button>
                  </div>
                  <CapReasonLine cap={manage?.restorePoints} />
                  {errorFor("restore")}

                  {snapshotsLoading && snapshots.length === 0 ? (
                    <div role="status" style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading restore points…</div>
                  ) : snapshotsError ? (
                    <div role="alert" style={{ fontSize: 12, color: "#e06c5a", lineHeight: 1.5 }}>
                      {snapshotsError} <button type="button" onClick={() => void refreshSnapshots()} style={{ ...btnGhost, marginLeft: 8 }}>Retry</button>
                    </div>
                  ) : snapshots.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No restore points yet.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 9 }}>
                      {snapshots.map((snapshot, index) => (
                        <div key={snapshot.id} style={{ border: "1px solid var(--etched-border)", padding: 12, display: "grid", gap: 9 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <div style={{ flex: 1, minWidth: 180 }}>
                              <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-black)" }}>Restore point {snapshots.length - index}</div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                                {fmtDate(snapshot.createdAt)} · {snapshot.status === "ready" ? "Ready" : snapshot.status === "creating" ? "Verifying" : snapshot.status === "restoring" ? "Restoring" : "Needs attention"}
                                {snapshot.restoreCount > 0 ? ` · restored ${snapshot.restoreCount}×` : ""}
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={busy || lifecyclePending || snapshot.status !== "ready" || !restorePointsUsable}
                              onClick={() => setRestoreConfirmId(snapshot.id)}
                              style={{ ...btnGhost, cursor: busy || lifecyclePending || snapshot.status !== "ready" ? "default" : "pointer", opacity: busy || lifecyclePending || snapshot.status !== "ready" ? 0.5 : 1 }}
                            >
                              <RefreshCw size={13} /> Restore
                            </button>
                          </div>
                          {snapshot.error ? <div role="alert" style={{ color: "#e06c5a", fontSize: 11.5 }}>{snapshot.error}</div> : null}
                          {restoreConfirmId === snapshot.id ? (
                            <div style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 10, display: "grid", gap: 9 }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                                <AlertTriangle size={15} style={{ color: "#e06c5a", flexShrink: 0, marginTop: 2 }} />
                                Restoring rolls the disk back to this point and permanently removes changes made afterward. The computer will be left stopped; start it after you review the result.
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  disabled={busy || lifecyclePending}
                                  onClick={() => void requestRunEnding("restore", snapshot.id)}
                                  style={{ ...btnDark, cursor: busy || lifecyclePending ? "default" : "pointer" }}
                                >
                                  {acting === "restore" || repliesCheck === "restore" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />}
                                  Confirm restore
                                </button>
                                <button type="button" disabled={busy} onClick={() => { setRestoreConfirmId(null); setRepliesConfirm(null); }} style={{ ...btnGhost, cursor: busy ? "default" : "pointer" }}>Cancel</button>
                              </div>
                              {repliesDialog(["restore"], snapshot.id)}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                    Up to {snapshotMaximum} restore points per computer. Destroying the computer removes its restore points too.
                  </div>
                </div>
              </div>
            ) : manage?.restorePoints ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="mono" style={label}>Restore points</div>
                <div style={card}><CapReasonLine cap={manage.restorePoints} /></div>
              </div>
            ) : null}

            {capShown(manage?.folderRecovery) ? (
              <div style={card}>
                {capAvailable(manage?.folderRecovery)
                  ? <a href={`/dashboard/computers/recovery?source=${encodeURIComponent(agent.id)}`} style={{ color: "var(--ink-black)", fontSize: 14, textDecoration: "underline" }}>Hivra folder recovery</a>
                  : <div style={{ color: "var(--ink-black)", fontSize: 14 }}>Hivra folder recovery</div>}
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                  Export an encrypted copy of your Hivra folder and restore it into a different empty Ubuntu computer. Folder only: 2 MiB total, up to 512 files and folders. The original computer is preserved.
                </div>
                <CapReasonLine cap={manage?.folderRecovery} />
              </div>
            ) : null}
          </div>
        </ManagePanel>
      ) : null}

      {/* PRIVATE NETWORK — only on computers that can join one. */}
      {sections.includes("network") ? (
        <ManagePanel id="network" selected={selected}>
          <HivraPrivateAccessPanel agentId={agent.id} observedStatus={agent.status} onFeedbackChange={reportNetworkFeedback} />
        </ManagePanel>
      ) : null}

      {/* UPDATES — the connection service, and the agent software (PR U slot). */}
      {sections.includes("updates") ? (
        <ManagePanel id="updates" selected={selected}>
          <div style={{ display: "grid", gap: 20 }}>
            {connectionUpdate ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="mono" style={label}>Connection service</div>
                <div style={card}>
                  {connectionUpdate.state === "unavailable" ? (
                    <CapReasonLine cap={connectionUpdate} />
                  ) : (
                    <>
                      <div>
                        <button type="button" disabled={busy || !capAvailable(connectionUpdate)} onClick={() => { setRepliesConfirm(null); void run("runtime-update", updateConnectionService); }} style={{ ...btnGhost, cursor: busy || !capAvailable(connectionUpdate) ? "default" : "pointer", opacity: busy || !capAvailable(connectionUpdate) ? 0.5 : 1 }} title="Refresh the Hivra connection service without restarting the computer">
                          {acting === "runtime-update" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Update connection service
                        </button>
                      </div>
                      <CapReasonLine cap={connectionUpdate} />
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                        {isComputerOnly
                          ? "Update connection service brings Hivra’s connection service up to date without restarting the computer, so apps, files, and local logins stay as they are. The desktop stream disconnects briefly; terminals open on this page reconnect when it finishes."
                          : "Update connection service brings Hivra’s connection service up to date without restarting the computer, so your agent login, chats, model credentials, and files stay as they are. Terminals open on this page reconnect when it finishes."}
                        {manage?.agentCli ? ` It also moves ${def?.name ?? "the agent"} to version ${manage.agentCli.vetted}, the version Hivra has tested, once no reply is being written.` : ""}
                      </div>
                    </>
                  )}
                  {errorFor("updates")}
                  {progressFor("updates")}
                </div>
              </div>
            ) : null}
            <div id="agent-software">
              <AgentSoftwareSlot agent={agent} />
            </div>
          </div>
        </ManagePanel>
      ) : null}

      {/* ADVANCED — details, history, export, what isn't available, and the danger zone. */}
      <ManagePanel id="advanced" selected={selected}>
        <div style={{ display: "grid", gap: 20 }}>
          <div style={{ display: "grid", gap: 10 }}>
            <div className="mono" style={label}>Details</div>
            <div style={card}>
              <ManageDetails details={manage?.details ?? []} />
              {agent.chat_url ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
                  <span className="mono" style={{ ...label, flex: "0 0 160px" }}>Connection address</span>
                  {/* The URL keeps a 160px basis, so on a phone the actions wrap under it instead of squeezing it. */}
                  <span style={{ ...valStyle, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 160px", minWidth: 0 }}>{agent.chat_url.replace(/^https?:\/\//, "")}</span>
                  <span style={{ display: "inline-flex", gap: 8, flexShrink: 0 }}>
                    <button type="button" onClick={() => void copyEndpoint()} title="Copy URL" className="mono" style={{ ...label, border: "1px solid var(--etched-border)", background: "transparent", padding: "4px 10px", minHeight: 40, cursor: "pointer", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }}>{copied ? <Check size={11} /> : <Copy size={11} />}{copied ? "Copied" : "Copy"}</button>
                    <a href={agent.chat_url} target="_blank" rel="noopener noreferrer" title="Open" aria-label="Open endpoint" style={{ color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 40, minHeight: 40, border: "1px solid var(--etched-border)", boxSizing: "border-box" }}><ExternalLink size={13} /></a>
                  </span>
                </div>
              ) : null}
              {!manage && agent.vmid ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="mono" style={{ ...label, flex: "0 0 160px" }}>VM ID (for support)</span>
                  <span style={valStyle}>{agent.vmid}</span>
                  <CopyButton value={String(agent.vmid)} label="VM ID (for support)" />
                </div>
              ) : null}
              {lifecyclePending ? <div style={manageMuted}>Current operation: {statusLabel}</div> : null}
              {agent.error ? <div style={{ ...manageMuted, overflowWrap: "anywhere" }}>Last error: {agent.error}</div> : null}
            </div>
          </div>

          <ManageHistory agentId={agent.id} />

          {manage?.export ? (
            <div style={card}>
              <div className="serif" style={{ fontSize: 16, color: "var(--ink-black)" }}>Export data</div>
              <div style={manageMuted}>Download {def?.name ?? "the agent"}&apos;s chats and memory as a portable file.</div>
              {capAvailable(manage.export)
                ? <div><a href={`/api/hivra/agents/${encodeURIComponent(agent.id)}/export`} style={{ ...btnGhost, textDecoration: "none" }}>Export data</a></div>
                : <CapReasonLine cap={manage.export} />}
            </div>
          ) : null}

          <ManageNotAvailable items={manage?.notAvailable ?? []} />

          {disclaimer ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div className="mono" style={label}>About</div>
              <div style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.02)", padding: 16, display: "flex", gap: 11, alignItems: "flex-start", boxSizing: "border-box" }}>
                <ShieldCheck size={16} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6, minWidth: 0 }}>{disclaimer}</div>
              </div>
            </div>
          ) : null}

          <ManageDangerZone
            name={agent.name}
            title={isComputerOnly ? "Destroy this computer" : "Destroy this agent"}
            description={isComputerOnly
              ? "Permanently deletes this computer and everything on it — files and local logins. This cannot be undone."
              : "Permanently deletes the agent and everything on it — chats, files, logins. This cannot be undone."}
            warning={providerComputer ? "This is a dedicated cloud computer. Removal also deletes its original Hetzner server, IPs, setup firewall and SSH key. Billing may continue until resource removal is verified." : undefined}
            confirmWarning={providerComputer ? "This also deletes its original Hetzner server, IPs, setup firewall and SSH key. Billing may continue until resource removal is verified." : undefined}
            busy={busy}
            deleting={acting === "destroy"}
            progress={deletionProgress}
            onConfirm={() => void run("destroy", async () => {
              const controller = new AbortController(); deletionController.current = controller;
              setDeletionProgress("Checking the original computer and removal operation…");
              try {
                await deleteAgent(agent.id, { signal: controller.signal,
                  onProgress: message => { if (!controller.signal.aborted) setDeletionProgress(message); } });
                if (!controller.signal.aborted) onDestroyed();
              } finally { if (deletionController.current === controller) deletionController.current = null; }
            })}
            error={errorFor("danger")}
          />
        </div>
      </ManagePanel>
    </ManageLayout>
  );
}

