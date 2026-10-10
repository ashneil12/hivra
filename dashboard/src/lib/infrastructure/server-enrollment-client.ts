"use client";

import { z } from "zod";

import { InfrastructureConnectionDtoSchema, type InfrastructureConnectionDto } from "./contracts";
import { requestJson } from "./client";
import {
  ServerEnrollmentDtoSchema,
  ServerEnrollmentIssueResultSchema,
  ServerEnrollmentListSchema,
  type ServerEnrollmentDto,
  type ServerEnrollmentIssueResult,
  type ServerEnrollmentList,
} from "./server-enrollment-contracts";

const success = <T extends z.ZodTypeAny>(data: T) => z.object({ success: z.literal(true), data }).passthrough();
const BASE = "/api/infrastructure/server-enrollments";
const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** Issue a setup command. The command holds a one-time code: keep it in
 * memory only, never in storage, a URL or a link. */
export async function issueServerEnrollment(replaceEnrollmentId: string | null = null): Promise<ServerEnrollmentIssueResult> {
  const body = await requestJson(BASE, post(replaceEnrollmentId ? { replaceEnrollmentId } : {}),
    success(ServerEnrollmentIssueResultSchema));
  return body.data;
}

export async function listServerEnrollments(signal?: AbortSignal): Promise<ServerEnrollmentList> {
  const body = await requestJson(BASE, { method: "GET", signal }, success(ServerEnrollmentListSchema));
  return body.data;
}

export async function getServerEnrollment(id: string, signal?: AbortSignal): Promise<ServerEnrollmentDto> {
  const body = await requestJson(`${BASE}/${z.string().uuid().parse(id)}`, { method: "GET", signal },
    success(z.object({ enrollment: ServerEnrollmentDtoSchema }).strict()));
  return body.data.enrollment;
}

const ConnectionResult = success(z.object({ connection: InfrastructureConnectionDtoSchema }).strict());

export async function confirmServerEnrollment(id: string, sshHost: string | null = null): Promise<InfrastructureConnectionDto> {
  const body = await requestJson(`${BASE}/${z.string().uuid().parse(id)}/confirm`, post(sshHost ? { sshHost } : {}),
    ConnectionResult);
  return body.data.connection;
}

export async function replaceServerEnrollmentAccess(id: string, request: {
  connectionId: string; connectionRevision: number; sshHost?: string | null;
}): Promise<InfrastructureConnectionDto> {
  const body = await requestJson(`${BASE}/${z.string().uuid().parse(id)}/replace`, post({
    connectionId: request.connectionId, connectionRevision: request.connectionRevision,
    ...(request.sshHost ? { sshHost: request.sshHost } : {}),
  }), ConnectionResult);
  return body.data.connection;
}

export async function declineServerEnrollment(id: string): Promise<void> {
  await requestJson(`${BASE}/${z.string().uuid().parse(id)}/decline`, post(),
    success(z.object({ declined: z.literal(true) }).strict()));
}

export async function cancelServerEnrollment(id: string): Promise<void> {
  await requestJson(`${BASE}/${z.string().uuid().parse(id)}/cancel`, post(),
    success(z.object({ cancelled: z.literal(true) }).strict()));
}

export type CapturedHostKey = { publicKey: string; fingerprintSha256: string };

/** The advanced wizard's fallback: read the Ed25519 key the server presents.
 * The owner compares it with the provider's console before it's pinned. */
export async function captureServerHostKey(sshHost: string, sshPort: number): Promise<CapturedHostKey> {
  const body = await requestJson("/api/infrastructure/connections/host-key-capture", post({ sshHost, sshPort }),
    success(z.object({
      hostKey: z.object({
        publicKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/),
        fingerprintSha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
      }).strict(),
    }).strict()));
  return body.data.hostKey;
}
