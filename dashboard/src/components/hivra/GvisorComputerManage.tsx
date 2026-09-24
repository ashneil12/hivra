"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Play, Square, TerminalSquare } from "lucide-react";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { gvisorIsolationDisclosure } from "@/lib/hivra/gvisor-computer-contract";
import { COMPUTER_PLACEMENT_LABEL, computerPlacementFor } from "@/lib/agent-computers/agent-surfaces";
import type { ManageSectionId } from "@/lib/hivra/manage-sections";
import { ComputerAgentSlot } from "./ComputerContractPanel";
import { ManageLayout, ManageNotice, ManagePanel } from "./ManageLayout";
import { useManageSection } from "./useManageSection";
import { ManageHeader } from "./manage/ManageHeader";
import { ManageDangerZone } from "./manage/ManageDangerZone";
import { ManageDetails, ManageHistory, ManageNotAvailable } from "./manage/ManageAdvancedParts";

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
// A double tap on Destroy must not also land on the confirm button.
const CONFIRM_ARM_MS = 600;
const label: React.CSSProperties = { fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)", marginBottom: 10 };
const errorStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid #c0392b",
  background: "rgba(192,57,43,0.08)", color: "#e06c5a", fontSize: 12.5, padding: "9px 13px", fontFamily: "var(--font-mono), monospace",
  lineHeight: 1.5, overflowWrap: "anywhere" };

type Slot = "header" | "computer" | "terminal" | "resources" | "danger";
const SLOT_SECTION: Record<Slot, ManageSectionId | null> = { header: null, computer: "overview", terminal: "command", resources: "resources", danger: "advanced" };
const ACTION_SLOT: Record<"start" | "stop" | "resize" | "delete" | "rename", Slot> = { start: "computer", stop: "computer", resize: "resources", delete: "danger", rename: "header" };
const FALLBACK_SECTIONS: ManageSectionId[] = ["overview", "resources", "command", "advanced"];

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

