/** @jest-environment jsdom */

import {
  createAgent,
  deleteAgent,
  fetchPlan,
  fetchPlanStrict,
  HivraLaunchCorrectableError,
  HivraLaunchInProgressError,
  HivraLaunchRejectedError,
  confirmProviderResize,
  getProviderResizeState,
  listBoxSessions,
  ProviderResizeApiError,
  reviewProviderResize,
  resizeAgent,
  telegramConnect,
  telegramStatus,
  telegramDisconnect,
} from "../agent-api";

describe("listBoxSessions", () => {
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; });

  it("lists the first-contact welcome conversation as Welcome, never under its hidden prompt", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ sessions: [
      { id: "00000000-0000-4000-8000-000000000001", title: "This is a hidden Hivra first-contact setup message. Do not mention", updatedAt: 2 },
      { id: "00000000-0000-4000-8000-000000000002", title: "Plan the week", updatedAt: 1 },
    ] }) } as Response);

    await expect(listBoxSessions("https://box.example.com", "box-token")).resolves.toEqual([
      { id: "00000000-0000-4000-8000-000000000001", title: "Welcome", updatedAt: 2 },
      { id: "00000000-0000-4000-8000-000000000002", title: "Plan the week", updatedAt: 1 },
    ]);
  });
});

describe("resource envelope client", () => {
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; });

  it("sends reserved and maximum resources for a resize", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ success: true, data: { status: "provisioning" } }) } as Response);
    await resizeAgent("agent-1", 2, 4, 6, 8);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
      action: "resize", cpu: 2, ram: 4, maximumCpu: 6, maximumRam: 8,
    });
  });
});
import {
  PROVIDER_RESIZE_BILLING_CONFIRMATION,
  PROVIDER_RESIZE_DOWNTIME_NOTICE,
  type ProviderResizeQuote,
} from "../provider-agent-resize-contract";

// jsdom lacks AbortSignal.timeout (real browsers and Node both have it), so
// polyfill it for the test env. A no-timer signal is enough: fetch is mocked, so
// only the signal's presence/type matters here, not its abort timing.
if (typeof AbortSignal.timeout !== "function") {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () =>
    new AbortController().signal;
}

describe("allocated-provider resize client", () => {
  const originalFetch = global.fetch;
  const agentId = "agent/with scope";
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const size = {
    serverTypeId: 1, serverType: "cpx22", architecture: "x86" as const, cores: 2, memoryGb: 4,
    advertisedDiskGb: 80, cpuType: "shared" as const,
    price: { currency: "EUR", hourlyGross: "0.01", monthlyGross: "5.95" },
  };
  const quote: ProviderResizeQuote = {
    operationId, quoteFingerprint: "d".repeat(64),
    agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", providerServerId: "42", location: "fsn1",
    source: size, target: { ...size, serverTypeId: 2, serverType: "cpx32", cores: 4, memoryGb: 8, advertisedDiskGb: 160,
      price: { ...size.price, monthlyGross: "11.90" } },
    existingDiskGb: 80, upgradeDisk: false,
    observedAt: "2026-09-04T14:00:00.000Z", expiresAt: "2026-09-04T14:05:00.000Z",
    downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
    billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
  };

  afterEach(() => { global.fetch = originalFetch; });

  it("loads only the strict no-cache capability or operation response", async () => {
    const catalog = {
      capability: "hetzner-change-type-v1", agentId: quote.agentId, providerServerId: "42", location: "fsn1",
      providerPowerState: "off", providerLocked: false, requiresPowerOff: true, upgradeDisk: false,
      existingDiskGb: 80, current: size, offers: [{ ...quote.target, description: "CPX32" }],
      observedAt: quote.observedAt, downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ success: true, data: { operation: null, catalog } }) } as Response);

    await expect(getProviderResizeState(agentId)).resolves.toEqual({ operation: null, catalog });
    expect(global.fetch).toHaveBeenCalledWith("/api/hivra/agents/agent%2Fwith%20scope/provider-resize", {
      method: "GET", cache: "no-store", redirect: "error", credentials: "same-origin",
    });
  });

  it("sends only the target review fields and the exact saved billing confirmation", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200,
        json: async () => ({ success: true, data: { quote } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 202,
        json: async () => ({ success: true, data: { operation: {
          operationId, stage: "action_pending", quote, providerActionId: 701,
          providerActionStatus: "running", observedProviderState: null, observedServerType: null,
          completedAt: null, message: "Waiting for Hetzner.",
        } } }) } as Response);

    await reviewProviderResize({ agentId, operationId, targetServerType: "cpx32" });
    await confirmProviderResize({ agentId, operationId, quoteFingerprint: quote.quoteFingerprint });
    const reviewBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const confirmBody = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(reviewBody).toEqual({ mode: "quote", operationId, targetServerType: "cpx32" });
    expect(confirmBody).toEqual({ mode: "apply", operationId, quoteFingerprint: quote.quoteFingerprint,
      billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION });
    for (const [, options] of (global.fetch as jest.Mock).mock.calls) {
      expect(options).toMatchObject({ method: "POST", cache: "no-store", redirect: "error", credentials: "same-origin" });
    }
  });

  it("keeps a stable secret-free API error code instead of accepting a failed envelope", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 409,
      json: async () => ({ success: false, error: "Review a fresh quote.", code: "quote_changed" }) } as Response);
    const outcome = await getProviderResizeState(agentId).catch((error) => error);
    expect(outcome).toBeInstanceOf(ProviderResizeApiError);
    expect(outcome).toMatchObject({ status: 409, code: "quote_changed", message: "Review a fresh quote." });
  });
});

