"use client";

import { useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { HetznerCloudConnectionDto } from "@/lib/infrastructure/contracts";
import type { PortableLaunchResourceId } from "@/lib/hivra/launch-navigation";
import { ProviderComputerSetupPanel } from "./ProviderComputerSetupPanel";
import { useInfrastructureDialog } from "./useInfrastructureDialog";
import styles from "./Infrastructure.module.css";

export function ProviderComputerSetupDialog({ connection, orderId = null, launchResourceId = null, unifiedLaunchReturn = false, onClose, onChanged }: {
  connection: HetznerCloudConnectionDto;
  orderId?: string | null;
  launchResourceId?: PortableLaunchResourceId | null;
  unifiedLaunchReturn?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [running, setRunning] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), id = useId();
  const dialog = useInfrastructureDialog({ onClose, closeOnEscape: !running, initialFocusRef: heading });

  return <div className={styles.modalBackdrop}>
    <section ref={dialog} className={`${styles.wizard} ${styles.capacityDialog}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <header className={styles.wizardHeader}>
        <div><span className={styles.eyebrow}>{connection.name} · Hetzner server</span><h1 id={id} ref={heading} tabIndex={-1}>Set it up for agents</h1></div>
        <button type="button" className={styles.closeButton} onClick={onClose} disabled={running} aria-label="Close computer setup"><X size={19} /></button>
      </header>
      <div className={styles.wizardBody}>
        <ProviderComputerSetupPanel
          connection={connection}
          orderId={orderId}
          launchResourceId={launchResourceId}
          unifiedLaunchReturn={unifiedLaunchReturn}
          onChanged={onChanged}
          onRunningChange={setRunning}
          onClose={onClose}
        />
      </div>
    </section>
  </div>;
}
