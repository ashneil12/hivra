import {
  readRecreateState,
  runRecoverMissingVmInstancesSweep,
  shouldAttemptRecreate,
} from "../recover-missing-vm-instances";
import { recreateMissingProxmoxInstanceById } from "@/lib/recreate-missing-proxmox-instance";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/recreate-missing-proxmox-instance", () => ({
  recreateMissingProxmoxInstanceById: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const RELEASE_MARKER = {
  at: "2026-05-18T16:22:53.175Z",
  reason: "post_provision_stale_conflict",
};

function releasedConfig(extra: Record<string, unknown> = {}) {
  return { infrastructureReleased: { ...RELEASE_MARKER }, ...extra };
}

function buildRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000001021",
    user_id: "user_robert",
    config: releasedConfig(),
    status: "stopped",
    lifecycle_state: "paused",
    entitlement_state: "ok",
    resource_tier: "operator",
    created_at: "2026-05-18T16:07:32.000Z",
    ...overrides,
  };
}

/** Chainable + awaitable Supabase query-builder stub. */
function thenable(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "not", "lt", "in", "limit", "update"]) {
    builder[m] = jest.fn(() => builder);
  }
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
const mockedRecreate = recreateMissingProxmoxInstanceById as jest.MockedFunction<
  typeof recreateMissingProxmoxInstanceById
>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("readRecreateState", () => {
  it("defaults to zero attempts when no marker present", () => {
    expect(readRecreateState(null)).toEqual({ attempts: 0, lastAttemptAt: null });
    expect(readRecreateState({})).toEqual({ attempts: 0, lastAttemptAt: null });
  });

  it("parses persisted attempt state", () => {
    expect(
      readRecreateState({ missingVmRecreate: { attempts: 2, lastAttemptAt: "2026-05-20T00:00:00Z" } }),
    ).toEqual({ attempts: 2, lastAttemptAt: "2026-05-20T00:00:00Z" });
  });
});

describe("shouldAttemptRecreate", () => {
  const now = Date.parse("2026-05-20T12:00:00Z");

  it("is eligible with no prior attempts", () => {
    expect(shouldAttemptRecreate({ attempts: 0, lastAttemptAt: null }, now)).toEqual({ eligible: true });
  });

  it("is ineligible once attempts hit the cap", () => {
    expect(shouldAttemptRecreate({ attempts: 3, lastAttemptAt: null }, now)).toEqual({
      eligible: false,
      reason: "exhausted",
    });
  });

  it("is ineligible inside the cooldown window", () => {
    const last = new Date(now - 60_000).toISOString(); // 1 min ago
    expect(shouldAttemptRecreate({ attempts: 1, lastAttemptAt: last }, now)).toEqual({
      eligible: false,
      reason: "cooldown",
    });
  });

  it("is eligible again after the cooldown elapses", () => {
    const last = new Date(now - 31 * 60_000).toISOString(); // 31 min ago
    expect(shouldAttemptRecreate({ attempts: 1, lastAttemptAt: last }, now)).toEqual({ eligible: true });
  });
});

