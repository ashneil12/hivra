// Moving an old Hermes agent onto the official Hermes: the state machine.
// Spec: docs/release/HERMES-OFFICIAL-MOVE.md.
//
// A move is a durable row (hermes_computer_moves). advanceMove takes the row's
// lease, does ONE unit of work and never waits on a guest job: a job is started
// in one call and its status file is read in later calls. It is called from the
// owner's page poll, from the POST that starts a move (through after()) and from
// the cron, so a closed browser or a fleet run still finishes. Every effect goes
// through MoveDeps, so the machine is tested with fakes and no host is touched.
//
// States: queued -> launching -> packing -> uploading -> unpacking -> finishing -> done,
// or failed / needs_attention, and undoing -> undone. A failure that must put the
// old agent back keeps the current state and walks `rollback-*` steps (stop the
// new gateway, start the old containers, restore the old row, delete the new
// computer) so only a finished outcome ends the move.

import { isHermesComputerEnabled } from "@/lib/hermes-computer/flag";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { HERMES_DEFAULT_MODEL, ModelKeySelectionSchema } from "@/lib/hivra/model-key-selection";
import { log } from "@/lib/logger";
import type { MoveCounts, MoveJobStatus, MovePart } from "@/lib/hermes-move/guest-jobs";
import {
  buildPackCommand,
  buildReadNewStatusGuestScript,
  buildReadOldStatusCommand,
  buildRestartOldCommand,
  buildStopNewGatewayGuestScript,
  buildUnpackGuestScript,
  buildUploadCommand,
  moveCountsArrived,
  parseMoveJobStatus,
} from "@/lib/hermes-move/guest-jobs";

// ---------------------------------------------------------------- types

export const ACTIVE_STATES = ["queued", "launching", "packing", "uploading", "unpacking", "finishing", "undoing"] as const;
export const TERMINAL_STATES = ["done", "failed", "needs_attention", "undone"] as const;
export type MoveState = (typeof ACTIVE_STATES)[number] | (typeof TERMINAL_STATES)[number];

/**
 * The one list of how a move may change state. Rollback steps run inside the
 * move's current state (step "rollback-*") and end in failed; anything that
 * cannot be rolled back ends in needs_attention. Only a done move may reopen,
 * into undoing. The database trigger in
 * 20261112130000_explicit_state_transitions.sql enforces the same list.
 */
export const MOVE_TRANSITIONS: Readonly<Record<MoveState, readonly MoveState[]>> = {
  queued: ["launching", "failed", "needs_attention"],
  launching: ["packing", "failed", "needs_attention"],
  packing: ["uploading", "failed", "needs_attention"],
  uploading: ["unpacking", "failed", "needs_attention"],
  unpacking: ["finishing", "failed", "needs_attention"],
  finishing: ["done", "failed", "needs_attention"],
  undoing: ["undone", "needs_attention"],
  done: ["undoing"],
  failed: [],
  needs_attention: [],
  undone: [],
};

export function canMoveTransition(from: MoveState, to: MoveState): boolean {
  return from === to || MOVE_TRANSITIONS[from].includes(to);
}

export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const OLD_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

const LEASE_MS = 2 * 60_000;
const LAUNCH_LEASE_MS = 10 * 60_000;
const LAUNCH_WAIT_MS = 60 * 60_000;
const PACK_WAIT_MS = 60 * 60_000;
const UPLOAD_WAIT_MS = 45 * 60_000;
const UNPACK_WAIT_MS = 45 * 60_000;
const RESTART_WAIT_MS = 15 * 60_000;
const MAX_STEP_ATTEMPTS = 8;
const MAX_STATUS_READ_FAILURES = 10;

export interface MoveRow {
  id: string;
  user_id: string;
  instance_id: string;
  agent_id: string | null;
  state: MoveState;
  step: string;
  message: string;
  key_encrypted: string | null;
  parts: MovePart[] | null;
  counts_before: MoveCounts | null;
  counts_after: MoveCounts | null;
  managed_model: boolean | null;
  initiated_by: "owner" | "operator";
  error: string | null;
  failure: { failureType: string; reason: string; technical: string; setupLog?: string } | null;
  lease_until: string | null;
  prev_instance_status: string | null;
  step_attempts: number;
  step_started_at: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  undo_until: string | null;
}

export type MovePatch = Partial<Omit<MoveRow, "id" | "user_id" | "instance_id">>;

