import type { MoveCounts } from "../guest-jobs";
import {
  advanceMove,
  moveOffer,
  redactSetupLog,
  startMove,
  sweepMoves,
  toMoveView,
  undoMove,
  type AgentRow,
  type CommandResult,
  type InstanceRow,
  type MoveDeps,
  type MovePatch,
  type MoveRow,
  type MoveStore,
} from "../orchestrator";

jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../guest-jobs", () => ({
  buildPackCommand: (p: { keyHex: string }) => `old:start:pack:${p.keyHex.length}`,
  buildUploadCommand: (p: { uploads: unknown[] }) => `old:start:upload:${p.uploads.length}`,
  buildRestartOldCommand: () => "old:start:restart-old",
  buildReadOldStatusCommand: (_id: string, job: string) => `old:read:${job}`,
  buildUnpackGuestScript: () => "new:start:unpack",
  buildStopNewGatewayGuestScript: () => "new:start:stop-new-gateway",
  buildReadNewStatusGuestScript: (_id: string, job: string) => `new:read:${job}`,
  parseMoveJobStatus: (out: string | null | undefined) => (out ? JSON.parse(out) : null),
  MOVE_STATUS_DIR: (id: string) => `/var/lib/hivra-move/${id}`,
}));

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const COUNTS: MoveCounts = { sessions: 3, messages: 40, skills: 2, cronJobs: 1, profiles: 1, envKeys: ["A", "B"] };
const PARTS = [{ name: "part-000", bytes: 10, sha256: "a".repeat(64) }];
const USER = "user_1";

function status(state: "running" | "done" | "failed", result?: Record<string, unknown>, message = "") {
  return JSON.stringify({ state, step: "x", message, updatedAt: "now", ...(result ? { result } : {}) });
}

