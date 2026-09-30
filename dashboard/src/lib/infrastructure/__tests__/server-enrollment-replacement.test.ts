/** @jest-environment node */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  ...jest.requireActual("@/lib/services/proxmox-instance-service"),
  runProxmoxHostScript: jest.fn(),
}));

const store = {
  issueServerEnrollmentRecord: jest.fn(),
  getServerEnrollmentRow: jest.fn(),
  listServerEnrollmentRows: jest.fn(),
  findKnownServer: jest.fn(),
  loadServerEnrollmentAdminKey: jest.fn(),
  sealServerEnrollmentAdminKey: jest.fn(),
  confirmServerEnrollmentRecord: jest.fn(),
  beginServerEnrollmentReplacement: jest.fn(),
  completeServerEnrollmentReplacement: jest.fn(),
  failServerEnrollmentReplacement: jest.fn(),
  declineServerEnrollmentRecord: jest.fn(),
  cancelServerEnrollmentRecord: jest.fn(),
  recordServerEnrollmentFetch: jest.fn(),
};
jest.mock("../server-enrollment-store", () => ({
  ...jest.requireActual("../server-enrollment-store"),
  ...Object.fromEntries(Object.keys(store).map(name => [name, (...args: unknown[]) => store[name as keyof typeof store](...args)])),
}));
const connections = {
  getInfrastructureConnection: jest.fn(),
  loadInfrastructureConnectionSecret: jest.fn(),
  sealConnectionPrivateKey: jest.fn(),
};
jest.mock("../connection-store", () => ({
  ...jest.requireActual("../connection-store"),
  getInfrastructureConnection: (...args: unknown[]) => connections.getInfrastructureConnection(...args),
  loadInfrastructureConnectionSecret: (...args: unknown[]) => connections.loadInfrastructureConnectionSecret(...args),
  sealConnectionPrivateKey: (...args: unknown[]) => connections.sealConnectionPrivateKey(...args),
}));
const mockResolve = jest.fn();
jest.mock("../connection-runtime", () => ({
  ...jest.requireActual("../connection-runtime"),
  resolveValidatedSshDestination: (...args: unknown[]) => mockResolve(...args),
}));

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { accountCode } from "@/lib/account-code";

import { InfrastructureNetworkError } from "../connection-runtime";
import { generateVerifiedEd25519SshKeyPair } from "../ed25519-ssh-key";
import { SERVER_ENROLLMENT_CODE_PATTERN, serverEnrollmentCodeSha256 } from "../server-enrollment-code";
import type { KnownServer } from "../server-enrollment-contracts";
import {
  confirmServerEnrollment,
  issueServerEnrollment,
  REPLACEMENT_PROBE_MARKER,
  REPLACEMENT_PROBE_SCRIPT,
  replaceServerEnrollmentAccess,
  ServerEnrollmentError,
} from "../server-enrollment-service";
import type { ServerEnrollmentRow } from "../server-enrollment-store";

const USER = "user_2abcDEF123";
const ENROLLMENT_ID = "66666666-6666-4666-8666-666666666666";
const CONNECTION_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-09-24T12:00:00.000Z");
const HOST = generateVerifiedEd25519SshKeyPair("host");
const ADMIN = generateVerifiedEd25519SshKeyPair("hivra-enrollment");
const PINNED_HEX = "ab".repeat(32);
const BODY = "hse_x() {\n  :\n}\n";

