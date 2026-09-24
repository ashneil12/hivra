"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Play, Square, TerminalSquare, Trash2 } from "lucide-react";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { gvisorIsolationDisclosure } from "@/lib/hivra/gvisor-computer-contract";
import { ComputerAgentSlot } from "./ComputerContractPanel";

type Observation = { state: "running" | "stopped" | "absent"; cpu?: number; memoryMb?: number; adapterVersion?: string;
  isolationClass?: "application-kernel"; isolationDriver?: "gvisor-runsc"; outerHostBoundary?: "operator-owned-host";
  reservationEqualsMaximum?: true; publicPorts?: never[] };

const box: React.CSSProperties = { border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)", padding: 18,
  display: "grid", gap: 14, marginBottom: 20 };
const button: React.CSSProperties = { border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)",
  padding: "9px 14px", minHeight: 40, display: "inline-flex", gap: 7, alignItems: "center", fontSize: 11, fontWeight: 700 };
const field: React.CSSProperties = { display: "grid", gap: 6 };
const control: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid var(--etched-border)",
  borderRadius: 0, background: "var(--bg-surface)", color: "var(--ink-black)" };
// A double tap on "Delete sandbox" must not also land on the confirm button.
const CONFIRM_ARM_MS = 600;
const label: React.CSSProperties = { fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)", marginBottom: 10 };
const errorStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid #c0392b",
  background: "rgba(192,57,43,0.08)", color: "#e06c5a", fontSize: 12.5, padding: "9px 13px", fontFamily: "var(--font-mono), monospace",
  lineHeight: 1.5, overflowWrap: "anywhere" };

type Section = "computer" | "terminal" | "resources" | "danger";
const ACTION_SECTION: Record<"start" | "stop" | "resize" | "delete", Section> = { start: "computer", stop: "computer", resize: "resources", delete: "danger" };

// Shown under the control that failed and scrolled into view, so it never covers a field.
function SectionError({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [message]);
  return <div ref={ref} role="alert" style={errorStyle}><AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /><span>{message}</span></div>;
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: Record<string, unknown> } | null;
  if (!response.ok || payload?.success !== true) throw new Error(payload?.error || `Computer request failed (${response.status})`);
  return payload.data ?? {};
}

