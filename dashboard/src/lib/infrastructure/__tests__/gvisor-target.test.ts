/** @jest-environment node */

// Linux Sandbox preflight and the host authority rules (section 9.5 of
// docs/superpowers/specs/2026-09-24-server-enrollment-command.md; T27, T36).

const mockRunScript = jest.fn();
const mockLoadConnection = jest.fn();
const mockBeginPreflight = jest.fn();
const mockCompletePreflight = jest.fn();
const mockLoadSnapshot = jest.fn();
const mockRpc = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) } }));
jest.mock("../connection-store", () => ({
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
import { preflightGvisorTarget } from "../gvisor-target";

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
        { encoding: "utf8", timeout: 10_000, env: { PATH: `${stubs}:/usr/bin:/bin`, LC_ALL: "C" } });
      expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
      expect(Buffer.from(run.stdout, "base64").toString("utf8")).toBe("runsc version release-20250101.0\n");
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