function makeWorld(opts: { instance?: Partial<InstanceRow> } = {}) {
  const w = {
    clock: T0,
    moves: new Map<string, MoveRow>(),
    instance: {
      id: "inst-1", user_id: USER, name: "Ada", status: "running", backend: "gateway", cpu_limit: 1, ram_limit: 2048,
      deleted_at: null, config: { infrastructure: { provider: "proxmox", vmid: 120 }, model: "venice-model-x" },
      ...opts.instance,
    } as InstanceRow,
    agents: new Map<string, AgentRow>(),
    instancePatches: [] as Record<string, unknown>[],
    wallet: "instance" as "instance" | "agent",
    calls: [] as string[],
    deleted: [] as string[],
    removed: [] as string[],
    alerts: [] as string[],
    launchBodies: [] as Record<string, unknown>[],
    launchOptions: [] as unknown[],
    launchResponse: () => new Response(JSON.stringify({ success: true, data: { agent: { id: "agent-1" } } }), { status: 201 }),
    observe: ((a: AgentRow) => ({ ...a, status: "running" })) as (a: AgentRow) => AgentRow,
    oldJobs: {} as Record<string, string | null>,
    newJobs: {} as Record<string, string | null>,
    oldStartOk: {} as Record<string, boolean>,
    newStartOk: true,
    deleteOk: true,
    setupLog: null as string | null,
    nextId: 1,
  };
  const store: MoveStore = {
    async insertMove(row) {
      for (const m of w.moves.values()) {
        if (m.instance_id === row.instance_id && ["queued", "launching", "packing", "uploading", "unpacking", "finishing", "undoing"].includes(m.state)) {
          throw Object.assign(new Error("dup"), { code: "23505" });
        }
      }
      const id = `move-${w.nextId++}`;
      const full: MoveRow = {
        id, agent_id: null, state: "queued", step: "queued", message: "", parts: null, counts_before: null, counts_after: null,
        managed_model: null, error: null, failure: null, lease_until: null, prev_instance_status: null, step_attempts: 0,
        step_started_at: null, started_at: new Date(w.clock).toISOString(), updated_at: new Date(w.clock).toISOString(),
        finished_at: null, undo_until: null, ...row,
      };
      w.moves.set(id, full);
      return { ...full };
    },
    async getMove(id) { const m = w.moves.get(id); return m ? { ...m } : null; },
    async claimLease(id, leaseUntil, nowIso) {
      const m = w.moves.get(id);
      if (!m || (m.lease_until && m.lease_until > nowIso)) return null;
      m.lease_until = leaseUntil;
      return { ...m };
    },
    async patchMove(id, patch: MovePatch) { Object.assign(w.moves.get(id)!, patch); },
    async transitionMove(id, from, patch) {
      const m = w.moves.get(id);
      if (!m || m.state !== from) return null;
      Object.assign(m, patch);
      return { ...m };
    },
    async activeMoveForInstance(instanceId) {
      return [...w.moves.values()].find((m) => m.instance_id === instanceId && !["done", "failed", "needs_attention", "undone"].includes(m.state)) ?? null;
    },
    async latestMoveForInstance(instanceId) { return [...w.moves.values()].filter((m) => m.instance_id === instanceId).pop() ?? null; },
    async moveForAgent(agentId) { return [...w.moves.values()].filter((m) => m.agent_id === agentId).pop() ?? null; },
    async listActiveMoves() { return [...w.moves.values()].filter((m) => !["done", "failed", "needs_attention", "undone"].includes(m.state)); },
    async listMoves() { return [...w.moves.values()]; },
    async getInstance(id) { return id === w.instance.id ? { ...w.instance } : null; },
    async patchInstance(_id, patch) {
      w.instancePatches.push(patch);
      Object.assign(w.instance, patch);
      if (patch.config) w.instance.config = patch.config as Record<string, unknown>;
    },
    async getAgent(id) { const a = w.agents.get(id); return a ? { ...a } : null; },
    async findLaunchedAgent() { return null; },
    async relinkWalletToAgent() { w.wallet = "agent"; w.calls.push("wallet->agent"); },
    async relinkWalletToInstance() { w.wallet = "instance"; w.calls.push("wallet->instance"); },
  };
  const ok = (stdout = "started"): CommandResult => ({ ok: true, stdout, stderr: "" });
  const deps: MoveDeps = {
    store,
    now: () => new Date(w.clock),
    randomKeyHex: () => "k".repeat(64),
    encrypt: (s) => `enc(${s})`,
    decrypt: (s) => s.replace(/^enc\(|\)$/g, ""),
    isEnabled: () => true,
    async launch(_u, body, options) {
      w.calls.push("launch");
      w.launchBodies.push(body);
      w.launchOptions.push(options);
      const res = w.launchResponse();
      if (res.ok) w.agents.set("agent-1", { id: "agent-1", user_id: USER, status: "provisioning", ip: "10.240.0.5", vmid: 200 });
      return res;
    },
    async observeLaunch(_u, agent) {
      const next = w.observe(agent);
      w.agents.set(agent.id, next);
      return next;
    },
    async sshOld(_i, command) {
      w.calls.push(command);
      if (command.startsWith("old:start:")) {
        const job = command.split(":")[2];
        return w.oldStartOk[job] === false ? { ok: false, stdout: "", stderr: "boom" } : ok();
      }
      const job = command.split(":")[2];
      const out = w.oldJobs[job];
      return out === null || out === undefined ? { ok: false, stdout: "", stderr: "no status" } : ok(out);
    },
    async runNewGuest(_u, _a, script) {
      w.calls.push(script);
      if (script.startsWith("new:start:")) return w.newStartOk ? ok() : { ok: false, stdout: "", stderr: "boom" };
      const job = script.split(":")[2];
      const out = w.newJobs[job];
      return out === null || out === undefined ? { ok: false, stdout: "", stderr: "no status" } : ok(out);
    },
    async shutdownOldVm() { w.calls.push("shutdown-old-vm"); return ok(""); },
    async startOldVm() { w.calls.push("start-old-vm"); return ok(""); },
    async readNewSetupLog(_u, agent) {
      w.calls.push(`read-setup-log:${agent.id}`);
      return w.setupLog;
    },
    async deleteNewComputer(_u, agent) {
      w.calls.push("delete-new");
      if (!w.deleteOk) return { ok: false, message: "cannot" };
      w.deleted.push(agent.id);
      w.agents.set(agent.id, { ...agent, status: "deleted" });
      return { ok: true };
    },
    storage: {
      uploadUrl: async (p) => `https://up/${p}`,
      downloadUrl: async (p) => `https://down/${p}`,
      remove: async (paths) => { w.removed.push(...paths); },
    },
    alert: async (e) => { w.alerts.push(e.failureType); },
  };
  return { w, deps };
}

