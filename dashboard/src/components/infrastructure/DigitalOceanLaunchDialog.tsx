"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, ArrowRight, Bot, CheckCircle2, LockKeyhole, Loader2, Play, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";

import { launchManagedSession, listDigitalOceanModels } from "@/lib/hivra/managed-session-client";
import {
  DIGITALOCEAN_HARNESS_LABELS,
  ManagedSessionLaunchSchema,
  type ManagedSessionDto,
} from "@/lib/hivra/managed-session-contracts";
import {
  DIGITALOCEAN_HARNESSES,
  type DigitalOceanConnectionDto,
  type DigitalOceanDeploymentTargetDto,
  type DigitalOceanHarness,
  type DigitalOceanSandboxSize,
} from "@/lib/infrastructure/contracts";

import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

const DEFAULT_SIZE: DigitalOceanSandboxSize = "mars-2vcpu-4gb";
const OTHER_MODEL = "__other__";

function defaultName(harness: DigitalOceanHarness): string {
  return `${DIGITALOCEAN_HARNESS_LABELS[harness].name} 1`;
}

export function DigitalOceanLaunchDialog({
  connection,
  target,
  onClose,
  returnFocusRef,
  onLaunched,
}: {
  connection: DigitalOceanConnectionDto;
  target: DigitalOceanDeploymentTargetDto;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onLaunched: (session: ManagedSessionDto) => void;
}) {
  const harnesses = DIGITALOCEAN_HARNESSES.filter((harness) => target.capabilities.harnesses.includes(harness));
  const [harness, setHarness] = useState<DigitalOceanHarness>(harnesses[0] ?? "claude-code");
  const sizes = target.capacity.sizes;
  const [size, setSize] = useState<DigitalOceanSandboxSize>(
    sizes.some((option) => option.slug === DEFAULT_SIZE) ? DEFAULT_SIZE : (sizes[0]?.slug ?? DEFAULT_SIZE),
  );
  const [name, setName] = useState(() => defaultName(harnesses[0] ?? "claude-code"));
  const [nameEdited, setNameEdited] = useState(false);
  const [modelMode, setModelMode] = useState<"vendor" | "digitalocean-inference">("vendor");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [models, setModels] = useState<{ state: "idle" | "loading" | "ready" | "failed"; ids: string[]; error?: string }>({ state: "idle", ids: [] });
  const [firstTask, setFirstTask] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState<ManagedSessionDto | null>(null);
  // One id per dialog: a retried submit after a lost response replays the
  // same launch instead of creating a second billable session.
  const launchRequestId = useMemo(() => crypto.randomUUID(), []);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const ids = { name: useId(), key: useId(), model: useId(), task: useId(), size: useId() };
  const dialogRef = useInfrastructureDialog({ onClose, closeOnEscape: !launching, initialFocusRef: closeButtonRef, returnFocusRef });
  const vendorKey = DIGITALOCEAN_HARNESS_LABELS[harness].vendorKey;
  const effectiveMode = vendorKey ? modelMode : "digitalocean-inference";
  const wantModels = effectiveMode === "digitalocean-inference";
  const modelsLoaded = useRef(false);

  // Fill the model list from DigitalOcean once Inference is chosen, so the
  // owner picks a model instead of typing a slug. Switching away mid-request
  // cancels it and a later switch back asks again.
  useEffect(() => {
    if (!wantModels || modelsLoaded.current) return;
    const controller = new AbortController();
    let settled = false;
    setModels({ state: "loading", ids: [] });
    listDigitalOceanModels(connection.id, controller.signal)
      .then((ids) => {
        settled = true;
        modelsLoaded.current = true;
        setModels({ state: "ready", ids });
        setModelChoice((current) => current || ids[0] || OTHER_MODEL);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        settled = true;
        modelsLoaded.current = true;
        setModels({ state: "failed", ids: [], error: cause instanceof Error ? cause.message : "DigitalOcean's model list could not be loaded." });
        setModelChoice(OTHER_MODEL);
      });
    return () => {
      controller.abort();
      if (!settled) setModels({ state: "idle", ids: [] });
    };
  }, [connection.id, wantModels]);
  const chosenModel = modelChoice && modelChoice !== OTHER_MODEL ? modelChoice : model.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed = ManagedSessionLaunchSchema.safeParse({
      launchRequestId,
      connectionId: connection.id,
      targetId: target.id,
      harness,
      size,
      name: name.trim(),
      model: effectiveMode === "vendor" ? { mode: "vendor", apiKey } : { mode: "digitalocean-inference", apiKey, model: chosenModel },
      firstTask: firstTask.trim() || undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the launch settings.");
      return;
    }
    setLaunching(true);
    try {
      const session = await launchManagedSession(parsed.data);
      setApiKey("");
      setLaunched(session);
      onLaunched(session);
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : "DigitalOcean did not start the session.");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className={styles.modalBackdrop}>
      <section ref={dialogRef} className={`${styles.wizard} ${styles.providerConnectionDialog}`} role="dialog" aria-modal="true" aria-labelledby="digitalocean-launch-title" tabIndex={-1}>
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>{connection.name}</span>
            <h1 id="digitalocean-launch-title">Launch an agent on DigitalOcean</h1>
          </div>
          <button ref={closeButtonRef} type="button" className={styles.closeButton} onClick={onClose} disabled={launching} aria-label="Close launch">
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.wizardBody}>
          {launched ? (
            <div className={styles.providerGuide} role="status">
              <span className={styles.providerGuideIcon} aria-hidden="true"><CheckCircle2 size={20} /></span>
              <div>
                <strong>{launched.status === "ready" ? `${launched.name} is ready on DigitalOcean.` : `DigitalOcean is starting ${launched.name}.`}</strong>
                <p>Open its chat to send tasks and answer approvals. You can pause or delete it there.</p>
                <div className={styles.wizardActions}>
                  <button type="button" className={styles.secondaryButton} onClick={onClose}>Close</button>
                  <Link className={styles.primaryButton} href={`/dashboard/agent/${encodeURIComponent(launched.agentId)}`}>
                    Open chat <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </div>
              </div>
            </div>
          ) : (
          <form onSubmit={handleSubmit} noValidate>
            <div className={styles.formSection}>
              <div className={styles.formSectionHeading}>
                <span className={styles.sectionNumber}>01</span>
                <div><h2>Choose the agent</h2><p>Each agent gets its own DigitalOcean session with a persistent workspace.</p></div>
              </div>
              <div className={styles.guidedChoicesTwo} role="radiogroup" aria-label="Agent">
                {harnesses.map((option) => (
                  <label key={option} className={styles.guidedChoice} style={{ cursor: "pointer", outline: option === harness ? "2px solid var(--ink-black)" : undefined }}>
                    <input type="radio" name="harness" value={option} checked={option === harness} onChange={() => { setHarness(option); if (!nameEdited) setName(defaultName(option)); }} className={styles.srOnly} />
                    <Bot size={18} aria-hidden="true" />
                    <h3>{DIGITALOCEAN_HARNESS_LABELS[option].name}</h3>
                    <small>{DIGITALOCEAN_HARNESS_LABELS[option].vendorKey ? `Your ${DIGITALOCEAN_HARNESS_LABELS[option].vendorKey} or DigitalOcean Inference` : "DigitalOcean Inference"}</small>
                  </label>
                ))}
              </div>
              <div className={styles.formGrid}>
                <label className={styles.field} htmlFor={ids.name}>
                  <span className={styles.fieldLabel}>Agent name</span>
                  <input id={ids.name} value={name} onChange={(event) => { setName(event.target.value); setNameEdited(true); }} maxLength={64} autoComplete="off" required />
                </label>
                <label className={styles.field} htmlFor={ids.size}>
                  <span className={styles.fieldLabel}>Sandbox size</span>
                  <select id={ids.size} value={size} onChange={(event) => setSize(event.target.value as DigitalOceanSandboxSize)}>
                    {sizes.map((option) => (
                      <option key={option.slug} value={option.slug}>
                        {option.vcpus || option.slug.split("-")[1]} vCPU · {option.memoryMb ? `${Math.round(option.memoryMb / 1024)} GB` : option.slug.split("-")[2]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className={styles.formSection}>
              <div className={styles.formSectionHeading}>
                <span className={styles.sectionNumber}>02</span>
                <div><h2>Model access</h2><p>Sent to DigitalOcean as a write-only session secret. Hivra does not store it.</p></div>
              </div>
              {vendorKey ? (
                <div className={styles.formGrid} role="radiogroup" aria-label="Model access">
                  <label className={styles.field}>
                    <span><input type="radio" name="model-mode" checked={modelMode === "vendor"} onChange={() => setModelMode("vendor")} /> {vendorKey}</span>
                  </label>
                  <label className={styles.field}>
                    <span><input type="radio" name="model-mode" checked={modelMode === "digitalocean-inference"} onChange={() => setModelMode("digitalocean-inference")} /> DigitalOcean Inference</span>
                  </label>
                </div>
              ) : null}
              <div className={styles.formGrid}>
                <label className={`${styles.field} ${styles.fullField}`} htmlFor={ids.key}>
                  <span className={styles.fieldLabel}>{effectiveMode === "vendor" ? vendorKey : "DigitalOcean model access key"}</span>
                  <span className={styles.secretField}>
                    <LockKeyhole size={17} aria-hidden="true" />
                    <input id={ids.key} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={512} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-lpignore="true" required />
                  </span>
                </label>
                {effectiveMode === "digitalocean-inference" ? (
                  <>
                    <label className={`${styles.field} ${styles.fullField}`} htmlFor={`${ids.model}-choice`}>
                      <span className={styles.fieldLabel}>DigitalOcean model</span>
                      <select
                        id={`${ids.model}-choice`}
                        value={modelChoice}
                        disabled={models.state === "loading"}
                        onChange={(event) => setModelChoice(event.target.value)}
                      >
                        {models.state === "loading" ? <option value="">Loading DigitalOcean’s models…</option> : null}
                        {models.ids.map((id) => <option key={id} value={id}>{id}</option>)}
                        <option value={OTHER_MODEL}>Enter a model id…</option>
                      </select>
                      <span className={models.state === "failed" ? styles.fieldError : styles.fieldHint}>
                        {models.state === "failed"
                          ? `${models.error} Enter the model id instead.`
                          : "Models DigitalOcean Serverless Inference offers your team."}
                      </span>
                    </label>
                    {modelChoice === OTHER_MODEL ? (
                      <label className={`${styles.field} ${styles.fullField}`} htmlFor={ids.model}>
                        <span className={styles.fieldLabel}>Model id</span>
                        <input id={ids.model} value={model} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-v4-pro" maxLength={128} autoComplete="off" required />
                      </label>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>

            <div className={styles.formSection}>
              <div className={styles.formSectionHeading}>
                <span className={styles.sectionNumber}>03</span>
                <div><h2>First task (optional)</h2><p>Sent as the first message once the session is ready.</p></div>
              </div>
              <label className={`${styles.field} ${styles.fullField}`} htmlFor={ids.task}>
                <span className={styles.srOnly}>First task</span>
                <textarea id={ids.task} rows={3} value={firstTask} onChange={(event) => setFirstTask(event.target.value)} maxLength={8000} />
              </label>
            </div>

            <div className={styles.providerSafetyNote}>
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>This starts billing in your DigitalOcean team.</strong>
                <span>
                  DigitalOcean charges per active vCPU-second and peak memory while the session runs, plus workspace
                  storage while it is paused. Sessions pause after 15 minutes idle. Model usage bills separately.
                  Commands, file writes outside the workspace, and GitHub pushes wait for your approval in Hivra.
                </span>
              </div>
            </div>

            {error ? <div className={styles.formError} role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{error}</span></div> : null}

            <div className={styles.wizardActions}>
              <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={launching}>
                <ArrowLeft size={14} aria-hidden="true" /> Cancel
              </button>
              <button type="submit" className={styles.primaryButton} disabled={launching}>
                {launching ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                {launching ? "Starting on DigitalOcean…" : "Launch and start billing"}
              </button>
            </div>
          </form>
          )}
        </div>
      </section>
    </div>
  );
}
