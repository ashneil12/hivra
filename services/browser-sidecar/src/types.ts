// Shared types across the sidecar.
//
// Keep this file thin. Types specific to one module belong in that module.

export interface SessionInfo {
  session_id: string;
  identity: string;
  created_at: number;
  last_used_at: number;
}

export type ToolError =
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "TIMEOUT"
  | "ELEMENT_NOT_FOUND"
  | "NAVIGATION_FAILED"
  | "FLOW_NOT_FOUND"
  | "FLOW_FAILED"
  | "INVALID_ARGS"
  | "INTERNAL";

export interface ToolFailure {
  ok: false;
  error: ToolError;
  message: string;
  identity?: string;
  last_used?: number;
}

export interface ToolSuccess<T = unknown> {
  ok: true;
  data?: T;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;
