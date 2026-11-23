import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseReencryptResult,
  resolveReencryptSweep,
  runReencryptSweep,
} from "../cold-archive-reencrypt";
import type { HostScriptResult } from "../proxmox-instance-service";

jest.mock("../proxmox-instance-service", () => {
  const actual = jest.requireActual("../proxmox-instance-service");
  return {
    ...actual,
    resolveProxmoxHostEnv: (_r: unknown, base: NodeJS.ProcessEnv) => base,
    runProxmoxHostScript: jest.fn(),
  };
});

const RECIPIENT = `age1${"q".repeat(58)}`;
const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";
const sha = (c: string) => c.repeat(64);
const uriFor = (id: string) => `free/${id}/data-20260101T000000Z.tar.zst`;

describe("resolveReencryptSweep (switch states)", () => {
  const base = { HERMES_BACKUP_ENCRYPTION: "on", HERMES_BACKUP_AGE_RECIPIENT: RECIPIENT };
  it.each([[undefined], [""], ["off"], ["OFF"]])("%p is off", (v) => {
    expect(resolveReencryptSweep({ ...base, HERMES_BACKUP_REENCRYPT_SWEEP: v })).toEqual({ mode: "off" });
  });
  it("off even without encryption configured", () => {
    expect(resolveReencryptSweep({})).toEqual({ mode: "off" });
  });
  it.each([["dry"], ["on"], [" On "]])("%p resolves with the recipient", (v) => {
    expect(resolveReencryptSweep({ ...base, HERMES_BACKUP_REENCRYPT_SWEEP: v })).toEqual({
      mode: v.trim().toLowerCase(),
      recipient: RECIPIENT,
    });
  });
  it("an unrecognised value is an error, never on", () => {
    expect(resolveReencryptSweep({ ...base, HERMES_BACKUP_REENCRYPT_SWEEP: "yes" }).mode).toBe("error");
  });
  it("requires HERMES_BACKUP_ENCRYPTION on", () => {
    const r = resolveReencryptSweep({ HERMES_BACKUP_REENCRYPT_SWEEP: "on", HERMES_BACKUP_AGE_RECIPIENT: RECIPIENT });
    expect(r.mode).toBe("error");
  });
  it.each([[""], ["age1nope"]])("requires a valid recipient (%p)", (rec) => {
    const r = resolveReencryptSweep({
      HERMES_BACKUP_REENCRYPT_SWEEP: "dry",
      HERMES_BACKUP_ENCRYPTION: "on",
      HERMES_BACKUP_AGE_RECIPIENT: rec,
    });
    expect(r.mode).toBe("error");
  });
});

describe("parseReencryptResult", () => {
  it("parses the last REENCRYPT_RESULT line", () => {
    const m = parseReencryptResult("noise\nREENCRYPT_RESULT plain=a enc=b enc_sha256=c enc_size=3\n");
    expect(m?.get("enc")).toBe("b");
    expect(m?.get("enc_size")).toBe("3");
  });
  it("returns null without one", () => expect(parseReencryptResult("nothing")).toBeNull());
});

type Row = {
  id: string;
  lifecycle_state: string;
  lifecycle_substate: string | null;
  last_lifecycle_transition_at: string | null;
  archive_uri: string;
  archive_sha256: string;
  archive_size_bytes: number;
};

