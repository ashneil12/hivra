import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseMemoryDb } from "@/test-utils/supabase-memory-db";

import { loadReleases, promoteRelease, haltRelease, recordBoxOutcome, registerRelease, ReleaseStoreError, unhaltRelease } from "../store";

jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn().mockResolvedValue({}) }));

const REPO = "ghcr.io/example/agent";
const DIGEST = `sha256:${"b".repeat(64)}`;
const PILOT = "22222222-2222-4222-8222-222222222222";

function setup() {
  const memory = createSupabaseMemoryDb({
    tables: ["hermes_releases", "hermes_release_events"],
    uniqueIndexes: {
      hermes_releases: [{ name: "repo_digest", columns: ["image_repo", "digest"], where: () => true }],
    },
  });
  return { memory, db: memory.db as unknown as SupabaseClient };
}

async function register(db: SupabaseClient, digest = DIGEST, version = "1.0.0") {
  return (await registerRelease(db, { imageRepo: REPO, version, digest, actor: "ops:test" })).release;
}

describe("registerRelease race", () => {
  it("returns the winner when a concurrent registration took the unique slot first", async () => {
    const { db, memory } = setup();
    // The existence check sees nothing, then the insert loses to a registration
    // that landed in between: the failure rule plants that winner as it fires.
    const winner = { id: "99999999-9999-4999-8999-999999999999", image_repo: REPO, digest: DIGEST, version: "1.0.0", channel: "canary", rollout_percent: 0, pilot_instance_ids: [], halted: false, promoted_at: null };
    memory.failNext({
      table: "hermes_releases",
      op: "insert",
      error: { code: "23505", message: "duplicate key" },
      match: () => {
        memory.tables.hermes_releases.push(winner);
        return true;
      },
    });
    const result = await registerRelease(db, { imageRepo: REPO, version: "1.0.0", digest: DIGEST, actor: "ci" });
    expect(result).toMatchObject({ created: false, release: { id: winner.id } });
    expect(memory.tables.hermes_release_events).toHaveLength(0);
  });
});

describe("registerRelease", () => {
  it("registers once, not offered to anyone yet", async () => {
    const { db, memory } = setup();
    const first = await registerRelease(db, { imageRepo: REPO, version: "1.0.0", digest: DIGEST, actor: "ops:test" });
    const again = await registerRelease(db, { imageRepo: REPO, version: "1.0.0", digest: DIGEST, actor: "ops:test" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.release.id).toBe(first.release.id);
    expect(first.release).toMatchObject({ channel: "canary", rollout_percent: 0, promoted_at: null, halted: false });
    expect(memory.tables.hermes_releases).toHaveLength(1);
    expect(memory.tables.hermes_release_events.map((e) => e.kind)).toEqual(["registered"]);
  });

  it("rejects a malformed digest", async () => {
    const { db } = setup();
    await expect(registerRelease(db, { imageRepo: REPO, version: "1", digest: "latest", actor: "a" })).rejects.toBeInstanceOf(ReleaseStoreError);
  });
});

describe("promoteRelease", () => {
  it("walks the ladder one rung at a time and records each step", async () => {
    const { db, memory } = setup();
    const release = await register(db);
    await expect(promoteRelease(db, release.id, { to: "pilot", pilotInstanceId: PILOT, actor: "ops:test" })).rejects.toThrow(/one stage at a time/);

    expect(await promoteRelease(db, release.id, { to: "canary", actor: "ops:test" })).toMatchObject({ channel: "canary" });
    expect(await promoteRelease(db, release.id, { to: "pilot", pilotInstanceId: PILOT, actor: "ops:test" })).toMatchObject({ channel: "stable", rollout_percent: 0, pilot_instance_ids: [PILOT] });
    expect(await promoteRelease(db, release.id, { to: "ten_percent", actor: "ops:test" })).toMatchObject({ rollout_percent: 10 });
    expect(await promoteRelease(db, release.id, { to: "full", actor: "ops:test" })).toMatchObject({ rollout_percent: 100 });
    expect(memory.tables.hermes_release_events.filter((e) => e.kind === "promoted").map((e) => e.detail)).toEqual([
      "registered -> canary",
      "canary -> pilot",
      "pilot -> ten_percent",
      "ten_percent -> full",
    ]);
  });

  it("refuses a halted release until it is unhalted", async () => {
    const { db } = setup();
    const release = await register(db);
    await haltRelease(db, release.id, { reason: "bad build", actor: "ops:test" });
    await expect(promoteRelease(db, release.id, { to: "canary", actor: "ops:test" })).rejects.toMatchObject({ status: 409 });
    await unhaltRelease(db, release.id, { actor: "ops:test" });
    expect(await promoteRelease(db, release.id, { to: "canary", actor: "ops:test" })).toMatchObject({ halted: false });
  });
});

describe("recordBoxOutcome", () => {
  const BOX_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const BOX_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("halts a release on the first failure at the canary or pilot stage", async () => {
    const { db } = setup();
    const release = await register(db);
    await promoteRelease(db, release.id, { to: "canary", actor: "ops:test" });

    const outcome = await recordBoxOutcome(db, { instanceId: BOX_A, kind: "rolled_back", targetDigest: DIGEST, detail: "unhealthy" });
    expect(outcome).toEqual({ releaseId: release.id, halted: true });
    const [stored] = await loadReleases(db, REPO);
    expect(stored).toMatchObject({ halted: true, halted_by: "auto" });
    expect(stored.halted_reason).toMatch(/Auto-halted/);
  });

  it("does not halt on a success, or on a failure that names no release", async () => {
    const { db } = setup();
    const release = await register(db);
    await promoteRelease(db, release.id, { to: "canary", actor: "ops:test" });
    expect((await recordBoxOutcome(db, { instanceId: BOX_A, kind: "updated", targetDigest: DIGEST })).halted).toBe(false);
    expect((await recordBoxOutcome(db, { instanceId: BOX_B, kind: "failed", targetDigest: null, detail: "disk full" })).halted).toBe(false);
    expect((await loadReleases(db, REPO))[0].halted).toBe(false);
  });

  it("counts each box once, by its latest outcome", async () => {
    const { db } = setup();
    const release = await register(db);
    // 9 healthy boxes and one that failed then recovered: no halt.
    for (let i = 0; i < 9; i += 1) {
      await recordBoxOutcome(db, { instanceId: `00000000-0000-4000-8000-00000000000${i}`, kind: "updated", targetDigest: DIGEST });
    }
    await recordBoxOutcome(db, { instanceId: BOX_A, kind: "failed", targetDigest: DIGEST });
    expect((await loadReleases(db, REPO))[0].halted).toBe(false);
    await recordBoxOutcome(db, { instanceId: BOX_A, kind: "updated", targetDigest: DIGEST });
    expect(release.id).toBeTruthy();
    expect((await loadReleases(db, REPO))[0].halted).toBe(false);
  });
});
