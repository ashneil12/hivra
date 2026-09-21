// Pure wire-contract helpers: no credentials or privileged I/O. Keep this
// module usable by the existing standalone Node operations clients as well.
import { z } from "zod";

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const ID = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ScopeSchema = z.object({
  orderId: UUID, attemptId: UUID, quoteFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  serverId: ID,
}).strict();
export type FirstBootFirewallScope = z.infer<typeof ScopeSchema>;
const ActionSchema = z.object({
  id: ID, command: z.string(), status: z.enum(["running", "success", "error"]),
  resources: z.array(z.object({ id: ID, type: z.string() }).strict()).min(1).max(2),
});
const RuleSchema = z.object({
  direction: z.literal("in"), protocol: z.literal("tcp"), port: z.enum(["22", "80", "443"]),
  source_ips: z.array(z.string()).length(2), destination_ips: z.array(z.string()).length(0),
  description: z.null().optional(),
}).strict();
const AttachmentSchema = z.object({
  type: z.literal("server"), server: z.object({ id: ID }).strict(),
  label_selector: z.null().optional(), applied_to_resources: z.array(z.never()).length(0).optional(),
}).strict();
const FirewallSchema = z.object({
  id: ID, name: z.string(), labels: z.record(z.string(), z.string()),
  created: z.string().datetime({ offset: true }), rules: z.array(RuleSchema).min(1).max(3),
  applied_to: z.array(AttachmentSchema).max(1),
});
const ReceiptSchema = z.object({
  version: z.literal(1), scope: ScopeSchema, firewallId: ID,
  createdAt: z.string().datetime({ offset: true }),
  setRulesActionId: ID, applyActionId: ID,
}).strict().refine(value => value.setRulesActionId !== value.applyActionId);
export type FirstBootFirewallReceipt = z.infer<typeof ReceiptSchema>;
export type FirstBootFirewall = z.infer<typeof FirewallSchema>;

export class FirstBootFirewallError extends Error {
  constructor(readonly code: "invalid_scope" | "invalid_receipt" | "resource_changed" | "action_failed" | "still_attached") {
    super("First-boot firewall check failed: " + code);
    this.name = "FirstBootFirewallError";
  }
}
function changed(): never { throw new FirstBootFirewallError("resource_changed"); }
function scope(value: unknown) {
  const parsed = ScopeSchema.safeParse(value);
  if (!parsed.success) throw new FirstBootFirewallError("invalid_scope");
  return parsed.data;
}

/** Fixed first-boot policy, not arbitrary networking input. Port 22 remains
 * public for generated-key-only, non-root SSH. Ports 80/443 admit the VM-owned
 * standalone HTTPS endpoint; before launch nothing listens there. No
 * outbound rules means outbound traffic is allowed, not egress containment.
 * A caller still needs explicit preparation consent and a live durable lease.
 */
export function firstBootFirewallRequest(input: FirstBootFirewallScope) {
  const s = scope(input);
  return {
    name: "hivra-fw-" + s.orderId.replaceAll("-", "").slice(0, 20)
      + "-" + s.attemptId.replaceAll("-", "").slice(0, 8),
    labels: { "hivra-operation": s.orderId, "hivra-attempt": s.attemptId,
      "hivra-quote": s.quoteFingerprint.slice(0, 32), "hivra-managed": "true" },
    rules: (["22", "80", "443"] as const).map(port => ({ direction: "in" as const, protocol: "tcp" as const,
      port, source_ips: ["0.0.0.0/0", "::/0"] })),
    apply_to: [{ type: "server", server: { id: s.serverId } }],
  };
}