export function GvisorComputerManage({ agent, onChanged, onDestroyed }: { agent: HivraAgent; onChanged: () => void; onDestroyed: () => void }) {
  const [observation, setObservation] = useState<Observation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ section: Section; message: string } | null>(null);
  const [cpu, setCpu] = useState(agent.cpu);
  const [ram, setRam] = useState(agent.ram);
  const [command, setCommand] = useState("python --version && id && pwd && ls -la");
  const [commandResult, setCommandResult] = useState<{ exitCode: number; stdout: string; stderr: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmShownAt = useRef(0);
  const disclosure = gvisorIsolationDisclosure();
  const errorFor = (section: Section) => (error?.section === section ? <SectionError message={error.message} /> : null);

  const refresh = useCallback(async () => {
    try {
      const data = await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/gvisor`);
      setObservation(data.observation as Observation); setError(null);
    } catch (cause) { setError({ section: "computer", message: cause instanceof Error ? cause.message : "Computer status could not be checked." }); }
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
    } catch (cause) { setError({ section: ACTION_SECTION[action], message: cause instanceof Error ? cause.message : "Computer operation failed." }); }
    finally { setBusy(null); }
  };

  const execute = async () => {
    if (!command.trim()) return;
    setBusy("exec"); setError(null); setCommandResult(null);
    try {
      const argv = ["/bin/sh", "-lc", command.trim()];
      const data = await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/gvisor/exec`, { method: "POST", body: JSON.stringify({ argv }) });
      setCommandResult(data.result as typeof commandResult);
    } catch (cause) { setError({ section: "terminal", message: cause instanceof Error ? cause.message : "Command failed." }); }
    finally { setBusy(null); }
  };

  return <div style={{ width: "100%", maxWidth: 620, margin: "0 auto", padding: "clamp(20px, 5vw, 36px) clamp(14px, 4vw, 20px)",
    height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
    <div style={label}>Computer</div>
    <section style={box}>
      <strong style={{ fontSize: 19 }}>{agent.name}</strong>
      <span>{observation?.state ?? agent.status} · {agent.cpu} CPU · {agent.ram} GB</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {observation?.state === "stopped" ? <button style={button} disabled={Boolean(busy)} onClick={() => void mutate("start")}><Play size={14} />Start</button>
          : <button style={button} disabled={Boolean(busy) || observation?.state !== "running"} onClick={() => void mutate("stop")}><Square size={14} />Stop</button>}
        <button style={button} disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
        {busy ? <span role="status"><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Confirming {busy}…</span> : null}
      </div>
      {errorFor("computer")}
    </section>

    <ComputerAgentSlot />

    <div style={label}>Isolation</div>
    <section style={box}>
      <strong>{disclosure.title}</strong><span>{disclosure.boundary}</span>
      <span>Driver: gVisor runsc · Class: application-kernel · Outer host: operator-owned</span>
      <span>No public ports, host mounts, host namespaces, devices, Docker socket, or privileged mode.</span>
    </section>

    <div style={label}>Terminal command</div>
    <section style={box}>
      <label style={field}>Command<textarea aria-label="Terminal command" value={command} onChange={event => setCommand(event.target.value)}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        rows={5} maxLength={4096} style={{ ...control, fontFamily: "var(--font-mono), monospace" }} /></label>
      <small>Python 3.13 and a POSIX shell are available. Commands run as a non-root user in the private persistent /workspace directory, with a 60-second limit and bounded output.</small>
      <button style={button} disabled={Boolean(busy) || observation?.state !== "running" || !command.trim()} onClick={() => void execute()}>
        <TerminalSquare size={14} />Run in /workspace</button>
      {errorFor("terminal")}
      {commandResult ? <div><div>Exit {commandResult.exitCode}</div><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 260, overflow: "auto" }}>{commandResult.stdout}{commandResult.stderr}</pre></div> : null}
    </section>

    <div style={label}>Resources</div>
    <section id="resources" style={box}>
      <span>gVisor uses enforced cgroup limits. Reserved and maximum values are identical for this driver.</span>
      <label style={field}>CPU limit<select aria-label="CPU limit" value={cpu} onChange={event => setCpu(Number(event.target.value))} style={{ ...control, minHeight: 44 }}>
        {[0.5, 1, 2, 4, 8].map(value => <option key={value} value={value}>{value} CPU</option>)}</select></label>
      <label style={field}>Memory limit<select aria-label="Memory limit" value={ram} onChange={event => setRam(Number(event.target.value))} style={{ ...control, minHeight: 44 }}>
        {[1, 2, 4, 8, 16].map(value => <option key={value} value={value}>{value} GB</option>)}</select></label>
      <button style={button} disabled={Boolean(busy) || (cpu === agent.cpu && ram === agent.ram)} onClick={() => void mutate("resize")}>Apply limits</button>
      {errorFor("resources")}
    </section>

    <div style={{ ...label, color: "#c0623f" }}>Danger zone</div>
    <section style={box}>
      <span>Delete removes this sandbox and its private workspace volume. It does not alter the connected host or other computers.</span>
      {/* Cancel takes the Delete button's position; the red confirm comes second. */}
      {!confirmDelete ? <button style={button} disabled={Boolean(busy)} onClick={() => { confirmShownAt.current = Date.now(); setConfirmDelete(true); }}><Trash2 size={14} />Delete sandbox</button>
        : <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button style={button} disabled={Boolean(busy)} onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button style={{ ...button, color: "#e06c5a", borderColor: "rgba(192,57,43,0.5)" }} disabled={Boolean(busy)}
            onClick={() => { if (Date.now() - confirmShownAt.current >= CONFIRM_ARM_MS) void mutate("delete"); }}>Confirm permanent deletion</button></div>}
      {errorFor("danger")}
    </section>
  </div>;
}
