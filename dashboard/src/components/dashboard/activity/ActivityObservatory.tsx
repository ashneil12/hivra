"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { AgentActivityPanel } from "@/components/dashboard/AgentActivityPanel";
import type {
  ActivitySnapshot,
  ActivityEvent,
} from "@/lib/activity-observability/types";
import styles from "./ActivityObservatory.module.css";

type View = "timeline" | "attention" | "coverage" | "usage";
const kindLabels: Record<string, string> = {
  lifecycle: "Lifecycle",
  desktop_session: "Desktop session",
  trace_span: "Trace span",
  tool_activity: "Tool activity",
};
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
  const facts = [
    ["Agent", event.agentName],
    ["Observed by", event.source.label],
    ["Source type", label(event.source.kind)],
    ["Recorded at", timestamp(event.occurredAt)],
    ["Event ID", event.id],
    ["Computer", event.computerId],
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
      <p className={styles.kicker}>Event inspector</p>
      <h2>{event.title}</h2>
      <span className={event.needsAttention ? styles.warning : styles.muted}>
        {label(event.outcome)} · {label(event.severity)}
      </span>
      <p className={styles.summary}>{event.summary}</p>
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
      <p className={styles.footnote}>
        A recorded event describes what its source observed. It does not
        establish task completion or independent computer monitoring.
      </p>
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
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("timeline");
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState("all");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/activity?days=30&limit=100", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Your session expired. Sign in again to load activity."
            : "Activity could not be loaded. Refresh to try again.",
        );
      const body = await response.json();
      const snapshot = body.data;
      if (
        snapshot?.schemaVersion !== 1 ||
        !Array.isArray(snapshot.events) ||
        !Array.isArray(snapshot.resources) ||
        !Array.isArray(snapshot.sources)
      )
        throw new Error(
          "Activity returned an unsupported response. Refresh to try again.",
        );
      if (!controller.signal.aborted) setData(snapshot);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Activity could not be loaded.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  const events = data?.events ?? [];
  const query = search.trim().toLowerCase();
  const filtered = events.filter(
    (event) =>
      (view !== "attention" || event.needsAttention) &&
      (agent === "all" || event.agentId === agent) &&
      (kind === "all" || event.kind === kind) &&
      [
        event.title,
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
  const gaps =
    data?.sources.filter((source) => source.state !== "active").length ?? 0;
  const views: [View, string][] = [
    ["timeline", "Timeline"],
    ["attention", "Needs attention"],
    ["coverage", "Coverage"],
    ...(showUsage ? [["usage", "Usage"] as [View, string]] : []),
  ];
  return (
    <section className={styles.root} aria-label="Activity">
      <header className={styles.heading}>
        <div>
          <p className={styles.kicker}>Your agents, in the open</p>
          <h1>Activity</h1>
          <p className={styles.muted}>
            Follow the work. Inspect the unexpected.
          </p>
        </div>
        <div className={styles.actions}>
          {data && (
            <button
              className={styles.coverageButton}
              onClick={() => setView("coverage")}
            >
              <AlertTriangle size={15} aria-hidden="true" />
              {gaps
                ? `${gaps} source${gaps === 1 ? "" : "s"} with gaps`
                : "Inspect coverage"}
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
            {key === "attention" && data && (
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
          {data && " Showing the previous snapshot; freshness is unverified."}
        </p>
      )}
      {data?.degraded && (
        <p className={styles.notice} role="status">
          Some activity sources could not be read. This snapshot is incomplete;
          absence of events does not mean no activity occurred.
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
            <p className={styles.kicker}>Visibility by resource</p>
            <h2>Know what you can see.</h2>
            <p className={styles.muted}>
              Recorded activity and independent computer monitoring are
              different kinds of evidence.
            </p>
            <h3>Sources</h3>
            {data.sources.map((source) => (
              <div className={styles.coverRow} key={source.id}>
                <strong>{source.label}</strong>
                <div>
                  <span
                    className={
                      source.state === "active" ? styles.muted : styles.warning
                    }
                  >
                    {label(source.state)}
                  </span>
                  <p className={styles.muted}>{source.detail}</p>
                </div>
              </div>
            ))}
            <h3>Resources</h3>
            {data.resources.length ? (
              data.resources.map((resource) => (
                <div className={styles.coverRow} key={resource.id}>
                  <div>
                    <strong>{resource.name}</strong>
                    <p className={styles.resourceId}>{resource.id}</p>
                  </div>
                  <div>
                    <p className={styles.muted}>
                      Last recorded signal: {timestamp(resource.lastSeenAt)}
                    </p>
                    <div className={styles.capabilities}>
                      {resource.capabilities.map((capability) => (
                        <span key={capability.key}>
                          {capability.label} · {label(capability.state)}
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
                No resources were returned by the available sources.
              </p>
            )}
          </section>
        ) : (
          <>
            <div className={styles.toolbar}>
              <input
                type="search"
                aria-label="Search recorded events"
                placeholder="Search events, evidence, trace IDs…"
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
                <option value="all">All kinds</option>
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
              <section aria-label="Recorded events">
                <div className={styles.listLabel}>
                  <span>Last 30 days · loaded snapshot</span>
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
                        <strong>{event.title}</strong>
                        <span className={styles.meta}>
                          {event.agentName} ·{" "}
                          {kindLabels[event.kind] ?? label(event.kind)}
                        </span>
                        <span className={styles.eventBottom}>
                          <span
                            className={
                              event.needsAttention ? styles.warning : undefined
                            }
                          >
                            {label(event.outcome)}
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
                        ? "No events are available from the sources that responded."
                        : "No activity was recorded in the last 30 days."}{" "}
                    Check Coverage to see which sources are available.
                  </p>
                )}
              </section>
              {active && (
                <Inspector event={active} selected={selected === active.id} />
              )}
            </div>
            {data.truncated && (
              <p className={styles.notice}>
                This is a limited snapshot of the latest events. Filters search
                only these loaded events; older activity may not be shown.
              </p>
            )}
          </>
        ))
      )}
      {data && (
        <footer className={styles.footer}>
          <span>
            Snapshot fetched {timestamp(data.generatedAt)} · refresh for updates
          </span>
          <span>Evidence before assumptions.</span>
        </footer>
      )}
    </section>
  );
}