function firewall(raw: unknown, current: FirstBootFirewallScope, allowLegacySshOnly = false): FirstBootFirewall {
  const parsed = FirewallSchema.safeParse(raw);
  if (!parsed.success) return changed();
  const f = parsed.data;
  const expected = firstBootFirewallRequest(current);
  const entries = (labels: Record<string, string>) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  const ruleKey = (rule: { port: string; source_ips: string[] }) => `${rule.port}:${[...rule.source_ips].sort().join(",")}`;
  const rules = f.rules.map(ruleKey).sort().join("|");
  const expectedRules = expected.rules.map(ruleKey).sort().join("|");
  const legacyRules = expected.rules.filter(rule => rule.port === "22").map(ruleKey).join("|");
  if (f.name !== expected.name || entries(f.labels) !== entries(expected.labels)
    || (rules !== expectedRules && !(allowLegacySshOnly && rules === legacyRules))
    || f.applied_to.some(attachment => attachment.server.id !== current.serverId)) changed();
  return f;
}
function exactAction(raw: unknown, command: string, resources: Array<{ id: number; type: string }>) {
  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) return changed();
  const action = parsed.data;
  const key = (value: { id: number; type: string }) => value.type + ":" + value.id;
  if (action.command !== command || action.resources.length !== resources.length
    || action.resources.map(key).sort().join(",") !== resources.map(key).sort().join(",")) changed();
  return action;
}

/** Only call on the original successful POST response. Lookup by name is not
 * a creation receipt, and a lost/malformed response must not trigger a new POST.
 * Error/running action states may be retained here; this is never boot proof.
 */
export function firstBootFirewallReceipt(input: FirstBootFirewallScope, raw: unknown): FirstBootFirewallReceipt {
  const current = scope(input);
  const response = z.object({ firewall: z.unknown(), actions: z.array(ActionSchema).length(2) }).safeParse(raw);
  if (!response.success) throw new FirstBootFirewallError("invalid_receipt");
  const f = firewall(response.data.firewall, current);
  const rules = exactAction(response.data.actions.find(action => action.command === "set_firewall_rules"),
    "set_firewall_rules", [{ id: f.id, type: "firewall" }]);
  const apply = exactAction(response.data.actions.find(action => action.command === "apply_firewall"),
    "apply_firewall", [{ id: f.id, type: "firewall" }, { id: current.serverId, type: "server" }]);
  if (rules.id === apply.id) throw new FirstBootFirewallError("invalid_receipt");
  return { version: 1, scope: current, firewallId: f.id, createdAt: f.created,
    setRulesActionId: rules.id, applyActionId: apply.id };
}

export function parseFirstBootFirewallReceipt(raw: unknown, input: FirstBootFirewallScope): FirstBootFirewallReceipt {
  const current = scope(input);
  const parsed = ReceiptSchema.safeParse(raw);
  if (!parsed.success || JSON.stringify(parsed.data.scope) !== JSON.stringify(current)) {
    throw new FirstBootFirewallError("invalid_receipt");
  }
  return parsed.data;
}

function sameFirewall(receipt: FirstBootFirewallReceipt, raw: unknown, allowLegacySshOnly = true) {
  // Existing named-tunnel computers retain their exact SSH-only policy for
  // lifecycle and deletion. Direct HTTPS must explicitly require the new set.
  const f = firewall(raw, receipt.scope, allowLegacySshOnly);
  if (f.id !== receipt.firewallId || Date.parse(f.created) !== Date.parse(receipt.createdAt)) changed();
  return f;
}

/** Network evidence only, not owner authority, an SSH identity or readiness.
 * The coordinator must also verify the full original server/IP/configuration,
 * provider freshness, enrollment expiry and its shared mutation lease directly
 * before dispatch. Other project administrators can race any GET/POST pair.
 */
export function assessFirstBootFirewall(input: {
  scope: FirstBootFirewallScope; receipt: unknown; firewall: unknown;
  setRulesAction: unknown; applyAction: unknown; server: unknown;
  requireHttps?: boolean;
}): "pending" | "firewall_verified" {
  return assessFirewall(input,"off");
}

/** Same original firewall/attachment evidence, but for a running enrolled
 * guest. This never authorizes first boot or fabricates an off observation.
 */
export function assessEnrolledGuestFirewall(input: Parameters<typeof assessFirstBootFirewall>[0]) {
  return assessFirewall(input,"running");
}

