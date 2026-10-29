import { NextRequest } from "next/server";
import { GET } from "../route";
import { deleteServer } from "@/lib/hetzner/client";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  isProxmoxBackedInstanceRow,
  resolveProxmoxLifecycleTarget,
} from "@/lib/services/proxmox-infrastructure";
import { reportOpsEvent } from "@/lib/ops-events";
import { deleteProxmoxInstance } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { locateProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";

jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: {
    restoreScheduledDeletions: jest.fn().mockResolvedValue(undefined),
    resumeBillingSuspendedInstances: jest.fn().mockResolvedValue(undefined),
  },
}));
// The purge's entitled-owner check (cross-lane resolver). Default: not entitled.
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  locateProxmoxInstanceAcrossFleet: jest.fn(),
}));

jest.mock("@/lib/hetzner/client", () => ({
  deleteServer: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  deleteProxmoxInstance: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-infrastructure", () => ({
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(),
  isProxmoxBackedInstanceRow: jest.fn(),
  resolveProxmoxLifecycleTarget: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue({ id: "evt_test" }),
  sanitizeOpsMetadata: jest.fn(
    (metadata: Record<string, unknown> | undefined) => metadata ?? {},
  ),
}));

function scheduledFetch(data: unknown[], error: Error | null = null) {
  return {
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        lte: jest.fn().mockResolvedValue({ data, error }),
      }),
    }),
  };
}

function strandedDeletedFetch(data: unknown[], error: Error | null = null) {
  return {
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        neq: jest.fn().mockReturnValue({
          or: jest.fn().mockResolvedValue({ data, error }),
        }),
      }),
    }),
  };
}

// Stand-in for one hermes_instances update. The purge claim is
// update -> eq/is/lte -> select -> maybeSingle; the mark-deleted write awaits
// the chain itself and resolves { error }. Every filter returns the same chain.
function makeUpdate(options: { error?: unknown; claimed?: boolean } = {}) {
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "is", "lte", "select"]) {
    chain[method] = jest.fn(() => chain);
  }
  chain.maybeSingle = jest.fn().mockResolvedValue({
    data: options.claimed === false ? null : { id: "claimed" },
    error: null,
  });
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ error: options.error ?? null }).then(resolve, reject);
  return {
    updateMock: jest.fn().mockReturnValue(chain),
    updateEq: chain.eq as jest.Mock,
    updateLte: chain.lte as jest.Mock,
  };
}

// Batched owner-subscription lookup used by the active-subscription purge guard.
function subsFetch(data: unknown[], error: Error | null = null) {
  return {
    select: jest.fn().mockReturnValue({
      in: jest.fn().mockResolvedValue({ data, error }),
    }),
  };
}

