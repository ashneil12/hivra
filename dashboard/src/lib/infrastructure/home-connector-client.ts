"use client";

import { z } from "zod";

const Envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ success: z.literal(true), data });
const EnabledSchema = Envelope(z.object({ enabled: z.boolean() }));
const EnrolmentDtoSchema = z.object({
  connectorId: z.string().uuid(),
  hostname: z.string().min(1),
  expiresAt: z.string(),
  command: z.string().min(1),
});
const EnrolmentSchema = Envelope(z.object({ enrolment: EnrolmentDtoSchema }));
const StatusSchema = Envelope(z.object({ online: z.boolean(), revoked: z.boolean(), hostname: z.string() }));

export type HomeConnectorEnrolmentDto = z.infer<typeof EnrolmentDtoSchema>;

/** The server's own answer: is connecting a machine on your network on here? Off on any failure. */
export async function getHomeConnectorEnabled(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/api/infrastructure/home-connector", { cache: "no-store", signal });
    if (!response.ok) return false;
    const parsed = EnabledSchema.safeParse(await response.json());
    return parsed.success && parsed.data.data.enabled;
  } catch {
    return false;
  }
}

export async function startHomeConnector(): Promise<HomeConnectorEnrolmentDto> {
  const response = await fetch("/api/infrastructure/home-connector", { method: "POST", cache: "no-store" });
  const parsed = EnrolmentSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new Error("Hivra could not start connecting a machine. Try again shortly.");
  return parsed.data.data.enrolment;
}

export async function getHomeConnectorStatus(connectorId: string, signal?: AbortSignal): Promise<{ online: boolean; revoked: boolean } | null> {
  try {
    const response = await fetch(`/api/infrastructure/home-connector/${connectorId}`, { cache: "no-store", signal });
    if (!response.ok) return null;
    const parsed = StatusSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.data : null;
  } catch {
    return null;
  }
}
