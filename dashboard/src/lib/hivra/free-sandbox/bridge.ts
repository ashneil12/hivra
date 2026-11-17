/**
 * The free sandbox bridge: one pass (`tick`) between the agent app's operator API and Hivra's pool servers. It places
 * free workspaces that wait for a computer, wakes the ones something wants, stops and packs the ones nobody uses, and
 * erases a workspace's sandbox only when the workspace itself is deleted. Off unless `freeSandboxEnabled` and the free
 * settings are whole; every number comes from those settings.
 *
 * Passes must not overlap: the deployed store holds a lock for the length of one.
 *
 * What counts as use: only people. The storage clock is the workspace's newest `lastSeenAt` (written when a person's
 * app connects and disconnects). A computer the app calls `busy` (a run, a task, an open view in the last two minutes)
 * is never stopped under it, but being busy never moves the clock: a scheduled job can delay a stop, not a pack.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  AppProvisioningApi,
  IssuedMachine,
  MachineRequest,
  OperatorEvent,
  OperatorMember,
  PlanLimits,
} from "./operator-api";
import { freePlacementAdmission, freeWakeAdmission, openPlaces, refusedShare } from "./placement";
import type { SandboxTier } from "./plan";
import { decideFreeSandbox } from "./policy";
import type {
  AccountDirectory,
  ArchiveStore,
  BridgeStore,
  Placement,
  PoolServer,
  SandboxHost,
  SandboxSpec,
} from "./ports";
import type { FreeSandboxSettings } from "./settings";

/** The program a free agent thinks with: the agent app's own agent on OpenCode's free models. */
export const FREE_BRAIN = "opencode";
/** The tier the bridge reports capacity for. */
const CAPACITY_TIER = "free";
/** How long the app is told a packed sandbox takes to come back, for the words people read while it does. */
const RESTORE_ESTIMATE_MS = 60_000;
/** How long a new sandbox is expected to take, for the same. */
const CREATE_ESTIMATE_MS = 90_000;
/** A held enroll code is used only with at least this long left. */
const CODE_MARGIN_MS = 60_000;
/** Pages of the events feed read in one pass, so a long backlog never holds a pass for ever. */
const EVENT_PAGES_PER_TICK = 20;

export interface BridgeDeps {
  app: AppProvisioningApi;
  store: BridgeStore;
  host: SandboxHost;
  archives: ArchiveStore;
  accounts: AccountDirectory;
  /** Which ladder a Hivra account is on (`sandboxTierFor`). */
  tierOf: (hivraUserId: string) => Promise<SandboxTier>;
  settings: FreeSandboxSettings;
  /** The agent app's public https address, where a sandbox's runner connects. */
  appUrl: string;
  now?: () => Date;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

export interface TickSummary {
  placed: number;
  waitlisted: number;
  woken: number;
  queued: number;
  stopped: number;
  packed: number;
  erased: number;
  skippedPaid: number;
  failed: number;
  /** Free replies seen on the events feed this pass. */
  aiAnswered: number;
  aiRefused: number;
  aiFailed: number;
}

/** The plan limits a free workspace gets: every one from the free settings but the brain. */
export function freePlanLimits(settings: FreeSandboxSettings): PlanLimits {
  return {
    agents: settings.agents,
    brains: [FREE_BRAIN],
    routines: settings.scheduledJobs,
    routineMinutes: Math.max(15, Math.round(settings.scheduledJobMinHours * 60)),
    models: [...settings.freeModels],
  };
}

export const specOf = (s: FreeSandboxSettings): SandboxSpec => ({
  cpus: s.cpus,
  memoryMb: s.memoryMb,
  storageMb: s.storageMb,
  cpuOvercommit: s.cpuOvercommit,
});

/** The adapter's owner digest for a workspace: its id hashed, so the pool server never sees who it is. */
export const ownerHashOf = (orgId: string) => createHash("sha256").update(`free-sandbox:${orgId}`).digest("hex");

/** The newest time any person in the workspace had it open; blocked and leaving accounts don't count. */
export function personActivityAt(members: OperatorMember[]): Date | null {
  let newest: number | null = null;
  for (const m of members) {
    if (m.blockedAt || m.deletionDueAt || !m.lastSeenAt) continue;
    const at = Date.parse(m.lastSeenAt);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest === null ? null : new Date(newest);
}

const errorName = (err: unknown) => (err instanceof Error ? err.name : "unknown");
const statusOf = (err: unknown) => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
};

const FAILED_ANOTHER_WAY = new Set(["opencode_failed", "not_logged_in"]);

/**
 * When a refused server's free AI should answer again: the time OpenCode gave, else the next UTC midnight (its free
 * allowance is per UTC day: both refusals seen so far named that instant).
 */
export function refusedUntil(at: Date, resetsAt: unknown): Date {
  const given = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
  if (Number.isFinite(given) && given > at.getTime()) return new Date(given);
  const next = new Date(at.getTime());
  next.setUTCHours(24, 0, 0, 0);
  return next;
}
/** The UTC day of an ISO time. */
const dayOf = (at: string) => new Date(Number.isFinite(Date.parse(at)) ? at : Date.now()).toISOString().slice(0, 10);

const ON_SERVER = new Set(["placing", "awake", "stopped", "packing"]);
const AWAKE = new Set(["placing", "awake"]);

export class FreeSandboxBridge {
  private readonly now: () => Date;
  private readonly log: NonNullable<BridgeDeps["log"]>;
  /** Recent `opencode_failed` per server, for the burst rule; in memory, so a restart forgets at most one window. */
  private readonly recentFailures = new Map<string, { orgId: string; at: number }[]>();
  /** Enroll codes issued and not used yet, by workspace: in memory only, never stored or logged. */
  private readonly codes = new Map<string, IssuedMachine>();