export interface InstanceRow {
  id: string;
  user_id: string;
  name: string;
  status: string | null;
  backend?: string | null;
  cpu_limit?: number | null;
  ram_limit?: number | null;
  deleted_at?: string | null;
  config: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface AgentRow {
  id: string;
  user_id: string;
  status: string;
  error?: string | null;
  [key: string]: unknown;
}

export interface CommandResult { ok: boolean; stdout: string; stderr: string; error?: string }

export interface MoveStore {
  insertMove(row: { user_id: string; instance_id: string; initiated_by: "owner" | "operator"; key_encrypted: string }): Promise<MoveRow>;
  getMove(id: string): Promise<MoveRow | null>;
  /** Take the advance lease if it is free or expired. Null when someone else holds it. */
  claimLease(id: string, leaseUntil: string, nowIso: string): Promise<MoveRow | null>;
  patchMove(id: string, patch: MovePatch): Promise<void>;
  /** Compare-and-set on state, for undo. Null when the state had changed. */
  transitionMove(id: string, fromState: MoveState, patch: MovePatch): Promise<MoveRow | null>;
  activeMoveForInstance(instanceId: string): Promise<MoveRow | null>;
  latestMoveForInstance(instanceId: string): Promise<MoveRow | null>;
  /** The newest finished-or-active move that created this agent. */
  moveForAgent(agentId: string): Promise<MoveRow | null>;
  listActiveMoves(): Promise<MoveRow[]>;
  listMoves(limit: number): Promise<MoveRow[]>;
  getInstance(id: string): Promise<InstanceRow | null>;
  patchInstance(id: string, patch: Record<string, unknown>): Promise<void>;
  getAgent(id: string): Promise<AgentRow | null>;
  /** The Hermes computer a launch created for this owner since the given time, if any. */
  findLaunchedAgent(input: { userId: string; name: string; since: string; excludeIds: string[] }): Promise<AgentRow | null>;
  relinkWalletToAgent(instanceId: string, agentId: string): Promise<void>;
  relinkWalletToInstance(agentId: string, instanceId: string): Promise<void>;
}

export interface MoveDeps {
  store: MoveStore;
  now: () => Date;
  randomKeyHex: () => string;
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  /** launchHivraAgentForUser: returns the POST /api/hivra/agents response. */
  launch: (userId: string, body: Record<string, unknown>, options: { moveFromInstanceId: string }) => Promise<Response>;
  /** One observation of a provisioning computer (flips it to running when the host says ready). Returns the fresh row. */
  observeLaunch: (userId: string, agent: AgentRow) => Promise<AgentRow>;
  /** A command on the OLD guest (VMID-bound ssh). */
  sshOld: (instance: InstanceRow, command: string, timeoutMs: number) => Promise<CommandResult>;
  /** A root script on the NEW guest, wrapped in the pinned host script. */
  runNewGuest: (userId: string, agent: AgentRow, guestScript: string, timeoutMs: number) => Promise<CommandResult>;
  shutdownOldVm: (instance: InstanceRow) => Promise<CommandResult>;
  startOldVm: (instance: InstanceRow) => Promise<CommandResult>;
  deleteNewComputer: (userId: string, agent: AgentRow) => Promise<{ ok: boolean; message?: string }>;
  /** The tail of the host's setup log for the new computer, read before it is removed (removal deletes the log). */
  readNewSetupLog: (userId: string, agent: AgentRow) => Promise<string | null>;
  storage: {
    uploadUrl: (path: string) => Promise<string>;
    downloadUrl: (path: string) => Promise<string>;
    remove: (paths: string[]) => Promise<void>;
  };
  alert: (event: { title: string; message: string; moveId: string; userId: string; instanceId: string; failureType: string }) => Promise<void>;
  isEnabled: () => boolean;
}

export class MoveRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "MoveRequestError";
  }
}

// ---------------------------------------------------------------- views and offer

export interface MoveView {
  id: string;
  instanceId: string;
  agentId: string | null;
  state: MoveState;
  step: string;
  message: string;
  startedAt: string;
  finishedAt: string | null;
  undoUntil: string | null;
}

export function toMoveView(row: MoveRow): MoveView {
  return {
    id: row.id,
    instanceId: row.instance_id,
    agentId: row.agent_id,
    state: row.state,
    step: row.step,
    message: row.message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    undoUntil: row.undo_until,
  };
}

export function isActiveMove(row: Pick<MoveRow, "state"> | null | undefined): boolean {
  return Boolean(row) && (ACTIVE_STATES as readonly string[]).includes(row!.state);
}

export type MoveOfferReason =
  | "available"
  | "not_enabled"
  | "not_hermes"
  | "not_running"
  | "already_moved"
  | "move_in_progress";

export interface MoveOffer { available: boolean; reason: MoveOfferReason }

export function movedToOf(row: { config?: Record<string, unknown> | null }): { agentId: string; moveId?: string; at?: string } | null {
  const moved = row.config?.movedTo as { agentId?: unknown; moveId?: unknown; at?: unknown } | undefined;
  if (!moved || typeof moved.agentId !== "string") return null;
  return {
    agentId: moved.agentId,
    ...(typeof moved.moveId === "string" ? { moveId: moved.moveId } : {}),
    ...(typeof moved.at === "string" ? { at: moved.at } : {}),
  };
}

function hasProxmoxHandle(config: Record<string, unknown> | null | undefined): boolean {
  const infra = config?.infrastructure as { provider?: unknown; vmid?: unknown } | undefined;
  return Boolean(infra && infra.provider === "proxmox" && infra.vmid);
}

/**
 * Whether an old Hermes agent can be moved now. Pure: the routes pass the
 * row's active move (if they have read it) so an in-flight move reads as such.
 */
export function moveOffer(
  instance: Pick<InstanceRow, "status" | "backend" | "deleted_at" | "config">,
  activeMove?: Pick<MoveRow, "state"> | null,
  enabled: boolean = isHermesComputerEnabled(),
): MoveOffer {
  if (!enabled) return { available: false, reason: "not_enabled" };
  if (movedToOf(instance) || instance.status === "scheduled_for_deletion") return { available: false, reason: "already_moved" };
  if (isActiveMove(activeMove)) return { available: false, reason: "move_in_progress" };
  const webfree = instance.backend === "webui" || instance.backend === "gateway";
  if (!webfree || !hasProxmoxHandle(instance.config) || instance.deleted_at) return { available: false, reason: "not_hermes" };
  if (instance.status !== "running") return { available: false, reason: "not_running" };
  return { available: true, reason: "available" };
}

// ---------------------------------------------------------------- start