async function begin(deps: MoveDeps) {
  return startMove({ userId: USER, instanceId: "inst-1", initiatedBy: "owner" }, deps);
}

/** Drive the machine through launch to the pack start. */
async function toPacking(deps: MoveDeps, id: string) {
  await advanceMove(id, deps); // launch
  return advanceMove(id, deps); // computer ready -> pack started
}

describe("moveOffer", () => {
  const base = { status: "running", backend: "gateway", deleted_at: null, config: { infrastructure: { provider: "proxmox", vmid: 1 } } };
  it("is available for a running old Hermes agent when the lane is on", () => {
    expect(moveOffer(base, null, true)).toEqual({ available: true, reason: "available" });
  });
  it.each([
    ["lane off", { ...base }, null, false, "not_enabled"],
    ["stopped", { ...base, status: "stopped" }, null, true, "not_running"],
    ["not a Hermes box", { ...base, backend: "aeon" }, null, true, "not_hermes"],
    ["already moved", { ...base, config: { ...base.config, movedTo: { agentId: "a" } } }, null, true, "already_moved"],
    ["scheduled for deletion", { ...base, status: "scheduled_for_deletion" }, null, true, "already_moved"],
    ["active move", { ...base }, { state: "packing" as const }, true, "move_in_progress"],
  ])("is not available: %s", (_n, row, active, enabled, reason) => {
    expect(moveOffer(row, active, enabled)).toEqual({ available: false, reason });
  });
  it("treats a finished move as no active move", () => {
    expect(moveOffer(base, { state: "failed" }, true).available).toBe(true);
  });
});

describe("startMove", () => {
  it("queues a move with an encrypted key, once per instance", async () => {
    const { w, deps } = makeWorld();
    const move = await begin(deps);
    expect(move).toMatchObject({ state: "queued", initiated_by: "owner", key_encrypted: `enc(${"k".repeat(64)})` });
    expect(JSON.stringify(toMoveView(move))).not.toContain("kkkk");
    await expect(begin(deps)).rejects.toMatchObject({ status: 409, code: "move_in_progress" });
    expect(w.moves.size).toBe(1);
  });
  it("refuses another owner's agent and an unavailable one", async () => {
    const { deps } = makeWorld();
    await expect(startMove({ userId: "other", instanceId: "inst-1", initiatedBy: "owner" }, deps)).rejects.toMatchObject({ status: 404 });
    const { deps: stopped } = makeWorld({ instance: { status: "stopped" } });
    await expect(begin(stopped)).rejects.toMatchObject({ status: 409, code: "not_running" });
  });
});