describe("createAgent receipt handling", () => {
  const originalFetch = global.fetch;
  const launchRequestId = "11111111-1111-4111-8111-111111111111";
  const input = {
    type: "codex" as const,
    name: "Codex",
    cpu: 2,
    ram: 4,
    browser: true,
    deployment: { mode: "hivra-managed" as const },
    launchRequestId,
  };

  afterEach(() => { global.fetch = originalFetch; });

  it("sends the caller's stable launch request ID and returns the accepted resource", async () => {
    const agent = { id: "agent-1", type: "codex", name: "Codex", status: "provisioning", cpu: 2, ram: 4 };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: {
        agent,
        launchRequestId,
        launch: { state: "accepted", phase: "accepted" },
      } }),
    } as Response);

    await expect(createAgent(input)).resolves.toEqual(agent);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({ launchRequestId });
  });

  it("surfaces an agent-less replay as the original in-progress launch", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ success: true, data: {
        launchRequestId,
        launch: { state: "reconciling", phase: "reserved" },
      } }),
    } as Response);

    const outcome = await createAgent(input).catch(error => error);
    expect(outcome).toBeInstanceOf(HivraLaunchInProgressError);
    expect(outcome).toMatchObject({ launchRequestId });
  });

  it("surfaces an explicit terminal receipt failure as rejected rather than uncertain", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: "The target changed before launch.",
        code: "agent_insert_conflict",
        launchRequestId,
        launch: { state: "failed", phase: "failed" },
      }),
    } as Response);

    const outcome = await createAgent(input).catch(error => error);
    expect(outcome).toBeInstanceOf(HivraLaunchRejectedError);
    expect(outcome).toMatchObject({ status: 409, code: "agent_insert_conflict" });
  });

  it("keeps an ordinary 4xx correction distinct from a terminal failed receipt", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: "Refresh the selected capacity and review this launch.",
        code: "target_revision_changed",
      }),
    } as Response);

    const outcome = await createAgent(input).catch(error => error);
    expect(outcome).toBeInstanceOf(HivraLaunchCorrectableError);
    expect(outcome).not.toBeInstanceOf(HivraLaunchRejectedError);
    expect(outcome).toMatchObject({ status: 409, code: "target_revision_changed" });
  });

  // Live on Canary, a launch refused because no host had the current
  // provisioner read as "We couldn't confirm the launch yet": nothing had
  // been created, and the launch only needed trying again.
  it("returns a refusal made before anything was created to Review, even as a 503", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        success: false,
        error: "Deployment target is temporarily unavailable while the Hivra provisioner is being prepared. Please try again shortly.",
        code: "placement_unavailable",
      }),
    } as Response);

    const outcome = await createAgent(input).catch(error => error);
    expect(outcome).toBeInstanceOf(HivraLaunchCorrectableError);
    expect(outcome).toMatchObject({ status: 503, code: "placement_unavailable" });
  });

  it("requires a new receipt when the server reports request identity conflict", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: "That request ID belongs to different launch settings.",
        code: "request_conflict",
      }),
    } as Response);

    const outcome = await createAgent(input).catch(error => error);
    expect(outcome).toBeInstanceOf(HivraLaunchRejectedError);
    expect(outcome).toMatchObject({ status: 409, code: "request_conflict" });
  });

  it("keeps an unconfirmed server outcome retryable with the same receipt", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        success: false,
        error: "The saved launch could not be confirmed.",
        code: "launch_unconfirmed",
        launchRequestId,
        launch: { state: "reconciling", phase: "reconciling" },
      }),
    } as Response);

    await expect(createAgent(input)).rejects.toMatchObject({
      name: "HivraLaunchInProgressError",
      launchRequestId,
    });
  });

  it("does not misreport a bound in-progress resource as accepted", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ success: true, data: {
        agent: { id: "agent-1", type: "codex", name: "Codex", status: "provisioning", cpu: 2, ram: 4 },
        launchRequestId,
        launch: { state: "in_progress", phase: "bound" },
      } }),
    } as Response);

    await expect(createAgent(input)).rejects.toBeInstanceOf(HivraLaunchInProgressError);
  });

  it("does not treat an agent-less generic success envelope as a launch receipt", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ success: true, data: {} }),
    } as Response);

    await expect(createAgent(input)).rejects.toThrow("Provision returned an invalid receipt (202)");
  });

  it("does not accept an agent while its matching receipt is still reconciling", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ success: true, data: {
        agent: { id: "agent-1", type: "codex", name: "Codex", status: "provisioning", cpu: 2, ram: 4 },
        launchRequestId,
        launch: { state: "reconciling", phase: "bound" },
      } }),
    } as Response);

    await expect(createAgent(input)).rejects.toBeInstanceOf(HivraLaunchInProgressError);
  });

  it("accepts a model launch from its own admission record, which names the request but has no launch state", async () => {
    const agent = { id: "agent-1", type: "codex", name: "Codex", status: "provisioning", cpu: 2, ram: 4 };
    const modelInput = { ...input, llm: { provider: "venice" as const, mode: "managed" as const, model: "deepseek-v4-pro", walletType: "card" as const } };
    for (const status of [200, 201]) {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status,
        json: async () => ({ success: true, data: { agent, launchRequestId } }),
      } as Response);
      await expect(createAgent(modelInput)).resolves.toEqual(agent);
    }
  });

  it("still needs an accepted launch state for a launch without a model key", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: {
        agent: { id: "agent-1", type: "codex", name: "Codex", status: "provisioning", cpu: 2, ram: 4 },
        launchRequestId,
      } }),
    } as Response);

    await expect(createAgent(input)).rejects.toThrow("Provision returned an invalid receipt (201)");
  });

  it("never accepts a model launch answered for another request", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {
        agent: { id: "agent-1", type: "codex", name: "Codex", status: "provisioning", cpu: 2, ram: 4 },
        launchRequestId: "22222222-2222-4222-8222-222222222222",
      } }),
    } as Response);

    await expect(createAgent({ ...input, llm: { provider: "venice", mode: "byok", apiKey: "synthetic-venice-key" } }))
      .rejects.toThrow("Provision returned an invalid receipt (200)");
  });
});

