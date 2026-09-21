/** Tier-change service regression tests.
 *
 * The service is the single chokepoint for "user moved between tiers" —
 * Stripe webhook AND token snapshot cron both call it. A bug here would:
 *   - silently fail to live-resize a paid user's VM after a Stripe upgrade
 *   - downgrade a Hetzner-only user's instance even though we don't support
 *     Hetzner live resize yet
 *   - update DB but not warden cache, so the new tier doesn't take effect
 *
 * Tests focus on the orchestration logic (which infra paths get touched
 * for which provider) rather than mocking out Supabase wholesale.
 */

import { applyTierChange } from "../tier-change-service";

// Mock dependencies BEFORE importing the service under test would normally
// be the pattern — but applyTierChange imports its deps inside the function
// body (lazy/dynamic for circular-import avoidance), so jest.mock at the
// top works.

jest.mock("@/lib/supabase", () => {
  // Hoisted shared mock builder
  const updateEqMock = jest.fn().mockResolvedValue({ error: null });
  const updateInMock = jest.fn().mockResolvedValue({ error: null });
  const fromMock = jest.fn();
  return {
    supabaseAdmin: { from: fromMock },
    __mocks: { fromMock, updateEqMock, updateInMock },
  };
});

jest.mock("../proxmox-instance-service", () => ({
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn().mockReturnValue(null),
  resizeProxmoxVm: jest.fn().mockResolvedValue({ ok: true, stdout: "", stderr: "" }),
}));

import { supabaseAdmin } from "@/lib/supabase";
import { resizeProxmoxVm } from "../proxmox-instance-service";

const fromMock = (supabaseAdmin!.from as jest.Mock);

function mockInstanceList(rows: unknown[]) {
  // Supabase chain: .from().select().eq().not()
  // returns { data, error }
  const updateChain = {
    eq: jest.fn().mockReturnValue({
      in: jest.fn().mockResolvedValue({ error: null }),
    }),
  };
  fromMock.mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        not: jest.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
    update: jest.fn().mockReturnValue(updateChain),
  });
}

/**
 * Same as mockInstanceList but captures every update() payload so tests
 * can assert on what was written to hermes_instances. Used by the
 * tier_change_pending regression suite below.
 */
