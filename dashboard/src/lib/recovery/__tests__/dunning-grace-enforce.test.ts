import {
  enforceGraceExpiredComputeStop,
  GRACE_EXPIRED_ENTITLEMENT_REASON,
  isDunningGraceEnforceLive,
} from "@/lib/recovery/dunning-grace-enforce";
import { supabaseAdmin } from "@/lib/supabase";
import {
  shutdownProxmoxInstance,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
  isProxmoxVmMissingResult,
} from "@/lib/services/proxmox-instance-service";
import {
  hasTokenTierInGrace,
  resolveEffectiveSubscription,
} from "@/lib/billing/instance-entitlement";
import { log } from "@/lib/logger";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  isProxmoxVmMissingResult: jest.fn(() => false),
}));
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(),
  hasTokenTierInGrace: jest.fn(),
}));

type Row = {
  id: string;
  user_id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  infrastructure_provider: string | null;
  /** What the billing suspend left on the row; the enforcer filters on it. */
  entitlement_reason?: string;
};

const infra = {
  provider: "proxmox" as const,
  node: "fixturenode1",
  vmid: 200,
  privateIpv4: "10.250.20.50",
  gatewayHost: "x.agents.hermesos.cloud",
};

/**
 * Stub from("hermes_instances") for both shapes: the terminal SELECT
 * (`.select().eq().in().not().is()`) resolves to the candidates whose
 * entitlement_reason passes the eq/in filters the code applied; each per-row
 * UPDATE (`.update().eq().in()`) records the patch and the reasons it was
 * allowed to overwrite, and resolves `{error:null}`. Distinguished by whether
 * `.update()` was called on the builder.
 */
function stubInstances(candidates: Row[]) {
  const updates: Array<{
    id: string;
    patch: Record<string, unknown>;
    reasons: string[] | null;
  }> = [];
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_instances") throw new Error(`unexpected table ${table}`);
    let isUpdate = false;
    let patch: Record<string, unknown> = {};
    let id: string | null = null;
    let reasons: string[] | null = null;
    const builder: Record<string, unknown> = {
      select: jest.fn(() => builder),
      update: jest.fn((p: Record<string, unknown>) => {
        isUpdate = true;
        patch = p;
        return builder;
      }),
      eq: jest.fn((col: string, val: string) => {
        if (col === "id") id = val;
        if (col === "entitlement_reason") reasons = [val];
        return builder;
      }),
      in: jest.fn((col: string, vals: string[]) => {
        if (col === "entitlement_reason") reasons = vals;
        return builder;
      }),
      not: jest.fn(() => builder),
      is: jest.fn(() => builder),
      then: (resolve: (v: unknown) => void) => {
        if (isUpdate) {
          updates.push({ id: id ?? "?", patch, reasons });
          resolve({ error: null });
        } else {
          resolve({
            data: candidates.filter(
              (c) =>
                reasons === null ||
                reasons.includes(c.entitlement_reason ?? "subscription_past_due")
            ),
            error: null,
          });
        }
      },
    };
    return builder;
  });
  return updates;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "inst_1",
    user_id: "user_1",
    proxmox_node: "fixturenode1",
    proxmox_vmid: 200,
    host_id: "host_1",
    config: { infrastructure: { provider: "proxmox", node: "fixturenode1", vmid: 200 } },
    infrastructure_provider: "proxmox",
    entitlement_reason: "subscription_past_due",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getProxmoxInfrastructure as jest.Mock).mockReturnValue(infra);
  (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });
  (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
  (hasTokenTierInGrace as jest.Mock).mockResolvedValue(false);
  delete process.env.DUNNING_GRACE_ENFORCE_LIVE;
});