export async function startMove(
  input: { userId: string; instanceId: string; initiatedBy: "owner" | "operator" },
  deps: MoveDeps,
): Promise<MoveRow> {
  const instance = await deps.store.getInstance(input.instanceId);
  if (!instance || instance.user_id !== input.userId) throw new MoveRequestError("Agent not found.", 404, "not_found");
  const active = await deps.store.activeMoveForInstance(input.instanceId);
  const offer = moveOffer(instance, active, deps.isEnabled());
  if (!offer.available) {
    throw new MoveRequestError(offerMessage(offer.reason), offer.reason === "move_in_progress" ? 409 : 409, offer.reason);
  }
  try {
    return await deps.store.insertMove({
      user_id: input.userId,
      instance_id: input.instanceId,
      initiated_by: input.initiatedBy,
      key_encrypted: deps.encrypt(deps.randomKeyHex()),
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new MoveRequestError(offerMessage("move_in_progress"), 409, "move_in_progress");
    }
    throw err;
  }
}

function offerMessage(reason: MoveOfferReason): string {
  switch (reason) {
    case "move_in_progress": return "A move is already running for this agent.";
    case "already_moved": return "This agent has already moved.";
    case "not_running": return "Start this agent before moving it.";
    case "not_enabled": return "Moving to the official Hermes is not available yet.";
    default: return "This agent cannot be moved.";
  }
}

// ---------------------------------------------------------------- advance

/**
 * Run one unit of work on a move. Idempotent: a call that cannot take the lease
 * (another call is mid-step) changes nothing and returns the row as it is.
 */
export async function advanceMove(moveId: string, deps: MoveDeps): Promise<MoveRow | null> {
  const now = deps.now();
  const current = await deps.store.getMove(moveId);
  if (!current || !isActiveMove(current)) return current;
  const leaseMs = current.state === "queued" || (current.state === "launching" && current.step === "creating") ? LAUNCH_LEASE_MS : LEASE_MS;
  const claimed = await deps.store.claimLease(moveId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString());
  if (!claimed) return current;

  let patch: MovePatch;
  try {
    patch = await runStep(claimed, deps);
  } catch (err) {
    patch = await handleStepError(claimed, err, deps);
  }
  const done = { ...patch, lease_until: null, updated_at: deps.now().toISOString() };
  await deps.store.patchMove(moveId, done);
  return { ...claimed, ...done };
}

async function handleStepError(row: MoveRow, err: unknown, deps: MoveDeps): Promise<MovePatch> {
  const technical = err instanceof Error ? err.message : String(err);
  const attempts = row.step_attempts + 1;
  log.warn("hermes move step failed", { source: "hermes-move", moveId: row.id, step: row.step, attempts, errorMessage: technical.slice(0, 300) });
  if (attempts < MAX_STEP_ATTEMPTS) return { step_attempts: attempts, error: technical.slice(0, 500) };
  return escalate(row, "move_step_failed", technical, deps);
}

/** A step that kept failing: roll back if the old agent can still be put back, else call for help. */
async function escalate(row: MoveRow, failureType: string, technical: string, deps: MoveDeps): Promise<MovePatch> {
  const reason = "Something went wrong while moving your agent.";
  if (row.state === "finishing" || row.state === "undoing" || row.step.startsWith("rollback-")) {
    return needsAttention(row, failureType, reason, technical, deps);
  }
  return beginRollback(row, { failureType, reason, technical, fromPack: row.state === "queued" || row.state === "launching", stopNew: row.state === "unpacking" }, deps);
}

async function runStep(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const key = `${row.state}/${row.step}`;
  if (row.step.startsWith("rollback-") || row.step.startsWith("undo-")) return runRestoreStep(row, deps);
  switch (key) {
    case "queued/queued": return stepStartLaunch(row, deps);
    case "launching/creating": return stepRecoverLaunch(row, deps);
    case "launching/starting": return stepWaitForComputer(row, deps);
    case "packing/pack-running": return stepWatchPack(row, deps);
    case "uploading/upload-running": return stepWatchUpload(row, deps);
    case "unpacking/unpack-running": return stepWatchUnpack(row, deps);
    case "finishing/finish": return stepFinish(row, deps);
    default:
      throw new Error(`no step for ${key}`);
  }
}

// ---------------------------------------------------------------- helpers

const iso = (d: Date) => d.toISOString();

function elapsedMs(row: MoveRow, deps: MoveDeps): number {
  const start = row.step_started_at ? Date.parse(row.step_started_at) : NaN;
  return Number.isFinite(start) ? deps.now().getTime() - start : 0;
}

function plainFailure(reason: string): string {
  return `${reason} Your agent was started again as it was, and nothing was lost.`;
}

async function oldInstance(row: MoveRow, deps: MoveDeps): Promise<InstanceRow> {
  const instance = await deps.store.getInstance(row.instance_id);
  if (!instance) throw new Error("the old agent's record is missing");
  return instance;
}

async function newAgent(row: MoveRow, deps: MoveDeps): Promise<AgentRow> {
  if (!row.agent_id) throw new Error("the move has no new computer yet");
  const agent = await deps.store.getAgent(row.agent_id);
  if (!agent) throw new Error("the new computer's record is missing");
  return agent;
}

function keyHex(row: MoveRow, deps: MoveDeps): string {
  if (!row.key_encrypted) throw new Error("the move has no key");
  return deps.decrypt(row.key_encrypted);
}

function startedOk(res: CommandResult): boolean {
  return res.ok && /started/.test(res.stdout || "");
}

async function readJob(
  deps: MoveDeps,
  side: { kind: "old"; instance: InstanceRow; moveId: string; job: "pack" | "upload" | "restart-old" }
    | { kind: "new"; userId: string; agent: AgentRow; moveId: string; job: "unpack" | "stop-new-gateway" },
): Promise<MoveJobStatus | null> {
  const res = side.kind === "old"
    ? await deps.sshOld(side.instance, buildReadOldStatusCommand(side.moveId, side.job), 30_000)
    : await deps.runNewGuest(side.userId, side.agent, buildReadNewStatusGuestScript(side.moveId, side.job), 30_000);
  if (!res.ok) return null;
  return parseMoveJobStatus(res.stdout);
}

// ---------------------------------------------------------------- launch

function launchBody(instance: InstanceRow): Record<string, unknown> {
  const oldCpu = Number(instance.cpu_limit) || 1;
  const oldRamGb = (Number(instance.ram_limit) || 2048) / 1024;
  const configured = typeof instance.config?.model === "string" ? instance.config.model.trim() : "";
  const valid = configured && ModelKeySelectionSchema.safeParse({ provider: "venice", mode: "managed", model: configured }).success;
  return {
    type: "hermes",
    name: instance.name,
    cpu: Math.max(1, Math.ceil(oldCpu * 2) / 2),
    ram: Math.max(2, Math.ceil(oldRamGb)),
    deployment: { mode: "hivra-managed" },
    llm: { provider: "venice", mode: "managed", model: valid ? configured : HERMES_DEFAULT_MODEL },
  };
}

/**
 * The setup log as kept on the move record: printable text only, anything that
 * looks like a key or token replaced, and only the last part. Service role only;
 * owners never see it.
 */
export function redactSetupLog(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=\S+/gi, "$1=[redacted]")
    .replace(/(authorization:\s*)\S+(\s+\S+)?/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]")
    .split("\n").map((line) => line.trimEnd()).filter(Boolean).join("\n")
    .slice(-4000);
}

