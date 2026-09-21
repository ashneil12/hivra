import { runPendingPromptSweep } from "../pending-prompt-sweep";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveClerkRecipient } from "@/lib/recovery/lifecycle-email-sweep";
import { sendAgentApprovalNeededEmail } from "@/lib/email/agent-approval-needed";
import { reportOpsEvent } from "@/lib/ops-events";
import { sendMobilePushToUser } from "@/lib/push/expo-push";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/recovery/lifecycle-email-sweep", () => ({
  resolveClerkRecipient: jest.fn(),
}));
jest.mock("@/lib/email/agent-approval-needed", () => ({
  sendAgentApprovalNeededEmail: jest.fn(),
}));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue(undefined),
}));
// Push is strictly additive beside the email; mocked so the sweep's supabase
// call ledger (queueFrom) stays exactly as it was pre-push.
jest.mock("@/lib/push/expo-push", () => ({
  sendMobilePushToUser: jest.fn(),
}));

const mockedFrom = supabaseAdmin!.from as jest.Mock;
const mockedResolve = resolveClerkRecipient as jest.MockedFunction<typeof resolveClerkRecipient>;
const mockedSend = sendAgentApprovalNeededEmail as jest.MockedFunction<typeof sendAgentApprovalNeededEmail>;
const mockedOps = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;
const mockedPush = sendMobilePushToUser as jest.MockedFunction<typeof sendMobilePushToUser>;

// The sweep calls from("instance_pending_prompts") several times with different
// chains. Queue a builder per expected call, in order.
function queueFrom(...builders: Array<() => unknown>) {
  const q = [...builders];
  mockedFrom.mockImplementation(() => {
    const next = q.shift();
    if (!next) throw new Error("unexpected extra from() call");
    return next();
  });
}

// EXPIRE: update().is().lt().select() -> { data, error }
function expireChain(result: { data?: unknown[]; error?: unknown }) {
  const select = jest.fn().mockResolvedValue({ data: result.data ?? [], error: result.error ?? null });
  const lt = jest.fn().mockReturnValue({ select });
  const is = jest.fn().mockReturnValue({ lt });
  const update = jest.fn().mockReturnValue({ is });
  return { update };
}

// NUDGE: select().is().is().gt().lt().order().limit() -> { data, error }
function nudgeChain(result: { data?: unknown[]; error?: unknown }) {
  const limit = jest.fn().mockResolvedValue({ data: result.data ?? [], error: result.error ?? null });
  const order = jest.fn().mockReturnValue({ limit });
  const lt = jest.fn().mockReturnValue({ order });
  const gt = jest.fn().mockReturnValue({ lt });
  const is2 = jest.fn().mockReturnValue({ gt });
  const is1 = jest.fn().mockReturnValue({ is: is2 });
  const select = jest.fn().mockReturnValue({ is: is1 });
  return { select };
}

// MARKER: update().eq() -> { error }
function markerChain(result: { error?: unknown } = {}) {
  const eq = jest.fn().mockResolvedValue({ error: result.error ?? null });
  const update = jest.fn().mockReturnValue({ eq });
  return { update, _eq: eq };
}

function nudgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    instance_id: "inst-1",
    prompt_id: "call-a",
    user_id: "user_1",
    kind: "approval",
    summary: "rm -rf /x",
    created_at: "2026-07-09T10:00:00.000Z",
    hermes_instances: { name: "My Agent", agent_type: "claude-code" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CLERK_SECRET_KEY = "sk_test_x";
  mockedResolve.mockResolvedValue({ email: "u@example.com", firstName: "Sam" });
  mockedSend.mockResolvedValue({ sent: true, messageId: "m1" });
  mockedPush.mockResolvedValue({
    attempted: 1,
    sent: 1,
    failed: 0,
    pruned: 0,
    skippedNoTokens: false,
  });
});

describe("runPendingPromptSweep — expire", () => {
  it("expires stale rows and reports the count", async () => {
    queueFrom(
      () => expireChain({ data: [{ id: "a" }, { id: "b" }] }),
      () => nudgeChain({ data: [] })
    );
    const summary = await runPendingPromptSweep();
    expect(summary.expired).toBe(2);
  });

  it("does not run the expire UPDATE in dryRun", async () => {
    // dryRun skips expire entirely, so only the nudge select is queued.
    queueFrom(() => nudgeChain({ data: [] }));
    const summary = await runPendingPromptSweep({ dryRun: true });
    expect(summary.expired).toBe(0);
    expect(mockedFrom).toHaveBeenCalledTimes(1);
  });
});

