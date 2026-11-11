"use client";

// Manage: let your agents run a command on your own computer, with your OK.
// Shows the commands agents are waiting to run (the agent, the computer, the
// exact command and the folder) with Approve, Deny and "Allow any command
// from this agent for 1 hour", the allowances in force with End, and the computers you set up with
// Revoke. Setting up a computer shows its bridge settings once. Nothing shows
// where the bridge isn't offered: the server answers 404 while
// HIVRA_LOCAL_BRIDGE_ENABLED is off, and the `enabled` prop can also hide it.

import { useCallback, useEffect, useState } from "react";
import { Laptop, Loader2, RefreshCw } from "lucide-react";

import styles from "./ComputerAgentsPanel.module.css";

/** While a request waits for you, read again this often. */
export const BRIDGE_POLL_MS = 5_000;

type BridgeRequestView = {
  id: string; agentId: string; computerId: string; argv: string[]; cwd: string | null; status: string;
  createdAt: string; expiresAt: string; hasResult?: boolean;
};
type BridgeResult = { stdout?: string; stderr?: string; exitCode?: number | null; truncated?: boolean; message?: string };
type BridgeView = {
  computers: { id: string; name: string; revoked: boolean }[];
  agents: { id: string; name: string }[];
  requests: BridgeRequestView[];
  allowances: { agentId: string; computerId: string; expiresAt: string }[];
};
type Load = { state: "loading" } | { state: "not_offered" } | { state: "unavailable"; message: string } | { state: "ready"; view: BridgeView };
type Enrolled = { computerName: string; config: Record<string, unknown> };

const API = "/api/hivra/bridge";

const UNUSUAL = /[\p{C}\p{Z}]/gu;