function row(overrides: Partial<ServerEnrollmentRow> = {}): ServerEnrollmentRow {
  return {
    id: ENROLLMENT_ID, user_id: USER, phase: "reported", issued_at: "2026-09-24T11:50:00.000Z",
    expires_at: "2026-09-24T12:05:00.000Z", script_version: "2026.09.24.1", admin_public_key: ADMIN.publicKey,
    admin_key_fingerprint: ADMIN.fingerprintSha256, script_fetches: 1, last_fetched_at: "2026-09-24T11:51:00.000Z",
    refused_reports: 0, last_refusal: null, last_refused_at: null, report_kind: "enrolled",
    reported_at: "2026-09-24T11:52:00.000Z", confirm_by: "2026-09-24T12:22:00.000Z", observed_address: "203.0.113.30",
    ssh_port: 22, host_public_key: HOST.publicKey, host_fingerprint_sha256: HOST.fingerprintSha256,
    facts: { hostname: "web-1", osId: "ubuntu", osVersionId: "24.04", architecture: "x86_64", cpuCount: 2,
      memoryBytes: 4_294_967_296, virtualization: "kvm", proxmoxVersion: null, sshMatchRules: false },
    consent: "terminal", reenrollment: false, words: "otter-maple-comet", replacement_attempts: 0,
    replacement_lease_expires_at: null, last_replacement_failure: null, decided_at: null, outcome: null,
    replaced_from_revision: null, connection_id: null, ...overrides,
  };
}

function known(overrides: Partial<KnownServer> = {}): KnownServer {
  return {
    connectionId: CONNECTION_ID, connectionName: "web-1", connectionRevision: 4, provider: "host",
    sshUser: "hivra", sshHost: "203.0.113.30", offer: "replace_key", reason: null, ...overrides,
  };
}

const loaded = (overrides: Record<string, unknown> = {}) => ({
  id: CONNECTION_ID, provider: "host", revision: 4,
  endpoint: { sshHost: "web-1.example", sshPort: 2222, sshUser: "hivra", sshHostFingerprintSha256: PINNED_HEX, sshPrivilege: "sudo" },
  credentials: { sshPrivateKey: "old-private-key" }, ...overrides,
});

function probeOk(uid = "0", proxmox = "0") {
  return { ok: true, stdout: `${REPLACEMENT_PROBE_MARKER} ${uid} ${proxmox}\n`, stderr: "" };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://hivra.example";
  store.getServerEnrollmentRow.mockResolvedValue(row());
  store.findKnownServer.mockResolvedValue(known());
  store.loadServerEnrollmentAdminKey.mockResolvedValue("new-private-key");
  store.sealServerEnrollmentAdminKey.mockReturnValue("sealed-admin-key");
  store.beginServerEnrollmentReplacement.mockResolvedValue({ outcome: "begun", attempt: 1 });
  store.completeServerEnrollmentReplacement.mockResolvedValue({ outcome: "replaced", connectionId: CONNECTION_ID });
  store.failServerEnrollmentReplacement.mockResolvedValue(undefined);
  store.confirmServerEnrollmentRecord.mockResolvedValue({ outcome: "connected", connectionId: CONNECTION_ID });
  store.issueServerEnrollmentRecord.mockResolvedValue({ outcome: "issued", enrollmentId: ENROLLMENT_ID });
  connections.loadInfrastructureConnectionSecret.mockResolvedValue(loaded());
  connections.getInfrastructureConnection.mockResolvedValue({ id: CONNECTION_ID });
  connections.sealConnectionPrivateKey.mockImplementation((key: string) => "sealed:" + key);
  mockResolve.mockResolvedValue({ hostname: "web-1.example", address: "203.0.113.30", family: 4 });
});

afterAll(() => { delete process.env.NEXT_PUBLIC_APP_URL; });

