const mockDb = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.value;
  },
}));
const sendMock = jest.fn();
jest.mock("@/lib/email/first-win", () => ({
  ...jest.requireActual("@/lib/email/first-win"),
  sendFirstWinEmail: (...a: unknown[]) => sendMock(...a),
}));
jest.mock("@/lib/posthog", () => ({
  posthogClient: { capture: jest.fn(), flush: jest.fn() },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const recipientMock = jest.fn();
jest.mock("@/lib/recovery/lifecycle-email-sweep", () => ({
  ...jest.requireActual("@/lib/recovery/lifecycle-email-sweep"),
  resolveClerkRecipient: (...a: unknown[]) => recipientMock(...a),
}));

import {
  agentPageUrl,
  runFirstWinEmailSweep,
  selectLaunchNudge,
  selectSayHiNudge,
  type FirstWinAgent,
} from "@/lib/recovery/first-win-email-sweep";
import { buildFirstWinEmail } from "@/lib/email/first-win";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const none = new Set<string>();

describe("selectLaunchNudge", () => {
  const sub = (plan: string, h = 30) => ({ user_id: "u", plan, created_at: hoursAgo(h) });

  it("picks hermes for paid and claude-code for free", () => {
    expect(selectLaunchNudge({ subscription: sub("operator"), everLaunched: false, sentKeys: none, now: NOW })).toEqual({
      profile: "hermes",
      paid: true,
    });
    expect(selectLaunchNudge({ subscription: sub("free"), everLaunched: false, sentKeys: none, now: NOW })).toEqual({
      profile: "claude-code",
      paid: false,
    });
  });

  it("waits 24h and stops after 7 days", () => {
    expect(selectLaunchNudge({ subscription: sub("free", 23), everLaunched: false, sentKeys: none, now: NOW })).toBeNull();
    expect(selectLaunchNudge({ subscription: sub("free", 24 * 7 + 1), everLaunched: false, sentKeys: none, now: NOW })).toBeNull();
  });

  it("never after a launch, never twice, never after the older idle email", () => {
    expect(selectLaunchNudge({ subscription: sub("free"), everLaunched: true, sentKeys: none, now: NOW })).toBeNull();
    expect(selectLaunchNudge({ subscription: sub("free"), everLaunched: false, sentKeys: new Set(["first_win_launch"]), now: NOW })).toBeNull();
    expect(selectLaunchNudge({ subscription: sub("free"), everLaunched: false, sentKeys: new Set(["day1_idle"]), now: NOW })).toBeNull();
    expect(selectLaunchNudge({ subscription: null, everLaunched: false, sentKeys: none, now: NOW })).toBeNull();
  });
});

describe("selectSayHiNudge", () => {
  const agent = (o: Partial<FirstWinAgent> = {}): FirstWinAgent => ({
    id: "a1",
    lane: "hivra",
    name: "Ada",
    readyAt: hoursAgo(2),
    firstUsageAt: null,
    ...o,
  });

  it("picks an agent ready for over an hour with no message", () => {
    expect(selectSayHiNudge({ agents: [agent()], sentKeys: none, now: NOW })?.id).toBe("a1");
  });

  it("waits an hour", () => {
    expect(selectSayHiNudge({ agents: [agent({ readyAt: hoursAgo(0.5) })], sentKeys: none, now: NOW })).toBeNull();
  });

  it("never once any agent has had a message", () => {
    const agents = [agent(), agent({ id: "a2", firstUsageAt: hoursAgo(1) })];
    expect(selectSayHiNudge({ agents, sentKeys: none, now: NOW })).toBeNull();
  });

  it("never twice, and ignores agents that are not ready", () => {
    expect(selectSayHiNudge({ agents: [agent()], sentKeys: new Set(["first_win_say_hi"]), now: NOW })).toBeNull();
    expect(selectSayHiNudge({ agents: [agent({ readyAt: null })], sentKeys: none, now: NOW })).toBeNull();
  });

  it("links to the right page per lane", () => {
    expect(agentPageUrl({ id: "x", lane: "hivra" })).toContain("/dashboard/agent/x");
    expect(agentPageUrl({ id: "x", lane: "hermes" })).toContain("/dashboard/instances/x");
  });
});

describe("email copy", () => {
  it("has no em dashes and keeps free launch copy honest", () => {
    const free = buildFirstWinEmail("first_win_launch", { profile: "claude-code", paid: false });
    const paid = buildFirstWinEmail("first_win_launch", { profile: "hermes", paid: true });
    const hi = buildFirstWinEmail("first_win_say_hi", { agentName: "Ada", agentUrl: "https://x/dashboard/agent/1" });
    for (const c of [free, paid, hi]) {
      expect(c.text + c.html + c.subject).not.toContain("—");
    }
    expect(free.ctaUrl).toMatch(/\/dashboard\/launch\?profile=claude-code$/);
    expect(paid.ctaUrl).toMatch(/\/dashboard\/launch\?profile=hermes$/);
    expect(free.text.toLowerCase()).not.toContain("free");
    expect(hi.subject).toBe("Your agent is ready. Say hi.");
    expect(hi.ctaUrl).toBe("https://x/dashboard/agent/1");
  });
});

// A chainable fake: each table has a queue of results, one per select query.
function fakeDb(queues: Record<string, unknown[][]>) {
  const upserts: unknown[] = [];
  return {
    upserts,
    from(table: string) {
      const rows = queues[table]?.shift() ?? [];
      const b: Record<string, unknown> = {};
      for (const m of ["select", "gte", "lte", "eq", "is", "in", "limit"]) b[m] = () => b;
      b.upsert = (row: unknown) => {
        upserts.push(row);
        return Promise.resolve({ error: null });
      };
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
      return b;
    },
  };
}

describe("runFirstWinEmailSweep", () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({ sent: true });
    recipientMock.mockReset().mockResolvedValue({ email: "a@b.c", firstName: "Sam" });
    process.env.CLERK_SECRET_KEY = "sk";
  });

  it("sends launch to an idle signup and say-hi to a ready silent agent, once each", async () => {
    const db = fakeDb({
      hermes_subscriptions: [[{ user_id: "idle", plan: "free", created_at: hoursAgo(30) }]],
      hivra_agents: [
        [{ user_id: "ready" }],
        [{ id: "ag1", user_id: "ready", name: "Ada", status: "running", provisioned_at: hoursAgo(3), first_usage_at: null }],
      ],
      hermes_instances: [[], []],
      lifecycle_email_sends: [[]],
    });
    mockDb.value = db;
    const summary = await runFirstWinEmailSweep({ now: NOW });
    expect(summary.first_win_launch).toBe(1);
    expect(summary.first_win_say_hi).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][1].idempotencyKey).toBe("lifecycle_first_win_launch_idle");
    expect(db.upserts).toHaveLength(2);
  });

  it("skips a user whose email is already in the ledger", async () => {
    mockDb.value = fakeDb({
      hermes_subscriptions: [[{ user_id: "idle", plan: "free", created_at: hoursAgo(30) }]],
      hivra_agents: [[], []],
      hermes_instances: [[], []],
      lifecycle_email_sends: [[{ user_id: "idle", email_key: "first_win_launch" }]],
    });
    const summary = await runFirstWinEmailSweep({ now: NOW });
    expect(sendMock).not.toHaveBeenCalled();
    expect(summary.first_win_launch).toBe(0);
  });
});
