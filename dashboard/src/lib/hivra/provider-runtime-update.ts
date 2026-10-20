import "server-only";

// Owner-triggered runtime update for a running agent on a My cloud computer
// (a provider VM): the same reviewed guest half the Proxmox updater runs
// (hivra-guest-runtime-update.sh), reaching the computer over its enrolled
// provider pin instead of a Proxmox host.
//
// An SSH session to a provider computer is bounded to seconds, so the update
// runs detached inside the guest. Dispatch writes this release's runtime
// files and the guest half into a fresh root-only directory named for the
// operation (once only: a second dispatch of the same operation is refused by
// the guest) and starts them as a transient unit. The agent poll observes the
// unit's own exit and commit line and settles the operation lease
// (claim_hivra_provider_runtime_update / finish_hivra_provider_runtime_update).
// The guest half rolls the runtime back itself on any failure.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { loadPortableProvisionerBundle, type PortableProvisionerBundleAsset } from "@/lib/infrastructure/connection-preparation";
import { PROVIDER_RUNTIME_UPDATE_TYPES } from "./lifecycle-support";
import { PROVIDER_RUNTIME_UPDATE_FAILED, PROVIDER_RUNTIME_UPDATE_LOST, PROVIDER_RUNTIME_UPDATE_NOT_STARTED,
  type ProviderRuntimeUpdateStage } from "./provider-runtime-update-contract";
import { providerAgentGuestContext, runProviderAgentGuestScript, ScopeRow, type ProviderGuestSeedRef } from "./provider-guest-seed";

const Uuid = z.string().uuid();
const Operation = z.object({ userId: z.string().min(1).max(256), agentId: Uuid, operationId: Uuid }).strict();
export type ProviderRuntimeUpdateOperation = z.infer<typeof Operation>;


/** The gateway assets and terminal files the guest half expects, as the Proxmox host half archives them. */
const GATEWAY_ASSETS = ["server.js", "llm-application.js", "guarded-files.cjs", "agent-zero-editor.cjs", "chat-runs.cjs", "index.html", "app.js"] as const;
const TERMINAL_ASSETS = ["hivra-agent-shell", "bux-ttyd-base-path.conf", "bux-box-ttyd.service", "agent-cli-versions.json",
  "hivra-agent-cli-update.sh", "hivra-codex-config-pin.py", "hivra-tg-apply", "hivra-claude-app.py", "hivra-claude-app.service",
  "claude-desktop-pin.json"] as const;
const GUEST_HALF = "hivra-guest-runtime-update.sh";

/** Nothing landed in the guest this long after the claim: the dispatch never ran. */
export const PROVIDER_RUNTIME_UPDATE_DISPATCH_MS = 3 * 60_000;
/** The unit's own limit (RuntimeMaxSec) plus margin. */
export const PROVIDER_RUNTIME_UPDATE_MAX_MS = 20 * 60_000;
const UNIT_RUNTIME_MAX_SECONDS = 900;

const OpRow = ScopeRow.extend({
  type: z.enum(PROVIDER_RUNTIME_UPDATE_TYPES), status: z.literal("provisioning"), desired_state: z.string(),
  operation_id: Uuid, operation_kind: z.literal("runtime_update"),
  operation_started_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
});

class ProviderRuntimeUpdateError extends Error {
  constructor() { super("The My cloud runtime update could not be verified."); this.name = "ProviderRuntimeUpdateError"; }
}

function database() {
  if (!supabaseAdmin) throw new ProviderRuntimeUpdateError();
  return supabaseAdmin;
}

async function loadOperationRow(raw: ProviderRuntimeUpdateOperation) {
  const operation = Operation.parse(raw);
  const { data, error } = await database().from("hivra_agents").select(Object.keys(OpRow.shape).join(","))
    .eq("id", operation.agentId).eq("user_id", operation.userId).eq("computer_substrate", "provider-vm")
    .eq("operation_id", operation.operationId).eq("operation_kind", "runtime_update").maybeSingle();
  if (error) throw new ProviderRuntimeUpdateError();
  return { operation, row: OpRow.parse(data) };
}

