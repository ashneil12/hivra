import { FreeSandboxBridge, freePlanLimits, personActivityAt } from "../bridge";
import { OperatorApiError, OperatorClient, operatorBaseUrl } from "../operator-api";
import type { ArchiveCopy, BridgeStore, Placement, PoolServer, SandboxHost, SandboxRef } from "../ports";
import type { FreeSandboxSettings } from "../settings";
import { BASE, FakeOperatorApp, TOKEN } from "./fake-operator-app";

const settings: FreeSandboxSettings = {
  sleepAfterIdleMinutes: 10,
  storeAfterIdleHours: 24,
  memoryMb: 1024,
  cpus: 0.5,
  storageMb: 1024,
  freePlacesPerServer: 2,
  hermesPlacesPerServer: 0,
  freeModels: ["opencode/model-a", "opencode/model-b"],
  paidReserveComputers: 1,
  cpuOvercommit: 2,
  maxConcurrentTurns: 4,
  dailyReplySecondsCap: null,
  agents: 1,
  scheduledJobs: 1,
  scheduledJobMinHours: 24,
  placesOpenPerServer: 50,
  refusedShareStop: 0.2,
  refusedShareMinReplies: 10,
};

const MIN = 60_000;
const HOUR = 60 * MIN;

class MemoryStore implements BridgeStore {
  pool: PoolServer[] = [{ id: "pool-1", cpus: 4, paidReserveIntact: true, paidWaiting: false }];
  rows = new Map<string, Placement>();
  cur: string | null = null;
  wakeRows: { orgId: string; wantedAt: Date }[] = [];
  waiting = new Set<string>();
  ai = new Map<string, { answered: number; refused: number; failed: number }>();
  async aiDay(serverId: string, day: string) {
    return this.ai.get(`${serverId}|${day}`) ?? { answered: 0, refused: 0, failed: 0 };
  }
  async countAi(serverId: string, day: string, kind: "answered" | "refused" | "failed") {
    const row = { ...(await this.aiDay(serverId, day)) };
    row[kind]++;
    this.ai.set(`${serverId}|${day}`, row);
  }
  async servers() {
    return this.pool;
  }
  async placement(orgId: string) {
    return this.rows.get(orgId) ?? null;
  }
  async placements() {
    return [...this.rows.values()];
  }
  async save(p: Placement) {
    this.rows.set(p.orgId, p);
  }
  async remove(orgId: string) {
    this.rows.delete(orgId);
  }
  async cursor() {
    return this.cur;
  }
  async setCursor(c: string | null) {
    this.cur = c;
  }
  async wakes() {
    return [...this.wakeRows].sort((a, b) => a.wantedAt.getTime() - b.wantedAt.getTime());
  }
  async addWake(orgId: string, wantedAt: Date) {
    if (!this.wakeRows.some((w) => w.orgId === orgId)) this.wakeRows.push({ orgId, wantedAt });
  }
  async removeWake(orgId: string) {
    this.wakeRows = this.wakeRows.filter((w) => w.orgId !== orgId);
  }
  async waitlist() {
    return [...this.waiting];
  }
  async setWaitlisted(orgId: string, on: boolean) {
    if (on) this.waiting.add(orgId);
    else this.waiting.delete(orgId);
  }
}

/** The adapter on the pool servers: records calls, and the runner's hello when it enrolls. */
class FakeHost implements SandboxHost {
  calls: string[] = [];
  failPack = false;
  constructor(private readonly app: FakeOperatorApp) {}
  async create(serverId: string, sb: SandboxRef) {
    this.calls.push(`create ${serverId} ${sb.sandboxId}`);
  }
  async start(serverId: string, sb: SandboxRef) {
    this.calls.push(`start ${serverId} ${sb.sandboxId}`);
  }
  async stop(serverId: string, sb: SandboxRef) {
    this.calls.push(`stop ${serverId} ${sb.sandboxId}`);
  }
  async enroll(serverId: string, sb: SandboxRef, code: string, url: string) {
    this.calls.push(`enroll ${serverId} ${url}`);
    if (!this.app.redeem(code)) throw new Error("code refused");
  }
  async pack(serverId: string) {
    this.calls.push(`pack ${serverId}`);
    if (this.failPack) throw new Error("disk");
    return { sha256: "a".repeat(64), bytes: 1000 };
  }
  async release(serverId: string, sb: SandboxRef, sha: string) {
    this.calls.push(`release ${serverId} ${sha.slice(0, 4)}`);
  }
  async restore(serverId: string, sb: SandboxRef, _spec: unknown, sha: string) {
    this.calls.push(`restore ${serverId} ${sha.slice(0, 4)}`);
  }
  async remove(serverId: string) {
    this.calls.push(`remove ${serverId}`);
  }
}

