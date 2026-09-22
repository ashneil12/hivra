"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { AgentActivityPanel } from "@/components/dashboard/AgentActivityPanel";
import type {
  ActivitySnapshot,
  ActivityEvent,
} from "@/lib/activity-observability/types";
import {
  kindLabels,
  sourceNames,
  capabilityNames,
  monitoringStates,
  presentEvent,
  sourceExplanation,
} from "./presentation";
import { AgentRuns } from "./AgentRuns";
import styles from "./ActivityObservatory.module.css";

type View = "runs" | "timeline" | "attention" | "coverage" | "usage";
const label = (value: string) => value.replaceAll("_", " ");
function timestamp(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      });
}
function Inspector({
  event,
  selected,
}: {
  event: ActivityEvent;
  selected: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && window.matchMedia?.("(max-width: 760px)").matches) {
      panel.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }, [event.id, selected]);
  const presentation = presentEvent(event);
  const facts = [
    ["Original title", event.title],
    ["Original summary", event.summary],
    ["Observed by", event.source.label],
    ["Source type", label(event.source.kind)],
    ["Outcome", event.outcome],
    ["Severity", event.severity],
    ["Event ID", event.id],
    ["Agent ID", event.agentId],
    ["Computer ID", event.computerId],
    ["Run", event.runId],
    ["Trace", event.traceId],
    ["Span", event.spanId],
    ["Parent span", event.parentSpanId],
  ];
  return (
    <aside
      className={styles.inspector}
      ref={panel}
      aria-label="Event inspector"
      aria-live="polite"
    >
      <p className={styles.kicker}>
        {event.needsAttention ? "Worth checking" : "History record"}
      </p>
      <h2>{presentation.title}</h2>
      <span className={event.needsAttention ? styles.warning : styles.muted}>
        {presentation.status}
      </span>
      <h3>What happened</h3>
      <p className={styles.muted}>{presentation.happened}</p>
      <h3>{event.needsAttention ? "What to do" : "Why this is here"}</h3>
      <p className={styles.muted}>{presentation.guidance}</p>
      <dl className={styles.facts}>
        <div>
          <dt>{event.computerId ? "Computer" : "Agent"}</dt>
          <dd>{event.agentName}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{timestamp(event.occurredAt)}</dd>
        </div>
      </dl>
      <details key={event.id} className={styles.technical}>
        <summary>Technical details</summary>
        <dl className={styles.facts}>
          {facts
            .filter(([, value]) => value)
            .map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
        <h3 className={styles.kicker}>Recorded evidence</h3>
        {event.evidence.length ? (
          <dl className={styles.evidence}>
            {event.evidence.map((item, index) => (
              <div key={`${item.label}-${index}`}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={styles.muted}>
            No additional evidence was retained for this event.
          </p>
        )}
      </details>
    </aside>
  );
}

export function ActivityObservatory({
  showUsage = true,
}: {
  showUsage?: boolean;
}) {
  const [data, setData] = useState<ActivitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("timeline");
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState("all");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(!cursor);
    setLoadingOlder(Boolean(cursor));
    setOlderError(null);
    if (!cursor) setError(null);
    try {
      const response = await fetch(
        `/api/activity?days=30&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        {
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Your session expired. Sign in again to load activity."
            : "Activity could not be loaded. Refresh to try again.",
        );
      const body = await response.json();
      const snapshot = body.data as ActivitySnapshot;
      if (
        snapshot?.schemaVersion !== 1 ||
        !Array.isArray(snapshot.events) ||
        !Array.isArray(snapshot.resources) ||
        !Array.isArray(snapshot.sources)
      )
        throw new Error(
          "Activity returned an unsupported response. Refresh to try again.",
        );
      if (!controller.signal.aborted) {
        setData((previous) => {
          if (!cursor || !previous) return snapshot;
          const known = new Set(previous.events.map((event) => event.id));
          const appended = snapshot.events.filter((event) => {
            if (known.has(event.id)) return false;
            known.add(event.id);
            return true;
          });
          return {
            ...previous,
            events: [...previous.events, ...appended],
            sources: previous.sources.map(
              (source) =>
                snapshot.sources.find(
                  (next) => next.id === source.id && next.state === "degraded",
                ) ?? source,
            ),
            degraded: previous.degraded || snapshot.degraded,
            truncated: snapshot.degraded
              ? previous.truncated
              : snapshot.truncated,
            nextCursor: snapshot.degraded
              ? previous.nextCursor
              : snapshot.nextCursor,
          };
        });
        if (!cursor) setSelected(null);
        else if (snapshot.degraded)
          setOlderError(
            "Some older activity sources could not be read. Available events were kept; retry this page to fill the gap.",
          );
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        (cursor ? setOlderError : setError)(
          cursor
            ? "Older events could not be loaded. Your loaded events are preserved; try again."
            : cause instanceof Error
              ? cause.message
              : "Activity could not be loaded.",
        );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, []);
  const refresh = useCallback(() => load(), [load]);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  const events = data?.events ?? [];
  const query = search.trim().toLowerCase();
  const filtered = events.filter(
    (event) =>
      (view !== "attention" || event.needsAttention) &&
      (view !== "runs" ||
        event.kind === "trace_span" ||
        event.kind === "tool_activity") &&
      (agent === "all" || event.agentId === agent) &&
      (kind === "all" || event.kind === kind) &&
      [
        presentEvent(event).title,
        event.title,
        event.id,
        event.computerId,
        event.spanId,
        event.summary,
        event.agentName,
        event.runId,
        event.traceId,
        ...event.evidence.flatMap((item) => [item.label, item.value]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
  );
  const active = filtered.find((event) => event.id === selected) ?? filtered[0];
  const agents = Array.from(
    new Map(events.map((event) => [event.agentId, event.agentName])).entries(),
  );
  const monitoringFailed =
    data?.degraded ||
    data?.sources.some((source) => source.state === "degraded");
  const views: [View, string][] = [
    ["timeline", "History"],
    ["runs", "Agent runs"],
    ["attention", "Needs attention"],
    ["coverage", "What is monitored"],
    ...(showUsage ? [["usage", "Usage"] as [View, string]] : []),
  ];
  return (
    <section className={styles.root} aria-label="Activity">
      <header className={styles.heading}>
        <div>
          <p className={styles.kicker}>Your agents, in the open</p>
          <h1>Activity</h1>
          <p className={styles.muted}>
            See what your agents and computers reported. Routine history appears
            here too.
          </p>
        </div>
        <div className={styles.actions}>
          {data && (
            <button
              className={`${styles.coverageButton} ${monitoringFailed ? styles.warning : ""}`}
              onClick={() => setView("coverage")}
            >
              {monitoringFailed && (
                <AlertTriangle size={15} aria-hidden="true" />
              )}
              {monitoringFailed
                ? "Some records could not be loaded"
                : "Monitoring limits"}
            </button>
          )}
          <button
            className={styles.refresh}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      <nav className={styles.tabs} aria-label="Activity views">
        {views.map(([key, title]) => (
          <button
            key={key}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {title}
            {key === "attention" &&
              events.some((event) => event.needsAttention) && (
                <span className={styles.count}>
                  {events.filter((event) => event.needsAttention).length}
                </span>
              )}
          </button>
        ))}
      </nav>
      {error && (
        <p className={styles.notice} role="alert">
          {error}
          {data && " Showing previously loaded history. It may be out of date."}
        </p>
      )}
      {data?.degraded && (
        <p className={styles.notice} role="status">
          Some activity could not be loaded. This history may be incomplete.
        </p>
      )}
      {loading && !data && (
        <p className={styles.empty} role="status">
          Loading recorded activity…
        </p>
      )}
      {view === "usage" ? (
        <div className={styles.usage}>
          <AgentActivityPanel />
        </div>
      ) : (
        data &&
        (view === "coverage" ? (
          <section className={styles.coverage} aria-label="Monitoring coverage">
            <p className={styles.kicker}>What Hivra can see</p>
            <h2>What is recorded, and what is missing.</h2>
            <p className={styles.muted}>
              Hivra shows saved computer changes and reports sent by agents. It
              does not see every command, file change, or network connection.
            </p>
            <h3>Types of history</h3>
            {data.sources.map((source) => (
              <div className={styles.coverRow} key={source.id}>
                <strong>{sourceNames[source.id] ?? source.label}</strong>
                <div>
                  <span
                    className={
                      source.state === "degraded"
                        ? styles.warning
                        : styles.muted
                    }
                  >
                    {monitoringStates[source.state]}
                  </span>
                  <p className={styles.muted}>{sourceExplanation(source)}</p>
                  <details className={styles.technical}>
                    <summary>Technical source details</summary>
                    <p>{source.label}</p>
                    <p>{source.detail}</p>
                  </details>
                </div>
              </div>
            ))}
            <h3>Your computers and agents</h3>
            {data.resources.length ? (
              data.resources.map((resource) => (
                <div className={styles.coverRow} key={resource.id}>
                  <div>
                    <strong>{resource.name}</strong>
                    <details className={styles.technical}>
                      <summary>Technical identifier</summary>
                      <p className={styles.resourceId}>{resource.id}</p>
                    </details>
                  </div>
                  <div>
                    <p className={styles.muted}>
                      Last agent report: {timestamp(resource.lastSeenAt)}
                    </p>
                    <div className={styles.capabilities}>
                      {resource.capabilities.map((capability) => (
                        <span key={capability.key}>
                          {capabilityNames[capability.key] ?? capability.label}{" "}
                          · {monitoringStates[capability.state]}
                          {capability.lastSeenAt && (
                            <small>
                              Last seen {timestamp(capability.lastSeenAt)}
                            </small>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className={styles.empty}>
                {data.degraded
                  ? "No computers or agents are shown. Some information could not be loaded; refresh to try again."
                  : "No computers or agents were returned by the available history."}
              </p>
            )}
          </section>
        ) : (
          <>
            <p className={styles.viewHelp}>
              {view === "runs"
                ? "Follow reported agent steps in order. Select a step to inspect what was reported; a quiet run does not mean it finished."
                : view === "attention"
                  ? "Only records marked for review appear here. The count covers loaded records, not all activity or a guarantee that everything is fine."
                  : "This is your saved history. Routine changes are not alerts; use Needs attention to review reported problems."}
            </p>
            <div className={styles.toolbar}>
              <input
                type="search"
                aria-label="Search recorded events"
                placeholder="Search activity…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <select
                aria-label="Filter by agent"
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
              >
                <option value="all">All agents</option>
                {agents.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="all">All activity types</option>
                {Array.from(new Set(events.map((event) => event.kind))).map(
                  (value) => (
                    <option key={value} value={value}>
                      {kindLabels[value] ?? label(value)}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div className={styles.work}>
              {view === "runs" ? (
                <AgentRuns
                  events={filtered}
                  selected={active?.id}
                  onSelect={setSelected}
                  limited={
                    data.truncated ||
                    data.degraded ||
                    Boolean(query) ||
                    agent !== "all" ||
                    kind !== "all"
                  }
                />
              ) : (
                <section aria-label="Recorded events">
                  <div className={styles.listLabel}>
                    <span>Last 30 days · loaded records</span>
                    <span role="status">{filtered.length} events</span>
                  </div>
                  {filtered.length ? (
                    filtered.map((event) => (
                      <button
                        key={event.id}
                        className={styles.event}
                        aria-pressed={active?.id === event.id}
                        onClick={() => setSelected(event.id)}
                      >
                        {event.needsAttention ? (
                          <AlertTriangle
                            size={16}
                            className={styles.warning}
                            aria-hidden="true"
                          />
                        ) : (
                          <Activity size={16} aria-hidden="true" />
                        )}
                        <span>
                          <strong>{presentEvent(event).title}</strong>
                          <span className={styles.meta}>
                            {event.agentName} ·{" "}
                            {kindLabels[event.kind] ?? label(event.kind)}
                          </span>
                          <span className={styles.eventBottom}>
                            <span
                              className={
                                event.needsAttention
                                  ? styles.warning
                                  : undefined
                              }
                            >
                              {presentEvent(event).status}
                            </span>
                            <time dateTime={event.occurredAt}>
                              {timestamp(event.occurredAt)}
                            </time>
                          </span>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className={styles.empty}>
                      {events.length
                        ? "No recorded events match this view and its filters."
                        : data.degraded
                          ? "No activity was returned by the available history."
                          : "No activity was recorded in the last 30 days."}{" "}
                      See What is monitored to understand which records are
                      available.
                    </p>
                  )}
                </section>
              )}
              {active && (
                <Inspector event={active} selected={selected === active.id} />
              )}
            </div>
            {olderError && (
              <p role="alert" className={styles.notice}>
                {olderError}
              </p>
            )}
            {data.nextCursor && (
              <button
                className={styles.refresh}
                disabled={loading || loadingOlder}
                onClick={() => void load(data.nextCursor)}
              >
                {loadingOlder ? "Loading older events…" : "Load older events"}
              </button>
            )}
            {data.truncated && (
              <p className={styles.notice}>
                Showing the records loaded so far. Search and filters only cover
                these records.
              </p>
            )}
          </>
        ))
      )}
      {data && (
        <footer className={styles.footer}>
          <span>
            Last updated {timestamp(data.generatedAt)} · refresh for updates
          </span>
          <span>Evidence before assumptions.</span>
        </footer>
      )}
    </section>
  );
}