describe("runPendingPromptSweep — nudge (email-first)", () => {
  it("sends one email per candidate then stamps notified_at AFTER the send", async () => {
    const marker = markerChain();
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] }),
      () => marker
    );

    const summary = await runPendingPromptSweep();

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const sendArg = mockedSend.mock.calls[0][0];
    expect(sendArg.email).toBe("u@example.com");
    expect(sendArg.agentName).toBe("My Agent");
    expect(sendArg.agentType).toBe("claude-code");
    expect(sendArg.idempotencyKey).toBe("pending-prompt:row-1");
    // Marker written to close the row for future runs.
    expect(marker.update).toHaveBeenCalledWith({ notified_at: expect.any(String) });
    expect(marker._eq).toHaveBeenCalledWith("id", "row-1");
    expect(summary.emailsSent).toBe(1);
  });

  it("does NOT stamp the marker when Resend fails (so a retry can re-send)", async () => {
    mockedSend.mockResolvedValue({ sent: false, reason: "send_failed", errorMessage: "x" });
    const marker = markerChain();
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] }),
      () => marker // must NOT be consumed
    );
    const summary = await runPendingPromptSweep();
    expect(summary.emailsFailed).toBe(1);
    expect(summary.emailsSent).toBe(0);
    expect(marker.update).not.toHaveBeenCalled();
  });

  it("skips a row whose owner has no resolvable email", async () => {
    mockedResolve.mockResolvedValue(null);
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] })
    );
    const summary = await runPendingPromptSweep();
    expect(summary.emailSkippedNoRecipient).toBe(1);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("dryRun counts would-send without sending or marking", async () => {
    queueFrom(() => nudgeChain({ data: [nudgeRow()] }));
    const summary = await runPendingPromptSweep({ dryRun: true });
    expect(summary.emailsSent).toBe(1);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("bails on nudge without CLERK_SECRET_KEY", async () => {
    delete process.env.CLERK_SECRET_KEY;
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] })
    );
    const summary = await runPendingPromptSweep();
    expect(summary.nudgeCandidates).toBe(1);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("passes clarify kind through to the email", async () => {
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow({ kind: "clarify" })] }),
      () => markerChain()
    );
    await runPendingPromptSweep();
    expect(mockedSend.mock.calls[0][0].kind).toBe("clarify");
  });
});

describe("runPendingPromptSweep — mobile push fan-out (additive beside email)", () => {
  it("fires an approval push beside the accepted email with the approval deep link", async () => {
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] }),
      () => markerChain()
    );

    const summary = await runPendingPromptSweep();

    expect(mockedPush).toHaveBeenCalledTimes(1);
    expect(mockedPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        title: "My Agent needs your approval",
        url: "hivra://approval/inst-1",
      })
    );
    expect(summary.pushesSent).toBe(1);
    expect(summary.pushesFailed).toBe(0);
    // Email behavior unchanged by the push lane.
    expect(summary.emailsSent).toBe(1);
  });

  it("uses question copy for clarify prompts", async () => {
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow({ kind: "clarify" })] }),
      () => markerChain()
    );
    await runPendingPromptSweep();
    expect(mockedPush).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My Agent has a question" })
    );
  });

  it("does NOT push when the email send failed (shared once-guard)", async () => {
    mockedSend.mockResolvedValue({ sent: false, reason: "send_failed", errorMessage: "x" });
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] })
    );
    const summary = await runPendingPromptSweep();
    expect(mockedPush).not.toHaveBeenCalled();
    expect(summary.pushesSent).toBe(0);
  });

  it("does NOT push in dryRun", async () => {
    queueFrom(() => nudgeChain({ data: [nudgeRow()] }));
    await runPendingPromptSweep({ dryRun: true });
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("keeps email accounting byte-identical when the push lane throws", async () => {
    mockedPush.mockRejectedValue(new Error("expo exploded"));
    const marker = markerChain();
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] }),
      () => marker
    );
    const summary = await runPendingPromptSweep();
    expect(summary.emailsSent).toBe(1);
    expect(summary.emailsFailed).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.pushesFailed).toBe(1);
    expect(marker.update).toHaveBeenCalledWith({ notified_at: expect.any(String) });
  });
});

describe("runPendingPromptSweep — ops reporting", () => {
  it("emits a stable-fingerprint ops event only on send failures", async () => {
    mockedSend.mockResolvedValue({ sent: false, reason: "send_failed" });
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [nudgeRow()] })
    );
    await runPendingPromptSweep();
    expect(mockedOps).toHaveBeenCalledTimes(1);
    const ev = mockedOps.mock.calls[0][0];
    expect(ev.severity).toBe("warn");
    // Counts live in metadata (not fingerprinted) so a persistent condition
    // pages once, not every tick.
    expect(ev.title).not.toMatch(/\d/);
    expect(ev.metadata).toMatchObject({ emails_failed: 1 });
  });

  it("emits no ops event on a clean run", async () => {
    queueFrom(
      () => expireChain({ data: [] }),
      () => nudgeChain({ data: [] })
    );
    await runPendingPromptSweep();
    expect(mockedOps).not.toHaveBeenCalled();
  });
});