describe("deleteAgent", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("resolves only after the API confirms deletion", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    } as Response);

    await expect(deleteAgent("agent-1")).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith("/api/hivra/agents/agent-1", { method: "DELETE", signal: expect.any(AbortSignal), redirect: "error" });
  });

  it("propagates the API error when provider cleanup is rejected", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: "Delete authority changed before provider cleanup. Refresh and retry." }),
    } as Response);

    await expect(deleteAgent("agent-1")).rejects.toThrow("Delete authority changed before provider cleanup. Refresh and retry.");
  });

  it("rejects an unsuccessful HTTP response even when its payload claims success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ success: true }),
    } as Response);

    await expect(deleteAgent("agent-1")).rejects.toThrow("Couldn't delete the agent (502)");
  });

  it("propagates an API rejection even with a successful HTTP status", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: "Agent VM destroy failed" }),
    } as Response);

    await expect(deleteAgent("agent-1")).rejects.toThrow("Agent VM destroy failed");
  });

  it.each([null, {}, { success: "true" }, { success: 1 }])(
    "does not treat an unconfirmed payload as successful deletion: %p",
    async (payload) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      } as Response);

      await expect(deleteAgent("agent-1")).rejects.toThrow("Couldn't delete the agent (200)");
    },
  );

  it("gives a useful fallback for a non-JSON response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    } as unknown as Response);

    await expect(deleteAgent("agent-1")).rejects.toThrow("Couldn't delete the agent (502)");
  });

  it.each([{}, 123, "   "])("does not display an invalid API error value: %p", async (error) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error }),
    } as Response);

    await expect(deleteAgent("agent-1")).rejects.toThrow("Couldn't delete the agent (500)");
  });

  it("rejects a network failure without claiming deletion or exposing transport details", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch https://internal.example.test/?secret=private"));

    await expect(deleteAgent("agent-1")).rejects.toThrow(
      "Couldn't confirm agent deletion. Refresh the agent to check its status before trying again.",
    );
  });

  it.each([{ success: true }, { success: true, data: { ok: false } }, { success: true, data: { pending: true } }])(
    "requires explicit completed deletion, not a generic successful envelope: %j", async payload => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
      await expect(deleteAgent("agent-1")).rejects.toThrow("Couldn't delete the agent (200)");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

  it("advances only an explicitly acknowledged pending removal for the same computer", async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ success: true, data: {
        ok: false, pending: true, stage: "provider_cleanup", agentId: "agent-1",
      } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }) });
    const progress = jest.fn(), completion = deleteAgent("agent-1", { onProgress: progress });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(completion).resolves.toBeUndefined();
    expect(progress).toHaveBeenCalledWith(expect.stringMatching(/original cloud resources/));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ok: true }, { ok: false, pending: true, stage: "unknown", agentId: "agent-1" },
    { ok: false, pending: true, stage: "provider_cleanup", agentId: "another-agent" },
  ])("does not follow an invalid continuation: %j", async data => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ success: true, data }) });
    await expect(deleteAgent("agent-1")).rejects.toThrow("Couldn't delete the agent (202)");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "rejected", "lost"])("follows repeated acknowledged cleanup then stops when %s", async outcome => {
    jest.useFakeTimers();
    const pending = { ok: true, status: 202, json: async () => ({ success: true, data: {
      ok: false, pending: true, stage: "provider_cleanup", agentId: "agent-1",
    } }) };
    const fetchMock = jest.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(pending);
    if (outcome === "completed") fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }) });
    else if (outcome === "rejected") fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ success: false, error: "Cleanup needs attention" }) });
    else fetchMock.mockRejectedValueOnce(new Error("Connection lost"));
    global.fetch = fetchMock;
    const result = deleteAgent("agent-1").catch(error => error as Error);
    await jest.advanceTimersByTimeAsync(60_000);
    if (outcome === "completed") expect(await result).toBeUndefined();
    else expect(await result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("/api/hivra/agents/agent-1"); expect(options.method).toBe("DELETE");
    }
  });

  it("stops subsequent removal checks when the owning UI leaves", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ success: true, data: {
      ok: false, pending: true, stage: "provider_cleanup", agentId: "agent-1",
    } }) });
    await expect(deleteAgent("agent-1", { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow("Removal checks stopped");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds acknowledged pending removal without claiming success", async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ success: true, data: {
      ok: false, pending: true, stage: "operation_finishing", agentId: "agent-1",
    } }) });
    const outcome = deleteAgent("agent-1").catch(error => error as Error);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/not completed within this check window/) }));
    expect(global.fetch).toHaveBeenCalledTimes(80);
  });
});