describe("happy path", () => {
  it("walks every step to done and switches over", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);

    // 1. launch, with the old size and model and without the old row counting
    let m = (await advanceMove(id, deps))!;
    expect(m).toMatchObject({ state: "launching", step: "starting", agent_id: "agent-1" });
    expect(w.launchBodies[0]).toMatchObject({
      type: "hermes", name: "Ada", cpu: 1, ram: 2, deployment: { mode: "hivra-managed" },
      llm: { provider: "venice", mode: "managed", model: "venice-model-x" },
    });
    expect(w.launchOptions[0]).toEqual({ moveFromInstanceId: "inst-1" });
    expect(w.instance.status).toBe("running");

    // 2. computer ready -> old row stopped, pack started
    m = (await advanceMove(id, deps))!;
    expect(m).toMatchObject({ state: "packing", step: "pack-running", prev_instance_status: "running" });
    expect(w.instance.status).toBe("stopped");
    expect(w.calls).toContain("old:start:pack:64");

    // pack still running: nothing changes
    w.oldJobs.pack = status("running");
    m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("packing");

    // 3. pack done -> upload started with one URL per part
    w.oldJobs.pack = status("done", { parts: PARTS, counts: COUNTS, managedModel: true, totalBytes: 10 });
    m = (await advanceMove(id, deps))!;
    expect(m).toMatchObject({ state: "uploading", step: "upload-running", managed_model: true, counts_before: COUNTS, parts: PARTS });
    expect(w.calls).toContain("old:start:upload:1");

    // 4. upload done -> unpack started on the new computer
    w.oldJobs.upload = status("done", { uploaded: 1 });
    m = (await advanceMove(id, deps))!;
    expect(m).toMatchObject({ state: "unpacking", step: "unpack-running" });
    expect(w.calls).toContain("new:start:unpack");

    // 5. unpack done with matching counts -> finishing
    w.newJobs.unpack = status("done", { counts: COUNTS, gateway: "running" });
    m = (await advanceMove(id, deps))!;
    expect(m).toMatchObject({ state: "finishing", counts_after: COUNTS });

    // 6. switch-over
    m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("done");
    expect(Date.parse(m.undo_until!) - w.clock).toBe(7 * 86_400_000);
    expect(w.instance.status).toBe("scheduled_for_deletion");
    expect(w.instance.scheduled_deletion_at).toBe(new Date(w.clock + 7 * 86_400_000).toISOString());
    expect(w.instance.config).toMatchObject({ movedTo: { agentId: "agent-1", moveId: id }, model: "venice-model-x" });
    expect(w.calls).toContain("shutdown-old-vm");
    expect(w.wallet).toBe("agent");
    expect(w.removed).toEqual([`${id}/part-000`]);
    expect(m.lease_until).toBeNull();
  });

  it("gives a move queued without a key (an operator's table insert) its key before launching", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    w.moves.set(id, { ...w.moves.get(id)!, key_encrypted: null, initiated_by: "operator" });
    let m = (await advanceMove(id, deps))!;
    expect(m).toMatchObject({ state: "launching", step: "starting" });
    expect(w.moves.get(id)!.key_encrypted).toBe(`enc(${"k".repeat(64)})`);
    m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("packing");
    expect(w.calls).toContain("old:start:pack:64");
  });

  it("uses the default model and the Hermes floor for a small old agent without a valid model", async () => {
    const { w, deps } = makeWorld({ instance: { cpu_limit: 0.5, ram_limit: 1024, config: { infrastructure: { provider: "proxmox", vmid: 1 }, model: "not a model!" } } });
    const { id } = await begin(deps);
    await advanceMove(id, deps);
    expect(w.launchBodies[0]).toMatchObject({ cpu: 1, ram: 2, llm: { model: "deepseek-v4-1-flash" } });
  });

  it("keeps waiting while the new computer provisions", async () => {
    const { w, deps } = makeWorld();
    w.observe = (a) => a;
    const { id } = await begin(deps);
    await advanceMove(id, deps);
    const m = (await advanceMove(id, deps))!;
    expect(m).toMatchObject({ state: "launching", step: "starting" });
    expect(w.instance.status).toBe("running");
  });
});

describe("lease and idempotency", () => {
  it("does nothing when another call holds the lease", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    w.moves.get(id)!.lease_until = new Date(w.clock + 60_000).toISOString();
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("queued");
    expect(w.calls).not.toContain("launch");
  });
  it("takes an expired lease and releases it after the step", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    w.moves.get(id)!.lease_until = new Date(w.clock - 1).toISOString();
    await advanceMove(id, deps);
    expect(w.calls.filter((c) => c === "launch")).toHaveLength(1);
    expect(w.moves.get(id)!.lease_until).toBeNull();
  });
  it("two concurrent advances run the step once", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await Promise.all([advanceMove(id, deps), advanceMove(id, deps)]);
    expect(w.calls.filter((c) => c === "launch")).toHaveLength(1);
  });
  it("leaves finished moves alone", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    w.moves.get(id)!.state = "failed";
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(w.calls).toHaveLength(0);
  });
  it("retries a throwing step and escalates after the attempts run out", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await advanceMove(id, deps);
    w.observe = () => { throw new Error("never"); };
    w.agents.get("agent-1")!.status = "provisioning";
    // observeLaunch failures are tolerated; a missing agent record throws
    w.agents.delete("agent-1");
    for (let i = 0; i < 7; i++) await advanceMove(id, deps);
    expect(w.moves.get(id)).toMatchObject({ state: "launching", step_attempts: 7 });
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.step).toBe("rollback-cleanup");
  });
});

