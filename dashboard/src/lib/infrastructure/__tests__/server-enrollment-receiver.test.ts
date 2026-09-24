/** @jest-environment node */

jest.mock("server-only", () => ({}));

import dns from "node:dns";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isServerEnrollmentSupported } from "../server-enrollment-contracts";

import { generateVerifiedEd25519SshKeyPair } from "../ed25519-ssh-key";
import { serverEnrollmentCodeSha256 } from "../server-enrollment-code";
import { receiveServerEnrollmentReport, reportResponseBody } from "../server-enrollment-receiver";
import { SERVER_ENROLL_SCRIPT_VERSION } from "../server-enrollment-script";
import type { TrustedClientAddress } from "../trusted-client-address";

const CODE = "hse1_" + "m".repeat(32);
const SHA = serverEnrollmentCodeSha256(CODE);
const ADMIN = generateVerifiedEd25519SshKeyPair("hivra-enrollment");
const HOST = generateVerifiedEd25519SshKeyPair("host");
const ENROLLMENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-24T12:00:00.000Z");
const PUBLIC: TrustedClientAddress = { address: "203.0.113.20", family: 4 };

const FACTS = {
  hostname: "web-1", osId: "ubuntu", osVersionId: "24.04", architecture: "x86_64", cpuCount: 4,
  memoryBytes: 8 * 1024 ** 3, virtualization: "kvm", proxmoxVersion: null, sshMatchRules: false,
};

function enrolled(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, kind: "enrolled", scriptVersion: SERVER_ENROLL_SCRIPT_VERSION, consent: "terminal",
    facts: FACTS, hostPublicKey: HOST.publicKey, adminKeyFingerprint: ADMIN.fingerprintSha256,
    sshPort: 22, reenrollment: false, ...overrides,
  };
}

function unsupported(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, kind: "unsupported", scriptVersion: SERVER_ENROLL_SCRIPT_VERSION, consent: "terminal",
    facts: { ...FACTS, osId: "debian", osVersionId: "12" }, hostPublicKey: null, adminKeyFingerprint: null,
    sshPort: null, reenrollment: false, ...overrides,
  };
}

function deps(record: Record<string, unknown> | null = {
  enrollmentId: ENROLLMENT_ID, phase: "issued", expiresAt: "2026-09-24T12:10:00.000Z",
  adminKeyFingerprint: ADMIN.fingerprintSha256,
}) {
  return {
    find: jest.fn().mockResolvedValue(record),
    refuse: jest.fn().mockResolvedValue(undefined),
    report: jest.fn().mockResolvedValue({
      status: "accepted", enrollmentId: ENROLLMENT_ID, words: "otter-maple-comet",
      hostFingerprint: HOST.fingerprintSha256, replay: false,
    }),
    admitCode: jest.fn().mockReturnValue(true),
    words: jest.fn().mockReturnValue("otter-maple-comet"),
    now: () => NOW,
    env: {},
    proxmoxSudoAllowed: false,
  };
}

const receive = (body: unknown, d = deps(), observed: TrustedClientAddress = PUBLIC) =>
  receiveServerEnrollmentReport({ code: CODE, rawBody: typeof body === "string" ? body : JSON.stringify(body), observed }, d);

