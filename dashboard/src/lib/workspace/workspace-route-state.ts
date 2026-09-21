import {
  AGENT_COMPUTER_SURFACES,
  type AgentComputerSurface,
} from "@/lib/agent-computers/contracts";

import type { WorkspaceRouteState, WorkspaceSurface } from "./workspace-contracts";

const WORKSPACE_PATH = "/dashboard/workspace";
const MAX_BACKING_ID_LENGTH = 128;
const WORKSPACE_SURFACES = new Set<WorkspaceSurface>([
  "conversation",
  ...AGENT_COMPUTER_SURFACES,
]);
const SOURCE_QUALIFIED_UID = new RegExp(
  `^[hx]-[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_BACKING_ID_LENGTH - 1}}$`,
);
const TOKEN_MARKERS = /(?:^|[-_.:])(bearer|token|api[-_]?key|secret|sk[-_]|pk[-_])/i;
const JWT_LIKE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const WORKSPACE_SURFACE_UNAVAILABLE_NOTICE =
  "That surface is not available for this agent." as const;

export interface NormalizedWorkspaceRoute {
  route: WorkspaceRouteState;
  notice: typeof WORKSPACE_SURFACE_UNAVAILABLE_NOTICE | null;
}

function isWorkspaceAgentUid(value: unknown): value is string {
  if (typeof value !== "string" || !SOURCE_QUALIFIED_UID.test(value)) {
    return false;
  }

  const backingId = value.slice(2);
  return !TOKEN_MARKERS.test(backingId) && !JWT_LIKE.test(backingId);
}

function isWorkspaceSurface(value: unknown): value is WorkspaceSurface {
  return typeof value === "string" && WORKSPACE_SURFACES.has(value as WorkspaceSurface);
}

function readParams(input: URLSearchParams | string): URLSearchParams {
  if (input instanceof URLSearchParams) {
    return new URLSearchParams(input);
  }

  if (!input.startsWith("?")) {
    return new URLSearchParams();
  }

  return new URLSearchParams(input.slice(1).split("#", 1)[0]);
}

export function parseWorkspaceRoute(
  input: URLSearchParams | string,
): WorkspaceRouteState {
  const params = readParams(input);
  const agentValue = params.get("agent");
  const agent = isWorkspaceAgentUid(agentValue) ? agentValue : null;

  if (!agent) {
    return { agent: null, surface: "conversation" };
  }

  const surfaceValue = params.get("surface");
  return {
    agent,
    surface: isWorkspaceSurface(surfaceValue) ? surfaceValue : "conversation",
  };
}

export function normalizeWorkspaceRoute(
  route: WorkspaceRouteState,
  advertisedSurfaces: readonly AgentComputerSurface[],
): NormalizedWorkspaceRoute {
  if (!route.agent) {
    return {
      route: { agent: null, surface: "conversation" },
      notice: null,
    };
  }

  if (
    route.surface === "conversation" ||
    advertisedSurfaces.includes(route.surface)
  ) {
    return { route, notice: null };
  }

  return {
    route: { agent: route.agent, surface: "conversation" },
    notice: WORKSPACE_SURFACE_UNAVAILABLE_NOTICE,
  };
}

export function serializeWorkspaceRoute(value: WorkspaceRouteState): string {
  if (!isWorkspaceAgentUid(value?.agent)) {
    return WORKSPACE_PATH;
  }

  if (!isWorkspaceSurface(value.surface)) {
    return WORKSPACE_PATH;
  }

  const params = new URLSearchParams();
  params.set("agent", value.agent);
  params.set("surface", value.surface);
  return `${WORKSPACE_PATH}?${params.toString()}`;
}