describe("failure paths", () => {
  it("launch refused: failed, nothing to clean up, old agent untouched", async () => {
    const { w, deps } = makeWorld();
    w.launchResponse = () => new Response(JSON.stringify({ success: false, error: "No free slot" }), { status: 409 });
    const { id } = await begin(deps);
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(m.message).toContain("Nothing was changed");
    expect(m.failure?.failureType).toBe("move_launch_failed");
    expect(w.instance.status).toBe("running");
    expect(w.deleted).toEqual([]);
  });

  it("new computer errors while setting up: new computer removed, failed", async () => {
    const { w, deps } = makeWorld();
    w.observe = (a) => ({ ...a, status: "error", error: "no capacity" });
    const { id } = await begin(deps);
    await advanceMove(id, deps);
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(w.deleted).toEqual(["agent-1"]);
    expect(w.instance.status).toBe("running");
  });

  it("keeps the new computer's setup log on the failed move, read before the computer is removed", async () => {
    const { w, deps } = makeWorld();
    w.observe = (a) => ({ ...a, status: "error", error: "provisioning failed" });
    w.setupLog = "==> 5e/7 Hermes Agent\n ! the Hermes installer failed\n";
    const { id } = await begin(deps);
    await advanceMove(id, deps);
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(m.failure?.setupLog).toBe("==> 5e/7 Hermes Agent\n ! the Hermes installer failed");
    expect(w.calls.indexOf("read-setup-log:agent-1")).toBeLessThan(w.calls.indexOf("delete-new"));
  });

  it("still removes the new computer when its setup log cannot be read", async () => {
    const { w, deps } = makeWorld();
    w.observe = (a) => ({ ...a, status: "error", error: "provisioning failed" });
    deps.readNewSetupLog = async () => { throw new Error("host unreachable"); };
    const { id } = await begin(deps);
    await advanceMove(id, deps);
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(m.failure?.setupLog).toBeUndefined();
    expect(w.deleted).toEqual(["agent-1"]);
  });

  it("pack failed: it restarted the old containers itself, so restore the row, delete the new computer, failed", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = status("failed", undefined, "disk full");
    let m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-cleanup");
    m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(m.message).toBe("Your data could not be packed. Your agent was started again as it was, and nothing was lost.");
    expect(m.error).toBe("disk full");
    expect(w.calls).not.toContain("old:start:restart-old");
    expect(w.instance.status).toBe("running");
    expect(w.deleted).toEqual(["agent-1"]);
  });

  it("pack could not be started: row restored, new computer removed", async () => {
    const { w, deps } = makeWorld();
    w.oldStartOk.pack = false;
    const { id } = await begin(deps);
    await advanceMove(id, deps);
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(w.instance.status).toBe("running");
    expect(w.deleted).toEqual(["agent-1"]);
  });

  it("upload failed: restart-old job, restore row, delete new computer, failed", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = status("done", { parts: PARTS, counts: COUNTS, managedModel: false, totalBytes: 10 });
    await advanceMove(id, deps);
    w.oldJobs.upload = status("failed", undefined, "network");
    let m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-restart-old");
    m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-restart-old-running");
    expect(w.calls).toContain("old:start:restart-old");
    w.oldJobs["restart-old"] = status("running");
    m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-restart-old-running");
    w.oldJobs["restart-old"] = status("done");
    m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-cleanup");
    m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("failed");
    expect(w.instance.status).toBe("running");
    expect(w.deleted).toEqual(["agent-1"]);
    expect(w.removed).toEqual([`${id}/part-000`]);
  });

  it("unpack counts differ: stops the new gateway first, then restores", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = status("done", { parts: PARTS, counts: COUNTS, managedModel: false, totalBytes: 10 });
    await advanceMove(id, deps);
    w.oldJobs.upload = status("done", {});
    await advanceMove(id, deps);
    w.newJobs.unpack = status("done", { counts: { ...COUNTS, messages: 39 }, gateway: "running" });
    let m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-stop-new");
    expect(m.failure?.failureType).toBe("move_counts_mismatch");
    m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-stop-new-running");
    w.newJobs["stop-new-gateway"] = status("done");
    m = (await advanceMove(id, deps))!;
    expect(m.step).toBe("rollback-restart-old");
    w.oldJobs["restart-old"] = status("done");
    await advanceMove(id, deps);
    await advanceMove(id, deps);
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.state).toBe("failed");
    const order = w.calls.filter((c) => ["new:start:stop-new-gateway", "old:start:restart-old", "delete-new"].includes(c));
    expect(order).toEqual(["new:start:stop-new-gateway", "old:start:restart-old", "delete-new"]);
    expect(w.instance.status).toBe("running");
  });

  it("unpack with the gateway stopped is a failure", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = status("done", { parts: PARTS, counts: COUNTS, managedModel: false, totalBytes: 10 });
    await advanceMove(id, deps);
    w.oldJobs.upload = status("done", {});
    await advanceMove(id, deps);
    w.newJobs.unpack = status("done", { counts: COUNTS, gateway: "stopped" });
    const m = (await advanceMove(id, deps))!;
    expect(m.failure?.failureType).toBe("move_gateway_not_running");
  });

  it("restart-old failed: needs attention with a failureType, an alert, and no new-computer deletion", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = status("done", { parts: PARTS, counts: COUNTS, managedModel: false, totalBytes: 10 });
    await advanceMove(id, deps);
    w.oldJobs.upload = status("failed", undefined, "x");
    await advanceMove(id, deps);
    await advanceMove(id, deps);
    w.oldJobs["restart-old"] = status("failed", undefined, "docker down");
    const m = (await advanceMove(id, deps))!;
    expect(m.state).toBe("needs_attention");
    expect(m.failure?.failureType).toBe("move_restart_old_failed");
    expect(m.message).toContain("Our team has been alerted");
    expect(w.alerts).toEqual(["move_restart_old_failed"]);
    expect(w.deleted).toEqual([]);
  });

  it("an unreadable pack status for too long rolls back through restart-old", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = null;
    for (let i = 0; i < 10; i++) await advanceMove(id, deps);
    expect(w.moves.get(id)!.step).toBe("rollback-restart-old");
  });

  it("a new computer that cannot be removed still ends the move, with an alert", async () => {
    const { w, deps } = makeWorld();
    w.deleteOk = false;
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = status("failed", undefined, "x");
    for (let i = 0; i < 5; i++) await advanceMove(id, deps);
    expect(w.moves.get(id)!.state).toBe("failed");
    expect(w.alerts).toContain("move_new_computer_not_removed");
    expect(w.instance.status).toBe("running");
  });
});

