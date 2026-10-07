"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  claudeAppInstall,
  claudeAppRemove,
  claudeAppSetView,
  claudeAppStatus,
  type ClaudeAppStatus,
  type ClaudeAppView,
} from "@/lib/hivra/agent-api";
import styles from "./ClaudeAppSwitch.module.css";

// Polling is quick while something is changing and slow once it has settled.
const FAST_POLL_MS = 3_000;
const SLOW_POLL_MS = 30_000;

type Panel = null | "add" | "update" | "remove";

// A clock read kept out of the component body: the view choice is stamped from an event.
const clockMs = () => Date.now();

/**
 * The Claude app on an Ubuntu Desktop computer: Anthropic's own Linux app,
 * added by the owner, shown full screen by default with the regular desktop one
 * switch away. It lives in the Desktop tab's own toolbar and renders nothing at
 * all on a computer that does not offer the app.
 *
 * Nothing here handles a Claude sign-in: the owner signs in inside the app.
 */
export function ClaudeAppSwitch({ boxUrl, token, active = true }: { boxUrl: string; token?: string | null; active?: boolean }) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<ClaudeAppStatus | null>(null);
  const [view, setView] = useState<ClaudeAppView>("app");
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<"add" | "view" | "update" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A view choice the owner just made outranks a poll that was already in flight.
  const choiceAtRef = useRef(0);

  const settledRef = useRef(false);
  const refresh = useCallback(async () => {
    const result = await claudeAppStatus(boxUrl, token);
    setAvailable(result.available);
    if (result.status) {
      setStatus(result.status);
      if (clockMs() - choiceAtRef.current > 4_000) setView(result.status.mode);
      // Quick while something is changing, slow once it has settled.
      settledRef.current = !result.status.installing && (!result.status.enabled || result.status.appRunning);
    } else {
      settledRef.current = false;
    }
  }, [boxUrl, token]);

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(tick, settledRef.current ? SLOW_POLL_MS : FAST_POLL_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [active, refresh]);

  if (!available || !status) return null;

  const installing = status.installing || busy === "add" || busy === "update";

  async function add(kind: "add" | "update") {
    setBusy(kind); setError(null); setPanel(null);
    const result = await claudeAppInstall(boxUrl, token);
    if (!result.ok) setError(result.error || "The Claude app could not be added.");
    await refresh();
    setBusy(null);
  }
  async function choose(next: ClaudeAppView) {
    if (next === view || busy) return;
    const previous = view;
    choiceAtRef.current = clockMs();
    setView(next); setBusy("view"); setError(null);
    const result = await claudeAppSetView(boxUrl, next, token);
    if (!result.ok) { setView(previous); setError(result.error || "The view could not be switched."); }
    setBusy(null);
  }
  async function remove() {
    setBusy("remove"); setError(null); setPanel(null);
    const result = await claudeAppRemove(boxUrl, token);
    if (!result.ok) setError(result.error || "The Claude app could not be removed.");
    await refresh();
    setBusy(null);
  }

  return (
    <div className={styles.root} data-claude-app-state={status.enabled ? "added" : "not-added"}>
      {!status.enabled && !installing ? (
        <button type="button" className={styles.action} aria-expanded={panel === "add"} onClick={() => setPanel(panel === "add" ? null : "add")}>
          Add Claude app
        </button>
      ) : null}
      {installing ? (
        <span className={styles.progress} role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          {status.enabled ? "Updating the Claude app…" : "Adding the Claude app…"}
        </span>
      ) : null}
      {status.enabled && !installing ? (
        <>
          <div className={styles.segment} role="radiogroup" aria-label="Desktop view">
            {([["app", "Claude app"], ["desktop", "Desktop"]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={view === value}
                className={styles.option}
                data-selected={view === value ? "true" : undefined}
                disabled={busy === "view"}
                onClick={() => void choose(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {!status.appRunning ? <span className={styles.progress} role="status"><Loader2 size={12} className="animate-spin" aria-hidden="true" />Starting…</span> : null}
          {status.updateAvailable ? (
            <button type="button" className={styles.action} aria-expanded={panel === "update"} onClick={() => setPanel(panel === "update" ? null : "update")}>
              Update
            </button>
          ) : null}
          <button type="button" className={styles.more} aria-label="Claude app options" aria-expanded={panel === "remove"} onClick={() => setPanel(panel === "remove" ? null : "remove")}>
            …
          </button>
        </>
      ) : null}
      {status.lastError && !status.enabled && !installing ? <span className={styles.error} role="alert" title={status.lastError}>Couldn’t add it: {status.lastError}</span> : null}
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
      {panel ? (
        <div className={styles.panel} role="dialog" aria-label={panel === "add" ? "Add the Claude app" : panel === "update" ? "Update the Claude app" : "Claude app options"}>
          {panel === "add" ? (
            <>
              <p className={styles.panelTitle}>Use Claude as an app on this computer</p>
              <p>
                This downloads Anthropic’s Claude app for Linux from Anthropic (about 180 MB) and opens it full screen here,
                with the regular desktop one click away. It uses roughly 0.6 GB of this computer’s memory.
              </p>
              <p>You sign in inside the app with your own Claude account. Hivra never sees or stores that sign-in. The app and its settings stay on this computer.</p>
              <div className={styles.panelActions}>
                <button type="button" className={styles.primary} onClick={() => void add("add")}>Add Claude app</button>
                <button type="button" className={styles.action} onClick={() => setPanel(null)}>Not now</button>
              </div>
            </>
          ) : null}
          {panel === "update" ? (
            <>
              <p className={styles.panelTitle}>Update the Claude app</p>
              <p>
                Version {status.pinnedVersion} is ready. The app restarts to apply it, so close or finish anything open in it first.
                Your sign-in and settings are kept.
              </p>
              <div className={styles.panelActions}>
                <button type="button" className={styles.primary} onClick={() => void add("update")}>Update and restart</button>
                <button type="button" className={styles.action} onClick={() => setPanel(null)}>Not now</button>
              </div>
            </>
          ) : null}
          {panel === "remove" ? (
            <>
              <p className={styles.panelTitle}>Claude app{status.installedVersion ? ` ${status.installedVersion}` : ""}</p>
              <p>Removing it deletes the app and its saved sign-in from this computer. Your files in the Hivra folder are not touched.</p>
              <div className={styles.panelActions}>
                <button type="button" className={styles.danger} onClick={() => void remove()}>Remove the Claude app</button>
                <button type="button" className={styles.action} onClick={() => setPanel(null)}>Keep it</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
