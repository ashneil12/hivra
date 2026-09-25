/**
 * The sudo transport for host scripts on connections whose privilege is
 * "sudo" (an enrolled server's hivra user, or an advanced sudo user). See
 * section 9.2 of docs/superpowers/specs/2026-09-24-server-enrollment-command.md.
 *
 * Every operation sends one constant command. Only the whole-second limit
 * changes. The script and its data travel on stdin behind a length prefix,
 * so no script byte or data byte is ever in argv (and so never in sudo's log
 * or in `ps`):
 *
 *   stdin = <byte length of script>\n<script><data>
 *
 * The loader reads the length, then exactly that many bytes (bash's `read`
 * takes a pipe one byte at a time), then runs the script in the same shell,
 * which reads its data from what is left of stdin. `login` connections and the
 * managed fleet never use this: they keep today's exact commands.
 */

export const HIVRA_SUDO_SENTINEL = "HIVRA_SUDO_V1";

/** Fixed, about 150 bytes, inside single quotes in the command: it must never
 * contain a single quote. */
export const HIVRA_SUDO_LOADER =
  'printf "HIVRA_SUDO_V1\\n" >&2; IFS= read -r n && [[ $n =~ ^[1-9][0-9]{0,5}$ ]] && IFS= read -r -d "" -n "$n" s && [ "${#s}" -eq "$n" ] && eval "$s"';

/** The length prefix allows up to 999,999 bytes of script. */
export const MAX_SUDO_TRANSPORT_SCRIPT_BYTES = 999_999;

/** Remote limit: the local timeout in whole seconds minus 2, at least 1, so
 * the remote process never outlives Hivra's own deadline. */
export function sudoTransportRemoteSeconds(timeoutMs: number): number {
  return Math.max(1, Math.floor(timeoutMs / 1_000) - 2);
}

/**
 * The one command sent over SSH. With the default "bounded" limit the remote
 * script gets TERM, then KILL a second later, just before Hivra's deadline.
 * "none" leaves out the limit for scripts that change packages (gVisor
 * Prepare): a KILL inside apt or dpkg leaves "dpkg was interrupted", which is
 * worse than a script that finishes after Hivra stopped waiting. That is what
 * a root login does today: closing the channel doesn't stop the remote
 * script. The disposable-server check (T29, T43) shows a script under this
 * command runs to its end after the channel closes, with use_pty on and off.
 */
/** Root's PATH under sudo on Ubuntu (its secure_path). Host scripts find
 * tools Prepare installs in /usr/local/bin (runsc) by name, as they do over a
 * root login, so the transport keeps them on PATH; the disposable-server run
 * found the narrower first-boot PATH hid runsc from the gVisor check. */
export const SUDO_TRANSPORT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin";

export function buildSudoTransportCommand(timeoutMs: number, remoteLimit: "bounded" | "none" = "bounded"): string {
  if (HIVRA_SUDO_LOADER.includes("'")) throw new Error("The sudo loader must not contain a single quote");
  const limit = remoteLimit === "none"
    ? ""
    : `/usr/bin/timeout --signal=TERM --kill-after=1s ${sudoTransportRemoteSeconds(timeoutMs)}s `;
  return `/usr/bin/sudo -n -- /usr/bin/env -i PATH=${SUDO_TRANSPORT_PATH} LC_ALL=C HOME=/root `
    + `${limit}/bin/bash --noprofile --norc -c '${HIVRA_SUDO_LOADER}'`;
}

/** The framed stdin, or null for a script the transport refuses: empty, over
 * the length limit, or containing a NUL byte (the loader's read stops at
 * NUL). */
export function frameSudoTransportInput(script: string, stdin: string): string | null {
  if (typeof script !== "string" || typeof stdin !== "string" || script.includes("\0")) return null;
  const length = Buffer.byteLength(script, "utf8");
  if (length < 1 || length > MAX_SUDO_TRANSPORT_SCRIPT_BYTES) return null;
  return `${length}\n${script}${stdin}`;
}

/** Remove the sentinel line the loader prints first on stderr. Callers never
 * see it. */
export function stripSudoSentinel(stderr: string): { stderr: string; sentinel: boolean } {
  const line = `${HIVRA_SUDO_SENTINEL}\n`;
  const index = stderr.indexOf(line);
  if (index === -1) return { stderr, sentinel: false };
  return { stderr: stderr.slice(0, index) + stderr.slice(index + line.length), sentinel: true };
}

/** Diagnosis 1, as the login user without sudo: which fixed tools the
 * transport needs are missing. */
export const SUDO_TRANSPORT_TOOLS = ["/usr/bin/sudo", "/usr/bin/env", "/usr/bin/timeout", "/bin/bash"] as const;
export const SUDO_MISSING_TOOLS_PROBE =
  "/bin/sh -c 'for p in /usr/bin/sudo /usr/bin/env /usr/bin/timeout /bin/bash; do [ -x \"$p\" ] || printf \"missing %s\\n\" \"$p\"; done'";
/** Diagnosis 2: does sudo run anything at all without a password? */
export const SUDO_TRUE_PROBE = "/usr/bin/sudo -n -- /usr/bin/true";

export type SudoTransportFailure =
  | { kind: "missing_tool"; path: (typeof SUDO_TRANSPORT_TOOLS)[number] }
  | { kind: "password_required" }
  | { kind: "command_not_allowed" };

export function parseMissingTool(output: string): (typeof SUDO_TRANSPORT_TOOLS)[number] | null {
  for (const line of output.split("\n")) {
    const path = line.startsWith("missing ") ? line.slice("missing ".length).trim() : null;
    const known = SUDO_TRANSPORT_TOOLS.find(tool => tool === path);
    if (known) return known;
  }
  return null;
}

/** The runner's error text for a failed transport. Stable, secret-free, and
 * recognisable by callers that classify failures. */
export function sudoTransportFailureMessage(failure: SudoTransportFailure): string {
  return failure.kind === "missing_tool"
    ? `Sudo transport failed: missing ${failure.path}`
    : `Sudo transport failed: ${failure.kind}`;
}