describe("receiveServerEnrollmentReport", () => {
  it("accepts a well-formed report once and answers in the fixed format", async () => {
    const d = deps();
    const outcome = await receive(enrolled(), d);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toBe(
      `HIVRA_ENROLLMENT v1\nstatus=accepted\nenrollment=${ENROLLMENT_ID}\nwords=otter-maple-comet\nhost=${HOST.fingerprintSha256}\n`,
    );
    expect(d.find).toHaveBeenCalledWith(SHA);
    expect(d.report).toHaveBeenCalledTimes(1);
    expect(d.report.mock.calls[0][0]).toEqual(expect.objectContaining({
      codeSha256: SHA, kind: "enrolled", adminKeyFingerprint: ADMIN.fingerprintSha256,
      // The fingerprint is Hivra's own computation, not the server's claim.
      hostPublicKey: HOST.publicKey, hostFingerprint: HOST.fingerprintSha256, sshPort: 22,
      consent: "terminal", reenrollment: false, observedAddress: "203.0.113.20", words: "otter-maple-comet",
    }));
    expect(d.report.mock.calls[0][0].reportDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(d.report.mock.calls)).not.toContain(CODE);
    expect(outcome.log).toEqual({ failureClass: null, scriptVersion: SERVER_ENROLL_SCRIPT_VERSION, addressClass: "public" });
  });

  it("refuses an unknown code before reading the body or the per-code limit (T1)", async () => {
    const d = deps(null);
    const outcome = await receive("{not json", d);
    expect(outcome).toMatchObject({ httpStatus: 401, body: reportResponseBody("not_usable") });
    expect(d.admitCode).not.toHaveBeenCalled();
    expect(d.refuse).not.toHaveBeenCalled();
    expect(d.report).not.toHaveBeenCalled();
  });

  it("applies the per-code limit before parsing (T21)", async () => {
    const d = deps();
    d.admitCode.mockReturnValue(false);
    const outcome = await receive(enrolled(), d);
    expect(outcome).toMatchObject({ httpStatus: 429, body: reportResponseBody("retry") });
    expect(d.report).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{"],
    ["an extra field", { ...enrolled(), extra: 1 }],
    ["a hostile hostname", enrolled({ facts: { ...FACTS, hostname: "web-1; rm -rf /" } })],
    ["an unknown version", enrolled({ version: 2 })],
    ["a host key with a comment", enrolled({ hostPublicKey: HOST.publicKey + " root@web-1" })],
  ])("counts %s as a refused report without spending the code", async (_label, body) => {
    const d = deps();
    const outcome = await receive(body, d);
    expect(outcome).toMatchObject({ httpStatus: 400, body: reportResponseBody("invalid_report") });
    expect(d.refuse).toHaveBeenCalledWith(SHA, "invalid_report");
    expect(d.report).not.toHaveBeenCalled();
  });

  it("refuses an unknown script version and counts it (T31)", async () => {
    const d = deps();
    const outcome = await receive(enrolled({ scriptVersion: "2020.01.01.1" }), d);
    expect(outcome).toMatchObject({ httpStatus: 400, log: { failureClass: "invalid_report", scriptVersion: "2020.01.01.1" } });
    expect(d.refuse).toHaveBeenCalledWith(SHA, "invalid_report");
    expect(d.report).not.toHaveBeenCalled();
  });

  it("refuses a report whose key is not the one Hivra issued with this code", async () => {
    const other = generateVerifiedEd25519SshKeyPair("other");
    const d = deps();
    expect((await receive(enrolled({ adminKeyFingerprint: other.fingerprintSha256 }), d)).httpStatus).toBe(400);
    expect(d.report).not.toHaveBeenCalled();
  });

  it("refuses a malformed host key", async () => {
    const d = deps();
    const zero = "ssh-ed25519 " + Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32)]).toString("base64");
    expect((await receive(enrolled({ hostPublicKey: zero }), d)).httpStatus).toBe(400);
    expect(d.report).not.toHaveBeenCalled();
  });

  it("refuses an IPv6 arrival with ipv4_required, counts it and keeps the code usable (T38)", async () => {
    const d = deps();
    const outcome = await receive(enrolled(), d, { address: "2001:db8::5", family: 6 });
    expect(outcome).toMatchObject({ httpStatus: 422, body: reportResponseBody("ipv4_required"), log: { addressClass: "ipv6" } });
    expect(d.refuse).toHaveBeenCalledWith(SHA, "ipv4_required");
    expect(d.report).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.20", "100.64.0.1", "0.0.0.0"])(
    "refuses a report from the reserved address %s on hosted Hivra (T15, T34)", async address => {
      const d = deps();
      const outcome = await receive(enrolled(), d, { address, family: 4 });
      expect(outcome).toMatchObject({ httpStatus: 422, body: reportResponseBody("private_address"), log: { addressClass: "private" } });
      expect(d.refuse).toHaveBeenCalledWith(SHA, "private_address");
      expect(d.report).not.toHaveBeenCalled();
    },
  );

  it("accepts a report whose address Hivra could not see, with no address kept", async () => {
    const d = deps();
    await receive(enrolled(), d, { address: null, family: null, reason: "cloudflare_edge" });
    expect(d.report.mock.calls[0][0]).toMatchObject({ observedAddress: null });
  });

  it("never resolves or fetches anything the report names (T15)", async () => {
    const lookup = jest.spyOn(dns, "lookup");
    const promisesLookup = jest.spyOn(dns.promises, "lookup");
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    try {
      await receive(enrolled({ facts: { ...FACTS, hostname: "metadata.google.internal" } }));
      expect(lookup).not.toHaveBeenCalled();
      expect(promisesLookup).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      promisesLookup.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("keeps an enrolled report from an unsupported OS as unsupported: no key, no words (T18)", async () => {
    const d = deps();
    d.report.mockResolvedValue({ status: "unsupported", enrollmentId: ENROLLMENT_ID });
    const outcome = await receive(enrolled({ facts: { ...FACTS, osVersionId: "20.04" } }), d);
    expect(outcome).toMatchObject({ httpStatus: 200, body: reportResponseBody("unsupported") });
    expect(d.report.mock.calls[0][0]).toMatchObject({
      kind: "unsupported", hostPublicKey: null, hostFingerprint: null, adminKeyFingerprint: null, sshPort: null, words: null,
    });
    expect(d.words).not.toHaveBeenCalled();
  });

  // Release gate T43: Proxmox launches need a root login for now, so Hivra
  // treats a Proxmox VE report as unsupported (this script version never
  // sends one; only a modified script would).
  it("keeps a Proxmox VE report as unsupported while the gate is off, and enrolled once it opens", async () => {
    const pve = enrolled({ facts: { ...FACTS, osId: "debian", osVersionId: "12", proxmoxVersion: "8.2.4" } });
    const closed = deps();
    await receive(pve, closed);
    expect(closed.report.mock.calls[0][0]).toEqual(expect.objectContaining({ kind: "unsupported", hostPublicKey: null, words: null }));
    const open = { ...deps(), proxmoxSudoAllowed: true };
    await receive(pve, open);
    expect(open.report.mock.calls[0][0]).toEqual(expect.objectContaining({ kind: "enrolled", hostPublicKey: HOST.publicKey }));
  });

  it("decides support from the same table the script's tests use", () => {
    const cases = JSON.parse(readFileSync(join(__dirname, "../../../../bootstrap/server-enroll-support-cases.json"), "utf8")) as
      Array<{ osId: string | null; osVersionId: string | null; architecture: string | null; proxmoxVersion: string | null; supported: boolean }>;
    expect(cases.length).toBeGreaterThan(10);
    for (const { supported, ...facts } of cases) {
      expect([facts, isServerEnrollmentSupported(facts, { proxmoxSudoAllowed: false })]).toEqual([facts, supported]);
    }
  });

  it("records an unsupported report with its facts", async () => {
    const d = deps();
    d.report.mockResolvedValue({ status: "unsupported", enrollmentId: ENROLLMENT_ID });
    expect((await receive(unsupported(), d)).httpStatus).toBe(200);
    expect(d.report.mock.calls[0][0]).toMatchObject({ kind: "unsupported", facts: { osId: "debian" } });
  });

  it("acknowledges a byte-identical replay the database recognised, and logs it as a replay (T3)", async () => {
    const d = deps({ enrollmentId: ENROLLMENT_ID, phase: "reported", expiresAt: "2026-09-24T12:10:00.000Z", adminKeyFingerprint: ADMIN.fingerprintSha256 });
    d.report.mockResolvedValue({
      status: "accepted", enrollmentId: ENROLLMENT_ID, words: "otter-maple-comet", hostFingerprint: HOST.fingerprintSha256, replay: true,
    });
    const outcome = await receive(enrolled(), d);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.log.failureClass).toBe("replay");
  });

  it("refuses a different second report after the code was spent, changing nothing (T2)", async () => {
    const d = deps({ enrollmentId: ENROLLMENT_ID, phase: "reported", expiresAt: "2026-09-24T12:10:00.000Z", adminKeyFingerprint: ADMIN.fingerprintSha256 });
    d.report.mockResolvedValue({ status: "not_usable" });
    const outcome = await receive(enrolled({ sshPort: 2222 }), d);
    expect(outcome).toMatchObject({ httpStatus: 401, body: reportResponseBody("not_usable") });
    expect(d.refuse).not.toHaveBeenCalled();
  });

  it("refuses an expired code without counting or reporting anything (T23)", async () => {
    const d = deps({ enrollmentId: ENROLLMENT_ID, phase: "issued", expiresAt: "2026-09-24T11:59:59.000Z", adminKeyFingerprint: ADMIN.fingerprintSha256 });
    const outcome = await receive(enrolled(), d);
    expect(outcome).toMatchObject({ httpStatus: 401, log: { failureClass: "expired" } });
    expect(d.refuse).not.toHaveBeenCalled();
    expect(d.report).not.toHaveBeenCalled();
    const invalid = await receive("{", d);
    expect(invalid.httpStatus).toBe(401);
    expect(d.refuse).not.toHaveBeenCalled();
  });

  it("never puts anything the server sent into its response", async () => {
    const outcome = await receive(enrolled({ facts: { ...FACTS, hostname: "evil-host" } }));
    expect(outcome.body).not.toContain("evil-host");
    for (const line of outcome.body.trimEnd().split("\n")) {
      expect(line).toMatch(/^(HIVRA_ENROLLMENT v1|status=[a-z_]+|enrollment=[0-9a-f-]{36}|words=[a-z]+-[a-z]+-[a-z]+|host=SHA256:[A-Za-z0-9+/]{43})$/);
    }
  });
});
