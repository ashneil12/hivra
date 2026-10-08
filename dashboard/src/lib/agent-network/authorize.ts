import { parseAuthzContext, type AuthzContext } from "./authz-context";
import { evaluate } from "./policy-evaluator";
import { isAgentNetworkEnabled } from "./flag";
import type { Decision, DecisionReason, NetworkAction, NetworkResource } from "./types";
import { NETWORK_ACTIONS } from "./types";

// One authorization decision for a request that reaches an enforcement point.
//
//   deployment flag -> request shape -> live context (one read) -> revision check
//   -> evaluate()
//
// Every step that cannot be completed denies. Revocation is immediate because the
// context is read live on every call: suspending an agent, removing its owner or
// letting it leave changes the next answer, whatever token it holds.

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface AuthzStore {
  /** Reads hivra_net_authz_context. May throw; a throw denies. */
  getContext(input: {
    orgId: string;
    principalId: string;
    peerPrincipalId?: string;
    revision?: number;
  }): Promise<unknown>;
}

export interface AuthorizeRequest {
  orgId: string;
  principalId: string;
  action: NetworkAction;
  /** brain.read and brain.write: 'org', 'team/<group id>' or 'agent/<principal id>'. */
  source?: string;
  /** a2a.send: the receiving principal. */
  peerPrincipalId?: string;
  /**
   * The policy revision the caller is working from (a gateway or broker cache).
   * Omitted: the newest. A revision newer than the newest is unknown and denies; one
   * older by more than maxRevisionLag is stale and denies.
   */
  revision?: number;
  /** How many revisions behind the newest a cached revision may be. Default 0. */
  maxRevisionLag?: number;
}

function deny(reason: DecisionReason, rule: string, base: Partial<Decision> = {}): Decision {
  return { allow: false, reason, rule, revision: null, orgId: null, ...base };
}

function malformed(request: AuthorizeRequest): boolean {
  if (!request || typeof request !== "object") return true;
  if (typeof request.orgId !== "string" || !UUID_PATTERN.test(request.orgId)) return true;
  if (typeof request.principalId !== "string" || !UUID_PATTERN.test(request.principalId)) return true;
  if (!(NETWORK_ACTIONS as readonly string[]).includes(request.action)) return true;
  if (request.revision !== undefined && (!Number.isInteger(request.revision) || request.revision < 1)) return true;
  if (
    request.maxRevisionLag !== undefined &&
    (!Number.isInteger(request.maxRevisionLag) || request.maxRevisionLag < 0)
  ) {
    return true;
  }
  if (request.action === "a2a.send") {
    return typeof request.peerPrincipalId !== "string" || !UUID_PATTERN.test(request.peerPrincipalId);
  }
  return typeof request.source !== "string";
}

export async function authorizeNetworkRequest(
  store: AuthzStore,
  request: AuthorizeRequest,
  env: Record<string, string | undefined> = process.env
): Promise<Decision> {
  if (!isAgentNetworkEnabled(env)) {
    return deny("network_disabled_on_deployment", "deployment-flag");
  }
  if (malformed(request)) {
    return deny("malformed_request", "request-shape");
  }

  let context: AuthzContext | null;
  try {
    context = parseAuthzContext(
      await store.getContext({
        orgId: request.orgId,
        principalId: request.principalId,
        peerPrincipalId: request.action === "a2a.send" ? request.peerPrincipalId : undefined,
        revision: request.revision,
      })
    );
  } catch {
    return deny("policy_unavailable", "store-error");
  }
  if (!context) {
    return deny("policy_unavailable", "context-shape");
  }
  if (!context.orgFound || context.currentRevision === null) {
    return deny("no_policy", "default-deny");
  }

  const newest = context.currentRevision;
  if (request.revision !== undefined) {
    if (request.revision > newest) {
      return deny("unknown_revision", "revision-skew", { orgId: request.orgId });
    }
    if (newest - request.revision > (request.maxRevisionLag ?? 0)) {
      return deny("stale_revision", "revision-skew", { orgId: request.orgId, revision: request.revision });
    }
  }
  const used = request.revision ?? newest;
  if (!context.policy || context.policy.revision !== used || context.policy.orgId.toLowerCase() !== request.orgId.toLowerCase()) {
    return deny("unknown_revision", "revision-skew", { orgId: request.orgId });
  }

  const resource: NetworkResource =
    request.action === "a2a.send"
      ? { kind: "principal", peer: context.peer }
      : { kind: "brain_source", source: request.source as string };
  return evaluate(context.policy, context.subject, request.action, resource);
}
