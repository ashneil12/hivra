import type { ActivityEvent } from "@/lib/activity-observability/types";
import { groupActivityRuns, presentRunStep } from "./run-groups";
import styles from "./ActivityObservatory.module.css";

function Steps({
  events,
  selected,
  onSelect,
}: {
  events: ActivityEvent[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ol className={styles.runSteps}>
      {events.map((event) => {
        const step = presentRunStep(event);
        return (
          <li key={event.id}>
            <button
              className={styles.event}
              aria-pressed={event.id === selected}
              onClick={() => onSelect(event.id)}
            >
              <span aria-hidden="true">↳</span>
              <span>
                <strong>{step.title}</strong>
                <span className={styles.meta}>
                  {event.agentName} ·{" "}
                  <time dateTime={event.occurredAt}>
                    {new Date(event.occurredAt).toLocaleString()}
                  </time>
                </span>
                <span className={styles.eventBottom}>
                  <span
                    className={
                      event.outcome === "failure" || event.severity === "error"
                        ? styles.warning
                        : undefined
                    }
                  >
                    {step.status}
                  </span>
                  <span>{step.duration ?? "Duration not reported"}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function AgentRuns({
  events,
  selected,
  onSelect,
  limited,
}: {
  events: ActivityEvent[];
  selected?: string;
  onSelect: (id: string) => void;
  limited: boolean;
}) {
  const { groups, ungrouped } = groupActivityRuns(events);
  return (
    <section aria-label="Agent runs" className={styles.runs}>
      <p className={styles.muted}>
        Steps are shown oldest first within each group. These are the reports
        loaded here, not a complete account of a run. A run’s final result is
        not confirmed by this history.
      </p>
      {limited && (
        <p className={styles.viewHelp}>
          Some records are missing or outside this view. A run may have earlier,
          later, or hidden steps.
        </p>
      )}
      {!groups.length && (
        <p className={styles.empty}>
          No linked agent runs are shown in these records. Reports need a run or
          trace identifier to appear together.
        </p>
      )}
      {groups.map((group) => (
        <article
          key={group.key}
          className={styles.runGroup}
          aria-label={`${group.agentName} ${group.correlation === "run" ? "run" : "trace group"}`}
        >
          <div className={styles.runHeading}>
            <h3>
              {group.agentName} ·{" "}
              {group.correlation === "run"
                ? "Run reports"
                : "Linked action reports"}
            </h3>
            <span className={group.hasFailures ? styles.warning : styles.muted}>
              {group.hasFailures
                ? "A step reported a problem"
                : "Final result not confirmed"}
            </span>
          </div>
          <p className={styles.muted}>
            {group.steps.length} loaded{" "}
            {group.steps.length === 1 ? "step" : "steps"}
            {group.correlation === "trace"
              ? " · Linked by a trace; no run identifier was supplied."
              : "."}
          </p>
          <details className={styles.technical}>
            <summary>Technical run details</summary>
            <dl className={styles.facts}>
              <div>
                <dt>Agent ID</dt>
                <dd>{group.agentId}</dd>
              </div>
              <div>
                <dt>{group.correlation === "run" ? "Run ID" : "Trace ID"}</dt>
                <dd>{group.correlationId}</dd>
              </div>
            </dl>
          </details>
          <Steps events={group.steps} selected={selected} onSelect={onSelect} />
        </article>
      ))}
      {ungrouped.length > 0 && (
        <section
          aria-label="Ungrouped agent reports"
          className={styles.runGroup}
        >
          <h3>Reports without a linked run</h3>
          <p className={styles.muted}>
            These reports have no usable run or trace identifier. Hivra cannot
            tell which work they belong to.
          </p>
          <Steps events={ungrouped} selected={selected} onSelect={onSelect} />
        </section>
      )}
    </section>
  );
}
