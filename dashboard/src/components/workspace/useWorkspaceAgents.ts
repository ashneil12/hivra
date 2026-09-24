"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clientLog } from "@/lib/client/logger";
import { listAgentsResult, type HivraAgent } from "@/lib/hivra/agent-api";
import {
  unifyAll,
  type HermesInstanceLite,
  type UnifiedAgent,
} from "@/lib/hivra/unified-agent";

type WorkspaceSourceFetcher = () => Promise<unknown>;

export interface UseWorkspaceAgentsOptions {
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

function parseHivraResult(value: unknown): HivraAgent[] {
  const result = asRecord(value);
  if (!result || result.error !== null || !Array.isArray(result.agents)) {
    throw new Error("invalid-hivra-result");
  }

  return result.agents.map((candidate) => {
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

async function defaultFetchHermes(): Promise<unknown> {
  const response = await fetch("/api/instances?summary=true", { cache: "no-store" });
  if (!response.ok) throw new Error("hermes-source-unavailable");
  return response.json();
}

async function defaultFetchHivra(): Promise<unknown> {
  return listAgentsResult();
}

function defaultNow(): Date {
  return new Date();
}

function logSourceFailure(agentSource: "hermes" | "hivra"): void {
  clientLog.warn("Workspace agent source unavailable", {
    source: "workspace-agents",
    agentSource,
    failureType: `workspace_${agentSource}_source_failed`,
  });
}

export function useWorkspaceAgents(
  options: UseWorkspaceAgentsOptions = {},
): UseWorkspaceAgentsResult {
  const fetchersRef = useRef({
    fetchHermes: options.fetchHermes ?? defaultFetchHermes,
    fetchHivra: options.fetchHivra ?? defaultFetchHivra,
    getNow: options.getNow ?? defaultNow,
  });
  const mountedRef = useRef(false);
  const hermesGenerationRef = useRef(0);
  const hivraGenerationRef = useRef(0);
  const [hermesRows, setHermesRows] = useState<HermesInstanceLite[]>([]);
  const [hivraRows, setHivraRows] = useState<HivraAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hermesError, setHermesError] = useState<string | null>(null);
  const [hivraError, setHivraError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  const markRefreshed = useCallback(() => {
    setLastRefreshedAt(fetchersRef.current.getNow().toISOString());
  }, []);

  const applyHermesResult = useCallback(
    (result: PromiseSettledResult<unknown>, generation: number) => {
      if (!mountedRef.current || generation !== hermesGenerationRef.current) return;
      try {
        if (result.status === "rejected") throw new Error("source-rejected");
        setHermesRows(parseHermesEnvelope(result.value));
        setHermesError(null);
      } catch {
        setHermesError(HERMES_ERROR);
        logSourceFailure("hermes");
      }
    },
    [],
  );

  const applyHivraResult = useCallback(
    (result: PromiseSettledResult<unknown>, generation: number) => {
      if (!mountedRef.current || generation !== hivraGenerationRef.current) return;
      try {
        if (result.status === "rejected") throw new Error("source-rejected");
        setHivraRows(parseHivraResult(result.value));
        setHivraError(null);
      } catch {
        setHivraError(HIVRA_ERROR);
        logSourceFailure("hivra");
      }
    },
    [],
  );

  const loadBoth = useCallback(
    async (initial: boolean) => {
      const hermesGeneration = ++hermesGenerationRef.current;
      const hivraGeneration = ++hivraGenerationRef.current;
      if (initial && mountedRef.current) setLoading(true);

      const [hermesResult, hivraResult] = await Promise.allSettled([
        fetchersRef.current.fetchHermes(),
        fetchersRef.current.fetchHivra(),
      ]);
      if (!mountedRef.current) return;

      applyHermesResult(hermesResult, hermesGeneration);
      applyHivraResult(hivraResult, hivraGeneration);
      markRefreshed();
      if (initial) setLoading(false);
    },
    [applyHermesResult, applyHivraResult, markRefreshed],
  );

  const retryHermes = useCallback(async () => {
    const generation = ++hermesGenerationRef.current;
    const [result] = await Promise.allSettled([fetchersRef.current.fetchHermes()]);
    if (!mountedRef.current) return;
    applyHermesResult(result, generation);
    markRefreshed();
  }, [applyHermesResult, markRefreshed]);

  const retryHivra = useCallback(async () => {
    const generation = ++hivraGenerationRef.current;
    const [result] = await Promise.allSettled([fetchersRef.current.fetchHivra()]);
    if (!mountedRef.current) return;
    applyHivraResult(result, generation);
    markRefreshed();
  }, [applyHivraResult, markRefreshed]);

  const retryAll = useCallback(async () => {
    await loadBoth(false);
  }, [loadBoth]);

  useEffect(() => {
    mountedRef.current = true;
    void loadBoth(true);
    return () => {
      mountedRef.current = false;
      hermesGenerationRef.current += 1;
      hivraGenerationRef.current += 1;
    };
  }, [loadBoth]);

  const agents = useMemo(() => unifyAll(hermesRows, hivraRows), [hermesRows, hivraRows]);

  return {
    agents,
    loading,
    hermesError,
    hivraError,
    lastRefreshedAt,
    retryHermes,
    retryHivra,
    retryAll,
  };
}
