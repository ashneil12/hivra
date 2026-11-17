import type { ComponentState, PublicStatus } from "@/lib/status/derive-status";

import styles from "./status-board.module.css";

const STATE_LABEL: Record<ComponentState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

const SEVERITY_LABEL = { degraded: "Degraded", down: "Down", maintenance: "Maintenance" } as const;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC";
}

// Server-rendered from the same data as /api/status. No client JavaScript.
export default function StatusBoard({ status }: { status: PublicStatus }) {
  return (
    <main className={styles.board}>
      <header className={styles.head}>
        <h1>Status</h1>
        <p className={styles.lead} data-state={status.overall.state}>
          <span className={styles.dot} aria-hidden="true" />
          {status.overall.headline}
        </p>
        <p className={styles.updated}>Updated {formatTime(status.generatedAt)}</p>
      </header>

      <ul className={styles.list} aria-label="Components">
        {status.components.map((c) => (
          <li key={c.key} className={styles.row} data-state={c.state}>
            <span>{c.name}</span>
            <span className={styles.state}>
              <span className={styles.dot} aria-hidden="true" />
              {STATE_LABEL[c.state]}
            </span>
          </li>
        ))}
      </ul>

      <section className={styles.incidents} aria-labelledby="incidents-title">
        <h2 id="incidents-title">Recent incidents</h2>
        {status.incidents.length === 0 ? (
          <p className={styles.empty}>No incidents in the last 30 days.</p>
        ) : (
          <ul>
            {status.incidents.map((i) => (
              <li key={i.id} className={styles.incident}>
                <p className={styles.incidentMeta}>
                  {SEVERITY_LABEL[i.severity]}
                  {i.component ? ` · ${i.component}` : ""} · {formatTime(i.startedAt)}
                  {i.resolvedAt ? ` · Resolved ${formatTime(i.resolvedAt)}` : " · Ongoing"}
                </p>
                <h3>{i.title}</h3>
                {i.body ? <p>{i.body}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