async function failBeforeChange(row: MoveRow, failureType: string, reason: string, technical: string, deps: MoveDeps, deleteNew: boolean): Promise<MovePatch> {
  let setupLog: string | null = null;
  if (deleteNew && row.agent_id) {
    const agent = await deps.store.getAgent(row.agent_id);
    if (agent) {
      // Removing the computer deletes its setup log, so keep why it failed first.
      setupLog = await deps.readNewSetupLog(row.user_id, agent).then((t) => (t ? redactSetupLog(t) : null)).catch((e) => {
        log.warn("hermes move could not read the new computer's setup log", { source: "hermes-move", moveId: row.id, errorMessage: String(e).slice(0, 200) });
        return null;
      });
      await deps.deleteNewComputer(row.user_id, agent).catch((e) => log.warn("hermes move could not remove the new computer", { source: "hermes-move", moveId: row.id, errorMessage: String(e).slice(0, 200) }));
    }
  }
  return {
    state: "failed",
    step: "failed",
    message: `${reason} Nothing was changed on your agent.`,
    error: technical.slice(0, 500),
    failure: { failureType, reason, technical: technical.slice(0, 500), ...(setupLog ? { setupLog } : {}) },
    finished_at: iso(deps.now()),
    step_attempts: 0,
  };
}

async function stepStartLaunch(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const instance = await oldInstance(row, deps);
  const offer = moveOffer(instance, null, deps.isEnabled());
  if (!offer.available) {
    return failBeforeChange(row, "move_not_available", offerMessage(offer.reason), `offer ${offer.reason}`, deps, false);
  }
  const startedAt = iso(deps.now());
  // A move an operator queued straight into the table carries no key (only the
  // server can encrypt one), so it gets its key here, before anything is packed.
  const keyPatch: MovePatch = row.key_encrypted ? {} : { key_encrypted: deps.encrypt(deps.randomKeyHex()) };
  // Recorded first: a launch that outlives this call can be found again by its time.
  await deps.store.patchMove(row.id, { state: "launching", step: "creating", message: "Setting up the new computer.", step_started_at: startedAt, step_attempts: 0, ...keyPatch });
  let response: Response;
  try {
    response = await deps.launch(row.user_id, launchBody(instance), { moveFromInstanceId: instance.id });
  } catch (err) {
    const found = await deps.store.findLaunchedAgent({ userId: row.user_id, name: instance.name, since: startedAt, excludeIds: [] });
    if (found) return { agent_id: found.id, step: "starting", step_attempts: 0, step_started_at: iso(deps.now()) };
    return failBeforeChange({ ...row, state: "launching" }, "move_launch_failed", "The new computer could not be set up.", err instanceof Error ? err.message : String(err), deps, false);
  }
  const json = await response.json().catch(() => null) as { data?: { agent?: { id?: unknown } }; error?: unknown } | null;
  const id = json?.data?.agent?.id;
  if (!response.ok || typeof id !== "string") {
    const technical = typeof json?.error === "string" ? json.error : `launch answered ${response.status}`;
    const found = await deps.store.findLaunchedAgent({ userId: row.user_id, name: instance.name, since: startedAt, excludeIds: [] });
    if (found) return failBeforeChange({ ...row, state: "launching", agent_id: found.id }, "move_launch_failed", "The new computer could not be set up.", technical, deps, true);
    const reason = response.status === 402 || response.status === 409 || response.status === 400
      ? `The new computer could not be set up: ${technical}`
      : "The new computer could not be set up.";
    return failBeforeChange({ ...row, state: "launching" }, "move_launch_failed", reason, technical, deps, false);
  }
  return { state: "launching", agent_id: id, step: "starting", message: "Setting up the new computer.", step_attempts: 0, step_started_at: iso(deps.now()) };
}

/** A launch call that never reported back (its function ran out of time): find what it created. */
async function stepRecoverLaunch(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const instance = await oldInstance(row, deps);
  const found = await deps.store.findLaunchedAgent({
    userId: row.user_id,
    name: instance.name,
    since: row.step_started_at ?? row.started_at,
    excludeIds: [],
  });
  if (found) return { agent_id: found.id, step: "starting", step_attempts: 0, step_started_at: iso(deps.now()) };
  return failBeforeChange(row, "move_launch_lost", "The new computer could not be set up.", "launch did not report back and created nothing", deps, false);
}

