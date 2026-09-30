import { CheckCircle2 } from "lucide-react";

import styles from "./Infrastructure.module.css";

/** The steps of connecting a host over SSH, as the connection wizard shows
 * them. The setup review dialog carries the same bar on from Prepare, so the
 * journey reads as one from Connect to Ready. */
export const HOST_SETUP_STEPS = ["Connect", "Inspect", "Recommend", "Prepare", "Ready"] as const;

export type HostSetupStep = (typeof HOST_SETUP_STEPS)[number];

/** The host setup progress bar, with `current` as the step on screen. */
export function HostSetupProgress({ current, className }: { current: HostSetupStep; className?: string }) {
  const active = HOST_SETUP_STEPS.indexOf(current);
  return (
    <ol className={[styles.wizardProgress, className].filter(Boolean).join(" ")} aria-label="Host setup progress">
      {HOST_SETUP_STEPS.map((step, index) => (
        <li
          key={step}
          className={index < active ? styles.progressDone : index === active ? styles.progressActive : undefined}
          aria-current={index === active ? "step" : undefined}
          aria-label={`${step}${index === active ? ", current" : index < active ? ", complete" : ""}`}
        >
          <span className={styles.progressMarker} aria-hidden="true">
            {index < active ? <CheckCircle2 size={13} /> : index + 1}
          </span>
          <span className={styles.progressText}>{step}</span>
        </li>
      ))}
    </ol>
  );
}
