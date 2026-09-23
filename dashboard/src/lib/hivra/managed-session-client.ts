"use client";

import { z } from "zod";

import {
  DigitalOceanConnectionCreateSchema,
  DigitalOceanDeploymentTargetDtoSchema,
  InfrastructureConnectionDtoSchema,
  type DigitalOceanConnectionCreate,
  type DigitalOceanConnectionDto,
  type DigitalOceanDeploymentTargetDto,
} from "@/lib/infrastructure/contracts";
import {
  ManagedSessionLaunchSchema,
  type ManagedSessionDto,
  type ManagedSessionLaunchInput,
} from "@/lib/hivra/managed-session-contracts";
import type { ManagedSessionEvent } from "@/lib/hivra/managed-session-transcript";

export class ManagedSessionApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "ManagedSessionApiError";
  }
}

const ManagedSessionDtoSchema: z.ZodType<ManagedSessionDto> = z.object({
  agentId: z.string().uuid(),
  name: z.string(),
  harness: z.enum(["claude-code", "codex", "hermes"]),
  size: z.enum(["mars-1vcpu-1gb", "mars-2vcpu-2gb", "mars-2vcpu-4gb", "mars-4vcpu-8gb", "mars-16vcpu-32gb"]),
  status: z.enum(["provisioning", "ready", "paused", "error", "deleting", "deleted"]),
  providerStatus: z.string().nullable(),
  pauseReason: z.string().nullable(),
  sessionId: z.string().nullable(),
  connectionId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

const SanitizedEventSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  type: z.string(),
  at: z.string().nullable(),
  data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
}) as unknown as z.ZodType<ManagedSessionEvent>;

async function request<T>(input: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      cache: "no-store",
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new ManagedSessionApiError("Hivra could not be reached. Check your connection and try again.", 0);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = body && typeof body === "object" ? body as { error?: unknown; code?: unknown } : {};
    throw new ManagedSessionApiError(
      typeof error.error === "string" && error.error ? error.error : `Request failed (${response.status}).`,
      response.status,
      typeof error.code === "string" ? error.code : undefined,
    );
  }
  const envelope = z.object({ success: z.literal(true), data: z.unknown() }).passthrough().safeParse(body);
  const parsed = envelope.success ? schema.safeParse(envelope.data.data) : null;
  if (!parsed?.success) throw new ManagedSessionApiError("Hivra returned an unexpected response. Refresh and try again.", response.status);
  return parsed.data;
}

const ConnectionResultSchema = z.object({
  connection: InfrastructureConnectionDtoSchema.refine((connection) => connection.provider === "digitalocean"),
  target: DigitalOceanDeploymentTargetDtoSchema,
}) as unknown as z.ZodType<{ connection: DigitalOceanConnectionDto; target: DigitalOceanDeploymentTargetDto }>;

export async function connectDigitalOceanAccount(input: DigitalOceanConnectionCreate) {
  const validated = DigitalOceanConnectionCreateSchema.parse(input);
  return request("/api/infrastructure/connections", { method: "POST", body: JSON.stringify(validated) }, ConnectionResultSchema);
}

export async function refreshDigitalOceanAccount(connectionId: string) {
  return request(`/api/infrastructure/connections/${encodeURIComponent(connectionId)}/digitalocean/refresh`, { method: "POST" }, ConnectionResultSchema);
}

export async function listManagedSessions(signal?: AbortSignal) {
  return request("/api/hivra/managed-sessions", { method: "GET", signal }, z.object({
    sessions: z.array(ManagedSessionDtoSchema),
    targets: z.array(DigitalOceanDeploymentTargetDtoSchema),
  }));
}

export async function launchManagedSession(input: ManagedSessionLaunchInput): Promise<ManagedSessionDto> {
  const validated = ManagedSessionLaunchSchema.parse(input);
  return (await request("/api/hivra/managed-sessions", { method: "POST", body: JSON.stringify(validated) }, z.object({ session: ManagedSessionDtoSchema }))).session;
}

export async function getManagedSession(agentId: string, options: { reconcile?: boolean; signal?: AbortSignal } = {}): Promise<ManagedSessionDto> {
  const query = options.reconcile ? "?reconcile=1" : "";
  return (await request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}${query}`, { method: "GET", signal: options.signal }, z.object({ session: ManagedSessionDtoSchema }))).session;
}

export async function changeManagedSession(agentId: string, action: "pause" | "resume" | "delete"): Promise<ManagedSessionDto> {
  return (await request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/lifecycle`, { method: "POST", body: JSON.stringify({ action }) }, z.object({ session: ManagedSessionDtoSchema }))).session;
}

export async function sendManagedSessionMessage(agentId: string, text: string): Promise<{ runId: string | null }> {
  return request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/input`, { method: "POST", body: JSON.stringify({ text }) }, z.object({ runId: z.string().nullable() }));
}

export async function answerManagedSessionApproval(agentId: string, requestId: string, outcome: "approve" | "reject"): Promise<void> {
  await request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify({ outcome }) }, z.object({ submitted: z.literal(true) }));
}

export async function readManagedSessionHistory(agentId: string, signal?: AbortSignal) {
  return request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/history`, { method: "GET", signal }, z.object({
    events: z.array(SanitizedEventSchema),
    prompts: z.array(z.object({ runId: z.string(), text: z.string(), createdAt: z.string() })),
  }));
}

export function managedSessionEventsUrl(agentId: string, after: string | null): string {
  const query = after ? `?${new URLSearchParams({ after })}` : "";
  return `/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/events${query}`;
}

export function parseManagedSessionStreamEvent(data: string): ManagedSessionEvent | null {
  try {
    const parsed = SanitizedEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
