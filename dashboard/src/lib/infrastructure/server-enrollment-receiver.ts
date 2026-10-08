import "server-only";

import { createHash, randomInt } from "node:crypto";
import net from "node:net";

import { enforceRateLimit } from "@/lib/rate-limit";

import { isAllowedSshAddress } from "./connection-runtime";
import { serverEnrollmentCodeSha256 } from "./server-enrollment-code";
import {
  isServerEnrollmentSupported,
  ServerEnrollmentReportSchema,
  type ServerEnrollmentFacts,
} from "./server-enrollment-contracts";
import { SERVER_ENROLL_ACCEPTED_REPORT_VERSIONS } from "./server-enrollment-script";
import { PROXMOX_SUDO_TRANSPORT_READY } from "./sudo-transport-gate";
import {
  findServerEnrollmentForReport,
  refuseServerEnrollmentReport,
  reportServerEnrollment,
} from "./server-enrollment-store";
import { chooseServerEnrollmentWords } from "./server-enrollment-words";
import { canonicalEd25519HostKey } from "./ssh-host-key";
import type { TrustedClientAddress } from "./trusted-client-address";

/** The report acknowledgement is fixed-format text lines the script checks one
 * by one. It never carries anything the script would run or print besides
 * the words and values that match their patterns. */
export function reportResponseBody(status: string, fields: Array<[string, string]> = []): string {
  return ["HIVRA_ENROLLMENT v1", `status=${status}`, ...fields.map(([key, value]) => `${key}=${value}`)].join("\n") + "\n";
}

export type ReportOutcome = {
  httpStatus: 200 | 400 | 401 | 422 | 429;
  body: string;
  /** Allowlisted log fields only: never the code, headers, body, keys or address. */
  log: { failureClass: string | null; scriptVersion: string | null; addressClass: "public" | "private" | "ipv6" | "none" };
};

type Dependencies = {
  find: typeof findServerEnrollmentForReport;
  refuse: typeof refuseServerEnrollmentReport;
  report: typeof reportServerEnrollment;
  admitCode: (codeSha256: string) => boolean;
  words: () => string;
  now: () => Date;
  env: Record<string, string | undefined>;
  /** Release gate T43: whether a Proxmox VE server may enroll through sudo. */
  proxmoxSudoAllowed: boolean;
};

const defaults: Dependencies = {
  find: findServerEnrollmentForReport,
  refuse: refuseServerEnrollmentReport,
  report: reportServerEnrollment,
  admitCode: codeSha256 => enforceRateLimit("server_enrollment_report_code:" + codeSha256, { limit: 12, windowMs: 60_000 }).success,
  words: () => chooseServerEnrollmentWords(max => randomInt(max)),
  now: () => new Date(),
  env: process.env,
  proxmoxSudoAllowed: PROXMOX_SUDO_TRANSPORT_READY,
};

function addressClass(observed: TrustedClientAddress, env: Record<string, string | undefined>): ReportOutcome["log"]["addressClass"] {
  if (observed.address === null) return "none";
  if (observed.family === 6) return "ipv6";
  return isAllowedSshAddress(observed.address, env) ? "public" : "private";
}

/**
 * One report from the setup script. The route has already refused query
 * strings, browser origins, a malformed code, the wrong content type and an
 * oversized or slow body. From here, in order: look up the code's hash, the
 * per-code limit, the strict schema, the script version, the admin key, the
 * host key, the observed address, the support re-check, then one SQL
 * transition that spends the code. A report makes nothing trusted.
 */
