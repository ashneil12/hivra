"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { clientLog } from "@/lib/client/logger";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import {
  unifyAll,
  type AttachedAgentLite,
  type HermesInstanceLite,
  type UnifiedAgent,
} from "@/lib/hivra/unified-agent";
import {
  createResourceInventory,
  INVENTORY_SOURCES,
  resourceInventory,
  type InventorySource,
  type InventorySourceState,
  type ResourceInventory,
} from "@/lib/workspace/resource-inventory";

/**
 * The account the dashboard is showing, the same key the sidebar scopes its
 * list with. The lists are held between pages, so a reader compares it with
 * the account they were read for before showing any of them.
 */
export const WorkspaceOwnerContext = createContext<string | null>(null);

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
  /**
   * Show the list already held at once, instead of reporting it as loading
   * until a read made since this view opened has answered. A held list is
   * read again only when it is more than a few seconds old. For a menu; never
   * for a view that acts on the list by itself, such as Home offering or
   * resuming an agent: a held list can predate a delete or a stop made
   * elsewhere moments ago.
   */
  reuseHeldList?: boolean;
}

export interface UseWorkspaceAgentsResult {
  agents: UnifiedAgent[];
  loading: boolean;
  hermesError: string | null;
  /** The owner's agents and computers could not be read. */
  hivraError: string | null;
  /** Only the agents added to the owner's computers could not be read: every
   * other row is current. Optional so callers built before it (and their
   * fixtures) still type-check. */
  attachedError?: string | null;
  lastRefreshedAt: string | null;
  retryHermes: () => Promise<void>;
  retryHivra: () => Promise<void>;
  retryAll: () => Promise<void>;
}

// Shown to people: never the name of the store an agent lives in (FTUE-03).
const HERMES_ERROR = "Some agents couldn't be loaded. Retry to check again.";
const HIVRA_ERROR = "Some agents and computers couldn't be loaded. Retry to check again.";
const ATTACHED_ERROR = "Agents added to your computers couldn't be loaded. Retry to check again.";
const HIVRA_STATUSES = new Set(["provisioning", "running", "stopped", "error", "deleted"]);
const HIVRA_SUBSTRATES = new Set(["proxmox-kvm", "provider-vm", "gvisor", "do-managed-session"]);
const HIVRA_DEPLOYMENT_MODES = new Set(["hivra-managed", "self-managed"]);
// A computer's operating system: Home names and opens it by this, and an
// unknown value is dropped rather than shown.
const HIVRA_COMPUTER_PROFILES = new Set(["ubuntu-desktop", "omarchy", "windows", "linux-terminal"]);

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
      computer_profile: knownValue<NonNullable<HivraAgent["computer_profile"]>>(row.computer_profile, HIVRA_COMPUTER_PROFILES) ?? null,
    };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTACHED_PHASES = new Set(["claimed", "dispatched", "attached"]);

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("invalid-source-record");
  return value;
}

/**
 * Agents added to the owner's computers, read with the Hivra list (the
 * inventory carries GET /api/hivra/attached-agents as `attached` on that
 * body): `undefined` when that one list could not be read.
 */
function parseAttached(value: unknown): AttachedAgentLite[] | undefined {
  if (value === undefined) return [];
  if (value === null) return undefined;
  const list = asRecord(asRecord(value)?.data ?? value);
  if (!list || !Array.isArray(list.agents)) return undefined;
  if (list.enabled !== true) return [];
  try {
    return list.agents.map((candidate) => {
      const row = asRecord(candidate);
      if (!row || typeof row.phase !== "string" || !ATTACHED_PHASES.has(row.phase)) throw new Error("invalid-source-record");
      return {
        id: requiredId(row.id),
        phase: row.phase as AttachedAgentLite["phase"],
        agentName: requiredString(row.agentName),
        computerId: requiredId(row.computerId),
        computerName: requiredString(row.computerName),
        computerStatus: optionalString(row.computerStatus) ?? null,
      };
    });
  } catch {
    return undefined;
  }
}

