/**
 * The free sandbox's `SandboxHost` port on real pool servers: the gVisor adapter on each server, run over that server's
 * SSH with the same identity guard the paid computers use, and every receipt it prints read back and checked against
 * the sandbox it was asked to act on. How a pool server is reached is decided by the resolver the caller injects, and
 * the script runner is injected too, so tests run this whole class on fakes. Nothing here runs unless it is constructed.
 */
import type { SandboxHost, SandboxRef, SandboxSpec } from "./ports";

type EnvLike = Record<string, string | undefined>;

/** What the host needs to act on one pool server: its SSH environment, its memory reserve and the identities it must match. */
export interface PoolServerAuthority {
  env: EnvLike;
  /** Host memory kept back from sandboxes, in MB (the adapter's `hostMemoryReserveMb`). */
  hostMemoryReserveMb: number;
  /** Lowercase SHA-256 of the adapter binary the server must be running. */
  adapterSha256: string;
  /** Lowercase SHA-256 of the gVisor runtime (`runsc`) the server must be running. */
  runtimeSha256: string;
}

/** Resolves one pool server (by its id) to the authority this host acts with. */
export type PoolServerResolver = (serverId: string) => Promise<PoolServerAuthority>;

/** The result shape of a host script run. The real runner returns more fields; only these are read here. */
export interface HostScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs one script on a server with a JSON document on its stdin. Same contract as the paid path's
 * `runProxmoxHostScriptWithStdin`: the stdin never becomes part of the command line.
 */
export type HostScriptRunner = (
  script: string,
  stdin: string,
  env: EnvLike,
  options: { timeoutMs: number; maxOutputBytes: number },
) => Promise<HostScriptResult>;

export type FreeSandboxHostErrorCode = "invalid_request" | "not_ready" | "capacity" | "remote_failed";

/**
 * A failed sandbox host operation. The message is fixed text written here: it never carries the request, the script's
 * output, an enroll code, a token or an archive path.
 */
export class FreeSandboxHostError extends Error {
  /** Which kind of failure this is. Callers branch on it (for example `capacity` to place the sandbox elsewhere). */
  readonly code: FreeSandboxHostErrorCode;

  constructor(code: FreeSandboxHostErrorCode, message: string) {
    super(message);
    this.name = "FreeSandboxHostError";
    this.code = code;
  }
}

type AdapterOperation = "create" | "start" | "stop" | "pack" | "release" | "restore" | "enroll" | "delete";
type AdapterRequest = Record<string, string | number>;

const ADAPTER_PATH = "/opt/hivra/gvisor-adapter/hivra-gvisor-adapter";
const ADAPTER_DIGEST_FILE = "/opt/hivra/gvisor-adapter/gvisor-bin.sha256";
const RUNSC_PATH = "/usr/local/bin/runsc";
const FREE_SANDBOX_CLASS = "free";
// Each budget is at or above what the adapter (provisioner/gvisor/hivra-gvisor-adapter.py) can spend in that operation.
/** create and restore: the image pull is bounded at 300s inside the adapter, then the sandbox is built or unpacked. */
const LONG_TIMEOUT_MS = 360_000;
/** start, stop and delete: admission and a single container operation. */
const SHORT_TIMEOUT_MS = 90_000;
/** pack: zstd is bounded at 3600s, then tar.wait 60s, a zstd -t read-back and two full SHA-256 passes over the archive. */
const PACK_TIMEOUT_MS = 4_200_000;
/** release: re-hashes the local archive (up to the storage quota) and deletes the sandbox. The adapter sets no bound. */
const RELEASE_TIMEOUT_MS = 900_000;
/** enroll: the adapter's docker exec is bounded at 120s, and it inspects the container before that. */
const ENROLL_TIMEOUT_MS = 150_000;
const OUTPUT_LIMIT_BYTES = 96 * 1024;

