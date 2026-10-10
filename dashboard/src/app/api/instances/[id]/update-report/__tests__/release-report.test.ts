import { NextRequest } from "next/server";

import { createSupabaseMemoryDb } from "@/test-utils/supabase-memory-db";

import { GET } from "../route";

const mockDb: { current: unknown } = { current: null };

jest.mock("@/lib/crypto", () => ({ decryptApiKey: jest.fn((value: string) => value) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue({}),
}));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.current;
  },
}));

import { reportOpsEvent } from "@/lib/ops-events";

const INSTANCE = "inst-1";
const REPO = "ghcr.io/example/agent";
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

// The memory db has no `not()` filter; the route's terminal-status guard is
// not what these tests exercise, so make it a pass-through.
function withNot<T extends Record<string, unknown>>(query: T): T {
  (query as Record<string, unknown>).not = () => query;
  return query;
}

function setup(releaseOverrides: Record<string, unknown> = {}) {
  const memory = createSupabaseMemoryDb({
    tables: ["hermes_instances", "hermes_releases", "hermes_release_events"],
    seed: {
      hermes_instances: [
        { id: INSTANCE, user_id: "user-1", api_server_key_encrypted: "secret", status: "redeploying", deleted_at: null },
      ],
      hermes_releases: [
        { id: "rel-1", image_repo: REPO, version: "1.0.1", digest: D1, channel: "stable", rollout_percent: 100, pilot_instance_ids: [], halted: false, promoted_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", ...releaseOverrides },
        { id: "rel-2", image_repo: REPO, version: "1.0.2", digest: D2, channel: "canary", rollout_percent: 0, pilot_instance_ids: [], halted: false, promoted_at: "2026-10-02T00:00:00Z", created_at: "2026-10-02T00:00:00Z" },
      ],
    },
  });
  mockDb.current = {
    from: (table: string) => {
      const t = memory.db.from(table);
      return {
        select: () => withNot(t.select() as Record<string, unknown>),
        insert: t.insert,
        update: (patch: Record<string, unknown>) => withNot(t.update(patch) as Record<string, unknown>),
      };
    },
  };
  return memory;
}

function report(query: string) {
  return GET(
    new NextRequest(`http://localhost/api/u/${INSTANCE}?${query}`, { headers: { authorization: "Bearer secret" } }),
    { params: Promise.resolve({ id: INSTANCE }) }
  );
}

describe("update-report release fields", () => {
  beforeEach(() => jest.clearAllMocks());

  it("records the digest, version and healthy stack after a successful update", async () => {
    const memory = setup();
    const res = await report(`s=succeeded&t=manual&r=completed&i=${D1}&ti=${D1}&k=updated&sv=2`);
    expect(res.status).toBe(200);
    expect(memory.tables.hermes_instances[0]).toMatchObject({
      agent_image_digest: D1,
      agent_release_id: "rel-1",
      agent_version: "1.0.1",
      update_stack_version: 2,
      update_health: "ok",
      update_health_detail: null,
      status: "running",
    });
    expect(memory.tables.hermes_release_events).toHaveLength(1);
    expect(memory.tables.hermes_release_events[0]).toMatchObject({ kind: "updated", release_id: "rel-1", instance_id: INSTANCE });
  });

  it("keeps the old digest on a rollback, surfaces it, and halts the failed release", async () => {
    const memory = setup();
    const res = await report(`s=failed&t=scheduled&r=unhealthy_after_roll&i=${D1}&ti=${D2}&k=rolled_back&sv=2`);
    expect(res.status).toBe(200);
    expect(memory.tables.hermes_instances[0]).toMatchObject({
      agent_image_digest: D1,
      agent_version: "1.0.1",
      update_health: "rolled_back",
      update_health_detail: "unhealthy_after_roll",
      status: "redeploying", // a failed report never flips status
    });
    // rel-2 was at the canary stage, so one failed box halts it.
    expect(memory.tables.hermes_releases.find((r) => r.id === "rel-2")).toMatchObject({ halted: true, halted_by: "auto" });
    expect(reportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({ source: "hermes-release-auto-halt" }));
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "instance-update-status", title: "Update rolled back", severity: "error" })
    );
  });

  it("never blames the release the box rolled back TO when the report names no target", async () => {
    // Seen on a real box: the rollback report carried the digest now running but no
    // target, and the release the box was safely back on was the one that got halted.
    const memory = setup();
    await report(`s=failed&t=manual&r=update+script+exited&i=${D1}&k=rolled_back`);
    expect(memory.tables.hermes_instances[0]).toMatchObject({ update_health: "rolled_back", agent_image_digest: D1 });
    expect(memory.tables.hermes_releases.every((r) => r.halted === false)).toBe(true);
    expect(memory.tables.hermes_release_events[0]).toMatchObject({ kind: "rolled_back", release_id: null });
  });

  it("still blames the digest a successful update moved the box to", async () => {
    const memory = setup();
    await report(`s=succeeded&t=manual&r=completed&i=${D1}&k=updated`);
    expect(memory.tables.hermes_release_events[0]).toMatchObject({ kind: "updated", release_id: "rel-1" });
  });

  it("surfaces a paused roller on the box without judging any release", async () => {
    const memory = setup();
    await report(`s=failed&t=scheduled&r=auto_roll_paused&k=paused&sv=2`);
    expect(memory.tables.hermes_instances[0]).toMatchObject({ update_health: "paused", update_health_detail: "auto_roll_paused" });
    expect(memory.tables.hermes_releases.every((r) => r.halted === false)).toBe(true);
  });

  it("ignores malformed digests and kinds, keeping the legacy behaviour", async () => {
    const memory = setup();
    const res = await report(`s=succeeded&t=manual&r=completed&i=not-a-digest&ti=nope&k=exploded&sv=999`);
    expect(res.status).toBe(200);
    expect(memory.tables.hermes_instances[0]).toMatchObject({ status: "running" });
    expect(memory.tables.hermes_instances[0].agent_image_digest).toBeUndefined();
    expect(memory.tables.hermes_instances[0].update_health).toBeUndefined();
    expect(memory.tables.hermes_release_events).toHaveLength(0);
  });

  it("rejects a report without the box's bearer", async () => {
    setup();
    const res = await GET(new NextRequest(`http://localhost/api/u/${INSTANCE}?s=succeeded&t=manual&k=updated`), {
      params: Promise.resolve({ id: INSTANCE }),
    });
    expect(res.status).toBe(401);
  });
});
