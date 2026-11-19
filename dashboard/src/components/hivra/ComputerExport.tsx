"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { listAgents, type HivraAgent } from "@/lib/hivra/agent-api";
import styles from "./ComputerFolderRecovery.module.css";

const ENDPOINT = "/api/hivra/computer-export";

type ExportView = {
  id: string; agentId: string; status: "running" | "ready" | "failed";
  bytesUploaded: number; byteCount: number | null; sha256: string | null;
  createdAt: string; expiresAt: string; downloadUrl: string | null; failure: string | null;
};

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok || !body || body.data === undefined) throw new Error(body?.error || "The export request did not complete.");
  return body.data;
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function ComputerExport() {
  const [computers, setComputers] = useState<HivraAgent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<ExportView | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    const selected = new URLSearchParams(window.location.search).get("source");
    if (selected && /^[0-9a-f-]{36}$/i.test(selected)) setAgentId(selected);
    listAgents().then((rows) => {
      if (active) setComputers(rows.filter((c) => c.computer_substrate === "proxmox-kvm" && c.status !== "deleted"));
    }).catch(() => { if (active) setError("Computers could not be loaded. Refresh this page to try again."); });
    return () => { active = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  const poll = useCallback((id: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const next = await call<ExportView>(`${ENDPOINT}?id=${encodeURIComponent(id)}`);
        setCurrent(next);
        if (next.status === "running") poll(id);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Progress could not be checked.");
        poll(id);
      }
    }, 10_000);
  }, []);

  async function start() {
    setBusy(true); setError(""); setCurrent(null);
    const secret = passphrase;
    setPassphrase(""); setConfirm("");
    try {
      const started = await call<ExportView>(ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, passphrase: secret }),
      });
      setCurrent(started);
      poll(started.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The export could not start.");
    } finally { setBusy(false); }
  }

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  return <div className={styles.page}>
    {agentId
      ? <Link href={`/dashboard/agent/${encodeURIComponent(agentId)}?tab=manage`} className={styles.link}>Back to {computers.find((c) => c.id === agentId)?.name || "computer"}</Link>
      : <Link href="/dashboard/computers" className={styles.link}>Back to computers</Link>}
    <header>
      <h1>Export a whole computer</h1>
      <p className={styles.secondary}>Download one encrypted file with everything that is yours on this computer: home folders, each agent&apos;s data and settings, and its browser sign-ins. Hivra&apos;s own connection files and caches are left out.</p>
    </header>
    <aside className={styles.notice}>
      <p>Your agents keep running while the file is packed. Packing and uploading can take from a few minutes to an hour for large computers. The download link works for a few days, then the file is deleted.</p>
      <p className={styles.hint}>Keys you added to your agents stay in the file, so keep it safe. To open it on any computer: <code>gpg -d computer.tar.gpg | zstd -d | tar -x</code></p>
    </aside>
    <label className={styles.field}><span>Computer</span>
      <select value={agentId} disabled={busy} onChange={(event) => setAgentId(event.target.value)} className={styles.input}>
        <option value="">Choose a computer</option>
        {computers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
      </select>
    </label>
    <label className={styles.field}><span>Passphrase</span>
      <input type="password" autoComplete="new-password" value={passphrase} disabled={busy} minLength={12} maxLength={1024}
        onChange={(event) => setPassphrase(event.target.value)} className={styles.input} />
      <span className={styles.hint}>At least 12 characters. Hivra never stores it and cannot recover it. Without it the file cannot be opened.</span>
    </label>
    <label className={styles.field}><span>Passphrase again</span>
      <input type="password" autoComplete="new-password" value={confirm} disabled={busy}
        onChange={(event) => setConfirm(event.target.value)} className={styles.input} />
      {mismatch && <span className={styles.hint}>The two passphrases differ.</span>}
    </label>
    <button type="button" className={styles.button} onClick={() => void start()}
      disabled={busy || !agentId || passphrase.length < 12 || confirm !== passphrase || current?.status === "running"}>
      {busy ? "Starting…" : "Export this computer"}
    </button>
    {current?.status === "running" && <p role="status" className={styles.status}>
      Packing and uploading{current.bytesUploaded > 0 ? `: ${size(current.bytesUploaded)} so far` : ""}. You can leave this page; the export carries on.
    </p>}
    {current?.status === "ready" && current.downloadUrl && <p role="status" className={styles.status}>
      Ready{current.byteCount ? ` (${size(current.byteCount)})` : ""}. <a href={current.downloadUrl} className={styles.link} download>Download the encrypted file</a>, available until {new Date(current.expiresAt).toLocaleString()}.
    </p>}
    {current?.status === "failed" && <p role="alert" className={styles.error}>{current.failure || "The export failed."} Nothing on the computer was changed.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </div>;
}
