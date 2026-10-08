import { z } from "zod";

import type { PolicySnapshot, PrincipalFacts } from "./types";

// The shape hivra_net_authz_context returns. Parsed strictly: anything that does
// not match is treated as "no context", which denies.

const UUID = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const layer = z.enum(["ceiling", "narrow"]);

const settingsSchema = z.object({
  networkEnabled: z.boolean(),
  paused: z.boolean(),
  buzzBindingDefault: z.enum(["allowed", "forbidden"]),
  maxHopDepth: z.number().int().min(1).max(8),
});

const policySchema = z.object({
  orgId: UUID,
  revision: z.number().int().min(1),
  settings: settingsSchema,
  groups: z.array(z.object({ id: UUID, name: z.string() })),
  groupMembers: z.array(z.object({ groupId: UUID, principalId: UUID })),
  grants: z.array(
    z.object({
      id: UUID,
      layer,
      principalId: UUID.nullable(),
      groupId: UUID.nullable(),
      source: z.string(),
      mode: z.enum(["none", "read", "write"]),
    })
  ),
  edges: z.array(
    z.object({
      id: UUID,
      layer,
      fromPrincipalId: UUID,
      toPrincipalId: UUID,
      mode: z.enum(["deny", "approve", "auto"]),
      maxMessagesPerHour: z.number().int().positive().nullable(),
      maxConcurrentRuns: z.number().int().positive().nullable(),
    })
  ),
});

const principalSchema = z.object({
  principalId: UUID,
  orgId: UUID,
  state: z.enum(["pending", "joined", "suspended", "left"]),
  ownerUserId: z.string().min(1),
  agentIdentityId: UUID,
  memberActive: z.boolean(),
});

const contextSchema = z.object({
  orgFound: z.boolean(),
  currentRevision: z.number().int().nullable(),
  requestedRevision: z.number().int().nullable(),
  policy: policySchema.nullable(),
  subject: principalSchema.nullable(),
  peer: principalSchema.nullable(),
});

export interface AuthzContext {
  orgFound: boolean;
  currentRevision: number | null;
  requestedRevision: number | null;
  policy: PolicySnapshot | null;
  subject: PrincipalFacts | null;
  peer: PrincipalFacts | null;
}

/** Strict parse of the database's answer; null when it is not exactly the contract. */
export function parseAuthzContext(value: unknown): AuthzContext | null {
  const parsed = contextSchema.safeParse(value);
  return parsed.success ? (parsed.data as AuthzContext) : null;
}