  constructor(private readonly deps: BridgeDeps) {
    if (!/^https:\/\/[^/?#@\s]+$/.test(deps.appUrl)) throw new Error("The agent app address must be https");
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** One pass: the events feed (wakes, deletions), waiting wakes, waiting workspaces, idle sandboxes, capacity. */
  async tick(): Promise<TickSummary> {
    const sum: TickSummary = {
      placed: 0,
      waitlisted: 0,
      woken: 0,
      queued: 0,
      stopped: 0,
      packed: 0,
      erased: 0,
      skippedPaid: 0,
      failed: 0,
      aiAnswered: 0,
      aiRefused: 0,
      aiFailed: 0,
    };
    await this.readEvents(sum);
    await this.drainWakes(sum);
    await this.placeWaiting(sum);
    await this.sweep(sum);
    await this.reportCapacity();
    return sum;
  }

  // ---- counts -------------------------------------------------------------------------------------------------

  private async occupancy() {
    const [servers, placements] = await Promise.all([this.deps.store.servers(), this.deps.store.placements()]);
    const placed = new Map<string, number>();
    const awake = new Map<string, number>();
    for (const p of placements) {
      if (!p.serverId) continue;
      if (ON_SERVER.has(p.state)) placed.set(p.serverId, (placed.get(p.serverId) ?? 0) + 1);
      if (AWAKE.has(p.state)) awake.set(p.serverId, (awake.get(p.serverId) ?? 0) + 1);
    }
    return { servers, placed, awake };
  }

  /** The server with room for one more free person: the fullest that still admits, so servers fill one at a time. */
  private async serverForNewPlace(): Promise<PoolServer | null> {
    const { servers, placed, awake } = await this.occupancy();
    const today = dayOf(this.now().toISOString());
    const admitting: PoolServer[] = [];
    for (const server of servers) {
      if (await this.refusedNow(server.id)) continue;
      const freePlaced = placed.get(server.id) ?? 0;
      const ai = await this.deps.store.aiDay(server.id, today);
      const admit = freePlacementAdmission(
        { freePlaced, paidReserveIntact: server.paidReserveIntact, paidWaiting: server.paidWaiting },
        this.deps.settings,
        ai,
      ).admit;
      if (admit && freeWakeAdmission(awake.get(server.id) ?? 0, server.cpus, this.deps.settings).admit) {
        admitting.push(server);
      }
    }
    admitting.sort((a, b) => (placed.get(b.id) ?? 0) - (placed.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    return admitting[0] ?? null;
  }

  // ---- events -------------------------------------------------------------------------------------------------

  private async readEvents(sum: TickSummary) {
    let cursor = await this.deps.store.cursor();
    for (let page = 0; page < EVENT_PAGES_PER_TICK; page++) {
      const { events, next } = await this.deps.app.listEvents(cursor ?? undefined);
      for (const event of events) {
        if (!event.orgId) continue;
        if (event.type === "machine.wake_wanted") {
          await this.wake(event.orgId, new Date(event.at), sum);
        } else if (event.type === "run.finished" || event.type === "machine.ai_limit") {
          await this.countAi(event, sum);
        } else if (event.type === "organization.deleted") {
          if (await this.erase(event.orgId)) sum.erased++;
        }
      }
      if (next !== cursor) await this.deps.store.setCursor(next);
      if (!events.length || next === cursor) return;
      cursor = next;
    }
  }

  // ---- the free AI's answers -----------------------------------------------------------------------------------

  /**
   * One reply on a free sandbox, counted per server and UTC day: answered (`run.finished`, OpenCode, done), refused by
   * the free AI's limit (`machine.ai_limit`, one per refused turn: such a run waits and resumes, so its
   * `run.finished` is not the count), or failed another way (`run.finished` failed with `opencode_failed` or
   * `not_logged_in`). OpenCode counts its free limit per network address, so a server whose replies are refused takes
   * nobody new (`freePlacementAdmission`).
   */
  private async countAi(event: OperatorEvent, sum: TickSummary) {
    const placement = event.orgId ? await this.deps.store.placement(event.orgId) : null;
    if (!placement?.serverId) return;
    const serverId = placement.serverId;
    const data = event.data as {
      brain?: unknown;
      status?: unknown;
      kind?: unknown;
      resetsAt?: unknown;
      failure?: { code?: unknown } | null;
    };
    const at = Number.isFinite(Date.parse(event.at)) ? new Date(event.at) : this.now();
    if (event.type === "machine.ai_limit") {
      if (data.kind !== FREE_BRAIN) return;
      await this.deps.store.countAi(serverId, dayOf(event.at), "refused");
      sum.aiRefused++;
      // OpenCode counts its free limit per network address, and every sandbox on a server shares one: one refusal
      // means the server's address is out until the limit lifts.
      await this.refuseUntil(serverId, refusedUntil(at, data.resetsAt));
      return;
    }
    if (data.brain === FREE_BRAIN && data.status === "done") {
      await this.deps.store.countAi(serverId, dayOf(event.at), "answered");
      sum.aiAnswered++;
      return;
    }
    if (data.status !== "failed" || !FAILED_ANOTHER_WAY.has(String(data.failure?.code ?? ""))) return;
    await this.deps.store.countAi(serverId, dayOf(event.at), "failed");
    sum.aiFailed++;
    if (data.failure?.code === "opencode_failed" && event.orgId && this.failedBurst(serverId, event.orgId, at)) {
      // OpenCode failing for many workspaces of one server at once is its free AI refusing that address under
      // another name: counted and remembered as a refusal.
      await this.deps.store.countAi(serverId, dayOf(event.at), "refused");
      sum.aiRefused++;
      await this.refuseUntil(serverId, refusedUntil(at, null));
    }
  }

  /** Whether `opencode_failed` has now come from at least the burst's number of workspaces within its minutes. */
  private failedBurst(serverId: string, orgId: string, at: Date): boolean {
    const { failedBurstWorkspaces: workspaces, failedBurstMinutes: minutes } = this.deps.settings;
    if (!workspaces || !minutes) return false;
    const since = at.getTime() - minutes * 60_000;
    const recent = (this.recentFailures.get(serverId) ?? []).filter((f) => f.at >= since && f.orgId !== orgId);
    recent.push({ orgId, at: at.getTime() });
    this.recentFailures.set(serverId, recent);
    if (new Set(recent.map((f) => f.orgId)).size < workspaces) return false;
    this.recentFailures.delete(serverId); // one burst, one refusal
    return true;
  }

  /** Remembers that the server's free AI is refused until `until`; a later time wins, an earlier one changes nothing. */
  private async refuseUntil(serverId: string, until: Date) {
    const held = await this.deps.store.aiRefusedUntil(serverId);
    if (held && held.getTime() >= until.getTime()) return;
    await this.deps.store.setAiRefusedUntil(serverId, until);
    this.log("free_sandbox.ai_refused", { serverId, until: until.toISOString() });
  }

  /** Whether the server's free AI is refused now. */
  private async refusedNow(serverId: string): Promise<boolean> {
    const until = await this.deps.store.aiRefusedUntil(serverId);
    return !!until && until.getTime() > this.now().getTime();
  }

  // ---- waking -------------------------------------------------------------------------------------------------

  private async wake(orgId: string, wantedAt: Date, sum: TickSummary) {
    const placement = await this.deps.store.placement(orgId);
    if (!placement || placement.state === "awake" || placement.state === "placing") return;
    if (placement.state !== "stopped" && placement.state !== "packed") return;
    const started = await this.tryWake(placement, sum);
    if (!started) {
      await this.deps.store.addWake(orgId, wantedAt);
      sum.queued++;
    }
  }

  /** Waiting wakes, oldest first, while there is room. */
  private async drainWakes(sum: TickSummary) {
    for (const { orgId } of await this.deps.store.wakes()) {
      const placement = await this.deps.store.placement(orgId);
      if (!placement || (placement.state !== "stopped" && placement.state !== "packed")) {
        await this.deps.store.removeWake(orgId);
        continue;
      }
      if (!(await this.tryWake(placement, sum))) return;
      await this.deps.store.removeWake(orgId);
    }
  }

  /** Starts a stopped sandbox, or brings a packed one back. False: no room now (it waits in line). */
  private async tryWake(placement: Placement, sum: TickSummary): Promise<boolean> {
    const { settings } = this.deps;
    const spec = specOf(settings);
    if (placement.state === "stopped" && placement.serverId) {
      const { servers, awake } = await this.occupancy();
      const server = servers.find((s) => s.id === placement.serverId);
      if (!server || !freeWakeAdmission(awake.get(server.id) ?? 0, server.cpus, settings).admit) return false;
      try {
        await this.deps.host.start(server.id, placement.sandbox, spec);
      } catch (err) {
        await this.flag(placement, "start", err, sum);
        return true;
      }
      await this.save(placement, { state: "awake" });
      sum.woken++;
      return true;
    }
    if (placement.state !== "packed" || !placement.archive) return false;
    const server = await this.serverForNewPlace();
    if (!server) return false;
    const ready = new Date(this.now().getTime() + RESTORE_ESTIMATE_MS).toISOString();
    if (placement.machineId) {
      await this.deps.app.setStorage(placement.orgId, placement.machineId, "restoring", ready);
    }
    await this.save(placement, { state: "restoring", serverId: server.id });
    try {
      await this.deps.archives.fetch(server.id, placement.sandbox, placement.archive);
      await this.deps.host.restore(server.id, placement.sandbox, spec, placement.archive.sha256);
      await this.deps.host.start(server.id, placement.sandbox, spec);
    } catch (err) {
      // The stored copy is untouched: it stays packed and is tried again on the next want.
      await this.save(placement, { state: "packed", serverId: null });
      if (placement.machineId) await this.deps.app.setStorage(placement.orgId, placement.machineId, "stored");
      this.problem("restore", placement, err);
      sum.failed++;
      return true;
    }
    await this.save(placement, { state: "awake", serverId: server.id });
    if (placement.machineId) await this.deps.app.setStorage(placement.orgId, placement.machineId, null);
    sum.woken++;
    return true;
  }

  // ---- placing ------------------------------------------------------------------------------------------------

  private async placeWaiting(sum: TickSummary) {
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const { requests, next } = await this.deps.app.listMachineRequests(cursor);
      for (const request of requests) {
        try {
          await this.place(request, sum);
        } catch (err) {
          // One workspace's failure never stops the pass: it is listed again next time.
          this.log("free_sandbox.request_failed", {
            orgId: request.orgId,
            error: errorName(err),
            status: statusOf(err),
          });
          sum.failed++;
        }
      }
      if (!next) return;
      cursor = next;
    }
  }

  /** Makes (or keeps) the workspace's computer row and holds its new code in memory. */
  private async issueCode(orgId: string): Promise<IssuedMachine> {
    const issued = await this.deps.app.issueMachine(orgId);
    this.codes.set(orgId, issued);
    return issued;
  }

  /** The held code while it has a minute or more left, else a new one for the same computer (the old one stops). */
  private async freshCode(orgId: string): Promise<IssuedMachine> {
    const held = this.codes.get(orgId);
    if (held && Date.parse(held.expiresAt) - this.now().getTime() >= CODE_MARGIN_MS) return held;
    return this.issueCode(orgId);
  }

  /** Free, paid or not known yet: by the owner's address, and only when the app says it is verified. */
  private async tierOfRequest(request: MachineRequest): Promise<SandboxTier["tier"]> {
    if (!request.owner) return "unknown";
    const user = await this.deps.app.findUserByEmail(request.owner.email);
    if (!user || user.blockedAt || user.deletionDueAt) return user ? "unknown" : "free";
    if (!user.emailVerified) return "free";
    const hivraId = await this.deps.accounts.hivraUserIdForEmail(user.email);
    if (!hivraId) return "free";
    return (await this.deps.tierOf(hivraId)).tier;
  }

  private async place(request: MachineRequest, sum: TickSummary) {
    const { app, store, settings } = this.deps;
    if (await store.placement(request.orgId)) return;
    const tier = await this.tierOfRequest(request);
    if (tier === "paid") {
      sum.skippedPaid++;
      return;
    }
    if (tier !== "free") return;
    // The workspace's computer row and its limits come first, before any place or sandbox: with the row there, a
    // message sent early waits for the computer's first hello instead of being refused for having no AI.
    if (!(await app.setPlanLimits(request.orgId, freePlanLimits(settings)))) return;
    const waiting = (await store.waitlist()).includes(request.orgId);
    if (!waiting && !this.codes.has(request.orgId)) await this.issueCode(request.orgId);
    const server = await this.serverForNewPlace();
    if (!server) {
      await app.reportProvisioning(request.orgId, { state: "waiting", reason: "capacity" });
      await store.setWaitlisted(request.orgId, true);
      sum.waitlisted++;
      return;
    }
    const now = this.now();
    const placement: Placement = {
      orgId: request.orgId,
      sandbox: { sandboxId: randomUUID(), computerId: randomUUID(), ownerHash: ownerHashOf(request.orgId) },
      machineId: null,
      serverId: server.id,
      state: "placing",
      placedAt: now,
      stateAt: now,
      archive: null,
      problem: null,
    };
    await store.save(placement);
    await store.setWaitlisted(request.orgId, false);
    const eta = new Date(now.getTime() + CREATE_ESTIMATE_MS).toISOString();
    try {
      await app.reportProvisioning(request.orgId, { state: "preparing", step: "reserving", expectedReadyAt: eta });
      await this.deps.host.create(server.id, placement.sandbox, specOf(settings));
      await app.reportProvisioning(request.orgId, { state: "preparing", step: "starting", expectedReadyAt: eta });
      const issued = await this.freshCode(request.orgId);
      placement.machineId = issued.machineId;
      await store.save(placement);
      await app.reportProvisioning(request.orgId, { state: "preparing", step: "connecting", expectedReadyAt: eta });
      try {
        await this.deps.host.enroll(server.id, placement.sandbox, issued.enrollCode, this.deps.appUrl);
      } finally {
        this.codes.delete(request.orgId); // single use, tried or not
      }
    } catch (err) {
      this.problem("place", placement, err);
      sum.failed++;
      // Nothing of the person's is in a sandbox that never connected: take it down so the next pass starts clean.
      await this.deps.host.remove(server.id, placement.sandbox).catch(() => {});
      await store.remove(request.orgId);
      await app.reportProvisioning(request.orgId, { state: "problem" }).catch(() => false);
      return;
    }
    await this.save(placement, { state: "awake" });
    sum.placed++;
  }

  // ---- idle -----------------------------------------------------------------------------------------------------

  private async sweep(sum: TickSummary) {
    for (const placement of await this.deps.store.placements()) {
      if (placement.state !== "awake" && placement.state !== "stopped") continue;
      try {
        await this.sweepOne(placement, sum);
      } catch (err) {
        this.problem("sweep", placement, err);
        sum.failed++;
      }
    }
  }

  private async sweepOne(placement: Placement, sum: TickSummary) {
    const { app, settings } = this.deps;
    const state = placement.state;
    if (state !== "awake" && state !== "stopped") return;
    const [machines, members] = await Promise.all([
      app.listMachines(placement.orgId),
      app.listMembers(placement.orgId),
    ]);
    if (!machines || !members) return; // The workspace is gone: its deletion event erases it.
    const machine = machines.find((m) => m.managed && m.id === placement.machineId);
    const busy = !!machine && (machine.busy || machine.waitingRuns > 0);
    const decision = decideFreeSandbox(
      { state, personActivityAt: personActivityAt(members), placedAt: placement.placedAt, personRunActive: busy },
      settings,
      this.now(),
    );
    if (decision.action === "stop") {
      if (await this.stop(placement, sum)) sum.stopped++;
    } else if (decision.action === "pack" && !busy) {
      if (await this.pack(placement, sum)) sum.packed++;
    }
  }

  private async stop(placement: Placement, sum: TickSummary): Promise<boolean> {
    if (!placement.serverId || !placement.machineId) return false;
    // Standby first, so whatever wants it from now on asks for a wake instead of finding it gone.
    if (!(await this.deps.app.setStandby(placement.orgId, placement.machineId, true))) return false;
    try {
      await this.deps.host.stop(placement.serverId, placement.sandbox);
    } catch (err) {
      await this.flag(placement, "stop", err, sum);
      return false;
    }
    await this.save(placement, { state: "stopped" });
    return true;
  }

  /** Into storage: packed, copied off the server and read back there, and only then removed from the server. */
  private async pack(placement: Placement, sum: TickSummary): Promise<boolean> {
    const serverId = placement.serverId;
    if (!serverId) return false;
    if (placement.state === "awake" && !(await this.stop(placement, sum))) return false;
    const previous = placement.archive;
    await this.save(placement, { state: "packing" });
    let copy: Placement["archive"];
    try {
      const packed = await this.deps.host.pack(serverId, placement.sandbox);
      copy = await this.deps.archives.upload(serverId, placement.sandbox, packed.sha256);
      if (copy.sha256 !== packed.sha256) throw new Error("The stored copy does not match the packed archive");
      await this.deps.host.release(serverId, placement.sandbox, packed.sha256);
    } catch (err) {
      // Still whole on the server, stopped: the next pass tries again.
      await this.save(placement, { state: "stopped" });
      this.problem("pack", placement, err);
      sum.failed++;
      return false;
    }
    await this.save(placement, {
      state: "packed",
      serverId: null,
      archive: copy,
    });
    if (previous && previous.location !== copy.location) await this.deps.archives.erase(previous).catch(() => {});
    if (placement.machineId) await this.deps.app.setStorage(placement.orgId, placement.machineId, "stored");
    return true;
  }

  // ---- erasure --------------------------------------------------------------------------------------------------

  /** The workspace was deleted: its computer, its sandbox and every stored copy go. Nothing else ever deletes. */
  private async erase(orgId: string): Promise<boolean> {
    const placement = await this.deps.store.placement(orgId);
    if (!placement) return false;
    if (placement.machineId) await this.deps.app.removeMachine(orgId, placement.machineId);
    if (placement.serverId) await this.deps.host.remove(placement.serverId, placement.sandbox);
    if (placement.archive) await this.deps.archives.erase(placement.archive);
    await this.deps.store.removeWake(orgId);
    await this.deps.store.setWaitlisted(orgId, false);
    await this.deps.store.remove(orgId);
    return true;
  }

  // ---- capacity -------------------------------------------------------------------------------------------------

  private async reportCapacity() {
    const { servers, placed } = await this.occupancy();
    let placesLeft = 0;
    const today = dayOf(this.now().toISOString());
    for (const server of servers) {
      if (server.paidWaiting || !server.paidReserveIntact) continue;
      if (await this.refusedNow(server.id)) continue;
      const share = refusedShare(await this.deps.store.aiDay(server.id, today), this.deps.settings);
      if (share !== null && share > this.deps.settings.refusedShareStop) continue;
      placesLeft += Math.max(0, openPlaces(this.deps.settings) - (placed.get(server.id) ?? 0));
    }
    const waitlistCount = (await this.deps.store.waitlist()).length;
    await this.deps.app.setCapacity({
      tier: CAPACITY_TIER,
      open: placesLeft > 0,
      placesLeft,
      waitlistCount,
    });
  }

  // ---- records --------------------------------------------------------------------------------------------------

  private async save(placement: Placement, change: Partial<Placement>) {
    Object.assign(placement, change, { stateAt: this.now() });
    if (change.state && change.state !== "flagged") placement.problem = null;
    await this.deps.store.save(placement);
  }

  private async flag(placement: Placement, step: string, err: unknown, sum: TickSummary) {
    this.problem(step, placement, err);
    sum.failed++;
    await this.save(placement, { state: "flagged", problem: `${step} failed` });
  }

  /** Logs a failed step by its ids and error name only: never a code, a token or an address. */
  private problem(step: string, placement: Placement, err: unknown) {
    this.log("free_sandbox.step_failed", {
      step,
      orgId: placement.orgId,
      sandboxId: placement.sandbox.sandboxId,
      serverId: placement.serverId,
      error: errorName(err),
      status: statusOf(err),
    });
  }
}
