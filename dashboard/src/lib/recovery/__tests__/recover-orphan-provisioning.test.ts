import {
  loadKnownProxmoxHostSlugs,
  recoverProxmoxInstanceAcrossFleet,
  runRecoverOrphanProvisioningSweep,
} from "../recover-orphan-provisioning";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { encryptApiKey } from "@/lib/crypto";
import { log } from "@/lib/logger";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/services/cloudflare-dns", () => ({
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  encryptApiKey: jest.fn((plain: string) => `enc(${plain})`),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

// Post-ready SOUL.md seed hook — fired per adopted row; the sweep only relies
// on its never-throws contract, so stub it out.
jest.mock("@/lib/recovery/soul-seed-reconcile", () => ({
  reconcileSoulSeedAfterReady: jest.fn().mockResolvedValue(null),
}));

import { reconcileSoulSeedAfterReady } from "@/lib/recovery/soul-seed-reconcile";

const mockedSoulSeedAfterReady = reconcileSoulSeedAfterReady as jest.Mock;
const ORIGINAL_ENV = process.env;

const ORPHAN_INSTANCE_ID = "00000000-0000-4000-8000-000000001045";
const ORPHAN_PREFIX = ORPHAN_INSTANCE_ID.slice(0, 8);

function buildOrphanRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ORPHAN_INSTANCE_ID,
    user_id: "user_42",
    status: "provisioning",
    lifecycle_state: "provisioning",
    proxmox_node: null,
    proxmox_vmid: null,
    ipv4_address: null,
    gateway_url: null,
    api_server_key_encrypted: null,
    config: null,
    updated_at: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

function buildDiscoveryStdout(opts: {
  vmid: number;
  privip: string;
  fqdn: string;
  bearer: string;
  vmStatus?: "running" | "stopped";
}): string {
  return [
    "RESULT OK",
    `VMID=${opts.vmid}`,
    `VMSTATUS=${opts.vmStatus ?? "running"}`,
    `PRIVIP=${opts.privip}`,
    `FQDN=${opts.fqdn}`,
    `BEARER=${opts.bearer}`,
  ].join("\n");
}

describe("loadKnownProxmoxHostSlugs", () => {
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      HERMES_PROXMOX_TARGETS: "fixturenode1,fixturenode6,fixturenode7,fixturenode9,fixturenode10,fixturenode21",
    };
  });
  afterEach(() => jest.clearAllMocks());

  it("returns slugs from the proxmox_hosts registry", async () => {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        data: [{ id: "fixturenode7" }, { id: "fixturenode8" }, { id: "fixturenode9" }],
        error: null,
      }),
    });
    await expect(loadKnownProxmoxHostSlugs()).resolves.toEqual(["fixturenode7", "fixturenode8", "fixturenode9"]);
  });

  it("falls back only to explicitly configured hosts when the registry errors", async () => {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
    });
    const slugs = await loadKnownProxmoxHostSlugs();
    expect(slugs).toEqual(["fixturenode1", "fixturenode6", "fixturenode7", "fixturenode9", "fixturenode10", "fixturenode21"]);
  });

  it("falls back when the registry returns an empty list", async () => {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockResolvedValue({ data: [], error: null }),
    });
    const slugs = await loadKnownProxmoxHostSlugs();
    expect(slugs).toEqual(["fixturenode1", "fixturenode6", "fixturenode7", "fixturenode9", "fixturenode10", "fixturenode21"]);
  });

  it("discovers an explicitly configured per-host SSH identity without inventing fleet members", async () => {
    delete process.env.HERMES_PROXMOX_TARGETS;
    process.env.PROXMOX_HOST_EDGE_1_SSH_HOST = "192.0.2.18";
    mockedFrom.mockReturnValue({
      select: jest.fn().mockResolvedValue({ data: [], error: null }),
    });
    await expect(loadKnownProxmoxHostSlugs()).resolves.toEqual(["edge_1"]);
  });
});