/** In-memory hermes_instances that honours the filters the service applies. */
function fakeSupabase(rows: Row[], opts: { casError?: string; mutateBeforeCas?: (r: Row[]) => void } = {}) {
  const log: Array<{ op: string; table: string; payload?: unknown; filters: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let op = "select";
    let payload: unknown;
    const after: string | null = null;
    let limit = 1000;
    const matches = (r: Row) =>
      Object.entries(filters).every(([k, v]) => {
        if (k === "archive_uri:notlike") return !r.archive_uri.endsWith(".age");
        if (k === "id:gt") return r.id > (v as string);
        return (r as unknown as Record<string, unknown>)[k] === v;
      });
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.update = (p: unknown) => { op = "update"; payload = p; return b; };
    b.eq = (k: string, v: unknown) => { filters[k] = v; return b; };
    b.not = (k: string, o: string, v: unknown) => { if (o === "like") filters[`${k}:notlike`] = v; return b; };
    b.is = (k: string, v: unknown) => { if (k === "lifecycle_substate") filters[k] = v; return b; };
    b.gt = (k: string, v: unknown) => { filters[`${k}:gt`] = v; return b; };
    b.order = () => b;
    b.limit = (n: number) => { limit = n; return b; };
    b.maybeSingle = async () => {
      log.push({ op, table, payload, filters: { ...filters } });
      if (op === "update") {
        if (typeof payload === "object" && payload !== null && "archive_uri" in payload) {
          opts.mutateBeforeCas?.(rows);
          if (opts.casError) return { data: null, error: { message: opts.casError } };
        }
        const hit = rows.find(matches);
        if (hit) Object.assign(hit, payload);
        return { data: hit ? { id: hit.id } : null, error: null };
      }
      const hit = rows.find(matches);
      return { data: hit ? { ...hit } : null, error: null };
    };
    // list query (awaited directly)
    b.then = (resolve: (v: unknown) => void) => {
      log.push({ op, table, filters: { ...filters } });
      void after;
      resolve({ data: rows.filter(matches).sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, limit), error: null });
    };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, log };
}

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, lifecycle_state: "cold_archived", lifecycle_substate: null, last_lifecycle_transition_at: null,
  archive_uri: uriFor(id), archive_sha256: sha("a"), archive_size_bytes: 10, ...over,
});
const resultStdout = (id: string, over: Record<string, string> = {}) => {
  const f = { plain: uriFor(id), enc: `${uriFor(id)}.age`, enc_sha256: sha("e"), enc_size: "42", plain_sha256: sha("a"), plain_deleted: "0", manifest: "m", resumed: "0", ...over };
  return `REENCRYPT_RESULT ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ")}\n`;
};
const ok = (stdout = ""): HostScriptResult => ({ ok: true, stdout, stderr: "" }) as HostScriptResult;
const sweepOn = { mode: "on" as const, recipient: RECIPIENT };

