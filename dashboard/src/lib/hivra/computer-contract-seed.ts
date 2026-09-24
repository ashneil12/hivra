import "server-only";

// Computer Contract delivery over the guest seed lanes: on Proxmox the
// host-to-guest lane the identity, skills and tool seeds use
// (runProxmoxHostScript -> host root -> ssh ubuntu@<guest> -> sudo); on a
// computer in the owner's own cloud the enrolled provider pin
// (provider-guest-seed.ts). Both run the same program. Unlike
// the one-shot identity seed it is revisioned and compare-and-swap: the
// guest replaces exactly one HIVRA:COMPUTER block in ~/system-prompt.md only
// when the block it finds is the one Hivra last delivered, then reads the
// file back and reports the digest of what is now there.
//
// Nothing user-controlled reaches a shell or the program text. The program is
// fixed; the request (block, digests, facts) travels as base64 JSON on stdin.

import { z } from "zod";
import { runProxmoxHostScript, type HostScriptResult } from "@/lib/services/proxmox-instance-service";
import { runProviderAgentGuestScript, type ProviderGuestSeedRef } from "./provider-guest-seed";
import { COMPUTER_CONTRACT_END, COMPUTER_CONTRACT_MAX_BYTES, COMPUTER_CONTRACT_START_PREFIX } from "@/lib/agent-computers/computer-contract";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Observed = z.union([Digest, z.literal("absent"), z.literal("conflict")]);
const BootId = z.string().regex(/^[0-9a-f-]{36}$/).nullable();

export type ComputerContractGuestMode = "deliver" | "restore" | "check";

export interface ComputerContractGuestRequest {
  mode: ComputerContractGuestMode;
  /** Digest of the block Hivra expects to find, or "absent" for none. */
  expected: string;
  revision: number;
  block: string;
  contentSha256: string;
  /** Written to ~/.hivra/computer.json next to the block. */
  facts: Record<string, unknown>;
}

const Result = z.discriminatedUnion("status", [
  z.object({ status: z.literal("delivered"), revision: z.number().int().positive(), contentSha256: Digest,
    observed: Digest, replay: z.boolean(), bootId: BootId }).strict(),
  z.object({ status: z.literal("state_conflict"), observed: Observed, bootId: BootId }).strict(),
  z.object({ status: z.literal("observed"), observed: Observed, bootId: BootId }).strict(),
  z.object({ status: z.literal("readback_mismatch"), observed: Observed, bootId: BootId }).strict(),
  z.object({ status: z.literal("no_instruction_file"), bootId: BootId }).strict(),
  z.object({ status: z.literal("unsafe_file"), bootId: BootId }).strict(),
]);
export type ComputerContractGuestResult = z.infer<typeof Result>;

export type ComputerContractGuestOutcome =
  | { ok: true; result: ComputerContractGuestResult }
  | { ok: false; error: "invalid_request" | "unreachable" | "unrecognized_output" };

const RESULT_PREFIX = "HIVRA_CONTRACT_RESULT ";

