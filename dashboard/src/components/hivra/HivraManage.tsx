"use client";

// HivraManage — the agent's settings surface (Manage tab).
// Overview (with inline rename + endpoint copy), Power (start/stop/restart),
// Resize (floor-aware, per agent type), and a Danger Zone with a two-step,
// type-the-name destroy confirmation. Command Center vocabulary throughout.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Power, RefreshCw, Trash2, Pencil, Check, X, Copy, ExternalLink, Loader2,
  AlertTriangle, Cpu, MemoryStick, Globe, Hash, Server, Clock, ShieldCheck, KeyRound, Wrench,
} from "lucide-react";
import { CookieImportModal } from "@/components/instances/CookieImportModal";
import { ToolInstallPicker } from "./ToolInstallPicker";
import { AgentModelSettings } from "./AgentModelSettings";
import { ProviderResizePanel } from "./ProviderResizePanel";
import { HivraPrivateAccessPanel } from "./HivraPrivateAccessPanel";
import { GvisorComputerManage } from "./GvisorComputerManage";

import {
  stopAgent, startAgent, restartAgent, updateAgentRuntime, resizeAgent, renameAgent, deleteAgent, browserToggle,
  getBoxModel, setBoxModel, getBoxRestrict, setBoxRestrict, listBoxMcp, addBoxMcp, removeBoxMcp,
  listAgentSnapshots, snapshotAgent, restoreAgentSnapshot,
  type HivraAgent, type HivraAgentSnapshot, type PlanInfo, type BoxRestrict, type McpServer,
} from "@/lib/hivra/agent-api";
import { resizeFloor, hostingDisclaimer, MAX_CPU, MAX_RAM, type AgentDef } from "@/lib/hivra/agent-catalog";
import { UpgradePaywallModal } from "@/components/billing/UpgradePaywallModal";
import { PoolMeter } from "./PoolMeter";
import { resizeBudget } from "@/lib/hivra/resize-budget";
import { agentActivityPresentation } from "@/lib/hivra/agent-activity";
import { providerPowerMessage } from "@/lib/hivra/provider-power-contract";
import { getComputerTemplate, type ComputerTemplateDefinition } from "@/lib/hivra/computer-catalog";

// The server's resource-gate denial for browser-on-free (403 from launch/resize)
// and the client-side pre-check below both funnel into the same paywall modal.
const PAID_PLAN_DENIAL_RE = /requires a paid plan/i;

const label: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)",
};
const card: React.CSSProperties = {
  border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)",
  padding: 18, display: "grid", gap: 14, boxSizing: "border-box", minWidth: 0,
  // minmax(0,1fr): the single column may SHRINK below its content's max-content
  // (e.g. a long endpoint URL) so children truncate instead of widening the card.
  gridTemplateColumns: "minmax(0, 1fr)",
};
const valStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace", fontSize: 12.5, color: "var(--ink-black)",
};

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

const STATUS_COLOR: Record<string, string> = {
  running: "#22c55e", provisioning: "var(--yellow)", stopped: "var(--text-muted)",
  error: "#e06c5a", deleted: "#e06c5a",
};

const LIFECYCLE_PROGRESS: Record<string, { title: string; detail: string }> = {
  start: {
    title: "Starting the computer…",
    detail: "Hivra is powering it on and waiting for the desktop connection. This normally takes under a minute.",
  },
  stop: {
    title: "Stopping the computer…",
    detail: "Hivra is shutting it down cleanly and confirming that it is off.",
  },
  restart: {
    title: "Restarting the computer…",
    detail: "The desktop will disconnect briefly while Hivra confirms the reboot.",
  },
  "runtime-update": {
    title: "Updating and restarting…",
    detail: "Hivra is refreshing the connection service, rebooting, and waiting for it to return.",
  },
};

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

function Row({ icon, k, children }: { icon: React.ReactNode; k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 22 }}>
      <span style={{ color: "var(--text-muted)", display: "inline-flex", width: 15 }}>{icon}</span>
      <span className="mono" style={{ ...label, width: 78 }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
    </div>
  );
}

