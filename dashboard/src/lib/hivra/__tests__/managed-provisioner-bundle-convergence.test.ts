import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  compareProvisionerVersions,
  runManagedProvisionerBundleConvergence,
} from "@/lib/hivra/managed-provisioner-bundle-convergence";
import {
  managedProvisionerBundleManifestFile,
  probeManagedProvisionerBundle,
  syncManagedProvisionerBundle,
  type ManagedProvisionerBundleProbe,
  type ManagedProvisionerBundleSyncResult,
} from "@/lib/hivra/managed-provisioner-bundle-sync";
import { managedHivraProvisionerChannelConfiguration } from "@/lib/hivra/managed-provisioner-channel";
import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "@/lib/infrastructure/portable-provisioner-contract";

const ORIGINAL_ENV = process.env;

function bundle() {
  return PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map((relativePath) => ({
    relativePath,
    content: Buffer.from(
      relativePath === "VERSION" ? `${PORTABLE_HIVRA_PROVISIONER_VERSION}\n` : `${relativePath}\n`,
    ),
  }));
}

function hostEnv(...ids: string[]) {
  return Object.fromEntries(ids.flatMap((id) => {
    const prefix = `PROXMOX_${id.toUpperCase()}_`;
    return [[`${prefix}SSH_HOST`, "192.0.2.10"], [`${prefix}SSH_USER`, "root"], [`${prefix}SSH_PRIVATE_KEY_B64`, "dGVzdA=="]];
  }));
}

type AgentRow = {
  id: string;
  vmid?: number | null;
  status?: string | null;
  proxmox_host: string | null;
  managed_provisioner_channel: string | null;
};

/** Just enough PostgREST for convergence inventory and the Canary hold check. */
function fakeSupabase(
  agents: AgentRow[],
  hosts: Array<{ id: string; status: string; decommissioned_at?: string | null }>,
  rpc = jest.fn().mockResolvedValue({ data: false, error: null }),
) {
  // Rows default to a live VMID-bound computer; tests that exercise the
  // "holds computers" predicate pass explicit vmid/status overrides.
  const rows = agents.map((agent) => ({ vmid: 500, status: "running", ...agent }));
  const from = jest.fn((table: string) => {
    if (table === "proxmox_hosts") {
      return { select: () => Promise.resolve({ data: hosts, error: null }) };
    }
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      order: () => builder,
      range: (start: number, end: number) => Promise.resolve({ data: rows.slice(start, end + 1), error: null }),
    };
    return builder;
  });
  return { from, rpc } as never;
}

function present(targetId: string, observedVersion: string | null, current = false): ManagedProvisionerBundleProbe {
  return { kind: "present", targetId, observedVersion, manifestMatches: current, intact: current };
}

function synced(channel: "default" | "canary", targetId: string): ManagedProvisionerBundleSyncResult {
  return { ok: true, targetId, channel, requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, changed: true, observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION };
}

