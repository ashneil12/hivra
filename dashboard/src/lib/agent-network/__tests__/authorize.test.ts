import { authorizeNetworkRequest, type AuthorizeRequest, type AuthzStore } from "../authorize";
import { isAgentNetworkEnabled } from "../flag";
import { ALICE, BOB, ORG, OTHER_ORG, edge, grant, pick, policy, principal, uuid } from "./fixtures";

const ON = { HERMES_DEPLOY_CHANNEL: "canary" };

function contextFor(options: { current: number; policyRevision?: number; withPolicy?: boolean; orgFound?: boolean } & Record<string, unknown>) {
  const revision = options.policyRevision ?? options.current;
  return {
    orgFound: options.orgFound ?? true,
    currentRevision: options.current,
    requestedRevision: revision,
    policy:
      options.withPolicy === false
        ? null
        : policy({ revision, grants: [grant({ source: "org", mode: "write" })], edges: [edge()] }),
    subject: principal(ALICE),
    peer: principal(BOB),
    ...options.overrides as object,
  };
}

function storeReturning(value: unknown): AuthzStore & { getContext: jest.Mock } {
  return { getContext: jest.fn(async () => value) };
}

const request = (extra: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
  orgId: ORG,
  principalId: ALICE,
  action: "brain.write",
  source: "org",
  ...extra,
});