/** Manage for a Linux Sandbox (gVisor): the shared sections, with its own one-shot command runner. */
export function GvisorComputerManage({ agent, onChanged, onDestroyed }: { agent: HivraAgent; onChanged: () => void; onDestroyed: () => void }) {
  const [observation, setObservation] = useState<Observation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ slot: Slot; message: string } | null>(null);
  const [cpu, setCpu] = useState(agent.cpu);
  const [ram, setRam] = useState(agent.ram);
  const [command, setCommand] = useState("python --version && id && pwd && ls -la");
  const [commandResult, setCommandResult] = useState<{ exitCode: number; stdout: string; stderr: string } | null>(null);
  const disclosure = gvisorIsolationDisclosure();
  const manage = agent.manage;
  const sections = manage?.sections ?? FALLBACK_SECTIONS;
  const { selected, select } = useManageSection(sections, Boolean(manage));
  const errorFor = (slot: Slot) => (error?.slot === slot ? <SectionError message={error.message} /> : null);
  const placement = manage?.placement.label ?? COMPUTER_PLACEMENT_LABEL[computerPlacementFor(agent)];

  const refresh = useCallback(async () => {
    try {
      const data = await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/gvisor`);
      setObservation(data.observation as Observation); setError(null);
    } catch (cause) { setError({ slot: "computer", message: cause instanceof Error ? cause.message : "Computer status could not be checked." }); }
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
    } catch (cause) { setError({ slot: ACTION_SLOT[action], message: cause instanceof Error ? cause.message : "Computer operation failed." }); }
    finally { setBusy(null); }
  };

  const rename = async (name: string) => {
    setBusy("rename"); setError(null);
    try {
      await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/action`, { method: "POST", body: JSON.stringify({ action: "rename", name }) });
      onChanged();
    } catch (cause) { setError({ slot: "header", message: cause instanceof Error ? cause.message : "The name could not be changed." }); }
    finally { setBusy(null); }
  };

  const execute = async () => {
    if (!command.trim()) return;
    setBusy("exec"); setError(null); setCommandResult(null);
    try {
      const argv = ["/bin/sh", "-lc", command.trim()];
      const data = await jsonRequest(`/api/hivra/agents/${encodeURIComponent(agent.id)}/gvisor/exec`, { method: "POST", body: JSON.stringify({ argv }) });
      setCommandResult(data.result as typeof commandResult);
    } catch (cause) { setError({ slot: "terminal", message: cause instanceof Error ? cause.message : "Command failed." }); }
    finally { setBusy(null); }
  };

  const errorSection = error ? SLOT_SECTION[error.slot] : null;
  const dirty = cpu !== agent.cpu || ram !== agent.ram;
  const state = observation?.state ?? agent.status;

  return (
    <ManageLayout
      label="Computer settings"
      sections={sections.map((id) => ({ id, unsaved: id === "resources" && dirty }))}
      selected={selected}
      onSelect={select}
      notice={error && errorSection && errorSection !== selected
        ? <ManageNotice kind="alert" message={error.message} section={errorSection} onOpen={select} /> : null}
      header={
        <ManageHeader
          eyebrow="Computer settings"
          name={agent.name}
          status={state === "absent" ? "error" : state}
          statusLabel={state}
          subtitle={`Linux Sandbox · ${placement}`}
          renaming={busy === "rename"}
          disabled={Boolean(busy)}
          onRename={(name) => void rename(name)}
          error={errorFor("header")}
        />
      }
    >
      <ManagePanel id="overview" selected={selected}>
        <div style={label}>Computer</div>
        <section style={box}>
          <span>{state} · {agent.cpu} CPU · {agent.ram} GB</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {observation?.state === "stopped" ? <button style={button} disabled={Boolean(busy)} onClick={() => void mutate("start")}><Play size={14} />Start</button>
              : <button style={button} disabled={Boolean(busy) || observation?.state !== "running"} onClick={() => void mutate("stop")}><Square size={14} />Stop</button>}
            <button style={button} disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh</button>
            {busy && busy !== "rename" ? <span role="status"><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Confirming {busy}…</span> : null}
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
      </ManagePanel>

      <ManagePanel id="resources" selected={selected}>
        <section id="resources" style={box}>
          <span>gVisor uses enforced cgroup limits. Reserved and maximum values are identical for this driver.</span>
          <label style={field}>CPU limit<select aria-label="CPU limit" value={cpu} onChange={event => setCpu(Number(event.target.value))} style={{ ...control, minHeight: 44 }}>
            {[0.5, 1, 2, 4, 8].map(value => <option key={value} value={value}>{value} CPU</option>)}</select></label>
          <label style={field}>Memory limit<select aria-label="Memory limit" value={ram} onChange={event => setRam(Number(event.target.value))} style={{ ...control, minHeight: 44 }}>
            {[1, 2, 4, 8, 16].map(value => <option key={value} value={value}>{value} GB</option>)}</select></label>
          <button style={button} disabled={Boolean(busy) || !dirty} onClick={() => void mutate("resize")}>Apply limits</button>
          {errorFor("resources")}
        </section>
      </ManagePanel>

      <ManagePanel id="command" selected={selected}>
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
      </ManagePanel>

      <ManagePanel id="advanced" selected={selected}>
        <div style={{ display: "grid", gap: 20 }}>
          {manage ? <section style={{ ...box, marginBottom: 0 }}><ManageDetails details={manage.details} /></section> : null}
          <ManageHistory agentId={agent.id} />
          <ManageNotAvailable items={manage?.notAvailable ?? []} />
          <ManageDangerZone
            name={agent.name}
            title="Destroy this sandbox"
            description="Delete removes this sandbox and its private workspace volume. It does not alter the connected host or other computers."
            busy={Boolean(busy)}
            deleting={busy === "delete"}
            armDelayMs={CONFIRM_ARM_MS}
            onConfirm={() => void mutate("delete")}
            error={errorFor("danger")}
          />
        </div>
      </ManagePanel>
    </ManageLayout>
  );
}