async function stepWaitForComputer(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  let agent = await newAgent(row, deps);
  if (agent.status === "provisioning") {
    agent = await deps.observeLaunch(row.user_id, agent).catch((e) => {
      log.warn("hermes move could not observe the launch", { source: "hermes-move", moveId: row.id, errorMessage: String(e).slice(0, 200) });
      return agent;
    });
  }
  if (agent.status === "error" || agent.status === "deleted") {
    return failBeforeChange(row, "move_new_computer_failed", "The new computer could not be set up.", String(agent.error ?? agent.status).slice(0, 300), deps, true);
  }
  if (agent.status !== "running") {
    if (elapsedMs(row, deps) > LAUNCH_WAIT_MS) {
      return failBeforeChange(row, "move_new_computer_timeout", "The new computer took too long to set up.", "launch did not finish in time", deps, true);
    }
    return {};
  }
  return startPack(row, agent, deps);
}

// ---------------------------------------------------------------- pack

async function startPack(row: MoveRow, agent: AgentRow, deps: MoveDeps): Promise<MovePatch> {
  const instance = await oldInstance(row, deps);
  if (instance.status !== "running") {
    return failBeforeChange(row, "move_old_not_running", "Your agent was not running when the move reached it.", `old status ${instance.status}`, deps, true);
  }
  // Stopped (paused) first so the old lane's restart and health crons leave it alone while it is packed.
  await deps.store.patchInstance(instance.id, buildInstanceLifecyclePatch("stopped", { now: deps.now() }));
  await deps.store.patchMove(row.id, { prev_instance_status: instance.status });
  const res = await deps.sshOld(instance, buildPackCommand({ moveId: row.id, instanceId: instance.id, keyHex: keyHex(row, deps) }), 60_000);
  if (!startedOk(res)) {
    await deps.store.patchInstance(instance.id, buildInstanceLifecyclePatch(instance.status ?? "running", { now: deps.now() }));
    return failBeforeChange({ ...row, agent_id: agent.id }, "move_pack_not_started", "Your data could not be packed.", (res.error || res.stderr || "pack did not start").slice(0, 300), deps, true);
  }
  return { state: "packing", step: "pack-running", message: "Packing your data.", prev_instance_status: instance.status, step_started_at: iso(deps.now()), step_attempts: 0 };
}

async function stepWatchPack(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const instance = await oldInstance(row, deps);
  const status = await readJob(deps, { kind: "old", instance, moveId: row.id, job: "pack" });
  if (!status) return unreadable(row, deps, "pack status could not be read", { fromPack: false, stopNew: false });
  if (status.state === "running") {
    if (elapsedMs(row, deps) > PACK_WAIT_MS) {
      return beginRollback(row, { failureType: "move_pack_timeout", reason: "Packing your data took too long.", technical: "pack timed out", fromPack: false, stopNew: false }, deps);
    }
    return row.step_attempts ? { step_attempts: 0 } : {};
  }
  if (status.state === "failed") {
    // The pack job starts the old containers again by itself.
    return beginRollback(row, { failureType: "move_pack_failed", reason: "Your data could not be packed.", technical: status.message || status.step, fromPack: true, stopNew: false }, deps);
  }
  const result = status.result as { parts?: MovePart[]; counts?: MoveCounts; managedModel?: boolean } | undefined;
  if (!result || !Array.isArray(result.parts) || result.parts.length === 0 || !result.counts) {
    return beginRollback(row, { failureType: "move_pack_result_invalid", reason: "Your data could not be packed.", technical: "pack finished without a usable result", fromPack: false, stopNew: false }, deps);
  }
  const packed: MoveRow = { ...row, parts: result.parts, counts_before: result.counts, managed_model: Boolean(result.managedModel) };
  const base: MovePatch = { parts: result.parts, counts_before: result.counts, managed_model: Boolean(result.managedModel) };
  try {
    const uploads = await Promise.all(result.parts.map(async (part) => ({ name: part.name, url: await deps.storage.uploadUrl(`${row.id}/${part.name}`) })));
    const res = await deps.sshOld(instance, buildUploadCommand({ moveId: row.id, instanceId: instance.id, uploads }), 60_000);
    if (!startedOk(res)) throw new Error((res.error || res.stderr || "upload did not start").slice(0, 300));
  } catch (err) {
    return { ...base, ...(await beginRollback(packed, { failureType: "move_upload_not_started", reason: "Your data could not be copied.", technical: err instanceof Error ? err.message : String(err), fromPack: false, stopNew: false }, deps)) };
  }
  return { ...base, state: "uploading", step: "upload-running", message: "Copying your data.", step_started_at: iso(deps.now()), step_attempts: 0 };
}

async function unreadable(row: MoveRow, deps: MoveDeps, technical: string, plan: { fromPack: boolean; stopNew: boolean }): Promise<MovePatch> {
  const attempts = row.step_attempts + 1;
  if (attempts < MAX_STATUS_READ_FAILURES) return { step_attempts: attempts };
  return beginRollback(row, { failureType: "move_status_unreadable", reason: "Something went wrong while moving your agent.", technical, ...plan }, deps);
}

// ---------------------------------------------------------------- upload

