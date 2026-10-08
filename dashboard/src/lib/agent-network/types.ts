// Agent network (package B1): identity, tenancy and policy types.
//
// Target design: docs/superpowers/specs/2026-10-07-shared-brain-and-agent-network.md
// (sections 6.1 and 6.2). These types describe the contract between the policy
// tables and every enforcement point (gateway, broker, console). They contain no
// behaviour; the evaluator is in policy-evaluator.ts.

export const PRINCIPAL_STATES = ["pending", "joined", "suspended", "left"] as const;
export type PrincipalState = (typeof PRINCIPAL_STATES)[number];

export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Actions an enforcement point asks the evaluator about. */
export const NETWORK_ACTIONS = ["brain.read", "brain.write", "a2a.send"] as const;
export type NetworkAction = (typeof NETWORK_ACTIONS)[number];

export const BRAIN_MODES = ["none", "read", "write"] as const;
export type BrainMode = (typeof BRAIN_MODES)[number];

export const EDGE_MODES = ["deny", "approve", "auto"] as const;
export type EdgeMode = (typeof EDGE_MODES)[number];

export const POLICY_LAYERS = ["ceiling", "narrow"] as const;
export type PolicyLayer = (typeof POLICY_LAYERS)[number];

/**
 * Lifetime of a short-lived access token for one audience (B1 decision, from the
 * proposal in the design). Nothing issues these tokens yet; the gateway and the
 * broker do. Revocation never waits for expiry: every request reads live state.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const ACCESS_TOKEN_AUDIENCES = ["brain-gateway", "a2a-broker"] as const;
export type AccessTokenAudience = (typeof ACCESS_TOKEN_AUDIENCES)[number];

export interface PolicySettings {
  networkEnabled: boolean;
  paused: boolean;
  buzzBindingDefault: "allowed" | "forbidden";
  maxHopDepth: number;
}

export interface PolicyGroup {
  id: string;
  name: string;
}

export interface PolicyGroupMember {
  groupId: string;
  principalId: string;
}

export interface PolicyGrant {
  id: string;
  layer: PolicyLayer;
  principalId: string | null;
  groupId: string | null;
  /** 'org', 'team/<group id>' or 'agent/<principal id>'. */
  source: string;
  mode: BrainMode;
}

export interface PolicyEdge {
  id: string;
  layer: PolicyLayer;
  fromPrincipalId: string;
  toPrincipalId: string;
  mode: EdgeMode;
  maxMessagesPerHour: number | null;
  maxConcurrentRuns: number | null;
}

/** The policy of one organization as it stood at one revision. Immutable. */
export interface PolicySnapshot {
  orgId: string;
  revision: number;
  settings: PolicySettings;
  groups: PolicyGroup[];
  groupMembers: PolicyGroupMember[];
  grants: PolicyGrant[];
  edges: PolicyEdge[];
}

/** Live facts about one principal, read at request time, never cached with a token. */
export interface PrincipalFacts {
  principalId: string;
  orgId: string;
  state: PrincipalState;
  ownerUserId: string;
  agentIdentityId: string;
  /** False once the organization has removed the member who owns the agent. */
  memberActive: boolean;
}

export type NetworkResource =
  | { kind: "brain_source"; source: string }
  | { kind: "principal"; peer: PrincipalFacts | null };

export type DecisionReason =
  | "granted"
  | "granted_own_source"
  | "edge_allowed"
  | "approval_required"
  | "no_policy"
  | "malformed_policy"
  | "unknown_revision"
  | "stale_revision"
  | "unknown_principal"
  | "org_mismatch"
  | "cross_org"
  | "network_disabled"
  | "network_disabled_on_deployment"
  | "org_paused"
  | "principal_not_joined"
  | "member_removed"
  | "peer_not_joined"
  | "peer_member_removed"
  | "unknown_peer"
  | "self_edge"
  | "no_grant"
  | "explicit_deny"
  | "narrowed"
  | "grant_insufficient"
  | "private_source_foreign"
  | "no_edge"
  | "edge_denied"
  | "malformed_resource"
  | "malformed_request"
  | "unknown_action"
  | "policy_unavailable";

export interface EdgeLimits {
  maxMessagesPerHour: number | null;
  maxConcurrentRuns: number | null;
  maxHopDepth: number;
}

export interface Decision {
  allow: boolean;
  reason: DecisionReason;
  /** The rule that decided: 'grant:<id>', 'edge:<id>', 'own-source', or a named default. */
  rule: string;
  /** The policy revision the decision used; null when there was none. */
  revision: number | null;
  orgId: string | null;
  /**
   * True when the edge allows the message only after a human approves it. allow is
   * false in that case, so a caller that ignores this field fails closed.
   */
  requiresApproval?: boolean;
  limits?: EdgeLimits;
}