describe("fetchPlanStrict managed usage", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function response(usage: unknown, key = "command") {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: {
      subscribed: true, plan: { key, totalCpu: 24, totalRam: 131072 }, usage,
    } }) });
  }

  it("uses account-wide counters and converts RAM from MB to GB without rounding", async () => {
    response({ agentCount: 3, usedCpu: 4.5, usedRam: 9728 });
    await expect(fetchPlanStrict()).resolves.toMatchObject({ usage: { agentCount: 3, usedCpu: 4.5, usedRam: 9.5 } });
  });

  it("preserves usage even for a free-tier subscriber", async () => {
    response({ agentCount: 1, usedCpu: 0.5, usedRam: 1024 }, "free");
    await expect(fetchPlanStrict()).resolves.toMatchObject({ key: "free", subscribed: false, usage: { agentCount: 1, usedCpu: 0.5, usedRam: 1 } });
  });

  function noPlan(extra: Record<string, unknown>) {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: {
      subscribed: false, plan: null, usage: null, ...extra,
    } }) });
  }

  it("marks an account billing reports no plan for as needing the Free plan turned on, with what it already runs", async () => {
    noPlan({ planOnHold: null, managedUsage: { agentCount: 1, usedCpu: 0.5, usedRam: 1024 } });
    const plan = await fetchPlanStrict();
    expect(plan).toMatchObject({ key: "free", subscribed: false, needsActivation: true, usage: { agentCount: 1, usedCpu: 0.5, usedRam: 1 } });
    expect(plan?.onHold).toBeUndefined();
  });

  it("leaves an account without a plan unknown, never empty, when billing couldn't read what it runs", async () => {
    noPlan({});
    const plan = await fetchPlanStrict();
    expect(plan).toMatchObject({ key: "free", needsActivation: true });
    expect(plan?.usage).toBeUndefined();
    noPlan({ managedUsage: { agentCount: -1, usedCpu: 0, usedRam: 0 } });
    expect((await fetchPlanStrict())?.usage).toBeUndefined();
  });

  it("reads a paid plan on hold as that plan, never as an account that can turn Free on", async () => {
    noPlan({
      planOnHold: { key: "operator", name: "Pro", status: "past_due", reason: "payment_overdue", billingPortal: true },
      managedUsage: { agentCount: 2, usedCpu: 1, usedRam: 2048 },
    });
    const plan = await fetchPlanStrict();
    expect(plan?.needsActivation).toBeUndefined();
    expect(plan?.onHold).toEqual({ key: "operator", name: "Pro", reason: "payment_overdue", billingPortal: true });
    // Everything else stays Free's shape: nothing reads the account as paid.
    expect(plan).toMatchObject({ key: "free", name: "Free", subscribed: false, usage: { agentCount: 2, usedCpu: 1, usedRam: 2 } });
  });

  it.each([
    { key: "operator", name: "Pro", reason: "unknown_reason" },
    { key: "", name: "Pro", reason: "no_slots" },
    { key: "operator", reason: "no_slots" },
    "operator",
  ])("treats a malformed plan hold as no hold: %j", async (planOnHold) => {
    noPlan({ planOnHold });
    const plan = await fetchPlanStrict();
    expect(plan?.onHold).toBeUndefined();
    expect(plan?.needsActivation).toBe(true);
  });

  it("never marks an active plan, Free included, as needing activation", async () => {
    response({ agentCount: 0, usedCpu: 0, usedRam: 0 }, "free");
    expect((await fetchPlanStrict())?.needsActivation).toBeUndefined();
    response({ agentCount: 0, usedCpu: 0, usedRam: 0 }, "operator");
    expect((await fetchPlanStrict())?.needsActivation).toBeUndefined();
  });

  it.each([null, {}, { agentCount: 0 }, { agentCount: -1, usedCpu: 0, usedRam: 0 }, { agentCount: 1, usedCpu: "2", usedRam: 4096 }, { agentCount: 1, usedCpu: 2, usedRam: -1 }])("does not invent empty capacity from invalid usage: %j", async (usage) => {
    response(usage);
    expect((await fetchPlanStrict())?.usage).toBeUndefined();
  });
});

