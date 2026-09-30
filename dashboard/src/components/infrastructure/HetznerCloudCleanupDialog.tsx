"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Trash2, X } from "lucide-react";
import { HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION, type HetznerCloudConnectionDto } from "@/lib/infrastructure/contracts";
import { HETZNER_CLEANUP_CONFIRMATION, HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION } from "@/lib/infrastructure/hetzner-cleanup-contracts";
import { advanceCleanup, cleanupErrorMessage, forgetCleanupAccess, listCleanupOrders, previewCleanup, type HetznerCleanupView } from "@/lib/infrastructure/hetzner-cleanup-client";
import { useInfrastructureDialog } from "./useInfrastructureDialog";
import styles from "./Infrastructure.module.css";

const RESOURCE_LABELS = {server:"Cloud server",ipv4:"Primary IPv4",ipv6:"Primary IPv6",sshKey:"Generated SSH key",firewall:"Setup firewall"};
export function HetznerCloudCleanupDialog({connection,onClose,onComplete,onForgot}: {
  connection:HetznerCloudConnectionDto;onClose:()=>void;onComplete:()=>void;onForgot?:()=>void;
}) {
  const [orders,setOrders] = useState<HetznerCleanupView[]>([]);
  const [current,setCurrent] = useState<HetznerCleanupView|null>(null);
  const [loading,setLoading] = useState(true);
  const [running,setRunning] = useState(false);
  const [reviewed,setReviewed] = useState(false);
  const [typedName,setTypedName] = useState("");
  const [error,setError] = useState<string|null>(null);
  const [forgetText,setForgetText] = useState("");
  const runningRef = useRef(false);
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useInfrastructureDialog({onClose,closeOnEscape:!running,initialFocusRef:heading});
  const inputId = useId();
  async function review(order:HetznerCleanupView) {
    setCurrent(order); setReviewed(false); setTypedName(""); setError(null);
    if (!order.eligible) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await previewCleanup(connection.id,order.orderId);
      if (alive.current) {setCurrent(result);setReviewed(true);}
    } catch (failure) {if(alive.current)setError(failure instanceof Error ? failure.message : cleanupErrorMessage(null));}
    finally {if(alive.current)setLoading(false);}
  }
  useEffect(()=>{
    alive.current=true;
    void listCleanupOrders(connection.id).then(async result=>{
      if(!alive.current)return;
      setOrders(result.orders);
      const first = result.orders.find(order=>order.status!=="deleted") ?? result.orders[0];
      if(first) await review(first); else setLoading(false);
    }).catch(failure=>{if(alive.current){setError(failure instanceof Error ? failure.message : cleanupErrorMessage(null));setLoading(false);}});
    return ()=>{alive.current=false;};
    // Connection identity fixes the scope of this dialog instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[connection.id]);
  async function remove() {
    if(runningRef.current || !current?.eligible || !current.fingerprint || !reviewed
      || typedName !== current.serverName || current.status === "deleted")return;
    runningRef.current=true;setRunning(true);setError(null);
    try {
      const idempotencyKey = current.cleanup?.idempotencyKey ?? crypto.randomUUID();
      const request = {orderId:current.orderId,idempotencyKey,fingerprint:current.fingerprint,
        serverName:current.serverName,confirmation:current.resources?.firewall ? HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION : HETZNER_CLEANUP_CONFIRMATION};
      // Four or five exact resources, plus one observation-only pass.
      const maxSteps = current.resources?.firewall ? 6 : 5;
      for(let step=0;step<maxSteps && alive.current;step+=1) {
        const result = await advanceCleanup(connection.id,request);
        if(!alive.current)return;
        setCurrent(result);
        if(result.status==="deleted"){setTypedName("");onComplete();return;}
        if(result.busy){setError("Another cleanup step is still running. Its saved operation is retained; reopen or resume after it finishes.");return;}
        if(result.cleanup?.error){setError(cleanupErrorMessage(result.cleanup.error));return;}
      }
      if(alive.current)setError("Hetzner has not confirmed every removal yet. Resume this saved cleanup after the provider finishes.");
    } catch(failure) {if(alive.current)setError(failure instanceof Error ? failure.message : cleanupErrorMessage(null));}
    finally{runningRef.current=false;if(alive.current)setRunning(false);}
  }
  const absence = current?.cleanup?.absence ?? current?.observedAbsence;
  const complete = current?.status==="deleted";
  const nameMismatch = typedName.length>0 && typedName!==current?.serverName;
  const forgetMismatch = forgetText.length>0 && forgetText!==HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION;
  async function forgetAccess() {
    if(runningRef.current || !current?.cleanup || !current.fingerprint || forgetText!==HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION)return;
    runningRef.current=true;setRunning(true);setError(null);
    try {
      await forgetCleanupAccess(connection.id,{orderId:current.orderId,idempotencyKey:current.cleanup.idempotencyKey,
        fingerprint:current.fingerprint,confirmation:HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION});
      if(alive.current){onForgot?.();onClose();}
    } catch(failure){if(alive.current)setError(failure instanceof Error?failure.message:cleanupErrorMessage(null));}
    finally{runningRef.current=false;if(alive.current)setRunning(false);}
  }
  return <div className={styles.modalBackdrop}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={inputId+"-title"} tabIndex={-1} className={`${styles.wizard} ${styles.cleanupDialog}`}>
      <header className={styles.wizardHeader}>
        <div><span className={styles.eyebrow}>{connection.name} · Resource cleanup</span>
          <h1 ref={heading} tabIndex={-1} id={inputId+"-title"}>{complete ? "Removal verified." : current?.resources?.firewall ? "Remove this setup computer." : "Remove an unused server."}</h1></div>
        <button type="button" className={styles.closeButton} onClick={onClose} disabled={running} aria-label="Close server cleanup"><X size={18}/></button>
      </header>
      <div className={styles.cleanupContent}>
        <p>Review the exact resources Hivra created. Your project connection and unrelated servers stay untouched.</p>
        {orders.length>1 && <label className={styles.field}>Created server
          <select value={current?.orderId ?? ""} disabled={running||loading} onChange={event=>{
            const chosen=orders.find(order=>order.orderId===event.target.value);if(chosen)void review(chosen);
          }}>{orders.map(order=><option key={order.orderId} value={order.orderId}>{order.serverName}{order.status==="deleted" ? " · removed" : ""}</option>)}</select>
        </label>}
        {loading && <p role="status"><Loader2 size={16} className={styles.spin}/> Checking saved records and provider resources…</p>}
        {!loading && !current && !error && <p>No completed Hivra-created servers are attached to this project. Imported servers and unresolved launches must be reviewed in Hetzner Console.</p>}
        {current && !current.eligible && <p role="status">{cleanupErrorMessage("not_eligible")}</p>}
        {current?.resources && <dl className={styles.cleanupResources} aria-label="Exact resources to remove">
          {(Object.keys(current.resources) as Array<keyof typeof RESOURCE_LABELS>).map(kind=><div key={kind}>
            <dt>{RESOURCE_LABELS[kind]}</dt><dd>#{current.resources![kind]}</dd>
            <dd>{absence?.[kind] ? <><CheckCircle2 size={13}/> Verified absent</> : running ? "Awaiting removal evidence" : reviewed ? "Not yet removed" : "Not checked"}</dd>
          </div>)}
        </dl>}
        {complete ? <div className={styles.capacityBoundary}><CheckCircle2 size={18}/><div>
          <strong>{current.resources?.firewall ? "All five original resources are confirmed absent." : "All four original resources are confirmed absent."}</strong><span>The encrypted bootstrap key is erased and the Hivra capacity slot is released. Accrued Hetzner charges still apply. Deleted server data cannot be recovered.</span>
        </div></div> : current?.eligible && <>
          <div className={styles.capacityBoundary}><AlertTriangle size={18}/><div><strong>This deletes the server and its data.</strong>
            <span>Hivra also checks both original IP addresses and removes its generated project SSH key. Charges can continue until billable resources are gone. Protected or reassigned resources stop cleanup for your review.</span>
            {current.resources?.firewall && <span>The setup-owned firewall is included. This can permanently delete a computer started during setup; stopping setup or closing this dialog does not stop Hetzner billing.</span>}
          </div></div>
          <div className={styles.field}>
            <label htmlFor={inputId}>Type <strong>{current.serverName}</strong> to confirm</label>
            <input id={inputId} value={typedName} disabled={running||loading} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              aria-describedby={nameMismatch ? inputId+"-mismatch" : undefined} onChange={event=>setTypedName(event.target.value)}/>
            {nameMismatch && <span id={inputId+"-mismatch"} className={styles.fieldHint}>Doesn&apos;t match yet</span>}
          </div>
        </>}
        {error && <div className={styles.formError} role="alert"><AlertTriangle size={17}/><span>{error}</span></div>}
        {running && <p role="status" aria-live="polite">Removing only the confirmed resources. Each result is saved; if the page closes, reopen this cleanup to resume.</p>}
        <div className={styles.resultActions}>
          <button type="button" onClick={onClose} disabled={running} className={styles.secondaryButton}>{complete ? "Done" : "Close"}</button>
          {!complete && current?.eligible && <button type="button" className={styles.primaryButton} disabled={running||loading||!reviewed||typedName!==current.serverName} onClick={()=>void remove()}>
            {running ? <Loader2 size={15} className={styles.spin}/> : <Trash2 size={15}/>}
            {running ? "Removing…" : current.cleanup ? "Resume cleanup" : "Delete confirmed resources"}
          </button>}
        </div>
        <a className={styles.tertiaryButton} href="https://console.hetzner.com/projects" target="_blank" rel="noopener noreferrer">Open Hetzner Console</a>
        {current?.cleanup && !complete && <details className={styles.cleanupFallback}>
          <summary>Cannot access the project anymore?</summary>
          <p>You can explicitly forget Hivra access after the active cleanup step finishes. This erases the saved project token and bootstrap private key, but does not remove provider resources or stop their charges. The unresolved capacity claim stays held. You will need to finish recovery directly in Hetzner; this cleanup cannot resume after forgetting.</p>
          <div className={styles.field}>
            <label htmlFor={inputId+"-forget"}>Type {HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION}</label>
            <input id={inputId+"-forget"} value={forgetText} disabled={running} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              aria-describedby={forgetMismatch ? inputId+"-forget-mismatch" : undefined} onChange={event=>setForgetText(event.target.value)}/>
            {forgetMismatch && <span id={inputId+"-forget-mismatch"} className={styles.fieldHint}>Doesn&apos;t match yet</span>}
          </div>
          <button type="button" className={styles.secondaryButton} disabled={running||forgetText!==HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION} onClick={()=>void forgetAccess()}>Forget access, keep provider resources</button>
        </details>}
      </div>
    </section>
  </div>;
}