describe("runRecoverMissingVmInstancesSweep", () => {
  it("recreates an eligible released, entitled candidate and bumps the attempt counter", async () => {
    mockedFrom
      .mockReturnValueOnce(thenable({ data: [buildRow()], error: null })) // candidate query
      .mockReturnValue(thenable({ error: null })); // counter bump update
    mockedRecreate.mockResolvedValue({
      ok: true,
      instanceId: "00000000-0000-4000-8000-000000001021",
      status: "provisioning",
      proxmoxVmid: 602,
      proxmoxNode: "fixturenode6",
      gatewayUrl: "https://x.hermesos.cloud",
    });

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary).toMatchObject({ candidates: 1, recreated: 1, failed: 0, errors: 0 });
    expect(mockedRecreate).toHaveBeenCalledWith("00000000-0000-4000-8000-000000001021");
    // counter bump = a second from() call (the update)
    expect(mockedFrom).toHaveBeenCalledTimes(2);
  });

  it("ignores rows that carry no release marker (not confirmed-missing)", async () => {
    mockedFrom.mockReturnValueOnce(
      thenable({ data: [buildRow({ config: { model: "x" } })], error: null }),
    );

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(mockedRecreate).not.toHaveBeenCalled();
  });

  it("never resurrects dormant_reclaim or legacy_backfill rows (non-failure release reasons)", async () => {
    mockedFrom.mockReturnValueOnce(
      thenable({
        data: [
          buildRow({ config: { infrastructureReleased: { at: RELEASE_MARKER.at, reason: "dormant_reclaim" } } }),
          buildRow({
            id: "00000000-0000-4000-8000-000000001000",
            config: { infrastructureReleased: { at: RELEASE_MARKER.at, reason: "legacy_backfill" } },
          }),
        ],
        error: null,
      }),
    );

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(mockedRecreate).not.toHaveBeenCalled();
  });

  it("does not recreate from a single routed-host miss", async () => {
    mockedFrom.mockReturnValueOnce(
      thenable({
        data: [
          buildRow({
            config: {
              infrastructureReleased: {
                at: RELEASE_MARKER.at,
                reason: "vm_missing_on_routed_host",
              },
            },
          }),
        ],
        error: null,
      }),
    );

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary.candidates).toBe(0);
    expect(mockedRecreate).not.toHaveBeenCalled();
  });

  it("skips a candidate that has exhausted its attempts", async () => {
    mockedFrom.mockReturnValueOnce(
      thenable({
        data: [buildRow({ config: releasedConfig({ missingVmRecreate: { attempts: 3, lastAttemptAt: null } }) })],
        error: null,
      }),
    );

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary).toMatchObject({ candidates: 1, recreated: 0, skippedExhausted: 1 });
    expect(mockedRecreate).not.toHaveBeenCalled();
  });

  it("skips a candidate inside the cooldown window", async () => {
    mockedFrom.mockReturnValueOnce(
      thenable({
        data: [
          buildRow({
            config: releasedConfig({
              missingVmRecreate: { attempts: 1, lastAttemptAt: new Date().toISOString() },
            }),
          }),
        ],
        error: null,
      }),
    );

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary).toMatchObject({ candidates: 1, recreated: 0, skippedCooldown: 1 });
    expect(mockedRecreate).not.toHaveBeenCalled();
  });

  it("fires an ops alert (log.error) when the final attempt fails", async () => {
    mockedFrom
      .mockReturnValueOnce(
        thenable({
          data: [buildRow({ config: releasedConfig({ missingVmRecreate: { attempts: 2, lastAttemptAt: null } }) })],
          error: null,
        }),
      )
      .mockReturnValue(thenable({ error: null }));
    mockedRecreate.mockResolvedValue({
      ok: false,
      httpStatus: 502,
      message: "Proxmox recreate provisioning failed",
      failureType: "recreate_missing_proxmox_provision_failed",
    });

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary).toMatchObject({ candidates: 1, failed: 1, recreated: 0 });
    expect(log.error).toHaveBeenCalledWith(
      "recover-missing-vm: gave up after max attempts — manual recreate needed",
      expect.any(Error),
      expect.objectContaining({ failureType: "recover_missing_vm_recreate_exhausted" }),
    );
  });

  it("logs a retry warning (not an alert) when failing below the cap", async () => {
    mockedFrom
      .mockReturnValueOnce(thenable({ data: [buildRow()], error: null }))
      .mockReturnValue(thenable({ error: null }));
    mockedRecreate.mockResolvedValue({
      ok: false,
      httpStatus: 502,
      message: "transient",
      failureType: "recreate_missing_proxmox_provision_failed",
    });

    const summary = await runRecoverMissingVmInstancesSweep();

    expect(summary).toMatchObject({ failed: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      "recover-missing-vm: recreate attempt failed; will retry",
      expect.objectContaining({ failureType: "recover_missing_vm_recreate_failed" }),
    );
    expect(log.error).not.toHaveBeenCalledWith(
      "recover-missing-vm: gave up after max attempts — manual recreate needed",
      expect.any(Error),
      expect.anything(),
    );
  });

  it("returns an empty summary when no candidates match", async () => {
    mockedFrom.mockReturnValueOnce(thenable({ data: [], error: null }));
    const summary = await runRecoverMissingVmInstancesSweep();
    expect(summary).toEqual({
      candidates: 0,
      recreated: 0,
      failed: 0,
      skippedCooldown: 0,
      skippedExhausted: 0,
      errors: 0,
    });
    expect(mockedRecreate).not.toHaveBeenCalled();
  });
});