const RECEIPT_STATUS = "HIVRA_GVISOR_V1 ";
const RECEIPT_PACK = "HIVRA_GVISOR_PACK_V1 ";
const RECEIPT_RELEASE = "HIVRA_GVISOR_RELEASE_V1 ";
const RECEIPT_ENROLL = "HIVRA_GVISOR_ENROLL_V1 ";
const IDENTITY_MISMATCH = "HIVRA_GVISOR_IDENTITY_MISMATCH";
// The adapter's own refusal texts (hivra-gvisor-adapter.py). Matched exactly; never echoed into an error.
const CAPACITY_REFUSALS = [
  "does not have enough uncommitted capacity",
  // The adapter's host_capacity check: the host reports too few cores or too little memory to admit anything.
  "Host capacity is unavailable",
];
const NOT_READY_REFUSALS = [
  "needs explicit CPU and memory limits",
  "Stop this gVisor computer before packing it",
  "Start this gVisor computer before enrolling it",
  "A running gVisor computer cannot be released",
  "does not run the free sandbox image",
  "No free sandbox image is pinned on this adapter",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Must equal the pool server id check in the database (dashboard/supabase/migrations/20261117210000_free_sandbox_bridge.sql).
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENROLL_CODE = /^[A-Za-z0-9_-]{8,256}$/;
const HTTPS_SERVER_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

/**
 * The gVisor adapter's operations on pool servers, one per `SandboxHost` method. Each call is a single adapter run
 * with the request on stdin; the guard in front of it proves the installed adapter and runtime are the pinned ones.
 */
export class GvisorSandboxHost implements SandboxHost {
  constructor(
    private readonly resolve: PoolServerResolver,
    private readonly runScript: HostScriptRunner,
  ) {}

  /**
   * Creates the sandbox on the server with its free-class limits. The adapter's create starts the container, so the
   * receipt must report it running.
   */
  async create(serverId: string, sandbox: SandboxRef, spec: SandboxSpec): Promise<void> {
    requireSpec(spec);
    const authority = await this.authorityFor(serverId);
    const request = {
      ...sandboxFields("create", sandbox),
      sandboxClass: FREE_SANDBOX_CLASS,
      ...specFields(spec),
      hostMemoryReserveMb: authority.hostMemoryReserveMb,
    };
    const stdout = await this.send(authority, request, LONG_TIMEOUT_MS);
    requireState(receiptOf(stdout, RECEIPT_STATUS, sandbox), "running");
  }

  /** Starts a stopped sandbox; the adapter admits it against the server's capacity first. */
  async start(serverId: string, sandbox: SandboxRef, spec: SandboxSpec): Promise<void> {
    requireOvercommit(spec.cpuOvercommit);
    const authority = await this.authorityFor(serverId);
    const request = {
      ...sandboxFields("start", sandbox),
      hostMemoryReserveMb: authority.hostMemoryReserveMb,
      cpuOvercommit: spec.cpuOvercommit,
    };
    const stdout = await this.send(authority, request, SHORT_TIMEOUT_MS);
    requireState(receiptOf(stdout, RECEIPT_STATUS, sandbox), "running");
  }

  /** Stops a running sandbox. */
  async stop(serverId: string, sandbox: SandboxRef): Promise<void> {
    const authority = await this.authorityFor(serverId);
    const stdout = await this.send(authority, sandboxFields("stop", sandbox), SHORT_TIMEOUT_MS);
    requireState(receiptOf(stdout, RECEIPT_STATUS, sandbox), "stopped");
  }

  /**
   * Joins the sandbox's runner to the agent app with a single-use code. The code travels only on stdin; it is checked
   * here and never echoed back in an error.
   */
  async enroll(serverId: string, sandbox: SandboxRef, enrollCode: string, serverUrl: string): Promise<void> {
    if (typeof enrollCode !== "string" || !ENROLL_CODE.test(enrollCode)) {
      throw invalid("enroll code");
    }
    if (typeof serverUrl !== "string" || !HTTPS_SERVER_URL.test(serverUrl)) {
      throw invalid("server address");
    }
    const authority = await this.authorityFor(serverId);
    const request = { ...sandboxFields("enroll", sandbox), enrollCode, serverUrl };
    const stdout = await this.send(authority, request, ENROLL_TIMEOUT_MS);
    if (receiptOf(stdout, RECEIPT_ENROLL, sandbox).enrolled !== true) throw unconfirmed();
  }

  /** Packs a stopped sandbox's workspace into a local archive and returns its verified digest and size. */
  async pack(serverId: string, sandbox: SandboxRef): Promise<{ sha256: string; bytes: number }> {
    const authority = await this.authorityFor(serverId);
    const stdout = await this.send(authority, sandboxFields("pack", sandbox), PACK_TIMEOUT_MS);
    return packReceipt(receiptOf(stdout, RECEIPT_PACK, sandbox));
  }

  /** Removes the sandbox and its local archive, only when that archive still reads back to `sha256`. */
  async release(serverId: string, sandbox: SandboxRef, sha256: string): Promise<void> {
    requireMatch(sha256, SHA256_HEX, "archive digest");
    const authority = await this.authorityFor(serverId);
    const request = { ...sandboxFields("release", sandbox), archiveSha256: sha256 };
    const receipt = receiptOf(await this.send(authority, request, RELEASE_TIMEOUT_MS), RECEIPT_RELEASE, sandbox);
    if (receipt.sha256 !== sha256) throw unconfirmed();
    requireState(receipt, "released");
  }

  /** Brings a packed sandbox back on the server from its archive, which is checked first; it comes back stopped. */
  async restore(serverId: string, sandbox: SandboxRef, spec: SandboxSpec, sha256: string): Promise<void> {
    requireSpec(spec);
    requireMatch(sha256, SHA256_HEX, "archive digest");
    const authority = await this.authorityFor(serverId);
    const request = {
      ...sandboxFields("restore", sandbox),
      sandboxClass: FREE_SANDBOX_CLASS,
      ...specFields(spec),
      hostMemoryReserveMb: authority.hostMemoryReserveMb,
      archiveSha256: sha256,
    };
    const stdout = await this.send(authority, request, LONG_TIMEOUT_MS);
    requireState(receiptOf(stdout, RECEIPT_STATUS, sandbox), "stopped");
  }

  /** Erases the sandbox from the server (the person deleted their account or workspace, or moved to a paid computer). */
  async remove(serverId: string, sandbox: SandboxRef): Promise<void> {
    const authority = await this.authorityFor(serverId);
    const stdout = await this.send(authority, sandboxFields("delete", sandbox), SHORT_TIMEOUT_MS);
    requireState(receiptOf(stdout, RECEIPT_STATUS, sandbox), "absent");
  }

  /** Resolves the server's authority and checks every value that will reach the guard script or the request. */
  private async authorityFor(serverId: string): Promise<PoolServerAuthority> {
    requireMatch(serverId, SERVER_ID, "pool server id");
    let authority: PoolServerAuthority;
    try {
      authority = await this.resolve(serverId);
    } catch {
      throw new FreeSandboxHostError("not_ready", "The pool server's host identity could not be resolved.");
    }
    return checkAuthority(authority);
  }

  /** One adapter run on the server, behind the identity guard. Returns the script's stdout when it succeeded. */
  private async send(authority: PoolServerAuthority, request: AdapterRequest, timeoutMs: number): Promise<string> {
    const guard = identityGuard(authority.adapterSha256, authority.runtimeSha256);
    let result: HostScriptResult;
    try {
      result = await this.runScript(guard, JSON.stringify(request), authority.env, {
        timeoutMs,
        maxOutputBytes: OUTPUT_LIMIT_BYTES,
      });
    } catch {
      throw unconfirmed();
    }
    if (!result.ok) throw refusalFor(`${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
}

/** The guard in front of every adapter run: the installed adapter, runtime and bundle must be the pinned ones. */
function identityGuard(adapterSha256: string, runtimeSha256: string): string {
  return `set -euo pipefail
identity_fail() { printf '${IDENTITY_MISMATCH}\\n' >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' '${ADAPTER_PATH}')" = 'root:root:700' ] || identity_fail
[ "$(sha256sum '${ADAPTER_PATH}' | awk '{print $1}')" = '${adapterSha256}' ] || identity_fail
[ "$(sha256sum ${RUNSC_PATH} | awk '{print $1}')" = '${runtimeSha256}' ] || identity_fail
[ "$(readlink -f "$(/usr/bin/docker info --format '{{(index .Runtimes "runsc").Path}}')")" = ${RUNSC_PATH} ] || identity_fail
[ "$(stat -c '%U:%G:%a' ${ADAPTER_DIGEST_FILE})" = 'root:root:600' ] || identity_fail
(cd / && sha256sum -c ${ADAPTER_DIGEST_FILE} >/dev/null) || identity_fail
exec '${ADAPTER_PATH}'`;
}

function sandboxFields(operation: AdapterOperation, sandbox: SandboxRef): AdapterRequest {
  return {
    operation,
    sandboxId: requireMatch(sandbox.sandboxId, UUID, "sandbox id"),
    computerId: requireMatch(sandbox.computerId, UUID, "computer id"),
    ownerHash: requireMatch(sandbox.ownerHash, SHA256_HEX, "owner identity"),
  };
}

function specFields(spec: SandboxSpec): AdapterRequest {
  return {
    cpu: spec.cpus,
    memoryMb: spec.memoryMb,
    storageMb: spec.storageMb,
    cpuOvercommit: spec.cpuOvercommit,
  };
}

function requireSpec(spec: SandboxSpec): void {
  requireNumber(spec.cpus, 0.5, 32, "CPU limit");
  requireInt(spec.memoryMb, 512, 131072, "memory limit");
  requireInt(spec.storageMb, 256, 65536, "storage quota");
  requireOvercommit(spec.cpuOvercommit);
}

function requireOvercommit(value: number): void {
  requireNumber(value, 1, 8, "CPU overcommit");
}

function checkAuthority(authority: PoolServerAuthority): PoolServerAuthority {
  if (
    typeof authority !== "object" ||
    authority === null ||
    typeof authority.env !== "object" ||
    authority.env === null
  ) {
    throw new FreeSandboxHostError("not_ready", "The pool server's host identity could not be resolved.");
  }
  requireInt(authority.hostMemoryReserveMb, 512, 1048576, "host memory reserve");
  requireMatch(authority.adapterSha256, SHA256_HEX, "adapter identity");
  requireMatch(authority.runtimeSha256, SHA256_HEX, "runtime identity");
  return authority;
}

function requireMatch(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(what);
  return value;
}

function requireInt(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw invalid(what);
  return value;
}

function requireNumber(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw invalid(what);
  return value;
}

function invalid(what: string): FreeSandboxHostError {
  return new FreeSandboxHostError("invalid_request", `The ${what} is invalid.`);
}

function unconfirmed(): FreeSandboxHostError {
  return new FreeSandboxHostError("remote_failed", "The gVisor sandbox operation could not be confirmed.");
}

/** Maps a failed run's output to an error. The output is read for the adapter's markers only and never copied out. */
function refusalFor(output: string): FreeSandboxHostError {
  if (output.includes(IDENTITY_MISMATCH)) {
    return new FreeSandboxHostError(
      "not_ready",
      "The host's gVisor runtime identity no longer matches. Inspect or prepare this host before another operation.",
    );
  }
  if (CAPACITY_REFUSALS.some((refusal) => output.includes(refusal))) {
    return new FreeSandboxHostError("capacity", "The host does not have enough uncommitted capacity for this sandbox.");
  }
  if (NOT_READY_REFUSALS.some((refusal) => output.includes(refusal))) {
    return new FreeSandboxHostError("not_ready", "The host is not ready for this operation yet.");
  }
  return unconfirmed();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The receipt line with `marker` from the script's stdout, parsed. It must name the same sandbox and computer the
 * request named; anything else is not a confirmation.
 */
function receiptOf(stdout: string, marker: string, sandbox: SandboxRef): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(marker));
  if (line === undefined) throw unconfirmed();
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(marker.length));
  } catch {
    throw unconfirmed();
  }
  if (!isRecord(parsed) || parsed.sandboxId !== sandbox.sandboxId || parsed.computerId !== sandbox.computerId) {
    throw unconfirmed();
  }
  return parsed;
}

function requireState(receipt: Record<string, unknown>, state: string): void {
  if (receipt.state !== state) throw unconfirmed();
}

function packReceipt(receipt: Record<string, unknown>): { sha256: string; bytes: number } {
  const { sha256, bytes } = receipt;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) throw unconfirmed();
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) throw unconfirmed();
  return { sha256, bytes };
}