describe("fetchPlan", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("uses the billing usage entitlement slot count instead of hardcoded plan defaults", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          subscribed: true,
          plan: {
            name: "Pro",
            key: "operator",
            maxAgents: 7,
            maxCpuPerAgent: 2,
            maxRamPerAgent: 4096,
            totalCpu: 6,
            totalRam: 12288,
          },
        },
      }),
    } as Response);

    const plan = await fetchPlan();

    expect(global.fetch).toHaveBeenCalledWith("/api/billing/usage", { cache: "no-store" });
    expect(plan).toEqual(
      expect.objectContaining({
        subscribed: true,
        key: "operator",
        maxAgents: 7,
        poolCpu: 6,
        poolRam: 12,
      })
    );
  });
});

// Regression: a blackholed/slow Hivra box must never leave the connect flow's
// spinner (or the status poll) hanging forever — every Telegram box round-trip
// carries an AbortSignal deadline, and connect maps an abort to a friendly,
// retryable error instead of surfacing a raw fetch error / hanging.
describe("telegram box calls are bounded (regression: silent hang)", () => {
  const originalFetch = global.fetch;
  const BOX = "https://box.example.com";
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("telegramConnect sends an AbortSignal and maps a timeout/abort to a friendly error", async () => {
    const okFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, botUsername: "b", setupToken: "t" }),
    } as Response);
    global.fetch = okFetch;
    await telegramConnect(BOX, "123:token", null, "tok");
    expect(okFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/telegram/connect"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    global.fetch = jest.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const res = await telegramConnect(BOX, "123:token", null, "tok");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/taking longer than expected/i);
  });

  it("telegramStatus sends an AbortSignal and falls back to not-connected on abort", async () => {
    const statusFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, active: true, ownerId: "1" }),
    } as Response);
    global.fetch = statusFetch;
    await telegramStatus(BOX, "tok");
    expect(statusFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/telegram/status"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    global.fetch = jest.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const res = await telegramStatus(BOX, "tok");
    expect(res).toEqual({ connected: false, active: false, ownerId: null });
  });

  it("telegramDisconnect sends an AbortSignal and never throws (best-effort)", async () => {
    const dcFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = dcFetch;
    await expect(telegramDisconnect(BOX, "tok")).resolves.toBeUndefined();
    expect(dcFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/telegram/disconnect"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
