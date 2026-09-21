import {
  AGENT_COMPUTER_SURFACES,
  type AgentComputer,
  type AgentComputerSurface,
} from "@/lib/agent-computers/contracts";
import {
  projectWorkspaceHermes,
  projectWorkspaceHivra,
  type WorkspaceProjectionReason,
} from "@/lib/agent-computers/workspace-projection";
import type { UnifiedAgent, UnifiedKind } from "@/lib/hivra/unified-agent";

export const RELEASE_CAPABILITY_SURFACES = AGENT_COMPUTER_SURFACES;

export const RELEASE_CAPABILITY_REASON_CODES = [
  "evidence-resolved",
  "capability-advertised",
  "capability-not-advertised",
  "implementation-unavailable",
  "access-unavailable",
  "detail-unavailable",
  "invalid-detail",
  "invalid-projection",
  "missing-evidence",
  "deleted-record",
  "unsupported-record",
] as const;

export const RELEASE_CAPABILITY_MATRIX_FIELDS = ["rows", "aggregate"] as const;

type ReleaseCapabilityReasonCode =
  (typeof RELEASE_CAPABILITY_REASON_CODES)[number];
type ReleaseCapabilityState =
  | "ready"
  | "unavailable"
  | "unsupported"
  | "unknown";
type ReleaseAggregateSupport = "yes" | "no" | "unknown";

interface ReleaseCapabilitySurfaceEvidence {
  state: ReleaseCapabilityState;
  reason: ReleaseCapabilityReasonCode;
}

type ReleaseCapabilitySurfaceMap = Record<
  AgentComputerSurface,
  ReleaseCapabilitySurfaceEvidence
>;

export interface ReleaseCapabilityRow {
  family: UnifiedKind;
  ordinal: number;
  detailState: "resolved" | "unknown";
  detailReason: ReleaseCapabilityReasonCode;
  surfaces: ReleaseCapabilitySurfaceMap;
}

interface ReleaseCapabilityAggregate {
  totalAgents: number;
  resolvedAgents: number;
  unknownAgents: number;
  surfaces: Record<AgentComputerSurface, ReleaseAggregateSupport>;
}

export interface ReleaseCapabilityMatrix {
  rows: ReleaseCapabilityRow[];
  aggregate: ReleaseCapabilityAggregate;
}

export type ReleaseAgentDetailLoader = (
  agent: UnifiedAgent,
  signal: AbortSignal,
) => Promise<unknown>;

export interface BuildReleaseCapabilityMatrixOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

interface IndexedAgent {
  agent: UnifiedAgent;
  family: UnifiedKind;
  ordinal: number;
}

