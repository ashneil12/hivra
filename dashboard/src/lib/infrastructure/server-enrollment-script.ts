import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ACCOUNT_CODE_PATTERN } from "@/lib/account-code";

import { SERVER_ENROLLMENT_CODE_PATTERN } from "./server-enrollment-code";
import { validateTrustedAppOrigin } from "./trusted-app-origin";

/**
 * The served setup script (bootstrap/server-enroll.sh) is a pinned file: the
 * same bytes for every requester, checkable against the public repository,
 * refused if it hashes differently on disk. Every released body is listed
 * here, newest last and never edited, and the report route accepts the
 * current and previous release only.
 *
 * To change the script: edit the file, add a release with a new date-based
 * version and the new sha256, and add the same pair to the frozen list in
 * server-enrollment-script.test.ts.
 */
export const SERVER_ENROLL_SCRIPT_RELEASES = [
  { version: "2026.09.24.1", sha256: "e1ec492a165f21addfa515883b06bad3693e9234c99c63ea5191b9ed46689cfe" },
] as const;
const CURRENT_RELEASE = SERVER_ENROLL_SCRIPT_RELEASES[SERVER_ENROLL_SCRIPT_RELEASES.length - 1];
export const SERVER_ENROLL_SCRIPT_VERSION: string = CURRENT_RELEASE.version;
export const SERVER_ENROLL_SCRIPT_SHA256: string = CURRENT_RELEASE.sha256;
/** Reports are accepted from the current release and the one before it. */
export const SERVER_ENROLL_ACCEPTED_REPORT_VERSIONS: readonly string[] = SERVER_ENROLL_SCRIPT_RELEASES
  .slice(-2).map(release => release.version);

const SCRIPT_PATH = "bootstrap/server-enroll.sh";
const MAX_SCRIPT_BYTES = 64 * 1024;
const PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/;

export class ServerEnrollScriptError extends Error {
  constructor(readonly code: "script_unavailable" | "invalid_value") {
    super("Server enrollment script " + code);
    this.name = "ServerEnrollScriptError";
  }
}

/** The pinned body, or ServerEnrollScriptError("script_unavailable") when the
 * file on disk is missing, too large, not plain ASCII, not newline-terminated
 * or hashes differently. Nothing is served in that case. */
export async function loadServerEnrollScriptBody(
  read: (path: string) => Promise<Buffer> = readFile,
): Promise<string> {
  let file: Buffer;
  try {
    file = await read(join(process.cwd(), SCRIPT_PATH));
  } catch {
    throw new ServerEnrollScriptError("script_unavailable");
  }
  if (file.length > MAX_SCRIPT_BYTES || file.length === 0 || file[file.length - 1] !== 0x0a
    || createHash("sha256").update(file).digest("hex") !== SERVER_ENROLL_SCRIPT_SHA256
    || file.some(byte => byte > 0x7e || (byte < 0x20 && byte !== 0x0a && byte !== 0x09))) {
    throw new ServerEnrollScriptError("script_unavailable");
  }
  return file.toString("ascii");
}

function checked(value: string, pattern: RegExp): string {
  // Each value is matched, never escaped: none of the patterns admits a
  // quote, backslash, dollar sign, brace, semicolon, newline or non-ASCII
  // byte, so single-quoting is exact. Anything else throws.
  if (typeof value !== "string" || !pattern.test(value) || /['\\$`{};\n\r\0]/.test(value)) {
    throw new ServerEnrollScriptError("invalid_value");
  }
  return value;
}

/** The one final line of an enroll download: a single brace group, the
 * caller's own arguments first, the fixed values after them, sentinels last. */
export function renderEnrollFinalLine(input: {
  origin: string; code: string; adminPublicKey: string; accountCode: string;
}): string {
  let origin: string;
  try {
    origin = validateTrustedAppOrigin(input.origin);
  } catch {
    throw new ServerEnrollScriptError("invalid_value");
  }
  return `{ hivra_enroll_entry "$@" HIVRA_ARGS_V1 '${checked(origin, /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/)}' '${
    checked(input.code, SERVER_ENROLLMENT_CODE_PATTERN)}' '${checked(input.adminPublicKey, PUBLIC_KEY_PATTERN)}' '${
    checked(input.accountCode, ACCOUNT_CODE_PATTERN)}' HIVRA_END_V1; }`;
}

export type ServerEnrollRefusal = "missing_code" | "expired_or_used" | "fetch_limit";

export function renderRefusalLine(reason: ServerEnrollRefusal): string {
  if (!["missing_code", "expired_or_used", "fetch_limit"].includes(reason)) {
    throw new ServerEnrollScriptError("invalid_value");
  }
  return `{ hivra_refuse '${reason}'; }`;
}

export const UNINSTALL_FINAL_LINE = '{ hivra_uninstall_entry "$@" HIVRA_END_V1; }';

/** What a GET returns: the body, then the final line and a newline. */
export function servedScript(body: string, finalLine: string): string {
  return body + finalLine + "\n";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The commands the panel shows. The code rides only in a header, never in
 * the URL. `--proto '=https'` and no -L: curl never follows a redirect. */
export function serverEnrollmentCommands(origin: string, code: string) {
  const trusted = validateTrustedAppOrigin(origin);
  checked(code, SERVER_ENROLLMENT_CODE_PATTERN);
  const fetch = `curl -fsS --proto '=https' -H 'Authorization: Bearer ${code}' ${trusted}/enroll`;
  return {
    command: `${fetch} | sudo bash`,
    dryRunCommand: `${fetch} | bash -s -- --dry-run`,
    downloadCommand: `${fetch} -o hivra-enroll.sh`,
    uninstallCommand: serverUninstallCommand(trusted),
  };
}

export function serverUninstallCommand(origin: string): string {
  return `curl -fsS --proto '=https' ${validateTrustedAppOrigin(origin)}/enroll/uninstall | sudo bash`;
}