export async function receiveServerEnrollmentReport(
  input: { code: string; rawBody: string; observed: TrustedClientAddress },
  dependencies: Partial<Dependencies> = {},
): Promise<ReportOutcome> {
  const deps = { ...defaults, ...dependencies };
  const addresses = addressClass(input.observed, deps.env);
  const outcome = (httpStatus: ReportOutcome["httpStatus"], status: string, failureClass: string | null,
    scriptVersion: string | null = null, fields: Array<[string, string]> = []): ReportOutcome => ({
    httpStatus, body: reportResponseBody(status, fields),
    log: { failureClass, scriptVersion, addressClass: addresses },
  });
  const notUsable = (failureClass: string) => outcome(401, "not_usable", failureClass);

  const codeSha256 = serverEnrollmentCodeSha256(input.code);
  const record = await deps.find(codeSha256);
  if (!record) return notUsable("unknown_code");
  if (!deps.admitCode(codeSha256)) return outcome(429, "retry", "code_rate_limited");
  const usable = record.phase === "issued" && Date.parse(record.expiresAt) > deps.now().getTime();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input.rawBody);
  } catch {
    parsedJson = undefined;
  }
  const parsed = ServerEnrollmentReportSchema.safeParse(parsedJson);
  const refuse = async (refusal: "private_address" | "ipv4_required" | "invalid_report", scriptVersion: string | null) => {
    if (!usable) return notUsable("not_usable_" + refusal);
    await deps.refuse(codeSha256, refusal);
    return outcome(refusal === "invalid_report" ? 400 : 422, refusal, refusal, scriptVersion);
  };
  if (!parsed.success) return refuse("invalid_report", null);
  const report = parsed.data;
  const scriptVersion = report.scriptVersion;
  const reportDigest = createHash("sha256").update(input.rawBody, "utf8").digest("hex");

  // After the one accepted report, only a byte-identical repeat is
  // acknowledged; the database decides that at commit.
  if (usable) {
    if (!SERVER_ENROLL_ACCEPTED_REPORT_VERSIONS.includes(scriptVersion)) return refuse("invalid_report", scriptVersion);
    if (report.kind === "enrolled" && report.adminKeyFingerprint !== record.adminKeyFingerprint) {
      return refuse("invalid_report", scriptVersion);
    }
    if (report.kind === "enrolled") {
      try { canonicalEd25519HostKey(report.hostPublicKey); } catch { return refuse("invalid_report", scriptVersion); }
    }
    // Hosted Hivra reaches servers over IPv4 only, and never a reserved range.
    if (input.observed.address !== null && input.observed.family === 6) return refuse("ipv4_required", scriptVersion);
    if (input.observed.address !== null && (net.isIP(input.observed.address) !== 4
      || !isAllowedSshAddress(input.observed.address, deps.env))) {
      return refuse("private_address", scriptVersion);
    }
  } else if (record.phase === "issued") {
    return notUsable("expired");
  }

  // Hivra's support answer wins: an "enrolled" report from a server the
  // shared rules don't support is kept as unsupported and connects nothing.
  const supported = report.kind === "enrolled"
    && isServerEnrollmentSupported(report.facts, { proxmoxSudoAllowed: deps.proxmoxSudoAllowed });
  const facts: ServerEnrollmentFacts = report.facts;
  const host = supported && report.kind === "enrolled" ? canonicalEd25519HostKey(report.hostPublicKey) : null;
  const transition = await deps.report({
    codeSha256,
    reportDigest,
    kind: supported ? "enrolled" : "unsupported",
    adminKeyFingerprint: supported && report.kind === "enrolled" ? report.adminKeyFingerprint : null,
    hostPublicKey: host?.publicKey ?? null,
    hostFingerprint: host?.fingerprintSha256 ?? null,
    sshPort: supported && report.kind === "enrolled" ? report.sshPort : null,
    facts,
    consent: report.consent,
    reenrollment: supported && report.kind === "enrolled" ? report.reenrollment : false,
    observedAddress: input.observed.address,
    words: supported ? deps.words() : null,
  });
  if (transition.status === "accepted") {
    return outcome(200, "accepted", transition.replay ? "replay" : null, scriptVersion, [
      ["enrollment", transition.enrollmentId],
      ["words", transition.words],
      ["host", transition.hostFingerprint],
    ]);
  }
  if (transition.status === "unsupported") return outcome(200, "unsupported", "unsupported", scriptVersion);
  return notUsable("not_usable");
}
