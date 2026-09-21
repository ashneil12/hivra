import { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";

import { POST } from "../route";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import {
  deleteProxmoxInstance,
  getProxmoxInstanceStatus,
  provisionProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
  encryptApiKey: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  deleteProxmoxInstance: jest.fn(),
  getProxmoxInstanceStatus: jest.fn(),
  provisionProxmoxInstance: jest.fn(),
}));

jest.mock("@/lib/services/instance-orchestrator", () => ({
  getHonchoSettingsFromInstance: jest.fn(() => ({ enabled: false })),
}));

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  recoverProxmoxInstanceAcrossFleet: jest.fn(),
}));

const baseInstance = {
  id: "inst_504",
  user_id: "user_123",
  name: "Hermes",
  provider: "openai",
  backend: "webui",
  subdomain: "agent-504",
  api_key_encrypted: "encrypted-provider",
  api_server_key_encrypted: "old-api-server",
  honcho_api_key_encrypted: null,
  status: "running",
  lifecycle_state: "active",
  cpu_limit: 1,
  ram_limit: 1024,
  resource_tier: "credit_base",
  infrastructure_provider: "proxmox",
  host_id: null,
  proxmox_node: "fixturenode5",
  proxmox_vmid: 504,
  proxmox_template_vmid: 9005,
  ipv4_address: "10.250.22.54",
  gateway_url: "https://agent-504.hermesos.cloud",
  updated_at: "2026-08-26T12:00:00.000Z",
  // Widened so individual cases can layer on config keys (e.g. `unconfigured`)
  // without fighting the inferred literal shape.
  config: {
    model: "gpt-test",
    infrastructure: {
      provider: "proxmox",
      node: "fixturenode5",
      hostSlug: "fixturenode5",
      hostEnvPrefix: "PROXMOX_FIXTURENODE5_",
      vmid: 504,
      privateIpv4: "10.250.22.54",
      gatewayHost: "agent-504.hermesos.cloud",
      templateVmid: 9005,
    },
  } as Record<string, unknown>,
};

function makeRequest(secret = "expected-secret") {
  return new NextRequest(
    "http://localhost/api/cron/recreate-missing-proxmox-instance?id=inst_504",
    {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    },
  );
}

function stubSupabase(instance: Record<string, unknown> = baseInstance) {
  const claimUpdate = {
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: baseInstance.id }, error: null }),
  };
  const finalUpdate = { update: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ error: null }) };
  const fetchQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: instance, error: null }),
  };

  let call = 0;
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
    call += 1;
    if (call === 1) return fetchQuery;
    if (call === 2) return claimUpdate;
    return finalUpdate;
  });

  return { fetchQuery, claimUpdate, finalUpdate };
}

