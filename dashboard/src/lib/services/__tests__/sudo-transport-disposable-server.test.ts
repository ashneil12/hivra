/**
 * @jest-environment node
 *
 * Opt-in live check of the real runner against a disposable server
 * (docs/superpowers/specs/2026-09-24-server-enrollment-command.md, 9.2 and 15).
 * Skipped unless HIVRA_DISPOSABLE_SUDO_SERVER names a JSON file:
 *
 *   { "host": "<public IPv4>", "hostFingerprintSha256Hex": "<64 hex>",
 *     "adminPrivateKeyPath": "…", "loginPrivateKeyPath": "…" }
 *
 * The server must have been enrolled by `scripts/test-server-enroll-host.py
 * --enroll-for-runner <admin public key> --login-key <login public key>`,
 * which also creates hsepw (sudo needs a password), hselimited (sudo allows
 * only /usr/bin/true) and hseops (passwordless sudo) with the login key.
 * Nothing here runs against anything else: the SSRF rules still apply, and the
 * database is replaced by in-memory fakes. gVisor Prepare installs Docker and
 * gVisor on that server.
 */
import { readFileSync } from "node:fs";

jest.mock("server-only", () => ({}));

const committed: Array<{ name: string; args: Record<string, unknown> }> = [];
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (name: string, args: Record<string, unknown>) => ({
      single: async () => {
        committed.push({ name, args });
        return { data: { id: "target", ...(args.p_target as object) }, error: null };
      },
    }),
  },
}));

const store = {
  connection: null as unknown,
  snapshot: null as unknown,
};
jest.mock("@/lib/infrastructure/connection-store", () => ({
  ...jest.requireActual("@/lib/infrastructure/connection-store"),
  loadInfrastructureConnectionSecret: async () => store.connection,
  beginInfrastructureConnectionPreparation: async () => true,
  beginInfrastructureConnectionPreflight: async () => true,
  completeInfrastructureConnectionPreflight: async () => true,
}));
// Every host script result, so a failure says what the server answered.
const results: Array<{ script: string; ok: boolean; error?: string; stderr: string; stdout: string }> = [];
jest.mock("@/lib/services/proxmox-instance-service", () => {
  const actual = jest.requireActual("@/lib/services/proxmox-instance-service");
  return {
    ...actual,
    runProxmoxHostScript: async (...args: Parameters<typeof actual.runProxmoxHostScript>) => {
      const result = await actual.runProxmoxHostScript(...args);
      results.push({ script: String(args[0]).slice(0, 80), ok: result.ok, error: result.error,
        stderr: String(result.stderr).slice(-2_000), stdout: String(result.stdout).slice(-1_000) });
      return result;
    },
  };
});
jest.mock("@/lib/infrastructure/host-authority", () => ({
  ...jest.requireActual("@/lib/infrastructure/host-authority"),
  loadCurrentHostDiscoverySnapshot: async () => store.snapshot,
}));

import type { LoadedInfrastructureConnection } from "@/lib/infrastructure/connection-store";
import { buildUserProxmoxEnvironment, resolveValidatedSshDestination } from "@/lib/infrastructure/connection-runtime";
import { discoverInfrastructureHost } from "@/lib/infrastructure/host-discovery";
import type { HostDiscoverySnapshot } from "@/lib/infrastructure/host-discovery-contracts";
import { hostDiscoveryOutcome } from "@/lib/infrastructure/host-discovery-outcome";
import { verifyEnrollmentKeyOnServer } from "@/lib/infrastructure/server-enrollment-service";
import { preflightGvisorTarget } from "@/lib/infrastructure/gvisor-target";
import { prepareGvisorHost } from "@/lib/hivra/gvisor-computer-service";
import { HIVRA_GVISOR_BUNDLE_SHA256 } from "@/lib/hivra/gvisor-computer-contract";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { createHash, randomBytes } from "node:crypto";

type Config = { host: string; hostFingerprintSha256Hex: string; adminPrivateKeyPath: string; loginPrivateKeyPath: string };
const configPath = process.env.HIVRA_DISPOSABLE_SUDO_SERVER;
const config: Config | null = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const live = config ? describe : describe.skip;
const CONNECTION_ID = "00000000-0000-4000-8000-00000000c001";

