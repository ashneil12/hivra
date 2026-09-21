import { z } from "zod";

const RELATIONSHIP_SNAPSHOT_VERSION = "2026-09-06-relationships-v1" as const;
const Id = z.string().uuid();
const Owner = z.string().min(1).max(256);
const Sequence = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n, "PostgreSQL bigint required");
const Name = z.string().min(1).max(256);
const Authority = z.object({
  writer: z.enum(["legacy", "canonical"]),
  generation: Sequence,
  commandId: Id.nullable(),
}).strict().superRefine((value, context) => {
  if (value.writer === "legacy"
    ? value.generation !== "1" || value.commandId !== null
    : value.generation === "1" || value.commandId === null) {
    context.addIssue({ code: "custom", message: "Authority epoch and command do not match" });
  }
});
const Identity = z.object({
  id: Id, ownerId: Owner, name: Name, status: z.enum(["active", "archived"]),
  sourceEventId: Sequence, authority: Authority,
}).strict();
const Installation = z.object({
  id: Id, ownerId: Owner, computerId: Id,
  runtimeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  status: z.enum(["unknown", "installing", "ready", "failed", "removed"]),
  sourceEventId: Sequence, authority: Authority,
}).strict();
const Binding = z.object({
  id: Id, ownerId: Owner, computerId: Id, agentIdentityId: Id,
  status: z.enum(["active", "detached"]), sourceEventId: Sequence,
  boundAt: z.string().datetime({ offset: true }), detachedAt: z.string().datetime({ offset: true }).nullable(),
  authority: Authority,
}).strict().superRefine((value, context) => {
  if ((value.status === "active") !== (value.detachedAt === null)) {
    context.addIssue({ code: "custom", message: "Binding state and detachment receipt disagree" });
  }
});

/** Current relationships, not the original launch's fixed identity slots.
 * Status is observed storage state, never an aggregate runtime-readiness claim.
 * Epochs/source event IDs stay strings to preserve PostgreSQL bigint precision.
 */
export const CanonicalRelationshipSnapshotSchema = z.object({
  contractVersion: z.literal(RELATIONSHIP_SNAPSHOT_VERSION),
  computerId: Id, ownerId: Owner, name: Name,
  source: z.object({ kind: z.enum(["hermes", "hivra"]), id: Id,
    alias: z.string(), resourceKind: z.enum(["agent", "computer"]) }).strict(),
  lifecycle: z.object({ authority: Authority, sourceEventId: Sequence,
    desired: z.enum(["absent", "running", "stopped", "unknown"]),
    observed: z.enum(["unknown", "missing", "provisioning", "running", "stopped", "suspended", "deleting", "error"]),
    tombstoned: z.boolean(),
  }).strict(),
  relationshipAuthority: Authority,
  identities: z.array(Identity), installations: z.array(Installation), bindings: z.array(Binding),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (value.source.alias !== `${value.source.kind === "hermes" ? "h" : "x"}-${value.source.id}`) issue("Source alias mismatch");
  if (value.lifecycle.authority.writer !== "legacy") issue("Unsupported lifecycle writer");
  for (const entities of [value.identities, value.installations, value.bindings]) {
    if (new Set(entities.map(entity => entity.id)).size !== entities.length) issue("Duplicate entity ID");
    if (entities.some(entity => entity.ownerId !== value.ownerId)) issue("Relationship owner mismatch");
  }
  if ([...value.installations, ...value.bindings].some(entity => entity.computerId !== value.computerId)) issue("Relationship computer mismatch");
  const identities = new Set(value.identities.map(identity => identity.id));
  if (value.bindings.some(binding => !identities.has(binding.agentIdentityId))) issue("Binding identity missing");
  if (value.identities.some(identity => !value.bindings.some(binding => binding.agentIdentityId === identity.id))) issue("Unrelated identity");
  if (value.bindings.filter(binding => binding.status === "active").length > 1) issue("Multiple active primary bindings");
});

export type CanonicalRelationshipSnapshot = z.infer<typeof CanonicalRelationshipSnapshotSchema>;
