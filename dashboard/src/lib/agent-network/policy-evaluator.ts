import type {
  BrainMode,
  Decision,
  DecisionReason,
  EdgeLimits,
  EdgeMode,
  NetworkAction,
  NetworkResource,
  PolicyEdge,
  PolicyGrant,
  PolicySnapshot,
  PrincipalFacts,
} from "./types";

// The one place a policy question is answered. The gateway, the broker and the
// console all call evaluate(); none of them re-implements a rule.
//
// Properties, each covered by policy-evaluator.test.ts:
//   * Default deny. Nothing is allowed unless a rule says so.
//   * A missing, malformed or unknown-revision policy denies.
//   * Attenuation only. A 'narrow' row (set by an agent's owner) can lower what a
//     'ceiling' row (set by an organization admin) allows and can never raise it
//     or create access where there is no ceiling.
//   * Deny overrides. An explicit 'none' ceiling row beats any allowing row.
//   * No authority travels in a request. The evaluator reads the principal's live
//     state; a token, a message or a recalled memory is never an input.
//   * Pure and synchronous: no clock, no network, no database.

const MODE_RANK: Record<BrainMode, number> = { none: 0, read: 1, write: 2 };
const EDGE_RANK: Record<EdgeMode, number> = { deny: 0, approve: 1, auto: 2 };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE_PATTERN = new RegExp(`^(org|team/${UUID}|agent/${UUID})$`);

function decision(
  policy: PolicySnapshot | null | undefined,
  allow: boolean,
  reason: DecisionReason,
  rule: string,
  extra: Partial<Decision> = {}
): Decision {
  const revision = policy && Number.isInteger(policy.revision) ? policy.revision : null;
  const orgId = policy && typeof policy.orgId === "string" ? policy.orgId : null;
  return { allow, reason, rule, revision, orgId, ...extra };
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isUsablePolicy(policy: PolicySnapshot | null | undefined): policy is PolicySnapshot {
  return Boolean(
    policy &&
      typeof policy.orgId === "string" &&
      policy.orgId.length > 0 &&
      Array.isArray(policy.grants) &&
      Array.isArray(policy.edges) &&
      Array.isArray(policy.groupMembers) &&
      Array.isArray(policy.groups) &&
      policy.settings &&
      typeof policy.settings === "object" &&
      typeof policy.settings.networkEnabled === "boolean" &&
      typeof policy.settings.paused === "boolean"
  );
}

/** Mode of a grant row, guarded so a corrupt row can only lower access. */
function grantRank(grant: PolicyGrant): number {
  return MODE_RANK[grant.mode] ?? 0;
}

function edgeRank(edge: PolicyEdge): number {
  return EDGE_RANK[edge.mode] ?? 0;
}

function minLimit(values: Array<number | null | undefined>): number | null {
  let result: number | null = null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    result = result === null ? value : Math.min(result, value);
  }
  return result;
}

function evaluateBrain(
  policy: PolicySnapshot,
  principal: PrincipalFacts,
  action: "brain.read" | "brain.write",
  resource: Extract<NetworkResource, { kind: "brain_source" }>
): Decision {
  const source = typeof resource.source === "string" ? resource.source.toLowerCase() : "";
  if (!SOURCE_PATTERN.test(source)) {
    return decision(policy, false, "malformed_resource", "source-grammar");
  }
  const needed = action === "brain.write" ? MODE_RANK.write : MODE_RANK.read;

  // A private source is its agent's own. No rule reaches another agent's.
  const isPrivate = source.startsWith("agent/");
  if (isPrivate && !sameId(source.slice("agent/".length), principal.principalId)) {
    return decision(policy, false, "private_source_foreign", "private-source");
  }

  const groups = new Set(
    policy.groupMembers.filter((m) => sameId(m.principalId, principal.principalId)).map((m) => m.groupId.toLowerCase())
  );
  const applies = (grant: PolicyGrant) =>
    grant.source.toLowerCase() === source &&
    ((grant.principalId !== null && sameId(grant.principalId, principal.principalId)) ||
      (grant.groupId !== null && groups.has(grant.groupId.toLowerCase())));
  const ceilingRows = policy.grants.filter((g) => g.layer === "ceiling" && applies(g));

  const denyRow = ceilingRows.find((g) => grantRank(g) === MODE_RANK.none);
  if (denyRow) {
    return decision(policy, false, "explicit_deny", `grant:${denyRow.id}`);
  }

  let ceiling: number;
  let ceilingRule: string;
  let allowReason: DecisionReason = "granted";
  if (isPrivate) {
    // The agent's own private source: write by default, restrictable by its own
    // principal row. Group rows never apply to a private source.
    const own = ceilingRows.find((g) => g.principalId !== null);
    if (own) {
      ceiling = grantRank(own);
      ceilingRule = `grant:${own.id}`;
    } else {
      ceiling = MODE_RANK.write;
      ceilingRule = "own-source";
      allowReason = "granted_own_source";
    }
  } else {
    if (ceilingRows.length === 0) {
      return decision(policy, false, "no_grant", "default-deny");
    }
    const top = ceilingRows.reduce((best, g) => (grantRank(g) > grantRank(best) ? g : best));
    ceiling = grantRank(top);
    ceilingRule = `grant:${top.id}`;
  }

  const narrowRows = policy.grants.filter(
    (g) => g.layer === "narrow" && g.principalId !== null && sameId(g.principalId, principal.principalId) && g.source.toLowerCase() === source
  );
  let effective = ceiling;
  let narrowedBy: PolicyGrant | null = null;
  for (const row of narrowRows) {
    if (grantRank(row) < effective) {
      effective = grantRank(row);
      narrowedBy = row;
    }
  }

  if (effective >= needed) {
    return decision(policy, true, allowReason, ceilingRule);
  }
  if (narrowedBy) {
    return decision(policy, false, "narrowed", `grant:${narrowedBy.id}`);
  }
  return decision(policy, false, "grant_insufficient", ceilingRule);
}

