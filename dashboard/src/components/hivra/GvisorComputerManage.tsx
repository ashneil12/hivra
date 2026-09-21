"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Play, Square, TerminalSquare, Trash2 } from "lucide-react";
import { ManageLayout, ManagePanel, useManageSection, manageStyles, type ManageSection } from "./ManageLayout";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { gvisorIsolationDisclosure } from "@/lib/hivra/gvisor-computer-contract";

type Observation = { state: "running" | "stopped" | "absent"; cpu?: number; memoryMb?: number; adapterVersion?: string;
  isolationClass?: "application-kernel"; isolationDriver?: "gvisor-runsc"; outerHostBoundary?: "operator-owned-host";
  reservationEqualsMaximum?: true; publicPorts?: never[] };

const box: React.CSSProperties = { border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)", padding: 18,
  display: "grid", gap: 14, marginBottom: 20 };
const button: React.CSSProperties = { border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)",
  padding: "9px 14px", display: "inline-flex", gap: 7, alignItems: "center", fontSize: 11, fontWeight: 700 };
const label: React.CSSProperties = { fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)", marginBottom: 10 };

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: Record<string, unknown> } | null;
  if (!response.ok || payload?.success !== true) throw new Error(payload?.error || `Computer request failed (${response.status})`);
  return payload.data ?? {};
}

