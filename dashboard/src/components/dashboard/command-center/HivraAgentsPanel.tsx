"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  ChevronDown,
  Loader2,
  Monitor,
  RefreshCw,
  Search,
  ServerCog,
  Wrench,
} from "lucide-react";

import { pollWhenVisible } from "@/lib/poll-when-visible";
import { listAgentsResult, type HivraAgent } from "@/lib/hivra/agent-api";
import {
  unifyAll,
  type UnifiedAgent,
  type HermesInstanceLite,
} from "@/lib/hivra/unified-agent";
import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import styles from "../../agents/AgentsPage.module.css";

export type { HermesInstanceLite };

const TOOL_CAPABLE_TYPES = new Set(["claude-code", "codex"]);
type InventoryFilter = "all" | "running" | "error" | "stopped";

function appendHivraQuery(path: string, hivraQuery: string) {
  if (!hivraQuery) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${hivraQuery.replace(/^\?/, "")}`;
}

export function HivraAgentsPanel({
  hivraQuery = "",
  hermesInstances = [],
  hermesLoading = false,
  hermesError = null,
  onOpenInstance,
  onOpenConsole,
  onCounts,
  onRetryHermes,
}: {
  hivraQuery?: string;
  hermesInstances?: HermesInstanceLite[];
  hermesLoading?: boolean;
  hermesError?: string | null;
  onOpenInstance?: (id: string) => void;
  onOpenConsole?: (id: string) => void;
  onCounts?: (c: { running: number; total: number }) => void;
  onRetryHermes?: () => void;
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<HivraAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InventoryFilter>("all");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const result = await listAgentsResult();
    if (!result.error) {
      const resources = result.agents.filter(
        (agent) =>
          agent.status !== "deleted" &&
          catalogAgent(agent.type)?.resourceKind !== "computer",
      );
      setAgents(resources);
      onCounts?.({
        running: resources.filter((agent) => agent.status === "running").length,
        total: resources.length,
      });
    }
    setLoadError(result.error);
    setLoaded(true);
    setRefreshing(false);
  }, [onCounts]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Owns the initial async inventory request and visibility-aware refresh interval.
    void refresh();
    const interval = window.setInterval(
      pollWhenVisible(() => void refresh()),
      15_000,
    );
    return () => window.clearInterval(interval);
  }, [refresh]);

  const go = useCallback(
    (path: string) => router.push(appendHivraQuery(path, hivraQuery)),
    [router, hivraQuery],
  );
  const inventory = useMemo(
    () => unifyAll(hermesInstances, agents),
    [hermesInstances, agents],
  );
  const visible = useMemo(
    () =>
      inventory.filter(
        (agent) =>
          (filter === "all" || agent.state === filter) &&
          `${agent.name} ${agent.typeLabel} ${agent.model || ""}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [inventory, filter, query],
  );
  const loading = !loaded || hermesLoading;
  const incomplete = Boolean(loadError || hermesError);

  return (
    <section className={styles.inventory} aria-label="Your agents">
      <div className={styles.inventoryHeading}>
        <h2>
          Your agents{" "}
          <span>
            {(loading || incomplete) && inventory.length === 0
              ? ""
              : inventory.length}
          </span>
        </h2>
        <button
          type="button"
          className={styles.textButton}
          disabled={refreshing || hermesLoading}
          onClick={() => {
            void refresh();
            onRetryHermes?.();
          }}
          aria-label="Refresh agents"
        >
          <RefreshCw
            size={14}
            className={refreshing ? styles.spin : undefined}
            aria-hidden
          />
          Refresh
        </button>
      </div>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={15} aria-hidden />
          <input
            type="search"
            aria-label="Search agents"
            placeholder="Find an agent…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className={styles.filters} aria-label="Filter agents">
          {(
            [
              ["all", "All"],
              ["running", "Running"],
              ["error", "Needs attention"],
              ["stopped", "Stopped"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {incomplete ? (
        <div className={styles.loadError} role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <strong>Some agents could not be refreshed.</strong>
            <span>{loadError || hermesError}</span>
            {inventory.length > 0 ? (
              <small>
                Showing available inventory. Some details may be out of date.
              </small>
            ) : null}
          </span>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              void refresh();
              onRetryHermes?.();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {loading ? (
        <div className={styles.loading} role="status">
          <Loader2 size={16} className={styles.spin} aria-hidden />
          Loading agents…
        </div>
      ) : null}
      <div className={styles.agentList}>
        {visible.map((agent) => (
          <AgentRow
            key={agent.uid}
            agent={agent}
            onOpen={() =>
              agent.kind === "hermes"
                ? onOpenInstance
                  ? onOpenInstance(agent.id)
                  : go(`/dashboard/instances/${encodeURIComponent(agent.id)}`)
                : go(`/dashboard/agent/${encodeURIComponent(agent.id)}`)
            }
            onConsole={
              agent.kind === "hermes" && onOpenConsole
                ? () => onOpenConsole(agent.id)
                : undefined
            }
            onTools={
              agent.kind === "hivra" &&
              agent.state === "running" &&
              TOOL_CAPABLE_TYPES.has(agent.agentType || "")
                ? () =>
                    go(
                      `/dashboard/agent/${encodeURIComponent(agent.id)}?tab=manage&tools=1`,
                    )
                : undefined
            }
          />
        ))}
      </div>
      {!loading && !incomplete && inventory.length === 0 ? (
        <div className={styles.empty}>
          <Bot size={25} aria-hidden />
          <h3>No agents yet</h3>
          <p>Choose Launch to give your first agent a computer.</p>
        </div>
      ) : null}
      {!loading && inventory.length > 0 && visible.length === 0 ? (
        <div className={styles.empty}>
          <h3>No matching agents</h3>
          <p>Try another name or clear your filters.</p>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Clear search and filters
          </button>
        </div>
      ) : null}
    </section>
  );
}

function AgentRow({
  agent,
  onOpen,
  onConsole,
  onTools,
}: {
  agent: UnifiedAgent;
  onOpen: () => void;
  onConsole?: () => void;
  onTools?: () => void;
}) {
  const browserReady = useHermesBrowserReady(
    agent.kind === "hermes" ? agent.id : undefined,
  );
  return (
    <article className={styles.agentRow}>
      <button
        type="button"
        className={styles.agentPrimary}
        onClick={onOpen}
        aria-label={`Open ${agent.name}, ${agent.typeLabel}, ${agent.statusRaw}`}
      >
        <span className={styles.agentIcon} aria-hidden>
          <Bot size={17} />
        </span>
        <span className={styles.agentIdentity}>
          <strong>{agent.name}</strong>
          <small>
            {agent.typeLabel}
            {agent.model ? ` · ${agent.model}` : ""}
          </small>
        </span>
        <span className={styles.agentResources}>
          {typeof agent.cpu === "number"
            ? `${agent.cpu} vCPU · ${agent.ram} GB`
            : ""}
        </span>
        <span className={styles.agentStatus} data-state={agent.state}>
          <span aria-hidden />
          {agent.statusRaw.replaceAll("_", " ")}
        </span>
        <ArrowUpRight size={16} className={styles.rowArrow} aria-hidden />
      </button>
      {browserReady || onTools || onConsole ? (
        <details className={styles.rowActions}>
          <summary aria-label={`More actions for ${agent.name}`}>
            Actions
            <ChevronDown size={13} aria-hidden />
          </summary>
          <div>
            {browserReady ? (
              <HermesBrowserButton instanceId={agent.id} />
            ) : null}
            {onTools ? (
              <button type="button" onClick={onTools}>
                <Wrench size={13} aria-hidden />
                Tools
              </button>
            ) : null}
            {onConsole ? (
              <button type="button" onClick={onConsole}>
                <ServerCog size={13} aria-hidden />
                Console
              </button>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function useHermesBrowserReady(instanceId?: string): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!instanceId) return;
    let alive = true;
    fetch(`/api/instances/${instanceId}/browser-sessions`, {
      cache: "no-store",
    })
      .then((response) => {
        if (alive) setReady(response.ok);
      })
      .catch(() => {
        /* The browser surface is optional; absence does not imply agent failure. */
      });
    return () => {
      alive = false;
    };
  }, [instanceId]);
  return ready;
}

function HermesBrowserButton({ instanceId }: { instanceId: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        window.open(
          `/api/instances/${instanceId}/browser-stream`,
          "_blank",
          "noopener,noreferrer",
        )
      }
    >
      <Monitor size={13} aria-hidden />
      Browser
    </button>
  );
}