describe("POST /api/cron/recreate-missing-proxmox-instance", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({ status: "gone" });
    process.env = { ...originalEnv, CRON_SECRET: "expected-secret" };
    (decryptApiKey as jest.Mock).mockReturnValue("provider-secret");
    (encryptApiKey as jest.Mock).mockReturnValue("encrypted-new-api-server");
    (clerkClient as jest.Mock).mockResolvedValue({
      users: { getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }) },
    });
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({
      status: "stopped",
      vmMissing: true,
    });
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 504,
      templateId: 9005,
      ipv4: "10.250.22.54",
      apiServerKey: "new-api-server",
      gatewayUrl: "https://agent-504.hermesos.cloud",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox",
        node: "fixturenode5",
        hostSlug: "fixturenode5",
        hostEnvPrefix: "PROXMOX_FIXTURENODE5_",
        vmid: 504,
        privateIpv4: "10.250.22.54",
        gatewayHost: "agent-504.hermesos.cloud",
        templateVmid: 9005,
      },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects requests with the wrong bearer", async () => {
    const res = await POST(makeRequest("wrong-secret"));

    expect(res.status).toBe(401);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("refuses to recreate when Proxmox says the VM still exists", async () => {
    stubSupabase();
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("runs a fresh fleet scan even when a prior release marker exists", async () => {
    stubSupabase({
      ...baseInstance,
      status: "error",
      lifecycle_state: "failed",
      proxmox_node: null,
      proxmox_vmid: null,
      ipv4_address: null,
      gateway_url: null,
      config: {
        model: "gpt-test",
        infrastructureReleased: {
          at: "2026-08-26T12:00:00.000Z",
          reason: "vm_missing_across_fleet",
        },
      },
    });
    (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({
      status: "recovered",
      found: { hostSlug: "fixturenode13", vmid: 1302 },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(recoverProxmoxInstanceAcrossFleet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inst_504" }),
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("does not provision when another recreate wins the atomic claim", async () => {
    const { claimUpdate } = stubSupabase();
    claimUpdate.maybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
    expect(claimUpdate.eq).toHaveBeenCalledWith("updated_at", baseInstance.updated_at);
  });

  it("recreates a confirmed-missing Proxmox VM and persists fresh metadata", async () => {
    const { claimUpdate, finalUpdate } = stubSupabase();

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(getProxmoxInstanceStatus).toHaveBeenCalledWith(
      expect.objectContaining({ vmid: 504, node: "fixturenode5" }),
      { hostConfig: expect.objectContaining({ hostSlug: "fixturenode5", envPrefix: "PROXMOX_FIXTURENODE5_" }) },
    );
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        instanceId: "inst_504",
        apiKey: "provider-secret",
        backend: "webui",
        subdomain: "agent-504",
      }),
      { hostConfig: expect.objectContaining({ hostSlug: "fixturenode5", envPrefix: "PROXMOX_FIXTURENODE5_" }) },
    );
    expect(claimUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "provisioning",
        lifecycle_state: "provisioning",
        proxmox_vmid: null,
      }),
    );
    expect(finalUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "provisioning",
        lifecycle_state: "provisioning",
        gateway_url: "https://agent-504.hermesos.cloud",
        api_server_key_encrypted: "encrypted-new-api-server",
        ipv4_address: "10.250.22.54",
        proxmox_node: "fixturenode5",
        proxmox_vmid: 504,
      }),
    );
    const finalPayload = finalUpdate.update.mock.calls[0][0];
    expect(finalPayload.config.infrastructure.vmid).toBe(504);
    expect(finalPayload.config.infrastructureReleased).toBeUndefined();
  });

  it("keeps a clean-slate box clean-slate when recreating its missing VM", async () => {
    // A clean-slate (deploy-card Managed=OFF) row still carries a benign
    // provider default and a real config.model — instance-service seeds both
    // at create — and its api_key_encrypted is the ciphertext of "". So it
    // sails through every upstream filter on the every-10-minute
    // recover-missing-vm sweep. Without threading config.unconfigured, the
    // rebuilt box gets provider+model written into its compose env and
    // config.yaml, the agent's _has_any_provider_configured() flips to true,
    // its native onboarding overlay never fires, and the box boots with a
    // keyless provider — dead on the first message. instance-orchestrator
    // honours this contract on redeploy; recreate must too.
    stubSupabase({
      ...baseInstance,
      config: { ...baseInstance.config, unconfigured: true },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ unconfigured: true }),
      expect.anything(),
    );
  });

  it("does not mark a normally-configured box as clean-slate on recreate", async () => {
    stubSupabase();

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ unconfigured: false }),
      expect.anything(),
    );
  });

  it("destroys the freshly cloned VM if the final metadata UPDATE fails (no orphan)", async () => {
    // Regression for the 2026-05-18 fixturenodea incident where three duplicate
    // VMs accumulated for the same paused tenant because each cron
    // iteration cloned a new VM, then failed to write the new vmid
    // back to the DB, then markFailed reset the row — leaving the new
    // VM running on the host as an orphan with no DB pointer.
    const fetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: baseInstance, error: null }),
    };
    const claimUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: baseInstance.id }, error: null }),
    };
    // Final persist returns a NON-duplicate error (e.g. transient db
    // hiccup). The duplicate-conflict recovery path is exercised in
    // the next test; here we want the rollback path.
    const finalUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        error: { message: "connection terminated unexpectedly", code: "57P01" },
      }),
    };
    const markFailedUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    let call = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      call += 1;
      if (call === 1) return fetchQuery;
      if (call === 2) return claimUpdate;
      if (call === 3) return finalUpdate;
      return markFailedUpdate;
    });

    // Provision returns a brand-new vmid (NOT the original 504) — this
    // is the actual production shape that caused the ghost VMs.
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 744,
      templateId: 9005,
      ipv4: "10.250.22.94",
      apiServerKey: "new-api-server",
      gatewayUrl: "https://agent-504.hermesos.cloud",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox",
        node: "fixturenode5",
        hostSlug: "fixturenode5",
        hostEnvPrefix: "PROXMOX_FIXTURENODE5_",
        vmid: 744,
        privateIpv4: "10.250.22.94",
        gatewayHost: "agent-504.hermesos.cloud",
        templateVmid: 9005,
      },
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    // The freshly cloned VM MUST be torn down so it doesn't leak.
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "proxmox", node: "fixturenode5", vmid: 744 }),
      expect.objectContaining({ hostConfig: expect.any(Object) }),
    );
    // And the row should still be marked failed afterwards (so the user
    // can re-trigger or be re-recovered).
    expect(markFailedUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", lifecycle_state: "failed", proxmox_vmid: null }),
    );
  });

  it("clears stale stopped VMID metadata conflicts and retries the final persist", async () => {
    const duplicateError = {
      code: "23505",
      message: "duplicate key value violates unique constraint hermes_instances_proxmox_node_vmid_key",
      details: "Key (proxmox_node, proxmox_vmid)=(fixturenode5, 504) already exists.",
    };
    const fetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: baseInstance, error: null }),
    };
    const claimUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: baseInstance.id }, error: null }),
    };
    const firstFinalUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: duplicateError }),
    };
    const conflictLookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          {
            id: "stale-paused-row",
            status: "stopped",
            lifecycle_state: "paused",
            proxmox_node: "fixturenode5",
            proxmox_vmid: 504,
            config: {
              infrastructure: {
                provider: "proxmox",
                vmid: 504,
              },
            },
          },
        ],
        error: null,
      }),
    };
    const clearStale = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn(),
    };
    clearStale.eq
      .mockReturnValueOnce(clearStale)
      .mockReturnValueOnce(clearStale)
      .mockResolvedValueOnce({ error: null });
    const retryFinalUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    let call = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      call += 1;
      if (call === 1) return fetchQuery;
      if (call === 2) return claimUpdate;
      if (call === 3) return firstFinalUpdate;
      if (call === 4) return conflictLookup;
      if (call === 5) return clearStale;
      return retryFinalUpdate;
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(conflictLookup.eq).toHaveBeenCalledWith("proxmox_node", "fixturenode5");
    expect(conflictLookup.eq).toHaveBeenCalledWith("proxmox_vmid", 504);
    expect(conflictLookup.neq).toHaveBeenCalledWith("id", "inst_504");
    expect(clearStale.update).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway_url: null,
        ipv4_address: null,
        proxmox_node: null,
        proxmox_vmid: null,
        proxmox_template_vmid: null,
        config: expect.objectContaining({
          infrastructureReleased: expect.objectContaining({
            reason: "post_provision_stale_conflict",
          }),
        }),
      }),
    );
    expect(retryFinalUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway_url: "https://agent-504.hermesos.cloud",
        api_server_key_encrypted: "encrypted-new-api-server",
        ipv4_address: "10.250.22.54",
        proxmox_node: "fixturenode5",
        proxmox_vmid: 504,
      }),
    );
  });
});
