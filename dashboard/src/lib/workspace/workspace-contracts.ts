import type { AgentComputerSurface } from "@/lib/agent-computers/contracts";

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
