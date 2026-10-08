import type { Decision, PolicyEdge, PolicyGrant, PolicySnapshot, PrincipalFacts } from "../types";

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const ORG = uuid(1);
export const OTHER_ORG = uuid(2);
export const ALICE = uuid(10);
export const BOB = uuid(11);
export const CARA = uuid(12);
export const TEAM = uuid(20);

export function principal(id: string, overrides: Partial<PrincipalFacts> = {}): PrincipalFacts {
  return {
    principalId: id,
    orgId: ORG,
    state: "joined",
    ownerUserId: `owner-of-${id.slice(-2)}`,
    agentIdentityId: uuid(900 + Number(id.slice(-2))),
    memberActive: true,
    ...overrides,
  };
}

let sequence = 100;
export function grant(overrides: Partial<PolicyGrant> & Pick<PolicyGrant, "source" | "mode">): PolicyGrant {
  return { id: uuid(++sequence), layer: "ceiling", principalId: ALICE, groupId: null, ...overrides };
}

export function edge(overrides: Partial<PolicyEdge> = {}): PolicyEdge {
  return {
    id: uuid(++sequence),
    layer: "ceiling",
    fromPrincipalId: ALICE,
    toPrincipalId: BOB,
    mode: "auto",
    maxMessagesPerHour: null,
    maxConcurrentRuns: null,
    ...overrides,
  };
}

export function policy(overrides: Partial<PolicySnapshot> = {}, settings: Partial<PolicySnapshot["settings"]> = {}): PolicySnapshot {
  return {
    orgId: ORG,
    revision: 7,
    settings: { networkEnabled: true, paused: false, buzzBindingDefault: "forbidden", maxHopDepth: 3, ...settings },
    groups: [],
    groupMembers: [],
    grants: [],
    edges: [],
    ...overrides,
  };
}

export function pick(decision: Decision) {
  return { allow: decision.allow, reason: decision.reason };
}
