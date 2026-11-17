import {
  accessLogCollectionEnabled, accessLogViewEnabled, agentAt, bucketAccessEvents, buildAccessDrainScript,
  parseAccessDrainOutput, runAccessLogCollection, type AgentCandidate,
} from "../computer-access-log";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  isProxmoxProvisioningConfigured: () => true,
  resolveProxmoxTargetConfiguration: (_env: unknown, id: string) => ({ env: { HOST: id } }),
}));

const event = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq, at: 1795000000 + seq, vmid: 2104, channel: "command", actor_class: "system", actor_label: "Hivra's systems (automatic)", program: "bash", ...extra,
});
const out = (events: unknown[], end: Record<string, unknown>) =>
  [...events.map((e) => `HIVRA_ACCESS_V1 ${JSON.stringify(e)}`), `HIVRA_ACCESS_END ${JSON.stringify(end)}`].join("\n");

describe("switches", () => {
  it("are off unless set exactly", () => {
    expect(accessLogViewEnabled({})).toBe(false);
    expect(accessLogViewEnabled({ NEXT_PUBLIC_HIVRA_ACCESS_LOG: "true" })).toBe(true);
    expect(accessLogCollectionEnabled({ HIVRA_ACCESS_LOG_COLLECTION: "yes" })).toBe(false);
    expect(accessLogCollectionEnabled({ HIVRA_ACCESS_LOG_COLLECTION: " ON " })).toBe(true);
  });
});

describe("buildAccessDrainScript", () => {
  it("says so when the host has no recorder, and refuses a bad cursor", () => {
    expect(buildAccessDrainScript(5)).toContain("/usr/local/sbin/hivra-guest-access-audit --drain 5 2000");
    expect(buildAccessDrainScript(5)).toContain('{"installed":false}');
    expect(() => buildAccessDrainScript(-1)).toThrow();
    expect(() => buildAccessDrainScript(1.5)).toThrow();
  });
});

describe("parseAccessDrainOutput", () => {
  it("keeps well-formed events and counts the rest", () => {
    const parsed = parseAccessDrainOutput(out(
      [event(1), event(2, { channel: "teleport" }), event(3, { program: "$(rm)" }), event(4, { actor_class: "root" })],
      { installed: true, last_seq: 4, more: false, head_seq: 4 },
    ));
    expect(parsed?.events.map((e) => [e.seq, e.program])).toEqual([[1, "bash"], [3, null]]);
    expect(parsed?.rejected).toBe(2);
    expect(parsed?.lastSeq).toBe(4);
  });

  it("is null for a run that never finished, and not-installed when the host has no recorder", () => {
    expect(parseAccessDrainOutput(`HIVRA_ACCESS_V1 ${JSON.stringify(event(1))}`)).toBeNull();
    expect(parseAccessDrainOutput('HIVRA_ACCESS_END {"installed":false}')).toMatchObject({ installed: false, events: [] });
  });
});

describe("agentAt", () => {
  const candidates: AgentCandidate[] = [
    { id: "old", user_id: "u1", vmid: 2104, proxmox_host: "host-a", status: "deleted", created_at: "2026-01-01T00:00:00Z" },
    { id: "new", user_id: "u2", vmid: 2104, proxmox_host: "host-a", status: "running", created_at: "2026-11-17T00:00:00Z" },
    { id: "other-host", user_id: "u3", vmid: 2104, proxmox_host: "host-b", status: "running", created_at: "2026-11-10T00:00:00Z" },
  ];

  it("picks the computer that held this VMID on this host at that moment", () => {
    expect(agentAt(candidates, "host-a", 2104, Date.parse("2026-11-18T00:00:00Z") / 1000)?.id).toBe("new");
    expect(agentAt(candidates, "host-a", 2104, Date.parse("2026-06-01T00:00:00Z") / 1000)?.id).toBe("old");
    expect(agentAt(candidates, "HOST-B", 2104, Date.parse("2026-11-18T00:00:00Z") / 1000)?.id).toBe("other-host");
    expect(agentAt(candidates, "host-c", 2104, Date.parse("2026-11-18T00:00:00Z") / 1000)).toBeNull();
  });
});