describe("undo", () => {
  async function moved() {
    const world = makeWorld();
    const { w, deps } = world;
    const { id } = await begin(deps);
    await toPacking(deps, id);
    w.oldJobs.pack = status("done", { parts: PARTS, counts: COUNTS, managedModel: false, totalBytes: 10 });
    await advanceMove(id, deps);
    w.oldJobs.upload = status("done", {});
    await advanceMove(id, deps);
    w.newJobs.unpack = status("done", { counts: COUNTS, gateway: "running" });
    await advanceMove(id, deps);
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.state).toBe("done");
    return { ...world, id };
  }

  it("walks stop-new, start VM, restart-old, restore, delete and ends undone", async () => {
    const { w, deps, id } = await moved();
    w.calls.length = 0;
    w.clock += 86_400_000;
    const started = await undoMove({ userId: USER, agentId: "agent-1" }, deps);
    expect(started.state).toBe("undoing");
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.step).toBe("undo-stop-new-running");
    w.newJobs["stop-new-gateway"] = status("done");
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.step).toBe("undo-start-vm");
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.step).toBe("undo-restart-old");
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.step).toBe("undo-restart-old-running");
    w.oldJobs["restart-old"] = status("done");
    await advanceMove(id, deps);
    await advanceMove(id, deps);
    const m = w.moves.get(id)!;
    expect(m.state).toBe("undone");
    expect(w.instance.status).toBe("running");
    expect(w.instance.scheduled_deletion_at).toBeNull();
    expect((w.instance.config as Record<string, unknown>).movedTo).toBeUndefined();
    expect(w.wallet).toBe("instance");
    expect(w.deleted).toEqual(["agent-1"]);
    const order = w.calls.filter((c) => ["new:start:stop-new-gateway", "start-old-vm", "old:start:restart-old", "wallet->instance", "delete-new"].includes(c));
    expect(order).toEqual(["new:start:stop-new-gateway", "start-old-vm", "old:start:restart-old", "wallet->instance", "delete-new"]);
    // a new move is possible again
    await expect(begin(deps)).resolves.toBeDefined();
  });

  it("keeps trying while the old VM boots, then asks for help", async () => {
    const { w, deps, id } = await moved();
    await undoMove({ userId: USER, agentId: "agent-1" }, deps);
    w.newJobs["stop-new-gateway"] = status("done");
    await advanceMove(id, deps);
    await advanceMove(id, deps);
    await advanceMove(id, deps);
    expect(w.moves.get(id)!.step).toBe("undo-restart-old");
    w.oldStartOk["restart-old"] = false;
    for (let i = 0; i < 20; i++) await advanceMove(id, deps);
    expect(w.moves.get(id)).toMatchObject({ state: "needs_attention" });
    expect(w.alerts).toContain("move_restart_old_not_started");
  });

  it("refuses a stranger, an unfinished move, an expired window and a second undo", async () => {
    const { w, deps } = await moved();
    await expect(undoMove({ userId: "other", agentId: "agent-1" }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(undoMove({ userId: USER, agentId: "nope" }, deps)).rejects.toMatchObject({ status: 404 });
    w.clock += 7 * 86_400_000 + 1;
    await expect(undoMove({ userId: USER, agentId: "agent-1" }, deps)).rejects.toMatchObject({ code: "undo_expired" });
    w.clock = T0;
    await undoMove({ userId: USER, agentId: "agent-1" }, deps);
    await expect(undoMove({ userId: USER, agentId: "agent-1" }, deps)).rejects.toMatchObject({ code: "not_undoable" });
  });
});