function evaluateSend(
  policy: PolicySnapshot,
  principal: PrincipalFacts,
  resource: Extract<NetworkResource, { kind: "principal" }>
): Decision {
  const peer = resource.peer;
  if (!peer) return decision(policy, false, "unknown_peer", "peer-lookup");
  if (typeof peer.orgId !== "string" || !sameId(peer.orgId, policy.orgId)) {
    return decision(policy, false, "cross_org", "tenant");
  }
  if (sameId(peer.principalId, principal.principalId)) {
    return decision(policy, false, "self_edge", "no-self-edge");
  }
  if (peer.state !== "joined") return decision(policy, false, "peer_not_joined", "peer-state");
  if (peer.memberActive !== true) return decision(policy, false, "peer_member_removed", "peer-member");

  const between = (edge: PolicyEdge) =>
    sameId(edge.fromPrincipalId, principal.principalId) && sameId(edge.toPrincipalId, peer.principalId);
  const ceilingEdges = policy.edges.filter((e) => e.layer === "ceiling" && between(e));
  if (ceilingEdges.length === 0) {
    return decision(policy, false, "no_edge", "default-deny");
  }
  // At most one active ceiling row exists per direction; if corrupt data holds
  // more, the most restrictive wins.
  const rows = [...ceilingEdges, ...policy.edges.filter((e) => e.layer === "narrow" && between(e))];
  const lowest = rows.reduce((best, e) => (edgeRank(e) < edgeRank(best) ? e : best));
  const limits: EdgeLimits = {
    maxMessagesPerHour: minLimit(rows.map((e) => e.maxMessagesPerHour)),
    maxConcurrentRuns: minLimit(rows.map((e) => e.maxConcurrentRuns)),
    maxHopDepth: policy.settings.maxHopDepth,
  };

  if (edgeRank(lowest) === EDGE_RANK.deny) {
    return decision(policy, false, "edge_denied", `edge:${lowest.id}`);
  }
  if (edgeRank(lowest) === EDGE_RANK.approve) {
    return decision(policy, false, "approval_required", `edge:${lowest.id}`, { requiresApproval: true, limits });
  }
  return decision(policy, true, "edge_allowed", `edge:${lowest.id}`, { limits });
}

/**
 * Answers one policy question.
 *
 * @param policy     The policy at the revision the caller is using. null or
 *                   undefined (no policy, unknown revision) denies.
 * @param principal  The requesting principal's live facts.
 * @param action     What it wants to do.
 * @param resource   What it wants to do it to.
 */
export function evaluate(
  policy: PolicySnapshot | null | undefined,
  principal: PrincipalFacts | null | undefined,
  action: NetworkAction,
  resource: NetworkResource
): Decision {
  if (policy === null || policy === undefined) {
    return decision(null, false, "no_policy", "default-deny");
  }
  if (!isUsablePolicy(policy)) {
    return decision(null, false, "malformed_policy", "default-deny");
  }
  if (!Number.isInteger(policy.revision) || policy.revision < 1) {
    return decision(policy, false, "unknown_revision", "default-deny");
  }
  if (!principal) {
    return decision(policy, false, "unknown_principal", "principal-lookup");
  }
  if (typeof principal.orgId !== "string" || !sameId(principal.orgId, policy.orgId)) {
    return decision(policy, false, "org_mismatch", "tenant");
  }
  if (policy.settings.networkEnabled !== true) {
    return decision(policy, false, "network_disabled", "org-settings");
  }
  if (policy.settings.paused !== false) {
    return decision(policy, false, "org_paused", "org-settings");
  }
  if (principal.state !== "joined") {
    return decision(policy, false, "principal_not_joined", "principal-state");
  }
  if (principal.memberActive !== true) {
    return decision(policy, false, "member_removed", "principal-member");
  }

  if (action === "brain.read" || action === "brain.write") {
    if (!resource || resource.kind !== "brain_source") {
      return decision(policy, false, "malformed_resource", "resource-kind");
    }
    return evaluateBrain(policy, principal, action, resource);
  }
  if (action === "a2a.send") {
    if (!resource || resource.kind !== "principal") {
      return decision(policy, false, "malformed_resource", "resource-kind");
    }
    return evaluateSend(policy, principal, resource);
  }
  return decision(policy, false, "unknown_action", "default-deny");
}