describe("issueServerEnrollment (T1, T4, T5, T25)", () => {
  it("returns the command once, with the owner's account code and the download's own sha256", async () => {
    store.getServerEnrollmentRow.mockResolvedValue(row({ phase: "issued", report_kind: null, reported_at: null, confirm_by: null,
      observed_address: null, ssh_port: null, host_public_key: null, host_fingerprint_sha256: null, facts: null, consent: null,
      reenrollment: null, words: null, script_fetches: 0, last_fetched_at: null }));
    const reachable = jest.fn().mockResolvedValue(true);
    const issued = await issueServerEnrollment(USER, {}, { reachable, body: async () => BODY, now: () => NOW });

    const code = /Bearer (hse1_[a-z2-7]{32})'/.exec(issued.command)?.[1];
    expect(code).toMatch(SERVER_ENROLLMENT_CODE_PATTERN);
    expect(issued.accountCode).toBe(accountCode(USER));
    expect(issued.finalLine).toContain(`'${code}'`);
    expect(issued.finalLine).toContain(`'${accountCode(USER)}' HIVRA_END_V1; }`);
    expect(issued.downloadSha256).toBe(createHash("sha256").update(BODY + issued.finalLine + "\n").digest("hex"));
    expect(reachable).toHaveBeenCalledWith("https://hivra.example");
    // The store gets the hash and a sealed key, never the code or the private key.
    const record = store.issueServerEnrollmentRecord.mock.calls[0][0];
    expect(record.codeSha256).toBe(serverEnrollmentCodeSha256(code!));
    expect(record.sealedAdminPrivateKey).toBe("sealed-admin-key");
    expect(JSON.stringify(store.issueServerEnrollmentRecord.mock.calls)).not.toContain(code!);
    expect(JSON.stringify(store.issueServerEnrollmentRecord.mock.calls)).not.toContain("PRIVATE KEY");
    // The enrollment view never carries the code.
    expect(JSON.stringify(issued.enrollment)).not.toContain(code!);
  });

  it("says unavailable, issuing nothing, when the report endpoint can't be reached", async () => {
    await expect(issueServerEnrollment(USER, {}, { reachable: async () => false, body: async () => BODY }))
      .rejects.toEqual(new ServerEnrollmentError("unavailable"));
    process.env.NEXT_PUBLIC_APP_URL = "";
    await expect(issueServerEnrollment(USER, {}, { reachable: async () => true, body: async () => BODY }))
      .rejects.toEqual(new ServerEnrollmentError("unavailable"));
    expect(store.issueServerEnrollmentRecord).not.toHaveBeenCalled();
  });

  it("passes the database's limits through", async () => {
    store.issueServerEnrollmentRecord.mockResolvedValue({ outcome: "active_limit" });
    await expect(issueServerEnrollment(USER, {}, { reachable: async () => true, body: async () => BODY }))
      .rejects.toEqual(new ServerEnrollmentError("active_limit"));
  });
});

