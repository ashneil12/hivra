"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { clientLog } from "@/lib/client/logger";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import {
  unifyAll,
  type HermesInstanceLite,
  type UnifiedAgent,
} from "@/lib/hivra/unified-agent";
import {
  createResourceInventory,
  resourceInventory,
  type InventorySourceState,
  type ResourceInventory,
} from "@/lib/workspace/resource-inventory";

/** Returns that source's API response body, as the route sends it. */
type WorkspaceSourceFetcher = () => Promise<unknown>;

export interface UseWorkspaceAgentsOptions {
  /**
   * Stand-ins for the two lists. Without them the hook reads the dashboard's
   * shared inventory, so Home and the switchers fetch each list once.
   */
  fetchHermes?: WorkspaceSourceFetcher;
  fetchHivra?: WorkspaceSourceFetcher;
  getNow?: () => Date;
}

export interface UseWorkspaceAgentsResult {
  agents: UnifiedAgent[];
  loading: boolean;
  hermesError: string | null;
  hivraError: string | null;
  lastRefreshedAt: string | null;
  retryHermes: () => Promise<void>;
  retryHivra: () => Promise<void>;
  retryAll: () => Promise<void>;
}

// Shown to people: never the name of the store an agent lives in (FTUE-03).
const HERMES_ERROR = "Some agents couldn't be loaded. Retry to check again.";
const HIVRA_ERROR = "Some agents and computers couldn't be loaded. Retry to check again.";
const HIVRA_STATUSES = new Set(["provisioning", "running", "stopped", "error", "deleted"]);
const HIVRA_SUBSTRATES = new Set(["proxmox-kvm", "provider-vm", "gvisor", "do-managed-session"]);
const HIVRA_DEPLOYMENT_MODES = new Set(["hivra-managed", "self-managed"]);

/** A known enum value, or undefined for anything else (never a guess). */
function knownValue<T extends string>(value: unknown, known: Set<string>): T | undefined {
  return typeof value === "string" && known.has(value) ? value as T : undefined;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("invalid-source-record");
  }
  return value;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("invalid-source-record");
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("invalid-source-record");
  }
  return value;
}

function parseHermesEnvelope(value: unknown): HermesInstanceLite[] {
  const envelope = asRecord(value);
  if (!envelope || envelope.success !== true || !Array.isArray(envelope.data)) {
    throw new Error("invalid-hermes-envelope");
  }

  return envelope.data.map((candidate) => {
    const row = asRecord(candidate);
    if (!row) throw new Error("invalid-source-record");

    return {
      id: requiredString(row.id),
      name: requiredString(row.name),
      status: requiredString(row.status),
      provider: optionalString(row.provider) ?? undefined,
      model: optionalString(row.model),
      pendingPrompt: row.pendingPrompt,
    };
  });
}

function parseHivraEnvelope(value: unknown): HivraAgent[] {
  const envelope = asRecord(value);
  const data = asRecord(envelope?.data);
  if (!envelope || envelope.success !== true || !data || !Array.isArray(data.agents)) {
    throw new Error("invalid-hivra-envelope");
  }

  return data.agents.map((candidate) => {
    const row = asRecord(candidate);
    if (!row) throw new Error("invalid-source-record");
    const status = requiredString(row.status);
    if (!HIVRA_STATUSES.has(status)) throw new Error("invalid-source-record");

    return {
      id: requiredString(row.id),
      type: requiredString(row.type) as HivraAgent["type"],
      name: requiredString(row.name),
      status: status as HivraAgent["status"],
      cpu: finiteNumber(row.cpu),
      ram: finiteNumber(row.ram),
      emoji: optionalString(row.emoji),
      provisioned_at: optionalString(row.provisioned_at),
      // Where the agent's computer runs, for its linked-pair line (ATT-11).
      computer_substrate: knownValue<NonNullable<HivraAgent["computer_substrate"]>>(row.computer_substrate, HIVRA_SUBSTRATES),
      deployment_mode: knownValue<NonNullable<HivraAgent["deployment_mode"]>>(row.deployment_mode, HIVRA_DEPLOYMENT_MODES),
    };
  });
}

