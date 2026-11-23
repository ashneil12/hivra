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
// The failed-report legacy correlation resolves the release a NEW update
// would pin. These tests exercise the report contract, not the registry
// read — the ungoverned answer keeps every legacy case on the write-time
// bounds, and attempt-stamped reports never read it at all.
jest.mock("@/lib/hermes-releases/live-update", () => ({
  resolveUpdateImagePolicy: jest.fn(async () => ({ policy: undefined, state: null })),
}));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.current;
  },
}));

import { reportOpsEvent } from "@/lib/ops-events";
import { resolveUpdateImagePolicy } from "@/lib/hermes-releases/live-update";

const INSTANCE = "22222222-2222-4222-8222-222222222222";
const REPO = "ghcr.io/example/agent";
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

// The memory db has no `not()` filter; the route's terminal-status guard is
// not what these tests exercise, so make it a pass-through.
function withNot<T extends Record<string, unknown>>(query: T): T {
  (query as Record<string, unknown>).not = () => query;
  return query;
}

function setup(
  releaseOverrides: Record<string, unknown> = {},
  instanceOverrides: Record<string, unknown> = {},
) {
  const memory = createSupabaseMemoryDb({
    tables: ["hermes_instances", "hermes_releases", "hermes_release_events"],
    seed: {
      hermes_instances: [
        { id: INSTANCE, user_id: "user-1", api_server_key_encrypted: "secret", status: "redeploying", deleted_at: null, ...instanceOverrides },
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
      // A failed report on a 'redeploying' row stamps the launch-failure shape
      // so the fleet-sync sweep re-admits it for a release retry.
      status: "failed",
      lifecycle_substate: "live_update_failed_vm_reached",
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

  it("stamps the failed state for the attempt the report names, even when the registry repinned mid-attempt", async () => {
    // The failed attempt targeted D1 while the registry has since moved its
    // pin to D2. With an attempt stamp (`a`) the write predicate itself is
    // the correlation — the registry is never read — so the valid D1
    // failure lands its stamp instead of being mistaken for a stale report
    // and the row is not left stranded at 'redeploying'.
    const attempt = "2026-04-23T06:00:00.000Z";
    const memory = setup({}, { last_lifecycle_transition_at: attempt });
    (resolveUpdateImagePolicy as jest.Mock).mockResolvedValue({
      policy: { kind: "pinned", ref: `${REPO}@${D2}`, digest: D2 },
      state: { governed: true },
    });

    const res = await report(`s=failed&t=manual&r=pull_failed&ti=${D1}&a=${attempt}`);

    expect(res.status).toBe(200);
    expect(resolveUpdateImagePolicy).not.toHaveBeenCalled();
    expect(memory.tables.hermes_instances[0]).toMatchObject({
      status: "failed",
      lifecycle_substate: "live_update_failed_vm_reached",
    });
  });

  it("does not let a delayed report from a superseded attempt stamp a newer attempt's row", async () => {
    // Attempt A targeted D1 and its report was delayed; attempt B has since
    // stamped the row for a retry toward the SAME digest. The older
    // report's `a` names A's transition stamp, which no longer matches the
    // row — so the failed stamp is refused even though the digest check
    // alone could not tell the two attempts apart. The report itself is
    // still durably recorded (release event + ops event), only the stamp
    // is refused.
    const attemptA = "2026-04-23T06:00:00.000Z";
    const attemptB = "2026-04-24T09:30:00.000Z";
    const memory = setup({}, { last_lifecycle_transition_at: attemptB });

    const res = await report(`s=failed&t=manual&r=pull_failed&ti=${D1}&a=${attemptA}`);

    expect(res.status).toBe(200);
    expect(memory.tables.hermes_instances[0]).toMatchObject({
      status: "redeploying",
      last_lifecycle_transition_at: attemptB,
    });
    expect(memory.tables.hermes_instances[0].lifecycle_state).not.toBe("failed");
    expect(memory.tables.hermes_release_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "failed", release_id: "rel-1", instance_id: INSTANCE }),
      ])
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-update-status",
        title: "Manual update failed",
        metadata: expect.objectContaining({ attemptStamp: attemptA }),
      })
    );
  });

  it("correlates an unstamped failure against the pre-report row — a report that stores the target digest still stamps", async () => {
    // Regression: recordReleaseReport stores the report's `i` digest into
    // agent_image_digest, and the legacy (no `a`) correlation resolved the
    // in-flight target AFTER that write. A failure reporting the target as
    // its running digest — the update applied, then the wrapper failed —
    // made the resolver read the just-stored digest as the box's current
    // image: "already on target" → keep → stale → the failed stamp was
    // skipped and the row stranded at 'redeploying' forever. The
    // correlation must see the row as it was when the report arrived.
    const D0 = `sha256:${"0".repeat(64)}`;
    const memory = setup({}, { agent_image_digest: D0 });
    let digestSeenByCorrelation: unknown;
    (resolveUpdateImagePolicy as jest.Mock).mockImplementation(async () => {
      // Stand-in for decideUpdate over the CURRENT stored digest: the
      // registry still pins D2, but a box whose stored digest already IS
      // D2 resolves keep — exactly the verdict the poisoned read produced.
      digestSeenByCorrelation = memory.tables.hermes_instances[0].agent_image_digest;
      return digestSeenByCorrelation === D2
        ? { policy: { kind: "keep" }, state: { governed: true } }
        : { policy: { kind: "pinned", ref: `${REPO}@${D2}`, digest: D2 }, state: { governed: true } };
    });

    const res = await report(`s=failed&t=manual&r=verify_failed&i=${D2}&ti=${D2}`);

    expect(res.status).toBe(200);
    // The correlation read the row BEFORE this report's own digest landed.
    expect(digestSeenByCorrelation).toBe(D0);
    // So the valid failure still stamped — while the report's own fields
    // were recorded all the same.
    expect(memory.tables.hermes_instances[0]).toMatchObject({
      status: "failed",
      lifecycle_substate: "live_update_failed_vm_reached",
      agent_image_digest: D2,
    });
  });

  it("does not let a delayed success report from a superseded attempt mark a newer attempt's row running", async () => {
    // Attempt A succeeded on the box but its report was delayed past the
    // launch of attempt B toward the same digest. Writing 'running' for
    // the stale report would misstate the in-flight attempt AND block B's
    // own failed-report stamp (it predicates on 'redeploying'). The `a`
    // mismatch refuses the write; the report itself is still recorded.
    const attemptA = "2026-04-23T06:00:00.000Z";
    const attemptB = "2026-04-24T09:30:00.000Z";
    const memory = setup({}, { last_lifecycle_transition_at: attemptB });

    const res = await report(`s=succeeded&t=manual&r=completed&i=${D1}&k=updated&a=${attemptA}`);

    expect(res.status).toBe(200);
    expect(memory.tables.hermes_instances[0]).toMatchObject({
      status: "redeploying",
      last_lifecycle_transition_at: attemptB,
      // The report's own fields still landed — only the status stamp is
      // attempt-gated.
      update_health: "ok",
      agent_image_digest: D1,
    });
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-update-status",
        title: "Manual update succeeded",
      })
    );
  });
});