describe("confirmServerEnrollment (T2, T15, T22, T30)", () => {
  beforeEach(() => store.findKnownServer.mockResolvedValue(null));

  it("creates one pinned connection at the observed address, and runs nothing on the server", async () => {
    await confirmServerEnrollment(USER, ENROLLMENT_ID, {}, NOW);
    expect(store.confirmServerEnrollmentRecord).toHaveBeenCalledWith({
      userId: USER, enrollmentId: ENROLLMENT_ID, sshHost: "203.0.113.30", connectionName: "web-1",
      encryptedBundle: "sealed:new-private-key",
    });
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("refuses Yes for an identity this account already connected, changing nothing", async () => {
    store.findKnownServer.mockResolvedValue(known());
    await expect(confirmServerEnrollment(USER, ENROLLMENT_ID, {}, NOW)).rejects.toEqual(new ServerEnrollmentError("known_identity"));
    expect(store.confirmServerEnrollmentRecord).not.toHaveBeenCalled();
  });

  it("asks for an address when Hivra saw none or saw a reserved one", async () => {
    for (const observed of [null, "10.240.0.4", "2001:db8::4"]) {
      store.getServerEnrollmentRow.mockResolvedValue(row({ observed_address: observed }));
      await expect(confirmServerEnrollment(USER, ENROLLMENT_ID, {}, NOW)).rejects.toEqual(new ServerEnrollmentError("address_required"));
    }
    expect(store.confirmServerEnrollmentRecord).not.toHaveBeenCalled();
  });

  it("runs an owner-entered address through the SSRF resolver", async () => {
    await confirmServerEnrollment(USER, ENROLLMENT_ID, { sshHost: "web-1.example" }, NOW);
    expect(mockResolve).toHaveBeenCalledWith("web-1.example");
    expect(store.confirmServerEnrollmentRecord).toHaveBeenCalledWith(expect.objectContaining({ sshHost: "web-1.example" }));
    mockResolve.mockRejectedValue(new InfrastructureNetworkError("ssh_host_forbidden", "no"));
    store.confirmServerEnrollmentRecord.mockClear();
    await expect(confirmServerEnrollment(USER, ENROLLMENT_ID, { sshHost: "metadata.internal" }, NOW))
      .rejects.toEqual(new ServerEnrollmentError("address_blocked"));
    await expect(confirmServerEnrollment(USER, ENROLLMENT_ID, { sshHost: "http://x/" }, NOW))
      .rejects.toEqual(new ServerEnrollmentError("address_invalid"));
    expect(store.confirmServerEnrollmentRecord).not.toHaveBeenCalled();
  });

  it("refuses a report that is no longer waiting, or past its deadline (T23)", async () => {
    store.getServerEnrollmentRow.mockResolvedValue(row({ confirm_by: "2026-09-24T11:59:59.000Z" }));
    await expect(confirmServerEnrollment(USER, ENROLLMENT_ID, {}, NOW)).rejects.toEqual(new ServerEnrollmentError("not_pending"));
    store.getServerEnrollmentRow.mockResolvedValue(row({ phase: "confirmed" }));
    await expect(confirmServerEnrollment(USER, ENROLLMENT_ID, {}, NOW)).rejects.toEqual(new ServerEnrollmentError("not_pending"));
    store.getServerEnrollmentRow.mockResolvedValue(null);
    await expect(confirmServerEnrollment(USER, ENROLLMENT_ID, {}, NOW)).rejects.toEqual(new ServerEnrollmentError("not_found"));
  });
});

describe("replaceServerEnrollmentAccess (T30, T46)", () => {
  const request = { connectionId: CONNECTION_ID, connectionRevision: 4 };
  const run = jest.fn();
  const deps = (proxmoxSudoAllowed = false) => ({ run, resolve: mockResolve, now: () => NOW, newRunId: () => "run-1",
    proxmoxSudoAllowed });

  function expectNothingChanged(failure: string | null) {
    expect(store.completeServerEnrollmentReplacement).not.toHaveBeenCalled();
    expect(connections.sealConnectionPrivateKey).not.toHaveBeenCalled();
    if (failure) {
      expect(store.failServerEnrollmentReplacement).toHaveBeenCalledWith({
        userId: USER, enrollmentId: ENROLLMENT_ID, runId: "run-1", failure,
      });
    }
  }

  beforeEach(() => run.mockReset().mockResolvedValue(probeOk()));

  it("signs in with the pinned key, user hivra and the new key through sudo before changing anything", async () => {
    await replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps());
    expect(mockResolve).toHaveBeenCalledWith("web-1.example");
    const [script, env] = run.mock.calls[0];
    expect(script).toContain(REPLACEMENT_PROBE_MARKER);
    expect(env).toMatchObject({
      HIVRA_USER_INFRA_CONNECTION: "true", PROXMOX_SSH_USER: "hivra", PROXMOX_SSH_PORT: "2222",
      PROXMOX_SSH_PRIVATE_KEY: "new-private-key", PROXMOX_SSH_PRIVILEGE: "sudo", PROXMOX_SSH_HOST_KEY_TYPE: "ssh-ed25519",
    });
    expect(String(env.PROXMOX_SSH_HOST_FINGERPRINT).toLowerCase().replace(/[^0-9a-f]/g, "")).toContain("ab".repeat(32));
    expect(store.beginServerEnrollmentReplacement).toHaveBeenCalledWith({
      userId: USER, enrollmentId: ENROLLMENT_ID, connectionId: CONNECTION_ID, expectedRevision: 4, mode: "key", runId: "run-1",
    });
    // Key mode moves only the key, by credential recovery in SQL.
    expect(store.completeServerEnrollmentReplacement).toHaveBeenCalledWith({
      userId: USER, enrollmentId: ENROLLMENT_ID, runId: "run-1", encryptedBundle: "sealed:new-private-key", sshHost: null,
    });
    expect(store.failServerEnrollmentReplacement).not.toHaveBeenCalled();
  });

  it.each([
    ["a different host key", { ok: false, stdout: "", stderr: "", error: "SSH connection failed: Handshake failed", presentedHostFingerprintSha256: "cd".repeat(32) }, "host_key_mismatch"],
    ["refused authentication", { ok: false, stdout: "", stderr: "", error: "SSH connection failed: All configured authentication methods failed" }, "authentication_failed"],
    ["no sudo sentinel", { ok: false, stdout: "", stderr: "", error: "sudo needs a password", sudoFailure: { kind: "password_required" } }, "sudo_unavailable"],
    ["a UID other than 0", probeOk("1000"), "not_root"],
    ["no probe line", { ok: true, stdout: "hello\n", stderr: "" }, "not_root"],
    ["a probe line without the Proxmox answer", { ok: true, stdout: `${REPLACEMENT_PROBE_MARKER} 0\n`, stderr: "" }, "not_root"],
    ["a dropped connection", { ok: false, stdout: "", stderr: "", error: "SSH connection failed: ECONNRESET" }, "connection_failed"],
  ])("changes nothing when the check meets %s", async (_label, result, failure) => {
    run.mockResolvedValue(result);
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps()))
      .rejects.toEqual(new ServerEnrollmentError("verification_failed", failure as never));
    expectNothingChanged(failure);
  });

  it("changes nothing when the address no longer resolves safely", async () => {
    mockResolve.mockRejectedValue(new InfrastructureNetworkError("ssh_host_forbidden", "no"));
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps()))
      .rejects.toEqual(new ServerEnrollmentError("verification_failed", "connection_failed"));
    expect(run).not.toHaveBeenCalled();
    expectNothingChanged("connection_failed");
  });

  it.each([
    ["no match", null],
    ["a login connection in use", known({ offer: "none", reason: "login_in_use", sshUser: "root" })],
    ["a Proxmox VE server while the gate is off", known({ offer: "none", reason: "proxmox_needs_root" })],
    ["a Proxmox connection (root login, Proxmox lane)", known({ offer: "none", reason: "proxmox_connection", provider: "proxmox", sshUser: "root" })],
    ["a Hetzner Cloud server", known({ offer: "none", reason: "hetzner", provider: "hetzner-cloud" })],
    ["several matches", known({ offer: "none", reason: "multiple" })],
  ])("offers no Replace for %s and opens no SSH connection", async (_label, match) => {
    store.findKnownServer.mockResolvedValue(match);
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps()))
      .rejects.toEqual(new ServerEnrollmentError("replace_not_offered"));
    expect(run).not.toHaveBeenCalled();
    expect(store.beginServerEnrollmentReplacement).not.toHaveBeenCalled();
  });

  it("refuses a stale revision before any SSH", async () => {
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, { ...request, connectionRevision: 3 }, deps()))
      .rejects.toEqual(new ServerEnrollmentError("connection_changed"));
    connections.loadInfrastructureConnectionSecret.mockResolvedValue(loaded({ revision: 5 }));
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps()))
      .rejects.toEqual(new ServerEnrollmentError("connection_changed"));
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["busy", "attempts_exhausted", "operation_running", "agents_bound", "connection_changed"] as const)(
    "stops before SSH when the database refuses the lease (%s)", async outcome => {
      store.beginServerEnrollmentReplacement.mockResolvedValue({ outcome });
      await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps()))
        .rejects.toEqual(new ServerEnrollmentError(outcome));
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("never lets a key-only Replace move the address", async () => {
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, { ...request, sshHost: "203.0.113.99" }, deps()))
      .rejects.toEqual(new ServerEnrollmentError("address_invalid"));
    expect(run).not.toHaveBeenCalled();
  });

  it("switches a root login to hivra at an owner-chosen address, after the same check", async () => {
    store.findKnownServer.mockResolvedValue(known({ offer: "switch_user", sshUser: "root" }));
    connections.loadInfrastructureConnectionSecret.mockResolvedValue(loaded({
      endpoint: { sshHost: "old.example", sshPort: 22, sshUser: "root", sshHostFingerprintSha256: PINNED_HEX, sshPrivilege: "login" },
    }));
    await replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, { ...request, sshHost: "web-1.example" }, deps());
    expect(store.beginServerEnrollmentReplacement).toHaveBeenCalledWith(expect.objectContaining({ mode: "switch" }));
    expect(run.mock.calls[0][1]).toMatchObject({ PROXMOX_SSH_USER: "hivra", PROXMOX_SSH_PRIVILEGE: "sudo" });
    expect(store.completeServerEnrollmentReplacement).toHaveBeenCalledWith(expect.objectContaining({ sshHost: "web-1.example" }));
  });

  // Review finding 4: the latest inspection can be missing or stale, so the
  // verification probe itself asks whether the server runs Proxmox VE.
  it("refuses a switch when the probe finds Proxmox VE while the gate is off, changing nothing", async () => {
    store.findKnownServer.mockResolvedValue(known({ offer: "switch_user", sshUser: "root" }));
    connections.loadInfrastructureConnectionSecret.mockResolvedValue(loaded({
      endpoint: { sshHost: "pve.example", sshPort: 22, sshUser: "root", sshHostFingerprintSha256: PINNED_HEX, sshPrivilege: "login" },
    }));
    run.mockResolvedValue(probeOk("0", "1"));
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps()))
      .rejects.toEqual(new ServerEnrollmentError("verification_failed", "proxmox_needs_root"));
    expectNothingChanged("proxmox_needs_root");
    // Once Proxmox launches may run through sudo, the same switch goes ahead.
    jest.clearAllMocks();
    run.mockResolvedValue(probeOk("0", "1"));
    await replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps(true));
    expect(store.completeServerEnrollmentReplacement).toHaveBeenCalled();
  });

  it("lets a key-only Replace through on Proxmox VE: it keeps the privilege the connection already has", async () => {
    run.mockResolvedValue(probeOk("0", "1"));
    await replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps());
    expect(store.completeServerEnrollmentReplacement).toHaveBeenCalled();
  });

  it("the probe is read-only and asks /etc/pve and pveversion itself", () => {
    expect(REPLACEMENT_PROBE_SCRIPT).toContain("[ -d /etc/pve ] || command -v pveversion");
    // No command that changes anything, and output goes nowhere but stdout.
    expect(REPLACEMENT_PROBE_SCRIPT).not.toMatch(/\b(rm|mv|cp|tee|touch|chmod|chown|useradd|userdel|apt|systemctl)\b|>(?!\/dev\/null|&)/);
    const local = spawnSync("bash", ["--noprofile", "--norc", "-s"], { input: REPLACEMENT_PROBE_SCRIPT, encoding: "utf8" });
    expect(local.stdout).toMatch(new RegExp(`^${REPLACEMENT_PROBE_MARKER} [0-9]+ [01]\n$`));
  });

  it("releases the lease when the swap loses a race", async () => {
    store.completeServerEnrollmentReplacement.mockResolvedValue({ outcome: "lease_lost" });
    await expect(replaceServerEnrollmentAccess(USER, ENROLLMENT_ID, request, deps()))
      .rejects.toEqual(new ServerEnrollmentError("connection_changed"));
    expect(store.failServerEnrollmentReplacement).toHaveBeenCalledWith(expect.objectContaining({ failure: "connection_changed" }));
  });
});