function mockInstanceListCapturingUpdates(rows: unknown[]) {
  const updates: Array<{ payload: Record<string, unknown>; rowIds: unknown }> = [];
  fromMock.mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        not: jest.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
    update: jest.fn().mockImplementation((payload: Record<string, unknown>) => ({
      eq: jest.fn().mockReturnValue({
        in: jest.fn().mockImplementation((_col: string, ids: unknown) => {
          updates.push({ payload, rowIds: ids });
          return Promise.resolve({ error: null });
        }),
      }),
    })),
  });
  return updates;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("applyTierChange", () => {
  it("no-ops when the user has no active instances", async () => {
    mockInstanceList([]);
    const outcome = await applyTierChange({
      userId: "user-1",
      newTier: "operator",
      source: "stripe",
    });
    expect(outcome.instancesUpdated).toBe(0);
    expect(outcome.resizesAttempted).toBe(0);
    expect(resizeProxmoxVm).not.toHaveBeenCalled();
  });

  it("hits the Proxmox live-resize path for a Proxmox VM", async () => {
    // Regression: Proxmox VMs MUST get qm set --cpulimit + --memory
    // applied live; without this, a Stripe upgrade leaves the VM at
    // its old caps until next reboot.
    mockInstanceList([
      {
        id: "inst-prox-1",
        config: { infrastructure: { provider: "proxmox", vmid: 201 } },
        hetzner_server_id: null,
        cpu_limit: 1,
        ram_limit: 2048,
        resource_tier: "credit_base",
        gateway_url: "https://abc.example.com",
      },
    ]);

    const outcome = await applyTierChange({
      userId: "user-2",
      newTier: "operator",
      source: "stripe",
    });

    expect(outcome.instancesUpdated).toBe(1);
    expect(outcome.resizesAttempted).toBe(1);
    expect(outcome.resizesSucceeded).toBe(1);
    expect(outcome.resizesFailed).toEqual([]);
    expect(resizeProxmoxVm).toHaveBeenCalledWith({
      vmid: 201,
      cpuLimit: 2,        // operator plan: PLANS.operator.maxCpuPerAgent
      memoryMb: 4096,     // operator plan: PLANS.operator.maxRamPerAgent
      cpuUnits: 100,      // operator priority (1) → cgroup CPU weight 100
    }, {
      hostConfig: null,
    });
  });

  it("does NOT call qm set on a Hetzner-backed instance (live resize unsupported)", async () => {
    // Regression: Hetzner live resize requires container recreate which
    // interrupts active chats. MVP defers Hetzner resize to next provisioning,
    // so the tier-change service must skip the Proxmox path for them and
    // ONLY update the DB row.
    mockInstanceList([
      {
        id: "inst-htz-1",
        config: null, // no infrastructure block = legacy Hetzner
        hetzner_server_id: 12345,
        cpu_limit: 1,
        ram_limit: 2048,
        resource_tier: "credit_base",
        gateway_url: "https://hetzner.example.com",
      },
    ]);

    const outcome = await applyTierChange({
      userId: "user-3",
      newTier: "operator",
      source: "stripe",
    });

    expect(outcome.instancesUpdated).toBe(1);
    expect(outcome.resizesAttempted).toBe(0);
    expect(resizeProxmoxVm).not.toHaveBeenCalled();
  });

  it("records a non-throwing Proxmox resize result with ok=false as a failure without aborting the batch", async () => {
    // Regression: resizeProxmoxVm can resolve { ok: false } instead of throwing.
    // That must still be counted as a failure, not a successful resize.
    (resizeProxmoxVm as jest.Mock)
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "ssh failed" })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" });

    mockInstanceList([
      {
        id: "inst-broken",
        config: { infrastructure: { provider: "proxmox", vmid: 100 } },
        hetzner_server_id: null,
        cpu_limit: 1,
        ram_limit: 2048,
        resource_tier: "credit_base",
        gateway_url: null,
      },
      {
        id: "inst-ok",
        config: { infrastructure: { provider: "proxmox", vmid: 101 } },
        hetzner_server_id: null,
        cpu_limit: 1,
        ram_limit: 2048,
        resource_tier: "credit_base",
        gateway_url: null,
      },
    ]);

    const outcome = await applyTierChange({
      userId: "user-4",
      newTier: "operator",
      source: "stripe",
    });

    expect(outcome.instancesUpdated).toBe(2);
    expect(outcome.resizesAttempted).toBe(2);
    expect(outcome.resizesSucceeded).toBe(1);
    expect(outcome.resizesFailed).toHaveLength(1);
    expect(outcome.resizesFailed[0].instanceId).toBe("inst-broken");
    expect(outcome.resizesFailed[0].error).toContain("Proxmox resize failed");
  });

  it("stacks the Venice boost (+1 vCPU / +2GB) on a paid tier when veniceBoost is passed", async () => {
    // Regression: a paid user holding ≥ $199 of VVV must get the boosted
    // caps written AND live-resized — operator base 2/4096 → 3/6144.
    mockInstanceList([
      {
        id: "inst-boost",
        config: { infrastructure: { provider: "proxmox", vmid: 300 } },
        hetzner_server_id: null,
        cpu_limit: 0.5,
        ram_limit: 1024,
        resource_tier: "credit_base",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-boost",
      newTier: "operator",
      source: "stripe",
      veniceBoost: true,
    });

    expect(resizeProxmoxVm).toHaveBeenCalledWith(
      { vmid: 300, cpuLimit: 3, memoryMb: 6144, cpuUnits: 100 },
      { hostConfig: null }
    );
  });

  it("ignores the Venice boost on a non-paid tier", async () => {
    // A free/token-base user who holds VVV gets no extra compute until they
    // upgrade — credit_base stays 0.5 / 1024 even with veniceBoost=true.
    mockInstanceList([
      {
        id: "inst-free-boost",
        config: { infrastructure: { provider: "proxmox", vmid: 301 } },
        hetzner_server_id: null,
        cpu_limit: 0.5,
        ram_limit: 1024,
        resource_tier: "credit_base",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-free-boost",
      newTier: "credit_base",
      source: "manual",
      veniceBoost: true,
    });

    expect(resizeProxmoxVm).toHaveBeenCalledWith(
      { vmid: 301, cpuLimit: 0.5, memoryMb: 1024, cpuUnits: 50 },
      { hostConfig: null }
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  //  tier_change_pending split (Brief 4 / Hetzner tier resize)
  //
  //  Hetzner has no live-resize path. After applyTierChange writes new
  //  cpu_limit/ram_limit to the row, the running container is still on
  //  old caps until the next redeploy. The dashboard surfaces a
  //  "Apply your new tier" banner driven by tier_change_pending.
  //
  //  Service contract:
  //    - Base write:    single atomic UPDATE setting resource_tier +
  //                     cpu_limit + ram_limit + updated_at on ALL rows.
  //                     Throws on failure → Stripe webhook retries.
  //    - Flag follow-up: separate best-effort UPDATE that sets
  //                     tier_change_pending=true ONLY on Hetzner rows.
  //                     Failures are logged, not thrown. Proxmox rows
  //                     keep the column at its default false.
  // ──────────────────────────────────────────────────────────────────────

  it("writes resource_tier to every row, and folds a uniform size into that same atomic update", async () => {
    // Both rows sit at the same size, so the target is uniform and collapses
    // back into the single base write. resource_tier is the ENTITLEMENT LABEL
    // and is always uniform regardless of per-row sizing.
    const updates = mockInstanceListCapturingUpdates([
      {
        id: "inst-prox-mixed",
        config: { infrastructure: { provider: "proxmox", vmid: 700 } },
        hetzner_server_id: null,
        cpu_limit: 2,
        ram_limit: 4096,
        resource_tier: "operator",
        gateway_url: null,
      },
      {
        id: "inst-htz-mixed",
        config: null,
        hetzner_server_id: 88888,
        cpu_limit: 2,
        ram_limit: 4096,
        resource_tier: "operator",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-mixed",
      newTier: "fleet",
      source: "stripe",
    });

    const baseUpdate = updates.find(
      (u) =>
        u.payload.resource_tier === "fleet" &&
        u.payload.tier_change_pending === undefined
    );
    expect(baseUpdate).toBeDefined();
    // Held at their existing 2 / 4096 rather than flattened up to the fleet
    // per-agent cap (4 / 8192) — two agents can't both take the whole pool.
    expect(baseUpdate!.payload.cpu_limit).toBe(2);
    expect(baseUpdate!.payload.ram_limit).toBe(4096);
    expect(Array.isArray(baseUpdate!.rowIds) ? baseUpdate!.rowIds : []).toEqual(
      expect.arrayContaining(["inst-prox-mixed", "inst-htz-mixed"])
    );
  });

  it("raises tier_change_pending on every instance whose caps changed (both backends)", async () => {
    // Downgrade fleet → operator: both rows sit above the new per-agent cap, so
    // both clamp down and both need the container redeploy. (An UPGRADE would
    // not move a multi-instance user's sizes at all — see the clamp-down rule
    // in resolveTargetSize — so it can't exercise this path.)
    const updates = mockInstanceListCapturingUpdates([
      {
        id: "inst-prox-only",
        config: { infrastructure: { provider: "proxmox", vmid: 700 } },
        hetzner_server_id: null,
        cpu_limit: 4,
        ram_limit: 8192,
        resource_tier: "fleet",
        gateway_url: null,
      },
      {
        id: "inst-htz-only",
        config: null,
        hetzner_server_id: 88888,
        cpu_limit: 4,
        ram_limit: 8192,
        resource_tier: "fleet",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-mixed",
      newTier: "operator",
      source: "stripe",
    });

    const flagUpdate = updates.find(
      (u) => u.payload.tier_change_pending === true
    );
    expect(flagUpdate).toBeDefined();
    // BOTH containers need a redeploy to pick up the new compose caps — the
    // Proxmox qm-set only raises the VM ceiling, not the container cgroup, so
    // the boost/tier wouldn't reach the agent without recreating the container.
    const flagRowIds = Array.isArray(flagUpdate!.rowIds) ? flagUpdate!.rowIds : [];
    expect(flagRowIds).toEqual(
      expect.arrayContaining(["inst-prox-only", "inst-htz-only"])
    );
  });

  it("does not flag rows whose caps are unchanged (no needless container restart)", async () => {
    const updates = mockInstanceListCapturingUpdates([
      {
        // Already at operator caps (2 / 4096) — re-applying operator changes
        // nothing, so no redeploy should be queued.
        id: "inst-steady",
        config: { infrastructure: { provider: "proxmox", vmid: 100 } },
        hetzner_server_id: null,
        cpu_limit: 2,
        ram_limit: 4096,
        resource_tier: "operator",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-steady",
      newTier: "operator",
      source: "stripe",
    });

    const flagWrites = updates.filter(
      (u) => u.payload.tier_change_pending !== undefined
    );
    expect(flagWrites).toHaveLength(0);
  });

  it("carries the upgrade all the way down to the container cgroup, not just the VM", async () => {
    // Regression: the free-to-paid upgrade resized the VM to 4096 MB
    // but `docker inspect` stayed at Memory=1073741824 on `-gateway` and
    // `-official-dashboard`, so v8's heap_size_limit stayed at 524 MB and the
    // customer's `next build` still died. The DB write and the qm-set were both
    // correct — the container ceiling was simply never moved.
    //
    // This joins the two halves that used to be disconnected: the memoryMb this
    // service hands resizeProxmoxVm must be the same number the guest script
    // sets the container cgroup to.
    const { buildAgentContainerCgroupScript } = jest.requireActual(
      "../proxmox-instance-service"
    ) as typeof import("../proxmox-instance-service");

    mockInstanceList([
      {
        id: "inst-tier-change",
        config: { infrastructure: { provider: "proxmox", vmid: 1148 } },
        hetzner_server_id: null,
        // The shape that broke: free-tier caps on the row.
        cpu_limit: 0.5,
        ram_limit: 1024,
        resource_tier: "credit_base",
        gateway_url: "https://tier-change.example.com",
      },
    ]);

    await applyTierChange({ userId: "user-tier-change", newTier: "operator", source: "stripe" });

    const [resizeArgs] = (resizeProxmoxVm as jest.Mock).mock.calls[0] as [
      { cpuLimit: number; memoryMb: number },
    ];
    expect(resizeArgs.memoryMb).toBe(4096);

    const guestScript = buildAgentContainerCgroupScript({
      memoryMb: resizeArgs.memoryMb,
      cpus: resizeArgs.cpuLimit,
    });
    // The container is moved off the old 1024 MB ceiling onto the new one.
    expect(guestScript).toContain("MEM_MB='4096'");
    expect(guestScript).not.toContain("MEM_MB='1024'");
    expect(guestScript).toContain("docker update --memory");
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Per-instance sizing vs the plan POOL
  //
  //  A plan is a compute pool the user splits across agents: on every plan
  //  totalCpu === maxCpuPerAgent while maxAgents is 3/5/8, so only a
  //  single-agent user can sit at the per-agent cap. This service used to
  //  write spec.cpuLimit/spec.ramLimitMb to EVERY row, which both handed
  //  each agent the whole pool (a Power user with 3 agents came out
  //  allocated 12 vCPU against the 4 they pay for) and silently overwrote
  //  whatever split the user chose at create time.
  //
  //  Contract (confirmed with Ash 2026-08-04): clamp DOWN always; grow only
  //  when growth is unambiguous, i.e. the user has exactly one instance.
  // ──────────────────────────────────────────────────────────────────────

  it("snaps a SINGLE instance up to the full tier spec on upgrade", async () => {
    // The unambiguous case: one agent, one way to fill the pool. An upgrade
    // must still deliver the compute the user just paid for.
    const updates = mockInstanceListCapturingUpdates([
      {
        id: "inst-solo",
        config: { infrastructure: { provider: "proxmox", vmid: 900 } },
        hetzner_server_id: null,
        cpu_limit: 2,
        ram_limit: 4096,
        resource_tier: "operator",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-solo",
      newTier: "fleet",
      source: "stripe",
    });

    const baseUpdate = updates.find((u) => u.payload.resource_tier === "fleet");
    expect(baseUpdate!.payload.cpu_limit).toBe(4);
    expect(baseUpdate!.payload.ram_limit).toBe(8192);
    expect(resizeProxmoxVm).toHaveBeenCalledWith(
      expect.objectContaining({ vmid: 900, cpuLimit: 4, memoryMb: 8192 }),
      expect.anything()
    );
  });

  it("does NOT inflate a multi-instance user's agents to the per-agent cap on upgrade", async () => {
    // THE REGRESSION. Three agents at 1 vCPU each = the 3 vCPU this user
    // actually splits. Flattening them to fleet's 4/8192 cap would allocate
    // 12 vCPU / 24 GB against a 4 vCPU / 8 GB pool — 3x what they pay for —
    // and destroy the split they chose.
    const rows = [1, 2, 3].map((n) => ({
      id: `inst-split-${n}`,
      config: { infrastructure: { provider: "proxmox", vmid: 900 + n } },
      hetzner_server_id: null,
      cpu_limit: 1,
      ram_limit: 2048,
      resource_tier: "operator",
      gateway_url: null,
    }));
    const updates = mockInstanceListCapturingUpdates(rows);

    await applyTierChange({
      userId: "user-split",
      newTier: "fleet",
      source: "stripe",
    });

    const sizeWrites = updates.filter(
      (u) => u.payload.cpu_limit !== undefined || u.payload.ram_limit !== undefined
    );
    for (const write of sizeWrites) {
      expect(write.payload.cpu_limit).toBe(1);
      expect(write.payload.ram_limit).toBe(2048);
    }
    // The entitlement label still moves to the new tier on every row.
    const tierWrite = updates.find((u) => u.payload.resource_tier === "fleet");
    expect(Array.isArray(tierWrite!.rowIds) ? tierWrite!.rowIds : []).toEqual(
      expect.arrayContaining(["inst-split-1", "inst-split-2", "inst-split-3"])
    );
    // …and no VM is grown past what the user chose.
    for (const call of (resizeProxmoxVm as jest.Mock).mock.calls) {
      expect(call[0]).toMatchObject({ cpuLimit: 1, memoryMb: 2048 });
    }
  });

  it("still clamps a multi-instance user DOWN on downgrade", async () => {
    // Downgrades must keep biting: anything above the new per-agent cap is
    // shrunk, per-row, even though upgrades leave sizes alone.
    const updates = mockInstanceListCapturingUpdates([
      {
        id: "inst-big",
        config: { infrastructure: { provider: "proxmox", vmid: 910 } },
        hetzner_server_id: null,
        cpu_limit: 4,
        ram_limit: 8192,
        resource_tier: "fleet",
        gateway_url: null,
      },
      {
        id: "inst-small",
        config: { infrastructure: { provider: "proxmox", vmid: 911 } },
        hetzner_server_id: null,
        cpu_limit: 0.5,
        ram_limit: 1024,
        resource_tier: "fleet",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-downgrade",
      newTier: "operator",
      source: "stripe",
    });

    const resizeCalls = (resizeProxmoxVm as jest.Mock).mock.calls.map((c) => c[0]);
    // Over-cap agent clamped to operator's 2 / 4096…
    expect(resizeCalls).toContainEqual(
      expect.objectContaining({ vmid: 910, cpuLimit: 2, memoryMb: 4096 })
    );
    // …while the already-small one is left exactly where the user put it.
    expect(resizeCalls).toContainEqual(
      expect.objectContaining({ vmid: 911, cpuLimit: 0.5, memoryMb: 1024 })
    );
    // Mixed targets ⇒ the sizes go out as separate per-size writes, and the
    // tier label write must NOT carry a size (that would re-flatten them).
    const tierWrite = updates.find((u) => u.payload.resource_tier === "operator");
    expect(tierWrite!.payload.cpu_limit).toBeUndefined();
    expect(tierWrite!.payload.ram_limit).toBeUndefined();
  });

  it("is idempotent for a multi-instance user (re-applying the same tier is a no-op)", async () => {
    // Guards against a ratchet: repeated tier events (Stripe retries, the
    // token-snapshot cron) must not walk sizes upward.
    const updates = mockInstanceListCapturingUpdates([
      {
        id: "inst-a",
        config: { infrastructure: { provider: "proxmox", vmid: 920 } },
        hetzner_server_id: null,
        cpu_limit: 1,
        ram_limit: 2048,
        resource_tier: "fleet",
        gateway_url: null,
      },
      {
        id: "inst-b",
        config: { infrastructure: { provider: "proxmox", vmid: 921 } },
        hetzner_server_id: null,
        cpu_limit: 3,
        ram_limit: 6144,
        resource_tier: "fleet",
        gateway_url: null,
      },
    ]);

    await applyTierChange({
      userId: "user-steady-split",
      newTier: "fleet",
      source: "stripe",
    });

    // Nothing changed ⇒ no container redeploy queued.
    const flagWrites = updates.filter(
      (u) => u.payload.tier_change_pending !== undefined
    );
    expect(flagWrites).toHaveLength(0);
    const resizeCalls = (resizeProxmoxVm as jest.Mock).mock.calls.map((c) => c[0]);
    expect(resizeCalls).toContainEqual(
      expect.objectContaining({ vmid: 920, cpuLimit: 1, memoryMb: 2048 })
    );
    expect(resizeCalls).toContainEqual(
      expect.objectContaining({ vmid: 921, cpuLimit: 3, memoryMb: 6144 })
    );
  });
});
