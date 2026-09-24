"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  ServerCog,
  X,
} from "lucide-react";

import {
  prepareGvisorConnection,
  prepareInfrastructureConnection,
  type GvisorTargetResult,
  type InfrastructurePreparation,
} from "@/lib/infrastructure/client";
import type { InfrastructureConnectionDto } from "@/lib/infrastructure/contracts";
import { preflightHeadline } from "@/lib/infrastructure/formatters";
import {
  hostPreparationFailure,
  preparationSteps,
  type HostPreparationEngine,
  type HostPreparationFailure,
} from "@/lib/infrastructure/host-preparation-steps";
import type { GvisorReadinessCheck } from "@/lib/infrastructure/launch-on-server";

import styles from "./Infrastructure.module.css";
import { HostSetupProgress } from "./HostSetupProgress";
import { LaunchOnServerLink, useGvisorCheckLaunchAction, useLaunchOnServer } from "./LaunchOnServer";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

type PreparationPhase = "review" | "running" | "success" | "failure";
type StepState = "waiting" | "done" | "failed" | "attention";

function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The one review dialog for every host setup Hivra runs over SSH: Proxmox's
 * recommended setup and Linux Sandbox (gVisor). It names each step before
 * anything changes, can't be closed while a step runs, and afterwards marks
 * only what it observed.
 */