// Runs as root in the guest. Only /home/bux/system-prompt.md and
// /home/bux/.hivra/computer.json are written, each through a temporary file
// in the same directory, renamed into place and read back. A symlink, a
// non-regular file or a file not owned by bux is refused, never followed.
export const COMPUTER_CONTRACT_GUEST_PROGRAM = String.raw`
import base64, hashlib, json, os, secrets, stat, sys

HOME = "/home/bux"
PROMPT = os.path.join(HOME, "system-prompt.md")
FACTS_DIR = os.path.join(HOME, ".hivra")
START = ${JSON.stringify(COMPUTER_CONTRACT_START_PREFIX)}
END = ${JSON.stringify(COMPUTER_CONTRACT_END)}
MAX_FILE = 1024 * 1024

def boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as stream:
            value = stream.read().strip()
        return value if len(value) == 36 else None
    except Exception:
        return None

def done(**fields):
    fields["bootId"] = boot_id()
    sys.stdout.write("HIVRA_CONTRACT_RESULT " + json.dumps(fields, sort_keys=True, separators=(",", ":")) + "\n")
    sys.exit(0)

def is_marker(line):
    return line.lstrip().startswith("<!--") and "HIVRA:COMPUTER" in line

def locate(lines):
    starts = [i for i, line in enumerate(lines) if line.startswith(START)]
    ends = [i for i, line in enumerate(lines) if line == END]
    stray = any(is_marker(line) and not line.startswith(START) and line != END for line in lines)
    if not starts and not ends and not stray:
        return "absent", None
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0] or stray:
        return "conflict", None
    return "present", (starts[0], ends[0])

def digest(lines, state, span):
    if state != "present":
        return state
    return hashlib.sha256("\n".join(lines[span[0]:span[1] + 1]).encode("utf-8")).hexdigest()

def read_regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
            raise ValueError("unsafe")
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_FILE:
                raise ValueError("unsafe")
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8"), info
    finally:
        os.close(fd)

def write_atomic(path, data, uid, gid, mode):
    directory = os.path.dirname(path)
    temporary = os.path.join(directory, ".hivra-contract-" + secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data.encode("utf-8"))
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.rename(temporary, path)
    except Exception:
        os.unlink(temporary)
        raise
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)

def write_facts(facts, uid, gid):
    try:
        info = os.lstat(FACTS_DIR)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
            return
    except FileNotFoundError:
        os.mkdir(FACTS_DIR, 0o700)
        os.chown(FACTS_DIR, uid, gid)
    write_atomic(os.path.join(FACTS_DIR, "computer.json"), json.dumps(facts, indent=2, sort_keys=True) + "\n", uid, gid, 0o644)

request = json.loads(base64.b64decode(sys.stdin.read().strip()).decode("utf-8"))
mode = request["mode"]
try:
    home = os.lstat(HOME)
    owner = home.st_uid
    if not stat.S_ISDIR(home.st_mode):
        done(status="unsafe_file")
    text, info = read_regular(PROMPT)
    if info.st_uid != owner:
        done(status="unsafe_file")
except FileNotFoundError:
    done(status="no_instruction_file")
except (ValueError, OSError, UnicodeDecodeError):
    done(status="unsafe_file")

lines = text.split("\n")
state, span = locate(lines)
observed = digest(lines, state, span)
if mode == "check":
    done(status="observed", observed=observed)

block_lines = request["block"].split("\n")
if hashlib.sha256(request["block"].encode("utf-8")).hexdigest() != request["contentSha256"]:
    sys.exit(3)

replay = observed == request["contentSha256"]
if mode == "deliver" and not replay and observed != request["expected"]:
    done(status="state_conflict", observed=observed)

if replay:
    updated = lines
elif mode == "restore" and state == "conflict":
    # Drop every complete Hivra region and every lone marker line; text
    # between unmatched markers is the owner's and stays.
    kept, index = [], 0
    while index < len(lines):
        line = lines[index]
        if line.startswith(START):
            close = next((j for j in range(index + 1, len(lines)) if lines[j] == END), None)
            if close is not None and not any(lines[k].startswith(START) for k in range(index + 1, close)):
                index = close + 1
                continue
        if not is_marker(line):
            kept.append(line)
        index += 1
    while kept and kept[-1] == "":
        kept.pop()
    updated = kept + ["", *block_lines, ""]
elif state == "present":
    updated = lines[:span[0]] + block_lines + lines[span[1] + 1:]
else:
    base = lines[:]
    while base and base[-1] == "":
        base.pop()
    updated = base + ["", *block_lines, ""]

try:
    if not replay:
        write_atomic(PROMPT, "\n".join(updated), info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
    after, _ = read_regular(PROMPT)
except (ValueError, OSError, UnicodeDecodeError):
    done(status="unsafe_file")
after_lines = after.split("\n")
after_state, after_span = locate(after_lines)
now = digest(after_lines, after_state, after_span)
if now != request["contentSha256"]:
    done(status="readback_mismatch", observed=now)
try:
    write_facts(request["facts"], info.st_uid, info.st_gid)
except OSError:
    pass
done(status="delivered", revision=int(request["revision"]), contentSha256=now, observed=now, replay=replay)
`;

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** The guest-side script: a fixed program, with the request on stdin only. */
export function buildComputerContractGuestScript(request: ComputerContractGuestRequest): string {
  const payload = b64(JSON.stringify(request));
  return `set -e
command -v python3 >/dev/null 2>&1 || { echo "python3 missing" >&2; exit 1; }
printf '%s' '${payload}' | python3 -c "$(printf '%s' '${b64(COMPUTER_CONTRACT_GUEST_PROGRAM)}' | base64 -d)"
`;
}

