"use client";

import { z } from "zod";

import {
  CredentialExpiryDtoSchema,
  DigitalOceanConnectionCreateSchema,
  DigitalOceanDeploymentTargetDtoSchema,
  InfrastructureConnectionDtoSchema,
  ProviderTokenExpiryInputSchema,
  type CredentialExpiryDto,
  type DigitalOceanConnectionCreate,
  type DigitalOceanConnectionDto,
  type DigitalOceanDeploymentTargetDto,
  type ProviderTokenExpiryInput,
} from "@/lib/infrastructure/contracts";
import {
  ManagedSessionLaunchSchema,
  type ManagedSessionDto,
  type ManagedSessionLaunchInput,
  type ManagedWorkspaceListing,
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

export async function replaceDigitalOceanAccountToken(connectionId: string, apiToken: string, tokenExpiry?: ProviderTokenExpiryInput) {
  const expiry = tokenExpiry ? ProviderTokenExpiryInputSchema.parse(tokenExpiry) : undefined;
  return request(`/api/infrastructure/connections/${encodeURIComponent(connectionId)}/digitalocean/token`, {
    method: "POST",
    body: JSON.stringify({ apiToken, ...(expiry ? { tokenExpiry: expiry } : {}) }),
  }, ConnectionResultSchema);
}

export async function setDigitalOceanAccountTokenExpiry(connectionId: string, tokenExpiry: ProviderTokenExpiryInput): Promise<CredentialExpiryDto> {
  const expiry = ProviderTokenExpiryInputSchema.parse(tokenExpiry);
  return (await request(`/api/infrastructure/connections/${encodeURIComponent(connectionId)}/digitalocean/token-expiry`, {
    method: "PUT",
    body: JSON.stringify({ tokenExpiry: expiry }),
  }, z.object({ credentialExpiry: CredentialExpiryDtoSchema }))).credentialExpiry;
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
  return (await getManagedSessionWithExpiry(agentId, options)).session;
}

/** The session plus the owner-declared expiry of its DigitalOcean token, when recorded. */
export async function getManagedSessionWithExpiry(
  agentId: string,
  options: { reconcile?: boolean; signal?: AbortSignal } = {},
): Promise<{ session: ManagedSessionDto; credentialExpiry: CredentialExpiryDto | null }> {
  const query = options.reconcile ? "?reconcile=1" : "";
  const result = await request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}${query}`, { method: "GET", signal: options.signal }, z.object({
    session: ManagedSessionDtoSchema,
    credentialExpiry: CredentialExpiryDtoSchema.nullable().optional(),
  }));
  return { session: result.session, credentialExpiry: result.credentialExpiry ?? null };
}

/** Errors that mean Hivra's saved DigitalOcean token cannot manage this agent. */
export function isManagedSessionCredentialProblem(error: unknown): error is ManagedSessionApiError {
  return error instanceof ManagedSessionApiError
    && (error.code === "invalid_credentials" || error.code === "provider_forbidden" || error.code === "connection_changed");
}

export async function changeManagedSession(agentId: string, action: "pause" | "resume" | "delete"): Promise<ManagedSessionDto> {
  return (await request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/lifecycle`, { method: "POST", body: JSON.stringify({ action }) }, z.object({ session: ManagedSessionDtoSchema }))).session;
}

export type DigitalOceanBalance =
  | { state: "unreadable" }
  | { state: "ok" | "empty" | "blocked"; balance: string | null; autoPrepay: boolean; checkedAt: string };

const DigitalOceanBalanceSchema: z.ZodType<DigitalOceanBalance> = z.union([
  z.object({ state: z.literal("unreadable") }),
  z.object({
    state: z.enum(["ok", "empty", "blocked"]),
    balance: z.string().nullable(),
    autoPrepay: z.boolean(),
    checkedAt: z.string(),
  }),
]);

export async function getDigitalOceanBalance(connectionId: string, signal?: AbortSignal): Promise<DigitalOceanBalance> {
  return (await request(`/api/infrastructure/connections/${encodeURIComponent(connectionId)}/digitalocean/balance`, { method: "GET", signal },
    z.object({ balance: DigitalOceanBalanceSchema }))).balance;
}

/** "$12.34" from DigitalOcean's decimal string. */
export function formatDigitalOceanBalance(balance: string | null): string {
  if (balance === null) return "unknown";
  const amount = Number(balance);
  return Number.isFinite(amount) ? amount.toLocaleString(undefined, { style: "currency", currency: "USD" }) : "unknown";
}

export async function listDigitalOceanModels(connectionId: string, signal?: AbortSignal): Promise<string[]> {
  return (await request(`/api/infrastructure/connections/${encodeURIComponent(connectionId)}/digitalocean/models`, { method: "GET", signal },
    z.object({ models: z.array(z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/)) }))).models;
}

/** Release an agent whose DigitalOcean token no longer works. Nothing is deleted at DigitalOcean. */
export async function forgetManagedSession(agentId: string): Promise<ManagedSessionDto> {
  return (await request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/forget`, {
    method: "POST",
    body: JSON.stringify({ acknowledge: "session-may-remain-at-digitalocean" }),
  }, z.object({ session: ManagedSessionDtoSchema }))).session;
}

const ManagedWorkspaceListingSchema: z.ZodType<ManagedWorkspaceListing> = z.object({
  path: z.string(),
  entries: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(["file", "directory", "symlink", "other"]),
    sizeBytes: z.number().int().nonnegative().nullable(),
    modifiedAt: z.string().nullable(),
  })),
  truncated: z.boolean(),
});

export async function listManagedWorkspace(agentId: string, path: string, signal?: AbortSignal): Promise<ManagedWorkspaceListing> {
  const query = path ? `?${new URLSearchParams({ path })}` : "";
  return (await request(`/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/workspace${query}`, { method: "GET", signal },
    z.object({ listing: ManagedWorkspaceListingSchema }))).listing;
}

export function managedWorkspaceDownloadUrl(agentId: string, path: string, options: { archive?: boolean } = {}): string {
  const query = new URLSearchParams({ path });
  if (options.archive) query.set("archive", "1");
  return `/api/hivra/managed-sessions/${encodeURIComponent(agentId)}/workspace/download?${query}`;
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
    // Rows recorded before the source column existed are the owner's.
    prompts: z.array(z.object({ runId: z.string(), text: z.string(), createdAt: z.string(),
      source: z.enum(["user", "hivra-setup"]).default("user") })),
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