async function stepWatchUpload(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const instance = await oldInstance(row, deps);
  const status = await readJob(deps, { kind: "old", instance, moveId: row.id, job: "upload" });
  if (!status) return unreadable(row, deps, "upload status could not be read", { fromPack: false, stopNew: false });
  if (status.state === "running") {
    if (elapsedMs(row, deps) > UPLOAD_WAIT_MS) {
      return beginRollback(row, { failureType: "move_upload_timeout", reason: "Copying your data took too long.", technical: "upload timed out", fromPack: false, stopNew: false }, deps);
    }
    return row.step_attempts ? { step_attempts: 0 } : {};
  }
  if (status.state === "failed") {
    return beginRollback(row, { failureType: "move_upload_failed", reason: "Your data could not be copied.", technical: status.message || status.step, fromPack: false, stopNew: false }, deps);
  }
  // Uploaded: unpack on the new computer.
  try {
    const agent = await newAgent(row, deps);
    const parts = row.parts ?? [];
    const downloads = await Promise.all(parts.map(async (part) => ({
      name: part.name,
      url: await deps.storage.downloadUrl(`${row.id}/${part.name}`),
      sha256: part.sha256,
      bytes: part.bytes,
    })));
    const script = buildUnpackGuestScript({
      moveId: row.id,
      keyHex: keyHex(row, deps),
      downloads,
      expectedCounts: row.counts_before as MoveCounts,
      managedModel: Boolean(row.managed_model),
    });
    const res = await deps.runNewGuest(row.user_id, agent, script, 60_000);
    if (!res.ok) throw new Error((res.error || res.stderr || "unpack did not start").slice(0, 300));
  } catch (err) {
    return beginRollback(row, { failureType: "move_unpack_not_started", reason: "Your data could not be unpacked on the new computer.", technical: err instanceof Error ? err.message : String(err), fromPack: false, stopNew: true }, deps);
  }
  return { state: "unpacking", step: "unpack-running", message: "Unpacking and checking your data on the new computer.", step_started_at: iso(deps.now()), step_attempts: 0 };
}

// ---------------------------------------------------------------- unpack

async function stepWatchUnpack(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const agent = await newAgent(row, deps);
  const status = await readJob(deps, { kind: "new", userId: row.user_id, agent, moveId: row.id, job: "unpack" });
  if (!status) return unreadable(row, deps, "unpack status could not be read", { fromPack: false, stopNew: true });
  if (status.state === "running") {
    if (elapsedMs(row, deps) > UNPACK_WAIT_MS) {
      return beginRollback(row, { failureType: "move_unpack_timeout", reason: "Unpacking your data took too long.", technical: "unpack timed out", fromPack: false, stopNew: true }, deps);
    }
    return row.step_attempts ? { step_attempts: 0 } : {};
  }
  if (status.state === "failed") {
    return beginRollback(row, { failureType: "move_unpack_failed", reason: "Your data did not check out on the new computer.", technical: status.message || status.step, fromPack: false, stopNew: true }, deps);
  }
  const result = status.result as { counts?: MoveCounts; gateway?: string } | undefined;
  if (!result?.counts || !row.counts_before || !moveCountsArrived(row.counts_before, result.counts, Boolean(row.managed_model))) {
    return beginRollback(row, { failureType: "move_counts_mismatch", reason: "Your data did not check out on the new computer.", technical: `counts differ: before ${JSON.stringify(row.counts_before)} after ${JSON.stringify(result?.counts ?? null)}`, fromPack: false, stopNew: true }, deps);
  }
  if (result.gateway !== "running") {
    return beginRollback(row, { failureType: "move_gateway_not_running", reason: "The new computer did not start your agent's connection service.", technical: `gateway ${String(result.gateway)}`, fromPack: false, stopNew: true }, deps);
  }
  return { state: "finishing", step: "finish", message: "Finishing the move.", counts_after: result.counts, step_started_at: iso(deps.now()), step_attempts: 0 };
}

// ---------------------------------------------------------------- finish

async function stepFinish(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const instance = await oldInstance(row, deps);
  const agent = await newAgent(row, deps);
  const now = deps.now();
  const at = iso(now);
  // 1. The old row: kept a week, hidden from lists, and marked so no payment restores it.
  if (!movedToOf(instance)) {
    await deps.store.patchInstance(instance.id, {
      status: "scheduled_for_deletion",
      scheduled_deletion_at: iso(new Date(now.getTime() + OLD_KEPT_MS)),
      config: { ...(instance.config ?? {}), movedTo: { agentId: agent.id, moveId: row.id, at } },
      updated_at: at,
    });
  }
  // 2. The old VM goes off (its disk stays). Its containers are already stopped, so a miss is not fatal.
  const off = await deps.shutdownOldVm(instance).catch((e) => ({ ok: false, stdout: "", stderr: String(e), error: String(e) }));
  if (!off.ok) log.warn("hermes move could not shut the old computer down", { source: "hermes-move", moveId: row.id, errorMessage: (off.error || off.stderr).slice(0, 200) });
  // 3. The Bankr wallet follows the agent.
  await deps.store.relinkWalletToAgent(instance.id, agent.id);
  // 4. The encrypted parts are no longer needed.
  await deps.storage.remove((row.parts ?? []).map((p) => `${row.id}/${p.name}`)).catch((e) => log.warn("hermes move could not delete its parts", { source: "hermes-move", moveId: row.id, errorMessage: String(e).slice(0, 200) }));
  return {
    state: "done",
    step: "done",
    message: "Your agent has moved to the official Hermes.",
    finished_at: at,
    undo_until: iso(new Date(now.getTime() + UNDO_WINDOW_MS)),
    step_attempts: 0,
    error: null,
  };
}

// ---------------------------------------------------------------- rollback and undo

interface RollbackPlan { failureType: string; reason: string; technical: string; fromPack: boolean; stopNew: boolean }

