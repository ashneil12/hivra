"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Network,
  PackageCheck,
  ServerCog,
  X,
} from "lucide-react";

import {
  prepareInfrastructureConnection,
  type InfrastructurePreparation,
} from "@/lib/infrastructure/client";
import type { InfrastructureConnectionDto } from "@/lib/infrastructure/contracts";
import { preflightHeadline } from "@/lib/infrastructure/formatters";

import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

type PreparationPhase = "confirm" | "preparing" | "success" | "failure";

export function InfrastructurePrepareDialog({
  connection,
  onClose,
  onPrepared,
}: {
  connection: InfrastructureConnectionDto;
  onClose: () => void;
  onPrepared: (preparation: InfrastructurePreparation) => Promise<void>;
}) {
  const [phase, setPhase] = useState<PreparationPhase>("confirm");
  const [preparation, setPreparation] = useState<InfrastructurePreparation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: phase !== "preparing",
    initialFocusRef: cancelRef,
  });

  useEffect(() => {
    if (phase === "confirm") {
      cancelRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [phase]);

  async function prepareHost() {
    setPhase("preparing");
    setError(null);
    try {
      const result = await prepareInfrastructureConnection(connection.id);
      await onPrepared(result);
      setPreparation(result);
      setPhase("success");
    } catch (prepareError) {
      setError(
        prepareError instanceof Error
          ? prepareError.message
          : "Hivra could not prepare this host.",
      );
      setPhase("failure");
    }
  }

  const headline = preparation ? preflightHeadline(preparation.preflight) : null;

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={`${styles.confirmDialog} ${styles.prepareDialog}`}
        role={phase === "failure" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="prepare-host-title"
        aria-describedby="prepare-host-description"
        tabIndex={-1}
      >
        {phase === "confirm" ? (
          <>
            <span className={styles.prepareIcon} aria-hidden="true"><ServerCog size={21} /></span>
            <span className={styles.eyebrow}>Review host changes</span>
            <h2 ref={headingRef} tabIndex={-1} id="prepare-host-title">Prepare the recommended setup on {connection.name}?</h2>
            <p id="prepare-host-description">
              Hivra will install its current versioned host tools and configure the
              dedicated network used by isolated agent computers. This changes the host,
              but it does not create or start an agent.
            </p>
            <ul className={styles.prepareList}>
              <li><PackageCheck size={15} aria-hidden="true" /><span>Install and verify the versioned Hivra host tools</span></li>
              <li><Network size={15} aria-hidden="true" /><span>Configure the dedicated agent network and required host assets</span></li>
              <li><CheckCircle2 size={15} aria-hidden="true" /><span>Run a fresh readiness check and save its measured evidence</span></li>
            </ul>
            <div className={styles.resultActions}>
              <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={styles.primaryButton} onClick={() => void prepareHost()}>
                <ServerCog size={14} aria-hidden="true" /> Prepare recommended setup
              </button>
            </div>
          </>
        ) : phase === "preparing" ? (
          <div className={styles.preparingHost} role="status" aria-live="polite">
            <span className={styles.checkingVisual} aria-hidden="true">
              <ServerCog size={28} />
              <span />
              <Loader2 size={18} className={styles.spin} />
            </span>
            <span className={styles.eyebrow}>Preparing recommended setup</span>
            <h2 ref={headingRef} tabIndex={-1} id="prepare-host-title">Installing Hivra on {connection.name}...</h2>
            <p id="prepare-host-description">
              Keep this window open. Hivra is installing its host tools, configuring the
              network, and recording a fresh readiness check. No agent is being created.
            </p>
          </div>
        ) : phase === "success" && preparation && headline ? (
          <>
            <span className={styles.successIcon} aria-hidden="true"><CheckCircle2 size={21} /></span>
            <span className={styles.eyebrow}>Host ready</span>
            <h2 ref={headingRef} tabIndex={-1} id="prepare-host-title">
              {preparation.preflight.ok && preparation.preflight.target.launchReady
                ? `${connection.name} is ready for agents.`
                : `${connection.name} was prepared, but still needs attention.`}
            </h2>
            <p id="prepare-host-description">{headline.detail}</p>
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
            <div className={styles.resultActions}>
              <button ref={cancelRef} type="button" className={styles.primaryButton} onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <span className={styles.dangerIcon} aria-hidden="true"><AlertTriangle size={21} /></span>
            <span className={styles.eyebrow}>Preparation stopped</span>
            <h2 ref={headingRef} tabIndex={-1} id="prepare-host-title">The host was not prepared.</h2>
            <p id="prepare-host-description">{error}</p>
            <div className={styles.resultActions}>
              <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={onClose}>Close</button>
              <button type="button" className={styles.primaryButton} onClick={() => setPhase("confirm")}>
                Review and try again
              </button>
            </div>
          </>
        )}

        {phase !== "preparing" ? (
          <button
            type="button"
            className={styles.prepareCloseButton}
            onClick={onClose}
            aria-label="Close host preparation"
          >
            <X size={17} aria-hidden="true" />
          </button>
        ) : null}
      </section>
    </div>
  );
}