export function InfrastructurePrepareDialog({
  connection,
  engine = "proxmox",
  mode = "prepare",
  continuesHostSetup = false,
  onClose,
  onPrepared,
  onGvisorPrepared,
}: {
  connection: InfrastructureConnectionDto;
  engine?: HostPreparationEngine;
  /** "repair" reinstalls an existing Linux Sandbox setup. */
  mode?: "prepare" | "repair";
  /** Opened from the connection wizard: it carries on the wizard's
   * Connect → Ready progress bar at Prepare, and ends on Ready. */
  continuesHostSetup?: boolean;
  onClose: () => void;
  onPrepared?: (preparation: InfrastructurePreparation) => Promise<void>;
  onGvisorPrepared?: (target: GvisorTargetResult) => Promise<void>;
}) {
  const [phase, setPhase] = useState<PreparationPhase>("review");
  const [preparation, setPreparation] = useState<InfrastructurePreparation | null>(null);
  const [gvisorTarget, setGvisorTarget] = useState<GvisorTargetResult | null>(null);
  // When setup's final check passed in this browser; it authorizes a launch
  // for 15 minutes.
  const [gvisorCheck, setGvisorCheck] = useState<GvisorReadinessCheck | null>(null);
  const [failure, setFailure] = useState<HostPreparationFailure | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const running = phase === "running";
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: !running,
    initialFocusRef: cancelRef,
  });
  const launch = useLaunchOnServer();
  const steps = preparationSteps(engine);
  const name = connection.name;

  useEffect(() => {
    if (phase === "review") {
      cancelRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [phase]);

  // Handed over from the wizard, whose closing returns focus to the control
  // that opened it and can scroll the page away. Keep this dialog's top, and
  // the progress bar carried on there, in view as each phase resizes it.
  useEffect(() => {
    if (continuesHostSetup) dialogRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [continuesHostSetup, dialogRef, phase]);

  // Leaving mid-step would hide the result the owner is waiting for.
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", warn);
    };
  }, [running]);

  async function run() {
    const started = Date.now();
    setStartedAt(started);
    setNow(started);
    setPhase("running");
    setFailure(null);
    try {
      if (engine === "proxmox") {
        const result = await prepareInfrastructureConnection(connection.id);
        await onPrepared?.(result);
        setPreparation(result);
      } else {
        const result = await prepareGvisorConnection(connection.id);
        const checkedAt = Date.now();
        await onGvisorPrepared?.(result);
        setGvisorTarget(result);
        setGvisorCheck(result.ready ? { targetId: result.targetId, checkedAt } : null);
      }
      setPhase("success");
    } catch (error) {
      setFailure(hostPreparationFailure(error, engine, name));
      setPhase("failure");
    }
  }

  const proxmoxReady = Boolean(preparation?.preflight.ok && preparation.preflight.target.launchReady);
  const ready = engine === "proxmox" ? proxmoxReady : Boolean(gvisorTarget?.ready);
  const gvisorLaunchAction = useGvisorCheckLaunchAction(engine === "gvisor" && phase === "success" ? gvisorCheck : null);
  // Setup passed, but its check is now more than 15 minutes old.
  const gvisorCheckLapsed = engine === "gvisor" && phase === "success" && ready && gvisorLaunchAction === null;
  const launchAction = phase !== "success" || !ready
    ? null
    : engine === "gvisor"
      ? gvisorLaunchAction
      : preparation?.preflight.ok
        ? launch.forProxmoxConnection(connection.id, preparation.preflight.target.externalId)
        : null;

  // Ready only once setup finished and its check passed (and, for Linux
  // Sandbox, is still fresh). A stop or a failed check stays on Prepare.
  const hostSetupStep = phase === "success" && ready && !gvisorCheckLapsed ? "Ready" : "Prepare";

  const failedIndex = failure?.failedStepId ? steps.findIndex((step) => step.id === failure.failedStepId) : -1;
  const stepState = (index: number): StepState => {
    if (phase === "success") return ready || index < steps.length - 1 ? "done" : "attention";
    if (phase === "failure" && failedIndex >= 0) {
      return index < failedIndex ? "done" : index === failedIndex ? "failed" : "waiting";
    }
    return "waiting";
  };
  const showStepStates = phase === "success" || (phase === "failure" && failedIndex >= 0);

  const title = phase === "review"
    ? engine === "proxmox"
      ? `Set up ${name} for agents?`
      : mode === "repair"
        ? `Reinstall Linux Sandbox setup on ${name}?`
        : `Set up Linux Sandbox on ${name}?`
    : phase === "running"
      ? `Setting up ${name}…`
      : phase === "success"
        ? engine === "proxmox"
          ? proxmoxReady ? `${name} is ready for agents.` : `${name} was set up, but still needs attention.`
          : ready ? `${name} is ready for Linux Sandbox.` : `${name} was set up, but its check didn't pass.`
        : failure?.title ?? `${name} was not set up.`;

  const description = phase === "review"
    ? engine === "proxmox"
      ? "Hivra will make these changes on the server, in this order. It doesn't create an agent or buy anything."
      : mode === "repair"
        ? "Hivra installs its pinned setup again, then checks it. Use this when the readiness check keeps failing. It doesn't create a computer or buy anything."
        : "Hivra will install this software on the server, in this order. It doesn't create a computer or buy anything."
    : phase === "running"
      ? `Keep this window open. Setup can take up to ${engine === "gvisor" ? 6 : 4} minutes.`
      : phase === "success"
        ? engine === "proxmox" && preparation
          ? preflightHeadline(preparation.preflight).detail
          : gvisorCheckLapsed
            ? "This check is more than 15 minutes old. Check readiness from the server's card before you launch."
            : ready
              ? "Its check is good for 15 minutes. After that, check again before you launch."
              : "Inspect the server again to see what it needs."
        : failure?.detail ?? "";

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={[styles.confirmDialog, styles.prepareDialog, continuesHostSetup ? styles.prepareContinues : ""].filter(Boolean).join(" ")}
        role={phase === "failure" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="prepare-host-title"
        aria-describedby="prepare-host-description"
        aria-busy={running || undefined}
        tabIndex={-1}
      >
        {continuesHostSetup ? <HostSetupProgress current={hostSetupStep} className={styles.prepareProgress} /> : null}
        <span
          className={phase === "success" ? styles.successIcon : phase === "failure" ? styles.dangerIcon : styles.prepareIcon}
          aria-hidden="true"
        >
          {phase === "success" ? <CheckCircle2 size={21} />
            : phase === "failure" ? <AlertTriangle size={21} />
              : phase === "running" ? <Loader2 size={21} className={styles.spin} />
                : <ServerCog size={21} />}
        </span>
        <span className={styles.eyebrow}>
          {phase === "review" ? "Review the changes"
            : phase === "running" ? "Setup running"
              : phase === "success" ? "Setup finished" : "Setup stopped"}
        </span>
        <h2 ref={headingRef} tabIndex={-1} id="prepare-host-title">{title}</h2>
        <p id="prepare-host-description">{description}</p>

        {running && startedAt !== null ? (
          <p className={styles.prepareElapsed} role="status" aria-live="polite">
            <Clock3 size={14} aria-hidden="true" />
            <span>Running for <strong>{formatElapsed(now - startedAt)}</strong>. Each step&apos;s result shows here when setup reports back.</span>
          </p>
        ) : null}

        <ol className={styles.prepareSteps} aria-label="Setup steps">
          {steps.map((step, index) => {
            const state = showStepStates ? stepState(index) : "waiting";
            return (
              <li key={step.id} data-state={state}>
                <span className={styles.prepareStepMarker} aria-hidden="true">
                  {state === "done" ? <Check size={12} />
                    : state === "failed" || state === "attention" ? <AlertTriangle size={12} />
                      : index + 1}
                </span>
                <span>{step.label}</span>
                {state === "done" ? <span className={styles.srOnly}>, done</span>
                  : state === "failed" ? <span className={styles.srOnly}>, stopped here</span>
                    : state === "attention" ? <span className={styles.srOnly}>, needs attention</span> : null}
              </li>
            );
          })}
        </ol>

        {phase === "success" && engine === "proxmox" && preparation ? (
          <div className={styles.prepareReceipt}>
            <span>
              <small>Installed host tools</small>
              <strong>Hivra {preparation.provisionerVersion}</strong>
            </span>
            <span>
              <small>Agent created</small>
              <strong>No</strong>
            </span>
            <span>
              <small>Readiness check</small>
              <strong>Refreshed</strong>
            </span>
          </div>
        ) : null}
        {phase === "success" && engine === "gvisor" ? (
          <div className={styles.prepareReceipt}>
            <span>
              <small>Installed</small>
              <strong>Pinned gVisor release</strong>
            </span>
            <span>
              <small>Computer created</small>
              <strong>No</strong>
            </span>
            <span>
              <small>Readiness check</small>
              <strong>{ready ? "Passed" : "Needs attention"}</strong>
            </span>
          </div>
        ) : null}

        {running ? null : <div className={styles.resultActions}>
          {phase === "review" ? (
            <>
              <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={styles.primaryButton} onClick={() => void run()}>
                <ServerCog size={14} aria-hidden="true" />
                {engine === "proxmox" ? `Set up ${name}` : mode === "repair" ? "Reinstall setup" : "Set up Linux Sandbox"}
              </button>
            </>
          ) : phase === "success" ? (
            launchAction ? (
              <>
                <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={onClose}>Done</button>
                <LaunchOnServerLink action={launchAction} />
              </>
            ) : (
              <button ref={cancelRef} type="button" className={styles.primaryButton} onClick={onClose}>Done</button>
            )
          ) : (
            <>
              <button ref={cancelRef} type="button" className={failure?.canRetryNow ? styles.secondaryButton : styles.primaryButton} onClick={onClose}>
                Close
              </button>
              {failure?.canRetryNow ? (
                <button type="button" className={styles.primaryButton} onClick={() => setPhase("review")}>
                  Review and try again
                </button>
              ) : null}
            </>
          )}
        </div>}

        {!running ? (
          <button
            type="button"
            className={styles.prepareCloseButton}
            onClick={onClose}
            aria-label="Close host setup"
          >
            <X size={17} aria-hidden="true" />
          </button>
        ) : null}
      </section>
    </div>
  );
}