describe("runReencryptSweep", () => {
  it("dry mode reports candidates and never contacts the host or writes", async () => {
    const { client, log } = fakeSupabase([row(ID_A), row(ID_B, { archive_uri: `${uriFor(ID_B)}.age` })]);
    const runHostScript = jest.fn();
    const r = await runReencryptSweep(client, { mode: "dry", recipient: RECIPIENT }, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes).toEqual([{ instanceId: ID_A, status: "would_reencrypt", archiveUri: uriFor(ID_A) }]);
    expect(runHostScript).not.toHaveBeenCalled();
    expect(log.some((l) => l.op === "update")).toBe(false);
  });

  it("on: keeps plain, then CAS-updates the row on the old uri, then deletes plain", async () => {
    const rows = [row(ID_A)];
    const { client, log } = fakeSupabase(rows);
    const calls: string[] = [];
    const runHostScript = jest.fn(async (script: string) => {
      calls.push(script);
      return ok(script.includes("--apply") ? resultStdout(ID_A) : "");
    });
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0]).toMatchObject({ status: "reencrypted", newUri: `${uriFor(ID_A)}.age`, encSizeBytes: 42, plainDeleted: true });
    expect(rows[0]).toMatchObject({
      archive_uri: `${uriFor(ID_A)}.age`, archive_sha256: sha("e"), archive_size_bytes: 42, lifecycle_substate: null,
    });

    const [claim, update] = log.filter((entry) => entry.op === "update");
    expect(claim.filters).toMatchObject({
      id: ID_A, archive_uri: uriFor(ID_A), archive_sha256: sha("a"), lifecycle_state: "cold_archived", lifecycle_substate: null,
    });
    expect(claim.payload).toMatchObject({ lifecycle_substate: "cold_archive_reencrypt" });
    expect(update.filters).toMatchObject({
      id: ID_A, archive_uri: uriFor(ID_A), lifecycle_state: "cold_archived", lifecycle_substate: "cold_archive_reencrypt",
    });
    // order: apply --keep-plain (recipient on argv, never a secret) -> DB update -> delete-plain
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--apply --keep-plain");
    expect(calls[0]).toContain(`HERMES_BACKUP_AGE_RECIPIENT=${RECIPIENT}`);
    expect(calls[0]).not.toContain("--delete-plain");
    expect(calls[1]).toContain("--delete-plain");
    expect(calls[1]).toContain(`--enc-sha256=${sha("e")}`);
    expect(calls.join("")).not.toContain("AGE-SECRET-KEY");
  });

  it("does not clobber a row a restore moved meanwhile: CAS loses, plain is never deleted", async () => {
    const rows = [row(ID_A)];
    const { client } = fakeSupabase(rows, { mutateBeforeCas: (rs) => { rs[0].lifecycle_state = "restoring"; } });
    const runHostScript = jest.fn(async (script: string) => ok(script.includes("--apply") ? resultStdout(ID_A) : ""));
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0].status).toBe("cas_lost");
    expect(rows[0].archive_uri).toBe(uriFor(ID_A));
    expect(runHostScript).toHaveBeenCalledTimes(1); // no delete-plain
  });

  it("does not update on a re-archive that changed the uri", async () => {
    const rows = [row(ID_A)];
    const { client } = fakeSupabase(rows, { mutateBeforeCas: (rs) => { rs[0].archive_uri = `free/${ID_A}/data-20260202T000000Z.tar.zst`; } });
    const runHostScript = jest.fn(async (s: string) => ok(s.includes("--apply") ? resultStdout(ID_A) : ""));
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0].status).toBe("cas_lost");
    expect(rows[0].archive_uri).toBe(`free/${ID_A}/data-20260202T000000Z.tar.zst`);
    expect(runHostScript).toHaveBeenCalledTimes(1);
  });

  it("a DB error keeps the plain copy (no delete-plain)", async () => {
    const { client } = fakeSupabase([row(ID_A)], { casError: "boom" });
    const runHostScript = jest.fn(async (s: string) => ok(s.includes("--apply") ? resultStdout(ID_A) : ""));
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0].status).toBe("db_update_failed");
    expect(runHostScript).toHaveBeenCalledTimes(1);
  });

  it("skips busy instances (restoring/archiving) and never runs the script for them", async () => {
    // The page query only selects cold_archived. The claim skips any row that changed.
    const rows = [row(ID_A), row(ID_B)];
    const { client } = fakeSupabase(rows);
    const runHostScript = jest.fn(async (s: string) => ok(s.includes("--apply") ? resultStdout(ID_B) : ""));
    // flip A to restoring after listing, before processing: simulate via a deps hook on first script call
    const origFrom = client.from.bind(client);
    let listed = false;
    (client as unknown as { from: typeof origFrom }).from = ((t: string) => {
      const b = origFrom(t) as unknown as { then?: unknown };
      const origThen = b.then as (r: (v: unknown) => void) => void;
      b.then = (resolve: (v: unknown) => void) => origThen((v) => { if (!listed) { listed = true; rows[0].lifecycle_state = "restoring"; } resolve(v); });
      return b as never;
    }) as never;
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0]).toMatchObject({ instanceId: ID_A, status: "skipped_busy" });
    expect(runHostScript.mock.calls.every((c) => !(c[0] as string).includes(uriFor(ID_A)))).toBe(true);
  });

  it("keeps a claim if transport failed before confirming that the host writer exited", async () => {
    const rows = [row(ID_A)];
    const { client } = fakeSupabase(rows);
    const runHostScript = jest.fn(async () => ({ ok: false, stdout: "", stderr: "exit 6" }) as HostScriptResult);
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0]).toMatchObject({ status: "host_script_failed", message: expect.stringContaining("claim retained") });
    expect(rows[0]).toMatchObject({ archive_uri: uriFor(ID_A), lifecycle_substate: "cold_archive_reencrypt" });
  });

  it("releases its claim if the remote writer explicitly reports that it stopped", async () => {
    const rows = [row(ID_A)];
    const { client } = fakeSupabase(rows);
    const runHostScript = jest.fn(async () => ({
      ok: false,
      stdout: "HERMES_COLD_REENCRYPT_WRITER_EXITED\n",
      stderr: "exit 6",
    }));
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0].status).toBe("host_script_failed");
    expect(rows[0]).toMatchObject({ archive_uri: uriFor(ID_A), lifecycle_substate: null });
  });

  it("does not start a second writer while an earlier writer claim remains", async () => {
    const { client } = fakeSupabase([row(ID_A, { lifecycle_substate: "cold_archive_reencrypt" })]);
    const runHostScript = jest.fn();
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0].status).toBe("skipped_busy");
    expect(runHostScript).not.toHaveBeenCalled();
  });

  it.each([
    ["missing line", ""],
    ["wrong enc path", resultStdout(ID_A, { enc: "free/x/y.age" })],
    ["plain already deleted", resultStdout(ID_A, { plain_deleted: "1" })],
    ["bad sha", resultStdout(ID_A, { enc_sha256: "zz" })],
    ["zero size", resultStdout(ID_A, { enc_size: "0" })],
  ])("an inconsistent script result (%s) preserves the plain archive pointer", async (_n, stdout) => {
    const rows = [row(ID_A)];
    const { client } = fakeSupabase(rows);
    const runHostScript = jest.fn(async () => ok(stdout));
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0].status).toBe("bad_result");
    expect(rows[0]).toMatchObject({ archive_uri: uriFor(ID_A), lifecycle_substate: null });
  });

  it("reports plainDeleted=false when the second step fails, but the row is already correct", async () => {
    const rows = [row(ID_A)];
    const { client } = fakeSupabase(rows);
    const runHostScript = jest.fn(async (s: string) =>
      s.includes("--apply") ? ok(resultStdout(ID_A)) : ({ ok: false, stdout: "", stderr: "exit 12" } as HostScriptResult));
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea" }, { runHostScript });
    expect(r.outcomes[0]).toMatchObject({ status: "reencrypted", plainDeleted: false });
    expect(rows[0].archive_uri.endsWith(".age")).toBe(true);
  });

  it("skips tampered rows without touching them, and pages with a cursor and a hard limit", async () => {
    const bad = row(ID_A, { archive_uri: "free/../../etc/passwd" });
    const rows = [bad, row(ID_B)];
    const { client } = fakeSupabase(rows);
    const runHostScript = jest.fn(async (s: string) => ok(s.includes("--apply") ? resultStdout(ID_B) : ""));
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea", limit: 1 }, { runHostScript });
    expect(r.scanned).toBe(1);
    expect(r.nextCursor).toBe(ID_A);
    expect(r.outcomes[0].status).toBe("skipped_invalid");
    const r2 = await runReencryptSweep(client, sweepOn, { hostSlug: "fixturenodea", limit: 1, cursor: r.nextCursor }, { runHostScript });
    expect(r2.outcomes[0].status).toBe("reencrypted");
    // limit is capped
    const many = Array.from({ length: 12 }, (_, i) => row(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`));
    const r3 = await runReencryptSweep(fakeSupabase(many).client, { mode: "dry", recipient: RECIPIENT }, { hostSlug: "h", limit: 999 }, { runHostScript });
    expect(r3.scanned).toBe(5);
  });

  it("defers rows when there is not enough wall clock left", async () => {
    const { client } = fakeSupabase([row(ID_A)]);
    const runHostScript = jest.fn();
    const r = await runReencryptSweep(client, sweepOn, { hostSlug: "h", deadlineMs: 1_000 }, { runHostScript, now: () => 0 });
    expect(r.outcomes[0].status).toBe("skipped_deadline");
    expect(runHostScript).not.toHaveBeenCalled();
  });
});
