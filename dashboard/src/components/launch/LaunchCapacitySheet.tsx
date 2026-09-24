"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

import { InfrastructureConnectionsPage } from "@/components/infrastructure/InfrastructureConnectionsPage";
import { useInfrastructureDialog } from "@/components/infrastructure/useInfrastructureDialog";
import type { PortableLaunchResourceId } from "@/lib/hivra/launch-navigation";

import styles from "./LaunchCapacitySheet.module.css";

/**
 * Capacity inside Launch: connecting a server or cloud account happens in a
 * sheet over the launch, and a ready place to run comes straight back to it.
 * Paying, creating a server and setting it up keep their own confirmations.
 */
export function LaunchCapacitySheet({
  launchResourceId,
  onLaunchTarget,
  onClose,
}: {
  launchResourceId: PortableLaunchResourceId | null;
  onLaunchTarget: (targetId: string) => void;
  onClose: () => void;
}) {
  // Escape closes only the sheet's own layer: an open connection or server
  // dialog inside it closes first.
  const sheetRef = useInfrastructureDialog({ onClose, closeOnEscape: false });
  useEffect(() => {
    const sheet = sheetRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !sheet) return;
      if (sheet.querySelector("[role='dialog'], [role='alertdialog']")) return;
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, sheetRef]);

  return (
    <div className={styles.backdrop}>
      <section
        ref={sheetRef as React.RefObject<HTMLElement>}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-capacity-sheet-heading"
        tabIndex={-1}
      >
        <div className={styles.toolbar}>
          <span className={styles.toolbarLabel}>Your launch is kept while you add capacity.</span>
          <button type="button" className={styles.close} onClick={onClose}>
            <X size={16} aria-hidden="true" /> Back to your launch
          </button>
        </div>
        <div className={styles.body}>
          <InfrastructureConnectionsPage embedded={{ launchResourceId, onLaunchTarget, onClose }} />
        </div>
      </section>
    </div>
  );
}
