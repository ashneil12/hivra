"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, Server, ShieldCheck, X } from "lucide-react";
import { advanceProviderComputerSetup, listProviderComputerSetups } from "@/lib/infrastructure/client";
import { PROVIDER_SETUP_STAGE_LABELS, isProviderComputerSetupTerminal, type ProviderComputerSetupView } from "@/lib/infrastructure/provider-computer-setup-contracts";
import type { HetznerCloudConnectionDto } from "@/lib/infrastructure/contracts";
import { PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS } from "@/lib/infrastructure/portable-provisioner-contract";
import {
  buildLaunchSetupHref,
  type PortableLaunchResourceId,
} from "@/lib/hivra/launch-navigation";
import { useInfrastructureDialog } from "./useInfrastructureDialog";
import styles from "./Infrastructure.module.css";

export function ProviderComputerSetupDialog({ connection, launchResourceId = null, unifiedLaunchReturn = false, onClose, onChanged }: {
  connection: HetznerCloudConnectionDto;
  launchResourceId?: PortableLaunchResourceId | null;
  unifiedLaunchReturn?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [computers, setComputers] = useState<ProviderComputerSetupView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true), runningRef = useRef(false), stopped = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null), id = useId();
  const dialog = useInfrastructureDialog({ onClose, closeOnEscape: !running, initialFocusRef: heading });
  const current = computers.find(item => item.orderId === selectedId) ?? computers[0];
  // This only permits returning to launch, not runtime admission. The launch
  // flow reloads the target's version and capabilities before enabling launch.
  const requestedRuntimeSupported = !launchResourceId
    || launchResourceId === "linux-desktop"
    || (PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS as readonly string[]).includes(launchResourceId);
  const launchTargetId = current?.stage === "environment_prepared" && current.launchReady ? current.targetId : null;

  useEffect(() => {
    alive.current = true;
    void listProviderComputerSetups(connection.id).then(items => {
      if (alive.current) { setComputers(items); setSelectedId(items.find(item => item.stage !== "retired")?.orderId ?? null); }
    }).catch(() => { if (alive.current) setError("Computer setup could not be loaded. Reopen this window to try again."); })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; stopped.current = true; };
  }, [connection.id]);

  async function run() {
    if (!current || runningRef.current || isProviderComputerSetupTerminal(current)) return;
    runningRef.current = true; stopped.current = false; setRunning(true); setError(null);
    const deadline = Date.now() + 10 * 60_000;
    try {
      // One explicit click drives bounded, once-only server operations. A page
      // reload only reads saved state; it never restarts this loop implicitly.
      for (let step = 0; step < 80 && alive.current && !stopped.current && Date.now() < deadline; step++) {
        const result = await advanceProviderComputerSetup(connection.id, {
          orderId: current.orderId, expectedConnectionRevision: current.connectionRevision,
        });
        if (!alive.current) return;
        if (result.orderId !== current.orderId || result.connectionId !== connection.id
          || result.connectionRevision !== current.connectionRevision) throw new Error("Setup returned a different computer. Reopen the original setup.");
        setComputers(items => items.map(item => item.orderId === result.orderId ? result : item));
        if (isProviderComputerSetupTerminal(result)) { onChanged(); return; }
        if (stopped.current) return;
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
      if (alive.current && !stopped.current) setError("Setup has not finished within this check window. Its original state is saved; inspect it here before resuming.");
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "This step could not be confirmed. Its original operation is retained.");
    } finally { runningRef.current = false; if (alive.current) setRunning(false); }
  }

  return <div className={styles.modalBackdrop}>
    <section ref={dialog} className={`${styles.wizard} ${styles.capacityDialog}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <header className={styles.wizardHeader}>
        <div><span className={styles.eyebrow}>{connection.name} · Cloud computer</span><h1 id={id} ref={heading} tabIndex={-1}>Prepare your computer</h1></div>
        <button type="button" className={styles.closeButton} onClick={onClose} disabled={running} aria-label="Close computer setup"><X size={19} /></button>
      </header>
      <div className={styles.wizardBody}>
        <div className={styles.capacityIntro}><Server size={22} aria-hidden="true" /><div>
          <strong>Prepare once. Choose a desktop or agent afterward.</strong>
          <p>Hivra applies the confirmed firewall, starts this server, verifies its connection, and installs the versioned setup files. No new server or subscription is purchased here.</p>
        </div></div>
        {!requestedRuntimeSupported && <div className={styles.formError} role="alert">
          <AlertTriangle size={16} aria-hidden="true" /><span>This launch type is not supported by provider setup. Return to launch to choose compatible capacity.</span>
        </div>}
        {loading ? <p role="status">Loading saved setup…</p> : !current ? <div className={styles.providerInventoryEmpty}>
          <div><strong>No Hivra-created computers to prepare.</strong><span>Create a cloud server and select automatic setup when reviewing it. Existing servers aren’t adopted or overwritten.</span></div>
        </div> : <>
          {computers.length > 1 && <label className={styles.field}><span className={styles.fieldLabel}>Computer</span>
            <select disabled={running} value={current.orderId} onChange={event => setSelectedId(event.target.value)}>
              {computers.map(item => <option key={item.orderId} value={item.orderId}>{item.serverName}{item.stage === "retired" ? " — Computer retired" : ""}</option>)}
            </select></label>}
          <div className={`${styles.capacityResultHero} ${current.stage === "environment_prepared" ? styles.capacityResult_ready : styles.capacityResult_warning}`} role="status" aria-live="polite">
            {running ? <Loader2 size={22} className={styles.spin} aria-hidden="true" /> : current.stage === "environment_prepared" ? <CheckCircle2 size={22} aria-hidden="true" /> : <ShieldCheck size={22} aria-hidden="true" />}
            <div><span className={styles.sectionLabel}>{current.serverName}</span><h2>{PROVIDER_SETUP_STAGE_LABELS[current.stage]}</h2>
              {current.stage === "retired" ? <p>This computer’s saved setup is reference-only. It cannot be resumed or launched. Check its original resource cleanup to confirm whether provider billing has ended.</p>
                : current.stage === "not_requested" ? <p>This server was created without an enrollment recipe. Hivra will not replace its first-boot configuration. You can keep it, manage it in Hetzner, or remove it through the original resource cleanup.</p>
                : current.stage === "expired" ? <p>The one-time enrollment window expired. Hivra won’t replace the key or start a different server. Inspect or remove this original computer before creating another.</p>
                  : current.stage === "environment_prepared" ? <p>{current.launchReady
                    ? "Setup is complete. Choose a desktop or agent next; launch will check this computer’s current compatibility. Setup itself does not launch a desktop or agent."
                    : "The setup files were verified, but this computer has not passed launch admission. It is not a running agent."}</p>
                    : <p>Steps use the saved server identity. An uncertain result stays visible and is never treated as success.</p>}
            </div>
          </div>
          <div className={styles.capacityBoundary}><ShieldCheck size={18} aria-hidden="true" /><div>
            <strong>Provider VM isolation, without nested Proxmox.</strong>
            <span>This server is one exclusive computer. Hivra does not silently switch to shared containers. Preparing it does not launch an agent; provider billing continues until its billable resources are removed.</span>
          </div></div>
        </>}
        {error && <div className={styles.formError} role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{error}</span></div>}
        <div className={styles.resultActions}>
          <button type="button" className={styles.secondaryButton} disabled={running} onClick={onClose}>Back to infrastructure</button>
          {!running && launchTargetId && requestedRuntimeSupported && <Link
            className={styles.primaryButton}
            href={launchResourceId
              ? buildLaunchSetupHref(launchResourceId, launchTargetId, { unified: unifiedLaunchReturn })
              : `/dashboard/launch?start=1&targetId=${encodeURIComponent(launchTargetId)}`}
          >{launchResourceId ? "Continue launch" : "Choose what to launch"}</Link>}
          {!running && !requestedRuntimeSupported && launchResourceId && <Link
            className={styles.primaryButton}
            href={buildLaunchSetupHref(launchResourceId, null, { unified: unifiedLaunchReturn })}
          >Choose compatible capacity</Link>}
          {running ? <button type="button" className={styles.secondaryButton} onClick={() => { stopped.current = true; setError("Pausing after the current step. Completed changes remain on the computer; you can resume this setup later."); }}>Pause after this step</button>
            : current && !isProviderComputerSetupTerminal(current) && <button type="button" className={styles.primaryButton} onClick={() => void run()} disabled={loading}>Continue setup</button>}
        </div>
      </div>
    </section>
  </div>;
}
