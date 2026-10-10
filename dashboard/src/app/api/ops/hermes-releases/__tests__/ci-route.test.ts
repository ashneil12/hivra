import { NextRequest } from "next/server";

import { reportOpsEvent } from "@/lib/ops-events";
import { createSupabaseMemoryDb, type MemoryRow } from "@/test-utils/supabase-memory-db";

import { POST } from "../ci/route";

const mockDb: { current: unknown } = { current: null };
const mockResolve = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: "user_admin" })),
  currentUser: jest.fn(async () => ({
    primaryEmailAddress: { emailAddress: "admin@example.com", verification: { status: "verified" } },
  })),
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn().mockResolvedValue({}) }));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.current;
  },
}));
jest.mock("@/lib/hermes-releases/registry", () => ({
  ...jest.requireActual("@/lib/hermes-releases/registry"),
  resolveGhcrTag: (...args: unknown[]) => mockResolve(...args),
}));

const TOKEN = "t".repeat(40);
const REPO = "ghcr.io/ashneil12/vanilla-hermes-agent-canary";
const TAG = "v2026.9.24-ab12cd3";
const DIGEST = `sha256:${"c".repeat(64)}`;

let ipCounter = 0;

function call(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  // A fresh address per request keeps the in-memory limiter out of other tests.
  return POST(
    new NextRequest("http://localhost/api/ops/hermes-releases/ci", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`, ...headers },
      body: JSON.stringify(body),
    })
  );
}

function setup(seed: Record<string, MemoryRow[]> = {}) {
  const memory = createSupabaseMemoryDb({
    tables: ["hermes_releases", "hermes_release_events"],
    seed,
    uniqueIndexes: {
      hermes_releases: [{ name: "repo_digest", columns: ["image_repo", "digest"], where: () => true }],
    },
  });
  mockDb.current = memory.db;
  return memory;
}

beforeEach(() => {
  process.env.HERMES_RELEASE_CI_TOKEN = TOKEN;
  process.env.OPS_ADMIN_EMAILS = "admin@example.com";
  mockResolve.mockReset().mockResolvedValue(DIGEST);
  (reportOpsEvent as jest.Mock).mockClear();
  setup();
});

afterEach(() => {
  delete process.env.HERMES_RELEASE_CI_TOKEN;
});

describe("POST /api/ops/hermes-releases/ci: authentication", () => {
  it("refuses a missing token, a wrong token and a near-miss, and touches nothing", async () => {
    const memory = setup();
    expect((await call({ imageRepo: REPO, tag: TAG }, {})).status).toBe(401);
    expect((await call({ imageRepo: REPO, tag: TAG }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await call({ imageRepo: REPO, tag: TAG }, { authorization: `Bearer ${"t".repeat(39)}x` })).status).toBe(401);
    expect((await call({ imageRepo: REPO, tag: TAG }, { authorization: TOKEN })).status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(memory.tables.hermes_releases).toHaveLength(0);
    expect(memory.tables.hermes_release_events).toHaveLength(0);
  });

  it("does not accept a signed-in ops admin session in place of the token", async () => {
    // Clerk is mocked as a signed-in admin; the route must still want the bearer token.
    expect((await call({ imageRepo: REPO, tag: TAG }, {})).status).toBe(401);
  });

  it("is closed when the token is not set or is too short to be a real secret", async () => {
    delete process.env.HERMES_RELEASE_CI_TOKEN;
    expect((await call({ imageRepo: REPO, tag: TAG }, { authorization: "Bearer " })).status).toBe(503);
    process.env.HERMES_RELEASE_CI_TOKEN = "short";
    expect((await call({ imageRepo: REPO, tag: TAG }, { authorization: "Bearer short" })).status).toBe(503);
  });

  it("rate-limits a single address, including failed token guesses", async () => {
    const headers = { authorization: "Bearer wrong", "x-forwarded-for": "198.51.100.7" };
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await call({ imageRepo: REPO, tag: TAG }, headers)).status);
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(401));
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});

describe("POST /api/ops/hermes-releases/ci: what it may register", () => {
  it("refuses an image repository that is not on the allowlist", async () => {
    const memory = setup();
    for (const imageRepo of [
      "ghcr.io/ashneil12/vanilla-hermes-agent",
      "ghcr.io/ashneil12/vanilla-hermes-agent-canary-evil",
      "ghcr.io/attacker/vanilla-hermes-agent-canary",
      "docker.io/ashneil12/vanilla-hermes-agent-canary",
    ]) {
      const res = await call({ imageRepo, tag: TAG });
      expect(res.status).toBe(400);
    }
    expect(mockResolve).not.toHaveBeenCalled();
    expect(memory.tables.hermes_releases).toHaveLength(0);
  });

  it("refuses floating tags and a digest-less 'latest' style registration", async () => {
    for (const tag of ["stable", "latest", "canary", "main", "v2026.9.24", "v2026.9.24-ab12cd"]) {
      expect((await call({ imageRepo: REPO, tag })).status).toBe(400);
    }
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("refuses any field that would set a stage, channel, halt state or rollout", async () => {
    const memory = setup();
    for (const extra of [
      { channel: "stable" },
      { stage: "full" },
      { promote: true },
      { rollout_percent: 100 },
      { halted: false },
      { action: "unhalt" },
      { pilotInstanceId: "22222222-2222-4222-8222-222222222222" },
      { version: "9.9.9" },
    ]) {
      expect((await call({ imageRepo: REPO, tag: TAG, ...extra })).status).toBe(400);
    }
    expect(memory.tables.hermes_releases).toHaveLength(0);
  });

  it("surfaces a registry failure as 422 and registers nothing", async () => {
    const { ReleaseRegistryError } = jest.requireActual("@/lib/hermes-releases/registry");
    mockResolve.mockRejectedValueOnce(new ReleaseRegistryError(`Tag ${TAG} was not found in ${REPO}.`));
    const memory = setup();
    expect((await call({ imageRepo: REPO, tag: TAG })).status).toBe(422);
    expect(memory.tables.hermes_releases).toHaveLength(0);
  });

  it("refuses a digest that disagrees with the registry", async () => {
    const memory = setup();
    expect((await call({ imageRepo: REPO, tag: TAG, digest: `sha256:${"d".repeat(64)}` })).status).toBe(409);
    expect(memory.tables.hermes_releases).toHaveLength(0);
    expect((await call({ imageRepo: REPO, tag: TAG, digest: DIGEST })).status).toBe(201);
  });
});

describe("POST /api/ops/hermes-releases/ci: registration", () => {
  it("registers by tag, resolving the digest from the registry, at the unpromoted stage", async () => {
    const memory = setup();
    const res = await call({ imageRepo: REPO, tag: TAG, notes: "proved by upstream-sync-followup" });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.created).toBe(true);
    expect(data.release).toMatchObject({ version: TAG, digest: DIGEST, stage: "registered", halted: false });
    expect(mockResolve).toHaveBeenCalledWith(REPO, TAG);

    expect(memory.tables.hermes_releases).toHaveLength(1);
    expect(memory.tables.hermes_releases[0]).toMatchObject({
      image_repo: REPO,
      version: TAG,
      digest: DIGEST,
      channel: "canary",
      rollout_percent: 0,
      pilot_instance_ids: [],
      halted: false,
      promoted_at: null,
      created_by: "ci",
    });
    // The audit trail names the actor, and nothing was promoted.
    expect(memory.tables.hermes_release_events).toEqual([
      expect.objectContaining({ kind: "registered", actor: "ci", digest: DIGEST }),
    ]);
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "hermes-release", metadata: expect.objectContaining({ actor: "ci" }) })
    );
  });

  it("is idempotent on the same digest: one row, one event, one ops report", async () => {
    const memory = setup();
    const first = await call({ imageRepo: REPO, tag: TAG });
    const second = await call({ imageRepo: REPO, tag: TAG });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const [a, b] = [(await first.json()).data, (await second.json()).data];
    expect(b.created).toBe(false);
    expect(b.release.id).toBe(a.release.id);
    expect(memory.tables.hermes_releases).toHaveLength(1);
    expect(memory.tables.hermes_release_events).toHaveLength(1);
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
  });

  it("never moves an existing release: a promoted one stays promoted, a halted one stays halted", async () => {
    const promoted = {
      id: "44444444-4444-4444-8444-444444444444", image_repo: REPO, version: "old", digest: DIGEST,
      channel: "stable", rollout_percent: 100, pilot_instance_ids: [], halted: false, promoted_at: "2026-10-01T00:00:00Z",
      created_by: "ops:user_x", created_at: "2026-10-01T00:00:00Z",
    };
    const memory = setup({ hermes_releases: [promoted] });
    let res = await call({ imageRepo: REPO, tag: TAG });
    expect(res.status).toBe(200);
    expect(memory.tables.hermes_releases[0]).toMatchObject({ channel: "stable", rollout_percent: 100, halted: false });

    const halted = { ...promoted, halted: true, halted_reason: "regression", halted_at: "2026-10-02T00:00:00Z", halted_by: "ops:user_x" };
    const memory2 = setup({ hermes_releases: [halted] });
    res = await call({ imageRepo: REPO, tag: TAG });
    expect(res.status).toBe(200);
    expect((await res.json()).data.release.halted).toBe(true);
    expect(memory2.tables.hermes_releases[0]).toMatchObject({ halted: true, halted_reason: "regression" });
    expect(memory2.tables.hermes_release_events).toHaveLength(0);
  });

  it("caps genuinely new releases per hour, but still answers a repeat of a known image", async () => {
    const now = new Date().toISOString();
    const seeded = Array.from({ length: 10 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
      image_repo: REPO, version: `v1-000000${i}`, digest: `sha256:${String(i).repeat(64)}`,
      channel: "canary", rollout_percent: 0, pilot_instance_ids: [], halted: false, promoted_at: null,
      created_by: "ci", created_at: now,
    }));
    const memory = setup({ hermes_releases: seeded });
    const res = await call({ imageRepo: REPO, tag: TAG });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(memory.tables.hermes_releases).toHaveLength(10);

    mockResolve.mockResolvedValueOnce(seeded[3].digest);
    expect((await call({ imageRepo: REPO, tag: "v1-0000003" })).status).toBe(200);
  });
});