describe("authorizeNetworkRequest", () => {
  it("allows a joined agent with a grant, and records the revision it used", async () => {
    const decision = await authorizeNetworkRequest(storeReturning(contextFor({ current: 7 })), request(), ON);
    expect(decision).toMatchObject({ allow: true, reason: "granted", revision: 7, orgId: ORG });
  });

  it("is off outside Canary, and never reads the store when off", async () => {
    const store = storeReturning(contextFor({ current: 7 }));
    for (const env of [{}, { HERMES_DEPLOY_CHANNEL: "production" }, { HERMES_DEPLOY_CHANNEL: "main" }]) {
      expect(pick(await authorizeNetworkRequest(store, request(), env))).toEqual({ allow: false, reason: "network_disabled_on_deployment" });
    }
    expect(store.getContext).not.toHaveBeenCalled();
    expect(isAgentNetworkEnabled({})).toBe(false);
    expect(isAgentNetworkEnabled(ON)).toBe(true);
  });

  describe("malformed requests deny before the store is asked", () => {
    const bad: Array<[string, unknown]> = [
      ["no request", undefined],
      ["not an object", "x"],
      ["org id not a uuid", { ...request(), orgId: "org" }],
      ["principal id not a uuid", { ...request(), principalId: "alice" }],
      ["unknown action", { ...request(), action: "brain.admin" }],
      ["brain action without a source", { ...request(), source: undefined }],
      ["send without a peer", { ...request(), action: "a2a.send", peerPrincipalId: undefined }],
      ["send with a peer that is not a uuid", { ...request(), action: "a2a.send", peerPrincipalId: "bob" }],
      ["revision zero", { ...request(), revision: 0 }],
      ["revision not an integer", { ...request(), revision: 2.5 }],
      ["negative lag", { ...request(), revision: 3, maxRevisionLag: -1 }],
    ];
    it.each(bad)("%s", async (_name, value) => {
      const store = storeReturning(contextFor({ current: 7 }));
      expect(pick(await authorizeNetworkRequest(store, value as AuthorizeRequest, ON))).toEqual({ allow: false, reason: "malformed_request" });
      expect(store.getContext).not.toHaveBeenCalled();
    });
  });

  describe("an unavailable or untrustworthy store denies", () => {
    it("when the store throws", async () => {
      const store = { getContext: jest.fn(async () => { throw new Error("db down"); }) };
      expect(pick(await authorizeNetworkRequest(store, request(), ON))).toEqual({ allow: false, reason: "policy_unavailable" });
    });
    it.each([
      ["null", null],
      ["a string", "ok"],
      ["an empty object", {}],
      ["a policy with a bad grant mode", { ...contextFor({ current: 7 }), policy: { ...policy({ revision: 7 }), grants: [{ ...grant({ source: "org", mode: "write" }), mode: "root" }] } }],
      ["a subject with an unknown state", { ...contextFor({ current: 7 }), subject: { ...principal(ALICE), state: "owner" } }],
      ["a subject that is not an object", { ...contextFor({ current: 7 }), subject: "alice" }],
    ])("when the store returns %s", async (_name, value) => {
      expect(pick(await authorizeNetworkRequest(storeReturning(value), request(), ON))).toEqual({ allow: false, reason: "policy_unavailable" });
    });
  });

  it("denies an organization with no policy", async () => {
    const store = storeReturning({ orgFound: false, currentRevision: null, requestedRevision: null, policy: null, subject: null, peer: null });
    expect(pick(await authorizeNetworkRequest(store, request(), ON))).toEqual({ allow: false, reason: "no_policy" });
  });

  it("denies a principal the context could not find", async () => {
    const store = storeReturning({ ...contextFor({ current: 7 }), subject: null });
    expect(pick(await authorizeNetworkRequest(store, request(), ON))).toEqual({ allow: false, reason: "unknown_principal" });
  });

  it("denies a context whose policy belongs to a different organization", async () => {
    const wrong = { ...contextFor({ current: 7 }), policy: policy({ orgId: OTHER_ORG, revision: 7 }) };
    expect(pick(await authorizeNetworkRequest(storeReturning(wrong), request(), ON))).toEqual({ allow: false, reason: "unknown_revision" });
  });

  it("denies a context whose policy is not the revision the caller used", async () => {
    const wrong = contextFor({ current: 7, policyRevision: 6 });
    expect(pick(await authorizeNetworkRequest(storeReturning(wrong), request(), ON))).toEqual({ allow: false, reason: "unknown_revision" });
  });

  it("denies a send whose peer the context could not find", async () => {
    const store = storeReturning({ ...contextFor({ current: 7 }), peer: null });
    const send = request({ action: "a2a.send", source: undefined, peerPrincipalId: BOB });
    expect(pick(await authorizeNetworkRequest(store, send, ON))).toEqual({ allow: false, reason: "unknown_peer" });
  });

  it("passes the peer only for a send", async () => {
    const store = storeReturning(contextFor({ current: 7 }));
    await authorizeNetworkRequest(store, request({ peerPrincipalId: BOB }), ON);
    expect(store.getContext).toHaveBeenLastCalledWith(expect.objectContaining({ peerPrincipalId: undefined }));
    await authorizeNetworkRequest(store, request({ action: "a2a.send", source: undefined, peerPrincipalId: BOB }), ON);
    expect(store.getContext).toHaveBeenLastCalledWith(expect.objectContaining({ peerPrincipalId: BOB }));
  });

  describe("revision-skew matrix (B1-T1)", () => {
    // current is 7. The caller claims a revision; the store would return the policy
    // at that revision.
    const cases: Array<{ claimed: number | undefined; lag?: number; expected: { allow: boolean; reason: string }; usedRevision?: number }> = [
      { claimed: undefined, expected: { allow: true, reason: "granted" }, usedRevision: 7 },
      { claimed: 7, expected: { allow: true, reason: "granted" }, usedRevision: 7 },
      { claimed: 8, expected: { allow: false, reason: "unknown_revision" } },
      { claimed: 100, lag: 100, expected: { allow: false, reason: "unknown_revision" } },
      { claimed: 6, expected: { allow: false, reason: "stale_revision" } },
      { claimed: 6, lag: 0, expected: { allow: false, reason: "stale_revision" } },
      { claimed: 6, lag: 1, expected: { allow: true, reason: "granted" }, usedRevision: 6 },
      { claimed: 5, lag: 1, expected: { allow: false, reason: "stale_revision" } },
      { claimed: 5, lag: 2, expected: { allow: true, reason: "granted" }, usedRevision: 5 },
      { claimed: 1, lag: 5, expected: { allow: false, reason: "stale_revision" } },
      { claimed: 1, lag: 6, expected: { allow: true, reason: "granted" }, usedRevision: 1 },
    ];
    it.each(cases)("claimed %p, lag %p", async ({ claimed, lag, expected, usedRevision }) => {
      const store: AuthzStore = {
        getContext: async (input) => contextFor({ current: 7, policyRevision: input.revision ?? 7 }),
      };
      const decision = await authorizeNetworkRequest(store, request({ revision: claimed, maxRevisionLag: lag }), ON);
      expect(pick(decision)).toEqual(expected);
      if (usedRevision !== undefined) expect(decision.revision).toBe(usedRevision);
    });

    it("a revision the database does not have (null policy) denies", async () => {
      const store = storeReturning(contextFor({ current: 7, withPolicy: false }));
      expect(pick(await authorizeNetworkRequest(store, request({ revision: 7 }), ON))).toEqual({ allow: false, reason: "unknown_revision" });
    });
  });

  it("evaluates live principal state however fresh the cached revision is", async () => {
    const suspended = { ...contextFor({ current: 7 }), subject: principal(ALICE, { state: "suspended" }) };
    expect(pick(await authorizeNetworkRequest(storeReturning(suspended), request({ revision: 7 }), ON))).toEqual({
      allow: false,
      reason: "principal_not_joined",
    });
    expect(uuid(1)).toBe(ORG);
  });
});
