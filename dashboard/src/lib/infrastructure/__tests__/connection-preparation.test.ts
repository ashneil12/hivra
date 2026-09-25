/** @jest-environment node */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  normalizeProxmoxSshHostFingerprint: (value: string) => value,
}));

import { spawnSync } from "node:child_process";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildPortableProvisionerPreparationScript,
  classifyPreparationFailureCause,
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

  // Release gate T43 (review finding 2): prepare-proxmox-host.sh checks only
  // `id -u`, which a sudo connection passes, so Hivra refuses first.
  it("refuses a sudo connection before reading the bundle or any SSH while the gate is off", async () => {
    const deps = dependencies();
    const base = connection();
    deps.loadConnection.mockResolvedValue(connection({
      provider: "host", endpoint: { ...base.endpoint, sshUser: "hivra", sshPrivilege: "sudo" },
    }));

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toMatchObject({ ok: false, error: { code: "PREPARATION_FAILED", cause: "root_required",
      message: "Setup needs a root login on this server. Proxmox launches need a root login for now." } });
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

  it("reports why the host script stopped as a fixed cause, never its raw output", async () => {
    const deps = dependencies();
    deps.executeHostScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "[hivra-prepare] creating host-to-guest key\n[hivra-prepare] no active VM-capable Proxmox storage was found\n",
      error: "Remote bash exited with code 1",
    });

    const result = await prepareSimpleProxmoxConnection("user_1", CONNECTION_ID, deps);

    expect(result).toEqual({
      ok: false,
      connectionId: CONNECTION_ID,
      error: expect.objectContaining({
        code: "PREPARATION_FAILED",
        cause: "storage_unavailable",
        message: "Setup couldn't find active Proxmox storage for virtual machines.",
      }),
    });
    expect(JSON.stringify(result)).not.toContain("VM-capable Proxmox storage was found");
    expect(deps.completePreflight).toHaveBeenCalledWith(
      "user_1", CONNECTION_ID, 4, "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ connectionStatus: "error" }),
    );
  });

  it.each([
    ["[hivra-prepare] run as root", "root_required"],
    ["[hivra-prepare] Proxmox VE 8 or 9 is required", "proxmox_version_unsupported"],
    ["[hivra-prepare] KVM is unavailable", "kvm_unavailable"],
    ["[hivra-prepare] another Hivra host preparation is already running", "already_running"],
    ["[hivra-prepare] selected storage is not active and VM-capable", "storage_unavailable"],
    ["[hivra-prepare] pveversion is required", "host_tools_missing"],
    ["[hivra-network-preflight] refusing to adopt an existing unowned bridge", "network_conflict"],
    ["[hivra-prepare] hivra0 exists but is not a bridge", "network_conflict"],
    ["[hivra-prepare] IPv4 guest egress isolation is not active", "network_setup_failed"],
    ["[hivra-network-preflight] owned bridge has an unexpected IPv4 address: 10.251.20.9/24\n[hivra-prepare] installed network ownership contract failed validation", "network_setup_failed"],
    ["[hivra-prepare] Ubuntu cloud image checksum verification failed", "image_download_failed"],
    ["[hivra-prepare] downloading Ubuntu cloud image\ncurl: (6) Could not resolve host: cloud-images.ubuntu.com", "image_download_failed"],
    ["something unexpected", undefined],
    ["", undefined],
  ])("classifies %j as %s", (stderr, cause) => {
    expect(classifyPreparationFailureCause(stderr)).toBe(cause);
  });

  // Review of slice 5: log() and fail() share the "[hivra-prepare] " prefix,
  // and the classifier read the last prefixed line. On a new host the script
  // logs "downloading Ubuntu cloud image", so any later set -e abort in the
  // network section was reported as a failed image download.
  it.each([
    ["[hivra-prepare] creating host-to-guest key\n[hivra-prepare] downloading Ubuntu cloud image\nRTNETLINK answers: Operation not permitted"],
    ["[hivra-prepare] downloading Ubuntu cloud image\nFailed to enable unit: Unit file hivra-network.service is masked."],
    ["[hivra-prepare] downloading Ubuntu cloud image\n/dev/stdin:3:5-45: Error: Could not process rule: No such file or directory"],
    ["[hivra-prepare] downloading Ubuntu cloud image"],
    ["[hivra-prepare] creating host-to-guest key"],
    ["[hivra-prepare] prepared Proxmox target with Hivra 2026.09.22.2"],
    // curl's error names the image download only while that download runs.
    ["curl: (6) Could not resolve host: cloud-images.ubuntu.com"],
  ])("never names a cause for a raw command error or a progress line: %j", (stderr) => {
    expect(classifyPreparationFailureCause(stderr)).toBeUndefined();
  });

  it("names a cause for exactly the prepare script's own fail() messages, and never for its log() lines", () => {
    const script = readFileSync(path.join(process.cwd(), "provisioner", "prepare-proxmox-host.sh"), "utf8");
    const fails = [...script.matchAll(/fail "([^"]+)"/g)].map((match) => match[1]);
    const logs = [...script.matchAll(/^\s*log "([^"]+)"/gm)].map((match) => match[1]);
    // Every fail() message the script prints, with the cause it should name.
    // Hivra's own settings being wrong (not the owner's server) stays generic.
    const expected: Record<string, string | undefined> = {
      "run as root": "root_required",
      "invalid provisioner version": undefined,
      "invalid bridge name": undefined,
      "bridge name is longer than Linux permits": undefined,
      "subnet prefix must contain three valid IPv4 octets": undefined,
      "gateway must be a valid IPv4 address": undefined,
      "gateway must be inside the selected /24": undefined,
      "gateway cannot be the network or broadcast address": undefined,
      "invalid IP start": undefined,
      "invalid VMID range": undefined,
      "unsafe path: $path": undefined,
      "provisioner source directory is missing": undefined,
      "network collision preflight is missing or not executable": undefined,
      "Ubuntu image URL must use HTTPS": undefined,
      "Ubuntu image checksum must be a lowercase SHA-256 digest": undefined,
      "$command is required": "host_tools_missing",
      "Proxmox VE 8 or 9 is required": "proxmox_version_unsupported",
      "KVM is unavailable": "kvm_unavailable",
      "another Hivra host preparation is already running": "already_running",
      "no active VM-capable Proxmox storage was found": "storage_unavailable",
      "invalid storage name": "storage_unavailable",
      "selected storage is not active and VM-capable": "storage_unavailable",
      "unsafe staging path": undefined,
      "unsafe previous-install path": undefined,
      "Ubuntu cloud image checksum verification failed": "image_download_failed",
      "downloaded cloud image is invalid": "image_download_failed",
      "$BRIDGE exists but is not a bridge": "network_conflict",
      "installed provisioner bundle failed checksum verification": undefined,
      "installed Ubuntu image failed checksum verification": "image_download_failed",
      "VM orchestrator private key has unsafe ownership or mode": undefined,
      "VM orchestrator public key has unsafe ownership or mode": undefined,
      "Hivra network service is not active": "network_setup_failed",
      "network ownership marker has unsafe ownership or mode": "network_setup_failed",
      "installed network ownership contract failed validation": "network_setup_failed",
      "IPv4 guest-to-host isolation is not active": "network_setup_failed",
      "IPv4 guest egress isolation is not active": "network_setup_failed",
      "IPv6 guest-to-host isolation is not active": "network_setup_failed",
      "IPv6 guest egress isolation is not active": "network_setup_failed",
      "layer-2 guest isolation is not active": "network_setup_failed",
    };
    // A new fail() line needs a decision here before it ships.
    expect([...new Set(fails)].sort()).toEqual(Object.keys(expected).sort());
    const commands = script.match(/for command in ([^;]+); do/)?.[1].trim().split(/\s+/) ?? [];
    expect(commands.length).toBeGreaterThan(10);
    for (const [message, cause] of Object.entries(expected)) {
      const printed = message === "$command is required" ? commands.map((command) => `${command} is required`)
        : message === "$BRIDGE exists but is not a bridge" ? ["hivra0 exists but is not a bridge"]
          : message === "unsafe path: $path" ? ["unsafe path: /opt/hivra/provisioner"]
            : [message];
      for (const line of printed) {
        expect([line, classifyPreparationFailureCause(`[hivra-prepare] ${line}\n`)]).toEqual([line, cause]);
      }
    }
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const line of logs) {
      expect([line, classifyPreparationFailureCause(`[hivra-prepare] ${line.replace("${VERSION}", "2026.09.22.2")}`)])
        .toEqual([line, undefined]);
    }
  });

  // Runs the real script only as a normal user, where it stops at its root
  // check before any change. Every path it could write points into a
  // throwaway directory as well, and it never runs as root: there it would get
  // as far as the host's own tools. Review of slice 5.
  (typeof process.getuid === "function" && process.getuid() === 0 ? it.skip : it)(
    "classifies the real script's first refusal as a non-root user",
    () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "hivra-prepare-test-"));
      try {
        const run = spawnSync("bash", [path.join(process.cwd(), "provisioner", "prepare-proxmox-host.sh")], {
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            HIVRA_SOURCE_DIR: path.join(process.cwd(), "provisioner"),
            HIVRA_INSTALL_DIR: path.join(scratch, "opt", "provisioner"),
            HIVRA_STATE_DIR: path.join(scratch, "etc"),
            HIVRA_KEY_DIR: path.join(scratch, "etc", "keys"),
            HIVRA_LOG_DIR: path.join(scratch, "log"),
            HIVRA_UBUNTU_IMG: path.join(scratch, "images", "ubuntu.img"),
            HIVRA_VM_SSH_KEY_PATH: path.join(scratch, "etc", "keys", "vm-orchestrator"),
            HIVRA_UBUNTU_IMG_URL: "https://example.invalid/ubuntu.img",
          } as unknown as NodeJS.ProcessEnv,
          timeout: 20_000,
        });
        expect(run.status).not.toBe(0);
        expect(classifyPreparationFailureCause(run.stderr)).toBe("root_required");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});