function logSourceFailure(agentSource: "hermes" | "hivra" | "attached"): void {
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

const NO_ROWS: SourceRows<never> = { rows: [], settled: false, failed: false };

/**
 * One list's rows. A failed refresh keeps the last good rows for browsing (the
 * caller marks them as last known); an unreadable one yields none. It counts
 * as settled only once a read newer than `mark` has answered, and only that
 * read can report a failure.
 */
function sourceRows<T>(state: InventorySourceState, parse: (value: unknown) => T[], mark: number): SourceRows<T> {
  let rows: T[] = [];
  let unreadable = false;
  if (state.hasBody) {
    try {
      rows = parse(state.body);
    } catch {
      unreadable = true;
    }
  }
  const settled = state.settledAt > 0 && state.read > mark;
  return { rows, settled, failed: settled && (state.failed || unreadable) };
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
  const owner = useContext(WorkspaceOwnerContext);
  // Fixed for the hook's lifetime: the shared inventory, or stand-ins, and
  // which reads count as current. Taken while rendering, before any effect of
  // this commit starts a read, so a read the sidebar starts alongside counts.
  const [inventory] = useState(() => privateInventory(options) ?? resourceInventory);
  const [reuseHeld] = useState(() => options.reuseHeldList === true);
  const [marks] = useState<Record<InventorySource, number>>(() => reuseHeld
    ? { hermes: 0, hivra: 0 }
    : { hermes: inventory.readMark("hermes"), hivra: inventory.readMark("hivra") });
  const snapshot = useSyncExternalStore(
    inventory.subscribe,
    inventory.getSnapshot,
    inventory.getServerSnapshot,
  );

  useEffect(() => {
    if (owner !== null) inventory.setOwner(owner);
    // Joins a read in flight (the sidebar's, on the same page change), so a
    // Home load still reads each list once.
    for (const source of INVENTORY_SOURCES) void inventory.load(source, { revalidate: !reuseHeld });
  }, [inventory, owner, reuseHeld]);

  // Lists held for another account (a sign-in without a page load) are not
  // shown while the effect above drops them.
  const mine = snapshot.owner === owner;
  const hermes = useMemo(
    () => mine ? sourceRows(snapshot.hermes, parseHermesEnvelope, marks.hermes) : NO_ROWS,
    [mine, snapshot.hermes, marks.hermes],
  );
  const hivra = useMemo(
    () => mine ? sourceRows(snapshot.hivra, parseHivraEnvelope, marks.hivra) : NO_ROWS,
    [mine, snapshot.hivra, marks.hivra],
  );
  // Its own failure (a rate limit, or attach not deployed yet) is reported on
  // its own: the agents and computers it did not touch stay current.
  const attached = useMemo(() => {
    if (!mine || !snapshot.hivra.hasBody) return { rows: [] as AttachedAgentLite[], failed: false };
    const rows = parseAttached(asRecord(snapshot.hivra.body)?.attached);
    return rows ? { rows, failed: false } : { rows: [] as AttachedAgentLite[], failed: hivra.settled && !hivra.failed };
  }, [mine, snapshot.hivra, hivra.settled, hivra.failed]);

  // Logged once per failed read this hook sees, never with the response.
  const hermesFailedAt = hermes.failed ? snapshot.hermes.settledAt : 0;
  const hivraFailedAt = hivra.failed ? snapshot.hivra.settledAt : 0;
  const attachedFailedAt = attached.failed ? snapshot.hivra.settledAt : 0;
  useEffect(() => {
    if (hermesFailedAt) logSourceFailure("hermes");
  }, [hermesFailedAt]);
  useEffect(() => {
    if (hivraFailedAt) logSourceFailure("hivra");
  }, [hivraFailedAt]);
  useEffect(() => {
    if (attachedFailedAt) logSourceFailure("attached");
  }, [attachedFailedAt]);

  const retryHermes = useCallback(() => inventory.load("hermes", { force: true }), [inventory]);
  const retryHivra = useCallback(() => inventory.load("hivra", { force: true }), [inventory]);
  const retryAll = useCallback(async () => {
    await Promise.all([retryHermes(), retryHivra()]);
  }, [retryHermes, retryHivra]);

  const agents = useMemo(() => unifyAll(hermes.rows, hivra.rows, attached.rows), [hermes.rows, hivra.rows, attached.rows]);
  const refreshedAt = mine ? Math.max(snapshot.hermes.settledAt, snapshot.hivra.settledAt) : 0;

  return {
    agents,
    loading: !hermes.settled || !hivra.settled,
    hermesError: hermes.failed ? HERMES_ERROR : null,
    hivraError: hivra.failed ? HIVRA_ERROR : null,
    attachedError: attached.failed ? ATTACHED_ERROR : null,
    lastRefreshedAt: refreshedAt > 0 ? new Date(refreshedAt).toISOString() : null,
    retryHermes,
    retryHivra,
    retryAll,
  };
}
