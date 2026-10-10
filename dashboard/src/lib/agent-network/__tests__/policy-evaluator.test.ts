import { evaluate } from "../policy-evaluator";
import type { NetworkAction, NetworkResource, PolicySnapshot, PrincipalFacts } from "../types";
import { ALICE, BOB, CARA, ORG, OTHER_ORG, TEAM, edge, grant, pick, policy, principal, uuid } from "./fixtures";

// AC-B1-1: run the evaluator over a table of principals, actions and revisions,
// including no policy and an unknown revision. Every row matches its expected
// decision; a missing policy and an unknown revision deny.

const brain = (source: string): NetworkResource => ({ kind: "brain_source", source });
const to = (peer: PrincipalFacts | null): NetworkResource => ({ kind: "principal", peer });

interface Row {
  name: string;
  policy: PolicySnapshot | null | undefined;
  principal: PrincipalFacts | null | undefined;
  action: NetworkAction;
  resource: NetworkResource;
  expect: { allow: boolean; reason: string };
}

const alice = principal(ALICE);
const bob = principal(BOB);

const ownPrivate = `agent/${ALICE}`;
const bobPrivate = `agent/${BOB}`;
const teamSource = `team/${TEAM}`;

const rows: Row[] = [
  // ---- no policy / unusable policy / unknown revision: deny ----------------
  { name: "no policy (null)", policy: null, principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "no_policy" } },
  { name: "no policy (undefined)", policy: undefined, principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "no_policy" } },
  { name: "malformed policy: missing settings", policy: { ...policy(), settings: undefined } as unknown as PolicySnapshot, principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "malformed_policy" } },
  { name: "malformed policy: grants not a list", policy: { ...policy(), grants: {} } as unknown as PolicySnapshot, principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "malformed_policy" } },
  { name: "malformed policy: network flag not a boolean", policy: policy({}, { networkEnabled: "yes" as unknown as boolean }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "malformed_policy" } },
  { name: "unknown revision: zero", policy: policy({ revision: 0, grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "unknown_revision" } },
  { name: "unknown revision: negative", policy: policy({ revision: -3, grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "unknown_revision" } },
  { name: "unknown revision: not an integer", policy: policy({ revision: 1.5, grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "unknown_revision" } },
  { name: "unknown revision: NaN", policy: policy({ revision: Number.NaN, grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "unknown_revision" } },

  // ---- principal, tenancy, organization state --------------------------------
  { name: "unknown principal", policy: policy(), principal: null, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "unknown_principal" } },
  { name: "principal from another org", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }), principal: principal(ALICE, { orgId: OTHER_ORG }), action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "org_mismatch" } },
  { name: "network off", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }, { networkEnabled: false }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "network_disabled" } },
  { name: "org paused", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }, { paused: true }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "org_paused" } },
  ...(["pending", "suspended", "left"] as const).map((state) => ({
    name: `principal ${state}`,
    policy: policy({ grants: [grant({ source: "org", mode: "write" })] }),
    principal: principal(ALICE, { state }),
    action: "brain.read" as const,
    resource: brain("org"),
    expect: { allow: false, reason: "principal_not_joined" },
  })),
  { name: "owner removed from org", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }), principal: principal(ALICE, { memberActive: false }), action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "member_removed" } },

  // ---- brain: default deny, grants, modes -----------------------------------
  { name: "joined agent, empty policy", policy: policy(), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "no_grant" } },
  { name: "read grant allows read", policy: policy({ grants: [grant({ source: "org", mode: "read" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: true, reason: "granted" } },
  { name: "read grant refuses write", policy: policy({ grants: [grant({ source: "org", mode: "read" })] }), principal: alice, action: "brain.write", resource: brain("org"), expect: { allow: false, reason: "grant_insufficient" } },
  { name: "write grant allows write", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.write", resource: brain("org"), expect: { allow: true, reason: "granted" } },
  { name: "write grant allows read", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: true, reason: "granted" } },
  { name: "grant for another source", policy: policy({ grants: [grant({ source: teamSource, mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "no_grant" } },
  { name: "grant for another principal", policy: policy({ grants: [grant({ principalId: BOB, source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "no_grant" } },
  { name: "source spelled in upper case", policy: policy({ grants: [grant({ source: "org", mode: "read" })] }), principal: alice, action: "brain.read", resource: brain("ORG"), expect: { allow: true, reason: "granted" } },
  { name: "unknown source grammar", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org/../secrets"), expect: { allow: false, reason: "malformed_resource" } },
  { name: "empty source", policy: policy(), principal: alice, action: "brain.read", resource: brain(""), expect: { allow: false, reason: "malformed_resource" } },
  { name: "wrong resource kind for a brain action", policy: policy(), principal: alice, action: "brain.read", resource: to(bob), expect: { allow: false, reason: "malformed_resource" } },
  { name: "unknown action", policy: policy({ grants: [grant({ source: "org", mode: "write" })] }), principal: alice, action: "brain.delete" as NetworkAction, resource: brain("org"), expect: { allow: false, reason: "unknown_action" } },
  { name: "corrupt grant mode can only deny", policy: policy({ grants: [grant({ source: "org", mode: "admin" as never })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "explicit_deny" } },

  // ---- brain: groups ---------------------------------------------------------
  { name: "group grant reaches a member", policy: policy({ groups: [{ id: TEAM, name: "t" }], groupMembers: [{ groupId: TEAM, principalId: ALICE }], grants: [grant({ principalId: null, groupId: TEAM, source: teamSource, mode: "write" })] }), principal: alice, action: "brain.write", resource: brain(teamSource), expect: { allow: true, reason: "granted" } },
  { name: "group grant does not reach a non-member", policy: policy({ groups: [{ id: TEAM, name: "t" }], groupMembers: [{ groupId: TEAM, principalId: BOB }], grants: [grant({ principalId: null, groupId: TEAM, source: teamSource, mode: "write" })] }), principal: alice, action: "brain.write", resource: brain(teamSource), expect: { allow: false, reason: "no_grant" } },
  { name: "membership alone grants nothing", policy: policy({ groups: [{ id: TEAM, name: "t" }], groupMembers: [{ groupId: TEAM, principalId: ALICE }] }), principal: alice, action: "brain.read", resource: brain(teamSource), expect: { allow: false, reason: "no_grant" } },
  { name: "highest of principal and group grants wins", policy: policy({ groups: [{ id: TEAM, name: "t" }], groupMembers: [{ groupId: TEAM, principalId: ALICE }], grants: [grant({ source: "org", mode: "read" }), grant({ principalId: null, groupId: TEAM, source: "org", mode: "write" })] }), principal: alice, action: "brain.write", resource: brain("org"), expect: { allow: true, reason: "granted" } },
  { name: "explicit none beats an allowing group grant", policy: policy({ groups: [{ id: TEAM, name: "t" }], groupMembers: [{ groupId: TEAM, principalId: ALICE }], grants: [grant({ source: "org", mode: "none" }), grant({ principalId: null, groupId: TEAM, source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "explicit_deny" } },
  { name: "explicit none on the group beats an allowing principal grant", policy: policy({ groups: [{ id: TEAM, name: "t" }], groupMembers: [{ groupId: TEAM, principalId: ALICE }], grants: [grant({ source: "org", mode: "write" }), grant({ principalId: null, groupId: TEAM, source: "org", mode: "none" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "explicit_deny" } },

  // ---- brain: attenuation ----------------------------------------------------
  { name: "narrow row lowers write to read", policy: policy({ grants: [grant({ source: "org", mode: "write" }), grant({ layer: "narrow", source: "org", mode: "read" })] }), principal: alice, action: "brain.write", resource: brain("org"), expect: { allow: false, reason: "narrowed" } },
  { name: "narrow row leaves read intact", policy: policy({ grants: [grant({ source: "org", mode: "write" }), grant({ layer: "narrow", source: "org", mode: "read" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: true, reason: "granted" } },
  { name: "narrow row to none removes access", policy: policy({ grants: [grant({ source: "org", mode: "write" }), grant({ layer: "narrow", source: "org", mode: "none" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "narrowed" } },
  { name: "narrow row cannot widen a read ceiling", policy: policy({ grants: [grant({ source: "org", mode: "read" }), grant({ layer: "narrow", source: "org", mode: "write" })] }), principal: alice, action: "brain.write", resource: brain("org"), expect: { allow: false, reason: "grant_insufficient" } },
  { name: "narrow row cannot create access without a ceiling", policy: policy({ grants: [grant({ layer: "narrow", source: "org", mode: "write" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "no_grant" } },
  { name: "narrow row for another principal is ignored", policy: policy({ grants: [grant({ source: "org", mode: "write" }), grant({ layer: "narrow", principalId: BOB, source: "org", mode: "none" })] }), principal: alice, action: "brain.write", resource: brain("org"), expect: { allow: true, reason: "granted" } },
  { name: "the most restrictive of several narrow rows applies", policy: policy({ grants: [grant({ source: "org", mode: "write" }), grant({ layer: "narrow", source: "org", mode: "read" }), grant({ layer: "narrow", source: "org", mode: "none" })] }), principal: alice, action: "brain.read", resource: brain("org"), expect: { allow: false, reason: "narrowed" } },

  // ---- brain: private sources ------------------------------------------------
  { name: "own private source: write by default", policy: policy(), principal: alice, action: "brain.write", resource: brain(ownPrivate), expect: { allow: true, reason: "granted_own_source" } },
  { name: "own private source: read by default", policy: policy(), principal: alice, action: "brain.read", resource: brain(ownPrivate), expect: { allow: true, reason: "granted_own_source" } },
  { name: "own private source: restricted by an admin row", policy: policy({ grants: [grant({ source: ownPrivate, mode: "read" })] }), principal: alice, action: "brain.write", resource: brain(ownPrivate), expect: { allow: false, reason: "grant_insufficient" } },
  { name: "own private source: closed by an admin row", policy: policy({ grants: [grant({ source: ownPrivate, mode: "none" })] }), principal: alice, action: "brain.read", resource: brain(ownPrivate), expect: { allow: false, reason: "explicit_deny" } },
  { name: "own private source: narrowed by its owner", policy: policy({ grants: [grant({ layer: "narrow", source: ownPrivate, mode: "read" })] }), principal: alice, action: "brain.write", resource: brain(ownPrivate), expect: { allow: false, reason: "narrowed" } },
  { name: "another agent's private source, even with a grant row", policy: policy({ grants: [grant({ source: bobPrivate, mode: "write" })] }), principal: alice, action: "brain.read", resource: brain(bobPrivate), expect: { allow: false, reason: "private_source_foreign" } },
  { name: "another agent's private source, no grant", policy: policy(), principal: alice, action: "brain.read", resource: brain(bobPrivate), expect: { allow: false, reason: "private_source_foreign" } },
  { name: "private source needs the network on", policy: policy({}, { networkEnabled: false }), principal: alice, action: "brain.read", resource: brain(ownPrivate), expect: { allow: false, reason: "network_disabled" } },
  { name: "private source needs a joined agent", policy: policy(), principal: principal(ALICE, { state: "suspended" }), action: "brain.read", resource: brain(ownPrivate), expect: { allow: false, reason: "principal_not_joined" } },

  // ---- a2a: default deny, edges, direction -----------------------------------
  { name: "send with no edge", policy: policy(), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "no_edge" } },
  { name: "send over an auto edge", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: true, reason: "edge_allowed" } },
  { name: "send in the wrong direction", policy: policy({ edges: [edge()] }), principal: bob, action: "a2a.send", resource: to(alice), expect: { allow: false, reason: "no_edge" } },
  { name: "send to a third agent", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: to(principal(CARA)), expect: { allow: false, reason: "no_edge" } },
  { name: "deny edge", policy: policy({ edges: [edge({ mode: "deny" })] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "edge_denied" } },
  { name: "approve edge holds the message (allow stays false)", policy: policy({ edges: [edge({ mode: "approve" })] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "approval_required" } },
  { name: "send to a suspended peer", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: to(principal(BOB, { state: "suspended" })), expect: { allow: false, reason: "peer_not_joined" } },
  { name: "send to a peer that left", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: to(principal(BOB, { state: "left" })), expect: { allow: false, reason: "peer_not_joined" } },
  { name: "send to a peer whose owner was removed", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: to(principal(BOB, { memberActive: false })), expect: { allow: false, reason: "peer_member_removed" } },
  { name: "send to a peer in another org", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: to(principal(BOB, { orgId: OTHER_ORG })), expect: { allow: false, reason: "cross_org" } },
  { name: "send with no peer found", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: to(null), expect: { allow: false, reason: "unknown_peer" } },
  { name: "send to oneself", policy: policy({ edges: [edge({ fromPrincipalId: ALICE, toPrincipalId: ALICE })] }), principal: alice, action: "a2a.send", resource: to(alice), expect: { allow: false, reason: "self_edge" } },
  { name: "wrong resource kind for a send", policy: policy({ edges: [edge()] }), principal: alice, action: "a2a.send", resource: brain("org"), expect: { allow: false, reason: "malformed_resource" } },
  { name: "send while the org is paused", policy: policy({ edges: [edge()] }, { paused: true }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "org_paused" } },
  { name: "send while the sender is suspended", policy: policy({ edges: [edge()] }), principal: principal(ALICE, { state: "suspended" }), action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "principal_not_joined" } },

  // ---- a2a: attenuation ------------------------------------------------------
  { name: "narrow edge to deny", policy: policy({ edges: [edge(), edge({ layer: "narrow", mode: "deny" })] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "edge_denied" } },
  { name: "narrow edge from auto to approve", policy: policy({ edges: [edge(), edge({ layer: "narrow", mode: "approve" })] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "approval_required" } },
  { name: "narrow edge cannot raise approve to auto", policy: policy({ edges: [edge({ mode: "approve" }), edge({ layer: "narrow", mode: "auto" })] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "approval_required" } },
  { name: "narrow edge cannot create an edge", policy: policy({ edges: [edge({ layer: "narrow", mode: "auto" })] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: false, reason: "no_edge" } },
  { name: "narrow edge in the other direction is ignored", policy: policy({ edges: [edge(), edge({ layer: "narrow", fromPrincipalId: BOB, toPrincipalId: ALICE, mode: "deny" })] }), principal: alice, action: "a2a.send", resource: to(bob), expect: { allow: true, reason: "edge_allowed" } },
];

describe("evaluate: decision table (AC-B1-1)", () => {
  it.each(rows)("$name", (row) => {
    expect(pick(evaluate(row.policy, row.principal, row.action, row.resource))).toEqual(row.expect);
  });

  it("denies in every row that has no policy, and never allows without a rule", () => {
    for (const row of rows) {
      const decision = evaluate(row.policy, row.principal, row.action, row.resource);
      if (row.policy === null || row.policy === undefined) expect(decision.allow).toBe(false);
      if (decision.allow) expect(decision.rule).toMatch(/^(grant:|edge:|own-source$)/);
    }
  });

  it("records the revision it used, and null when there was no policy", () => {
    expect(evaluate(policy({ grants: [grant({ source: "org", mode: "read" })] }), alice, "brain.read", brain("org")).revision).toBe(7);
    expect(evaluate(policy({ revision: 42 }), alice, "brain.read", brain("org"))).toMatchObject({ revision: 42, orgId: ORG });
    expect(evaluate(null, alice, "brain.read", brain("org"))).toMatchObject({ revision: null, orgId: null });
  });
});

describe("evaluate: edge details", () => {
  it("returns the tightest limits across the ceiling and narrowing rows, and the org's hop depth", () => {
    const decision = evaluate(
      policy(
        { edges: [edge({ maxMessagesPerHour: 60, maxConcurrentRuns: 4 }), edge({ layer: "narrow", maxMessagesPerHour: 10, maxConcurrentRuns: null })] },
        { maxHopDepth: 2 }
      ),
      alice,
      "a2a.send",
      to(bob)
    );
    expect(decision).toMatchObject({ allow: true, limits: { maxMessagesPerHour: 10, maxConcurrentRuns: 4, maxHopDepth: 2 } });
  });

  it("flags approval and keeps allow false, so a caller that ignores the flag still denies", () => {
    const decision = evaluate(policy({ edges: [edge({ mode: "approve", maxMessagesPerHour: 5 })] }), alice, "a2a.send", to(bob));
    expect(decision).toMatchObject({ allow: false, requiresApproval: true, limits: { maxMessagesPerHour: 5 } });
  });

  it("names the rule that decided", () => {
    const e = edge({ mode: "deny" });
    const g = grant({ source: "org", mode: "read" });
    expect(evaluate(policy({ edges: [e] }), alice, "a2a.send", to(bob)).rule).toBe(`edge:${e.id}`);
    expect(evaluate(policy({ grants: [g] }), alice, "brain.read", brain("org")).rule).toBe(`grant:${g.id}`);
    expect(evaluate(policy(), alice, "brain.write", brain(ownPrivate)).rule).toBe("own-source");
  });
});

describe("evaluate: tenancy", () => {
  it("never applies one organization's rows to another's principal", () => {
    const other = policy({ orgId: OTHER_ORG, grants: [grant({ source: "org", mode: "write" })] });
    // Alice is in ORG; this policy belongs to OTHER_ORG.
    expect(pick(evaluate(other, alice, "brain.read", brain("org")))).toEqual({ allow: false, reason: "org_mismatch" });
    expect(pick(evaluate(other, principal(ALICE, { orgId: OTHER_ORG }), "brain.read", brain("org")))).toEqual({ allow: true, reason: "granted" });
    expect(uuid(1)).toBe(ORG);
  });

  it("compares ids case-insensitively", () => {
    const decision = evaluate(
      policy({ grants: [grant({ principalId: ALICE.toUpperCase(), source: "org", mode: "read" })] }),
      principal(ALICE, { orgId: ORG.toUpperCase() }),
      "brain.read",
      brain("org")
    );
    expect(decision.allow).toBe(true);
  });
});
