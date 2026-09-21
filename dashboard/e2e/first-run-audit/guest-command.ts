import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";

type GuestCommandResult = Pick<
  SpawnSyncReturns<string>,
  "error" | "signal" | "status" | "stdout"
>;

const SAFE_RECEIPT_ERRORS = new Set([
  "Agent id is invalid.",
  "Agent is not in a stable, identity-bound running state.",
  "Agent not found.",
  "Remote desktop Canary install command failed.",
  "Remote desktop Canary restart command failed.",
  "Remote desktop guest installation failed.",
  "Remote desktop install authority is unavailable.",
  "Remote desktop install request is invalid.",
  "Remote desktop restart authority is unavailable.",
  "Remote desktop restart could not be verified.",
  "Remote desktop restart failed.",
  "Remote desktop restarted but its capability proof failed.",
  "Remote desktop was installed but its capability proof failed.",
  "The managed host runtime could not be prepared.",
]);
const SAFE_CODED_RECEIPT_ERROR = /^Remote desktop (?:guest installation|capability) could not be verified \([a-z0-9_]+\)\.$/;
const MAX_RECEIPT_BYTES = 64 * 1024;

function outputText(value: unknown): string {
  if (typeof value === "string") return value.slice(-MAX_RECEIPT_BYTES);
  if (Buffer.isBuffer(value)) return value.subarray(-MAX_RECEIPT_BYTES).toString("utf8");
  return "";
}

function lastOutputLine(value: unknown): string {
  return outputText(value).trim().split(/\r?\n/).at(-1) ?? "";
}

function safeFailureReceipt(result: GuestCommandResult, agentId: string): string {
  const line = lastOutputLine(result.stdout);
  try {
    const parsed = JSON.parse(line) as { agentId?: unknown; error?: unknown; ok?: unknown };
    if (
      parsed.ok === false
      && parsed.agentId === agentId
      && typeof parsed.error === "string"
      && (SAFE_RECEIPT_ERRORS.has(parsed.error) || SAFE_CODED_RECEIPT_ERROR.test(parsed.error))
    ) {
      return parsed.error;
    }
  } catch {}

  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOBUFS") return "host_output_limit";
  if (errorCode === "ETIMEDOUT") return "host_timeout";
  if (errorCode && /^[A-Z0-9_]+$/.test(errorCode)) return `host_${errorCode.toLowerCase()}`;
  if (result.signal) return "host_signal";
  if (typeof result.status === "number") return "operator_exit";
  return "no_safe_receipt";
}

export function buildGuestCommandInvocation(
  cwd: string,
  script: string,
  agentId: string,
  apply = true,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  return {
    executable: process.execPath,
    args: [
      "-r", path.join(cwd, "scripts/register-server-only-noop.cjs"),
      "-r", "ts-node/register/transpile-only",
      "-r", "tsconfig-paths/register",
      script,
      "--agent-id", agentId,
      ...(apply ? ["--apply"] : []),
    ],
    env: {
      ...baseEnv,
      TS_NODE_TRANSPILE_ONLY: "true",
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
    },
  };
}

export function parseGuestCommandResult(
  result: GuestCommandResult,
  scriptName: string,
  agentId: string,
): Record<string, unknown> {
  if (result.status !== 0) {
    throw new Error(`${scriptName} failed: ${safeFailureReceipt(result, agentId)}`);
  }

  const line = lastOutputLine(result.stdout);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`${scriptName} did not return a valid structured receipt.`);
  }
  if (parsed.ok !== true || parsed.agentId !== agentId) {
    throw new Error(`${scriptName} did not return an exact successful agent receipt.`);
  }
  return parsed;
}

export function runGuestCommandProcess(
  executable: string,
  args: string[],
  scriptName: string,
  agentId: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    timeoutMs?: number;
  } = {},
): Record<string, unknown> {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    // The operator command owns normalization into one bounded JSON receipt.
    // Discard dependency stderr so package-manager or SSH noise cannot exhaust
    // the audit runner's output buffer or leak credentials into CI output.
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs ?? 20 * 60_000,
  });
  return parseGuestCommandResult(result, scriptName, agentId);
}