describe("GET /api/cron/purge-expired", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const mockedDeleteServer = deleteServer as jest.MockedFunction<typeof deleteServer>;
  const mockedDeleteProxmoxInstance =
    deleteProxmoxInstance as jest.MockedFunction<typeof deleteProxmoxInstance>;
  const mockedResolveProxmoxLifecycleTarget =
    resolveProxmoxLifecycleTarget as jest.MockedFunction<typeof resolveProxmoxLifecycleTarget>;
  const mockedIsProxmoxBackedInstanceRow =
    isProxmoxBackedInstanceRow as jest.MockedFunction<typeof isProxmoxBackedInstanceRow>;
  const mockedGetProxmoxHostRoutingConfigFromInfrastructure =
    getProxmoxHostRoutingConfigFromInfrastructure as jest.MockedFunction<
      typeof getProxmoxHostRoutingConfigFromInfrastructure
    >;
  const mockedSupabaseAdmin = supabaseAdmin as unknown as { from: jest.Mock };
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    // Default: rows look like Hetzner-only instances unless a test overrides.
    mockedResolveProxmoxLifecycleTarget.mockReturnValue(null);
    mockedIsProxmoxBackedInstanceRow.mockReturnValue(false);
    mockedGetProxmoxHostRoutingConfigFromInfrastructure.mockReturnValue(null);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", { method: "GET" })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/cron secret is not configured/i);
  });

  it("rejects requests with the wrong authorization header", async () => {
    process.env.CRON_SECRET = "expected-secret";

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer wrong-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("does not log raw database fetch errors", async () => {
    process.env.CRON_SECRET = "expected-secret";
    mockedSupabaseAdmin.from
      .mockReturnValueOnce(scheduledFetch([], new Error("db-secret-leak")))
      .mockReturnValueOnce(strandedDeletedFetch([]));

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to query instances");
    const fetchLogs = consoleErrorSpy.mock.calls.flat().join(" ");
    // The structured log line carries the source + failureType so it's still
    // greppable, but the raw error message must never appear.
    expect(fetchLogs).toContain("failed to fetch expired instances");
    expect(fetchLogs).toContain("cron/purge-expired");
    expect(fetchLogs).not.toContain("db-secret-leak");
  });

  it("does not expose raw purge failures in logs or response payloads", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const { updateMock } = makeUpdate();
    mockedSupabaseAdmin.from.mockImplementation((table: string) => {
      if (table !== "hermes_instances") {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            lte: jest.fn().mockResolvedValue({
              data: [
                {
                  id: "inst-123",
                  user_id: "user_123",
                  name: "Atlas",
                  hetzner_server_id: 42,
                },
              ],
              error: null,
            }),
            neq: jest.fn().mockReturnValue({
              or: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
        update: updateMock,
      };
    });
    mockedDeleteServer.mockRejectedValueOnce(new Error("hetzner-secret-leak"));

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purged).toBe(0);
    expect(body.data.failed).toBe(1);
    expect(body.data.results).toEqual([
      {
        id: "inst-123",
        name: "Atlas",
        success: false,
        error: "Failed to purge instance",
      },
    ]);
    const purgeLogs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(purgeLogs).toContain("failed to purge instance");
    expect(purgeLogs).toContain("inst-123");
    expect(purgeLogs).not.toContain("hetzner-secret-leak");
  });

  it("reports a failed purge (not a silent success) when the mark-deleted DB write fails after teardown", async () => {
    process.env.CRON_SECRET = "expected-secret";
    // VM teardown succeeds, but the subsequent mark-deleted UPDATE fails.
    // Previously the update error was unchecked, so the cron logged success
    // while leaving a destroyed VM behind a still-present DB row (orphan).
    const { updateMock } = makeUpdate({ error: { message: "db write failed" } });
    mockedSupabaseAdmin.from
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
        return scheduledFetch([
          { id: "inst-orphan", user_id: "user_x", name: "Orphan", hetzner_server_id: 77 },
        ]);
      })
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
        return strandedDeletedFetch([]);
      })
      .mockImplementation((table: string) => {
        if (table === "instance_deletion_archives") {
          return { insert: jest.fn().mockResolvedValue({ error: null }) };
        }
        if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
        return { update: updateMock };
      });

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedDeleteServer).toHaveBeenCalled(); // VM was destroyed...
    expect(body.data.purged).toBe(0); // ...but the failed DB write is surfaced
    expect(body.data.failed).toBe(1);
    expect(body.data.results).toEqual([
      { id: "inst-orphan", name: "Orphan", success: false, error: "Failed to purge instance" },
    ]);
  });

  it("tears down Proxmox VMs via deleteProxmoxInstance instead of Hetzner delete", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const proxmoxInfra = {
      provider: "proxmox" as const,
      vmid: 203,
      privateIpv4: "10.250.20.55",
      gatewayHost: "agent-vesper.example.com",
    };
    mockedResolveProxmoxLifecycleTarget.mockReturnValue(proxmoxInfra);
    mockedIsProxmoxBackedInstanceRow.mockReturnValue(true);
    mockedDeleteProxmoxInstance.mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    const { updateMock, updateEq } = makeUpdate();
    mockedSupabaseAdmin.from
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return scheduledFetch([
          {
            id: "vesper",
            user_id: "user_gone",
            name: "Vesper",
            hetzner_server_id: null,
            host_id: null,
            config: { infrastructure: { provider: "proxmox", vmid: 203 } },
          },
        ]);
      })
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return strandedDeletedFetch([]);
      })
      .mockImplementation((table: string) => {
        if (table === "instance_deletion_archives") {
          // The purge cron writes a snapshot row before destroy. The test
          // mock just acks; per-test assertions live where they matter.
          return { insert: jest.fn().mockResolvedValue({ error: null }) };
        }
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return {
          update: updateMock,
        };
      });

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purged).toBe(1);
    expect(mockedDeleteProxmoxInstance).toHaveBeenCalledWith(proxmoxInfra, {
      hostConfig: null,
      expectedInstanceId: "vesper",
    });
    // Critically: must NOT touch Hetzner for a Proxmox row.
    expect(mockedDeleteServer).not.toHaveBeenCalled();
    expect(updateEq).toHaveBeenCalledWith("id", "vesper");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
        scheduled_deletion_at: null,
        deleted_at: expect.any(String),
        last_lifecycle_transition_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
  });

  it("hands cold-archived rows to the cold-retention pipeline instead of tearing down the (already destroyed) VM", async () => {
    // Regression: archiveInstance destroys the VM and nulls the routing
    // columns but leaves config.infrastructure behind. purge-expired used to
    // re-resolve that stale handle and SSH the (possibly decommissioned) host
    // every night — purge_instance_failed on two fixturenodea cold_archived rows,
    // 2026-07 — and a recycled VMID could even belong to another tenant.
    process.env.CRON_SECRET = "expected-secret";
    const staleInfra = {
      provider: "proxmox" as const,
      node: "fixturenode7",
      vmid: 705,
      privateIpv4: "10.250.20.55",
      gatewayHost: "stale.hermesos.cloud",
    };
    mockedResolveProxmoxLifecycleTarget.mockReturnValue(staleInfra);
    mockedIsProxmoxBackedInstanceRow.mockReturnValue(true);

    const handoffEqLifecycle = jest.fn().mockResolvedValue({ error: null });
    const handoffEqId = jest.fn().mockReturnValue({ eq: handoffEqLifecycle });
    const updateMock = jest.fn().mockReturnValue({ eq: handoffEqId });
    mockedSupabaseAdmin.from
      .mockImplementationOnce(() =>
        scheduledFetch([
          {
            id: "tincho",
            user_id: "user_cold",
            name: "Hermes-Tincho",
            hetzner_server_id: null,
            host_id: null,
            proxmox_vmid: null,
            status: "scheduled_for_deletion",
            lifecycle_state: "cold_archived",
            scheduled_deletion_at: "2026-07-02T09:00:51.565Z",
            config: { infrastructure: { provider: "proxmox", vmid: 705 } },
          },
        ])
      )
      .mockImplementationOnce(() => strandedDeletedFetch([]))
      .mockImplementation((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return { update: updateMock };
      });

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purged).toBe(1);
    // NEVER touch a provider for a cold-archived row — the VM is already gone.
    expect(mockedDeleteProxmoxInstance).not.toHaveBeenCalled();
    expect(mockedDeleteServer).not.toHaveBeenCalled();
    // Handoff, not deletion: pending_deletion so cold-retention-sweep's
    // purgeArchive owns the tarball + final deleted transition. The row must
    // NOT be marked deleted here (that strands the archive/restore path).
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "stopped",
        lifecycle_state: "pending_deletion",
      })
    );
    expect(updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted" })
    );
    expect(handoffEqId).toHaveBeenCalledWith("id", "tincho");
    expect(handoffEqLifecycle).toHaveBeenCalledWith("lifecycle_state", "cold_archived");
  });

  it("refuses to purge a stranded-deleted instance whose owner still has an active subscription", async () => {
    process.env.CRON_SECRET = "expected-secret";
    mockedSupabaseAdmin.from
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
        return scheduledFetch([]); // no scheduled deletions
      })
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
        // zombie: marked deleted but still has a live Hetzner server
        return strandedDeletedFetch([
          {
            id: "zombie-1",
            user_id: "user_paying",
            name: "PayingCustomer",
            hetzner_server_id: 999,
            host_id: null,
            status: "deleted",
            lifecycle_state: "running",
            proxmox_vmid: null,
          },
        ]);
      })
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_subscriptions") throw new Error(`Unexpected table ${table}`);
        return subsFetch([{ user_id: "user_paying", status: "active" }]);
      })
      .mockImplementation((table: string) => {
        throw new Error(`Unexpected extra table access: ${table}`);
      });

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // The paying customer's server must NOT be destroyed.
    expect(mockedDeleteServer).not.toHaveBeenCalled();
    expect(mockedDeleteProxmoxInstance).not.toHaveBeenCalled();
    // And an ops event must flag the lifecycle/billing mismatch.
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "instance.purge_blocked_active_sub" }),
    );
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "zombie-1",
          success: false,
          error: "skipped: owner has active subscription",
        }),
      ]),
    );
  });

  it("writes a deletion archive row and an ops_events audit row before destroying", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const proxmoxInfra = {
      provider: "proxmox" as const,
      vmid: 207,
      privateIpv4: "10.250.20.57",
      gatewayHost: "abc.example.com",
    };
    mockedResolveProxmoxLifecycleTarget.mockReturnValue(proxmoxInfra);
    mockedIsProxmoxBackedInstanceRow.mockReturnValue(true);
    mockedDeleteProxmoxInstance.mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    const archiveInsert = jest.fn().mockResolvedValue({ error: null });
    const { updateMock, updateEq } = makeUpdate();
    mockedSupabaseAdmin.from
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return scheduledFetch([
          {
            id: "audit-target",
            user_id: "user_audit",
            name: "AuditAgent",
            hetzner_server_id: null,
            host_id: null,
            config: { infrastructure: { provider: "proxmox", vmid: 207 } },
            status: "scheduled_for_deletion",
            lifecycle_state: "suspended",
            entitlement_state: "grace",
            proxmox_node: "fixturenode3",
            proxmox_vmid: 207,
            gateway_url: "https://abc.example.com",
            subdomain: "abc",
            ipv4_address: "10.250.20.57",
            resource_tier: "free",
            cpu_limit: 1,
            ram_limit: 1024,
            disk_size_gb: 30,
            scheduled_deletion_at: "2026-04-22T00:00:00Z",
          },
        ]);
      })
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return strandedDeletedFetch([]);
      })
      .mockImplementation((table: string) => {
        if (table === "instance_deletion_archives") {
          return { insert: archiveInsert };
        }
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return { update: updateMock };
      });

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purged).toBe(1);

    // Archive write happens BEFORE destroy.
    expect(archiveInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        original_instance_id: "audit-target",
        user_id: "user_audit",
        deletion_reason: expect.any(String),
        archive: expect.objectContaining({
          name: "AuditAgent",
          proxmox_vmid: 207,
          config: expect.any(Object),
        }),
        expires_at: expect.any(String),
      }),
    );

    // ops_events audit row for the actual destroy.
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance.purge_destroyed",
        instanceId: "audit-target",
        userId: "user_audit",
        metadata: expect.objectContaining({
          proxmox_vmid: 207,
          deletion_reason: expect.any(String),
        }),
      }),
    );
  });

  it("reaps Proxmox rows already marked deleted but still carrying a live VMID", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const proxmoxInfra = {
      provider: "proxmox" as const,
      vmid: 202,
      privateIpv4: "10.250.20.52",
      gatewayHost: "stranded.example.com",
    };
    mockedResolveProxmoxLifecycleTarget.mockReturnValue(proxmoxInfra);
    mockedIsProxmoxBackedInstanceRow.mockReturnValue(true);
    mockedDeleteProxmoxInstance.mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    const { updateMock, updateEq } = makeUpdate();
    mockedSupabaseAdmin.from
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return scheduledFetch([]);
      })
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return strandedDeletedFetch([
          {
            id: "stranded-proxmox",
            user_id: "user_old",
            name: "Old deleted VM",
            hetzner_server_id: null,
            host_id: null,
            config: { infrastructure: { provider: "proxmox", vmid: 202 } },
          },
        ]);
      })
      .mockImplementation((table: string) => {
        if (table === "instance_deletion_archives") {
          // The purge cron writes a snapshot row before destroy. The test
          // mock just acks; per-test assertions live where they matter.
          return { insert: jest.fn().mockResolvedValue({ error: null }) };
        }
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return {
          update: updateMock,
        };
      });

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purged).toBe(1);
    expect(mockedDeleteProxmoxInstance).toHaveBeenCalledWith(proxmoxInfra, {
      hostConfig: null,
      expectedInstanceId: "stranded-proxmox",
    });
    expect(updateEq).toHaveBeenCalledWith("id", "stranded-proxmox");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
        scheduled_deletion_at: null,
      })
    );
  });

  it("leaves a shared-host server alone — only the Supabase row gets soft-deleted", async () => {
    process.env.CRON_SECRET = "expected-secret";

    const { updateMock, updateEq } = makeUpdate();
    mockedSupabaseAdmin.from
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return scheduledFetch([
          {
            id: "shared-tenant",
            user_id: "user_gone",
            name: "Tenant on shared host",
            hetzner_server_id: 999,
            host_id: "host-abc",
            config: null,
          },
        ]);
      })
      .mockImplementationOnce((table: string) => {
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return strandedDeletedFetch([]);
      })
      .mockImplementation((table: string) => {
        if (table === "instance_deletion_archives") {
          // The purge cron writes a snapshot row before destroy. The test
          // mock just acks; per-test assertions live where they matter.
          return { insert: jest.fn().mockResolvedValue({ error: null }) };
        }
        if (table !== "hermes_instances") {
          throw new Error(`Unexpected table ${table}`);
        }
        return {
          update: updateMock,
        };
      });

    const response = await GET(
      new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purged).toBe(1);
    // The shared host stays up — pulling deleteServer here would knock other
    // tenants off the same Hetzner box. The orphan sweep already filtered for
    // sole-tenant before getting here.
    expect(mockedDeleteServer).not.toHaveBeenCalled();
    expect(mockedDeleteProxmoxInstance).not.toHaveBeenCalled();
    expect(updateEq).toHaveBeenCalledWith("id", "shared-tenant");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
        scheduled_deletion_at: null,
        deleted_at: expect.any(String),
        last_lifecycle_transition_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
  });

  describe("owner must be a platform account", () => {
    // Pre-launch review H5: a row written with a Supabase Auth JWT carries the
    // JWT's `sub` (a UUID) as user_id, never a Clerk user id. Such a row did
    // not come from any application path, so the purge must not act on the
    // server or VM it names.
    const FOREIGN_OWNER = "00000000-0000-4000-8000-0000000000a1";
    const originalAuthMode = process.env.HIVRA_AUTH_MODE;

    afterEach(() => {
      if (originalAuthMode === undefined) delete process.env.HIVRA_AUTH_MODE;
      else process.env.HIVRA_AUTH_MODE = originalAuthMode;
    });

    function cronRequest() {
      return new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      });
    }

    it("refuses to destroy the Hetzner server named by a scheduled row whose owner is not a platform account", async () => {
      process.env.CRON_SECRET = "expected-secret";
      // The archive insert and mark-deleted update would succeed, so the only
      // thing between this row and deleteServer(4242) is the owner check.
      const archiveInsert = jest.fn().mockResolvedValue({ error: null });
      const updateMock = jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      });
      mockedSupabaseAdmin.from
        .mockImplementationOnce(() =>
          scheduledFetch([
            {
              id: "forged-1",
              user_id: FOREIGN_OWNER,
              name: "Forged",
              hetzner_server_id: 4242,
              host_id: null,
              status: "scheduled_for_deletion",
              lifecycle_state: "running",
              config: null,
            },
          ])
        )
        .mockImplementationOnce(() => strandedDeletedFetch([]))
        .mockImplementation((table: string) => {
          if (table === "instance_deletion_archives") return { insert: archiveInsert };
          if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
          return { update: updateMock };
        });

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockedDeleteServer).not.toHaveBeenCalled();
      expect(mockedDeleteProxmoxInstance).not.toHaveBeenCalled();
      // No archive row, no mark-deleted write: the row is left for a human.
      expect(archiveInsert).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(body.data.purged).toBe(0);
      expect(body.data.results).toEqual([
        {
          id: "forged-1",
          name: "Forged",
          success: false,
          error: "skipped: owner is not a known account",
        },
      ]);
      expect(reportOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "instance.purge_blocked_unknown_owner",
          severity: "error",
          instanceId: "forged-1",
          metadata: expect.objectContaining({
            owner_user_id: FOREIGN_OWNER,
            hetzner_server_id: 4242,
          }),
        })
      );
    });

    it("refuses to reap a stranded-deleted Proxmox row whose owner is not a platform account", async () => {
      process.env.CRON_SECRET = "expected-secret";
      mockedResolveProxmoxLifecycleTarget.mockReturnValue({
        provider: "proxmox" as const,
        vmid: 311,
        privateIpv4: "10.250.20.61",
        gatewayHost: "forged.example.com",
      });
      mockedIsProxmoxBackedInstanceRow.mockReturnValue(true);
      mockedDeleteProxmoxInstance.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
      const archiveInsert = jest.fn().mockResolvedValue({ error: null });
      const updateMock = jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      });
      mockedSupabaseAdmin.from
        .mockImplementationOnce(() => scheduledFetch([]))
        .mockImplementationOnce(() =>
          strandedDeletedFetch([
            {
              id: "forged-2",
              user_id: FOREIGN_OWNER,
              name: "Forged zombie",
              hetzner_server_id: null,
              host_id: null,
              status: "deleted",
              lifecycle_state: "running",
              proxmox_vmid: 311,
              config: { infrastructure: { provider: "proxmox", vmid: 311 } },
            },
          ])
        )
        .mockImplementationOnce((table: string) => {
          if (table !== "hermes_subscriptions") throw new Error(`Unexpected table ${table}`);
          return subsFetch([]);
        })
        .mockImplementation((table: string) => {
          if (table === "instance_deletion_archives") return { insert: archiveInsert };
          if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
          return { update: updateMock };
        });

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockedDeleteProxmoxInstance).not.toHaveBeenCalled();
      expect(mockedDeleteServer).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(body.data.results).toEqual([
        expect.objectContaining({
          id: "forged-2",
          success: false,
          error: "skipped: owner is not a known account",
        }),
      ]);
    });

    it("still purges the self-host operator's rows in local auth mode", async () => {
      process.env.CRON_SECRET = "expected-secret";
      process.env.HIVRA_AUTH_MODE = "local";
      const { updateMock, updateEq } = makeUpdate();
      mockedSupabaseAdmin.from
        .mockImplementationOnce(() =>
          scheduledFetch([
            {
              id: "local-1",
              user_id: "hivra-local-operator",
              name: "Local",
              hetzner_server_id: 55,
              host_id: null,
              status: "scheduled_for_deletion",
              config: null,
            },
          ])
        )
        .mockImplementationOnce(() => strandedDeletedFetch([]))
        .mockImplementation((table: string) => {
          if (table === "instance_deletion_archives") {
            return { insert: jest.fn().mockResolvedValue({ error: null }) };
          }
          if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
          return { update: updateMock };
        });

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockedDeleteServer).toHaveBeenCalledWith(55);
      expect(body.data.purged).toBe(1);
      expect(updateEq).toHaveBeenCalledWith("id", "local-1");
    });
  });

  describe("proxmox teardown proof and claim before destroy", () => {
    const mockedRecover = locateProxmoxInstanceAcrossFleet as jest.MockedFunction<
      typeof locateProxmoxInstanceAcrossFleet
    >;
    const proxmoxInfra = {
      provider: "proxmox" as const,
      vmid: 203,
      privateIpv4: "10.250.20.55",
      gatewayHost: "agent-miss.example.com",
    };
    const proxmoxRow = {
      id: "inst-miss",
      user_id: "user_miss",
      name: "Miss",
      hetzner_server_id: null,
      host_id: null,
      config: { infrastructure: { provider: "proxmox", vmid: 203 } },
      status: "scheduled_for_deletion",
      lifecycle_state: "suspended",
      proxmox_node: "fixturenode3",
      proxmox_vmid: 203,
      scheduled_deletion_at: "2026-04-22T00:00:00Z",
    };

    beforeEach(() => {
      process.env.CRON_SECRET = "expected-secret";
      mockedDeleteProxmoxInstance.mockReset();
      mockedRecover.mockReset();
      mockedDeleteServer.mockReset();
      mockedDeleteServer.mockResolvedValue(undefined);
    });

    // Routes the staged row through the Proxmox teardown branch.
    function useProxmoxTeardown() {
      mockedResolveProxmoxLifecycleTarget.mockReturnValue(proxmoxInfra);
      mockedIsProxmoxBackedInstanceRow.mockReturnValue(true);
    }

    // Routes the staged row through the Hetzner teardown branch.
    function useHetznerTeardown() {
      mockedResolveProxmoxLifecycleTarget.mockReturnValue(null);
      mockedIsProxmoxBackedInstanceRow.mockReturnValue(false);
    }

    function stageRows(rows: unknown[], update: ReturnType<typeof makeUpdate>) {
      mockedSupabaseAdmin.from
        .mockImplementationOnce(() => scheduledFetch(rows))
        .mockImplementationOnce(() => strandedDeletedFetch([]))
        .mockImplementation((table: string) => {
          if (table === "instance_deletion_archives") {
            return { insert: jest.fn().mockResolvedValue({ error: null }) };
          }
          if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
          return { update: update.updateMock };
        });
    }

    function cronRequest() {
      return new NextRequest("http://localhost/api/cron/purge-expired", {
        method: "GET",
        headers: { authorization: "Bearer expected-secret" },
      });
    }

    it("keeps the row when the routed host reports the VM missing and the fleet cannot prove it gone", async () => {
      // The host script exits 0 when the VMID is not on the routed host. That
      // is one host's answer, not proof of teardown: the row must stay put.
      mockedDeleteProxmoxInstance.mockResolvedValue({
        ok: true,
        stdout: "HERMES_PROXMOX_DELETE_VM_MISSING 203\n",
        stderr: "",
      });
      useProxmoxTeardown();
      mockedRecover.mockResolvedValue({ status: "inconclusive" });
      const update = makeUpdate();
      stageRows([proxmoxRow], update);

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockedRecover).toHaveBeenCalledWith(expect.objectContaining({ id: "inst-miss" }));
      expect(body.data.purged).toBe(0);
      expect(body.data.results).toEqual([
        { id: "inst-miss", name: "Miss", success: false, error: "Failed to purge instance" },
      ]);
      // Never marked deleted: the claim (deleted_at only) is released so the
      // row is retried exactly as it was, and a payment can restore it.
      expect(update.updateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ lifecycle_state: "deleted" }),
      );
      expect(update.updateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: expect.anything() }),
      );
      expect(update.updateMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ deleted_at: expect.any(String) }),
      );
      expect(update.updateMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ deleted_at: null }),
      );
      expect(reportOpsEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: "instance.purge_destroyed" }),
      );
    });

    it("does not destroy a scheduled row when the owner's entitlement cannot be read", async () => {
      useProxmoxTeardown();
      const update = makeUpdate();
      stageRows([proxmoxRow], update);
      (resolveEffectiveSubscription as jest.Mock).mockRejectedValueOnce(new Error("db down"));
      const restore = StripeWebhookService.restoreScheduledDeletions as jest.Mock;
      restore.mockClear();

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(body.data.purged).toBe(0);
      expect(mockedDeleteProxmoxInstance).not.toHaveBeenCalled();
      expect(update.updateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ deleted_at: null }));
      expect(restore).not.toHaveBeenCalled();
    });

    it("does not destroy a scheduled row whose owner is entitled now; hands it back to restore and resume", async () => {
      useProxmoxTeardown();
      const update = makeUpdate();
      stageRows([proxmoxRow], update);
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValueOnce({ plan: "pro", status: "active" });
      const restore = StripeWebhookService.restoreScheduledDeletions as jest.Mock;

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(body.data.purged).toBe(0);
      expect(mockedDeleteProxmoxInstance).not.toHaveBeenCalled();
      expect(update.updateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ deleted_at: null }));
      expect(restore).toHaveBeenCalledWith("user_miss");
      expect(StripeWebhookService.resumeBillingSuspendedInstances).toHaveBeenCalledWith("user_miss");
    });

    it("keeps the row when the fleet search found the VM on another host (row untouched, retry later)", async () => {
      mockedDeleteProxmoxInstance.mockResolvedValue({
        ok: true,
        stdout: "HERMES_PROXMOX_DELETE_VM_MISSING 203\n",
        stderr: "",
      });
      useProxmoxTeardown();
      mockedRecover.mockResolvedValue({
        status: "found",
        found: {} as never,
      });
      const update = makeUpdate();
      stageRows([proxmoxRow], update);

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(body.data.purged).toBe(0);
      expect(update.updateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ lifecycle_state: "deleted" }),
      );
    });

    it("marks the row deleted once every known host reports the VM absent", async () => {
      mockedDeleteProxmoxInstance.mockResolvedValue({
        ok: true,
        stdout: "HERMES_PROXMOX_DELETE_VM_MISSING 203\n",
        stderr: "",
      });
      useProxmoxTeardown();
      mockedRecover.mockResolvedValue({ status: "gone" });
      const update = makeUpdate();
      stageRows([proxmoxRow], update);

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(body.data.purged).toBe(1);
      expect(update.updateEq).toHaveBeenCalledWith("id", "inst-miss");
      expect(update.updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: "deleted", lifecycle_state: "deleted" }),
      );
    });

    it("claims the selected row on its status, lifecycle and due time before destroying it", async () => {
      useHetznerTeardown();
      const update = makeUpdate();
      stageRows(
        [
          {
            id: "claim-1",
            user_id: "user_claim",
            name: "Claim",
            hetzner_server_id: 88,
            host_id: null,
            config: null,
            status: "scheduled_for_deletion",
            lifecycle_state: "suspended",
            scheduled_deletion_at: "2026-04-22T00:00:00Z",
          },
        ],
        update,
      );

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(body.data.purged).toBe(1);
      expect(update.updateEq).toHaveBeenCalledWith("id", "claim-1");
      expect(update.updateEq).toHaveBeenCalledWith("status", "scheduled_for_deletion");
      expect(update.updateEq).toHaveBeenCalledWith("lifecycle_state", "suspended");
      expect(update.updateLte).toHaveBeenCalledWith("scheduled_deletion_at", expect.any(String));
      // The claim is taken before the Hetzner server is destroyed.
      const claimOrder = update.updateMock.mock.invocationCallOrder[0];
      const destroyOrder = mockedDeleteServer.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(destroyOrder);
    });

    it("skips a row a payment restored after the candidate read (claim matches nothing)", async () => {
      useHetznerTeardown();
      const update = makeUpdate({ claimed: false });
      stageRows(
        [
          {
            id: "restored-1",
            user_id: "user_back",
            name: "Restored",
            hetzner_server_id: 88,
            host_id: null,
            config: null,
            status: "scheduled_for_deletion",
            lifecycle_state: "suspended",
            scheduled_deletion_at: "2026-04-22T00:00:00Z",
          },
        ],
        update,
      );

      const response = await GET(cronRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockedDeleteServer).not.toHaveBeenCalled();
      expect(update.updateMock).toHaveBeenCalledTimes(1);
      expect(body.data.purged).toBe(0);
      expect(body.data.results).toEqual([
        {
          id: "restored-1",
          name: "Restored",
          success: false,
          error: "skipped: instance changed after selection",
        },
      ]);
    });
  });
});
