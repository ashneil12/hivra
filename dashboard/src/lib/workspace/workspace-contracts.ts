import type {
  AgentComputer,
  AgentComputerSourceIdentity,
  AgentComputerSurface,
} from "@/lib/agent-computers/contracts";

export type WorkspaceSurface = "conversation" | AgentComputerSurface;

export interface WorkspaceRouteState {
  agent: string | null;
  surface: WorkspaceSurface;
}

export type WorkspaceSurfaceAvailability =
  | "available"
  | "unavailable"
  | "unknown";

export interface WorkspaceSurfaceDescriptor {
  surface: WorkspaceSurface;
  label: string;
  availability: WorkspaceSurfaceAvailability;
  reason?: string;
}

/**
 * Secret-free content that the common workspace shell may retain.
 * Family-specific credentials and transport URLs stay behind render methods.
 */
interface WorkspaceAgentContent {
  uid: string;
  computer: AgentComputer;
  sourceLabel: string;
  surfaces: readonly WorkspaceSurfaceDescriptor[];
}
