"use client";

// AI agent job library (/tools/ai-agent-use-cases).
//
// Forty prompts in eight groups. Filter by group, by what your agent is connected to, or search. Each card
// shows the outcome, the schedule, what must be connected and a copy button; the prompt, the setup note and
// the risk note are one click away. The group and the connections go in the page address (allow-listed);
// the search text never does. Nothing is sent anywhere.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import local from "./AgentJobLibraryTool.module.css";
import CopyButton from "./CopyButton";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import { agentDeployHref, getAgentSeoEntry } from "@/lib/hivra/agent-seo-catalog";
import { currentSearch, replaceToolSearch } from "@/lib/tools/tool-params";
import {
  AGENT_JOBS,
  CATEGORIES,
  CATEGORY_IDS,
  CONNECTIONS,
  CONNECTION_IDS,
  DEFAULT_FILTER,
  JOB_PARAM_KEYS,
  countByCategory,
  filterJobs,
  groupByCategory,
  parseJobParams,
  serializeJobParams,
  type AgentJob,
  type CategoryId,
  type ConnectionId,
  type JobFilter,
} from "@/lib/tools/agent-tools/agent-job-library";

const ACTION_LABEL: Record<AgentJob["action"], string> = {
  reads: "Read only",
  drafts: "Drafts, you approve",
  "writes-file": "Writes a file, you approve",
};

function JobCard({ job }: { job: AgentJob }) {
  const needs = job.needs.length > 0 ? job.needs.map((n) => CONNECTIONS[n].label).join(", ") : "Nothing connected";
  return (
    <article className={local.card} aria-labelledby={`job-${job.id}`} data-testid="job-card" data-job-id={job.id}>
      <h4 id={`job-${job.id}`} className={local.cardTitle}>
        {job.title}
      </h4>
      <p className={local.outcome}>{job.outcome}</p>
      <dl className={local.meta}>
        <dt>Schedule</dt>
        <dd>{job.schedule}</dd>
        <dt>Needs</dt>
        <dd>{needs}</dd>
        <dt>Does</dt>
        <dd>
          <span className={`${local.tag} ${job.action === "reads" ? local.tagSafe : ""}`}>{ACTION_LABEL[job.action]}</span>
        </dd>
      </dl>
      <details className={local.details}>
        <summary>Show prompt and notes</summary>
        <pre className={local.prompt}>{job.prompt}</pre>
        <p className={local.notes}>
          <strong>Set up first:</strong> {job.setup}
        </p>
        <p className={local.notes}>
          <strong>What can go wrong:</strong> {job.risk}
        </p>
      </details>
      <div className={local.cardActions}>
        <CopyButton text={job.prompt} label="Copy prompt" copiedLabel="Prompt copied" ariaLabel={`Copy prompt: ${job.title}`} />
      </div>
    </article>
  );
}

export default function AgentJobLibraryTool() {
  const [filter, setFilter] = useState<JobFilter>(DEFAULT_FILTER);
  const [ready, setReady] = useState(false);

  // Read a shared link once, after hydration, so the server render shows every job.
  useEffect(() => {
    // Reading the address is an external system; it can only happen after hydration. Same pattern as the keep-awake tool.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilter((prev) => ({ ...parseJobParams(currentSearch()), query: prev.query }));
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) replaceToolSearch(serializeJobParams(filter), JOB_PARAM_KEYS);
  }, [filter, ready]);

  const counts = useMemo(() => countByCategory(), []);
  const shown = useMemo(() => filterJobs(filter), [filter]);
  const groups = useMemo(() => groupByCategory(shown), [shown]);

  const setCategory = (category: CategoryId | "all") => setFilter((f) => ({ ...f, category }));
  const toggleHave = (id: ConnectionId) =>
    setFilter((f) => {
      const have = f.have.includes(id) ? f.have.filter((h) => h !== id) : [...f.have, id];
      return { ...f, have, onlyRunnable: f.onlyRunnable || have.length > 0 };
    });
  const reset = () => setFilter(DEFAULT_FILTER);

  const startHref = agentDeployHref(getAgentSeoEntry("hermes")!);
  const filtered = filter.category !== "all" || filter.onlyRunnable || filter.query.trim() !== "";

  return (
    <div className={styles.tool} data-testid="agent-job-library">
      <div className={local.filters}>
        <div>
          <label className={styles.label} htmlFor="job-search">
            Search the jobs
          </label>
          <input
            id="job-search"
            type="search"
            className={styles.field}
            placeholder="For example calendar, invoice, price"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            autoComplete="off"
          />
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Group</legend>
          <div className={local.chips}>
            <button type="button" className={local.chip} aria-pressed={filter.category === "all"} onClick={() => setCategory("all")}>
              All ({AGENT_JOBS.length})
            </button>
            {CATEGORY_IDS.map((id) => (
              <button key={id} type="button" className={local.chip} aria-pressed={filter.category === id} onClick={() => setCategory(id)}>
                {CATEGORIES[id].label} ({counts[id]})
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>What my agent is connected to</legend>
          <div className={local.checks}>
            {CONNECTION_IDS.map((id) => (
              <label key={id} className={styles.check} title={CONNECTIONS[id].hint}>
                <input type="checkbox" checked={filter.have.includes(id)} onChange={() => toggleHave(id)} />
                {CONNECTIONS[id].label}
              </label>
            ))}
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={filter.onlyRunnable}
              onChange={(e) => setFilter((f) => ({ ...f, onlyRunnable: e.target.checked }))}
            />
            Only show jobs I can run with what is ticked
          </label>
          <p className={styles.hint}>With nothing ticked, this shows only the jobs that need nothing connected.</p>
        </fieldset>
      </div>

      <div className={local.status}>
        <p role="status" aria-live="polite" className={local.statusText}>
          Showing {shown.length} of {AGENT_JOBS.length} jobs.
        </p>
        {filtered && (
          <button type="button" className={styles.smallButton} onClick={reset}>
            Clear filters
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <p className={local.empty}>No job matches. Clear a filter, or untick a connection.</p>
      ) : (
        groups.map((group) => (
          <section key={group.id} className={local.group} aria-labelledby={`group-${group.id}`}>
            <div className={local.groupHead}>
              <h3 id={`group-${group.id}`} className={local.groupTitle}>
                {CATEGORIES[group.id].label}
              </h3>
              <p className={local.groupBlurb}>{CATEGORIES[group.id].blurb}</p>
            </div>
            <div className={local.cards}>
              {group.jobs.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>
          </section>
        ))
      )}

      <p className={styles.note}>
        Schedules are suggestions. To run a job on a schedule, paste the prompt into Hermes and ask it to run it at that time, or set it up in OpenClaw with the `openclaw automations` command. Test it by hand first.
      </p>

      <div className={styles.bridge}>
        <p>
          Scheduled jobs need a machine that stays on. A Hivra computer for Hermes costs {formatPlanSize("entry")}, and the plan does not include AI usage. A spare machine
          at home works too.
        </p>
        <Link href={startHref} className={styles.bridgeLink}>
          Start Hermes on Hivra
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