/** The lane's loader for a computer this update holds: same pin and scope as a seed. */
function operationContextLoader(operation: ProviderRuntimeUpdateOperation) {
  return async (ref: ProviderGuestSeedRef) => {
    if (ref.agentId !== operation.agentId || ref.userId !== operation.userId) throw new ProviderRuntimeUpdateError();
    const { row } = await loadOperationRow(operation);
    return providerAgentGuestContext(ref, row);
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function unitName(operationId: string): string {
  return `hivra-runtime-update-${operationId.replace(/-/g, "").slice(0, 16)}`;
}

function directory(operationId: string): string {
  return `/var/lib/hivra/runtime-update/provider-${operationId}`;
}

/**
 * The dispatch script: write this release's runtime files and guest half into
 * the operation's own new directory, archive them in the layout the guest
 * half expects, and start it as a transient unit. Payloads are gzip+base64
 * literals inside the script, so nothing reaches argv or a log.
 */
export function buildProviderRuntimeUpdateDispatchScript(operationId: string, assets: PortableProvisionerBundleAsset[]): string {
  Uuid.parse(operationId);
  const byPath = new Map(assets.map(asset => [asset.relativePath, asset.content]));
  const files: Array<[string, Buffer]> = [];
  for (const name of GATEWAY_ASSETS) files.push([`hivra-chat/${name}`, required(byPath, `hivra-chat/${name}`)]);
  for (const name of TERMINAL_ASSETS) files.push([name, required(byPath, name)]);
  const guest = required(byPath, GUEST_HALF);
  const dir = directory(operationId);
  const lines = [
    "set -e",
    "umask 077",
    "export PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    `DIR=${shellQuote(dir)}`,
    "[ -d /var/lib/hivra ] || install -d -o root -g root -m 0711 /var/lib/hivra",
    "install -d -o root -g root -m 0700 /var/lib/hivra/runtime-update",
    // Finished updates are kept a week for diagnosis, then removed.
    "find /var/lib/hivra/runtime-update -mindepth 1 -maxdepth 1 -name 'provider-*' -mtime +7 -exec rm -rf -- {} + 2>/dev/null || true",
    // Once only: a replayed dispatch of the same operation never runs twice.
    "mkdir -m 0700 \"$DIR\"",
    "mkdir -m 0700 \"$DIR/source\" \"$DIR/source/hivra-chat\"",
  ];
  const write = (target: string, content: Buffer) => {
    const digest = createHash("sha256").update(content).digest("hex");
    lines.push(`printf '%s' ${shellQuote(gzipSync(content).toString("base64"))} | base64 -d | gunzip -c > ${shellQuote(target)}`);
    lines.push(`[ "$(sha256sum ${shellQuote(target)} | cut -d' ' -f1)" = ${digest} ]`);
  };
  for (const [relative, content] of files) write(`${dir}/source/${relative}`, content);
  write(`${dir}/guest.sh`, guest);
  const runner = [
    "cd /",
    `DIR=${shellQuote(dir)}`,
    "SHA=\"$(sha256sum \"$DIR/runtime.tar.gz\" | cut -d' ' -f1)\"",
    `HIVRA_RUNTIME_ARCHIVE="$DIR/runtime.tar.gz" HIVRA_RUNTIME_ARCHIVE_SHA256="$SHA" HIVRA_CHAT_PORT=8080 HIVRA_RUNTIME_UPDATE_SECONDS=${UNIT_RUNTIME_MAX_SECONDS - 60} \\`,
    "  /bin/bash \"$DIR/guest.sh\" >\"$DIR/result\" 2>\"$DIR/error\"",
    "printf '%s\\n' \"$?\" >\"$DIR/exit.next\"",
    "mv -f \"$DIR/exit.next\" \"$DIR/exit\"",
  ].join("\n") + "\n";
  write(`${dir}/run.sh`, Buffer.from(runner));
  lines.push(
    `tar -czf "$DIR/runtime.tar.gz" -C "$DIR/source/hivra-chat" ${GATEWAY_ASSETS.join(" ")} -C "$DIR/source" ${TERMINAL_ASSETS.join(" ")}`,
    "rm -rf -- \"$DIR/source\"",
    `systemd-run --quiet --no-ask-password --collect --unit=${unitName(operationId)} --service-type=exec \\`,
    `  --property=RuntimeMaxSec=${UNIT_RUNTIME_MAX_SECONDS}s --property=KillMode=control-group --property=UMask=0077 \\`,
    "  /bin/bash \"$DIR/run.sh\"",
    // Written only once the unit started, so a status read can tell an update
    // that never started from one that stopped without finishing.
    ": > \"$DIR/dispatched\"",
    `printf 'HIVRA_PROVIDER_RUNTIME_UPDATE_DISPATCHED %s\\n' ${shellQuote(operationId)}`,
  );
  return `${lines.join("\n")}\n`;
}

function required(byPath: Map<string, Buffer>, relativePath: string): Buffer {
  const content = byPath.get(relativePath);
  if (!content) throw new ProviderRuntimeUpdateError();
  return content;
}

/** Read-only: what the guest says about this operation's update. */
export function buildProviderRuntimeUpdateStatusScript(operationId: string): string {
  Uuid.parse(operationId);
  return [
    "set -e",
    "export PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    `DIR=${shellQuote(directory(operationId))}`,
    "if [ ! -d \"$DIR\" ]; then echo 'HIVRA_PROVIDER_RUNTIME_UPDATE_STATE absent'; exit 0; fi",
    "if [ -f \"$DIR/exit\" ]; then",
    "  code=\"$(head -c 8 \"$DIR/exit\" | tr -cd '0-9')\"",
    "  committed=0; grep -Fxq HIVRA_GUEST_RUNTIME_UPDATED \"$DIR/result\" 2>/dev/null && committed=1",
    "  printf 'HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished %s %s\\n' \"${code:-255}\" \"$committed\"",
    "  grep -m1 -xE 'HIVRA_AGENT_CLI name=(claude-code|codex) version=([0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}|unknown) target=[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6} state=(current|scheduled|running|failed)' \"$DIR/result\" 2>/dev/null || true",
    "  exit 0",
    "fi",
    `state="$(systemctl show -p ActiveState --value ${unitName(operationId)}.service 2>/dev/null || true)"`,
    "case \"$state\" in active|activating|deactivating|reloading) echo 'HIVRA_PROVIDER_RUNTIME_UPDATE_STATE running'; exit 0;; esac",
    // No unit and no exit: either the dispatch stopped before starting it, or it stopped without finishing.
    "if [ -f \"$DIR/dispatched\" ]; then echo 'HIVRA_PROVIDER_RUNTIME_UPDATE_STATE lost'; else echo 'HIVRA_PROVIDER_RUNTIME_UPDATE_STATE absent'; fi",
  ].join("\n") + "\n";
}

export type ProviderRuntimeUpdateGuestState =
  | { state: "absent" } | { state: "running" } | { state: "lost" }
  | { state: "finished"; exitCode: number; committed: boolean; agentCli: string | null };

export function parseProviderRuntimeUpdateStatus(output: string): ProviderRuntimeUpdateGuestState {
  const lines = output.split("\n").filter(Boolean);
  const head = /^HIVRA_PROVIDER_RUNTIME_UPDATE_STATE (absent|running|lost|finished)(?: ([0-9]{1,3}) ([01]))?$/.exec(lines[0] ?? "");
  if (!head || lines.length > 2) throw new ProviderRuntimeUpdateError();
  if (head[1] !== "finished") {
    if (head[2] !== undefined || lines.length !== 1) throw new ProviderRuntimeUpdateError();
    return { state: head[1] as "absent" | "running" | "lost" };
  }
  if (head[2] === undefined) throw new ProviderRuntimeUpdateError();
  const cli = lines[1] ?? null;
  if (cli !== null && !/^HIVRA_AGENT_CLI name=(claude-code|codex) version=([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|unknown) target=[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6} state=(current|scheduled|running|failed)$/.test(cli)) {
    throw new ProviderRuntimeUpdateError();
  }
  return { state: "finished", exitCode: Number(head[2]), committed: head[3] === "1", agentCli: cli };
}

type Dependencies = {
  bundle: typeof loadPortableProvisionerBundle;
  run: typeof runProviderAgentGuestScript;
  finish: (operation: ProviderRuntimeUpdateOperation, outcome: "succeeded" | "failed", error: string | null) => Promise<boolean>;
  now: () => number;
};

async function finishOperation(operation: ProviderRuntimeUpdateOperation, outcome: "succeeded" | "failed", error: string | null) {
  const { data, error: rpcError } = await database().rpc("finish_hivra_provider_runtime_update", {
    p_user_id: operation.userId, p_agent_id: operation.agentId, p_operation_id: operation.operationId,
    p_outcome: outcome, p_error: error,
  });
  if (rpcError) throw new ProviderRuntimeUpdateError();
  return z.boolean().parse(data);
}

const defaults: Dependencies = { bundle: loadPortableProvisionerBundle, run: runProviderAgentGuestScript, finish: finishOperation, now: () => Date.now() };

/** Claim the computer's operation lease for one update. */
export async function claimProviderRuntimeUpdate(raw: ProviderRuntimeUpdateOperation): Promise<boolean> {
  const operation = Operation.parse(raw);
  const { data, error } = await database().rpc("claim_hivra_provider_runtime_update", {
    p_user_id: operation.userId, p_agent_id: operation.agentId, p_operation_id: operation.operationId,
  });
  if (error) throw new ProviderRuntimeUpdateError();
  return z.boolean().parse(data);
}

/**
 * Send the update once. "dispatched" only when the guest confirmed it started
 * the unit; "uncertain" when it may or may not have: the poll settles both.
 */
export async function dispatchProviderRuntimeUpdate(raw: ProviderRuntimeUpdateOperation,
  dependencies: Partial<Dependencies> = {}): Promise<"dispatched" | "uncertain"> {
  const deps = { ...defaults, ...dependencies };
  const operation = Operation.parse(raw);
  const script = buildProviderRuntimeUpdateDispatchScript(operation.operationId, await deps.bundle());
  const result = await deps.run({ userId: operation.userId, agentId: operation.agentId }, script,
    { load: operationContextLoader(operation) });
  return result.ok && result.stdout.split("\n").includes(`HIVRA_PROVIDER_RUNTIME_UPDATE_DISPATCHED ${operation.operationId}`)
    ? "dispatched" : "uncertain";
}

export { PROVIDER_RUNTIME_UPDATE_FAILED, PROVIDER_RUNTIME_UPDATE_LOST, PROVIDER_RUNTIME_UPDATE_NOT_STARTED };
export type { ProviderRuntimeUpdateStage };

/**
 * Observe the update from the agent poll and settle the lease once the guest
 * has an outcome. Never dispatches; a computer that can't be reached keeps
 * the operation until it can, or until the update's own time limit passes.
 */
export async function observeProviderRuntimeUpdate(raw: ProviderRuntimeUpdateOperation,
  dependencies: Partial<Dependencies> = {}): Promise<{ stage: ProviderRuntimeUpdateStage; agentCli: string | null }> {
  const deps = { ...defaults, ...dependencies };
  const operation = Operation.parse(raw);
  const { row } = await loadOperationRow(operation);
  const age = deps.now() - Date.parse(row.operation_started_at);
  const result = await deps.run({ userId: operation.userId, agentId: operation.agentId },
    buildProviderRuntimeUpdateStatusScript(operation.operationId), { load: operationContextLoader(operation) });
  let guest: ProviderRuntimeUpdateGuestState | null = null;
  if (result.ok) {
    try { guest = parseProviderRuntimeUpdateStatus(result.stdout); } catch { guest = null; }
  }
  const settle = async (outcome: "succeeded" | "failed", error: string | null) => {
    if (!await deps.finish(operation, outcome, error)) throw new ProviderRuntimeUpdateError();
  };
  if (guest?.state === "finished") {
    if (guest.exitCode === 0 && guest.committed) {
      await settle("succeeded", null);
      return { stage: "updated", agentCli: guest.agentCli };
    }
    await settle("failed", PROVIDER_RUNTIME_UPDATE_FAILED);
    return { stage: "failed", agentCli: null };
  }
  if (guest?.state === "absent" && age >= PROVIDER_RUNTIME_UPDATE_DISPATCH_MS) {
    await settle("failed", PROVIDER_RUNTIME_UPDATE_NOT_STARTED);
    return { stage: "failed", agentCli: null };
  }
  if ((guest?.state === "lost" && age >= PROVIDER_RUNTIME_UPDATE_DISPATCH_MS) || age >= PROVIDER_RUNTIME_UPDATE_MAX_MS) {
    await settle("failed", PROVIDER_RUNTIME_UPDATE_LOST);
    return { stage: "failed", agentCli: null };
  }
  return { stage: guest ? "updating" : "verification_unavailable", agentCli: null };
}
