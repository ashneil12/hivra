"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, ShieldCheck } from "lucide-react";

import { advanceProviderComputerSetup, listProviderComputerSetups } from "@/lib/infrastructure/client";
import type { HetznerCloudConnectionDto } from "@/lib/infrastructure/contracts";
import { PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS } from "@/lib/infrastructure/portable-provisioner-contract";
import {
  PROVIDER_SETUP_STAGE_LABELS,
  isProviderComputerSetupTerminal,
  type ProviderComputerSetupView,
} from "@/lib/infrastructure/provider-computer-setup-contracts";
import { buildLaunchSetupHref, type PortableLaunchResourceId } from "@/lib/hivra/launch-navigation";

import styles from "./Infrastructure.module.css";

const SETUP_POLL_MS = 5_000;
const SETUP_WINDOW_MS = 10 * 60_000;
const SETUP_MAX_STEPS = 80;

/** Stages before the server has connected back with its one-time key. Only
 * these show the key's countdown; afterwards the key no longer matters. */
/** Stages that need the user's attention rather than their next click. */
const ATTENTION_STAGES = new Set<ProviderComputerSetupView["stage"]>([
  "not_requested", "expired", "stopped", "retired", "firewall_outcome_unknown", "power_outcome_unknown",
]);

const PRE_ENROLLMENT_STAGES = new Set<ProviderComputerSetupView["stage"]>([
  "waiting_for_capacity", "awaiting_setup", "busy", "firewall_requested", "waiting_for_firewall",
  "power_requested", "waiting_for_power", "waiting_for_identity",
]);

/** Where a ready Hivra-created server opens the launch journey. */
export function launchOnTargetHref(targetId: string): string {
  return `/dashboard/launch?start=1&targetId=${encodeURIComponent(targetId)}`;
}

export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The observed stage in plain words; a launch-ready server says so. */
function stageLabel(view: ProviderComputerSetupView): string {
  return view.stage === "environment_prepared" && view.launchReady && view.targetId
    ? "Ready for agents"
    : PROVIDER_SETUP_STAGE_LABELS[view.stage];
}

function stageBody(view: ProviderComputerSetupView): string {
  switch (view.stage) {
    case "retired":
      return "This server's saved setup is reference-only. It can't be resumed or launched. Check its original resource cleanup to confirm whether provider billing has ended.";
    case "not_requested":
      return "This server was created without agent setup. Hivra won't replace its first-boot configuration. You can keep it, manage it in Hetzner, or remove it with Remove created server.";
    case "expired":
      return "The one-time setup key expired before the server connected back. Hivra won't replace the key or start a different server. Remove this server with Remove created server before creating another.";
    case "stopped":
      return "Setup was stopped. The server and its saved state are kept; nothing else will run.";
    case "firewall_outcome_unknown":
    case "power_outcome_unknown":
      return "Hetzner didn't confirm the last step. Check the server in Hetzner Console before doing anything else; Hivra never treats an uncertain result as success.";
    case "environment_prepared":
      return view.launchReady
        ? `${view.serverName} is ready for agents. Launch checks it again before anything starts.`
        : "The setup files are verified, but this server hasn't passed launch checks yet. Continue setup to finish.";
    case "awaiting_setup":
      return "Start setup turns the server on and installs Hivra's setup files. It takes about 5 minutes. Nothing is bought here.";
    default:
      return "Hivra is setting up this exact server. If a step's result is uncertain, it stays visible here and is never treated as success.";
  }
}