interface ResolvedDetail {
  computer: AgentComputer;
  hasHivraFileAccess: boolean;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const HERMES_IMPLEMENTED = new Set<AgentComputerSurface>([
  "workspace",
  "terminal",
  "browser",
  "native",
]);
const HIVRA_IMPLEMENTED = new Set<AgentComputerSurface>([
  "workspace",
  "files",
  "git",
  "terminal",
  "browser",
  // Computer profiles render a desktop in both routes now. Without this the
  // matrix reported a computer's own primary surface as "unsupported" while the
  // UI happily rendered it — a second, independent copy of the implemented set
  // disagreeing with the first.
  "desktop",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasSafeHttpAccessUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function projectionReason(
  reason: WorkspaceProjectionReason,
): ReleaseCapabilityReasonCode {
  return reason === "invalid-record" ? "invalid-projection" : reason;
}

function resolveDetail(
  indexed: IndexedAgent,
  value: unknown,
): ResolvedDetail | ReleaseCapabilityReasonCode {
  const detail = asRecord(value);
  if (
    !detail ||
    detail.kind !== indexed.family ||
    detail.uid !== indexed.agent.uid
  ) {
    return "invalid-detail";
  }

  if (indexed.family === "hermes") {
    const instance = asRecord(detail.instance);
    if (!instance) return "invalid-detail";
    const projection = projectWorkspaceHermes(instance);
    if (!projection.ok) return projectionReason(projection.reason);
    if (projection.computer.id !== indexed.agent.uid) return "invalid-detail";
    return { computer: projection.computer, hasHivraFileAccess: false };
  }

  const agent = asRecord(detail.agent);
  if (!agent) return "invalid-detail";
  const projection = projectWorkspaceHivra({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    type: agent.type,
    computerProfile: agent.computer_profile,
    browserEnabled:
      detail.browserEnabled === true || agent.browser_enabled === true,
    canProvision: agent.canProvision === true,
  });
  if (!projection.ok) return projectionReason(projection.reason);
  if (projection.computer.id !== indexed.agent.uid) return "invalid-detail";
  return {
    computer: projection.computer,
    hasHivraFileAccess: hasSafeHttpAccessUrl(agent.chat_url),
  };
}

function unknownSurfaces(
  reason: ReleaseCapabilityReasonCode,
): ReleaseCapabilitySurfaceMap {
  return Object.fromEntries(
    RELEASE_CAPABILITY_SURFACES.map((surface) => [
      surface,
      { state: "unknown", reason },
    ]),
  ) as ReleaseCapabilitySurfaceMap;
}

function resolvedSurfaces(
  family: UnifiedKind,
  detail: ResolvedDetail,
): ReleaseCapabilitySurfaceMap {
  const advertised = new Set(detail.computer.capabilities.surfaces);
  const implemented = family === "hermes" ? HERMES_IMPLEMENTED : HIVRA_IMPLEMENTED;

  return Object.fromEntries(
    RELEASE_CAPABILITY_SURFACES.map((surface) => {
      if (!advertised.has(surface)) {
        return [
          surface,
          {
            state: "unsupported",
            reason: "capability-not-advertised",
          },
        ];
      }
      if (!implemented.has(surface)) {
        return [
          surface,
          {
            state: "unsupported",
            reason: "implementation-unavailable",
          },
        ];
      }
      if (
        family === "hivra" &&
        (surface === "files" || surface === "git") &&
        !detail.hasHivraFileAccess
      ) {
        return [
          surface,
          { state: "unavailable", reason: "access-unavailable" },
        ];
      }
      return [
        surface,
        { state: "ready", reason: "capability-advertised" },
      ];
    }),
  ) as ReleaseCapabilitySurfaceMap;
}

function rowFromSettled(
  indexed: IndexedAgent,
  settled: PromiseSettledResult<unknown>,
): ReleaseCapabilityRow {
  if (settled.status === "rejected") {
    return {
      family: indexed.family,
      ordinal: indexed.ordinal,
      detailState: "unknown",
      detailReason: "detail-unavailable",
      surfaces: unknownSurfaces("detail-unavailable"),
    };
  }

  const detail = resolveDetail(indexed, settled.value);
  if (typeof detail === "string") {
    return {
      family: indexed.family,
      ordinal: indexed.ordinal,
      detailState: "unknown",
      detailReason: detail,
      surfaces: unknownSurfaces(detail),
    };
  }

  return {
    family: indexed.family,
    ordinal: indexed.ordinal,
    detailState: "resolved",
    detailReason: "evidence-resolved",
    surfaces: resolvedSurfaces(indexed.family, detail),
  };
}

function aggregateSurface(
  rows: ReleaseCapabilityRow[],
  surface: AgentComputerSurface,
): ReleaseAggregateSupport {
  if (rows.length === 0) return "no";
  const states = rows.map((row) => row.surfaces[surface].state);
  if (states.includes("unknown")) return "unknown";
  return states.includes("ready") ? "yes" : "no";
}

function buildAggregate(rows: ReleaseCapabilityRow[]): ReleaseCapabilityAggregate {
  const resolvedAgents = rows.filter(
    ({ detailState }) => detailState === "resolved",
  ).length;
  return {
    totalAgents: rows.length,
    resolvedAgents,
    unknownAgents: rows.length - resolvedAgents,
    surfaces: Object.fromEntries(
      RELEASE_CAPABILITY_SURFACES.map((surface) => [
        surface,
        aggregateSurface(rows, surface),
      ]),
    ) as ReleaseCapabilityAggregate["surfaces"],
  };
}

function boundedConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.trunc(value), MAX_CONCURRENCY);
}

export async function buildReleaseCapabilityMatrix(
  agents: readonly UnifiedAgent[],
  loadDetail: ReleaseAgentDetailLoader,
  options: BuildReleaseCapabilityMatrixOptions = {},
): Promise<ReleaseCapabilityMatrix> {
  const familyOrdinals: Record<UnifiedKind, number> = { hermes: 0, hivra: 0 };
  const indexedAgents: IndexedAgent[] = agents.map((agent) => ({
    agent,
    family: agent.kind,
    ordinal: (familyOrdinals[agent.kind] += 1),
  }));
  const rows: ReleaseCapabilityRow[] = [];
  const concurrency = boundedConcurrency(options.concurrency);
  const signal = options.signal ?? new AbortController().signal;

  for (let offset = 0; offset < indexedAgents.length; offset += concurrency) {
    const batch = indexedAgents.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      batch.map(({ agent }) => loadDetail(agent, signal)),
    );
    settled.forEach((result, index) => {
      rows.push(rowFromSettled(batch[index], result));
    });
  }

  return {
    rows,
    aggregate: buildAggregate(rows),
  };
}

export function releaseAgentLabel(row: ReleaseCapabilityRow): string {
  const family = row.family === "hermes" ? "Hermes" : "Hivra";
  return `${family} agent ${row.ordinal}`;
}

function surfaceLabel(surface: AgentComputerSurface): string {
  return surface.charAt(0).toUpperCase() + surface.slice(1);
}

export function serializeReleaseCapabilityMatrix(
  matrix: ReleaseCapabilityMatrix,
): string {
  const lines = [
    "Capability matrix",
    `Agents: ${matrix.aggregate.totalAgents} total; ${matrix.aggregate.resolvedAgents} resolved; ${matrix.aggregate.unknownAgents} unknown`,
  ];

  for (const row of matrix.rows) {
    lines.push(
      `${releaseAgentLabel(row)} — detail ${row.detailState} (${row.detailReason})`,
    );
    for (const surface of RELEASE_CAPABILITY_SURFACES) {
      const evidence = row.surfaces[surface];
      lines.push(
        `  ${surfaceLabel(surface)}: ${evidence.state} (${evidence.reason})`,
      );
    }
  }

  lines.push("Aggregate support");
  for (const surface of RELEASE_CAPABILITY_SURFACES) {
    lines.push(`  ${surfaceLabel(surface)}: ${matrix.aggregate.surfaces[surface]}`);
  }
  return lines.join("\n");
}
