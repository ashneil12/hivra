/**
 * Agent-ready push tests. Locks in:
 *   - the notifications_sent once-guard (skip when already sent; atomic
 *     conditional-claim; lost race → no push)
 *   - claim-first ordering (no claim, no push)
 *   - push copy + hivra://chat deep link
 *   - mobile_launch_ready fires ONLY for mobile-launched boxes (ledger stamp)
 *     with elapsed_ms measured from the launch request + $insert_id + flush
 *   - never-throws contract
 */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/push/expo-push", () => ({
  sendMobilePushToUser: jest.fn(),
}));

const captureMock = jest.fn();
const flushMock = jest.fn();
jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => captureMock(...args),
    flush: (...args: unknown[]) => flushMock(...args),
  },
}));

import {
  AGENT_READY_PUSH_LEDGER_KEY,
  MOBILE_LAUNCH_REQUESTED_LEDGER_KEY,
  notifyAgentReady,
} from "../agent-ready-push";
import { sendMobilePushToUser } from "@/lib/push/expo-push";
import { supabaseAdmin } from "@/lib/supabase";

const mockedFrom = supabaseAdmin!.from as jest.Mock;
const mockedPush = sendMobilePushToUser as jest.Mock;

interface DbOptions {
  row?: Record<string, unknown> | null;
  readError?: { message: string } | null;
  claimError?: { message: string } | null;
  /** Rows returned by the conditional claim (empty = lost the race). */
  claimedRows?: Array<{ id: string }>;
}

function instanceDb(opts: DbOptions = {}) {
  const claimSelect = jest.fn().mockResolvedValue({
    data: opts.claimedRows ?? [{ id: "inst-1" }],
    error: opts.claimError ?? null,
  });
  const claimIs = jest.fn().mockReturnValue({ select: claimSelect });
  const claimEq = jest.fn().mockReturnValue({ is: claimIs });
  const update = jest.fn().mockReturnValue({ eq: claimEq });
  mockedFrom.mockImplementation((table: string) => {
    if (table !== "hermes_instances") throw new Error(`unexpected table ${table}`);
    return {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: jest.fn().mockResolvedValue({
            data:
              opts.row === undefined
                ? {
                    id: "inst-1",
                    user_id: "user_owner",
                    name: "Bea",
                    created_at: "2026-07-16T10:00:00.000Z",
                    notifications_sent: {},
                  }
                : opts.row,
            error: opts.readError ?? null,
          }),
        }),
      }),
      update,
    };
  });
  return { update, claimEq, claimIs };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedPush.mockResolvedValue({
    attempted: 1,
    sent: 1,
    failed: 0,
    pruned: 0,
    skippedNoTokens: false,
  });
});

const params = {
  instanceId: "inst-1",
  userId: "user_from_request",
  trigger: "list_provision_promote_proxmox" as const,
};

describe("notifyAgentReady", () => {
  it("claims the ledger key then pushes the ready notification with the chat deep link", async () => {
    const { update, claimEq, claimIs } = instanceDb();

    await notifyAgentReady(params);

    // Atomic claim: merged ledger write, filtered on the key being absent.
    expect(update).toHaveBeenCalledWith({
      notifications_sent: expect.objectContaining({
        [AGENT_READY_PUSH_LEDGER_KEY]: expect.any(String),
      }),
    });
    expect(claimEq).toHaveBeenCalledWith("id", "inst-1");
    expect(claimIs).toHaveBeenCalledWith(
      `notifications_sent->${AGENT_READY_PUSH_LEDGER_KEY}`,
      null
    );

    expect(mockedPush).toHaveBeenCalledWith({
      userId: "user_owner", // the row's owner, not the request's viewer
      title: "Bea is ready — say hi",
      body: "Bea just finished setting up and is waiting for your first task.",
      url: "hivra://chat/inst-1",
      data: { kind: "agent_ready", instanceId: "inst-1" },
    });
  });

  it("skips (no claim write, no push) when the ledger already has the key", async () => {
    const { update } = instanceDb({
      row: {
        id: "inst-1",
        user_id: "user_owner",
        name: "Bea",
        created_at: "2026-07-16T10:00:00.000Z",
        notifications_sent: { [AGENT_READY_PUSH_LEDGER_KEY]: "2026-07-16T10:05:00.000Z" },
      },
    });

    await notifyAgentReady(params);

    expect(update).not.toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("does NOT push when the conditional claim matched no rows (lost the race)", async () => {
    instanceDb({ claimedRows: [] });
    await notifyAgentReady(params);
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("does NOT push when the claim write errors (no claim, no push — never dupe)", async () => {
    instanceDb({ claimError: { message: "db down" } });
    await notifyAgentReady(params);
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("emits mobile_launch_ready with elapsed_ms ONLY for mobile-launched boxes", async () => {
    const requestedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    instanceDb({
      row: {
        id: "inst-1",
        user_id: "user_owner",
        name: "Bea",
        created_at: "2026-07-16T10:00:00.000Z",
        notifications_sent: { [MOBILE_LAUNCH_REQUESTED_LEDGER_KEY]: requestedAt },
      },
    });

    await notifyAgentReady(params);

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captured = captureMock.mock.calls[0][0];
    expect(captured).toMatchObject({
      distinctId: "user_owner",
      event: "mobile_launch_ready",
      properties: expect.objectContaining({
        instance_id: "inst-1",
        trigger: "list_provision_promote_proxmox",
        $insert_id: "mobile_launch_ready_inst-1",
      }),
    });
    // ~2 minutes elapsed, measured from the launch request stamp.
    expect(captured.properties.elapsed_ms).toBeGreaterThanOrEqual(120_000);
    expect(captured.properties.elapsed_ms).toBeLessThan(180_000);
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT emit mobile_launch_ready for web-launched boxes (no ledger stamp)", async () => {
    instanceDb();
    await notifyAgentReady(params);
    expect(mockedPush).toHaveBeenCalledTimes(1); // push still goes out
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("falls back to 'Your agent' when the row has no name", async () => {
    instanceDb({
      row: {
        id: "inst-1",
        user_id: "user_owner",
        name: "  ",
        created_at: "2026-07-16T10:00:00.000Z",
        notifications_sent: {},
      },
    });
    await notifyAgentReady(params);
    expect(mockedPush).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Your agent is ready — say hi" })
    );
  });

  it("never throws: a read failure is swallowed", async () => {
    instanceDb({ row: null, readError: { message: "boom" } });
    await expect(notifyAgentReady(params)).resolves.toBeUndefined();
    expect(mockedPush).not.toHaveBeenCalled();
  });
});