describe("isDunningGraceEnforceLive", () => {
  it("is false unless the flag is exactly 'true'", () => {
    expect(isDunningGraceEnforceLive({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isDunningGraceEnforceLive({ DUNNING_GRACE_ENFORCE_LIVE: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isDunningGraceEnforceLive({ DUNNING_GRACE_ENFORCE_LIVE: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("enforceGraceExpiredComputeStop", () => {
  it("skips a user who still has ANY effective entitlement (token/yearly underneath)", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
      source: "token_holding",
      plan: "operator",
    });

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("skipped_entitled");
    expect(result.affected).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    // Must not even query instances once we know the user is still entitled.
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("returns skipped_no_instances when the lapsed user has no eligible rows", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    stubInstances([]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("skipped_no_instances");
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("DRY-RUN by default: reports wouldStop but never touches a VM or a row", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    const updates = stubInstances([row(), row({ id: "inst_2", proxmox_vmid: 201 })]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: false });
    expect(result.outcome).toBe("dry_run");
    expect(result.affected).toBe(2);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("LIVE: shuts the VM down (onboot:0) and pins the grace-expired reason", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    const updates = stubInstances([row()]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("stopped");
    expect(result.affected).toBe(1);
    expect(shutdownProxmoxInstance).toHaveBeenCalledWith(
      infra,
      expect.objectContaining({ setOnboot: 0, shutdownTimeoutSeconds: 30 })
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({
      status: "stopped",
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
      entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON,
    });
  });

  it("treats a MISSING VM as already-stopped and still pins the reason", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: false });
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(true);
    const updates = stubInstances([row()]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("stopped");
    expect(updates[0].patch.entitlement_reason).toBe(GRACE_EXPIRED_ENTITLEMENT_REASON);
  });

  it("does NOT pin the reason when a real (non-missing) shutdown fails — leaves it for retry", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: false, stderr: "boom" });
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
    const updates = stubInstances([row()]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("error");
    expect(result.affected).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("skips a non-Proxmox (legacy) row without failing the batch", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    const updates = stubInstances([
      row({ proxmox_vmid: null, proxmox_node: null, config: null }),
    ]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.affected).toBe(0);
  });

  describe("cancelled owners (subscription_canceled)", () => {
    const cancelled = () => row({ entitlement_reason: "subscription_canceled" });

    it("dry run (switch unset): a cancelled owner's running Proxmox computer is not touched", async () => {
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("dry_run");
      expect(result.affected).toBe(1);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("dry-run"),
        expect.objectContaining({ userId: "user_1", wouldStop: 1 })
      );
    });

    it("live: shuts a cancelled owner's computer down (onboot 0) and flips the row to grace expired", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("stopped");
      expect(shutdownProxmoxInstance).toHaveBeenCalledWith(
        infra,
        expect.objectContaining({ setOnboot: 0 })
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].patch).toMatchObject({
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON,
      });
      // The compare-and-set must allow the cancelled reason to be overwritten.
      expect(updates[0].reasons).toEqual(
        expect.arrayContaining(["subscription_canceled", "subscription_past_due"])
      );
    });

    it("an owner with another lane's entitlement is not stopped", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
        source: "token_yearly",
        plan: "operator",
      });
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitled");
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it.each(["1", "TRUE", "false"])(
      "dry run: the switch set to %p is not 'true', so nothing is touched",
      async (value) => {
        process.env.DUNNING_GRACE_ENFORCE_LIVE = value;
        (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
        const updates = stubInstances([cancelled()]);

        const result = await enforceGraceExpiredComputeStop("user_1");
        expect(result.outcome).toBe("dry_run");
        expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
        expect(updates).toHaveLength(0);
      }
    );

    it("an owner whose token tier is still inside its grace is not stopped", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      (hasTokenTierInGrace as jest.Mock).mockResolvedValue(true);
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitled");
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("a failed token grace read stops nothing (fail open)", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      (hasTokenTierInGrace as jest.Mock).mockRejectedValue(new Error("read failed"));
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitlement_unknown");
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("a failed entitlement read stops nothing (fail open)", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockRejectedValue(
        new Error("hermes_subscriptions could not be read: timeout")
      );
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitlement_unknown");
      expect(result.affected).toBe(0);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
      expect(resolveEffectiveSubscription).toHaveBeenCalledWith("user_1", {
        throwOnQueryError: true,
      });
    });
  });

  it("past_due rows are still stopped exactly as before", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    const updates = stubInstances([row({ entitlement_reason: "subscription_past_due" })]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("stopped");
    expect(updates[0].patch.entitlement_reason).toBe(GRACE_EXPIRED_ENTITLEMENT_REASON);
  });

  it("leaves a row that is already grace expired alone", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    stubInstances([row({ entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON })]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("skipped_no_instances");
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });
});
