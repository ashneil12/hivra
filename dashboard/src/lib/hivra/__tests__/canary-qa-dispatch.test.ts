import { createCanaryQaDispatcher } from "../canary-qa-dispatch";

const scope = { ownerId: "user_qa", hostId: "canary-host", vmid: 1234 };
const operationId = "11111111-1111-4111-8111-111111111111";
const anotherId = "22222222-2222-4222-8222-222222222222";
const input = { ...scope, action: "start", operationId };
const claim = { ...input, status: "claimed" };
const settled = { status: "settled", operationId, outcome: "performed" };
const ok = (data: unknown) => ({ data, error: null });

function fixture() {
  const rpc = jest.fn();
  const schema = jest.fn(() => ({ rpc }));
  let runs = 0;
  const run = jest.fn(async (): Promise<"performed" | "refused" | "unknown"> => {
    runs += 1;
    return "performed";
  });
  const db = { schema };
  const dispatch = createCanaryQaDispatcher({ enabled: true, scope, db, run });
  return { db, rpc, schema, run, dispatch, runs: () => runs };
}

describe("Canary QA dispatch boundary", () => {
  it("is disabled unless the trusted caller explicitly enables it", async () => {
    const { db, schema, run } = fixture();
    const dispatch = createCanaryQaDispatcher({ scope, db, run });

    await expect(dispatch({ ...input, enabled: true })).resolves.toEqual({
      status: "denied", reason: "disabled",
    });
    expect(schema).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["owner mismatch", { ...input, ownerId: "user_other" }],
    ["host mismatch", { ...input, hostId: "other-host" }],
    ["VM mismatch", { ...input, vmid: scope.vmid + 1 }],
    ["VM as text", { ...input, vmid: String(scope.vmid) }],
    ["unlisted action", { ...input, action: "stop" }],
    ["invalid operation ID", { ...input, operationId: "not-a-uuid" }],
    ["noncanonical operation ID", { ...input, operationId: `${operationId}\n` }],
    ["missing input", null],
  ])("denies %s before touching the database or runner", async (_label, request) => {
    const { dispatch, schema, run } = fixture();
    await expect(dispatch(request)).resolves.toEqual({ status: "denied", reason: "invalid_operation" });
    expect(schema).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { ...scope, ownerId: " " },
    { ...scope, hostId: "" },
    { ...scope, vmid: 0 },
    { ...scope, vmid: 2_147_483_648 },
  ])("denies an invalid configured scope even when the request matches", async (invalidScope) => {
    const { db, schema, run } = fixture();
    const dispatch = createCanaryQaDispatcher({ enabled: true, db, run, scope: invalidScope });
    await expect(dispatch({ ...input, ...invalidScope })).resolves.toEqual({
      status: "denied", reason: "invalid_operation",
    });
    expect(schema).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["start", "resize", "create"] as const)("runs only the claimed %s and finishes with the same database client", async (action) => {
    const { dispatch, rpc, schema, run, runs } = fixture();
    const operation = { ...input, action };
    rpc.mockResolvedValueOnce(ok({ ...claim, action })).mockResolvedValueOnce(ok(settled));

    await expect(dispatch({
      ...operation, credential: "ignored", principal: "ignored", args: ["ignored"],
    })).resolves.toEqual({ status: "settled", outcome: "performed" });
    expect(schema.mock.calls).toEqual([["public"]]);
    expect(rpc.mock.calls).toEqual([
      ["claim_canary_qa_dispatch", {
        p_owner_id: scope.ownerId, p_host_id: scope.hostId, p_vmid: scope.vmid,
        p_action: action, p_operation_id: operationId,
      }],
      ["finish_canary_qa_dispatch", { p_operation_id: operationId, p_outcome: "performed" }],
    ]);
    expect(run.mock.calls).toEqual([[operation]]);
    expect(runs()).toBe(1);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1]);
  });

  it("does not run a concurrent replay or a new operation after revocation", async () => {
    const { dispatch, rpc, runs } = fixture();
    let reachedFinish!: () => void;
    const finishStarted = new Promise<void>((resolve) => { reachedFinish = resolve; });
    let releaseFinish!: () => void;
    const finishReleased = new Promise<void>((resolve) => { releaseFinish = resolve; });
    let revoked = false;
    let claimed = false;
    rpc.mockImplementation(async (name, args) => {
      if (name === "finish_canary_qa_dispatch") {
        reachedFinish();
        await finishReleased;
        return ok(revoked ? { status: "denied" } : settled);
      }
      if (revoked) return ok({ status: "denied" });
      if (claimed) return ok({ status: "pending" });
      claimed = true;
      return ok({ ...claim, operationId: args.p_operation_id });
    });

    const firstDispatch = dispatch(input);
    await finishStarted;
    await expect(dispatch(input)).resolves.toEqual({ status: "denied", reason: "claim_not_granted" });
    revoked = true;
    await expect(dispatch({ ...input, operationId: anotherId })).resolves.toEqual({
      status: "denied", reason: "claim_not_granted",
    });
    releaseFinish();
    await expect(firstDispatch).resolves.toEqual({ status: "held", reason: "finish_unconfirmed" });
    expect(runs()).toBe(1);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_canary_qa_dispatch", "finish_canary_qa_dispatch",
      "claim_canary_qa_dispatch", "claim_canary_qa_dispatch",
    ]);
  });

  it.each([
    { ...claim, status: "closed" },
    { ...claim, status: "replay" },
    { ...claim, ownerId: "user_other" },
    { ...claim, hostId: "other-host" },
    { ...claim, vmid: String(scope.vmid) },
    { ...claim, action: "resize" },
    { ...claim, operationId: anotherId },
    { ...settled, operationId: anotherId },
    { ...settled, outcome: "unknown" },
    { status: "claimed" },
    [claim],
    true,
    null,
  ].map((data) => ({ data })))("rejects an unconfirmed claim: $data", async ({ data }) => {
    const { dispatch, rpc, run, runs } = fixture();
    rpc.mockResolvedValueOnce(ok(data));
    await expect(dispatch(input)).resolves.toEqual({ status: "denied", reason: "claim_unconfirmed" });
    expect(run).not.toHaveBeenCalled();
    expect(runs()).toBe(0);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("denies when a claim's acknowledgement is lost or returned with an error", async () => {
    const { dispatch, rpc, run } = fixture();
    rpc.mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce({ data: claim, error: { code: "test" } });
    await expect(dispatch(input)).resolves.toEqual({ status: "denied", reason: "claim_unconfirmed" });
    await expect(dispatch(input)).resolves.toEqual({ status: "denied", reason: "claim_unconfirmed" });
    expect(run).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("records a positive refusal as settled without calling the runner twice", async () => {
    const { dispatch, rpc, run } = fixture();
    run.mockImplementationOnce(async () => "refused");
    rpc.mockResolvedValueOnce(ok(claim)).mockResolvedValueOnce(ok({ ...settled, outcome: "refused" }));

    await expect(dispatch(input)).resolves.toEqual({ status: "settled", outcome: "refused" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith("finish_canary_qa_dispatch", {
      p_operation_id: operationId, p_outcome: "refused",
    });
  });

  it.each([
    async () => "unknown" as const,
    async () => { throw new Error("host transport lost"); },
  ])("holds after an unconfirmed runner outcome without finishing", async (runner) => {
    const { dispatch, rpc, run } = fixture();
    run.mockImplementationOnce(runner);
    rpc.mockResolvedValueOnce(ok(claim));
    await expect(dispatch(input)).resolves.toEqual({ status: "held", reason: "runner_unconfirmed" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ok({ status: "denied" }),
    ok({ ...settled, operationId: anotherId }),
    ok({ ...settled, outcome: "refused" }),
    { data: settled, error: { code: "test" } },
    null,
  ])("holds when finishing is denied or unconfirmed: %j", async (response) => {
    const { dispatch, rpc, runs } = fixture();
    rpc.mockResolvedValueOnce(ok(claim)).mockResolvedValueOnce(response);
    await expect(dispatch(input)).resolves.toEqual({ status: "held", reason: "finish_unconfirmed" });
    expect(runs()).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each(["performed", "refused"] as const)("replays a settled %s receipt without running or finishing", async (outcome) => {
    const { dispatch, rpc, runs } = fixture();
    rpc.mockResolvedValueOnce(ok({ ...settled, outcome }));
    await expect(dispatch(input)).resolves.toEqual({ status: "settled", outcome });
    expect(runs()).toBe(0);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["claim_canary_qa_dispatch"]);
  });

  it("reads a terminal receipt without retrying or dispatching twice after a lost finish acknowledgement", async () => {
    const { dispatch, rpc, runs } = fixture();
    rpc.mockResolvedValueOnce(ok(claim))
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce(ok(settled));
    await expect(dispatch(input)).resolves.toEqual({ status: "held", reason: "finish_unconfirmed" });
    await expect(dispatch(input)).resolves.toEqual({ status: "settled", outcome: "performed" });
    expect(runs()).toBe(1);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_canary_qa_dispatch", "finish_canary_qa_dispatch", "claim_canary_qa_dispatch",
    ]);
  });
});
