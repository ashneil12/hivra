/** @jest-environment node */

// Linux Sandbox preflight and the host authority rules (section 9.5 of
// docs/superpowers/specs/2026-09-24-server-enrollment-command.md; T27, T36).

const mockRunScript = jest.fn();
const mockLoadConnection = jest.fn();
const mockBeginPreflight = jest.fn();
const mockCompletePreflight = jest.fn();
const mockLoadSnapshot = jest.fn();
const mockRpc = jest.fn();
const mockDiscover = jest.fn();
const mockGetTarget = jest.fn();
const mockGetAuthority = jest.fn();
const mockFrom = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => mockRpc(...args), from: (...args: unknown[]) => mockFrom(...args),
} }));
jest.mock("../host-discovery", () => ({ discoverInfrastructureHost: (...args: unknown[]) => mockDiscover(...args) }));
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: async () => ({ plan: "operator", status: "active", instance_limit: 3 }),
}));
jest.mock("@/lib/billing/plan-ladder-entitlement", () => ({ loadLadderEntitlement: async () => null }));
jest.mock("@/lib/subscription", () => ({ getPlan: () => ({ totalCpu: 2, totalRam: 4096 }) }));
jest.mock("../connection-store", () => ({
  getInfrastructureConnectionAuthority: (...args: unknown[]) => mockGetAuthority(...args),
  getInfrastructureDeploymentTarget: (...args: unknown[]) => mockGetTarget(...args),
  loadInfrastructureConnectionSecret: (...args: unknown[]) => mockLoadConnection(...args),
  beginInfrastructureConnectionPreflight: (...args: unknown[]) => mockBeginPreflight(...args),
  completeInfrastructureConnectionPreflight: (...args: unknown[]) => mockCompletePreflight(...args),
}));
jest.mock("../connection-runtime", () => ({
  resolveValidatedSshDestination: jest.fn(async () => ({ address: "192.0.2.1" })),
  buildUserProxmoxEnvironment: jest.fn((connection: { sshPrivilege?: string }) => ({ PRIVILEGE: connection.sshPrivilege ?? "login" })),
}));
// The authority rules are the real ones; only the snapshot read is stubbed.
jest.mock("../host-authority", () => ({
  ...jest.requireActual("../host-authority"),
  loadCurrentHostDiscoverySnapshot: (...args: unknown[]) => mockLoadSnapshot(...args),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunScript(...args),
}));

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasHostAdministratorAuthority, hasRuntimeHostAuthority } from "../host-authority";
import type { HostDiscoverySnapshot } from "../host-discovery-contracts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkManagedGvisorLaunchAuthority } from "@/lib/hivra/managed-gvisor-authority";
import {
  HIVRA_GVISOR_ADAPTER_VERSION, HIVRA_GVISOR_BUNDLE_SHA256, HIVRA_GVISOR_IMAGE, HIVRA_GVISOR_PREFLIGHT_TTL_MS,
} from "@/lib/hivra/gvisor-computer-contract";
import { preflightGvisorTarget, refreshManagedGvisorTarget } from "../gvisor-target";

const USER = "user_test";
const CONNECTION = "33333333-3333-4333-8333-333333333333";
const BUNDLE = "b".repeat(64);
const NOW = Date.now();

function connectionAs(sshUser: string, sshPrivilege?: "login" | "sudo", revision = 5) {
  return {
    id: CONNECTION, provider: "host", revision, status: "pending", configuration: null,
    endpoint: { sshHost: "host.example", sshPort: 22, sshUser, sshHostFingerprintSha256: "c".repeat(64),
      ...(sshPrivilege ? { sshPrivilege } : {}) },
    credentials: { sshPrivateKey: "test" },
  };
}