describe("runRecoverOrphanProvisioningSweep", () => {
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;
  const mockedResolveEnv = resolveProxmoxHostEnv as jest.MockedFunction<typeof resolveProxmoxHostEnv>;
  const mockedEncrypt = encryptApiKey as jest.MockedFunction<typeof encryptApiKey>;
  let updateCallback: jest.Mock;
  let updateResultCallback: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, HERMES_PROXMOX_TARGETS: "fixturenode1,fixturenode2" };
    mockedResolveEnv.mockReturnValue({});

    updateCallback = jest.fn().mockReturnThis();
    updateResultCallback = jest.fn().mockResolvedValue({
      data: { id: ORPHAN_INSTANCE_ID },
      error: null,
    });
    const candidateQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn(),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      match: updateCallback,
      select: jest.fn().mockReturnThis(),
      maybeSingle: updateResultCallback,
    };

    // Default: one orphan row whose UPDATE never landed.
    candidateQuery.limit.mockResolvedValue({ data: [buildOrphanRow()], error: null });

    let call = 0;
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      call += 1;
      // First call = candidate SELECT, second call = reconcile UPDATE.
      return call === 1 ? candidateQuery : updateQuery;
    });
  });

  it("reconciles an orphan row when a Proxmox host has the matching VM", async () => {
    mockedRunScript.mockImplementation(async (script: string) => {
      // Match by instance-id prefix in the discovery script.
      if (!script.includes(ORPHAN_PREFIX)) {
        return { ok: true, stdout: "RESULT NOT_FOUND", stderr: "" };
      }
      return {
        ok: true,
        stdout: buildDiscoveryStdout({
          vmid: 425,
          privip: "10.250.20.75",
          fqdn: "00000000000000000000.hermesos.cloud",
          bearer: "f".repeat(64),
        }),
        stderr: "",
      };
    });

    const summary = await runRecoverOrphanProvisioningSweep();

    expect(summary.candidates).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(summary.notFound).toBe(0);
    expect(summary.errors).toBe(0);

    // The reconcile UPDATE should stamp every field provisionProxmoxInstance
    // would have written, including the encrypted bearer.
    expect(updateCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ORPHAN_INSTANCE_ID,
        updated_at: "2026-08-26T12:00:00.000Z",
      }),
    );
    expect(mockedEncrypt).toHaveBeenCalledWith("f".repeat(64));
    expect(mockedRunScript.mock.calls.some(([script]) => script.includes("ssh -n -i /etc/hivra/keys/vm-orchestrator"))).toBe(
      true
    );

    // Adoption promotes the row to running — an adopted box booted long ago
    // with the agent's factory-default SOUL.md (the in-band seed never
    // completed; that's why it was an orphan). The sweep must fire the
    // post-ready soul-seed reconcile for the adopted row.
    expect(mockedSoulSeedAfterReady).toHaveBeenCalledTimes(1);
    expect(mockedSoulSeedAfterReady).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: ORPHAN_INSTANCE_ID,
        trigger: "recover_orphan_adopt",
      }),
    );
  });

  it("does not report recovery when a concurrent lifecycle change wins the CAS", async () => {
    updateResultCallback.mockResolvedValue({ data: null, error: null });
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: buildDiscoveryStdout({
        vmid: 425,
        privip: "10.250.20.75",
        fqdn: "race.example",
        bearer: "9".repeat(64),
      }),
      stderr: "",
    });

    const summary = await runRecoverOrphanProvisioningSweep();

    expect(summary).toEqual({ candidates: 1, recovered: 0, notFound: 0, errors: 1 });
    expect(mockedSoulSeedAfterReady).not.toHaveBeenCalled();
  });

  it("syncs api_server_key_encrypted from the live VM even when DB already has one", async () => {
    const candidateQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          // Bearer is already set; only IP/gateway/vmid are missing.
          buildOrphanRow({ api_server_key_encrypted: "preexisting-encrypted-bearer" }),
        ],
        error: null,
      }),
    };
    const updatePayloads: unknown[] = [];
    const updateQuery: {
      update: jest.Mock;
      match: jest.Mock;
      select: jest.Mock;
      maybeSingle: jest.Mock;
    } = {
      update: jest.fn(),
      match: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: ORPHAN_INSTANCE_ID }, error: null }),
    };
    updateQuery.update.mockImplementation((payload: unknown) => {
      updatePayloads.push(payload);
      return updateQuery;
    });
    mockedFrom.mockReset();
    let call = 0;
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      call += 1;
      return call === 1 ? candidateQuery : updateQuery;
    });
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: buildDiscoveryStdout({
        vmid: 425,
        privip: "10.250.20.75",
        fqdn: "kept.example",
        bearer: "0".repeat(64),
      }),
      stderr: "",
    });

    const summary = await runRecoverOrphanProvisioningSweep();
    expect(summary.recovered).toBe(1);
    // The live Caddyfile bearer is the source of truth for partially
    // reconciled rows; a prior failed recreate may have left the old bearer
    // encrypted in the DB.
    expect(mockedEncrypt).toHaveBeenCalledWith("0".repeat(64));
    expect(updatePayloads.length).toBe(1);
    const payload = updatePayloads[0] as Record<string, unknown>;
    expect(payload.api_server_key_encrypted).toBe(`enc(${"0".repeat(64)})`);
    expect(payload.proxmox_vmid).toBe(425);
    expect(payload.ipv4_address).toBe("10.250.20.75");
    expect(payload.gateway_url).toBe("https://kept.example");
  });

  it("recovers routing for a stopped VM using its stored encrypted bearer", async () => {
    const updatePayloads: Array<Record<string, unknown>> = [];
    const updateQuery = {
      update: jest.fn(),
      match: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: ORPHAN_INSTANCE_ID },
        error: null,
      }),
    };
    updateQuery.update.mockImplementation((payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return updateQuery;
    });
    mockedFrom.mockReset();
    mockedFrom.mockImplementation((table: string) => {
      if (table === "proxmox_hosts") {
        return {
          select: jest.fn().mockResolvedValue({ data: [{ id: "fixturenode13" }], error: null }),
        };
      }
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      return updateQuery;
    });
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "RESULT NO_BEARER",
        "VMID=425",
        "VMSTATUS=stopped",
        "PRIVIP=10.250.20.75",
        "FQDN=stopped.example",
      ].join("\n"),
      stderr: "",
    });

    const result = await recoverProxmoxInstanceAcrossFleet(
      buildOrphanRow({
        status: "stopped",
        lifecycle_state: "stopped",
        api_server_key_encrypted: "stored-encrypted-bearer",
      }),
      { allowStopped: true },
    );

    expect(result).toEqual(expect.objectContaining({
      status: "recovered",
      found: expect.objectContaining({ vmStatus: "stopped", vmid: 425 }),
    }));
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toEqual(
      expect.objectContaining({
        proxmox_node: expect.any(String),
        proxmox_vmid: 425,
        ipv4_address: "10.250.20.75",
        gateway_url: "https://stopped.example",
      })
    );
    expect(updatePayloads[0]).not.toHaveProperty("api_server_key_encrypted");
    expect(updatePayloads[0]).not.toHaveProperty("status");
    expect(updatePayloads[0]).not.toHaveProperty("lifecycle_state");
    expect(mockedEncrypt).not.toHaveBeenCalled();
    expect(mockedSoulSeedAfterReady).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", true],
    ["stopped", false],
  ] as const)("does not adopt NO_BEARER with state=%s and allowStopped=%s", async (vmStatus, allowStopped) => {
    mockedFrom.mockReset();
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "proxmox_hosts") throw new Error(`Unexpected table: ${table}`);
      return {
        select: jest.fn().mockResolvedValue({ data: [{ id: "fixturenode13" }], error: null }),
      };
    });
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "RESULT NO_BEARER",
        "VMID=425",
        `VMSTATUS=${vmStatus}`,
        "PRIVIP=10.250.20.75",
        "FQDN=unknown.example",
      ].join("\n"),
      stderr: "",
    });

    const result = await recoverProxmoxInstanceAcrossFleet(
      buildOrphanRow({ api_server_key_encrypted: "stored-encrypted-bearer" }),
      { allowStopped },
    );

    expect(result).toEqual({ status: "inconclusive" });
    expect(mockedEncrypt).not.toHaveBeenCalled();
    expect(mockedSoulSeedAfterReady).not.toHaveBeenCalled();
  });

  it("clears stale stopped Proxmox metadata conflicts and retries reconciliation", async () => {
    const candidateQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          buildOrphanRow({
            status: "running",
            lifecycle_state: "active",
            proxmox_node: "fixturenode5",
            api_server_key_encrypted: "stale-encrypted-bearer",
          }),
        ],
        error: null,
      }),
    };
    const duplicateError = {
      code: "23505",
      message: "duplicate key value violates unique constraint hermes_instances_proxmox_node_vmid_key",
      details: "Key (proxmox_node, proxmox_vmid)=(fixturenode5, 425) already exists.",
    };
    const firstUpdateQuery = {
      update: jest.fn().mockReturnThis(),
      match: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: duplicateError }),
    };
    const conflictLookupQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          {
            id: "stale-paused-instance",
            status: "stopped",
            lifecycle_state: "paused",
            proxmox_node: "fixturenode5",
            proxmox_vmid: 425,
            config: { infrastructure: { provider: "proxmox", vmid: 425 } },
          },
        ],
        error: null,
      }),
    };
    const clearQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn(),
    };
    clearQuery.eq
      .mockReturnValueOnce(clearQuery)
      .mockReturnValueOnce(clearQuery)
      .mockResolvedValueOnce({ error: null });
    const retryUpdateQuery = {
      update: jest.fn().mockReturnThis(),
      match: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: ORPHAN_INSTANCE_ID }, error: null }),
    };

    mockedFrom.mockReset();
    let call = 0;
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      call += 1;
      if (call === 1) return candidateQuery;
      if (call === 2) return firstUpdateQuery;
      if (call === 3) return conflictLookupQuery;
      if (call === 4) return clearQuery;
      return retryUpdateQuery;
    });
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: buildDiscoveryStdout({
        vmid: 425,
        privip: "10.250.20.75",
        fqdn: "recovered.example",
        bearer: "1".repeat(64),
      }),
      stderr: "",
    });

    const summary = await runRecoverOrphanProvisioningSweep();

    expect(summary).toEqual({ candidates: 1, recovered: 1, notFound: 0, errors: 0 });
    expect(conflictLookupQuery.eq).toHaveBeenCalledWith("proxmox_node", "fixturenode5");
    expect(conflictLookupQuery.eq).toHaveBeenCalledWith("proxmox_vmid", 425);
    expect(conflictLookupQuery.neq).toHaveBeenCalledWith("id", ORPHAN_INSTANCE_ID);
    expect(clearQuery.update).toHaveBeenCalledWith(
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
    expect(retryUpdateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        proxmox_node: "fixturenode5",
        proxmox_vmid: 425,
        ipv4_address: "10.250.20.75",
        gateway_url: "https://recovered.example",
        api_server_key_encrypted: `enc(${"1".repeat(64)})`,
      }),
    );
  });

  it("counts notFound when no host reports the VM", async () => {
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND", stderr: "" });

    const summary = await runRecoverOrphanProvisioningSweep();
    expect(summary.candidates).toBe(1);
    expect(summary.notFound).toBe(1);
    expect(summary.recovered).toBe(0);
  });

  it("cleans the dangling DNS record when the VM is conclusively gone on every host", async () => {
    const candidateQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [buildOrphanRow({ subdomain: "agent-gone" })],
        error: null,
      }),
    };
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      return candidateQuery;
    });
    // Every host positively reports NOT_FOUND → the VM (e.g. destroyed by a
    // failed async phase-2's cleanup trap) is provably gone.
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND", stderr: "" });

    const summary = await runRecoverOrphanProvisioningSweep();

    expect(summary.notFound).toBe(1);
    expect(removeInstanceDnsBestEffort).toHaveBeenCalledWith(
      "agent-gone",
      expect.objectContaining({ instanceId: ORPHAN_INSTANCE_ID })
    );
  });

  it("does NOT clean DNS when a host still sees the VM (exists-but-unrecoverable)", async () => {
    const candidateQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [buildOrphanRow({ subdomain: "agent-nobearer" })],
        error: null,
      }),
    };
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      return candidateQuery;
    });
    // VM exists on a host but the bearer isn't readable yet (e.g. a phase-2
    // still finishing) — NOT gone, so DNS must be left alone.
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NO_BEARER", stderr: "" });

    const summary = await runRecoverOrphanProvisioningSweep();

    expect(summary.notFound).toBe(1);
    expect(removeInstanceDnsBestEffort).not.toHaveBeenCalled();
  });

  it("logs an unrecoverable discovery result with host context", async () => {
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    const summary = await runRecoverOrphanProvisioningSweep();

    expect(summary).toEqual({ candidates: 1, recovered: 0, notFound: 1, errors: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      "recover-orphan: discovery returned an unrecoverable result",
      expect.objectContaining({
        failureType: "recover_orphan_discovery_unrecoverable",
        instanceId: ORPHAN_INSTANCE_ID,
        discoveryResult: "UNKNOWN",
      })
    );
  });

  it("returns zero candidates when DB has no orphan rows", async () => {
    mockedFrom.mockReset();
    const emptyQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table: ${table}`);
      return emptyQuery;
    });

    const summary = await runRecoverOrphanProvisioningSweep();
    expect(summary).toEqual({ candidates: 0, recovered: 0, notFound: 0, errors: 0 });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});
