import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadKnownProxmoxFleet,
  locateProxmoxInstanceAcrossFleet,
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

function hostRegistry(hosts: Array<{ id: string; status?: string; decommissioned_at?: string | null }>) {
  return {
    select: jest.fn().mockResolvedValue({
      data: hosts.map((host) => ({ status: "active", decommissioned_at: null, ...host })),
      count: hosts.length,
      error: null,
    }),
  };
}

describe("loadKnownProxmoxFleet", () => {
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      HERMES_PROXMOX_TARGETS: "fixturenode1,fixturenode6,fixturenode7,fixturenode9,fixturenode10,fixturenode21",
    };
  });
  afterEach(() => jest.clearAllMocks());

  it("includes drainage and maintenance but omits explicitly decommissioned hosts", async () => {
    mockedFrom.mockReturnValue(hostRegistry([
      { id: "fixturenode7" },
      { id: "fixturenode8", status: "draining" },
      { id: "fixturenode9", status: "maintenance" },
      { id: "fixturenode10", status: "maintenance", decommissioned_at: "2026-10-24T16:00:00+00:00" },
    ]));
    await expect(loadKnownProxmoxFleet()).resolves.toEqual({
      source: "registry",
      slugs: ["fixturenode7", "fixturenode8", "fixturenode9"],
      decommissionedSlugs: new Set(["fixturenode10"]),
    });
  });

  it("falls back only to explicitly configured hosts when the registry errors", async () => {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
    });
    await expect(loadKnownProxmoxFleet()).resolves.toEqual({
      source: "configuration",
      slugs: ["fixturenode1", "fixturenode6", "fixturenode7", "fixturenode9", "fixturenode10", "fixturenode21"],
    });
  });

  it("falls back when the registry returns an empty list", async () => {
    mockedFrom.mockReturnValue(hostRegistry([]));
    await expect(loadKnownProxmoxFleet()).resolves.toEqual({
      source: "configuration",
      slugs: ["fixturenode1", "fixturenode6", "fixturenode7", "fixturenode9", "fixturenode10", "fixturenode21"],
    });
  });

  it("discovers an explicitly configured per-host SSH identity without inventing fleet members", async () => {
    delete process.env.HERMES_PROXMOX_TARGETS;
    process.env.PROXMOX_HOST_EDGE_1_SSH_HOST = "192.0.2.18";
    mockedFrom.mockReturnValue(hostRegistry([]));
    await expect(loadKnownProxmoxFleet()).resolves.toEqual({ source: "configuration", slugs: ["edge_1"] });
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
    process.env = { ...ORIGINAL_ENV };
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
      if (table === "proxmox_hosts") return hostRegistry([{ id: "fixturenode1" }, { id: "fixturenode2" }]);
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
    // The bearer read is pinned to the VMID-attested guest host key, and its
    // stdin is /dev/null so nested guest SSH can't swallow the host script.
    const discovery = mockedRunScript.mock.calls.map(([script]) => script as string)
      .find((script) => script.includes("GUEST_SSH[@]"));
    expect(discovery).toBeDefined();
    expect(discovery).toContain("VM_SSH_KEY_PATH=/etc/hivra/keys/vm-orchestrator");
    expect(discovery).toMatch(/"\$\{GUEST_SSH\[@\]\}" "sudo -n grep[^\n]*<\/dev\/null/);
    expect(discovery).not.toContain("StrictHostKeyChecking=no");
    require("node:child_process").execFileSync("bash", ["-n"], { input: discovery });

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
      if (table === "proxmox_hosts") return hostRegistry([{ id: "fixturenode13" }]);
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
        return hostRegistry([{ id: "fixturenode13" }]);
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

  it("locates a VM for teardown without writing the row (never revives a row being deleted)", async () => {
    mockedFrom.mockReset();
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "proxmox_hosts") throw new Error(`Unexpected table: ${table}`);
      return hostRegistry([{ id: "fixturenode13" }]);
    });
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: buildDiscoveryStdout({
        vmid: 425,
        privip: "10.250.20.75",
        fqdn: "elsewhere.example",
        bearer: "a".repeat(64),
      }),
      stderr: "",
    });

    const result = await locateProxmoxInstanceAcrossFleet(
      buildOrphanRow({ status: "scheduled_for_deletion", lifecycle_state: "suspended" }),
    );

    expect(result).toEqual(expect.objectContaining({
      status: "found",
      found: expect.objectContaining({ vmid: 425 }),
    }));
    // Only the host registry is read: no hermes_instances write at all.
    expect(mockedFrom.mock.calls.map(([table]) => table)).toEqual(["proxmox_hosts"]);
    expect(mockedEncrypt).not.toHaveBeenCalled();
  });

  it("gives no teardown verdict when the host registry is unreadable (a fallback list may be partial)", async () => {
    mockedFrom.mockReset();
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "proxmox_hosts") throw new Error(`Unexpected table: ${table}`);
      return {
        select: jest.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
      };
    });
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });

    const result = await locateProxmoxInstanceAcrossFleet(
      buildOrphanRow({ status: "scheduled_for_deletion", lifecycle_state: "suspended" }),
    );

    expect(result).toEqual({ status: "inconclusive" });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("does not probe a decommissioned host even when both routing hints still name it", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode13,fixturenode12";
    process.env.PROXMOX_FIXTURENODE12_SSH_HOST = "192.0.2.12";
    mockedFrom.mockReturnValue(hostRegistry([
      { id: "fixturenode13" },
      { id: "fixturenode12", status: "maintenance", decommissioned_at: "2026-10-24T16:00:00Z" },
    ]));
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });
    const row = buildOrphanRow({
      proxmox_node: "fixturenode12",
      config: { infrastructure: { node: "fixturenode12", hostSlug: "fixturenode12" } },
    });

    await expect(locateProxmoxInstanceAcrossFleet(row)).resolves.toEqual({ status: "gone" });
    await expect(recoverProxmoxInstanceAcrossFleet(row)).resolves.toEqual({ status: "gone" });
    expect(mockedResolveEnv.mock.calls.map(([config]) => config?.hostSlug))
      .toEqual(["fixturenode13", "fixturenode13"]);
  });

  it.each(["active", "draining", "maintenance", "unknown"])(
    "cannot establish absence when a %s host is unreachable",
    async (status) => {
      mockedFrom.mockReturnValue(hostRegistry([
        { id: "fixturenode13" },
        { id: "fixturenode12", status },
      ]));
      mockedResolveEnv.mockImplementation((config) => {
        if (config?.hostSlug === "fixturenode12") throw new Error("Host route unavailable");
        return {};
      });
      mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });

      await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow()))
        .resolves.toEqual({ status: "inconclusive" });
      expect(mockedRunScript).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an unregistered row hint inconclusive without probing it", async () => {
    mockedFrom.mockReturnValue(hostRegistry([{ id: "fixturenode13" }]));
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });

    await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow({ proxmox_node: "fixturenode12" })))
      .resolves.toEqual({ status: "inconclusive" });
    expect(mockedResolveEnv.mock.calls.map(([config]) => config?.hostSlug)).toEqual(["fixturenode13"]);
  });

  it("keeps an unregistered infrastructure hostSlug inconclusive without probing it", async () => {
    mockedFrom.mockReturnValue(hostRegistry([{ id: "fixturenode13" }]));
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });
    const row = buildOrphanRow({ config: { infrastructure: { node: "fixturenode13", hostSlug: "fixturenode12" } } });

    await expect(locateProxmoxInstanceAcrossFleet(row)).resolves.toEqual({ status: "inconclusive" });
    expect(mockedResolveEnv.mock.calls.map(([config]) => config?.hostSlug)).toEqual(["fixturenode13"]);
  });

  it.each([
    ["HERMES_PROXMOX_TARGETS", "fixturenode13,fixturenode12"],
    ["PROXMOX_HOST_FIXTURENODE12_SSH_HOST", "192.0.2.12"],
    ["PROXMOX_FIXTURENODE12_SSH_HOST", "192.0.2.12"],
    ["FIXTURENODE12_PROXMOX_SSH_HOST", "192.0.2.12"],
  ])("requires registry coverage for a host declared through %s", async (key, value) => {
    process.env[key] = value;
    mockedFrom.mockReturnValue(hostRegistry([{ id: "fixturenode13" }]));
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });

    await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow())).resolves.toEqual({ status: "inconclusive" });
    expect(mockedResolveEnv.mock.calls.map(([config]) => config?.hostSlug)).toEqual(["fixturenode13"]);
  });

  it("does not use a truncated registry response as evidence of absence", async () => {
    const registry = hostRegistry([{ id: "fixturenode13" }]);
    const partial = await registry.select();
    registry.select.mockResolvedValue({ ...partial, count: 2 });
    mockedFrom.mockReturnValue(registry);
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });

    await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow()))
      .resolves.toEqual({ status: "inconclusive" });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("recovers with a configured inventory without treating a miss as conclusive", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode1,fixturenode2";
    mockedFrom.mockReturnValue(hostRegistry([]));
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "RESULT NOT_FOUND\n", stderr: "" });

    await expect(recoverProxmoxInstanceAcrossFleet(buildOrphanRow()))
      .resolves.toEqual({ status: "inconclusive" });
    expect(mockedRunScript).toHaveBeenCalledTimes(2);
  });

  it("keeps an unrouteable stopped VM present for teardown purposes", async () => {
    mockedFrom.mockReturnValue(hostRegistry([{ id: "fixturenode13" }]));
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "RESULT NO_FQDN\nVMID=425\nVMSTATUS=stopped\nPRIVIP=10.250.20.75\n",
      stderr: "",
    });

    await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow()))
      .resolves.toEqual({ status: "inconclusive" });
  });

  it.each([
    ["listing error with partial output", "printf 'VMID NAME STATUS\\n'; return 1", "inconclusive"],
    ["missing list header", "return 0", "inconclusive"],
    ["malformed VM row", "printf 'VMID NAME STATUS\\n425\\n'", "inconclusive"],
    ["valid empty list", "printf 'VMID NAME STATUS\\n'", "gone"],
  ])("verifies the generated probe handles %s", async (_description, qmBody, status) => {
    mockedFrom.mockReturnValue(hostRegistry([{ id: "fixturenode13" }]));
    mockedRunScript.mockImplementation(async (script) => {
      const result = spawnSync("bash", ["-c", `qm() { ${qmBody}; }\n${script}`], {
        encoding: "utf8",
        timeout: 3000,
      });
      return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
    });

    await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow())).resolves.toEqual({ status });
  });

  it.each([
    [`hermes-${ORPHAN_INSTANCE_ID}`, "RESULT NO_IP", "inconclusive"],
    [`hermes-legacy-agent-${ORPHAN_PREFIX}`, "RESULT NO_IP", "inconclusive"],
    [`hermes-${"a".repeat(41)}`, "RESULT IDENTITY_UNVERIFIED", "inconclusive"],
  ])("keeps stopped VM %s from proving absence with the generated probe", async (vmName, marker, status) => {
    mockedFrom.mockReturnValue(hostRegistry([{ id: "fixturenode13" }]));
    let probeStdout = "";
    mockedRunScript.mockImplementation(async (script) => {
      const result = spawnSync("bash", ["-c", `qm() {
        case "$1" in
          list) printf '%s\\n' 'VMID NAME STATUS' '425 ${vmName} stopped' ;;
          status) printf '%s\\n' 'status: stopped' ;;
          config) printf '%s\\n' 'name: ${vmName}' ;;
          *) return 1 ;;
        esac
      }\n${script}`], { encoding: "utf8", timeout: 3000 });
      probeStdout = result.stdout;
      return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
    });

    await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow())).resolves.toEqual({ status });
    expect(probeStdout).toContain(marker);
  });

  it("can rule out a truncated VM with an agreeing full-ID claim and Caddy route for another instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-discovery-"));
    try {
      const tenant = "00000000-0000-4000-8000-000000001047";
      for (const dir of ["claims", "qemu", "caddy"]) mkdirSync(join(root, dir));
      writeFileSync(join(root, "claims", "425.claim"), tenant);
      writeFileSync(join(root, "qemu", "425.conf"), "ipconfig0: ip=10.250.20.75/24,gw=10.250.20.1\n");
      const site = join(root, "caddy", "agent.caddy");
      writeFileSync(site, [
        "agent.example {",
        `  redir https://dashboard.example/wake/${tenant} 302`,
        "  reverse_proxy 10.250.20.75:80 {",
        "  }",
        "}",
      ].join("\n"));
      mockedFrom.mockReturnValue(hostRegistry([{ id: "fixturenode13" }]));
      mockedRunScript.mockImplementation(async (script) => {
        const fixtureScript = script
          .replaceAll("/run/hermes-vm-claims", join(root, "claims"))
          .replaceAll("/etc/pve/qemu-server", join(root, "qemu"))
          .replaceAll("/etc/caddy/hermes.d", join(root, "caddy"));
        const result = spawnSync("bash", ["-c", `qm() {
          printf '%s\\n' 'VMID NAME STATUS' '425 hermes-${"a".repeat(41)} stopped'
        }\n${fixtureScript}`], { encoding: "utf8", timeout: 3000 });
        return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
      });
      await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow())).resolves.toEqual({ status: "gone" });

      await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow({ id: tenant })))
        .resolves.toEqual({ status: "inconclusive" });

      const beforeClone = new Date("2000-01-01T00:00:00Z");
      utimesSync(site, beforeClone, beforeClone);
      await expect(locateProxmoxInstanceAcrossFleet(buildOrphanRow()))
        .resolves.toEqual({ status: "inconclusive" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["unknown", true],
    ["stopped", false],
  ] as const)("does not adopt NO_BEARER with state=%s and allowStopped=%s", async (vmStatus, allowStopped) => {
    mockedFrom.mockReset();
    mockedFrom.mockImplementation((table: string) => {
      if (table !== "proxmox_hosts") throw new Error(`Unexpected table: ${table}`);
      return hostRegistry([{ id: "fixturenode13" }]);
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
      if (table === "proxmox_hosts") return hostRegistry([{ id: "fixturenode5" }]);
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
      if (table === "proxmox_hosts") return hostRegistry([{ id: "fixturenode13" }]);
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