export function HivraManage({
  agent, def, onChanged, onDestroyed, browserOn, onBrowserChange, plan,
}: {
  agent: HivraAgent;
  def?: AgentDef;
  onChanged: () => void;
  onDestroyed: () => void;
  /** Live browser-automation state (from the box). null = unknown/loading. */
  browserOn?: boolean | null;
  onBrowserChange?: (enabled: boolean) => void;
  /** The user's plan (pool budget + per-agent caps). null = loading/unsubscribed. */
  plan?: PlanInfo | null;
}) {
  const [acting, setActing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Locked-feature paywall (browser automation on Free). null = closed.
  const [paywallFeature, setPaywallFeature] = useState<"browser" | null>(null);
  const isFreePlan = agent.deployment_mode !== "self-managed" && Boolean(plan && (!plan.subscribed || plan.key === "free"));
  const managedPlanUnknown = agent.deployment_mode !== "self-managed" && !plan;

  const setModelSettingsBusy = useCallback((active: boolean) => setActing(active ? "llm" : null), []);

  // rename
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(agent.name);

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
  // Deep link from the dashboard panel: ?tab=manage&tools=1 opens the picker
  // straight away, so "Tools" in the agent list is one click to the modal.
  const [toolsOpen, setToolsOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).get("tools") === "1"; } catch { return false; }
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
  useEffect(() => {
    if (window.location.hash === "#resources#resources") {
      const canonical = new URL(window.location.href);
      canonical.hash = "resources";
      window.history.replaceState(window.history.state, "", `${canonical.pathname}${canonical.search}${canonical.hash}`);
    }
    if (window.location.hash !== "#resources") return;
    const frame = window.requestAnimationFrame(() => {
      const resources = document.getElementById("resources");
      if (resources && typeof resources.scrollIntoView === "function") resources.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [agent.id]);

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
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const deletionController = useRef<AbortController | null>(null);
  const [deletionProgress, setDeletionProgress] = useState<string | null>(null);
  useEffect(() => () => { deletionController.current?.abort(); }, [agent.id]);

  // misc
  const [copied, setCopied] = useState(false);
  const [snapshots, setSnapshots] = useState<HivraAgentSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [snapshotMaximum, setSnapshotMaximum] = useState(5);
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);

  const refreshSnapshots = useCallback(async () => {
    if (agent.computer_substrate !== "proxmox-kvm") {
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
  }, [agent.id, agent.computer_substrate]);

  useEffect(() => {
    setRestoreConfirmId(null);
    void refreshSnapshots();
  }, [refreshSnapshots]);

  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setActing(key); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) {
      const message = (e as Error).message;
      setErr(message);
      // A resource-gate "browser on Free" 403 deserves the upgrade path, not
      // just a raw error banner.
      if (PAID_PLAN_DENIAL_RE.test(message)) setPaywallFeature("browser");
    }
    finally { setActing(null); }
  }, [onChanged]);

  const copyEndpoint = useCallback(async () => {
    if (!agent.chat_url) return;
    try { await navigator.clipboard.writeText(agent.chat_url); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
  }, [agent.chat_url]);

  const toggleBrowser = useCallback(async (next: boolean) => {
    if (!agent.chat_url || acting) return;
    if (next && managedPlanUnknown) {
      setErr("Check your Hivra Cloud plan before enabling browser automation.");
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
      setErr(message);
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
    } catch (e) { setErr((e as Error).message); }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting]);

  const applyRestrict = useCallback(async (next: BoxRestrict) => {
    if (!agent.chat_url || acting) return;
    setActing("restrict"); setErr(null);
    try {
      const r = await setBoxRestrict(agent.chat_url, next, agent.api_token);
      if (!r.ok) throw new Error(r.error || "Couldn't change permissions");
      setRestrict(next);
    } catch (e) { setErr((e as Error).message); }
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
    } catch (e) { setErr((e as Error).message); }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting, mcpName, mcpCmd]);

  const dropMcp = useCallback(async (name: string) => {
    if (!agent.chat_url || acting) return;
    setActing("mcp-" + name); setErr(null);
    try {
      const r = await removeBoxMcp(agent.chat_url, name, agent.api_token);
      if (!r.ok) throw new Error(r.error || "Couldn't remove the MCP server");
      setMcp((prev) => (prev || []).filter((s) => s.name !== name));
    } catch (e) { setErr((e as Error).message); }
    finally { setActing(null); }
  }, [agent.chat_url, agent.api_token, acting]);

  const savedMaximumCpu = agent.cpu_max ?? agent.cpu;
  const savedMaximumRam = agent.ram_max ?? agent.ram;
  const dirty = rcpu !== agent.cpu || rram !== agent.ram
    || maximumCpu !== savedMaximumCpu || maximumRam !== savedMaximumRam;
  const busy = acting !== null;
  const lifecyclePending = agent.status === "provisioning";
  const providerComputer = agent.computer_substrate === "provider-vm";
  const gvisorComputer = agent.computer_substrate === "gvisor";
  const computerTemplate = agent.computer_profile && agent.computer_profile !== "linux-terminal" ? getComputerTemplate(agent.computer_profile) : undefined;
  const preparedComputer = computerTemplate?.launchMode === "prepared-canary";
  const snapshotComputer = agent.computer_substrate === "proxmox-kvm" && !preparedComputer;
  const isComputerOnly = agent.type === "linux-desktop" || Boolean(agent.computer_profile);
  const maximumCapCpu = budget.selfManaged
    ? MAX_CPU
    : budget.fixedSize ? capCpu : plan?.maxCpuPerAgent ?? capCpu;
  const maximumCapRam = budget.selfManaged
    ? MAX_RAM
    : budget.fixedSize ? capRam : plan?.maxRamPerAgent ?? capRam;
  const canResize = !providerComputer && !preparedComputer && !lifecyclePending && budget.ready && dirty
    && rcpu >= floor.cpu && rram >= floor.ram && rcpu <= capCpu && rram <= capRam
    && maximumCpu >= rcpu && maximumRam >= rram
    && maximumCpu <= maximumCapCpu && maximumRam <= maximumCapRam;

  const btnDark: React.CSSProperties = {
    border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)",
    fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800,
    padding: "9px 14px", display: "inline-flex", alignItems: "center", gap: 7,
  };
  const btnGhost: React.CSSProperties = {
    border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)",
    fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800,
    padding: "9px 14px", display: "inline-flex", alignItems: "center", gap: 7,
  };

  if (gvisorComputer) return <GvisorComputerManage agent={agent} onChanged={onChanged} onDestroyed={onDestroyed} />;

  return (
    <div style={{ width: "100%", maxWidth: 620, margin: "0 auto", padding: "clamp(20px, 5vw, 36px) clamp(14px, 4vw, 20px)", height: "100%", overflowY: "auto", overflowX: "hidden", boxSizing: "border-box" }}>
      {err ? (
        <div style={{ border: "1px solid #c0392b", background: "rgba(192,57,43,0.08)", color: "#e06c5a", fontSize: 12.5, padding: "9px 13px", marginBottom: 16, fontFamily: "var(--font-mono), monospace" }}>{err}</div>
      ) : null}

      {paywallFeature ? (
        <UpgradePaywallModal
          feature={paywallFeature}
          currentPlan={plan?.key ?? null}
          onClose={() => setPaywallFeature(null)}
        />
      ) : null}

      {/* OVERVIEW */}
      <div className="mono" style={{ ...label, marginBottom: 10 }}>Overview</div>
      <div style={{ ...card, marginBottom: 20 }}>
        {/* name + rename */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {editing ? (
            <>
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                maxLength={60}
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && nameDraft.trim()) { setEditing(false); void run("rename", () => renameAgent(agent.id, nameDraft.trim())); } if (e.key === "Escape") { setEditing(false); setNameDraft(agent.name); } }}
                style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 16, fontFamily: "var(--font-serif), serif", outline: "none" }}
              />
              <button type="button" disabled={!nameDraft.trim() || busy} onClick={() => { setEditing(false); void run("rename", () => renameAgent(agent.id, nameDraft.trim())); }} title="Save" style={{ ...btnGhost, padding: "7px 9px", color: "#22a06b" }}><Check size={14} /></button>
              <button type="button" onClick={() => { setEditing(false); setNameDraft(agent.name); }} title="Cancel" style={{ ...btnGhost, padding: "7px 9px" }}><X size={14} /></button>
            </>
          ) : (
            <>
              <strong className="serif" style={{ fontSize: 20, fontWeight: 400, color: "var(--ink-black)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name}</strong>
              {acting === "rename" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite", color: "var(--text-muted)" }} /> : null}
              <button type="button" onClick={() => { setNameDraft(agent.name); setEditing(true); }} title="Rename" className="mono" style={{ ...label, border: "1px solid var(--etched-border)", padding: "6px 9px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", flexShrink: 0 }}>
                <Pencil size={12} /> Rename
              </button>
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 14, display: "grid", gap: 9, gridTemplateColumns: "minmax(0, 1fr)" }}>
          <Row icon={<Server size={14} />} k={isComputerOnly ? "Computer" : "Agent"}><span style={valStyle}>{computerTemplate ? `${computerTemplate.name} · Operating system` : `${def?.name || agent.type} · ${def?.vendor || "—"}`}</span></Row>
          <Row icon={<span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_COLOR[agent.status] || "var(--text-muted)", display: "inline-block" }} />} k="Status"><span style={{ ...valStyle, textTransform: "capitalize" }}>{lifecyclePending ? agentActivityPresentation(agent, computerTemplate?.name || def?.name || "the agent").label : agent.status}</span></Row>
          <Row icon={<Cpu size={14} />} k="Size"><span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}><span style={valStyle}>{agent.cpu} CPU · {agent.ram} GB reserved · up to {agent.cpu_max ?? agent.cpu} CPU · {agent.ram_max ?? agent.ram} GB</span><a href="#resources" style={{ ...label, color: "var(--ink-black)" }}>Resources</a></span></Row>
          <Row icon={<Globe size={14} />} k="Region"><span style={valStyle}>{providerComputer ? "See your provider project" : "EU"}</span></Row>
          {agent.ip ? <Row icon={<Globe size={14} />} k="IP"><span style={valStyle}>{agent.ip}</span></Row> : null}
          {agent.vmid ? <Row icon={<Hash size={14} />} k="Box"><span style={valStyle}>{agent.vmid}</span></Row> : null}
          <Row icon={<Clock size={14} />} k="Created"><span style={valStyle}>{fmtDate(agent.created_at)}</span></Row>
          {agent.chat_url ? (
            <Row icon={<Globe size={14} />} k="Endpoint">
              <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
                <span style={{ ...valStyle, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{agent.chat_url.replace(/^https?:\/\//, "")}</span>
                <button type="button" onClick={() => void copyEndpoint()} title="Copy URL" className="mono" style={{ ...label, border: "1px solid var(--etched-border)", padding: "4px 7px", cursor: "pointer", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>{copied ? <Check size={11} /> : <Copy size={11} />}{copied ? "Copied" : "Copy"}</button>
                <a href={agent.chat_url} target="_blank" rel="noopener noreferrer" title="Open" style={{ color: "var(--text-secondary)", display: "inline-flex", flexShrink: 0 }}><ExternalLink size={13} /></a>
              </span>
            </Row>
          ) : null}
        </div>
      </div>

      {/* POWER */}
      <div className="mono" style={{ ...label, marginBottom: 10 }}>Power</div>
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {agent.status === "stopped" ? (
            <button type="button" disabled={busy} onClick={() => void run("start", () => startAgent(agent.id))} style={{ ...btnDark, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
              {acting === "start" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Power size={14} />} Start
            </button>
          ) : (
            <button type="button" disabled={busy || lifecyclePending} onClick={() => void run("stop", () => stopAgent(agent.id))} style={{ ...btnGhost, cursor: busy || lifecyclePending ? "default" : "pointer", opacity: busy || lifecyclePending ? 0.6 : 1 }}>
              {acting === "stop" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Power size={14} />} Stop
            </button>
          )}
          <button type="button" disabled={busy || lifecyclePending || agent.status === "stopped"} onClick={() => void run("restart", () => restartAgent(agent.id))} style={{ ...btnGhost, cursor: busy || lifecyclePending || agent.status === "stopped" ? "default" : "pointer", opacity: busy || lifecyclePending || agent.status === "stopped" ? 0.5 : 1 }} title={agent.status === "stopped" ? "Box is stopped — use Start" : "Reboot the box"}>
            {acting === "restart" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Restart
          </button>
          {!providerComputer && !preparedComputer ? <button type="button" disabled={busy || lifecyclePending || agent.status !== "running"} onClick={() => void run("runtime-update", () => updateAgentRuntime(agent.id))} style={{ ...btnGhost, cursor: busy || lifecyclePending || agent.status !== "running" ? "default" : "pointer", opacity: busy || lifecyclePending || agent.status !== "running" ? 0.5 : 1 }} title="Refresh the Hivra connection service and reboot the box">
            {acting === "runtime-update" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Update &amp; restart
          </button> : null}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Stop shuts down the box; Start brings it back. Restart reboots in place. {!providerComputer && !preparedComputer
            ? isComputerOnly
              ? "Update & restart refreshes Hivra’s connection service, then reboots; your files and local logins remain on the computer."
              : "Update & restart refreshes Hivra’s connection service, then reboots; your agent login, chats, model credentials, and files remain on the box."
            : ""} Stopping does not cancel your plan or any provider billing.
        </div>
        {acting && LIFECYCLE_PROGRESS[acting] ? (
          <div role="status" aria-live="polite" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.025)" }}>
            <Loader2 size={15} aria-hidden="true" style={{ animation: "spin 1s linear infinite", flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 12.5, color: "var(--ink-black)", fontWeight: 700 }}>{LIFECYCLE_PROGRESS[acting].title}</div>
              <div style={{ marginTop: 3, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{LIFECYCLE_PROGRESS[acting].detail}</div>
            </div>
          </div>
        ) : null}
        {providerComputer && providerPowerMessage(agent.power_stage) ? <p
          role={["verification_unavailable", "request_uncertain", "failed"].includes(String(agent.power_stage)) ? "alert" : "status"}
          style={{ margin: 0, padding: "12px 14px", border: "1px solid var(--etched-border)", fontSize: 12, lineHeight: 1.6 }}
        >{providerPowerMessage(agent.power_stage)}</p> : null}
      </div>

      {snapshotComputer ? (
        <>
          <div className="mono" style={{ ...label, marginBottom: 10 }}>Restore points</div>
          <div style={{ ...card, marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Same-host recovery</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, marginTop: 3 }}>
                  Capture this Proxmox computer in place. Restore points stay on the same host until you destroy the computer; they are not an off-host backup.
                </div>
              </div>
              <button
                type="button"
                disabled={busy || lifecyclePending || !["running", "stopped"].includes(agent.status) || snapshots.length >= snapshotMaximum}
                onClick={() => void run("snapshot", async () => {
                  await snapshotAgent(agent.id);
                  await refreshSnapshots();
                })}
                style={{ ...btnDark, cursor: busy || lifecyclePending || snapshots.length >= snapshotMaximum ? "default" : "pointer", opacity: busy || lifecyclePending || snapshots.length >= snapshotMaximum ? 0.5 : 1 }}
              >
                {acting === "snapshot" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <ShieldCheck size={14} />}
                Create restore point
              </button>
            </div>

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
                        disabled={busy || lifecyclePending || snapshot.status !== "ready"}
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
                            onClick={() => void run("restore", async () => {
                              await restoreAgentSnapshot(agent.id, snapshot.id);
                              setRestoreConfirmId(null);
                              await refreshSnapshots();
                            })}
                            style={{ ...btnDark, cursor: busy || lifecyclePending ? "default" : "pointer" }}
                          >
                            {acting === "restore" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />}
                            Confirm restore
                          </button>
                          <button type="button" disabled={busy} onClick={() => setRestoreConfirmId(null)} style={{ ...btnGhost, cursor: busy ? "default" : "pointer" }}>Cancel</button>
                        </div>
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
        </>
      ) : null}

      {agent.type === "linux-desktop" && agent.computer_profile === "ubuntu-desktop" && !providerComputer ? (
        <div style={{ ...card, marginBottom: 20 }}>
          <a href={`/dashboard/computers/recovery?source=${encodeURIComponent(agent.id)}`} style={{ color: "var(--ink-black)", fontSize: 14, textDecoration: "underline" }}>Hivra folder recovery</a>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
            Export an encrypted copy of your Hivra folder and restore it into a different empty Ubuntu computer. Folder only: 2 MiB total, up to 512 files and folders. The original computer is preserved.
          </div>
        </div>
      ) : null}

      {/* BROWSER AUTOMATION (browser-capable agents only) */}
      {def?.browser ? (
        <>
          <div className="mono" style={{ ...label, marginBottom: 10 }}>Browser automation</div>
          <div style={{ ...card, marginBottom: 20 }}>
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
                    : "No browser — the box runs leaner and can resize down to the 0.5 CPU / 1 GB floor. The Browser tab and web automation are off until you turn this back on."}
                </div>
              </div>
              {browserStateKnown ? <button
                type="button"
                role="switch"
                aria-checked={bOn}
                disabled={busy || lifecyclePending || (!bOn && managedPlanUnknown)}
                onClick={() => void toggleBrowser(!bOn)}
                title={bOn ? "Disable browser automation" : "Enable browser automation"}
                style={{ width: 48, height: 27, borderRadius: 14, border: "1px solid var(--etched-border)", background: bOn ? "var(--gold-leaf)" : "rgba(255,255,255,0.05)", position: "relative", cursor: busy ? "default" : "pointer", flexShrink: 0, padding: 0 }}
              >
                {acting === "browser" ? (
                  <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "var(--ink-black)", position: "absolute", top: 6, left: bOn ? 24 : 6 }} />
                ) : (
                  <span style={{ position: "absolute", top: 3, left: bOn ? 24 : 3, width: 19, height: 19, borderRadius: "50%", background: bOn ? "var(--ink-black)" : "var(--text-muted)", transition: "left .15s ease" }} />
                )}
              </button> : null}
            </div>
            {managedPlanUnknown ? <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
              Check your Hivra Cloud plan before enabling browser automation. You can still turn an existing browser off.
              <div style={{ marginTop: 10 }}><button type="button" style={btnGhost} onClick={onChanged}>Check plan</button></div>
            </div> : null}
          </div>
          {browserStateKnown && bOn && agent.chat_url ? (
            <div style={{ ...card, marginBottom: 20, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Log in with your accounts</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, marginTop: 3 }}>
                  Import cookies from your own browser so the agent is signed in to your sites — no passwords shared, and far fewer datacenter bot-checks (Cloudflare, CAPTCHAs).
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCookieOpen(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, flexShrink: 0, padding: "9px 14px", border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--vellum-bg, #f5f0e8)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer" }}
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
        </>
      ) : null}

      {/* MODEL (chat-CLI agents with a new-enough box) */}
      {isChatCli && agent.chat_url && modelSupported ? (
        <>
          <div className="mono" style={{ ...label, marginBottom: 10 }}>Model</div>
          <div style={{ ...card, marginBottom: 20 }}>
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
                      fontSize: 12, padding: "6px 11px", cursor: busy ? "default" : "pointer",
                      fontFamily: "var(--font-mono), monospace",
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
              {acting === "model" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "var(--text-muted)" }} /> : null}
            </div>
            {model && !(MODEL_OPTS[def?.cliKind || "claude"] || []).some((o) => o.value === model) ? (
              <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>Current: {model}</div>
            ) : null}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && customModel.trim()) void applyModel(customModel.trim()); }}
                placeholder={def?.cliKind === "codex" ? "Custom model id (e.g. gpt-5.1-codex)" : "Custom model id (e.g. claude-opus-4-8[1m])"}
                style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 12, fontFamily: "var(--font-mono), monospace", outline: "none", minWidth: 0 }}
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
        </>
      ) : null}

      {def?.llm?.providers.includes("venice") ? (
        <AgentModelSettings key={agent.id} agentId={agent.id} agentName={def.name}
          ready={agent.status === "running" && !agent.activity} disabled={busy} onChanged={onChanged}
          onBusyChange={setModelSettingsBusy} />
      ) : null}

      {/* PERMISSIONS (chat-CLI agents with a new-enough box) */}
      {isChatCli && agent.chat_url && restrictSupported ? (
        <>
          <div className="mono" style={{ ...label, marginBottom: 10 }}>Permissions</div>
          <div style={{ ...card, marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
              How much the agent may do on its box. Applies from the next message.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {([
                { value: "" as BoxRestrict, label: "Full access", hint: "Everything — shell, files, web. The default." },
                { value: "limited" as BoxRestrict, label: "Limited", hint: def?.cliKind === "codex" ? "Sandboxed to its workspace — no system-wide changes." : "No shell commands — it can still read and edit files." },
                { value: "readonly" as BoxRestrict, label: "Read-only", hint: "Look but don't touch — research and answers only." },
              ]).map((o) => {
                const active = restrict === o.value;
                return (
                  <button
                    key={o.value || "full"}
                    type="button"
                    disabled={busy}
                    title={o.hint}
                    onClick={() => { if (!active) void applyRestrict(o.value); }}
                    style={{
                      border: active ? "1px solid var(--ink-black)" : "1px solid var(--etched-border)",
                      background: active ? "var(--ink-black)" : "transparent",
                      color: active ? "var(--bg-surface)" : "var(--text-secondary)",
                      fontSize: 12, padding: "6px 11px", cursor: busy ? "default" : "pointer",
                      fontFamily: "var(--font-mono), monospace",
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
              {acting === "restrict" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "var(--text-muted)" }} /> : null}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {restrict === "readonly"
                ? "The agent can read files and browse but won't run commands or change anything."
                : restrict === "limited"
                  ? (def?.cliKind === "codex" ? "Sandboxed to its workspace — can edit project files but not the wider system." : "Shell commands are off; file reads and edits still work.")
                  : "The agent runs autonomously with full access to its own box (it's single-tenant — yours alone)."}
            </div>
          </div>
        </>
      ) : null}

      {/* TOOLS + MCP SERVERS (chat-CLI agents with a new-enough box) */}
      {isChatCli && agent.chat_url ? (
        <>
          <div className="mono" style={{ ...label, marginBottom: 10 }}>Tools</div>
          <div style={{ ...card, marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
              Attach a capability to {def?.name || "the agent"} — crypto research, deeper web search, and more. Each tool wires up its own connector (and credentials) on the box; they load on the next message.
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

            {/* Advanced escape hatch: connect a raw MCP server by hand. Power users
                and tools not yet in the catalog rely on this. */}
            {mcpSupported ? (
            <details style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: 11.5, color: "var(--text-muted)", userSelect: "none" }}>
                Advanced — connect a raw MCP server
              </summary>
              <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                  Any Model Context Protocol server, by command. Servers run on the box and load on the next message.
                </div>
            {(mcp || []).length > 0 ? (
              <div style={{ display: "grid", gap: 6 }}>
                {(mcp || []).map((s) => (
                  <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--etched-border)", padding: "7px 10px" }}>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-black)", flexShrink: 0 }}>{s.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[s.command, ...s.args].join(" ")}</span>
                    <button type="button" disabled={busy} onClick={() => void dropMcp(s.name)} aria-label={`Remove ${s.name}`} style={{ border: "none", background: "transparent", color: "#e06c5a", cursor: "pointer", display: "inline-flex", padding: 2 }}>
                      {acting === "mcp-" + s.name ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={13} />}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No MCP servers connected yet.</div>
            )}
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0, 110px) minmax(0, 1fr) auto" }}>
              <input
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                placeholder="name"
                style={{ padding: "8px 10px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 12, fontFamily: "var(--font-mono), monospace", outline: "none", minWidth: 0 }}
              />
              <input
                value={mcpCmd}
                onChange={(e) => setMcpCmd(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void addMcp(); }}
                placeholder="command, e.g. npx -y @modelcontextprotocol/server-github"
                style={{ padding: "8px 10px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 12, fontFamily: "var(--font-mono), monospace", outline: "none", minWidth: 0 }}
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
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  Servers that need API keys read them from the command&apos;s environment — include them as <span className="mono">KEY=value</span> via the box terminal if needed.
                </div>
              </div>
            </details>
            ) : null}
          </div>
          {toolsOpen ? (
            <ToolInstallPicker
              agentId={agent.id}
              boxUrl={agent.chat_url}
              token={agent.api_token}
              onClose={() => setToolsOpen(false)}
              onChanged={() => void refreshMcp()}
            />
          ) : null}
        </>
      ) : null}

      <HivraPrivateAccessPanel agentId={agent.id} />

      {/* RESIZE */}
      <section id="resources" style={{ scrollMarginTop: 24 }}>
      {providerComputer ? <ProviderResizePanel agent={agent} onChanged={onChanged} /> : preparedComputer ? (
        <>
          <div className="mono" style={{ ...label, marginBottom: 10 }}>Size</div>
          <div style={{ ...card, marginBottom: 20 }}>
            <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Fixed preview size</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
              This prepared {computerTemplate.name} computer uses {fmtNum(agent.cpu)} CPU / {fmtNum(agent.ram)} GB. Resize is not available for this retained preview, so Hivra will not offer a control that cannot be completed safely.
            </div>
          </div>
        </>
      ) : <>
      <div className="mono" style={{ ...label, marginBottom: 10 }}>Resources</div>
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
          Reserved CPU counts against your pool, but shared CPU scheduling does not provide dedicated physical cores or guaranteed performance. Reserved memory is the VM&apos;s protected balloon floor. Maximums are hard ceilings available only while the host has spare capacity.
        </div>
        {hasPlan ? (
          <PoolMeter
            planName={plan?.name}
            cpu={{ othersUsed: usedOtherCpu, selected: rcpu, total: poolCpu }}
            ram={{ othersUsed: usedOtherRam, selected: rram, total: poolRam }}
          />
        ) : null}
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0, 1fr)" }}>
          <fieldset aria-label="Reserved CPU" style={{ margin: 0, padding: 0, border: 0 }}>
            <legend className="mono" style={{ ...label, marginBottom: 7 }}><Cpu size={12} /> Reserved CPU</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {cpuOptions.map((n) => {
              const disabled = providerComputer || lifecyclePending || n < floor.cpu || n > capCpu;
              return (
                <button key={`c${n}`} type="button" disabled={disabled} aria-pressed={rcpu === n} onClick={() => { setRcpu(n); setMaximumCpu(current => Math.max(current, n)); }} style={{ border: "1px solid var(--etched-border)", background: rcpu === n ? "var(--gold-leaf)" : "transparent", color: rcpu === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} CPU</button>
              );
            })}
            </div>
          </fieldset>
          <fieldset aria-label="Maximum CPU" style={{ margin: 0, padding: 0, border: 0 }}>
            <legend className="mono" style={{ ...label, marginBottom: 7 }}><Cpu size={12} /> Maximum CPU</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {cpuOptions.filter(n => n >= rcpu).map((n) => {
                const disabled = lifecyclePending || n > maximumCapCpu;
                return <button key={`mc${n}`} type="button" disabled={disabled} aria-pressed={maximumCpu === n} onClick={() => setMaximumCpu(n)} style={{ border: "1px solid var(--etched-border)", background: maximumCpu === n ? "var(--gold-leaf)" : "transparent", color: maximumCpu === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} CPU</button>;
              })}
            </div>
          </fieldset>
          <fieldset aria-label="Reserved memory" style={{ margin: 0, padding: 0, border: 0 }}>
            <legend className="mono" style={{ ...label, marginBottom: 7 }}><MemoryStick size={12} /> Reserved memory</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {ramOptions.map((n) => {
              const disabled = providerComputer || lifecyclePending || n < floor.ram || n > capRam;
              return (
                <button key={`r${n}`} type="button" disabled={disabled} aria-pressed={rram === n} onClick={() => { setRram(n); setMaximumRam(current => Math.max(current, n)); }} style={{ border: "1px solid var(--etched-border)", background: rram === n ? "var(--gold-leaf)" : "transparent", color: rram === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} GB</button>
              );
            })}
            </div>
          </fieldset>
          <fieldset aria-label="Maximum memory" style={{ margin: 0, padding: 0, border: 0 }}>
            <legend className="mono" style={{ ...label, marginBottom: 7 }}><MemoryStick size={12} /> Maximum memory</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {ramOptions.filter(n => n >= rram).map((n) => {
                const disabled = lifecyclePending || n > maximumCapRam;
                return <button key={`mr${n}`} type="button" disabled={disabled} aria-pressed={maximumRam === n} onClick={() => setMaximumRam(n)} style={{ border: "1px solid var(--etched-border)", background: maximumRam === n ? "var(--gold-leaf)" : "transparent", color: maximumRam === n ? "var(--ink-black)" : disabled ? "var(--text-muted)" : "var(--text-secondary)", fontSize: 12, padding: "5px 11px", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-mono), monospace", opacity: disabled ? 0.35 : 1 }}>{fmtNum(n)} GB</button>;
              })}
            </div>
          </fieldset>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button type="button" disabled={busy || !canResize} onClick={() => { if (canResize) void run("resize", () => resizeAgent(agent.id, rcpu, rram, maximumCpu, maximumRam)); }} style={{ ...btnDark, background: canResize ? "var(--ink-black)" : "transparent", color: canResize ? "var(--bg-surface)" : "var(--text-muted)", cursor: busy || !canResize ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {acting === "resize" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : null}
            {dirty ? `Apply · ${fmtNum(rcpu)} CPU / ${fmtNum(rram)} GB reserved · ${fmtNum(maximumCpu)} CPU / ${fmtNum(maximumRam)} GB max` : "Apply"}
          </button>
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            {providerComputer ? `This agent uses its whole ${fmtNum(agent.cpu)} CPU / ${fmtNum(agent.ram)} GB cloud computer. Resizing allocated Hetzner computers through Hivra is not supported yet; the original size and data are retained.`
              : !budget.ready ? "Couldn’t verify your available Hivra Cloud capacity. Refresh before resizing."
              : budget.selfManaged ? `Your infrastructure — choose a size up to ${MAX_CPU} CPU / ${MAX_RAM} GB. Host capacity is checked before applying; your Hivra Cloud plan does not limit this computer.`
              : budget.fixedSize ? `This managed dashboard has a fixed ${fmtNum(capCpu)} CPU / ${fmtNum(capRam)} GB allocation. It uses an agent slot, not your compute pool.`
              : hasPlan
              ? poolFull
                ? `Your ${plan?.name} pool is fully used by your other agents — shrink another box to grow this one.`
                : `Min ${fmtNum(floor.cpu)} CPU / ${fmtNum(floor.ram)} GB · up to ${fmtNum(capCpu)} CPU / ${fmtNum(capRam)} GB for this box on ${plan?.name}.`
              : `Min for ${def?.name || "this agent"}: ${floor.cpu} CPU / ${floor.ram} GB · max ${MAX_CPU} / ${MAX_RAM} GB.`}
          </span>
          {!budget.ready ? <button type="button" style={btnGhost} onClick={onChanged}>Refresh capacity</button> : null}
        </div>
        {!providerComputer ? <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Resizing reboots the box (a brief reconnect; the chat reattaches automatically).</div> : null}
      </div>
      </>}
      </section>

      {/* DANGER ZONE */}
      <div className="mono" style={{ ...label, marginBottom: 10, color: "#c0623f" }}>Danger zone</div>
      <div style={{ border: "1px solid rgba(192,57,43,0.4)", background: "rgba(192,57,43,0.04)", padding: 18, display: "grid", gap: 14, gridTemplateColumns: "minmax(0, 1fr)" }}>
        {!confirming ? (
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Destroy this box</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 3 }}>
                {isComputerOnly
                  ? "Permanently deletes this computer and everything on it — files and local logins. This cannot be undone."
                  : "Permanently deletes the agent and everything on it — chats, files, logins. This cannot be undone."}
              </div>
              {agent.computer_substrate === "provider-vm" && <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 6 }}>This is a dedicated cloud computer. Removal also deletes its original Hetzner server, IPs, setup firewall and SSH key. Billing may continue until resource removal is verified.</div>}
            </div>
            <button type="button" onClick={() => { setConfirming(true); setAck(false); setTyped(""); }} style={{ border: "1px solid #c0392b", background: "transparent", color: "#e06c5a", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, padding: "9px 14px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}>
              <Trash2 size={14} /> Destroy
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 9 }}>
              <AlertTriangle size={18} style={{ color: "#e06c5a", flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 13, color: "var(--ink-black)", lineHeight: 1.55 }}>
                This will <strong>permanently destroy</strong> <span className="mono" style={{ color: "#c0623f" }}>{agent.name}</span> and wipe its disk. Anything not saved elsewhere is gone for good.
                {agent.computer_substrate === "provider-vm" && <p style={{ margin: "8px 0 0" }}>This also deletes its original Hetzner server, IPs, setup firewall and SSH key. Billing may continue until resource removal is verified.</p>}
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12.5, color: "var(--text-secondary)", cursor: "pointer", lineHeight: 1.5 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2, accentColor: "#c0392b" }} />
              I understand this is irreversible and deletes all data on the box.
            </label>
            <div>
              <div className="mono" style={{ ...label, marginBottom: 6 }}>Type <span style={{ color: "#c0623f" }}>{agent.name}</span> to confirm</div>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={agent.name} autoFocus style={{ width: "100%", padding: "9px 12px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 13, fontFamily: "var(--font-mono), monospace", outline: "none" }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                disabled={busy || !ack || typed.trim() !== agent.name}
                onClick={() => void run("destroy", async () => {
                  const controller = new AbortController(); deletionController.current = controller;
                  setDeletionProgress("Checking the original computer and removal operation…");
                  try {
                    await deleteAgent(agent.id, { signal: controller.signal,
                      onProgress: message => { if (!controller.signal.aborted) setDeletionProgress(message); } });
                    if (!controller.signal.aborted) onDestroyed();
                  } finally { if (deletionController.current === controller) deletionController.current = null; }
                })}
                style={{ border: "1px solid #c0392b", background: ack && typed.trim() === agent.name ? "#c0392b" : "transparent", color: ack && typed.trim() === agent.name ? "#fff" : "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, padding: "10px 16px", cursor: busy || !ack || typed.trim() !== agent.name ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}
              >
                {acting === "destroy" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={14} />} Permanently destroy
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)} style={{ ...btnGhost, cursor: "pointer" }}>Cancel</button>
            </div>
            {acting === "destroy" && deletionProgress && <p role="status" style={{ color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>{deletionProgress}</p>}
          </>
        )}
      </div>

      {/* WHAT THIS IS — plain-language, trademark-safe hosting disclaimer (footer) */}
      {def || computerTemplate ? (
        <>
          <div className="mono" style={{ ...label, margin: "26px 0 10px" }}>What this is</div>
          <div style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.02)", padding: 16, display: "flex", gap: 11, alignItems: "flex-start", boxSizing: "border-box" }}>
            <ShieldCheck size={16} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6, minWidth: 0 }}>{computerTemplate ? computerHostingDisclaimer(computerTemplate) : hostingDisclaimer(def!, agent.deployment_mode === "self-managed" ? "self-managed" : "hivra-managed")}</div>
          </div>
        </>
      ) : null}
    </div>
  );
}
