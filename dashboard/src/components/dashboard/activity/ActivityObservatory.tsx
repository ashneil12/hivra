"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { StatusText } from "@/components/ui/StatusText";
import { AgentActivityPanel } from "@/components/dashboard/AgentActivityPanel";
import type {
  ActivitySnapshot,
  ActivityEvent,
  ActivityResource,
} from "@/lib/activity-observability/types";
import {
  kindLabels,
  sourceNames,
  capabilityExplanation,
  capabilityStateLabel,
  monitoringStates,
  presentEvent,
  producerName,
  reportingAlerts,
  sourceExplanation,
  type CapabilityContext,
} from "./presentation";
import { AgentRuns, AgentRunsIntro } from "./AgentRuns";
import { selectRuns } from "./run-groups";
import styles from "./ActivityObservatory.module.css";

type View = "runs" | "timeline" | "attention" | "usage";

// Below this width the list and inspector share one column, so the inspector
// opens inline under the selected record instead of after the whole list.
const NARROW_QUERY = "(max-width: 760px)";
function subscribeNarrow(onChange: () => void) {
  const media = window.matchMedia?.(NARROW_QUERY);
  if (!media?.addEventListener) return () => {};
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const narrowSnapshot = () => window.matchMedia?.(NARROW_QUERY).matches ?? false;
function useNarrowLayout() {
  return useSyncExternalStore(subscribeNarrow, narrowSnapshot, () => false);
}
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
/** "3 hours ago" style wording, measured from when the snapshot was taken. */
function relativeTime(value: string | undefined, now: string) {
  if (!value) return "a while ago";
  const then = Date.parse(value);
  const base = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(base)) return "a while ago";
  const minutes = Math.max(0, Math.round((base - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
const agentHref = (id: string) => `/dashboard/agent/${encodeURIComponent(id)}`;

const reportingContext = (
  resource: ActivityResource,
  now: string,
): CapabilityContext => ({
  status: resource.status,
  agentType: resource.agentType,
  now,
});

function Inspector({
  event,
  inline = false,
  claimReveal,
}: {
  event: ActivityEvent;
  inline?: boolean;
  /** True once, for the record the user just tapped open. */
  claimReveal?: (id: string) => boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  // Inline, keep the tapped record on screen (collapsing a previously open
  // record can shift it). When its detail would open below the fold or behind
  // the bottom navigation (the record's bottom scroll margin), bring the record
  // to the top so the detail shows. Only a tap scrolls: a record that remounts
  // because the view or filters changed leaves the page where the user is.
  useLayoutEffect(() => {
    if (!inline || !panel.current || !claimReveal?.(event.id)) return;
    const record = panel.current.previousElementSibling;
    if (!record) return;
    const reserved =
      Number.parseFloat(getComputedStyle(record).scrollMarginBottom) || 0;
    const hidden =
      panel.current.getBoundingClientRect().bottom >
      window.innerHeight - reserved;
    record.scrollIntoView?.({
      block: hidden ? "start" : "nearest",
      behavior: "instant",
    });
  }, [event.id, inline, claimReveal]);
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
    ["Reported by", producerName(event)],
    ["Record type", event.role],
    ["Tool", event.toolName],
    ["Duration (ms)", event.durationMs?.toString()],
    ["Conversation", event.conversationId],
    ["Error type", event.errorType],
  ];
  return (
    <aside
      className={`${styles.inspector} ${inline ? styles.inspectorInline : ""}`}
      ref={panel}
      aria-label="Event inspector"
      aria-live="polite"
    >
      <p className={styles.kicker}>
        {event.needsAttention ? "Worth checking" : "History record"}
      </p>
      <h2>{presentation.title}</h2>
      <StatusText
        className={
          event.needsAttention || presentation.warning
            ? styles.warning
            : styles.muted
        }
        value={presentation.status}
      />
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

const isRunRecord = (event: ActivityEvent) =>
  event.kind === "trace_span" || event.kind === "tool_activity";

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
  const [chosenView, setChosenView] = useState<View | null>(null);
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState("all");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const narrow = useNarrowLayout();
  const tabsRef = useRef<HTMLElement>(null);
  // The record a tap just opened on a narrow screen, until its inline
  // inspector has brought it into view.
  const revealRef = useRef<string | null>(null);
  const claimReveal = useCallback((id: string) => {
    if (revealRef.current !== id) return false;
    revealRef.current = null;
    return true;
  }, []);
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
  const events = useMemo(() => data?.events ?? [], [data]);
  const now = data?.generatedAt ?? "";
  // Things that need the person: records marked for review, and computers that
  // stopped reporting. Needs you opens first, and only exists, while there are any.
  const alerts = reportingAlerts(data?.resources ?? []);
  const attentionEvents = events.filter((event) => event.needsAttention);
  const attentionCount = attentionEvents.length + alerts.length;
  const view: View =
    chosenView === "usage" && !showUsage
      ? "timeline"
      : chosenView && (chosenView !== "attention" || attentionCount > 0)
        ? chosenView
        : attentionCount > 0
          ? "attention"
          : "timeline";
  const setView = setChosenView;
  // The tab strip scrolls sideways on phones; keep the active view in sight
  // without moving the page vertically.
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    const bounds = strip.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    if (target.left < bounds.left)
      strip.scrollLeft -= bounds.left - target.left + 16;
    else if (target.right > bounds.right)
      strip.scrollLeft += target.right - bounds.right + 16;
  }, [view]);
  const query = search.trim().toLowerCase();
  // Stable per query, agent and kind, so the derived lists below can memoise
  // and a keystroke or selection does not regroup every loaded record.
  const matchesQuery = useCallback(
    (event: ActivityEvent) =>
      !query ||
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
        event.toolName,
        event.conversationId,
        producerName(event),
        ...event.evidence.flatMap((item) => [item.label, item.value]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    [query],
  );
  const inScope = useCallback(
    (event: ActivityEvent) =>
      (agent === "all" || event.agentId === agent) &&
      (kind === "all" || event.kind === kind),
    [agent, kind],
  );
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (view !== "runs" || isRunRecord(event)) &&
          inScope(event) &&
          matchesQuery(event),
      ),
    [events, view, inScope, matchesQuery],
  );
  // Runs are grouped from every loaded record that passes the agent and kind
  // filters, so a run's status, start and counts never depend on the search;
  // the search only chooses which runs are shown.
  const runEvents = useMemo(
    () =>
      view === "runs"
        ? events.filter((event) => isRunRecord(event) && inScope(event))
        : [],
    [events, view, inScope],
  );
  const shownRuns = useMemo(
    () =>
      view === "runs"
        ? selectRuns(runEvents, query ? matchesQuery : undefined)
        : undefined,
    [view, runEvents, query, matchesQuery],
  );
  const shownRunIds = useMemo(
    () =>
      new Set(
        shownRuns
          ? [
              ...shownRuns.groups.flatMap((group) =>
                group.steps.flatMap((step) => step.records.map((item) => item.id)),
              ),
              ...shownRuns.ungrouped.map((event) => event.id),
            ]
          : [],
      ),
    [shownRuns],
  );
  const selectable = useMemo(
    () =>
      view === "runs"
        ? runEvents.filter((event) => shownRunIds.has(event.id))
        : filtered,
    [view, runEvents, shownRunIds, filtered],
  );
  const active =
    selectable.find((event) => event.id === selected) ??
    selectable.find(matchesQuery);
  // Narrow screens open only the record the user tapped, in place; a second
  // tap closes it.
  const expandedId =
    narrow && active && active.id === selected ? active.id : undefined;
  const selectEvent = narrow
    ? (id: string | null) => {
        const next = id === null || selected === id ? null : id;
        revealRef.current = next;
        setSelected(next);
      }
    : setSelected;
  const agents = Array.from(
    new Map(events.map((event) => [event.agentId, event.agentName])).entries(),
  );
  const monitoringFailed =
    data?.degraded ||
    data?.sources.some((source) => source.state === "degraded");
  const views: [View, string][] = [
    ...(attentionCount > 0 ? [["attention", "Needs you"] as [View, string]] : []),
    ["timeline", "History"],
    ["runs", "Runs"],
    ...(showUsage ? [["usage", "Usage"] as [View, string]] : []),
  ];
  const viewHelp =
    view === "runs"
      ? "Follow reported agent steps in order. Select a step to inspect what was reported; a quiet run does not mean it finished."
      : "This is your saved history. Routine changes are not alerts.";
  return (
    <section className={styles.root} aria-label="Activity">
      <header className={styles.heading}>
        <div>
          <h1>Activity</h1>
          <p className={styles.muted}>
            What your agents did, and anything that needs you.
          </p>
        </div>
        <div className={styles.actions}>
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
      <nav className={styles.tabs} aria-label="Activity views" ref={tabsRef}>
        {views.map(([key, title]) => (
          <button
            key={key}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {title}
            {key === "attention" && (
              <span className={styles.count}>{attentionCount}</span>
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
      {data && monitoringFailed && (
        <p className={styles.notice} role="status">
          <AlertTriangle size={15} aria-hidden="true" /> Some records could not
          be loaded. This history may be incomplete.{" "}
          <button
            className={styles.inlineButton}
            disabled={loading}
            onClick={() => void refresh()}
          >
            Try again
          </button>
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
        (view === "attention" ? (
          <section aria-label="Needs you" className={styles.needs}>
            {attentionCount > 0 ? (
              <ul>
                {alerts.map(({ resource, capability }) => (
                  <li key={`gap-${resource.id}`} className={styles.need}>
                    <AlertTriangle
                      size={16}
                      className={styles.warning}
                      aria-hidden="true"
                    />
                    <p>
                      {resource.name} stopped reporting{" "}
                      {relativeTime(capability.lastSeenAt, now)}
                    </p>
                    <Link
                      className={styles.primaryAction}
                      href={agentHref(resource.id)}
                      aria-label={`Open ${resource.name}`}
                    >
                      Open
                    </Link>
                  </li>
                ))}
                {attentionEvents.map((event) => {
                  const presentation = presentEvent(event);
                  const target = event.computerId ?? event.agentId;
                  return (
                    <li key={event.id} className={styles.need}>
                      <AlertTriangle
                        size={16}
                        className={styles.warning}
                        aria-hidden="true"
                      />
                      <p>
                        {event.agentName}: {presentation.title}{" "}
                        <StatusText
                          className={styles.muted}
                          value={presentation.status}
                        />{" "}
                        <time className={styles.meta} dateTime={event.occurredAt}>
                          {relativeTime(event.occurredAt, now)}
                        </time>
                      </p>
                      <Link
                        className={styles.primaryAction}
                        href={agentHref(target)}
                        aria-label={`Open ${event.agentName}`}
                      >
                        Open
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.empty}>Nothing needs you right now.</p>
            )}
          </section>
        ) : (
          <>
            {narrow ? (
              <details className={`${styles.technical} ${styles.aboutView}`}>
                <summary>About this view</summary>
                <p className={styles.viewHelp}>{viewHelp}</p>
                {view === "runs" && <AgentRunsIntro />}
              </details>
            ) : (
              <p className={styles.viewHelp}>{viewHelp}</p>
            )}
            <div className={styles.toolbar}>
              <input
                type="search"
                aria-label="Search recorded events"
                placeholder="Search activity…"
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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
                  events={runEvents}
                  matches={query ? matchesQuery : undefined}
                  hasOlder={Boolean(data.nextCursor)}
                  selected={narrow ? expandedId : active?.id}
                  onSelect={selectEvent}
                  accordion={narrow}
                  showIntro={!narrow}
                  detail={
                    expandedId && active ? (
                      <Inspector
                        event={active}
                        inline
                        claimReveal={claimReveal}
                      />
                    ) : null
                  }
                  limited={
                    data.truncated ||
                    data.degraded ||
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
                      <Fragment key={event.id}>
                        <button
                          className={styles.event}
                          {...(narrow
                            ? { "aria-expanded": expandedId === event.id }
                            : { "aria-pressed": active?.id === event.id })}
                          onClick={() => selectEvent(event.id)}
                        >
                          {event.needsAttention || presentEvent(event).warning ? (
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
                              <StatusText
                                className={
                                  event.needsAttention ||
                                  presentEvent(event).warning
                                    ? styles.warning
                                    : undefined
                                }
                                value={presentEvent(event).status}
                              />
                              <time dateTime={event.occurredAt}>
                                {timestamp(event.occurredAt)}
                              </time>
                            </span>
                          </span>
                        </button>
                        {expandedId === event.id && active && (
                          <Inspector
                            event={active}
                            inline
                            claimReveal={claimReveal}
                          />
                        )}
                      </Fragment>
                    ))
                  ) : (
                    <p className={styles.empty}>
                      {events.length
                        ? "No recorded events match this view and its filters."
                        : data.degraded
                          ? "No activity was returned by the available history."
                          : "No activity was recorded in the last 30 days."}{" "}
                      Open Sources below to see what Hivra keeps a record of.
                    </p>
                  )}
                </section>
              )}
              {active && !narrow && <Inspector event={active} />}
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
            {view === "timeline" && (
              <details className={styles.sources}>
                <summary>Sources</summary>
                <h3>What Hivra keeps a record of</h3>
                {data.sources.map((source) => (
                  <div className={styles.coverRow} key={source.id}>
                    <strong>{sourceNames[source.id] ?? source.label}</strong>
                    <div>
                      <StatusText
                        className={
                          source.state === "degraded"
                            ? styles.warning
                            : styles.muted
                        }
                        value={monitoringStates[source.state]}
                      />
                      <p className={styles.muted}>
                        {sourceExplanation(source, data.resources)}
                      </p>
                    </div>
                  </div>
                ))}
                <h3>When each computer last reported</h3>
                {data.resources.length ? (
                  data.resources.map((resource) => (
                    <div className={styles.coverRow} key={resource.id}>
                      <strong>{resource.name}</strong>
                      <div>
                        <p className={styles.muted}>
                          {resource.lastSeenAt
                            ? `Last reported ${relativeTime(resource.lastSeenAt, now)}`
                            : "Has not reported yet"}
                        </p>
                        {resource.capabilities
                          .filter(
                            (capability) => capability.key === "native_tracing",
                          )
                          .map((capability) => {
                            const context = reportingContext(resource, now);
                            return (
                              <p className={styles.muted} key={capability.key}>
                                <StatusText
                                  className={
                                    ["stale", "expired", "degraded"].includes(
                                      capability.state,
                                    )
                                      ? styles.warning
                                      : undefined
                                  }
                                  value={capabilityStateLabel(capability, context)}
                                />
                                {" · "}
                                {capabilityExplanation(capability, context)}
                              </p>
                            );
                          })}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className={styles.empty}>
                    {data.degraded
                      ? "No computers or agents are shown. Some information could not be loaded; try again."
                      : "No computers or agents have reported yet."}
                  </p>
                )}
              </details>
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