describe("managed provisioner bundle convergence", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, HERMES_PROXMOX_TARGETS: "", ...hostEnv("fixturenode11", "fixturenode12", "fixturenode21") };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("does nothing at all while the switch is off", async () => {
    const supabase = fakeSupabase([], []);
    const loadBundle = jest.fn();
    const probe = jest.fn();
    const sync = jest.fn();

    const summary = await runManagedProvisionerBundleConvergence({
      supabase,
      env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "false" },
      channel: "default",
      dependencies: { loadBundle, probe, sync },
    });

    expect(summary).toMatchObject({ enabled: false, dryRun: false, hosts: [], synced: [], pending: [] });
    expect((supabase as unknown as { from: jest.Mock }).from).not.toHaveBeenCalled();
    expect(loadBundle).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("counts only VMID-bound, non-error computers as held by a host", async () => {
    // Prod 2026-11: one host reported 46 "live computers" that were mostly
    // deleted/error/VMID-less bookkeeping rows, which kept a dead host
    // paging as error severity every 10 minutes.
    const summary = await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase(
        [
          { id: "live", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "stopped", vmid: 501, status: "stopped", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "no-vmid", vmid: null, proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "errored", status: "error", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "deleted", status: "deleted", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
        ],
        [],
      ),
      env: {},
      channel: "default",
      dryRun: true,
      dependencies: {
        loadBundle: jest.fn().mockResolvedValue(bundle()),
        probe: jest.fn(async (_channel: string, targetId: string) =>
          present(targetId, PORTABLE_HIVRA_PROVISIONER_VERSION, true)),
      },
    });

    expect(summary.hosts).toEqual([
      expect.objectContaining({ targetId: "fixturenode21", liveComputers: 2 }),
    ]);
  });

  it("never probes a decommissioned host even while its stopped computers hold rows", async () => {
    // Prod 2026-11: a retired host kept 43 stopped, VMID-bound rows, so the
    // "holds computers" leg re-admitted it every run and the unreachable
    // probe kept the whole sync flagged as failing forever.
    const probe = jest.fn(async (_channel: string, targetId: string) =>
      present(targetId, PORTABLE_HIVRA_PROVISIONER_VERSION, true));
    const summary = await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase(
        [
          { id: "stopped-1", vmid: 401, status: "stopped", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "stopped-2", vmid: 402, status: "stopped", proxmox_host: "fixturenode12", managed_provisioner_channel: null },
        ],
        [
          { id: "fixturenode21", status: "maintenance", decommissioned_at: "2026-11-23T18:00:00+00:00" },
          { id: "fixturenode12", status: "maintenance", decommissioned_at: null },
        ],
      ),
      env: {},
      channel: "default",
      dryRun: true,
      dependencies: { loadBundle: jest.fn().mockResolvedValue(bundle()), probe },
    });

    // The plain-maintenance host is still a candidate (honest signal for a
    // host that is merely down); only the decommissioned one drops out.
    expect(summary.hosts).toEqual([
      expect.objectContaining({ targetId: "fixturenode12", liveComputers: 1 }),
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("default", "fixturenode12", expect.any(String));
  });

  // The real probe script runs in bash against a temporary provisioner
  // directory; the sync goes through the real syncManagedProvisionerBundle,
  // whose host side is simulated by writing the bundle it was sent for.
  it("finds a stale host, syncs it, and leaves it alone on the next run", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivra-bundle-converge-"));
    const hostDir = join(root, "hivra-provisioner");
    const realDir = managedHivraProvisionerChannelConfiguration("default").runtime.provisionerDirectory;
    try {
      mkdirSync(hostDir);
      writeFileSync(join(hostDir, "VERSION"), "2026.09.30.1\n");
      writeFileSync(join(hostDir, "hivra-start-on-host.sh"), "old\n");
      writeFileSync(join(hostDir, "BUNDLE.sha256"), `${createHash("sha256").update("old\n").digest("hex")}  hivra-start-on-host.sh\n`);

      const syncScripts: string[] = [];
      const fakeHost = jest.fn(async (script: string) => {
        if (script.includes("HIVRA_MANAGED_BUNDLE_PROBE")) {
          const result = spawnSync("bash", ["-s"], { input: script.split(realDir).join(hostDir), encoding: "utf8", timeout: 5000 });
          return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
        }
        syncScripts.push(script);
        rmSync(hostDir, { recursive: true, force: true });
        for (const asset of bundle()) {
          mkdirSync(dirname(join(hostDir, asset.relativePath)), { recursive: true });
          writeFileSync(join(hostDir, asset.relativePath), asset.content);
        }
        writeFileSync(join(hostDir, "BUNDLE.sha256"), managedProvisionerBundleManifestFile(bundle()));
        return {
          ok: true,
          stdout: `HIVRA_HOST_READY\nHIVRA_MANAGED_HOST_PRESERVED target=fixturenode21 vm_before=50/0/50 vm_after=50/0/50 caddy_before=active caddy_after=active storage_before=a/b/c storage_after=a/b/c\nHIVRA_MANAGED_BUNDLE_SYNC status=updated version=${PORTABLE_HIVRA_PROVISIONER_VERSION} backup=/root/x\n`,
          stderr: "",
        };
      });
      const run = () => runManagedProvisionerBundleConvergence({
        supabase: fakeSupabase(
          [{ id: "a1", proxmox_host: "fixturenode21", managed_provisioner_channel: null }],
          [],
        ),
        env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" },
        channel: "default",
        dependencies: {
          loadBundle: jest.fn().mockResolvedValue(bundle()),
          probe: (channel, targetId, digest) => probeManagedProvisionerBundle(channel, targetId, digest, { runHostScript: fakeHost }),
          sync: (channel, targetId) => syncManagedProvisionerBundle(channel, targetId, {
            loadBundle: jest.fn().mockResolvedValue(bundle()),
            runHostScript: fakeHost,
          }),
        },
      });

      const first = await run();
      expect(first.hosts).toEqual([expect.objectContaining({
        targetId: "fixturenode21",
        liveComputers: 1,
        status: "synced",
        observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      })]);
      expect(first.synced).toEqual(["fixturenode21"]);
      expect(syncScripts).toHaveLength(1);
      expect(syncScripts[0]).toContain("EXPECTED_HOSTNAME='fixturenode21'");
      expect(syncScripts[0]).toContain("TARGET='/root/hivra-provisioner'");
      expect(readFileSync(join(hostDir, "VERSION"), "utf8").trim()).toBe(PORTABLE_HIVRA_PROVISIONER_VERSION);

      const second = await run();
      expect(second.hosts).toEqual([expect.objectContaining({ targetId: "fixturenode21", status: "current" })]);
      expect(second.synced).toEqual([]);
      expect(syncScripts).toHaveLength(1);
      expect(existsSync(hostDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("probes at most four hosts at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const probe = jest.fn(async (_channel: string, targetId: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return present(targetId, "2026.09.30.1");
    });
    const sync = jest.fn(async (channel: "default" | "canary", targetId: string) => synced(channel, targetId));
    const hosts = ["fixturenode11", "fixturenode12", "fixturenode13", "fixturenode14", "fixturenode15", "fixturenode16"];

    const summary = await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase(
        hosts.map((host, index) => ({ id: `b${index}`, proxmox_host: host, managed_provisioner_channel: "canary" })),
        [],
      ),
      env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" },
      channel: "canary",
      dependencies: { loadBundle: jest.fn().mockResolvedValue(bundle()), probe, sync },
    });

    expect(probe).toHaveBeenCalledTimes(hosts.length);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(summary.hosts.map((host) => host.targetId)).toEqual([...hosts].sort());
  });

  it("serves only its own channel and syncs the busiest stale host first, one per run", async () => {
    const probe = jest.fn(async (_channel: string, targetId: string) => present(targetId, "2026.09.30.1"));
    const sync = jest.fn(async (channel: "default" | "canary", targetId: string) => synced(channel, targetId));

    const summary = await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase(
        [
          { id: "a1", proxmox_host: "fixturenode11", managed_provisioner_channel: "canary" },
          { id: "a2", proxmox_host: "fixturenode12", managed_provisioner_channel: "canary" },
          { id: "a3", proxmox_host: "fixturenode12", managed_provisioner_channel: "canary" },
          { id: "a4", proxmox_host: "fixturenode21", managed_provisioner_channel: "default" },
          { id: "a5", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "a6", proxmox_host: "fixturenode21", managed_provisioner_channel: "corrupt" },
        ],
        [{ id: "fixturenode11", status: "active" }, { id: "fixturenode16", status: "maintenance" }],
      ),
      env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" },
      channel: "canary",
      dependencies: { loadBundle: jest.fn().mockResolvedValue(bundle()), probe, sync },
    });

    // fixturenode21 holds only default-lane rows and fixturenode16 is not an active placement host.
    expect(probe.mock.calls.map((call) => call[1]).sort()).toEqual(["fixturenode11", "fixturenode12"]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith("canary", "fixturenode12");
    expect(summary.synced).toEqual(["fixturenode12"]);
    expect(summary.pending).toEqual(["fixturenode11"]);
    expect(summary.hosts.find((host) => host.targetId === "fixturenode11")).toMatchObject({
      status: "stale", placementHost: true, liveComputers: 1,
    });
  });

  it("holds an exact Canary host/version without spending the run's sync attempt", async () => {
    const rpc = jest.fn().mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    const sync = jest.fn(async (_channel: string, targetId: string) => synced("canary", targetId));
    const summary = await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase([], [
        { id: "fixturenode11", status: "active" }, { id: "fixturenode12", status: "active" },
      ], rpc),
      env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" },
      channel: "canary",
      dependencies: {
        loadBundle: jest.fn().mockResolvedValue(bundle()),
        probe: jest.fn(async (_channel: string, targetId: string) => present(targetId, "2026.09.30.1")),
        sync,
      },
    });
    expect(rpc.mock.calls).toEqual(["fixturenode11", "fixturenode12"].map(targetId => [
      "get_hivra_canary_bundle_sync_held", { p_host_id: targetId, p_installed_version: "2026.09.30.1" },
    ]));
    expect(sync.mock.calls).toEqual([["canary", "fixturenode12"]]);
    expect(rpc.mock.invocationCallOrder[1]).toBeLessThan(sync.mock.invocationCallOrder[0]);
    expect(summary.pending).toEqual(["fixturenode11"]);
    expect(summary.hosts[0]).toMatchObject({ status: "held", observedVersion: "2026.09.30.1" });
  });

  it.each([
    { data: null, error: { message: "not available" } },
    { data: null, error: null },
  ])("refuses automatic Canary sync without a conclusive hold read (%j)", async (result) => {
    const rpc = jest.fn().mockResolvedValue(result);
    const sync = jest.fn();
    await expect(runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase([], [{ id: "fixturenode11", status: "active" }], rpc),
      env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" },
      channel: "canary",
      dependencies: {
        loadBundle: jest.fn().mockResolvedValue(bundle()),
        probe: jest.fn().mockResolvedValue(present("fixturenode11", "unreadable")),
        sync,
      },
    })).rejects.toThrow("Could not verify Canary automatic bundle sync hold");
    expect(rpc).toHaveBeenCalledWith("get_hivra_canary_bundle_sync_held", {
      p_host_id: "fixturenode11", p_installed_version: null,
    });
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([
    ["canary", false, false],
    ["canary", true, true],
    ["default", false, true],
  ] as const)("probes a maintenance fallback on %s with live rows %s: %s", async (channel, live, eligible) => {
    const rpc = jest.fn();
    const probe = jest.fn().mockResolvedValue(present("fixturenode11", "2026.09.30.1"));
    const summary = await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase(live ? [{ id: "fixture", proxmox_host: "fixturenode11", managed_provisioner_channel: channel }] : [],
        [{ id: "fixturenode11", status: "maintenance" }], rpc),
      env: { HIVRA_CLAUDE_CODE_PROXMOX_HOST: "fixturenode11" },
      dryRun: true,
      channel,
      dependencies: { loadBundle: jest.fn().mockResolvedValue(bundle()), probe },
    });
    expect(summary.hosts.map(host => host.targetId)).toEqual(eligible ? ["fixturenode11"] : []);
    expect(probe).toHaveBeenCalledTimes(eligible ? 1 : 0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not let one failing host starve the next", async () => {
    const probe = jest.fn(async (_channel: string, targetId: string) => present(targetId, "2026.09.30.1"));
    const sync = jest.fn(async (channel: "default" | "canary", targetId: string): Promise<ManagedProvisionerBundleSyncResult> => targetId === "fixturenode21"
      ? { ok: false, targetId, channel, requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, changed: false, observedVersion: null, error: "identity mismatch" }
      : synced(channel, targetId));

    const summary = await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase(
        [
          { id: "a1", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "a2", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
          { id: "a3", proxmox_host: "fixturenode12", managed_provisioner_channel: null },
          { id: "a4", proxmox_host: "fixturenode11", managed_provisioner_channel: null },
        ],
        [],
      ),
      env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" },
      channel: "default",
      dependencies: { loadBundle: jest.fn().mockResolvedValue(bundle()), probe, sync },
    });

    expect(sync.mock.calls.map((call) => call[1])).toEqual(["fixturenode21", "fixturenode11"]);
    expect(summary.hosts.find((host) => host.targetId === "fixturenode21")).toMatchObject({ status: "sync_failed", error: "identity mismatch" });
    expect(summary.synced).toEqual(["fixturenode11"]);
    expect(summary.pending).toEqual(["fixturenode12"]);
  });

  it("never prepares a missing directory, never downgrades a newer host, and never syncs on a dry run", async () => {
    const probes: Record<string, ManagedProvisionerBundleProbe> = {
      fixturenode11: { kind: "missing", targetId: "fixturenode11" },
      fixturenode12: present("fixturenode12", "2099.01.01.1"),
      fixturenode21: present("fixturenode21", "2026.09.30.1"),
    };
    const sync = jest.fn();
    const run = (env: Record<string, string>, dryRun: boolean) => runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase(
        ["fixturenode11", "fixturenode12", "fixturenode21"].map((host, index) => ({ id: `a${index}`, proxmox_host: host, managed_provisioner_channel: null })),
        [],
      ),
      env,
      channel: "default",
      dryRun,
      dependencies: {
        loadBundle: jest.fn().mockResolvedValue(bundle()),
        probe: jest.fn(async (_channel: string, targetId: string) => probes[targetId]),
        sync,
      },
    });

    const dry = await run({}, true);
    expect(dry).toMatchObject({ enabled: false, dryRun: true, synced: [], pending: ["fixturenode21"] });
    expect(dry.hosts.map((host) => [host.targetId, host.status])).toEqual([
      ["fixturenode11", "not_prepared"], ["fixturenode12", "newer_on_host"], ["fixturenode21", "stale"],
    ]);
    expect(sync).not.toHaveBeenCalled();

    sync.mockResolvedValue({ ok: true, targetId: "fixturenode21", channel: "default", requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, changed: true, observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION });
    const live = await run({ HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" }, false);
    expect(sync.mock.calls).toEqual([["default", "fixturenode21"]]);
    expect(live.synced).toEqual(["fixturenode21"]);
  });

  it("treats a current version with a damaged or different manifest as stale", async () => {
    const sync = jest.fn().mockResolvedValue({ ok: true, targetId: "fixturenode21", channel: "default", requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, changed: true, observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION });
    await runManagedProvisionerBundleConvergence({
      supabase: fakeSupabase([{ id: "a1", proxmox_host: "fixturenode21", managed_provisioner_channel: null }], []),
      env: { HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true" },
      channel: "default",
      dependencies: {
        loadBundle: jest.fn().mockResolvedValue(bundle()),
        probe: jest.fn(async () => ({ kind: "present" as const, targetId: "fixturenode21", observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, manifestMatches: true, intact: false })),
        sync,
      },
    });
    expect(sync).toHaveBeenCalledWith("default", "fixturenode21");
  });

  it("refuses to probe a host this deployment has no configuration for", async () => {
    const runHostScript = jest.fn();
    expect(await probeManagedProvisionerBundle("default", "ghostnode", "digest", { runHostScript })).toMatchObject({ kind: "unconfigured" });
    expect(runHostScript).not.toHaveBeenCalled();
  });

  it("compares dotted provisioner versions numerically", () => {
    expect(compareProvisionerVersions("2026.10.07.1", "2026.9.30.1")).toBe(1);
    expect(compareProvisionerVersions("2026.10.07.1", "2026.10.07.1")).toBe(0);
    expect(compareProvisionerVersions("2026.10.07.1", "2026.10.07.2")).toBe(-1);
    expect(compareProvisionerVersions("legacy", "2026.10.07.1")).toBeNull();
  });
});
