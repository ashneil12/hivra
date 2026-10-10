"use client";

// Read-only view of a DigitalOcean session's /workspace. Listings come from
// DigitalOcean's sandbox exec API and downloads stream through Hivra with
// DigitalOcean's checksum verified; nothing here writes to the workspace.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, File, Folder, FolderDown, Link2, Loader2, Play, RefreshCw } from "lucide-react";

import {
  changeManagedSession,
  isManagedSessionCredentialProblem,
  listManagedWorkspace,
  ManagedSessionApiError,
  managedWorkspaceDownloadUrl,
} from "@/lib/hivra/managed-session-client";
import type { ManagedSessionDto, ManagedWorkspaceEntry, ManagedWorkspaceListing } from "@/lib/hivra/managed-session-contracts";

import chatStyles from "./ManagedSessionChat.module.css";
import styles from "./ManagedSessionWorkspace.module.css";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatModified(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function EntryIcon({ entry }: { entry: ManagedWorkspaceEntry }) {
  if (entry.kind === "directory") return <Folder size={15} aria-hidden />;
  if (entry.kind === "symlink") return <Link2 size={15} aria-hidden />;
  return <File size={15} aria-hidden />;
}

export function ManagedSessionFiles({
  session,
  onSessionChange,
  onCredentialProblem,
}: {
  session: ManagedSessionDto;
  onSessionChange: (session: ManagedSessionDto) => void;
  onCredentialProblem: (error: ManagedSessionApiError) => void;
}) {
  const agentId = session.agentId;
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<ManagedWorkspaceListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; text: string } | null>(null);
  const [resuming, setResuming] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    listManagedWorkspace(agentId, path, controller.signal)
      .then((next) => { setListing(next); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (isManagedSessionCredentialProblem(cause)) onCredentialProblem(cause);
        setListing(null);
        setError({
          code: cause instanceof ManagedSessionApiError ? cause.code : undefined,
          text: cause instanceof Error ? cause.message : "The files could not be listed.",
        });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agentId, path, reloadKey, onCredentialProblem]);

  const resume = useCallback(async () => {
    setResuming(true);
    try {
      onSessionChange(await changeManagedSession(agentId, "resume"));
      setReloadKey((key) => key + 1);
    } catch (cause) {
      if (isManagedSessionCredentialProblem(cause)) onCredentialProblem(cause);
      setError({ text: cause instanceof Error ? cause.message : "The session did not resume." });
    } finally {
      setResuming(false);
    }
  }, [agentId, onCredentialProblem, onSessionChange]);

  const segments = path ? path.split("/") : [];
  const paused = error?.code === "session_paused";

  return (
    <div className={styles.files}>
      <div className={styles.filesInner}>
        <div className={styles.toolbar}>
          <nav className={styles.crumbs} aria-label="Folder">
            <button type="button" className={styles.crumb} disabled={segments.length === 0} onClick={() => setPath("")}>/workspace</button>
            {segments.map((segment, index) => (
              <span key={`${index}-${segment}`}>
                /<button
                  type="button"
                  className={styles.crumb}
                  disabled={index === segments.length - 1}
                  onClick={() => setPath(segments.slice(0, index + 1).join("/"))}
                >{segment}</button>
              </span>
            ))}
          </nav>
          <button type="button" className={chatStyles.ghostButton} onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            {loading ? <Loader2 size={12} className={chatStyles.spin} aria-hidden /> : <RefreshCw size={12} aria-hidden />} Refresh
          </button>
          {listing ? (
            <a className={chatStyles.ghostButton} href={managedWorkspaceDownloadUrl(agentId, path, { archive: true })} download>
              <FolderDown size={12} aria-hidden /> Download folder (.tar)
            </a>
          ) : null}
        </div>

        {paused ? (
          <div className={styles.banner} role="status">
            <div className={styles.bannerTitle}>This session is paused, so its files can&apos;t be read right now.</div>
            <span>Resuming starts DigitalOcean compute billing again until it pauses.</span>
            <div className={styles.bannerActions}>
              <button type="button" className={chatStyles.primaryButton} onClick={() => void resume()} disabled={resuming}>
                {resuming ? <Loader2 size={12} className={chatStyles.spin} aria-hidden /> : <Play size={12} aria-hidden />} Resume session
              </button>
            </div>
          </div>
        ) : error ? (
          <div className={`${chatStyles.notice} ${chatStyles.noticeError}`} role="alert" style={{ margin: 0 }}>
            <AlertTriangle size={15} aria-hidden /> {error.text}
          </div>
        ) : null}

        {listing ? (
          <div className={styles.list} aria-busy={loading}>
            {listing.entries.length === 0 ? (
              <div className={styles.empty}>
                {path ? "This folder is empty." : `Nothing in /workspace yet. Files ${session.name} creates appear here.`}
              </div>
            ) : listing.entries.map((entry) => {
              const childPath = path ? `${path}/${entry.name}` : entry.name;
              return (
                <div key={entry.name} className={styles.row}>
                  {entry.kind === "directory" ? (
                    <button type="button" className={styles.name} onClick={() => setPath(childPath)}>
                      <EntryIcon entry={entry} /><span>{entry.name}</span>
                    </button>
                  ) : (
                    <span className={styles.name}><EntryIcon entry={entry} /><span>{entry.name}</span></span>
                  )}
                  <span className={`${styles.meta} ${styles.rowSize}`}>{formatBytes(entry.sizeBytes)}</span>
                  <span className={`${styles.meta} ${styles.rowModified}`}>{formatModified(entry.modifiedAt)}</span>
                  {entry.kind === "file" ? (
                    <a className={styles.download} href={managedWorkspaceDownloadUrl(agentId, childPath)} download aria-label={`Download ${entry.name}`}>
                      <Download size={15} aria-hidden />
                    </a>
                  ) : entry.kind === "directory" ? (
                    <a className={styles.download} href={managedWorkspaceDownloadUrl(agentId, childPath, { archive: true })} download aria-label={`Download ${entry.name} as .tar`}>
                      <FolderDown size={15} aria-hidden />
                    </a>
                  ) : <span />}
                </div>
              );
            })}
          </div>
        ) : loading ? (
          <div className={styles.empty} role="status"><Loader2 size={16} className={chatStyles.spin} aria-hidden /> Reading /workspace…</div>
        ) : null}

        {listing?.truncated ? (
          <p className={styles.hint}>This folder has more entries than Hivra lists at once. Ask {session.name} to tidy it, or download the folder.</p>
        ) : null}
        <p className={styles.hint}>
          Read-only. Downloads come straight from DigitalOcean and are checked against its checksum. Files over 250 MB
          aren&apos;t downloaded here.
        </p>
      </div>
    </div>
  );
}