/** Enter the put-the-old-agent-back path. fromPack: the pack job already restarted the old containers. */
async function beginRollback(row: MoveRow, plan: RollbackPlan, deps: MoveDeps): Promise<MovePatch> {
  const failure = { failureType: plan.failureType, reason: plan.reason, technical: plan.technical.slice(0, 500) };
  log.warn("hermes move is rolling back", { source: "hermes-move", moveId: row.id, failureType: plan.failureType, errorMessage: plan.technical.slice(0, 300) });
  const base: MovePatch = { failure, error: failure.technical, step_attempts: 0, step_started_at: iso(deps.now()), message: `${plan.reason} Putting your agent back as it was.` };
  if (plan.fromPack || !row.prev_instance_status) {
    return { ...base, step: "rollback-cleanup" };
  }
  if (plan.stopNew && row.agent_id) return { ...base, step: "rollback-stop-new" };
  return { ...base, step: "rollback-restart-old" };
}

async function needsAttention(row: MoveRow, failureType: string, reason: string, technical: string, deps: MoveDeps): Promise<MovePatch> {
  const owner = row.step.startsWith("undo-")
    ? "We could not start your agent on its old computer again. Our team has been alerted."
    : "We could not start your agent again after the move did not complete. Our team has been alerted.";
  log.error("hermes move needs attention", new Error(failureType), { source: "hermes-move", moveId: row.id, failureType, step: row.step, errorMessage: technical.slice(0, 300) });
  await deps.alert({
    title: "A Hermes move needs attention",
    message: `Move ${row.id} stopped at ${row.state}/${row.step}: ${technical.slice(0, 300)}`,
    moveId: row.id,
    userId: row.user_id,
    instanceId: row.instance_id,
    failureType,
  }).catch(() => undefined);
  return {
    state: "needs_attention",
    step: row.step,
    message: owner,
    error: technical.slice(0, 500),
    failure: { failureType, reason, technical: technical.slice(0, 500) },
    finished_at: iso(deps.now()),
  };
}

/** Undo: the owner's request. Moves a done move to undoing; the steps run in advanceMove. */
export async function undoMove(input: { userId: string; agentId: string }, deps: MoveDeps): Promise<MoveRow> {
  const move = await deps.store.moveForAgent(input.agentId);
  if (!move || move.user_id !== input.userId) throw new MoveRequestError("Move not found.", 404, "not_found");
  if (move.state !== "done") throw new MoveRequestError("This move cannot be undone.", 409, "not_undoable");
  if (!move.undo_until || Date.parse(move.undo_until) <= deps.now().getTime()) {
    throw new MoveRequestError("The undo period for this move has ended.", 409, "undo_expired");
  }
  const started = await deps.store.transitionMove(move.id, "done", {
    state: "undoing",
    step: "undo-stop-new",
    message: "Undoing the move. Putting your agent back on its old computer.",
    step_attempts: 0,
    step_started_at: iso(deps.now()),
    finished_at: null,
    lease_until: null,
    updated_at: iso(deps.now()),
  });
  if (!started) throw new MoveRequestError("This move cannot be undone.", 409, "not_undoable");
  return started;
}

/**
 * The shared restore walk. Rollback steps run in the move's own state; undo
 * steps run in `undoing`. Both: stop the new gateway (so two computers never
 * hold the same chat channels), start the old containers, put the old row
 * back, remove the new computer.
 */
async function runRestoreStep(row: MoveRow, deps: MoveDeps): Promise<MovePatch> {
  const undo = row.step.startsWith("undo-");
  const prefix = undo ? "undo" : "rollback";
  const suffix = row.step.slice(prefix.length + 1);
  const instance = await oldInstance(row, deps);
  const fail = (technical: string, failureType: string) =>
    needsAttention(row, failureType, undo ? "The old computer could not be started." : "The old agent could not be started again.", technical, deps);

  switch (suffix) {
    case "stop-new": {
      // Best effort: a new computer that is gone or off holds no channels.
      if (row.agent_id) {
        const agent = await deps.store.getAgent(row.agent_id);
        if (agent) {
          const res = await deps.runNewGuest(row.user_id, agent, buildStopNewGatewayGuestScript(row.id), 60_000).catch((e) => ({ ok: false, stdout: "", stderr: String(e) }));
          if (res.ok) return { step: `${prefix}-stop-new-running`, step_attempts: 0, step_started_at: iso(deps.now()) };
          log.warn("hermes move could not stop the new gateway", { source: "hermes-move", moveId: row.id, errorMessage: (res.stderr || "").slice(0, 200) });
        }
      }
      return afterStopNew(row, prefix, deps);
    }
    case "stop-new-running": {
      const agent = row.agent_id ? await deps.store.getAgent(row.agent_id) : null;
      const status = agent ? await readJob(deps, { kind: "new", userId: row.user_id, agent, moveId: row.id, job: "stop-new-gateway" }) : null;
      if (status?.state === "running" && row.step_attempts < 5) return { step_attempts: row.step_attempts + 1 };
      if (!status && row.step_attempts < 3) return { step_attempts: row.step_attempts + 1 };
      return afterStopNew(row, prefix, deps);
    }
    case "start-vm": {
      const res = await deps.startOldVm(instance);
      if (!res.ok) {
        if (row.step_attempts + 1 >= 5) return fail((res.error || res.stderr || "start failed").slice(0, 300), "move_old_vm_not_started");
        return { step_attempts: row.step_attempts + 1 };
      }
      return { step: "undo-restart-old", step_attempts: 0, step_started_at: iso(deps.now()) };
    }
    case "restart-old": {
      const res = await deps.sshOld(instance, buildRestartOldCommand({ moveId: row.id, instanceId: instance.id }), 60_000);
      if (!startedOk(res)) {
        // A VM that was just started needs time before it answers ssh.
        if (row.step_attempts + 1 >= (undo ? 20 : 5)) return fail((res.error || res.stderr || "restart did not start").slice(0, 300), "move_restart_old_not_started");
        return { step_attempts: row.step_attempts + 1 };
      }
      return { step: `${prefix}-restart-old-running`, step_attempts: 0, step_started_at: iso(deps.now()) };
    }
    case "restart-old-running": {
      const status = await readJob(deps, { kind: "old", instance, moveId: row.id, job: "restart-old" });
      if (!status || status.state === "running") {
        if (elapsedMs(row, deps) > RESTART_WAIT_MS || row.step_attempts + 1 >= MAX_STATUS_READ_FAILURES * 3) return fail("restart status stayed unavailable or running", "move_restart_old_timeout");
        return status ? {} : { step_attempts: row.step_attempts + 1 };
      }
      if (status.state === "failed") return fail(status.message || status.step || "restart failed", "move_restart_old_failed");
      return { step: `${prefix}-cleanup`, step_attempts: 0, step_started_at: iso(deps.now()) };
    }
    case "cleanup":
      return undo ? finishUndo(row, instance, deps) : finishRollback(row, instance, deps);
    default:
      throw new Error(`no restore step ${row.step}`);
  }
}

