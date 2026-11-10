import styles from "./LoadingState.module.css";
import { ThinkingOrb } from "./ThinkingOrb";

type LoadingStateProps = {
  label?: string;
  detail?: string;
  /** Compact panels keep their surrounding controls visible. */
  compact?: boolean;
  dark?: boolean;
};

/** Indeterminate activity only: never implies measured progress or readiness. */
export function LoadingState({ label = "Opening Hivra…", detail, compact = false, dark = false }: LoadingStateProps) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className={`${styles.surface} ${compact ? styles.compact : ""} ${dark ? styles.dark : ""}`}>
      <div className={styles.content}>
        <div className={styles.mark} aria-hidden="true"><ThinkingOrb state="working" size={64} theme={dark ? "dark" : "auto"} /></div>
        <p className={styles.label}>{label}</p>
        {detail && <p className={styles.detail}>{detail}</p>}
      </div>
    </div>
  );
}