/** Shows control, format (invisible), separator and other non-ASCII-space characters as \uXXXX, so they cannot hide. */
export function escapeUnusual(text: string): string {
  return text.replace(UNUSUAL, (char) => {
    if (char === " ") return char;
    const code = char.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export function hasUnusual(...texts: string[]): boolean {
  return texts.some((text) => escapeUnusual(text) !== text);
}

/** The exact command, each argument quoted when it needs it, with unusual characters made visible. */
export function commandLine(argv: string[]): string {
  return argv.map((arg) => (arg !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : escapeUnusual(JSON.stringify(arg)))).join(" ");
}

async function post(body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
  try {
    const response = await fetch(API, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: Record<string, unknown>; error?: string } | null;
    if (!response.ok || !payload?.success) return { ok: false, message: payload?.error || "That didn't work. Try again." };
    return { ok: true, data: payload.data ?? {} };
  } catch {
    return { ok: false, message: "That didn't work. Try again." };
  }
}

async function load(): Promise<Load> {
  try {
    const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
    if (response.status === 404) return { state: "not_offered" };
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: BridgeView; error?: string } | null;
    if (!response.ok || !payload?.success || !payload.data) return { state: "unavailable", message: payload?.error || "Couldn't load the bridge." };
    // A request past its time can no longer be approved; the server marks it expired too.
    const now = Date.now();
    const requests = payload.data.requests.map((request) => request.status === "pending" && Date.parse(request.expiresAt) <= now ? { ...request, status: "expired" } : request);
    return { state: "ready", view: { ...payload.data, requests } };
  } catch {
    return { state: "unavailable", message: "Couldn't load the bridge." };
  }
}

export function LocalBridgePanel({ enabled = true }: { enabled?: boolean }) {
  const [state, setState] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState<Enrolled | null>(null);
  const [label, setLabel] = useState("");
  const [outputs, setOutputs] = useState<Record<string, BridgeResult | null>>({});

  const refresh = useCallback(async () => { setState(await load()); }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void load().then((result) => { if (alive) setState(result); });
    return () => { alive = false; };
  }, [enabled]);

  const waiting = state.state === "ready" && state.view.requests.some((request) => request.status === "pending");
  useEffect(() => {
    if (!enabled || !waiting) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, BRIDGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, waiting, refresh]);

  if (!enabled || state.state === "not_offered") return null;
  if (state.state === "loading") {
    return <section className={styles.section} aria-busy="true"><p className={styles.note}><Loader2 size={13} aria-hidden /> Loading…</p></section>;
  }
  if (state.state === "unavailable") {
    return <section className={styles.section}><p className={styles.note} role="status">{state.message}</p>
      <div className={styles.actions}><button type="button" className={styles.button} onClick={() => void refresh()}><RefreshCw size={13} aria-hidden /> Try again</button></div></section>;
  }

  const { computers, agents, requests, allowances } = state.view;
  const agentName = (id: string) => escapeUnusual(agents.find((agent) => agent.id === id)?.name ?? "An agent");
  const computerName = (id: string) => escapeUnusual(computers.find((computer) => computer.id === id)?.name ?? "your computer");
  // (A request past its time is already shown as expired: see load().)
  const pending = requests.filter((request) => request.status === "pending");
  const recent = requests.filter((request) => request.status !== "pending").slice(0, 5);

  async function act(body: Record<string, unknown>) {
    setBusy(true); setError(null);
    const result = await post(body);
    setBusy(false);
    if (!result.ok) setError(result.message);
    await refresh();
    return result;
  }
  async function showOutput(id: string) {
    try {
      const response = await fetch(`${API}?request=${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: { result: BridgeResult | null } } | null;
      setOutputs((current) => ({ ...current, [id]: response.ok && payload?.success ? payload.data?.result ?? null : null }));
    } catch {
      setOutputs((current) => ({ ...current, [id]: null }));
    }
  }
  async function enroll(computerId?: string) {
    const result = await act(computerId ? { action: "enroll", computerId } : { action: "enroll", label: label.trim() || "My computer" });
    if (result.ok) {
      const data = result.data as { computer?: { name?: string }; config?: Record<string, unknown> };
      setEnrolled({ computerName: data.computer?.name ?? "your computer", config: data.config ?? {} });
      setLabel("");
    }
  }

  return <section className={styles.section} aria-labelledby="local-bridge-heading">
    <h3 id="local-bridge-heading" className={styles.heading}>Let your agents run commands on your own computer</h3>
    <div className={styles.panel}>
      <p className={styles.body}>
        An agent can ask to run one command on a computer you set up here. Nothing runs until you approve it. It runs as you, and it can
        read and change anything you can on that computer. The folders you list there only set where a command starts; they are not a sandbox.
        Stop the bridge program, or Revoke it here, to turn it off.
      </p>
      {error ? <p className={styles.note} role="alert">{error}</p> : null}

      {pending.length > 0 ? <ul className={styles.rows} aria-label="Waiting for your OK">
        {pending.map((request) => <li key={request.id} className={styles.row}>
          <p className={styles.body}><strong>{agentName(request.agentId)}</strong> wants to run this on <strong>{computerName(request.computerId)}</strong>:</p>
          <pre className={styles.note} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{commandLine(request.argv)}</pre>
          <p className={styles.note}>Starts in: {request.cwd === null ? "the first folder you listed on that computer" : escapeUnusual(request.cwd)}</p>
          {hasUnusual(...request.argv, request.cwd ?? "") ? <p className={styles.note} role="alert">This command has unusual characters, shown as {"\\uXXXX"}. Check it carefully before you approve it.</p> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ action: "decide", requestId: request.id, decision: "approve" })}>Approve</button>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => void act({ action: "decide", requestId: request.id, decision: "deny" })}>Deny</button>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void act({ action: "decide", requestId: request.id, decision: "allow_hour" })}>Allow any command from this agent for 1 hour</button>
          </div>
        </li>)}
      </ul> : <p className={styles.note}>No commands are waiting for your OK.</p>}

      {allowances.length > 0 ? <ul className={styles.rows} aria-label="Allowed for now">
        {allowances.map((allowance) => <li key={`${allowance.agentId}|${allowance.computerId}`} className={styles.rowHead}>
          <span className={styles.body}><strong>{agentName(allowance.agentId)}</strong> can run any command on {computerName(allowance.computerId)}, without asking, until {new Date(allowance.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. That includes anything you can read or change there.</span>
          <button type="button" className={styles.button} disabled={busy} aria-label={`End ${agentName(allowance.agentId)}'s hour`}
            onClick={() => void act({ action: "end_allowance", agentId: allowance.agentId, computerId: allowance.computerId })}>End</button>
        </li>)}
      </ul> : null}

      <ul className={styles.rows} aria-label="Your computers">
        {computers.map((computer) => <li key={computer.id} className={styles.rowHead}>
          <span className={styles.agentRow}><Laptop size={16} aria-hidden /><span><strong>{computer.name}</strong>
            <span className={styles.note}>{computer.revoked ? " · revoked. Set it up again to use it." : ""}</span></span></span>
          <span className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} aria-label={`New settings for ${computer.name}`} onClick={() => void enroll(computer.id)}>New settings</button>
            <button type="button" className={styles.danger} disabled={busy || computer.revoked} aria-label={`Revoke ${computer.name}`}
              onClick={() => void act({ action: "revoke", computerId: computer.id })}>Revoke</button>
          </span>
        </li>)}
      </ul>

      <div className={styles.actions}>
        <input aria-label="Computer name" placeholder="Name this computer" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)}
          style={{ minHeight: 40, padding: "0 10px", border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)" }} />
        <button type="button" className={styles.button} disabled={busy} onClick={() => void enroll()}>Set up a computer</button>
      </div>

      {enrolled ? <div className={styles.contract} role="region" aria-label="Bridge settings">
        <p className={styles.body}>Settings for <strong>{enrolled.computerName}</strong>. They are shown only now: save them as <code>~/.config/hivra-bridge/config.json</code> (mode 600), add <code>&quot;allowedFolders&quot;: [&quot;/the/folders/you/allow&quot;]</code>, then run the bridge.</p>
        <pre className={styles.note} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{JSON.stringify(enrolled.config, null, 2)}</pre>
        <pre className={styles.note} style={{ margin: 0 }}>python3 hivra_bridge.py run --config ~/.config/hivra-bridge/config.json</pre>
        <div className={styles.actions}><button type="button" className={styles.button} onClick={() => setEnrolled(null)}>I saved them</button></div>
      </div> : null}

      {recent.length > 0 ? <details>
        <summary className={styles.note}>Recent commands</summary>
        <ul className={styles.lines}>
          {recent.map((request) => <li key={request.id}><strong>{agentName(request.agentId)}</strong>: {commandLine(request.argv)} · {request.status}
            {request.hasResult && !(request.id in outputs) ? <> <button type="button" className={styles.button} onClick={() => void showOutput(request.id)}>Show output</button></> : null}
            {request.id in outputs ? (outputs[request.id] ? <pre className={styles.note} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {[outputs[request.id]?.stdout, outputs[request.id]?.stderr, outputs[request.id]?.message].filter(Boolean).join("\n")}
              {typeof outputs[request.id]?.exitCode === "number" ? `\n(exit ${outputs[request.id]?.exitCode})` : ""}</pre> : <span className={styles.note}> The output is no longer kept.</span>) : null}</li>)}
        </ul>
      </details> : null}
    </div>
  </section>;
}
