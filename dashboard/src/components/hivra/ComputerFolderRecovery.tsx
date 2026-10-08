"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listAgents, type HivraAgent } from "@/lib/hivra/agent-api";
import styles from "./ComputerFolderRecovery.module.css";

const ENDPOINT = "/api/hivra/folder-recovery";
// iOS maps the custom extension to no file type and greys the file out in the
// picker, so the octet-stream type keeps it selectable; the name is checked below.
const ARCHIVE_ACCEPT = ".hivra-folder,application/octet-stream";

async function requestRecovery(body: Record<string, unknown>): Promise<Response> {
  const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", cache: "no-store", body: JSON.stringify(body) });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(result?.error || "The recovery request did not complete. Your original computer has not been removed.");
  }
  return response;
}

export function ComputerFolderRecovery() {
  const [computers, setComputers] = useState<HivraAgent[]>([]);
  const [sourceId, setSourceId] = useState("");
  // The computer whose Manage tab opened this page; the back link returns there.
  const [entrySourceId, setEntrySourceId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [restoredId, setRestoredId] = useState("");

  useEffect(() => { let active = true;
    const selected = new URLSearchParams(window.location.search).get("source");
    if (selected && /^[0-9a-f-]{36}$/i.test(selected)) { setSourceId(selected); setEntrySourceId(selected); }
    listAgents().then((rows) => { if (active) setComputers(rows.filter((computer) =>
      computer.type === "linux-desktop" && computer.computer_profile === "ubuntu-desktop"
      && computer.computer_substrate === "proxmox-kvm" && computer.status !== "deleted")); })
      .catch(() => { if (active) setError("Computers could not be loaded. Refresh this page to try again."); });
    return () => { active = false; };
  }, []);

  async function perform(action: "export" | "restore") {
    setBusy(action); setError(""); setMessage(""); setRestoredId("");
    const secret = passphrase;
    setPassphrase("");
    try {
      if (action === "export") {
        setMessage("Reading the complete Hivra folder and encrypting the file. Keep this page open.");
        const response = await requestRecovery({ action, sourceId, passphrase: secret });
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "ubuntu-hivra-folder.hivra-folder";
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setMessage("Encrypted folder file downloaded. Save it and its passphrase separately. The source and its desktop sessions are unchanged.");
      } else {
        if (!archive || archive.size > 3 * 1024 * 1024) throw new Error("Choose a .hivra-folder file no larger than 3 MiB.");
        if (!archive.name.toLowerCase().includes(".hivra-folder")) throw new Error("Choose the encrypted .hivra-folder file you exported.");
        const bytes = new Uint8Array(await archive.arrayBuffer());
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
        }
        setMessage("Checking the archive and empty destination, restoring files, then verifying every hash. This can take a few minutes; keep this page open.");
        const response = await requestRecovery({ action, sourceId, destinationId, artifact: btoa(chunks.join("")),
          passphrase: secret, revokeSourceSessions: consent });
        const result = await response.json() as { data: { files: number; bytes: number; resumed: boolean; alreadyCompleted: boolean } };
        setRestoredId(destinationId);
        setMessage(result.data.alreadyCompleted
          ? "This exact archive was already restored and verified. This request did not change any files or end any new sessions. Open the destination to inspect its current files."
          : `${result.data.files} files (${result.data.bytes.toLocaleString()} bytes) restored and verified. Existing source desktop sessions have ended; you can open a new source session. Both computers and the original files are preserved. Reboot and reconnect to the destination to check your files.`);
      }
    } catch (failure) {
      setMessage(""); setError(failure instanceof Error ? failure.message : "Recovery could not be confirmed.");
    } finally { setBusy(null); }
  }

  const fieldClass = styles.input;
  const entrySource = computers.find((computer) => computer.id === entrySourceId);
  return <div className={styles.page}>
    {entrySourceId
      ? <Link href={`/dashboard/agent/${encodeURIComponent(entrySourceId)}?tab=manage&section=recovery`} className={styles.link}>Back to {entrySource?.name || "computer"}</Link>
      : <Link href="/dashboard/computers" className={styles.link}>Back to computers</Link>}
    <header>
      <h1>Move your Ubuntu Hivra folder</h1>
      <p className={styles.secondary}>Copy the Hivra folder from your Ubuntu desktop into a different freshly launched Ubuntu computer using an encrypted file. Your original computer is kept.</p>
      <p className={styles.hint}>On the desktop, open <code>/home/ubuntu/Hivra</code>. In Terminal or Files, the same shared folder is <code>/home/bux/Hivra</code>. Only files inside this folder are included.</p>
    </header>
    <aside className={styles.notice}>
      <p>Folder only · 2 MiB total · 512 files and folders maximum</p>
      <p className={styles.hint}>Not a whole-computer backup. Other folders, installed apps, browser profiles and machine credentials are not included. Exports containing links or special files are rejected. Encrypted downloads must be no larger than 3 MiB. Currently supports enrolled Ubuntu desktops on Proxmox.</p>
    </aside>
    <label className={styles.field}><span>Recovery passphrase</span>
      <input type="password" autoComplete="new-password" value={passphrase} disabled={Boolean(busy)}
        onChange={(event) => setPassphrase(event.target.value)} minLength={12} maxLength={1024} className={fieldClass} />
      <span className={styles.hint}>At least 12 characters. Enter it again for restore. It is sent to this controller for this request only, never saved; we cannot recover it.</span>
    </label>
    <section className={styles.section}>
      <h2>1. Export from the original</h2>
      <p className={styles.hint}>Close apps writing to the Hivra folder first. The source must be running. Nothing is removed or disconnected on export.</p>
      <label className={styles.field}><span>Original Ubuntu computer</span>
        <select value={sourceId} disabled={Boolean(busy)} onChange={(event) => {
          const nextSource = event.target.value;
          setSourceId(nextSource);
          if (destinationId === nextSource) setDestinationId("");
        }} className={fieldClass}>
          <option value="">Choose the original computer</option>
          {computers.map((computer) => <option key={computer.id} value={computer.id}>{computer.name} — {computer.status}</option>)}
        </select>
      </label>
      <button type="button" disabled={Boolean(busy) || !sourceId || passphrase.length < 12} onClick={() => void perform("export")}
        className={styles.button}>{busy === "export" ? "Exporting…" : "Download encrypted folder"}</button>
    </section>
    <section className={styles.section}>
      <h2>2. Restore to a fresh computer</h2>
      <p className={styles.hint}>Select the archive’s original computer above. <Link href="/dashboard/computers" className={styles.link}>Launch a new Ubuntu computer</Link>, then choose it here once running. Leave its Hivra folder empty and close destination apps and terminal/SSH sessions. Existing files are never overwritten. A pending transfer can be verified by submitting the same file and destination again.</p>
      <label className={styles.field}><span>Encrypted Hivra-folder file</span>
        <input type="file" accept={ARCHIVE_ACCEPT} disabled={Boolean(busy)} onChange={(event) => setArchive(event.target.files?.[0] ?? null)} className={fieldClass} />
      </label>
      <label className={styles.field}><span>Fresh destination Ubuntu computer</span>
        <select value={destinationId} disabled={Boolean(busy)} onChange={(event) => setDestinationId(event.target.value)} className={fieldClass}>
          <option value="">Choose the empty destination</option>
          {computers.filter((computer) => computer.id !== sourceId).map((computer) => <option key={computer.id} value={computer.id}>{computer.name} — {computer.status}</option>)}
        </select>
      </label>
      <label className={styles.consent}><input type="checkbox" checked={consent} disabled={Boolean(busy)}
        onChange={(event) => setConsent(event.target.checked)} />
        <span>Restart the destination’s desktop, terminals and files service to load the restored folder. After a verified transfer, end existing desktop sessions on {computers.find((computer) => computer.id === sourceId)?.name || "the selected original computer"}. I can open the original again with a new session; its files remain.</span>
      </label>
      <button type="button" disabled={Boolean(busy) || !sourceId || !destinationId || sourceId === destinationId || !archive || !consent || passphrase.length < 12}
        onClick={() => void perform("restore")} className={styles.button}>{busy === "restore" ? "Restoring and verifying…" : "Restore without overwriting"}</button>
    </section>
    {message && <p role="status" className={styles.status}>{message}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {restoredId && <Link href={`/dashboard/agent/${encodeURIComponent(restoredId)}`} className={styles.link}>Open the restored computer</Link>}
  </div>;
}