function snapshot(version: 1 | 2, privilegeVia: "login" | "sudo" = "login", overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: version, connectionRevision: 5, hostIdentityDigest: "d".repeat(64),
    observedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 14 * 60_000).toISOString(),
    host: {
      os: { family: "linux", id: "ubuntu", versionId: "24.04" },
      kernel: { release: "6.8.0", architecture: "amd64" },
      environment: { effectivePrivilege: "root", cgroupVersion: 2, virtualization: "virtual-machine", packageManagers: ["apt"],
        ...(version === 2 ? { privilegeVia, passwordlessSudo: null } : {}) },
    },
    ...overrides,
  } as unknown as HostDiscoverySnapshot;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBeginPreflight.mockResolvedValue(true);
  mockCompletePreflight.mockResolvedValue(true);
  // The strict check itself fails here: these tests are about whether Hivra
  // reaches it at all.
  mockRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: "" });
});

describe("host authority rules", () => {
  it("gives runtime authority to root over a login, and to any user through sudo, never to a plain non-root login", () => {
    expect(hasRuntimeHostAuthority(connectionAs("root"))).toBe(true);
    expect(hasRuntimeHostAuthority(connectionAs("hivra", "sudo"))).toBe(true);
    expect(hasRuntimeHostAuthority(connectionAs("ubuntu"))).toBe(false);
    expect(hasRuntimeHostAuthority({ ...connectionAs("root"), provider: "proxmox" })).toBe(false);
  });

  it("needs a current inspection that reached root the way the connection does now (T27)", () => {
    // A version 1 snapshot is read as a login snapshot: exact, since no sudo path existed.
    expect(hasHostAdministratorAuthority(connectionAs("root"), snapshot(1), NOW)).toBe(true);
    expect(hasHostAdministratorAuthority(connectionAs("root"), snapshot(2, "login"), NOW)).toBe(true);
    expect(hasHostAdministratorAuthority(connectionAs("hivra", "sudo"), snapshot(2, "sudo"), NOW)).toBe(true);
    expect(hasHostAdministratorAuthority(connectionAs("hivra", "sudo"), snapshot(1), NOW)).toBe(false);
    expect(hasHostAdministratorAuthority(connectionAs("hivra", "sudo"), snapshot(2, "login"), NOW)).toBe(false);
    expect(hasHostAdministratorAuthority(connectionAs("root"), snapshot(2, "sudo"), NOW)).toBe(false);
    expect(hasHostAdministratorAuthority(connectionAs("root"), snapshot(1, "login", { connectionRevision: 4 }), NOW)).toBe(false);
    expect(hasHostAdministratorAuthority(connectionAs("root"),
      snapshot(1, "login", { expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
    expect(hasHostAdministratorAuthority(connectionAs("root"), null, NOW)).toBe(false);
  });
});

describe("preflightGvisorTarget", () => {
  it("still checks a root login connection with a version 1 snapshot, as before slice 13", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("root"));
    mockLoadSnapshot.mockResolvedValue(snapshot(1));
    await expect(preflightGvisorTarget(USER, CONNECTION, BUNDLE)).rejects.toMatchObject({ code: "remote_failed" });
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(mockRunScript.mock.calls[0][1]).toEqual({ PRIVILEGE: "login" });
  });

  it("checks a sudo connection through the transport when its inspection ran through sudo", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("hivra", "sudo"));
    mockLoadSnapshot.mockResolvedValue(snapshot(2, "sudo"));
    await expect(preflightGvisorTarget(USER, CONNECTION, BUNDLE)).rejects.toMatchObject({ code: "remote_failed" });
    expect(mockRunScript.mock.calls[0][1]).toEqual({ PRIVILEGE: "sudo" });
  });

  it.each([
    ["a version 1 snapshot", snapshot(1)],
    ["a snapshot taken over the login", snapshot(2, "login")],
  ])("refuses a sudo connection with %s before any SSH (T27)", async (_label, current) => {
    mockLoadConnection.mockResolvedValue(connectionAs("hivra", "sudo"));
    mockLoadSnapshot.mockResolvedValue(current);
    await expect(preflightGvisorTarget(USER, CONNECTION, BUNDLE))
      .rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("root or passwordless sudo") });
    expect(mockBeginPreflight).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  // runsc prints its version in two writes. The check read only the first
  // line with `head -n 1`, which exits as soon as it has it; if runsc's second
  // write came after that, runsc died of SIGPIPE and, under pipefail, the
  // whole strict check failed. Seen on disposable servers as a check that
  // failed right after Prepare and passed when run again.
  it("reads runsc's version without failing when runsc writes after the first line", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("root"));
    mockLoadSnapshot.mockResolvedValue(snapshot(1));
    await expect(preflightGvisorTarget(USER, CONNECTION, BUNDLE)).rejects.toMatchObject({ code: "remote_failed" });
    const script = String(mockRunScript.mock.calls[0][0]);
    const versionLine = script.split("\n").find(line => line.startsWith("runsc_version="));
    expect(versionLine).toBeDefined();
    const stubs = mkdtempSync(join(tmpdir(), "hivra-runsc-"));
    try {
      writeFileSync(join(stubs, "runsc"), "#!/bin/bash\nprintf 'runsc version release-20250101.0\\n'\nsleep 0.3\nprintf 'spec: 1.1.0\\n'\n");
      chmodSync(join(stubs, "runsc"), 0o755);
      const run = spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail\n${versionLine}\nprintf '%s' "$runsc_version"`],
        { encoding: "utf8", timeout: 10_000, env: { PATH: `${stubs}:/usr/bin:/bin`, LC_ALL: "C", NODE_ENV: "test" } });
      expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
      expect(Buffer.from(run.stdout, "base64").toString("utf8")).toBe("runsc version release-20250101.0\n");
    } finally {
      rmSync(stubs, { recursive: true, force: true });
    }
  });

  // The same race, the other early-exit reader: `docker info … | grep -q`
  // under pipefail. grep -q exits at its first match; a later write by docker
  // would die of SIGPIPE and fail the check (exit 141).
  it("checks docker's runsc runtime without failing when docker writes after the match", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("root"));
    mockLoadSnapshot.mockResolvedValue(snapshot(1));
    await expect(preflightGvisorTarget(USER, CONNECTION, BUNDLE)).rejects.toMatchObject({ code: "remote_failed" });
    const script = String(mockRunScript.mock.calls[0][0]);
    const runtimeLine = script.split("\n").find(line => line.includes("docker info --format '{{json .Runtimes}}'"));
    expect(runtimeLine).toBeDefined();
    const stubs = mkdtempSync(join(tmpdir(), "hivra-docker-"));
    const run = (runtimes: string) => {
      writeFileSync(join(stubs, "docker"), `#!/bin/bash\nprintf '%s\\n' '${runtimes}'\nsleep 0.3\nprintf '\\n'\n`);
      chmodSync(join(stubs, "docker"), 0o755);
      return spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail\n${runtimeLine}\necho checked`],
        { encoding: "utf8", timeout: 10_000, env: { PATH: `${stubs}:/usr/bin:/bin`, LC_ALL: "C", NODE_ENV: "test" } });
    };
    try {
      const withRunsc = run('{"runc":{"path":"runc"},"runsc":{"path":"/usr/local/bin/runsc"}}');
      expect({ status: withRunsc.status, stdout: withRunsc.stdout, stderr: withRunsc.stderr })
        .toEqual({ status: 0, stdout: "checked\n", stderr: "" });
      const withoutRunsc = run('{"runc":{"path":"runc"}}');
      expect(withoutRunsc.status).not.toBe(0);
      expect(withoutRunsc.stdout).toBe("");
    } finally {
      rmSync(stubs, { recursive: true, force: true });
    }
  });

  it("asks for a new inspection when there is no current one", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("hivra", "sudo"));
    mockLoadSnapshot.mockResolvedValue(null);
    await expect(preflightGvisorTarget(USER, CONNECTION, BUNDLE)).rejects.toMatchObject({ code: "discovery_required" });
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("refuses a non-root login without sudo before reading any snapshot", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("ubuntu"));
    await expect(preflightGvisorTarget(USER, CONNECTION, BUNDLE))
      .rejects.toMatchObject({ code: "unsupported", message: "Linux Sandbox needs root or passwordless sudo on this server." });
    expect(mockLoadSnapshot).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });
});

describe("managed evidence renewal", () => {
  const targetId = "44444444-4444-4444-8444-444444444444";
  const config = { authorityUserId: USER, connectionId: CONNECTION, targetId, connectionRevision: 5 };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true",
    HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID: USER,
    HIVRA_MANAGED_GVISOR_CONNECTION_ID: CONNECTION,
    HIVRA_MANAGED_GVISOR_TARGET_ID: targetId,
    HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "5",
  };
  const runtimeSha = "e".repeat(64);
  const sha = createHash("sha256").update(readFileSync("provisioner/gvisor/hivra-gvisor-adapter.py")).digest("hex");
  const output = (runscSha256: string) => ({
    ok: true,
    stdout: "HIVRA_GVISOR_PREFLIGHT_V1 " + JSON.stringify({
      adapterVersion: HIVRA_GVISOR_ADAPTER_VERSION, adapterSha256: sha, bundleSha256: HIVRA_GVISOR_BUNDLE_SHA256,
      runscSha256, cpu: 2, memoryMb: 4096, memoryAvailableMb: 3072,
      storageTotalBytes: 1_000_000, storageAvailableBytes: 999_999,
      runscVersionBase64: Buffer.from("runsc version example").toString("base64"), image: HIVRA_GVISOR_IMAGE,
    }),
  });

  function readyFixture() {
    const connection = { ...connectionAs("root"), status: "ready" };
    const target = {
      id: targetId, connectionId: CONNECTION, evidenceConnectionRevision: 5, status: "ready",
      lastPreflightAt: new Date(Date.now() - HIVRA_GVISOR_PREFLIGHT_TTL_MS - 1).toISOString(),
      capabilities: {
        kind: "gvisor", hostIdentityDigest: "d".repeat(64),
        adapter: { version: HIVRA_GVISOR_ADAPTER_VERSION, sha256: sha }, runtime: { sha256: runtimeSha },
      },
    };
    mockLoadConnection.mockResolvedValue(connection);
    mockGetAuthority.mockResolvedValue(connection);
    mockGetTarget.mockResolvedValue(target);
    mockDiscover.mockResolvedValue({ ok: true, snapshot: snapshot(1) });
    mockRunScript.mockResolvedValue(output(runtimeSha));
    return target;
  }

  it("refuses managed launch after expiry, then allows it after the exact target is refreshed", async () => {
    const target = readyFixture();
    const staleAt = target.lastPreflightAt;
    let pending: { last_preflight_at: string };
    const query = {
      update: jest.fn(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => {
        target.lastPreflightAt = pending.last_preflight_at;
        return { data: { id: targetId }, error: null };
      }),
    };
    query.update.mockImplementation((update: { last_preflight_at: string }) => { pending = update; return query; });
    mockFrom.mockReturnValue(query);
    await expect(checkManagedGvisorLaunchAuthority("user_customer", env)).resolves.toMatchObject({
      ok: false, status: 503, code: "managed_gvisor_target_mismatch",
    });
    await refreshManagedGvisorTarget(config);
    expect(query.update).toHaveBeenCalledWith({ last_preflight_at: target.lastPreflightAt });
    expect(query.eq).toHaveBeenCalledWith("last_preflight_at", staleAt);
    expect(query.eq).toHaveBeenCalledWith("evidence_connection_revision", 5);
    expect(query.eq).toHaveBeenCalledWith("id", targetId);
    expect(mockBeginPreflight).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    await expect(checkManagedGvisorLaunchAuthority("user_customer", env)).resolves.toMatchObject({ ok: true });
  });

  it("does not refresh changed runtime or a connection revision changed during the probe", async () => {
    readyFixture();
    mockRunScript.mockResolvedValueOnce(output("f".repeat(64)));
    await expect(refreshManagedGvisorTarget(config)).rejects.toMatchObject({ code: "remote_failed" });
    mockGetAuthority.mockResolvedValueOnce({ ...connectionAs("root", undefined, 6), status: "ready" });
    await expect(refreshManagedGvisorTarget(config)).rejects.toMatchObject({ code: "not_found" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