class FakeArchives {
  calls: string[] = [];
  async upload(_s: string, sb: SandboxRef, sha256: string): Promise<ArchiveCopy> {
    this.calls.push("upload");
    return { location: `store/${sb.sandboxId}/${this.calls.length}`, sha256, bytes: 1000 };
  }
  async fetch(serverId: string) {
    this.calls.push(`fetch ${serverId}`);
  }
  async erase(copy: ArchiveCopy) {
    this.calls.push(`erase ${copy.location}`);
  }
}

function setup(tiers: Record<string, "free" | "paid" | "unknown"> = {}) {
  const app = new FakeOperatorApp();
  const store = new MemoryStore();
  const host = new FakeHost(app);
  const archives = new FakeArchives();
  let now = new Date("2026-11-17T12:00:00Z");
  const logs: Record<string, unknown>[] = [];
  const client = new OperatorClient({ baseUrl: BASE, token: TOKEN, fetch: app.fetch as typeof fetch });
  const bridge = new FreeSandboxBridge({
    app: client,
    store,
    host,
    archives,
    accounts: { hivraUserIdForEmail: async (email) => (tiers[email] ? `hivra-${email}` : null) },
    tierOf: async (id) => {
      const tier = tiers[id.replace("hivra-", "")];
      return tier === "paid" ? { tier: "paid", plan: "p" } : ({ tier: tier ?? "free" } as { tier: "free" });
    },
    settings,
    appUrl: "https://agents.example",
    now: () => now,
    log: (_e, fields) => logs.push(fields),
  });
  return {
    app,
    store,
    host,
    archives,
    bridge,
    logs,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    now: () => now,
  };
}