export function GvisorComputerManage({ agent, onChanged, onDestroyed }: { agent: HivraAgent; onChanged: () => void; onDestroyed: () => void }) {
  const [observation, setObservation] = useState<Observation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cpu, setCpu] = useState(agent.cpu);
  const [ram, setRam] = useState(agent.ram);
  const [command, setCommand] = useState("python --version && id && pwd && ls -la");
  const [commandResult, setCommandResult] = useState<{ exitCode: number; stdout: string; stderr: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sections: ManageSection[] = ["overview", "resources", "access", "advanced"];
  const { selected, select } = useManageSection(sections);
  const [deleteName, setDeleteName] = useState("");
  const disclosure = gvisorIsolationDisclosure();

  const refresh = useCallback(async () => {
    try {
      const data = await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/gvisor`);
      setObservation(data.observation as Observation); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Computer status could not be checked."); }
  }, [agent.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setCpu(agent.cpu); setRam(agent.ram); }, [agent.cpu, agent.ram]);

  const mutate = async (action: "start" | "stop" | "resize" | "delete") => {
    setBusy(action); setError(null);
    try {
      await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/action`, { method: "POST",
        body: JSON.stringify(action === "resize" ? { action, cpu, ram, maximumCpu: cpu, maximumRam: ram } : { action }) });
      if (action === "delete") { onDestroyed(); return; }
      await refresh(); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Computer operation failed."); }
    finally { setBusy(null); }
  };

  const execute = async () => {
    if (!command.trim()) return;
    setBusy("exec"); setError(null); setCommandResult(null);
    try {
      const argv = ["/bin/sh", "-lc", command.trim()];
      const data = await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/gvisor/exec`, { method: "POST", body: JSON.stringify({ argv }) });
      setCommandResult(data.result as typeof commandResult);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Command failed."); }
    finally { setBusy(null); }
  };

  return <ManageLayout sections={sections} selected={selected} onSelect={select}
    header={<><span className={manageStyles.eyebrow}>Computer settings · gVisor sandbox</span><strong className={manageStyles.title}>{agent.name}</strong>
      <div className={manageStyles.identity}><span className={manageStyles.status}>{observation?.state ?? "Status unknown"}</span><span>Your infrastructure</span></div></>}
    notice={<>{error ? <div role="alert" style={{ ...box, color: "#e06c5a" }}><AlertTriangle size={15} />{error}</div> : null}
      {busy ? <p role="status"><Loader2 size={14} /> Confirming {busy}…</p> : null}</>}>
    <ManagePanel section="overview" selected={selected}>
    <h2 className={manageStyles.title}>Your sandbox, at a glance</h2>
    <p className={manageStyles.description}>Power and terminal access to your private workspace.</p>
    <div className={manageStyles.metrics}><div className={manageStyles.metric}><span className={manageStyles.eyebrow}>CPU limit</span><strong>{agent.cpu} <small>CPU</small></strong></div><div className={manageStyles.metric}><span className={manageStyles.eyebrow}>Memory limit</span><strong>{agent.ram} <small>GB</small></strong></div></div>
    <div style={label}>Power</div>
    <section style={box}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {observation?.state === "stopped" ? <button style={button} disabled={Boolean(busy)} onClick={() => void mutate("start")}><Play size={14} />Start</button>
          : <button style={button} disabled={Boolean(busy) || observation?.state !== "running"} onClick={() => void mutate("stop")}><Square size={14} />Stop</button>}
        <button style={button} disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
      </div>
    </section>

    <div style={label}>Terminal command</div>
    <section style={box}>
      <label>Command<textarea aria-label="Terminal command" value={command} onChange={event => setCommand(event.target.value)}
        rows={5} maxLength={4096} style={{ width: "100%", boxSizing: "border-box", padding: 12, marginTop: 8, background: "var(--bg-surface)", border: "1px solid var(--etched-border)", color: "var(--ink-black)", fontFamily: "var(--font-mono), monospace", fontSize: 12 }} /></label>
      <small>Python 3.13 and a POSIX shell are available. Commands run as a non-root user in the private persistent /workspace directory, with a 60-second limit and bounded output.</small>
      <button style={button} disabled={Boolean(busy) || observation?.state !== "running" || !command.trim()} onClick={() => void execute()}>
        <TerminalSquare size={14} />Run in /workspace</button>
      {commandResult ? <div><div>Exit {commandResult.exitCode}</div><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 260, overflow: "auto" }}>{commandResult.stdout}{commandResult.stderr}</pre></div> : null}
    </section>

    </ManagePanel>
    <ManagePanel section="access" selected={selected}><h2 className={manageStyles.title}>Sandbox access</h2><p className={manageStyles.description}>Use the terminal on Overview to work in /workspace. This sandbox has no desktop or public port access.</p>    <div style={label}>Isolation</div>
    <section style={box}>
      <strong>{disclosure.title}</strong><span>{disclosure.boundary}</span>
      <span>Driver: gVisor runsc · Class: application-kernel · Outer host: operator-owned</span>
      <span>No public ports, host mounts, host namespaces, devices, Docker socket, or privileged mode.</span>
    </section>

</ManagePanel>
    <ManagePanel section="resources" selected={selected}>
    <h2 className={manageStyles.title}>Resource limits</h2><p className={manageStyles.description}>Set the CPU and memory this sandbox can use.</p>
    <section id="resources" style={box}>
      <span>gVisor uses enforced cgroup limits. Reserved and maximum values are identical for this driver.</span>
      <label className={manageStyles.limitField}>CPU limit<select aria-label="CPU limit" value={cpu} onChange={event => setCpu(Number(event.target.value))}>
        {[0.5, 1, 2, 4, 8].map(value => <option key={value} value={value}>{value} CPU</option>)}</select></label>
      <label className={manageStyles.limitField}>Memory limit<select aria-label="Memory limit" value={ram} onChange={event => setRam(Number(event.target.value))}>
        {[1, 2, 4, 8, 16].map(value => <option key={value} value={value}>{value} GB</option>)}</select></label>
      <button style={button} disabled={Boolean(busy) || (cpu === agent.cpu && ram === agent.ram)} onClick={() => void mutate("resize")}>Apply limits</button>
    </section>

    </ManagePanel>
    <ManagePanel section="advanced" selected={selected}>
    <h2 className={manageStyles.title}>Advanced</h2><p className={manageStyles.description}>Permanently remove this sandbox and its workspace.</p>
    <div style={{ ...label, color: "#c0623f" }}>Danger zone</div>
    <section style={box}>
      <span>Delete removes this sandbox and its private workspace volume. It does not alter the connected host or other computers.</span>
      {!confirmDelete ? <button style={button} disabled={Boolean(busy)} onClick={() => { setDeleteName(""); setConfirmDelete(true); }}><Trash2 size={14} />Delete sandbox</button>
        : <div style={{ display: "grid", gap: 12 }}><label>Type {agent.name} to confirm<input aria-label="Sandbox name confirmation" value={deleteName} onChange={event => setDeleteName(event.target.value)} style={{ display: "block", width: "100%", marginTop: 8, padding: 10 }} /></label><button style={{ ...button, color: "#e06c5a" }} disabled={Boolean(busy) || deleteName.trim() !== agent.name} onClick={() => void mutate("delete")}>Confirm permanent deletion</button>
          <button style={button} disabled={Boolean(busy)} onClick={() => setConfirmDelete(false)}>Cancel</button></div>}
    </section>
    </ManagePanel>
  </ManageLayout>;
}
