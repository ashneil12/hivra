/** @jest-environment node */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  normalizeProxmoxSshHostFingerprint: (value: string) => value,
}));

import { spawnSync } from "node:child_process";

import {
  buildPortableProvisionerPreparationScript,
  loadPortableProvisionerBundle,
  prepareSimpleProxmoxConnection,
  type PortableProvisionerBundleAsset,
} from "../connection-preparation";
import { InfrastructureConnectionStoreError } from "../connection-store";
import type { LoadedInfrastructureConnection } from "../connection-store";
import { InfrastructureNetworkError } from "../connection-runtime";
import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "../portable-provisioner-contract";

const CONNECTION_ID = "00000000-0000-4000-8000-000000001035";
const PRIVATE_KEY = "very-private-ssh-key-material";

function connection(
  overrides: Partial<LoadedInfrastructureConnection> = {},
): LoadedInfrastructureConnection {
  return {
    id: CONNECTION_ID,
    name: "Personal Proxmox",
    provider: "proxmox",
    operatingMode: "self-managed",
    setupMode: "simple",
    status: "pending",
    endpoint: {
      sshHost: "pve.example.test",
      sshPort: 22,
      sshUser: "root",
      sshHostFingerprintSha256: "ab".repeat(32),
    },
    configuration: null,
    revision: 4,
    pendingBindingRebindFromRevision: null,
    credentials: { sshPrivateKey: PRIVATE_KEY },
    lastCheckedAt: null,
    lastErrorCode: null,
    createdAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

function bundle(): PortableProvisionerBundleAsset[] {
  return PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map((relativePath) => ({
    relativePath,
    content: Buffer.from(
      relativePath === "VERSION" ? `${PORTABLE_HIVRA_PROVISIONER_VERSION}\n` : `asset:${relativePath}\n`,
    ),
  }));
}

const preflight = {
  ok: false as const,
  connectionId: CONNECTION_ID,
  checkedAt: "2026-08-26T12:01:00.000Z",
  error: {
    code: "CAPACITY_UNAVAILABLE" as const,
    message: "Target capacity could not be measured.",
  },
  unmetRequirements: [{
    code: "CAPACITY_UNAVAILABLE" as const,
    message: "Target capacity could not be measured.",
  }],
};

function dependencies() {
  return {
    loadConnection: jest.fn().mockResolvedValue(connection()),
    resolveDestination: jest.fn().mockResolvedValue({
      hostname: "pve.example.test",
      address: "203.0.113.10",
      family: 4,
    }),
    loadBundle: jest.fn().mockResolvedValue(bundle()),
    executeHostScript: jest.fn().mockResolvedValue({
      ok: true,
      stdout: `noise\nHIVRA_PREPARE_RESULT {"version":"${PORTABLE_HIVRA_PROVISIONER_VERSION}","storage":"local-lvm"}\n`,
      stderr: "host-only detail",
    }),
    preflight: jest.fn().mockResolvedValue(preflight),
    beginPreparation: jest.fn().mockResolvedValue(true),
    completePreflight: jest.fn().mockResolvedValue(true),
    now: jest.fn().mockReturnValue(new Date("2026-08-26T12:00:30.000Z")),
    newRunId: jest.fn().mockReturnValue("11111111-1111-4111-8111-111111111111"),
  };
}

describe("portable Proxmox host preparation", () => {
  it("loads the complete reviewed bundle with the contracted version", async () => {
    const loaded = await loadPortableProvisionerBundle();

    expect(loaded.map((asset) => asset.relativePath)).toEqual(
      Array.from(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES),
    );
    expect(loaded.find((asset) => asset.relativePath === "VERSION")?.content.toString().trim())
      .toBe(PORTABLE_HIVRA_PROVISIONER_VERSION);
  });

  it("builds a checksum-verified temporary upload that invokes only the preparation entrypoint", () => {
    const script = buildPortableProvisionerPreparationScript(bundle());

    expect(script).toContain("mktemp -d /tmp/hivra-provisioner.XXXXXXXX");
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain('bash "$UPLOAD_DIR/prepare-proxmox-host.sh"');
    expect(script).toContain("timeout --foreground --signal=TERM --kill-after=10s 210s env");
    expect(script).toContain("HIVRA_INSTALL_DIR='/opt/hivra/provisioner'");
    expect(script).toContain("HIVRA_BRIDGE='hivra0'");
    expect(script).not.toContain("qm create");
    expect(script).not.toContain("qm clone");
    expect(script).not.toContain(PRIVATE_KEY);
    const syntax = spawnSync("bash", ["-n", "-s"], {
      input: script,
      encoding: "utf8",
    });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("pins fresh DNS, streams over an allowlisted user environment, and returns only sanitized evidence", async () => {
    const deps = dependencies();

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toEqual({
      ok: true,
      connectionId: CONNECTION_ID,
      provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      preflight,
    });
    expect(deps.loadConnection).toHaveBeenCalledTimes(4);
    expect(deps.executeHostScript).toHaveBeenCalledWith(
      expect.stringContaining("sha256sum -c -"),
      expect.objectContaining({
        HIVRA_USER_INFRA_CONNECTION: "true",
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_PRIVATE_KEY: PRIVATE_KEY,
        PROXMOX_ALLOW_SSH_AGENT: "false",
        PROXMOX_BRIDGE: "hivra0",
      }),
      { timeoutMs: 225_000, maxOutputBytes: 65_536 },
    );
    expect(deps.beginPreparation).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      4,
      "11111111-1111-4111-8111-111111111111",
      "2026-08-26T12:00:30.000Z",
    );
    expect(deps.preflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      { newRunId: expect.any(Function) },
      4,
    );
    expect(deps.preflight.mock.calls[0][2].newRunId()).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain("host-only detail");
  });

  it("rejects Advanced setup before reading or sending the bundle", async () => {
    const deps = dependencies();
    deps.loadConnection.mockResolvedValue(connection({
      setupMode: "advanced",
      configuration: { bridge: "vmbr0" },
    }));

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "SIMPLE_MODE_REQUIRED" } });
    expect(deps.resolveDestination).not.toHaveBeenCalled();
    expect(deps.loadBundle).not.toHaveBeenCalled();
    expect(deps.executeHostScript).not.toHaveBeenCalled();
    expect(deps.beginPreparation).not.toHaveBeenCalled();
  });

  it("maps cross-owner absence without attempting DNS or SSH", async () => {
    const deps = dependencies();
    deps.loadConnection.mockRejectedValue(new InfrastructureConnectionStoreError("not_found"));

    const result = await prepareSimpleProxmoxConnection("other_owner", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "CONNECTION_NOT_FOUND" } });
    expect(deps.resolveDestination).not.toHaveBeenCalled();
    expect(deps.executeHostScript).not.toHaveBeenCalled();
  });

  it("blocks forbidden resolution before the private key reaches an executor", async () => {
    const deps = dependencies();
    deps.resolveDestination.mockRejectedValue(
      new InfrastructureNetworkError("ssh_host_forbidden", "raw destination detail"),
    );

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "HOST_ADDRESS_BLOCKED" } });
    expect(JSON.stringify(result)).not.toContain("raw destination detail");
    expect(deps.executeHostScript).not.toHaveBeenCalled();
  });

  it("fails closed when the connection revision changes before mutation", async () => {
    const deps = dependencies();
    deps.loadConnection
      .mockResolvedValueOnce(connection({ revision: 4 }))
      .mockResolvedValueOnce(connection({ revision: 5 }));

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_SUPERSEDED" } });
    expect(deps.executeHostScript).not.toHaveBeenCalled();
    expect(deps.preflight).not.toHaveBeenCalled();
  });

  it("does not mutate the host when durable preparation authority is contended", async () => {
    const deps = dependencies();
    deps.beginPreparation.mockResolvedValue(false);

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_SUPERSEDED" } });
    expect(deps.executeHostScript).not.toHaveBeenCalled();
    expect(deps.preflight).not.toHaveBeenCalled();
  });

  it("does not accept prepared evidence if the connection changes during the operation", async () => {
    const deps = dependencies();
    deps.loadConnection
      .mockResolvedValueOnce(connection({ revision: 4 }))
      .mockResolvedValueOnce(connection({ revision: 4 }))
      .mockResolvedValueOnce(connection({ revision: 5 }));

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_SUPERSEDED" } });
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      4,
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ connectionStatus: "error", target: null }),
    );
  });

  it("never returns raw remote output when host preparation fails", async () => {
    const deps = dependencies();
    deps.executeHostScript.mockResolvedValue({
      ok: false,
      stdout: `remote leaked ${PRIVATE_KEY}`,
      stderr: "package manager emitted private host detail",
      error: "Remote bash exited with code 1",
    });

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_FAILED" } });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain("package manager");
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      4,
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ connectionStatus: "error", target: null }),
    );
  });

  it("requires the exact versioned receipt before running preflight", async () => {
    const deps = dependencies();
    deps.executeHostScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_PREPARE_RESULT {\"version\":\"stale-version\"}\n",
      stderr: "",
    });

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_FAILED" } });
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1",
      CONNECTION_ID,
      4,
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        connectionStatus: "error",
        lastErrorCode: "PROVISIONER_UNAVAILABLE",
        target: null,
      }),
    );
  });

  it("rejects a preflight superseded after the remote operation", async () => {
    const deps = dependencies();
    deps.preflight.mockResolvedValue({
      ok: false,
      connectionId: CONNECTION_ID,
      checkedAt: "2026-08-26T12:01:00.000Z",
      error: {
        code: "PREFLIGHT_SUPERSEDED",
        message: "A newer connection replaced this check.",
      },
      unmetRequirements: [{
        code: "PREFLIGHT_SUPERSEDED",
        message: "A newer connection replaced this check.",
      }],
    });

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_SUPERSEDED" } });
  });

  it("checks the connection revision again after preflight completes", async () => {
    const deps = dependencies();
    deps.loadConnection
      .mockResolvedValueOnce(connection({ revision: 4 }))
      .mockResolvedValueOnce(connection({ revision: 4 }))
      .mockResolvedValueOnce(connection({ revision: 4 }))
      .mockResolvedValueOnce(connection({ revision: 5 }));

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_SUPERSEDED" } });
  });
});