export function ProviderComputerSetupPanel({
  connection,
  orderId = null,
  launchResourceId = null,
  unifiedLaunchReturn = false,
  onChanged,
  onRunningChange,
  onClose,
  closeLabel = "Close",
  note = null,
}: {
  connection: HetznerCloudConnectionDto;
  /** Pin the panel to one Hivra-created server; otherwise show a picker. */
  orderId?: string | null;
  launchResourceId?: PortableLaunchResourceId | null;
  unifiedLaunchReturn?: boolean;
  onChanged: () => void;
  onRunningChange?: (running: boolean) => void;
  onClose?: () => void;
  closeLabel?: string;
  /** One line of context shown above the setup status, such as the purchase that just happened. */
  note?: ReactNode;
}) {
  const [computers, setComputers] = useState<ProviderComputerSetupView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(orderId);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [observed, setObserved] = useState<Array<{ label: string; elapsedMs: number }>>([]);
  const [clock, setClock] = useState(() => Date.now());
  const alive = useRef(true);
  const runningRef = useRef(false);
  const stopped = useRef(false);
  const expiryChecked = useRef<string | null>(null);
  const selectorId = useId();

  const current = orderId
    ? computers.find((item) => item.orderId === orderId)
    : computers.find((item) => item.orderId === selectedId) ?? computers[0];
  // This only permits returning to launch, not runtime admission. The launch
  // flow reloads the target's version and capabilities before enabling launch.
  const requestedRuntimeSupported = !launchResourceId
    || launchResourceId === "linux-desktop"
    || (PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS as readonly string[]).includes(launchResourceId);
  const launchTargetId = current?.stage === "environment_prepared" && current.launchReady ? current.targetId : null;
  const expiresAt = current?.enrollmentExpiresAt && PRE_ENROLLMENT_STAGES.has(current.stage)
    ? Date.parse(current.enrollmentExpiresAt)
    : null;
  const remainingMs = expiresAt === null || !Number.isFinite(expiresAt) ? null : expiresAt - clock;

  const load = useCallback(async () => {
    try {
      const items = await listProviderComputerSetups(connection.id);
      if (!alive.current) return;
      setComputers(items);
      setSelectedId((selected) => selected ?? items.find((item) => item.stage !== "retired")?.orderId ?? null);
    } catch {
      if (alive.current) setError("Setup could not be loaded. Close this window and open it again to retry.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [connection.id]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; stopped.current = true; };
  }, [load]);

  useEffect(() => { onRunningChange?.(running); }, [running, onRunningChange]);

  const ticking = running || remainingMs !== null;
  useEffect(() => {
    if (!ticking) return;
    setClock(Date.now());
    const interval = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [ticking]);

  // The server decides expiry. When the local countdown reaches zero, read the
  // saved state once instead of claiming the window closed.
  useEffect(() => {
    if (remainingMs === null || remainingMs > 0 || running || !current) return;
    const key = `${current.orderId}:${current.enrollmentExpiresAt}`;
    if (expiryChecked.current === key) return;
    expiryChecked.current = key;
    void load();
  }, [remainingMs, running, current, load]);

  async function run() {
    if (!current || runningRef.current || isProviderComputerSetupTerminal(current)) return;
    runningRef.current = true; stopped.current = false;
    const began = Date.now();
    setRunning(true); setError(null); setStartedAt(began); setObserved([]);
    const deadline = began + SETUP_WINDOW_MS;
    try {
      // One explicit click drives bounded, once-only server operations. A page
      // reload only reads saved state; it never restarts this loop implicitly.
      for (let step = 0; step < SETUP_MAX_STEPS && alive.current && !stopped.current && Date.now() < deadline; step++) {
        const result = await advanceProviderComputerSetup(connection.id, {
          orderId: current.orderId, expectedConnectionRevision: current.connectionRevision,
        });
        if (!alive.current) return;
        if (result.orderId !== current.orderId || result.connectionId !== connection.id
          || result.connectionRevision !== current.connectionRevision) throw new Error("Setup returned a different server. Reopen the original setup.");
        setComputers((items) => items.map((item) => item.orderId === result.orderId ? result : item));
        const label = stageLabel(result);
        setObserved((items) => items.at(-1)?.label === label
          ? items
          : [...items, { label, elapsedMs: Date.now() - began }]);
        if (isProviderComputerSetupTerminal(result)) { onChanged(); return; }
        if (stopped.current) return;
        await new Promise((resolve) => setTimeout(resolve, SETUP_POLL_MS));
      }
      if (alive.current && !stopped.current) setError("Setup hasn't finished within this check window. Its progress is saved; continue setup to resume it.");
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "This step could not be confirmed. Its original operation is kept.");
    } finally {
      runningRef.current = false;
      if (alive.current) setRunning(false);
    }
  }

  const noteLine = note ? <p className={styles.setupNote}><CheckCircle2 size={14} aria-hidden="true" /><span>{note}</span></p> : null;
  if (loading) return <div className={styles.setupPanel}>{noteLine}<p role="status">Loading saved setup…</p></div>;

  return <div className={styles.setupPanel}>
    {noteLine}
    {!requestedRuntimeSupported && <div className={styles.formError} role="alert">
      <AlertTriangle size={16} aria-hidden="true" /><span>This launch type can&apos;t run on a Hetzner server yet. Return to launch to choose another place for it.</span>
    </div>}
    {!current && orderId ? <div className={styles.providerInventoryEmpty}>
      <div><strong>This server&apos;s setup isn&apos;t readable yet.</strong><span>Its creation is saved. Check again in a moment, or open Computer setup from the project card.</span></div>
      <button type="button" className={styles.secondaryButton} onClick={() => { setLoading(true); void load(); }}>Check again</button>
    </div> : !current ? <div className={styles.providerInventoryEmpty}>
      <div><strong>No Hivra-created servers to set up here.</strong><span>Create a server from this project&apos;s card; setup is included. Servers that Hivra didn&apos;t create connect with the setup command instead.</span></div>
    </div> : <>
      {!orderId && computers.length > 1 && <label className={styles.field} htmlFor={selectorId}><span className={styles.fieldLabel}>Server</span>
        <select id={selectorId} disabled={running} value={current.orderId} onChange={(event) => setSelectedId(event.target.value)}>
          {computers.map((item) => <option key={item.orderId} value={item.orderId}>{item.serverName}{item.stage === "retired" ? " — Computer retired" : ""}</option>)}
        </select></label>}
      <div className={`${styles.capacityResultHero} ${launchTargetId
        ? styles.capacityResult_ready
        : ATTENTION_STAGES.has(current.stage) ? styles.capacityResult_warning : ""}`} role="status" aria-live="polite">
        <span aria-hidden="true">{running ? <Loader2 size={22} className={styles.spin} /> : current.stage === "environment_prepared" && current.launchReady ? <CheckCircle2 size={22} /> : <ShieldCheck size={22} />}</span>
        <div>
          <span className={styles.sectionLabel}>{current.serverName}</span>
          <h2>{stageLabel(current)}</h2>
          <p>{stageBody(current)}</p>
        </div>
      </div>

      {remainingMs !== null && !isProviderComputerSetupTerminal(current) ? (
        <p className={remainingMs > 0 && remainingMs < 3 * 60_000 ? `${styles.setupCountdown} ${styles.setupCountdownUrgent}` : styles.setupCountdown}>
          <Clock3 size={14} aria-hidden="true" />
          {remainingMs > 0
            ? current.stage === "awaiting_setup" && !running
              ? <span>Setup key valid for <strong>{formatClock(remainingMs)}</strong>. Start setup before it runs out; Hivra can&apos;t issue a new key for this server.</span>
              : <span>The server has <strong>{formatClock(remainingMs)}</strong> left to connect back with its setup key.</span>
            : <span>The setup key&apos;s time is up. Checking the saved state…</span>}
        </p>
      ) : null}

      {running || observed.length > 0 ? (
        <div className={styles.setupProgress}>
          {running && startedAt !== null ? (
            <p className={styles.setupElapsed}>
              <Loader2 size={13} className={styles.spin} aria-hidden="true" />
              <span>Setting up · <strong>{formatClock(clock - startedAt)}</strong> · usually about 5 minutes. Keep this window open.</span>
            </p>
          ) : null}
          {observed.length > 0 ? (
            <ol className={styles.setupObservedStages} aria-label="Observed setup steps">
              {observed.map((item) => <li key={`${item.label}:${item.elapsedMs}`}><span>{formatClock(item.elapsedMs)}</span>{item.label}</li>)}
            </ol>
          ) : null}
        </div>
      ) : null}
    </>}

    {error && <div className={styles.formError} role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{error}</span></div>}

    <div className={styles.resultActions}>
      {onClose ? <button type="button" className={styles.secondaryButton} disabled={running} onClick={onClose}>{closeLabel}</button> : null}
      {!running && launchTargetId && requestedRuntimeSupported && <Link
        className={styles.primaryButton}
        href={launchResourceId
          ? buildLaunchSetupHref(launchResourceId, launchTargetId, { unified: unifiedLaunchReturn })
          : launchOnTargetHref(launchTargetId)}
      >{launchResourceId ? "Continue your launch" : "Launch on this server"}</Link>}
      {!running && !requestedRuntimeSupported && launchResourceId && <Link
        className={styles.primaryButton}
        href={buildLaunchSetupHref(launchResourceId, null, { unified: unifiedLaunchReturn })}
      >Choose another place</Link>}
      {running
        ? <button type="button" className={styles.secondaryButton} onClick={() => { stopped.current = true; setError("Pausing after the current step. Finished steps stay done; you can continue setup later."); }}>Pause after this step</button>
        : current && !isProviderComputerSetupTerminal(current) && <button type="button" className={styles.primaryButton} onClick={() => void run()}>
          {current.stage === "awaiting_setup" ? "Start setup" : "Continue setup"}
        </button>}
    </div>
  </div>;
}