function logSourceFailure(agentSource: "hermes" | "hivra"): void {
  clientLog.warn("Workspace agent source unavailable", {
    source: "workspace-agents",
    agentSource,
    failureType: `workspace_${agentSource}_source_failed`,
  });
}

interface SourceRows<T> {
  rows: T[];
  settled: boolean;
  failed: boolean;
}

/**
 * One list's rows. A failed refresh keeps the last good rows for browsing (the
 * caller marks them as last known); an unreadable one yields none.
 */
function sourceRows<T>(state: InventorySourceState, parse: (value: unknown) => T[]): SourceRows<T> {
  let rows: T[] = [];
  let unreadable = false;
  if (state.hasBody) {
    try {
      rows = parse(state.body);
    } catch {
      unreadable = true;
    }
  }
  return { rows, settled: state.settledAt > 0, failed: state.failed || unreadable };
}

function privateInventory(options: UseWorkspaceAgentsOptions): ResourceInventory | null {
  if (!options.fetchHermes && !options.fetchHivra) return null;
  const { fetchHermes, fetchHivra, getNow } = options;
  return createResourceInventory({
    fetchers: {
      ...(fetchHermes ? { hermes: () => fetchHermes() } : {}),
      ...(fetchHivra ? { hivra: () => fetchHivra() } : {}),
    },
    now: getNow ? () => getNow().getTime() : undefined,
  });
}

export function useWorkspaceAgents(
  options: UseWorkspaceAgentsOptions = {},
): UseWorkspaceAgentsResult {
  // Fixed for the hook's lifetime: the shared inventory, or stand-ins.
  const [inventory] = useState(() => privateInventory(options) ?? resourceInventory);
  const snapshot = useSyncExternalStore(
    inventory.subscribe,
    inventory.getSnapshot,
    inventory.getServerSnapshot,
  );

  useEffect(() => {
    void inventory.load("hermes");
    void inventory.load("hivra");
  }, [inventory]);

  const hermes = useMemo(() => sourceRows(snapshot.hermes, parseHermesEnvelope), [snapshot.hermes]);
  const hivra = useMemo(() => sourceRows(snapshot.hivra, parseHivraEnvelope), [snapshot.hivra]);

  // Logged once per failed read this hook sees, never with the response.
  const hermesFailedAt = hermes.failed ? snapshot.hermes.settledAt : 0;
  const hivraFailedAt = hivra.failed ? snapshot.hivra.settledAt : 0;
  useEffect(() => {
    if (hermesFailedAt) logSourceFailure("hermes");
  }, [hermesFailedAt]);
  useEffect(() => {
    if (hivraFailedAt) logSourceFailure("hivra");
  }, [hivraFailedAt]);

  const retryHermes = useCallback(() => inventory.load("hermes", { force: true }), [inventory]);
  const retryHivra = useCallback(() => inventory.load("hivra", { force: true }), [inventory]);
  const retryAll = useCallback(async () => {
    await Promise.all([retryHermes(), retryHivra()]);
  }, [retryHermes, retryHivra]);

  const agents = useMemo(() => unifyAll(hermes.rows, hivra.rows), [hermes.rows, hivra.rows]);
  const refreshedAt = Math.max(snapshot.hermes.settledAt, snapshot.hivra.settledAt);

  return {
    agents,
    loading: !hermes.settled || !hivra.settled,
    hermesError: hermes.failed ? HERMES_ERROR : null,
    hivraError: hivra.failed ? HIVRA_ERROR : null,
    lastRefreshedAt: refreshedAt > 0 ? new Date(refreshedAt).toISOString() : null,
    retryHermes,
    retryHivra,
    retryAll,
  };
}
