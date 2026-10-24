import "server-only";

// Runs one linked agent's command on one computer, over the lane the computer
// takes commands on (eligibility.ts). The caller has already checked the link.

import { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { executeGvisorComputerCommand } from "@/lib/hivra/gvisor-computer-service";
import { log } from "@/lib/logger";
import { linkTarget } from "./eligibility";
import { buildLinkExecHostScript, buildLinkExecPayload, LINK_EXEC_STDERR_MAX, LINK_EXEC_STDOUT_MAX, parseLinkExecOutput,
  validExecRequest, type LinkExecOutcome, type LinkExecRequest } from "./exec-program";
import type { OwnedRow } from "./store";

/** A sandbox takes argv only; stdin rides in the command, so it stays small there. */
const GVISOR_STDIN_MAX = 2 * 1024;

const REFUSAL_COPY: Record<string, string> = {
  computer_not_running: "That computer isn't running. Ask your owner to start it.",
  binding_mismatch: "Hivra couldn't confirm that computer is the one on record, so nothing was run.",
  computer_unreachable: "Hivra couldn't reach that computer's host. Try again in a minute.",
  guest_unreachable: "That computer didn't answer. It may still be starting; try again in a minute.",
  no_user: "That computer has no user account to run commands as.",
  start_failed: "The command couldn't be started on that computer.",
  request_invalid: "The command couldn't be sent.",
  stdin_too_large: "Input that large can't be sent to a Linux sandbox. Keep it under 2 KB there.",
  not_supported: "Agents can't use that computer yet.",
};

export function execRefusalCopy(reason: string): string {
  return REFUSAL_COPY[reason] ?? "That computer refused the command.";
}

async function runOnProxmox(userId: string, computer: OwnedRow, request: LinkExecRequest): Promise<LinkExecOutcome> {
  const context = await resolveHivraAgentExecutionContext(userId, computer);
  if (!context.infrastructureBindingTagEnforced || !Number.isSafeInteger(Number(computer.vmid))) {
    return { status: "refused", reason: "binding_mismatch" };
  }
  const script = buildLinkExecHostScript({ vmid: Number(computer.vmid), bindingTag: context.infrastructureBindingTag }, request.timeoutSeconds);
  const result = await runProxmoxHostScriptWithStdin(script, buildLinkExecPayload(request), context.env, {
    timeoutMs: (request.timeoutSeconds + 60) * 1000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const parsed = parseLinkExecOutput(result.stdout || "");
  if (parsed) return parsed;
  log.warn("agent link command had no answer", { source: "agent-links/exec", failureType: "agent_link_exec_unrecognized",
    userId, computerId: computer.id, ok: result.ok, errorMessage: result.error ?? null });
  return { status: "refused", reason: "guest_unreachable" };
}

async function runOnGvisor(userId: string, computer: OwnedRow, request: LinkExecRequest): Promise<LinkExecOutcome> {
  const stdin = request.stdin ?? Buffer.alloc(0);
  if (stdin.length > GVISOR_STDIN_MAX) return { status: "refused", reason: "stdin_too_large" };
  // The command reaches bash as one argv item; stdin, when there is any, is
  // decoded from a second one, so neither is ever parsed by another shell.
  const argv = stdin.length > 0
    ? ["/bin/bash", "-c", 'printf %s "$1" | base64 -d | timeout -k 5 "$2" /bin/bash -lc "$0"', request.command, stdin.toString("base64"), String(request.timeoutSeconds)]
    : ["timeout", "-k", "5", String(request.timeoutSeconds), "/bin/bash", "-lc", request.command];
  const started = Date.now();
  const receipt = await executeGvisorComputerCommand(userId, computer.id, argv) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
  const out = Buffer.from(typeof receipt.stdout === "string" ? receipt.stdout : "", "utf8");
  const err = Buffer.from(typeof receipt.stderr === "string" ? receipt.stderr : "", "utf8");
  const exitCode = Number.isInteger(receipt.exitCode) ? Number(receipt.exitCode) : 1;
  return {
    status: "ran", exitCode, stdout: out.subarray(0, LINK_EXEC_STDOUT_MAX), stderr: err.subarray(0, LINK_EXEC_STDERR_MAX),
    stdoutTruncated: out.length > LINK_EXEC_STDOUT_MAX, stderrTruncated: err.length > LINK_EXEC_STDERR_MAX,
    timedOut: exitCode === 124 || exitCode === 137, durationMs: Date.now() - started,
  };
}

export async function runLinkedCommand(userId: string, computer: OwnedRow, request: LinkExecRequest): Promise<LinkExecOutcome> {
  if (!validExecRequest(request)) return { status: "refused", reason: "request_invalid" };
  const target = linkTarget(computer);
  if (!target.ok) return { status: "refused", reason: "not_supported" };
  if (computer.status !== "running") return { status: "refused", reason: "computer_not_running" };
  try {
    return target.lane === "gvisor" ? await runOnGvisor(userId, computer, request) : await runOnProxmox(userId, computer, request);
  } catch (error) {
    log.warn("agent link command failed", { source: "agent-links/exec", failureType: "agent_link_exec_failed",
      userId, computerId: computer.id, errorMessage: error instanceof Error ? error.message : String(error) });
    return { status: "refused", reason: "computer_unreachable" };
  }
}