describe("operator client", () => {
  it("takes https, or http on this machine only, ending in the operator prefix", () => {
    expect(operatorBaseUrl("https://a.example/api/operator/v1/")).toBe("https://a.example/api/operator/v1");
    expect(operatorBaseUrl("http://127.0.0.1:3011/api/operator/v1")).toBe("http://127.0.0.1:3011/api/operator/v1");
    expect(() => operatorBaseUrl("http://a.example/api/operator/v1")).toThrow();
    expect(() => operatorBaseUrl("https://u:p@a.example/api/operator/v1")).toThrow();
    expect(() => operatorBaseUrl("https://a.example/api")).toThrow();
  });

  it("names the route and the app's error code in its errors, never the token", async () => {
    const app = new FakeOperatorApp();
    const client = new OperatorClient({ baseUrl: BASE, token: "wrong-token-123", fetch: app.fetch as typeof fetch });
    const err = await client.listMachineRequests().catch((e) => e);
    expect(err).toBeInstanceOf(OperatorApiError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("unauthorized");
    expect(err.message).not.toContain("wrong-token");
  });

  it("answers false, not an error, while the app lacks the storage and capacity routes", async () => {
    const app = new FakeOperatorApp();
    const client = new OperatorClient({ baseUrl: BASE, token: TOKEN, fetch: app.fetch as typeof fetch });
    await expect(client.setCapacity({ tier: "free", open: true, placesLeft: 1, waitlistCount: 0 })).resolves.toBe(
      false,
    );
    app.hasStorageRoutes = true;
    await expect(client.setCapacity({ tier: "free", open: true, placesLeft: 1, waitlistCount: 0 })).resolves.toBe(true);
  });
});

describe("free sandbox bridge", () => {
  it("places a free workspace: limits with the free models, progress, a computer, the runner enrolled", async () => {
    const t = setup();
    t.app.addWorkspace("org-1", "a@example.com");
    const sum = await t.bridge.tick();
    expect(sum.placed).toBe(1);
    const org = t.app.org("org-1");
    expect(org.planLimits).toEqual({
      agents: 1,
      brains: ["opencode"],
      routines: 1,
      routineMinutes: 1440,
      models: settings.freeModels,
    });
    const steps = t.app.calls
      .filter((c) => c.path === "/orgs/org-1/provisioning")
      .map((c) => (c.body as { step?: string }).step);
    expect(steps).toEqual(["reserving", "starting", "connecting"]);
    for (const c of t.app.calls.filter((c) => c.path === "/orgs/org-1/provisioning")) {
      expect(c.body).not.toHaveProperty("specs");
    }
    expect(t.host.calls[0]).toMatch(/^create pool-1/);
    expect(t.host.calls).toContain("enroll pool-1 https://agents.example");
    expect(org.machine?.online).toBe(true);
    expect((await t.store.placement("org-1"))?.state).toBe("awake");
    // Listed no more once its runner said hello: the next pass places nothing.
    expect((await t.bridge.tick()).placed).toBe(0);
  });

  it("leaves a paying owner's workspace alone, and places nothing while the plan read fails", async () => {
    const t = setup({ "paid@example.com": "paid", "flaky@example.com": "unknown" });
    t.app.addWorkspace("org-paid", "paid@example.com");
    t.app.addWorkspace("org-flaky", "flaky@example.com");
    const sum = await t.bridge.tick();
    expect(sum.skippedPaid).toBe(1);
    expect(sum.placed).toBe(0);
    expect(t.app.org("org-paid").planLimits).toBeNull();
    expect(t.host.calls).toEqual([]);
  });

  it("treats an owner whose address is not verified as Free, whatever account has that address", async () => {
    const t = setup({ "pending@example.com": "paid" });
    t.app.addWorkspace("org-p", "pending@example.com", { verified: false });
    expect((await t.bridge.tick()).placed).toBe(1);
  });

  it("tells a workspace to wait when the places are full, and reports the waiting list", async () => {
    const t = setup();
    for (const id of ["o1", "o2", "o3"]) t.app.addWorkspace(id, `${id}@example.com`);
    t.app.hasStorageRoutes = true;
    const sum = await t.bridge.tick();
    expect(sum.placed).toBe(2);
    expect(sum.waitlisted).toBe(1);
    expect(t.app.org("o3").provisioning).toMatchObject({ state: "waiting", reason: "capacity" });
    expect(t.app.capacity.at(-1)).toEqual({ tier: "free", open: false, placesLeft: 0, waitlistCount: 1 });
  });

  it("never takes the paid reserve or a server a paid computer waits for", async () => {
    const t = setup();
    t.store.pool = [
      { id: "reserve", cpus: 4, paidReserveIntact: false, paidWaiting: false },
      { id: "paid-waits", cpus: 4, paidReserveIntact: true, paidWaiting: true },
    ];
    t.app.addWorkspace("o1", "o1@example.com");
    expect((await t.bridge.tick()).waitlisted).toBe(1);
  });

  it("stops after the quiet minutes by people only, standby first; never while busy", async () => {
    const t = setup();
    t.app.addWorkspace("org-1", "a@example.com");
    await t.bridge.tick();
    const org = t.app.org("org-1");
    org.members[0].lastSeenAt = t.now().toISOString();
    t.advance(9 * MIN);
    expect((await t.bridge.tick()).stopped).toBe(0);
    t.advance(2 * MIN);
    org.machine!.busy = true; // a run (a scheduled job, say) holds the stop, but never moves the clock
    org.machine!.lastUsedAt = t.now().toISOString();
    expect((await t.bridge.tick()).stopped).toBe(0);
    org.machine!.busy = false;
    expect((await t.bridge.tick()).stopped).toBe(1);
    const standbyAt = t.app.calls.findIndex((c) => c.path.endsWith("/standby"));
    expect(standbyAt).toBeGreaterThan(-1);
    expect(org.machine!.standby).toBe(true);
    expect(t.host.calls.at(-1)).toMatch(/^stop pool-1/);
  });

  it("packs after the storage hours, copy verified before the server's is removed, then wakes it back", async () => {
    const t = setup();
    t.app.addWorkspace("org-1", "a@example.com");
    t.app.hasStorageRoutes = true;
    await t.bridge.tick();
    t.app.org("org-1").members[0].lastSeenAt = t.now().toISOString();
    t.advance(25 * HOUR);
    expect((await t.bridge.tick()).stopped).toBe(1); // an awake sandbox stops first, then packs on the next pass
    const sum = await t.bridge.tick();
    expect(sum.packed).toBe(1);
    expect(t.host.calls.slice(-2)).toEqual(["pack pool-1", "release pool-1 aaaa"]);
    const packed = (await t.store.placement("org-1"))!;
    expect(packed).toMatchObject({ state: "packed", serverId: null });
    expect(packed.archive?.sha256).toBe("a".repeat(64));
    expect(t.app.storage.at(-1)).toMatchObject({ state: "stored" });
    // The packed computer stays the same computer: never removed from the app.
    expect(t.app.calls.some((c) => c.method === "DELETE")).toBe(false);

    t.app.event("machine.wake_wanted", "org-1", { machineId: packed.machineId, why: "run" });
    // What wants it keeps it busy (a run waiting for it), so the same pass never stops it again.
    t.app.org("org-1").machine!.busy = true;
    const woke = await t.bridge.tick();
    expect(woke.woken).toBe(1);
    expect(t.archives.calls).toContain("fetch pool-1");
    expect(t.host.calls.slice(-2)).toEqual(["restore pool-1 aaaa", expect.stringMatching(/^start pool-1/)]);
    expect(t.app.storage.map((s) => s.state).slice(-2)).toEqual(["restoring", null]);
    expect((await t.store.placement("org-1"))?.state).toBe("awake");
  });

  it("keeps a sandbox whole on its server when packing fails", async () => {
    const t = setup();
    t.app.addWorkspace("org-1", "a@example.com");
    await t.bridge.tick();
    t.host.failPack = true;
    t.advance(25 * HOUR);
    await t.bridge.tick();
    const sum = await t.bridge.tick();
    expect(sum.failed).toBe(1);
    expect(t.host.calls.some((c) => c.startsWith("release"))).toBe(false);
    expect(await t.store.placement("org-1")).toMatchObject({ state: "stopped", serverId: "pool-1" });
  });

  it("queues a wake when the pool's running cap is reached and starts it once there is room", async () => {
    const t = setup();
    t.store.pool = [{ id: "pool-1", cpus: 0.5, paidReserveIntact: true, paidWaiting: false }]; // room for 2 awake
    t.app.addWorkspace("o1", "o1@example.com");
    t.app.addWorkspace("o2", "o2@example.com");
    await t.bridge.tick();
    t.advance(11 * MIN);
    await t.bridge.tick(); // both stop
    for (const id of ["o1", "o2"]) t.app.org(id).members[0].lastSeenAt = t.now().toISOString();
    // A third person's sandbox takes one of the two awake slots.
    t.app.event("machine.wake_wanted", "o1", { why: "view" });
    await t.bridge.tick();
    const o1 = (await t.store.placement("o1"))!;
    expect(o1.state).toBe("awake");
    t.store.rows.set("x", { ...o1, orgId: "x", state: "awake" });
    t.app.event("machine.wake_wanted", "o2", { why: "run" });
    const queued = await t.bridge.tick();
    expect(queued.queued).toBe(1);
    expect((await t.store.placement("o2"))?.state).toBe("stopped");
    t.store.rows.delete("x");
    expect((await t.bridge.tick()).woken).toBe(1);
    expect((await t.store.placement("o2"))?.state).toBe("awake");
  });

  it("erases everything of a workspace only when the workspace is deleted", async () => {
    const t = setup();
    t.app.addWorkspace("org-1", "a@example.com");
    await t.bridge.tick();
    t.advance(25 * HOUR);
    await t.bridge.tick();
    await t.bridge.tick();
    const archive = (await t.store.placement("org-1"))!.archive!;
    t.app.event("organization.deleted", "org-1");
    t.app.orgs.delete("org-1"); // a deleted workspace waits for no computer
    const sum = await t.bridge.tick();
    expect(sum.erased).toBe(1);
    expect(t.app.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/orgs/org-1/machines/"))).toBe(true);
    expect(t.archives.calls).toContain(`erase ${archive.location}`);
    expect(await t.store.placement("org-1")).toBeNull();
  });

  it("never logs an enroll code or the token when a step fails", async () => {
    const t = setup();
    t.app.addWorkspace("org-1", "a@example.com");
    t.host.enroll = async () => {
      throw new Error("refused code code2abcdefgh");
    };
    const sum = await t.bridge.tick();
    expect(sum.failed).toBe(1);
    expect(await t.store.placement("org-1")).toBeNull();
    expect(t.app.org("org-1").provisioning?.state).toBe("problem");
    const logged = JSON.stringify(t.logs);
    expect(logged).not.toMatch(/code\d+abcdefgh/);
    expect(logged).not.toContain(TOKEN);
  });

  it("counts the free AI's replies per server and day, and stops placing where too many are refused", async () => {
    const t = setup();
    t.app.addWorkspace("org-1", "a@example.com");
    await t.bridge.tick();
    const machineId = (await t.store.placement("org-1"))!.machineId;
    const at = t.now().toISOString();
    for (let i = 0; i < 7; i++)
      t.app.event("run.finished", "org-1", { runId: `r${i}`, brain: "opencode", status: "done" }, at);
    for (let i = 0; i < 3; i++)
      t.app.event("machine.ai_limit", "org-1", { machineId, kind: "opencode", resetsAt: null }, at);
    // A refused turn's own run is not the count: only `machine.ai_limit` is.
    t.app.event(
      "run.finished",
      "org-1",
      { brain: "opencode", status: "failed", failure: { code: "plan_limit", cause: "quota" } },
      at,
    );
    t.app.event(
      "run.finished",
      "org-1",
      { brain: "opencode", status: "failed", failure: { code: "opencode_failed", cause: null } },
      at,
    );
    t.app.event("run.finished", "org-1", { brain: "model", status: "done" }, at);
    t.app.addWorkspace("org-2", "b@example.com");
    const sum = await t.bridge.tick();
    expect([sum.aiAnswered, sum.aiRefused, sum.aiFailed]).toEqual([7, 3, 1]);
    expect(await t.store.aiDay("pool-1", at.slice(0, 10))).toEqual({ answered: 7, refused: 3, failed: 1 });
    // 3 of 10 refused is past the 20% stop: the second workspace waits.
    expect(sum.waitlisted).toBe(1);
    expect(t.app.org("org-2").provisioning).toMatchObject({ state: "waiting", reason: "capacity" });
  });

  it("opens places in steps: never more than the open step per server", async () => {
    const t = setup();
    (t as unknown as { bridge: { deps: { settings: FreeSandboxSettings } } }).bridge.deps.settings = {
      ...settings,
      placesOpenPerServer: 1,
    };
    t.app.addWorkspace("o1", "o1@example.com");
    t.app.addWorkspace("o2", "o2@example.com");
    const sum = await t.bridge.tick();
    expect([sum.placed, sum.waitlisted]).toEqual([1, 1]);
  });

  it("reads the person-only clock from the newest member who is still a member", () => {
    expect(
      personActivityAt([
        { userId: "a", email: "a", lastSeenAt: "2026-11-17T10:00:00Z", blockedAt: null, deletionDueAt: null },
        {
          userId: "b",
          email: "b",
          lastSeenAt: "2026-11-17T11:00:00Z",
          blockedAt: "2026-11-17T00:00:00Z",
          deletionDueAt: null,
        },
      ])?.toISOString(),
    ).toBe("2026-11-17T10:00:00.000Z");
    expect(freePlanLimits(settings).models).toEqual(settings.freeModels);
  });
});
