import type { ActivityEvent } from "@/lib/activity-observability/types";
import {
  describeRunCounts,
  describeRunStatus,
  describeRunStep,
  groupActivityRuns,
  presentRunStep,
  type ActivityRunGroup,
  type ActivityRunStep,
} from "./run-groups";
import styles from "./ActivityObservatory.module.css";

const when = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
};

function StepRow({
  title,
  status,
  duration,
  warning,
  event,
  pressed,
  onSelect,
}: {
  title: string;
  status: string;
  duration?: string;
  warning: boolean;
  event: ActivityEvent;
  pressed: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        className={styles.event}
        aria-pressed={pressed}
        onClick={() => onSelect(event.id)}
      >
        <span aria-hidden="true">↳</span>
        <span>
          <strong>{title}</strong>
          <span className={styles.meta}>
            {event.agentName} ·{" "}
            <time dateTime={event.occurredAt}>{when(event.occurredAt)}</time>
          </span>
          <span className={styles.eventBottom}>
            <span className={warning ? styles.warning : undefined}>
              {status}
            </span>
            <span>{duration ?? "Duration not reported"}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function Steps({
  steps,
  selected,
  onSelect,
}: {
  steps: ActivityRunStep[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ol className={styles.runSteps}>
      {steps.map((step) => (
        <StepRow
          key={step.id}
          {...describeRunStep(step)}
          event={step.event}
          pressed={step.records.some((record) => record.id === selected)}
          onSelect={onSelect}
        />
      ))}
    </ol>
  );
}

function runHeading(group: ActivityRunGroup) {
  if (!group.native)
    return group.correlation === "run"
      ? "Run reports"
      : "Linked action reports";
  const producer = group.producer ?? "Agent";
  return group.delegated ? `${producer} delegated run` : `${producer} run`;
}

function RunGroup({
  group,
  selected,
  onSelect,
}: {
  group: ActivityRunGroup;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const status = describeRunStatus(group);
  const label = group.native
    ? `${group.agentName} ${runHeading(group)}`
    : `${group.agentName} ${group.correlation === "run" ? "run" : "trace group"}`;
  return (
    <article className={styles.runGroup} aria-label={label}>
      <div className={styles.runHeading}>
        <h3>
          {group.agentName} · {runHeading(group)}
        </h3>
        <span className={status.warning ? styles.warning : styles.muted}>
          {status.text}
        </span>
      </div>
      {group.native ? (
        <p className={styles.muted}>
          {group.incomplete ? "Earliest loaded step" : "Started"}{" "}
          <time dateTime={group.startedAt}>{when(group.startedAt)}</time> ·{" "}
          {describeRunCounts(group).join(" · ")}
        </p>
      ) : (
        <p className={styles.muted}>
          {group.steps.length} loaded{" "}
          {group.steps.length === 1 ? "step" : "steps"}
          {group.correlation === "trace"
            ? " · Linked by a trace; no run identifier was supplied."
            : "."}
        </p>
      )}
      {group.delegated && (
        <p className={styles.muted}>
          Delegated run: the agent handed part of its work to a helper in the
          same conversation. It is shown as its own run.
        </p>
      )}
      {group.incomplete && (
        <p className={styles.viewHelp}>
          Started before the loaded records; load older events for earlier
          steps.
        </p>
      )}
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
          {group.conversationId && (
            <div>
              <dt>Conversation</dt>
              <dd>{group.conversationId}</dd>
            </div>
          )}
          {group.errorType && (
            <div>
              <dt>Error type</dt>
              <dd>{group.errorType}</dd>
            </div>
          )}
          {group.native && (
            <div>
              <dt>Records</dt>
              <dd>
                {group.steps.reduce(
                  (sum, step) => sum + step.records.length,
                  0,
                )}{" "}
                loaded
              </dd>
            </div>
          )}
        </dl>
      </details>
      <Steps steps={group.steps} selected={selected} onSelect={onSelect} />
    </article>
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
        Claude Code and Codex computers report each task from the agent’s own
        transcript: when it started and ended, which tools it called, how long
        they took, and whether the agent recorded a failure. Hivra never records
        prompts, replies, commands, file contents, or tool inputs and outputs.
      </p>
      <p className={styles.muted}>
        This is what the agent reported, not an audit of the computer. Steps are
        shown oldest first. These are the reports loaded here, not a complete
        account of a run.
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
        <RunGroup
          key={group.key}
          group={group}
          selected={selected}
          onSelect={onSelect}
        />
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
          <ol className={styles.runSteps}>
            {ungrouped.map((event) => (
              <StepRow
                key={event.id}
                {...presentRunStep(event)}
                event={event}
                pressed={event.id === selected}
                onSelect={onSelect}
              />
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
