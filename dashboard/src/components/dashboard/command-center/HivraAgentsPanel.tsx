"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  unifiedStateLabel,
  unifyAll,
  type UnifiedAgent,
  type HermesInstanceLite,
} from "@/lib/hivra/unified-agent";
import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import styles from "../../agents/AgentsPage.module.css";

export type { HermesInstanceLite };

const TOOL_CAPABLE_TYPES = new Set(["claude-code", "codex"]);

/** Shared by the Agents and Computers inventories so their filters cannot drift. */
export type InventoryFilter = "all" | "running" | "starting" | "error" | "stopped";
export const INVENTORY_FILTERS: ReadonlyArray<readonly [InventoryFilter, string]> = [
  ["all", "All"],
  ["running", "Running"],
  ["starting", "Starting"],
  ["error", "Needs attention"],
  ["stopped", "Stopped"],
];

export function matchesInventoryFilter(
  state: UnifiedAgent["state"],
  filter: InventoryFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "starting")
    return state === "provisioning" || state === "updating";
  return state === filter;
}

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
  const [openActions, setOpenActions] = useState<string | null>(null);
  const setRowActionsOpen = useCallback(
    (uid: string, open: boolean) =>
      setOpenActions((current) =>
        open ? uid : current === uid ? null : current,
      ),
    [],
  );

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
          matchesInventoryFilter(agent.state, filter) &&
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
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className={styles.filters} aria-label="Filter agents">
          {INVENTORY_FILTERS.map(([value, label]) => (
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
            actionsOpen={openActions === agent.uid}
            onActionsOpenChange={setRowActionsOpen}
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
                      `/dashboard/agent/${encodeURIComponent(agent.id)}?tab=manage&section=model&tools=1`,
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
  actionsOpen,
  onActionsOpenChange,
  onOpen,
  onConsole,
  onTools,
}: {
  agent: UnifiedAgent;
  actionsOpen: boolean;
  onActionsOpenChange: (uid: string, open: boolean) => void;
  onOpen: () => void;
  onConsole?: () => void;
  onTools?: () => void;
}) {
  const browserReady = useHermesBrowserReady(
    agent.kind === "hermes" ? agent.id : undefined,
  );
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const statusLabel = unifiedStateLabel(agent.state);
  const pair = agent.computerPair ?? null;
  const { uid } = agent;
  const setActionsOpen = useCallback(
    (open: boolean) => onActionsOpenChange(uid, open),
    [onActionsOpenChange, uid],
  );

  // One menu at a time; an outside click or Escape closes it so menus never
  // stack over later rows. A click, not pointerdown: a touch scroll that
  // starts outside the menu keeps it open.
  useEffect(() => {
    if (!actionsOpen) return;
    // A menu opened near the fixed bottom navigation would sit under it.
    menuRef.current?.scrollIntoView?.({ block: "nearest" });
    const onClick = (event: MouseEvent) => {
      if (!actionsRef.current?.contains(event.target as Node))
        setActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const menu = actionsRef.current;
      // Return focus to the menu's summary only when focus was in the menu;
      // Escape from the search field or a dialog leaves focus where it is.
      const focusInMenu = Boolean(menu?.contains(document.activeElement));
      setActionsOpen(false);
      if (focusInMenu) menu?.querySelector("summary")?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsOpen, setActionsOpen]);

  const runAction = (action: () => void) => () => {
    setActionsOpen(false);
    action();
  };

  return (
    <article className={styles.agentRow}>
      <button
        type="button"
        className={styles.agentPrimary}
        onClick={onOpen}
        aria-label={`Open ${agent.name}, ${[agent.typeLabel, pair?.relation.toLowerCase(), pair?.placement, pair?.size, statusLabel].filter(Boolean).join(", ")}`}
      >
        <span className={styles.agentIcon} aria-hidden>
          <Bot size={17} />
        </span>
        <span className={styles.agentIdentity}>
          <strong>{agent.name}</strong>
          <small>
            {agent.typeLabel}
            {agent.model ? ` · ${agent.model}` : ""}
            {/* The linked pair (ATT-11); its size sits in the resources column. */}
            {pair ? <span data-testid="agent-computer-pair"> · {[pair.relation, pair.placement].filter(Boolean).join(" · ")}</span> : null}
          </small>
        </span>
        <span className={styles.agentResources}>
          {pair?.size ?? (typeof agent.cpu === "number"
            ? `${agent.cpu} CPU / ${agent.ram} GB`
            : "")}
        </span>
        <span className={styles.agentStatus} data-state={agent.state}>
          <span aria-hidden />
          {statusLabel}
        </span>
        <ArrowUpRight size={16} className={styles.rowArrow} aria-hidden />
      </button>
      {browserReady || onTools || onConsole ? (
        <details ref={actionsRef} className={styles.rowActions} open={actionsOpen}>
          <summary
            aria-label={`More actions for ${agent.name}`}
            onClick={(event) => {
              event.preventDefault();
              setActionsOpen(!actionsOpen);
            }}
          >
            Actions
            <ChevronDown size={13} aria-hidden />
          </summary>
          <div ref={menuRef}>
            {browserReady ? (
              <HermesBrowserButton
                instanceId={agent.id}
                onOpened={() => setActionsOpen(false)}
              />
            ) : null}
            {onTools ? (
              <button type="button" onClick={runAction(onTools)}>
                <Wrench size={13} aria-hidden />
                Tools
              </button>
            ) : null}
            {onConsole ? (
              <button type="button" onClick={runAction(onConsole)}>
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

function HermesBrowserButton({
  instanceId,
  onOpened,
}: {
  instanceId: string;
  onOpened: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onOpened();
        window.open(
          `/api/instances/${instanceId}/browser-stream`,
          "_blank",
          "noopener,noreferrer",
        );
      }}
    >
      <Monitor size={13} aria-hidden />
      Browser
    </button>
  );
}