function afterStopNew(row: MoveRow, prefix: string, deps: MoveDeps): MovePatch {
  return { step: prefix === "undo" ? "undo-start-vm" : "rollback-restart-old", step_attempts: 0, step_started_at: iso(deps.now()) };
}

async function removeParts(row: MoveRow, deps: MoveDeps): Promise<void> {
  await deps.storage.remove((row.parts ?? []).map((p) => `${row.id}/${p.name}`)).catch(() => undefined);
}

async function deleteNew(row: MoveRow, deps: MoveDeps): Promise<{ ok: boolean; message?: string }> {
  if (!row.agent_id) return { ok: true };
  const agent = await deps.store.getAgent(row.agent_id);
  if (!agent || agent.status === "deleted") return { ok: true };
  try {
    return await deps.deleteNewComputer(row.user_id, agent);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function finishRollback(row: MoveRow, instance: InstanceRow, deps: MoveDeps): Promise<MovePatch> {
  // The old row first: the owner's agent matters more than the cleanup.
  if (row.prev_instance_status) {
    await deps.store.patchInstance(instance.id, buildInstanceLifecyclePatch(row.prev_instance_status, { now: deps.now() }));
  }
  const removed = await deleteNew(row, deps);
  if (!removed.ok && row.step_attempts + 1 < 3) return { step_attempts: row.step_attempts + 1 };
  if (!removed.ok) {
    await deps.alert({
      title: "A Hermes move left a computer behind",
      message: `Move ${row.id} was rolled back but its new computer could not be removed: ${(removed.message ?? "").slice(0, 200)}`,
      moveId: row.id, userId: row.user_id, instanceId: row.instance_id, failureType: "move_new_computer_not_removed",
    }).catch(() => undefined);
  }
  await removeParts(row, deps);
  const reason = row.failure?.reason ?? "The move did not complete.";
  return {
    state: "failed",
    step: "failed",
    message: plainFailure(reason),
    finished_at: iso(deps.now()),
    step_attempts: 0,
  };
}

async function finishUndo(row: MoveRow, instance: InstanceRow, deps: MoveDeps): Promise<MovePatch> {
  const { movedTo: _movedTo, ...config } = (instance.config ?? {}) as Record<string, unknown>;
  void _movedTo;
  await deps.store.patchInstance(instance.id, {
    ...buildInstanceLifecyclePatch("running", { now: deps.now() }),
    scheduled_deletion_at: null,
    config,
  });
  // The wallet goes back before the new computer is deleted: deleting it must find none of the wallet.
  if (row.agent_id) await deps.store.relinkWalletToInstance(row.agent_id, instance.id);
  const removed = await deleteNew(row, deps);
  if (!removed.ok && row.step_attempts + 1 < 3) return { step_attempts: row.step_attempts + 1 };
  if (!removed.ok) {
    await deps.alert({
      title: "An undone Hermes move left a computer behind",
      message: `Move ${row.id} was undone but its new computer could not be removed: ${(removed.message ?? "").slice(0, 200)}`,
      moveId: row.id, userId: row.user_id, instanceId: row.instance_id, failureType: "move_new_computer_not_removed",
    }).catch(() => undefined);
  }
  return {
    state: "undone",
    step: "undone",
    message: "The move was undone. Your agent is back on its old computer.",
    finished_at: iso(deps.now()),
    step_attempts: 0,
  };
}

// ---------------------------------------------------------------- cron sweep

export interface MoveSweepResult { advanced: number; started: number; active: number; queued: number }

/**
 * The cron: advance the moves in flight and start queued ones while fewer than
 * `concurrency` are in flight.
 */
export async function sweepMoves(concurrency: number, deps: MoveDeps): Promise<MoveSweepResult> {
  const limit = Math.max(1, Math.floor(concurrency));
  const all = await deps.store.listActiveMoves();
  const running = all.filter((m) => m.state !== "queued").sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  const queued = all.filter((m) => m.state === "queued").sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const toAdvance = running.slice(0, limit);
  const slots = Math.max(0, limit - running.length);
  const toStart = queued.slice(0, slots);
  await Promise.all([...toAdvance, ...toStart].map((m) => advanceMove(m.id, deps).catch((err) => {
    log.error("hermes move advance threw", err, { source: "hermes-move", moveId: m.id });
    return null;
  })));
  return { advanced: toAdvance.length, started: toStart.length, active: running.length, queued: queued.length };
}