describe("bucketAccessEvents", () => {
  it("counts per hour, who and channel, and merges program names", () => {
    const parsed = parseAccessDrainOutput(out(
      [event(1), event(2, { program: "cat" }), event(3, { at: 1795000000 + 3600 }), event(4, { actor_class: "staff", actor_label: "Hivra staff", channel: "ssh", program: null })],
      { installed: true, last_seq: 4 },
    ))!;
    const buckets = bucketAccessEvents("host-a", parsed.events, [
      { id: "a1", user_id: "u1", vmid: 2104, proxmox_host: "host-a", status: "running", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toMatchObject({ agent_id: "a1", user_id: "u1", count: 2, programs: ["bash", "cat"], channel: "command", actor_class: "system" });
    expect(buckets[2]).toMatchObject({ actor_class: "staff", channel: "ssh", count: 1, programs: [] });
  });
});

describe("runAccessLogCollection", () => {
  function fakeDb(cursor: number | null) {
    const calls: Array<{ table: string; op: string; value?: unknown }> = [];
    const rpc = jest.fn(async () => ({ error: null }));
    const chain = (table: string) => {
      const q: Record<string, unknown> = {};
      const result = () => {
        if (table === "proxmox_hosts") return { data: [{ id: "host-a" }], error: null };
        if (table === "hivra_access_log_cursors") return { data: cursor === null ? null : { last_seq: cursor }, error: null };
        if (table === "hivra_agents") return { data: [{ id: "a1", user_id: "u1", vmid: 2104, proxmox_host: "host-a", status: "running", created_at: "2026-01-01T00:00:00Z" }], error: null };
        return { data: null, error: null, count: 0 };
      };
      for (const m of ["select", "eq", "in", "lt", "order", "limit", "gte"]) q[m] = () => q;
      q.maybeSingle = async () => result();
      q.then = (resolve: (v: unknown) => unknown) => resolve(result());
      q.upsert = async (value: unknown) => { calls.push({ table, op: "upsert", value }); return { error: null }; };
      q.delete = () => { calls.push({ table, op: "delete" }); return q; };
      return q;
    };
    return { db: { from: chain, rpc }, calls, rpc };
  }

  it("does nothing while the switch is off", async () => {
    expect(await runAccessLogCollection({ env: {}, db: fakeDb(0).db })).toMatchObject({ skipped: true, reason: "flag_off" });
  });

  it("stores new events, then moves the host's cursor", async () => {
    const fake = fakeDb(1);
    const runHostScript = jest.fn(async (_script: string, _env?: unknown, _opts?: unknown) => ({ ok: true, stdout: out([event(1), event(2), event(3)], { installed: true, last_seq: 3, more: false, head_seq: 3 }), stderr: "" }));
    const summary = await runAccessLogCollection({ env: { HIVRA_ACCESS_LOG_COLLECTION: "on" }, db: fake.db, runHostScript: runHostScript as never });
    expect(runHostScript.mock.calls[0][0]).toContain("--drain 1 2000");
    expect(summary).toMatchObject({ hosts: 1, events: 2, buckets: 1, errors: 0 });
    expect(fake.rpc).toHaveBeenCalledWith("hivra_record_computer_access", { entries: [expect.objectContaining({ agent_id: "a1", count: 2 })] });
    expect(fake.calls).toContainEqual(expect.objectContaining({ table: "hivra_access_log_cursors", op: "upsert", value: expect.objectContaining({ last_seq: 3 }) }));
  });

  it("keeps the cursor when storing fails, so the same lines are read again", async () => {
    const fake = fakeDb(0);
    fake.rpc.mockResolvedValueOnce({ error: { message: "boom" } } as never);
    const runHostScript = jest.fn(async (_script: string, _env?: unknown, _opts?: unknown) => ({ ok: true, stdout: out([event(1)], { installed: true, last_seq: 1, head_seq: 1 }), stderr: "" }));
    const summary = await runAccessLogCollection({ env: { HIVRA_ACCESS_LOG_COLLECTION: "on" }, db: fake.db, runHostScript: runHostScript as never });
    expect(summary.errors).toBe(1);
    expect(fake.calls.filter((c) => c.table === "hivra_access_log_cursors")).toEqual([]);
  });

  it("lists hosts without the recorder", async () => {
    const fake = fakeDb(null);
    const runHostScript = jest.fn(async (_script: string, _env?: unknown, _opts?: unknown) => ({ ok: true, stdout: 'HIVRA_ACCESS_END {"installed":false}', stderr: "" }));
    const summary = await runAccessLogCollection({ env: { HIVRA_ACCESS_LOG_COLLECTION: "on" }, db: fake.db, runHostScript: runHostScript as never });
    expect(summary.notInstalled).toEqual(["host-a"]);
    expect(fake.calls.filter((c) => c.table === "hivra_access_log_cursors")).toEqual([]);
  });
});