// Same host lane and key as agent-bootstrap.ts; the guest script is wrapped
// again so no request byte reaches the host's shell unencoded.
function buildHostScript(ip: string, guestScript: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
KEY=/etc/hivra/keys/vm-orchestrator
[ -f "$KEY" ] || { echo "vm key $KEY missing" >&2; exit 1; }
OUTER='${b64(guestScript)}'
ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${ip}" "echo '$OUTER' | base64 -d | sudo bash"
`;
}

/** Strict parse of the one result line; anything else is not a receipt. */
export function parseComputerContractGuestOutput(stdout: string): ComputerContractGuestResult | null {
  const lines = stdout.split("\n").filter((line) => line.startsWith(RESULT_PREFIX));
  if (lines.length !== 1) return null;
  try {
    const parsed = Result.safeParse(JSON.parse(lines[0].slice(RESULT_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function validRequest(request: ComputerContractGuestRequest): boolean {
  return ["deliver", "restore", "check"].includes(request.mode)
    && Observed.safeParse(request.expected).success
    && Number.isSafeInteger(request.revision) && request.revision > 0
    && typeof request.block === "string" && Buffer.byteLength(request.block) <= COMPUTER_CONTRACT_MAX_BYTES
    && request.block.startsWith(COMPUTER_CONTRACT_START_PREFIX) && request.block.endsWith(COMPUTER_CONTRACT_END)
    && Digest.safeParse(request.contentSha256).success
    && JSON.stringify(request.facts).length <= 8192;
}

/** One bounded round trip. A transport failure is "unreachable", never a receipt. */
export async function runComputerContractSeed(
  ip: string,
  request: ComputerContractGuestRequest,
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<ComputerContractGuestOutcome> {
  const address = (ip || "").trim();
  if (!/^[0-9.]+$/.test(address) || !validRequest(request)) return { ok: false, error: "invalid_request" };
  let result: HostScriptResult;
  try {
    // Same cap as the identity seed: well under the poll route's budget.
    result = await runProxmoxHostScript(buildHostScript(address, buildComputerContractGuestScript(request)), env, 25_000);
  } catch {
    return { ok: false, error: "unreachable" };
  }
  if (!result.ok) return { ok: false, error: "unreachable" };
  const parsed = parseComputerContractGuestOutput(result.stdout || "");
  return parsed ? { ok: true, result: parsed } : { ok: false, error: "unrecognized_output" };
}

/**
 * The same guest program on a computer in the owner's own cloud, over the
 * provider seed lane (provider-guest-seed.ts). An agent that is not stable and
 * running there, or a computer that cannot be verified, is "unreachable": no
 * receipt, and the next attempt tries again.
 */
export async function runProviderComputerContractSeed(
  ref: ProviderGuestSeedRef,
  request: ComputerContractGuestRequest,
  run: typeof runProviderAgentGuestScript = runProviderAgentGuestScript,
): Promise<ComputerContractGuestOutcome> {
  if (!validRequest(request)) return { ok: false, error: "invalid_request" };
  const outcome = await run(ref, buildComputerContractGuestScript(request));
  if (!outcome.ok) return { ok: false, error: "unreachable" };
  const parsed = parseComputerContractGuestOutput(outcome.stdout);
  return parsed ? { ok: true, result: parsed } : { ok: false, error: "unrecognized_output" };
}