function connection(overrides: { sshUser: string; sshPrivilege: "login" | "sudo"; key: string; fingerprint?: string }):
  LoadedInfrastructureConnection {
  return {
    id: CONNECTION_ID, userId: "disposable-owner", name: "disposable", provider: "host", operatingMode: "self-managed",
    setupMode: "simple", status: "pending", revision: 1, pendingBindingRebindFromRevision: null,
    endpoint: {
      sshHost: config!.host, sshPort: 22, sshUser: overrides.sshUser,
      sshHostFingerprintSha256: overrides.fingerprint ?? config!.hostFingerprintSha256Hex,
      ...(overrides.sshPrivilege === "sudo" ? { sshPrivilege: "sudo" as const } : {}),
      sshHostKeyType: "ssh-ed25519" as const,
    },
    configuration: null, credentials: { sshPrivateKey: readFileSync(overrides.key, "utf8") },
    lastCheckedAt: null, lastErrorCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as unknown as LoadedInfrastructureConnection;
}

async function discover(target: LoadedInfrastructureConnection) {
  let snapshot: HostDiscoverySnapshot | null = null;
  const result = await discoverInfrastructureHost("disposable-owner", CONNECTION_ID, {
    loadConnection: async () => target,
    beginDiscovery: async () => true,
    completeDiscovery: async (input: { snapshot: HostDiscoverySnapshot }) => {
      snapshot = input.snapshot;
      return true;
    },
    releaseDiscovery: async () => true,
    recordIdentityMismatch: async () => undefined,
    enrolledFacts: async () => null,
  } as never);
  return { result, snapshot: snapshot as HostDiscoverySnapshot | null };
}

async function env(target: LoadedInfrastructureConnection) {
  const destination = await resolveValidatedSshDestination(target.endpoint.sshHost);
  return buildUserProxmoxEnvironment({
    id: target.id, sshHost: target.endpoint.sshHost, sshPort: target.endpoint.sshPort, sshUser: target.endpoint.sshUser,
    sshHostFingerprintSha256: target.endpoint.sshHostFingerprintSha256!, sshPrivateKey: target.credentials.sshPrivateKey,
    sshPrivilege: target.endpoint.sshPrivilege, sshHostKeyType: target.endpoint.sshHostKeyType,
  }, destination);
}

live("the real runner against a disposable enrolled server", () => {
  jest.setTimeout(15 * 60_000);
  const hivraSudo = () => connection({ sshUser: "hivra", sshPrivilege: "sudo", key: config!.adminPrivateKeyPath });

  it("inspects through the sudo transport: root, privilegeVia sudo, Linux Sandbox after a short setup", async () => {
    const { result, snapshot } = await discover(hivraSudo());
    expect(result.ok).toBe(true);
    expect(snapshot?.contractVersion).toBe(2);
    expect(snapshot?.host.environment).toMatchObject({ effectivePrivilege: "root", privilegeVia: "sudo" });
    expect(snapshot?.host.os.id).toBe("ubuntu");
    expect(hostDiscoveryOutcome(snapshot!, { sshUser: "hivra", proxmoxSudoAllowed: false }).action)
      .toMatch(/^(review-gvisor-setup|check-gvisor)$/);
    store.snapshot = snapshot;
    console.log("discovery", JSON.stringify({ os: snapshot?.host.os, kernel: snapshot?.host.kernel,
      environment: snapshot?.host.environment }));
  });

  it("the same user signed in without the transport is non-root with passwordless sudo: Use sudo for setup", async () => {
    const { snapshot } = await discover(connection({ sshUser: "hivra", sshPrivilege: "login", key: config!.adminPrivateKeyPath }));
    expect(snapshot?.host.environment).toMatchObject({ effectivePrivilege: "non-root", privilegeVia: "login", passwordlessSudo: true });
    expect(hostDiscoveryOutcome(snapshot!, { sshUser: "hivra" }).action).toBe("use-sudo");
  });

  it("a user whose sudo needs a password: no passwordless sudo when signed in, the password copy through the transport", async () => {
    const { snapshot } = await discover(connection({ sshUser: "hsepw", sshPrivilege: "login", key: config!.loginPrivateKeyPath }));
    expect(snapshot?.host.environment).toMatchObject({ effectivePrivilege: "non-root", passwordlessSudo: false });
    expect(hostDiscoveryOutcome(snapshot!, { sshUser: "hsepw" })).toMatchObject({ action: "use-setup-command",
      title: "Signed in as hsepw without passwordless sudo." });
    const { result } = await discover(connection({ sshUser: "hsepw", sshPrivilege: "sudo", key: config!.loginPrivateKeyPath }));
    expect(result).toMatchObject({ ok: false, error: { code: "SSH_SUDO_UNAVAILABLE",
      message: "Hivra signed in as hsepw, but sudo wouldn't run without a password." } });
  });

  it("a sudo rule for other commands only gets the sudoers-rule copy", async () => {
    const { result } = await discover(connection({ sshUser: "hselimited", sshPrivilege: "sudo", key: config!.loginPrivateKeyPath }));
    expect(result).toMatchObject({ ok: false, error: { code: "SSH_SUDO_UNAVAILABLE", message: "sudo on this server wouldn't run Hivra's command." } });
  });

  it("refuses a server that presents another key before authenticating, and shows both fingerprints (T17)", async () => {
    const { result } = await discover(connection({ sshUser: "hivra", sshPrivilege: "sudo", key: config!.adminPrivateKeyPath,
      fingerprint: "ab".repeat(32) }));
    const presented = "SHA256:" + Buffer.from(config!.hostFingerprintSha256Hex, "hex").toString("base64").replace(/=+$/, "");
    expect(result).toMatchObject({ ok: false, error: { code: "SSH_HOST_KEY_MISMATCH", hostKey: { presented } } });
  });

  // The runner's stdin is a string (UTF-8 on the wire, at most 1 MB), so 600
  // KB of random bytes travel as latin1 text and come back to bytes on the
  // server. scripts/test-server-enroll-host.py sends 1 MB of raw bytes.
  it("carries binary stdin byte for byte through the real runner (T29)", async () => {
    const data = randomBytes(600 * 1024).toString("latin1");
    const result = await runProxmoxHostScriptWithStdin(
      "set -Eeuo pipefail\nprintf 'SHA %s\\n' \"$(LC_ALL=C iconv -f utf-8 -t latin1 | sha256sum | cut -d' ' -f1)\"\nid -u\n",
      data, await env(hivraSudo()), { timeoutMs: 120_000, maxOutputBytes: 4_096 });
    expect(result.ok).toBe(true);
    expect(result.stderr).not.toContain("HIVRA_SUDO_V1");
    expect(result.stdout).toBe(`SHA ${createHash("sha256").update(Buffer.from(data, "latin1")).digest("hex")}\n0\n`);
  });

  it("verifies an enrollment key the way Replace does: pinned key, this key, sudo as UID 0", async () => {
    const run = (key: string) => verifyEnrollmentKeyOnServer({ connectionId: CONNECTION_ID, sshHost: config!.host, sshPort: 22,
      pinnedFingerprint: config!.hostFingerprintSha256Hex, privateKey: readFileSync(key, "utf8"), refuseProxmox: true },
    { run: runProxmoxHostScript, resolve: resolveValidatedSshDestination });
    await expect(run(config!.adminPrivateKeyPath)).resolves.toBeNull();
    await expect(run(config!.loginPrivateKeyPath)).resolves.toBe("authentication_failed");
  });

  it("early finish under sudo: a nohup child outlives the runner closing the channel at the marker (T43)", async () => {
    const stamp = `/tmp/hse-live-t43-${randomBytes(6).toString("hex")}`;
    const started = Date.now();
    const result = await runProxmoxHostScript(
      `nohup bash -c 'sleep 10; date > ${stamp}' >/dev/null 2>&1 &\necho HIVRA_LIVE_T43_MARKER\nsleep 60\n`,
      await env(hivraSudo()), { timeoutMs: 120_000, earlyFinishMarker: "HIVRA_LIVE_T43_MARKER" });
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const check = await runProxmoxHostScript(`test -s ${stamp} && echo PRESENT`, await env(hivraSudo()), { timeoutMs: 60_000 });
    expect(check.stdout).toBe("PRESENT\n");
  });

  it("prepares Linux Sandbox through sudo, then passes the strict readiness check", async () => {
    store.connection = hivraSudo();
    results.length = 0;
    const prepared = await prepareGvisorHost("disposable-owner", CONNECTION_ID);
    expect(prepared.runscSha256).toMatch(/^[0-9a-f]{64}$/);
    try {
      await preflightGvisorTarget("disposable-owner", CONNECTION_ID, HIVRA_GVISOR_BUNDLE_SHA256,
        { runId: prepared.runId, connectionRevision: prepared.connectionRevision });
    } catch (error) {
      throw new Error(`${String(error)}\n${JSON.stringify(results.slice(-2), null, 1)}`);
    }
    const target = committed.find((entry) => entry.name === "commit_hivra_gvisor_target_preflight")?.args.p_target as
      { status: string; capabilities: { runtime: { sha256: string } } };
    expect(target).toMatchObject({ status: "ready", capabilities: { runtime: { sha256: prepared.runscSha256 } } });
    console.log("gvisor", JSON.stringify({ runscSha256: prepared.runscSha256, adapterVersion: prepared.adapterVersion }));
  });
});

it("is opt-in", () => {
  expect(typeof live).toBe("function");
});