function assessFirewall(input: Parameters<typeof assessFirstBootFirewall>[0],powerState:"off"|"running"):"pending"|"firewall_verified" {
  const receipt = parseFirstBootFirewallReceipt(input.receipt, input.scope);
  const f = sameFirewall(receipt, input.firewall, input.requireHttps !== true);
  const rules = exactAction(input.setRulesAction, "set_firewall_rules", [{ id: f.id, type: "firewall" }]);
  const apply = exactAction(input.applyAction, "apply_firewall", [
    { id: f.id, type: "firewall" }, { id: receipt.scope.serverId, type: "server" },
  ]);
  if (rules.id !== receipt.setRulesActionId || apply.id !== receipt.applyActionId) changed();
  const parsed = z.object({
    id: ID, status: z.literal(powerState), locked: z.boolean(),
    public_net: z.object({ firewalls: z.array(z.object({
      id: ID, status: z.enum(["applied", "pending"]),
    }).strict()).max(1) }),
  }).safeParse(input.server);
  if (!parsed.success) return changed();
  const server = parsed.data;
  if (server.id !== receipt.scope.serverId
    || server.public_net.firewalls.some(attachment => attachment.id !== f.id)) changed();
  // Hard failures dominate transient observations, never an opaque retry.
  if (rules.status === "error" || apply.status === "error") throw new FirstBootFirewallError("action_failed");
  return rules.status === "success" && apply.status === "success" && !server.locked
    && f.applied_to.length === 1 && server.public_net.firewalls.length === 1
    && server.public_net.firewalls[0].status === "applied"
    ? "firewall_verified" : "pending";
}

/** A cleanup coordinator must separately prove server absence and own the
 * original receipt/lease. Never detach another server or remove a selector.
 */
export function assertFirstBootFirewallUnattached(input: {
  scope: FirstBootFirewallScope; receipt: unknown; firewall: unknown;
}): void {
  const receipt = parseFirstBootFirewallReceipt(input.receipt, input.scope);
  if (sameFirewall(receipt, input.firewall).applied_to.length !== 0) {
    throw new FirstBootFirewallError("still_attached");
  }
}

/** Validate the entire firewall attachment boundary during cleanup. An absent
 * firewall is allowed only when the server agrees that it is no longer attached.
 * Nothing here detaches servers or grants provider mutation authority.
 */
export function assertFirstBootFirewallCleanup(input: {
  scope: FirstBootFirewallScope; receipt: unknown; firewall: unknown | null; server: unknown | null;
}): void {
  const receipt = parseFirstBootFirewallReceipt(input.receipt, input.scope);
  const f = input.firewall === null ? null : sameFirewall(receipt, input.firewall);
  if (input.server === null) {
    if (f && f.applied_to.length !== 0) throw new FirstBootFirewallError("still_attached");
    return;
  }
  const parsed = z.object({ id: ID, public_net: z.object({
    firewalls: z.array(z.object({ id: ID, status: z.enum(["applied", "pending"]) }).strict()).max(1),
  }) }).safeParse(input.server);
  if (!parsed.success || parsed.data.id !== receipt.scope.serverId) return changed();
  const attachments = parsed.data.public_net.firewalls;
  if (attachments.some(item => item.id !== receipt.firewallId) || (!f && attachments.length !== 0)) changed();
  // A receipted creation can fail before attachment. Both sides agreeing it is
  // unattached is safe for exact-resource cleanup; never detach to repair it.
  const bothUnattached = f?.applied_to.length === 0 && attachments.length === 0;
  if (f && !bothUnattached && (f.applied_to.length !== 1 || attachments.length !== 1 || attachments[0].status !== "applied")) {
    throw new FirstBootFirewallError("still_attached");
  }
}

export function firstBootPowerOnAction(serverId: number, raw: unknown) {
  if (!ID.safeParse(serverId).success) throw new FirstBootFirewallError("invalid_scope");
  return exactAction(raw, "start_server", [{ id: serverId, type: "server" }]);
}