describe("sweepMoves", () => {
  it("advances moves in flight and starts queued ones only within the limit", async () => {
    const { w, deps } = makeWorld();
    const { id } = await begin(deps);
    const result = await sweepMoves(2, deps);
    expect(result).toMatchObject({ advanced: 0, started: 1, queued: 1 });
    expect(w.moves.get(id)!.state).toBe("launching");
    // one in flight, one slot left, nothing queued: it is advanced
    const again = await sweepMoves(2, deps);
    expect(again).toMatchObject({ advanced: 1, started: 0 });
    expect(w.moves.get(id)!.state).toBe("packing");
  });
  it("starts no queued move when the limit is used up", async () => {
    const { w, deps } = makeWorld();
    const first = await begin(deps);
    await advanceMove(first.id, deps);
    w.moves.set("extra", { ...w.moves.get(first.id)!, id: "extra", instance_id: "inst-2", state: "queued", step: "queued" });
    const result = await sweepMoves(1, deps);
    expect(result.started).toBe(0);
    expect(w.moves.get("extra")!.state).toBe("queued");
  });
});

describe("redactSetupLog", () => {
  it("drops colour codes and control characters and keeps the last part", () => {
    expect(redactSetupLog("\u001b[1m==>\u001b[0m step\r\n\u0007 ok done\n\n")).toBe("==> step\n ok done");
    const long = redactSetupLog(`${"step ok\n".repeat(1000)}last line`);
    expect(long.length).toBe(4000);
    expect(long.endsWith("last line")).toBe(true);
  });

  it("replaces anything that looks like a key or a token, and keeps paths", () => {
    const token = ["sk", "live", "0123456789abcdefghijklmnopqrstuv"].join("_");
    const out = redactSetupLog([
      `HIVRA_MODEL_KEY=${token} set`,
      `Authorization: Bearer ${token}`,
      `curl failed for ${token}`,
      "die: /home/bux/.hermes/hermes-agent/web/dist missing",
    ].join("\n"));
    expect(out).not.toContain(token);
    expect(out).toContain("HIVRA_MODEL_KEY=[redacted]");
    expect(out).toContain("/home/bux/.hermes/hermes-agent/web/dist missing");
  });
});
