/**
 * Unit tests for cold-storage-service.ts. Mocks the SSH-to-PVE transport
 * (`deps.runHostScript`) and the supabase chain, exercises every state
 * transition the orchestrator owns. End-to-end behaviour (real PVE host +
 * Storage Box) is validated by the procedure documented in
 * docs/cold-storage.md, using a disposable sandbox and placeholder identities.
 */

import {
  archiveInstance,
  buildRestoreCloneTeardownScript,
  manifestPathFromArchiveUri,
  purgeArchive,
  restoreInstance,
  restoreScriptRefusedPreexistingVmid,
  verifyArchiveIntegrity,
  type ColdStorageDeps,
} from "../cold-storage-service";
import type { HostScriptResult } from "../proxmox-instance-service";

jest.mock("../proxmox-instance-service", () => {
  const actual = jest.requireActual("../proxmox-instance-service");
  return {
    ...actual,
    // resolveProxmoxHostEnv is called inside the service to build the env
    // for the host-script runner. Make it a passthrough so tests don't
    // need real PROXMOX_* env populated.
    resolveProxmoxHostEnv: (_routing: unknown, baseEnv: NodeJS.ProcessEnv) => baseEnv,
    runProxmoxHostScript: jest.fn(),
  };
});

// Cold-archive drops the per-tenant Cloudflare A record after qm destroy
// to free a slot on the zone's record cap (a leak that helped fill the
// hermesos.cloud Free plan's 200 records on 2026-05-17). Mock the helper
// so the service doesn't try to talk to the real Cloudflare API in tests.
jest.mock("@/lib/services/cloudflare-dns", () => ({
  removeInstanceDns: jest.fn().mockResolvedValue({ ok: true, removed: true }),
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
}));

import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
const removeInstanceDnsBestEffortMock = removeInstanceDnsBestEffort as jest.Mock;

const VALID_INSTANCE_ID = "00000000-0000-4000-8000-000000000216";
const VALID_SHA = "10977054c9de258a9e9011d812c562bcaf6fc8fd02a60bdcba9747040e356e22";
const VALID_TS = "20260516T102940Z";
const VALID_ARCHIVE_URI = `free/${VALID_INSTANCE_ID}/data-${VALID_TS}.tar.zst`;
const VALID_SIZE = 917665644;

type SupabaseMock = {
  from: jest.Mock;
  __queue: Array<{
    table: string;
    op: "select" | "update";
    matchers: Record<string, unknown>;
    /** When op=update this is the `.update(payload)` payload captured for assertions. */
    payload?: Record<string, unknown>;
    result: { data: unknown; error: { message: string } | null };
  }>;
};

function makeSupabase(
  queue: Array<{
    table: string;
    op: "select" | "update";
    result: { data: unknown; error: { message: string } | null };
    capture?: (payload: Record<string, unknown>, matchers: Record<string, unknown>) => void;
  }>
): SupabaseMock {
  let cursor = 0;
  const transactions: SupabaseMock["__queue"] = [];

  const from = jest.fn((table: string) => {
    const txIdx = cursor;
    cursor += 1;
    const stage = queue[txIdx];
    if (!stage) {
      throw new Error(`Supabase mock exhausted at .from("${table}") (call #${txIdx + 1}).`);
    }
    if (stage.table !== table) {
      throw new Error(
        `Supabase mock expected .from("${stage.table}") at call #${txIdx + 1} but got .from("${table}")`
      );
    }

    const matchers: Record<string, unknown> = {};
    let payload: Record<string, unknown> | undefined;

    const builder: Record<string, unknown> = {};
    builder.select = jest.fn(() => builder);
    builder.update = jest.fn((p: Record<string, unknown>) => {
      payload = p;
      return builder;
    });
    builder.eq = jest.fn((column: string, value: unknown) => {
      matchers[`eq:${column}`] = value;
      return builder;
    });
    builder.in = jest.fn((column: string, value: unknown) => {
      matchers[`in:${column}`] = value;
      return builder;
    });
    builder.is = jest.fn((column: string, value: unknown) => {
      matchers[`is:${column}`] = value;
      return builder;
    });
    builder.maybeSingle = jest.fn(async () => {
      transactions.push({ table, op: stage.op, matchers, payload, result: stage.result });
      stage.capture?.(payload ?? {}, matchers);
      return stage.result;
    });

    return builder;
  });

  return { from, __queue: transactions } as unknown as SupabaseMock;
}

function archiveScriptOk(opts?: { sha?: string; size?: number; ts?: string; iid?: string; vmid?: number; host?: string }): HostScriptResult {
  const sha = opts?.sha ?? VALID_SHA;
  const size = opts?.size ?? VALID_SIZE;
  const ts = opts?.ts ?? VALID_TS;
  const iid = opts?.iid ?? VALID_INSTANCE_ID;
  const vmid = opts?.vmid ?? 216;
  const host = opts?.host ?? "fixturenode2";
  return {
    ok: true,
    stdout: [
      "═══ archive-vm-cold ... ═══",
      "  step 1/6: ...",
      `MANIFEST sha256=${sha} size=${size} iid=${iid} ts=${ts} vmid=${vmid} host=${host}`,
    ].join("\n"),
    stderr: "",
  };
}

function manifestJson(opts?: { sha?: string; size?: number; ts?: string }): HostScriptResult {
  const sha = opts?.sha ?? VALID_SHA;
  const size = opts?.size ?? VALID_SIZE;
  const ts = opts?.ts ?? VALID_TS;
  return {
    ok: true,
    stdout: JSON.stringify({
      schema_version: 1,
      archived_at: "2026-05-16T10:29:40Z",
      vmid: 216,
      pve_host: "fixturenode2",
      instance_id: VALID_INSTANCE_ID,
      archive_path: `free/${VALID_INSTANCE_ID}/data-${ts}.tar.zst`,
      archive_size_bytes: size,
      archive_sha256: sha,
      tier: "free",
    }),
    stderr: "",
  };
}

function destroyOk(): HostScriptResult {
  return { ok: true, stdout: "", stderr: "" };
}

// 4th host script in the happy archive path: remove the per-instance host
// Caddy site file + reload host Caddy. Gated on qm destroy succeeding, exactly
// like the Cloudflare A-record removal.
function caddyCleanupOk(): HostScriptResult {
  return {
    ok: true,
    stdout: "HERMES_CADDY_SITE_REMOVED agent-archive-test.hermesos.cloud\nHERMES_CADDY_CLEANUP_RELOADED",
    stderr: "",
  };
}

/**
 * The host script handed to runHostScript is now a small shell program: a
 * base64 self-install of restore-vm-cold.sh (so hosts can't run a stale
 * hand-copied version) followed by the invocation. Positional-argument
 * assertions must look at the invocation LINE, not the whole program.
 */
function restoreInvocationParts(hostScript: string): string[] {
  const lines = hostScript
    .split("\n")
    // The invocation is the only line that STARTS with the script path. Every
    // line of the install block (mktemp, base64 -d >, chmod, mv -f) mentions the
    // path but is indented or prefixed by a command, so anchoring beats
    // blacklisting — a new install step can't silently slip past this.
    .filter((l) => l.startsWith("/usr/local/sbin/restore-vm-cold.sh"));
  // Exactly one invocation, on one line — if a refactor ever splits the args
  // across lines the index-based assertions below would silently stop guarding.
  expect(lines).toHaveLength(1);
  return lines[0].trim().split(/\s+/);
}

function makeDeps(scripts: HostScriptResult[]): {
  deps: ColdStorageDeps;
  runHostScript: jest.Mock;
} {
  const queue = [...scripts];
  const runHostScript = jest.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("runHostScript mock exhausted");
    return next;
  });
  return {
    deps: {
      runHostScript,
      now: () => new Date("2026-05-16T12:00:00.000Z"),
      env: {},
    },
    runHostScript,
  };
}

describe("manifestPathFromArchiveUri", () => {
  it("derives the manifest path from a free-tier archive uri", () => {
    expect(
      manifestPathFromArchiveUri(`free/${VALID_INSTANCE_ID}/data-${VALID_TS}.tar.zst`)
    ).toBe(`meta/${VALID_INSTANCE_ID}/${VALID_TS}.json`);
  });

  it("returns null for an unrecognized path shape", () => {
    expect(manifestPathFromArchiveUri("free/abc/notarchive.txt")).toBeNull();
    expect(manifestPathFromArchiveUri("foo/bar/baz")).toBeNull();
  });
});

describe("archiveInstance", () => {
  const baseRow = {
    id: VALID_INSTANCE_ID,
    proxmox_node: "fixturenode2",
    proxmox_vmid: 216,
    ipv4_address: "10.250.21.66",
    resource_tier: "credit_base",
    lifecycle_state: "paused",
    status: "stopped",
    subdomain: "agent-archive-test",
    archive_uri: null,
    archived_at: null,
    archive_size_bytes: null,
    archive_sha256: null,
    archive_count: 0,
    paused_reason: "inactivity",
  };

  beforeEach(() => {
    removeInstanceDnsBestEffortMock.mockClear();
    removeInstanceDnsBestEffortMock.mockResolvedValue(undefined);
  });

  it("happy path: paused → archiving → cold_archived, then destroy", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } }, // fetchInstance
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } }, // CAS to archiving
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } }, // → cold_archived
    ]);
    const { deps, runHostScript } = makeDeps([archiveScriptOk(), manifestJson(), destroyOk(), caddyCleanupOk()]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    expect(result).toMatchObject({
      ok: true,
      instanceId: VALID_INSTANCE_ID,
      vmid: 216,
      pveHost: "fixturenode2",
      archiveUri: VALID_ARCHIVE_URI,
      archiveSha256: VALID_SHA,
      archiveSizeBytes: VALID_SIZE,
    });
    // archive-vm-cold.sh, manifest fetch, qm destroy, host caddy site cleanup
    expect(runHostScript).toHaveBeenCalledTimes(4);
    expect(runHostScript.mock.calls[0]?.[0]).toContain(
      `/usr/local/sbin/archive-vm-cold.sh 216 '${VALID_INSTANCE_ID}'`,
    );
    // The cold_archived UPDATE must clear proxmox routing fields per Invariant I5
    const coldUpdate = supabase.__queue.find(
      (tx) => tx.op === "update" && (tx.payload as { lifecycle_state?: string })?.lifecycle_state === "cold_archived"
    );
    expect(coldUpdate?.payload).toMatchObject({
      lifecycle_state: "cold_archived",
      proxmox_node: null,
      proxmox_vmid: null,
      ipv4_address: null,
      archive_uri: VALID_ARCHIVE_URI,
      archive_sha256: VALID_SHA,
      archive_count: 1,
    });
  });

  it("returns instance_missing when the row is gone", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: null, error: null } },
    ]);
    const { deps } = makeDeps([]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "instance_missing", retryable: false });
  });

  it("returns instance_not_archivable when not paused", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: { ...baseRow, lifecycle_state: "active" }, error: null } },
    ]);
    const { deps } = makeDeps([]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "instance_not_archivable", retryable: false });
  });

  it("returns lock_not_acquired when CAS finds no matching row", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: null, error: null } }, // CAS lost
    ]);
    const { deps } = makeDeps([]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "lock_not_acquired", retryable: true });
  });

  it("reverts to paused when the host script fails (no destroy)", async () => {
    let revertedPayload: Record<string, unknown> | undefined;
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      {
        table: "hermes_instances",
        op: "update",
        result: { data: null, error: null },
        capture: (payload) => { revertedPayload = payload; },
      }, // revert
    ]);
    const { deps, runHostScript } = makeDeps([
      { ok: false, stdout: "", stderr: "oh no", error: "script blew up" },
    ]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "host_script_failed", retryable: true });
    expect(revertedPayload).toMatchObject({ lifecycle_state: "paused" });
    // Only the archive script was called; no manifest fetch, no destroy
    expect(runHostScript).toHaveBeenCalledTimes(1);
  });

  it("reverts and does NOT destroy on manifest sha mismatch", async () => {
    let revertedPayload: Record<string, unknown> | undefined;
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      {
        table: "hermes_instances",
        op: "update",
        result: { data: null, error: null },
        capture: (payload) => { revertedPayload = payload; },
      },
    ]);
    // archive script reports sha A, manifest returns sha B → mismatch
    const { deps, runHostScript } = makeDeps([
      archiveScriptOk({ sha: "a".repeat(64) }),
      manifestJson({ sha: "b".repeat(64) }),
    ]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "manifest_verify_failed", retryable: false });
    expect(revertedPayload).toMatchObject({ lifecycle_state: "paused" });
    expect(runHostScript).toHaveBeenCalledTimes(2); // no destroy attempted
  });

  it("reverts to paused on any synchronous throw after lock (env resolution etc.)", async () => {
    // Regression test for the bug where resolveProxmoxHostEnv throwing
    // synchronously left the row stuck in `archiving` because the revert
    // handler only fired for HostScriptResult-shaped failures, not thrown
    // errors. Fix: archiveInstance wraps the post-lock body in try/catch.
    let revertedPayload: Record<string, unknown> | undefined;
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } }, // CAS
      {
        table: "hermes_instances",
        op: "update",
        result: { data: { id: VALID_INSTANCE_ID }, error: null },
        capture: (payload) => { revertedPayload = payload; },
      }, // revert
    ]);
    const deps: ColdStorageDeps = {
      runHostScript: async () => { throw new Error("env identity check failed"); },
      now: () => new Date("2026-05-16T12:00:00.000Z"),
      env: {},
    };

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: "host_script_failed",
      message: expect.stringContaining("threw after lock acquired"),
      retryable: true,
    });
    expect(revertedPayload).toMatchObject({ lifecycle_state: "paused" });
  });

  it("returns destroy_failed but keeps row cold_archived when qm destroy fails", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } }, // cold_archived
    ]);
    const { deps } = makeDeps([
      archiveScriptOk(),
      manifestJson(),
      { ok: false, stdout: "", stderr: "destroy failed", error: "qm destroy: VM not found" },
    ]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);
    expect(result).toMatchObject({ ok: false, reason: "destroy_failed", retryable: true });
    // The cold_archived UPDATE happened — only the destroy is missing
    const coldUpdate = supabase.__queue.find(
      (tx) => (tx.payload as { lifecycle_state?: string })?.lifecycle_state === "cold_archived"
    );
    expect(coldUpdate).toBeDefined();
    // DNS removal is gated on qm destroy succeeding so a failed destroy
    // doesn't strand the row with no routing on retry.
    expect(removeInstanceDnsBestEffortMock).not.toHaveBeenCalled();
  });

  it("removes the per-tenant Cloudflare A record after a successful destroy", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps } = makeDeps([archiveScriptOk(), manifestJson(), destroyOk(), caddyCleanupOk()]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    expect(result.ok).toBe(true);
    expect(removeInstanceDnsBestEffortMock).toHaveBeenCalledTimes(1);
    expect(removeInstanceDnsBestEffortMock).toHaveBeenCalledWith(
      baseRow.subdomain,
      expect.objectContaining({ source: "cold-storage-service", instanceId: VALID_INSTANCE_ID }),
    );
  });

  it("calls DNS cleanup even when the helper would surface a failure", async () => {
    // A failed DNS removal must not flip a successful archive to failure —
    // the VM is gone, the archive is on the Storage Box, the row is
    // cold_archived. A stale Cloudflare record is the smallest possible
    // follow-up and a later sweep can mop it up. The helper itself is
    // contracted not to throw (it logs and resolves); the helper's own
    // unit tests in cloudflare-dns.test.ts cover the swallow-and-warn
    // path. Here we just guarantee the call site reaches the helper.
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps } = makeDeps([archiveScriptOk(), manifestJson(), destroyOk(), caddyCleanupOk()]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    expect(result.ok).toBe(true);
    expect(removeInstanceDnsBestEffortMock).toHaveBeenCalledWith(
      baseRow.subdomain,
      expect.objectContaining({ source: "cold-storage-service" }),
    );
  });

  it("removes the per-instance host caddy site file after a successful destroy", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps, runHostScript } = makeDeps([archiveScriptOk(), manifestJson(), destroyOk(), caddyCleanupOk()]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    expect(result.ok).toBe(true);
    // The 4th host script (after archive, manifest fetch, qm destroy) removes
    // the host caddy site file and reloads — closing the cross-tenant routing
    // leak when the freed VMID/IP is later recycled.
    expect(runHostScript).toHaveBeenCalledTimes(4);
    const cleanupCmd = runHostScript.mock.calls[3][0] as string;
    // No config.infrastructure on baseRow → derives <subdomain>.hermesos.cloud
    expect(cleanupCmd).toContain("/etc/caddy/hermes.d/agent-archive-test.hermesos.cloud.caddy");
    expect(cleanupCmd).toContain("rm -f");
    // validate-then-reload, mirroring hermes_caddy_reload
    expect(cleanupCmd).toContain("caddy validate --config /etc/caddy/Caddyfile");
    expect(cleanupCmd).toContain("caddy reload --config /etc/caddy/Caddyfile --force");
  });

  it("derives the caddy site file from config.infrastructure.gatewayHost when present", async () => {
    const rowWithInfra = {
      ...baseRow,
      subdomain: "stalesub",
      config: { infrastructure: { provider: "proxmox", gatewayHost: "realhost.hermesos.cloud" } },
    };
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: rowWithInfra, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps, runHostScript } = makeDeps([archiveScriptOk(), manifestJson(), destroyOk(), caddyCleanupOk()]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    expect(result.ok).toBe(true);
    const cleanupCmd = runHostScript.mock.calls[3][0] as string;
    // Authoritative gatewayHost wins over the subdomain fallback.
    expect(cleanupCmd).toContain("/etc/caddy/hermes.d/realhost.hermesos.cloud.caddy");
    expect(cleanupCmd).not.toContain("stalesub.hermesos.cloud.caddy");
  });

  it("a failed host caddy site cleanup does NOT flip a successful archive to failure", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps } = makeDeps([
      archiveScriptOk(),
      manifestJson(),
      destroyOk(),
      { ok: false, stdout: "", stderr: "another site file is broken", error: "caddy validate failed" },
    ]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    // Archive succeeded: VM destroyed, archive on Storage Box, row cold_archived.
    // A reload failure (e.g. a pre-existing broken neighbour file) is logged,
    // not surfaced — the rm already landed and the orphan sweep mops up later.
    expect(result.ok).toBe(true);
  });

  it("does NOT run host caddy cleanup when qm destroy fails (only 3 host scripts)", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: baseRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps, runHostScript } = makeDeps([
      archiveScriptOk(),
      manifestJson(),
      { ok: false, stdout: "", stderr: "destroy failed", error: "qm destroy: VM not found" },
    ]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    expect(result).toMatchObject({ ok: false, reason: "destroy_failed" });
    // Caddy cleanup is gated on destroy success, like the DNS removal — the
    // VM still exists, so its route must stay.
    expect(runHostScript).toHaveBeenCalledTimes(3);
  });

  it("forwards a null subdomain to the helper (helper short-circuits)", async () => {
    // sslip-only instances have no subdomain. The helper's contract is to
    // no-op on null/undefined; cold-storage trusts that contract rather
    // than guarding the call itself.
    const sslipRow = { ...baseRow, subdomain: null };
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: sslipRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps } = makeDeps([archiveScriptOk(), manifestJson(), destroyOk()]);

    const result = await archiveInstance(supabase as never, VALID_INSTANCE_ID, deps);

    expect(result.ok).toBe(true);
    expect(removeInstanceDnsBestEffortMock).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ source: "cold-storage-service" }),
    );
  });
});

describe("restoreInstance", () => {
  const coldRow = {
    id: VALID_INSTANCE_ID,
    proxmox_node: null,
    proxmox_vmid: null,
    ipv4_address: null,
    resource_tier: "credit_base",
    lifecycle_state: "cold_archived",
    status: "stopped",
    archive_uri: VALID_ARCHIVE_URI,
    archived_at: "2026-05-16T10:29:40Z",
    archive_size_bytes: VALID_SIZE,
    archive_sha256: VALID_SHA,
    archive_count: 1,
    paused_reason: "cold_archived",
  };

  const restoreOptions = {
    destinationHostSlug: "fixturenode5",
    destinationVmid: 599,
    destinationIp: "10.250.22.199",
    destinationGateway: "10.250.22.1",
    templateVmid: 9006,
    targetDiskGb: 30,
    cpuLimit: 0.5,
  };

  function restoreScriptOk(opts?: { vmid?: number; ip?: string; host?: string }): HostScriptResult {
    return {
      ok: true,
      stdout: [
        "═══ restore-vm-cold ... ═══",
        `RESULT status=ok instance=${VALID_INSTANCE_ID} vmid=${opts?.vmid ?? 599} host=${opts?.host ?? "fixturenode5"} ip=${opts?.ip ?? "10.250.22.199"} archive=${VALID_ARCHIVE_URI} sha256=${VALID_SHA} size=${VALID_SIZE}`,
      ].join("\n"),
      stderr: "",
    };
  }

  it("happy path: cold_archived → restoring → active with new routing", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } }, // CAS
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } }, // → active
    ]);
    const { deps, runHostScript } = makeDeps([restoreScriptOk()]);

    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({
      ok: true,
      instanceId: VALID_INSTANCE_ID,
      newVmid: 599,
      newPveHost: "fixturenode5",
      newIpv4: "10.250.22.199",
    });

    // The restore-vm-cold.sh invocation must carry cpu_limit as the 9th
    // positional arg; without it the VM provisions unbounded (the fixturenodea
    // saturation incident class from 2026-05-17). Asserting the tail of
    // the command string so a regression of "forgot to thread cpuLimit"
    // is caught here, not 4h later by aeon fleet-sweep.
    const restoreCmd = runHostScript.mock.calls[0][0] as string;
    expect(restoreCmd).toContain("/usr/local/sbin/restore-vm-cold.sh");
    // 9 positional args after the script path: instance, archive, sha, vmid,
    // ip, gw, template, disk, cpu_limit
    const parts = restoreInvocationParts(restoreCmd);
    expect(parts).toHaveLength(10); // script + 9 args
    expect(parts[9]).toBe("0.5");

    const activeUpdate = supabase.__queue.find(
      (tx) => (tx.payload as { lifecycle_state?: string })?.lifecycle_state === "active"
    );
    expect(activeUpdate?.payload).toMatchObject({
      lifecycle_state: "active",
      proxmox_node: "fixturenode5",
      proxmox_vmid: 599,
      ipv4_address: "10.250.22.199",
      paused_reason: null,
    });

    // The row is live again, so it must stop claiming to be a cold-storage row.
    // A stale archive_uri here is invisible until the box is re-paused, at which
    // point the archive cron's `archive_uri IS NULL` filter can never select it
    // and the instance pins its thin-pool disk forever (25 rows by 2026-09-17).
    expect(activeUpdate?.payload).toMatchObject({
      archive_uri: null,
      archive_sha256: null,
      archive_size_bytes: null,
      archived_at: null,
    });
  });

  it("uses 0.5 cpu_limit default when caller omits cpuLimit option", async () => {
    // Old callers that don't know about cpuLimit shouldn't accidentally
    // unbound-provision; the default is the free-tier value.
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps, runHostScript } = makeDeps([restoreScriptOk()]);

    const { cpuLimit: _omitted, ...optionsWithoutCpu } = restoreOptions;
    await restoreInstance(supabase as never, VALID_INSTANCE_ID, optionsWithoutCpu, deps);

    const restoreCmd = runHostScript.mock.calls[0][0] as string;
    const parts = restoreInvocationParts(restoreCmd);
    expect(parts[9]).toBe("0.5");
  });

  it("returns instance_not_restorable when not in cold_archived or pending_deletion", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: { ...coldRow, lifecycle_state: "active" }, error: null } },
    ]);
    const { deps } = makeDeps([]);
    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: false, reason: "instance_not_restorable" });
  });

  it("also restorable from pending_deletion (rescue case)", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: { ...coldRow, lifecycle_state: "pending_deletion" }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps } = makeDeps([restoreScriptOk()]);

    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: true });
  });

  it("returns missing_archive_metadata when archive_uri/sha not stored", async () => {
    const supabase = makeSupabase([
      {
        table: "hermes_instances",
        op: "select",
        result: { data: { ...coldRow, archive_uri: null, archive_sha256: null }, error: null },
      },
    ]);
    const { deps } = makeDeps([]);
    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: false, reason: "missing_archive_metadata" });
  });

  it("reverts to previous state when restore-vm-cold.sh fails AND tears down the clone it may have created", async () => {
    let revertedPayload: Record<string, unknown> | undefined;
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      {
        table: "hermes_instances",
        op: "update",
        result: { data: null, error: null },
        capture: (payload) => { revertedPayload = payload; },
      },
    ]);
    const { deps, runHostScript } = makeDeps([
      { ok: false, stdout: "[restore] SHA MISMATCH", stderr: "", error: "exit 2" },
      { ok: true, stdout: "TEARDOWN_SKIP_ABSENT 599", stderr: "" }, // guarded teardown
    ]);

    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: false, reason: "host_script_failed", retryable: true });
    expect(revertedPayload).toMatchObject({ lifecycle_state: "cold_archived" });

    // A failure after the restore script ran MUST attempt the guarded clone
    // teardown before reverting the row to cold — otherwise the clone leaks as
    // a running onboot=1 VM no sweep can see (2026-07-07 incident: 24 orphans).
    expect(runHostScript).toHaveBeenCalledTimes(2);
    const teardownScript = runHostScript.mock.calls[1][0] as string;
    expect(teardownScript).toContain(`expect='hermes-${VALID_INSTANCE_ID}'`);
    expect(teardownScript).toContain("vmid=599");
    // The exact-name guard must gate the destroy (regression: guard blocks a
    // mismatched name so a recycled VMID / another tenant's VM is never touched).
    const guardIdx = teardownScript.indexOf('if [ "$name" != "$expect" ]');
    const destroyIdx = teardownScript.indexOf("qm destroy");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(destroyIdx).toBeGreaterThan(guardIdx);
  });

  it("parks the row health_pending (not reverted) when the script exits 5 with status=health_pending", async () => {
    // restore-vm-cold.sh restored the data + booted the VM but the gateway
    // hadn't gone healthy in its window: exit 5 (ok:false) + RESULT
    // status=health_pending. The row MUST NOT revert to cold (that would leak
    // the live VM) — it parks as restoring/restore_health_pending with the new
    // routing written for the recovery sweep to promote.
    let parkPayload: Record<string, unknown> | undefined;
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } }, // CAS
      {
        table: "hermes_instances",
        op: "update",
        result: { data: { id: VALID_INSTANCE_ID }, error: null }, // park
        capture: (payload) => { parkPayload = payload; },
      },
    ]);
    const { deps, runHostScript } = makeDeps([
      {
        ok: false,
        error: "exit 5",
        stdout: [
          "[restore] gateway never reported healthy after 60s",
          `RESULT status=health_pending instance=${VALID_INSTANCE_ID} vmid=599 host=fixturenode5 ip=10.250.22.199 archive=${VALID_ARCHIVE_URI} sha256=${VALID_SHA} size=${VALID_SIZE}`,
        ].join("\n"),
        stderr: "",
      },
    ]);

    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: "health_pending",
      instanceId: VALID_INSTANCE_ID,
      newVmid: 599,
      newPveHost: "fixturenode5",
      newIpv4: "10.250.22.199",
      retryable: false,
    });
    // health_pending is NOT a failure: the live VM is parked for the recovery
    // sweep — the clone teardown must NOT fire (that would destroy a healthy
    // restore mid-finalization).
    expect(runHostScript).toHaveBeenCalledTimes(1);
    // The park write keeps the row in restoring (NOT cold_archived) with the
    // finalizing substate + the new VM routing columns.
    expect(parkPayload).toMatchObject({
      lifecycle_state: "restoring",
      lifecycle_substate: "restore_health_pending",
      proxmox_node: "fixturenode5",
      proxmox_vmid: 599,
      ipv4_address: "10.250.22.199",
    });
    // Crucially it must NOT have reverted to the cold state.
    expect(parkPayload?.lifecycle_state).not.toBe("cold_archived");
    // And it must KEEP the archive pointer: the restore is not confirmed yet, so
    // if the sweep later judges it broken the archive has to remain restorable
    // and purgeable. Only the confirmed-live paths clear it.
    expect(parkPayload).not.toHaveProperty("archive_uri");
  });

  it("returns result_parse_failed when stdout has no RESULT line (and tears down the clone)", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: null, error: null } }, // revert
    ]);
    const { deps, runHostScript } = makeDeps([
      { ok: true, stdout: "the script ran but never emitted a RESULT line", stderr: "" },
      { ok: true, stdout: "TEARDOWN_OK 599", stderr: "" }, // guarded teardown
    ]);

    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: false, reason: "result_parse_failed" });
    expect(runHostScript).toHaveBeenCalledTimes(2);
  });

  it("rejects RESULT line claiming a different instance_id (and tears down only under OUR name)", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: null, error: null } },
    ]);
    const { deps, runHostScript } = makeDeps([
      {
        ok: true,
        stdout: "RESULT status=ok instance=99999999-9999-1999-8999-999999999999 vmid=599 host=fixturenode5 ip=10.250.22.199 archive=x sha256=y size=1",
        stderr: "",
      },
      { ok: true, stdout: "TEARDOWN_SKIP_NAME 599 hermes-99999999-9999-1999-8999-999999999999", stderr: "" },
    ]);

    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: false, reason: "result_parse_failed", retryable: false });
    // The teardown script's expected name is OUR instance id — a clone that
    // reports some other instance's name is skipped by the run-time guard.
    const teardownScript = runHostScript.mock.calls[1][0] as string;
    expect(teardownScript).toContain(`expect='hermes-${VALID_INSTANCE_ID}'`);
  });

  it("skips the teardown entirely when the script preflight refused a pre-existing VMID", async () => {
    // "[restore] VMID <n> already exists" = the VM at the destination VMID was
    // NOT created by this attempt — it must never be touched from this path
    // (the flag-gated orphan sweep owns that class).
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: null, error: null } }, // revert
    ]);
    const { deps, runHostScript } = makeDeps([
      {
        ok: false,
        stdout: "",
        stderr: "[restore] VMID 599 already exists on fixturenode5",
        error: "exit 1",
      },
    ]);

    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: false, reason: "host_script_failed" });
    expect(runHostScript).toHaveBeenCalledTimes(1); // no second (teardown) call
  });

  it("accepts a failed row with intact archive metadata", async () => {
    const failedRow = {
      ...coldRow,
      lifecycle_state: "failed",
      status: "error",
      proxmox_vmid: null,
    };
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: failedRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    const { deps } = makeDeps([restoreScriptOk()]);
    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: true, newVmid: 599, newPveHost: "fixturenode5" });
  });

  it("still rejects a 'failed' row WITHOUT archive metadata (data is gone, restore meaningless)", async () => {
    const failedRowNoArchive = {
      ...coldRow,
      lifecycle_state: "failed",
      proxmox_vmid: null,
      archive_uri: null,
      archive_sha256: null,
    };
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: failedRowNoArchive, error: null } },
    ]);
    const { deps } = makeDeps([]);
    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: false, reason: "instance_not_restorable" });
  });

  it("rewrites config.infrastructure to the new VMID/host on success (closes #94 cross-tenant footgun)", async () => {
    let activeUpdatePayload: Record<string, unknown> | undefined;
    const rowWithStaleInfra = {
      ...coldRow,
      config: {
        infrastructure: {
          node: "fixturenode1",
          vmid: 304,
          hostSlug: "fixturenode1",
          provider: "proxmox",
          gatewayHost: "old-instance.agents.hermesos.cloud",
          privateIpv4: "10.250.20.84",
          templateVmid: 9004,
        },
      },
    };
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: rowWithStaleInfra, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      {
        table: "hermes_instances",
        op: "update",
        result: { data: { id: VALID_INSTANCE_ID }, error: null },
        capture: (payload) => { activeUpdatePayload = payload; },
      },
    ]);
    const { deps } = makeDeps([restoreScriptOk({ vmid: 727, host: "fixturenode7", ip: "10.250.20.77" })]);
    const result = await restoreInstance(supabase as never, VALID_INSTANCE_ID, restoreOptions, deps);
    expect(result).toMatchObject({ ok: true });
    expect(activeUpdatePayload).toMatchObject({
      proxmox_node: "fixturenode7",
      proxmox_vmid: 727,
      ipv4_address: "10.250.20.77",
    });
    const cfg = activeUpdatePayload?.config as { infrastructure?: Record<string, unknown> } | undefined;
    expect(cfg?.infrastructure).toMatchObject({
      node: "fixturenode7",
      vmid: 727,
      hostSlug: "fixturenode7",
      privateIpv4: "10.250.20.77",
      // templateVmid is intentionally preserved from the original config so
      // subsequent redeploys keep their template lineage.
      templateVmid: 9004,
    });
  });

  it("backfills gatewayHost + hostEnvPrefix into infrastructure on restore (reclaim strips it → 'No host attached')", async () => {
    // Reclaim runs stripProxmoxInfrastructure, deleting the whole infra block.
    // The restore must reconstruct gatewayHost from the destination gateway —
    // otherwise getProxmoxInfrastructure() returns null and the next live-update
    // fails with "No host attached" (regression for ADAIR/COACH).
    let activeUpdatePayload: Record<string, unknown> | undefined;
    const rowWithStrippedInfra = { ...coldRow, config: {} };
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: rowWithStrippedInfra, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
      {
        table: "hermes_instances",
        op: "update",
        result: { data: { id: VALID_INSTANCE_ID }, error: null },
        capture: (payload) => { activeUpdatePayload = payload; },
      },
    ]);
    const { deps } = makeDeps([restoreScriptOk({ vmid: 727, host: "fixturenode7", ip: "10.250.20.77" })]);
    const result = await restoreInstance(
      supabase as never,
      VALID_INSTANCE_ID,
      { ...restoreOptions, destinationGateway: "https://restored-sub.hermesos.cloud" },
      deps
    );
    expect(result).toMatchObject({ ok: true });
    const cfg = activeUpdatePayload?.config as { infrastructure?: Record<string, unknown> } | undefined;
    expect(cfg?.infrastructure).toMatchObject({
      node: "fixturenode7",
      vmid: 727,
      provider: "proxmox",
      privateIpv4: "10.250.20.77",
      gatewayHost: "restored-sub.hermesos.cloud",
      hostEnvPrefix: "PROXMOX_FIXTURENODE7_",
    });
  });
});

describe("buildRestoreCloneTeardownScript (leak-guard invariants)", () => {
  const IID = "00000000-0000-4000-8000-000000000216";

  it("builds a script whose destroy is gated by the exact hermes-<instanceId> name re-check", () => {
    const script = buildRestoreCloneTeardownScript(599, IID);
    expect(script).not.toBeNull();
    expect(script).toContain(`expect='hermes-${IID}'`);
    // Guard blocks a mismatched name BEFORE any stop/destroy is reachable.
    const skipAbsentIdx = script!.indexOf("TEARDOWN_SKIP_ABSENT");
    const skipNameIdx = script!.indexOf("TEARDOWN_SKIP_NAME");
    const stopIdx = script!.indexOf('qm stop "$vmid"');
    const destroyIdx = script!.indexOf('qm destroy "$vmid" --purge 1');
    expect(skipAbsentIdx).toBeGreaterThan(-1);
    expect(skipNameIdx).toBeGreaterThan(skipAbsentIdx);
    expect(stopIdx).toBeGreaterThan(skipNameIdx);
    expect(destroyIdx).toBeGreaterThan(stopIdx);
  });

  it("REFUSES to build for template-range vmids (9007 template, 9100 reserved) and bad vmids", () => {
    expect(buildRestoreCloneTeardownScript(9007, IID)).toBeNull();
    expect(buildRestoreCloneTeardownScript(9100, IID)).toBeNull();
    expect(buildRestoreCloneTeardownScript(9000, IID)).toBeNull();
    expect(buildRestoreCloneTeardownScript(0, IID)).toBeNull();
    expect(buildRestoreCloneTeardownScript(-5, IID)).toBeNull();
    expect(buildRestoreCloneTeardownScript(1.5, IID)).toBeNull();
  });

  it("REFUSES to build for a non-UUID instance id (nothing interpolatable into the shell)", () => {
    expect(buildRestoreCloneTeardownScript(599, "not-a-uuid")).toBeNull();
    expect(buildRestoreCloneTeardownScript(599, "")).toBeNull();
    expect(buildRestoreCloneTeardownScript(599, "$(reboot)")).toBeNull();
    expect(buildRestoreCloneTeardownScript(599, `${IID}'; rm -rf /`)).toBeNull();
  });
});

describe("restoreScriptRefusedPreexistingVmid", () => {
  it("detects the preflight refusal marker on stdout or stderr", () => {
    expect(
      restoreScriptRefusedPreexistingVmid({ stdout: "", stderr: "[restore] VMID 599 already exists on fixturenode5" })
    ).toBe(true);
    expect(
      restoreScriptRefusedPreexistingVmid({ stdout: "[restore] VMID 42 already exists on fixturenode9", stderr: "" })
    ).toBe(true);
    expect(restoreScriptRefusedPreexistingVmid({ stdout: "step 3/6: clone", stderr: "" })).toBe(false);
    expect(restoreScriptRefusedPreexistingVmid({})).toBe(false);
  });
});

describe("verifyArchiveIntegrity", () => {
  const coldRow = {
    id: VALID_INSTANCE_ID,
    proxmox_node: "fixturenode2",
    proxmox_vmid: null,
    ipv4_address: null,
    resource_tier: "credit_base",
    lifecycle_state: "cold_archived",
    status: "stopped",
    archive_uri: VALID_ARCHIVE_URI,
    archived_at: "2026-05-16T10:29:40Z",
    archive_size_bytes: VALID_SIZE,
    archive_sha256: VALID_SHA,
    archive_count: 1,
    paused_reason: "cold_archived",
  };

  it("slice mode happy path", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
    ]);
    const { deps } = makeDeps([
      manifestJson(),
      { ok: true, stdout: "OK", stderr: "" }, // slice probe
    ]);

    const result = await verifyArchiveIntegrity(
      supabase as never,
      VALID_INSTANCE_ID,
      { mode: "slice" },
      deps
    );
    expect(result).toMatchObject({ ok: true, mode: "slice", archiveUri: VALID_ARCHIVE_URI });
  });

  it("full mode happy path", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
    ]);
    const { deps } = makeDeps([
      manifestJson(),
      { ok: true, stdout: `VERIFY sha=${VALID_SHA} size=${VALID_SIZE}`, stderr: "" },
    ]);
    const result = await verifyArchiveIntegrity(
      supabase as never,
      VALID_INSTANCE_ID,
      { mode: "full", hostSlug: "fixturenode2" },
      deps
    );
    expect(result).toMatchObject({ ok: true, mode: "full" });
  });

  it("flags sha mismatch in full mode", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
    ]);
    const { deps } = makeDeps([
      manifestJson(),
      { ok: true, stdout: `VERIFY sha=${"f".repeat(64)} size=${VALID_SIZE}`, stderr: "" },
    ]);
    const result = await verifyArchiveIntegrity(
      supabase as never,
      VALID_INSTANCE_ID,
      { mode: "full" },
      deps
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "sha_mismatch",
      expectedSha256: VALID_SHA,
      actualSha256: "f".repeat(64),
    });
  });

  it("returns missing_archive_metadata when no archive_uri stored", async () => {
    const supabase = makeSupabase([
      {
        table: "hermes_instances",
        op: "select",
        result: { data: { ...coldRow, archive_uri: null, archive_sha256: null }, error: null },
      },
    ]);
    const { deps } = makeDeps([]);
    const result = await verifyArchiveIntegrity(supabase as never, VALID_INSTANCE_ID, {}, deps);
    expect(result).toMatchObject({ ok: false, reason: "missing_archive_metadata" });
  });
});

describe("purgeArchive", () => {
  const coldRow = {
    id: VALID_INSTANCE_ID,
    proxmox_node: "fixturenode2",
    proxmox_vmid: null,
    ipv4_address: null,
    resource_tier: "credit_base",
    lifecycle_state: "pending_deletion",
    status: "stopped",
    archive_uri: VALID_ARCHIVE_URI,
    archived_at: "2026-05-16T10:29:40Z",
    archive_size_bytes: VALID_SIZE,
    archive_sha256: VALID_SHA,
    archive_count: 1,
    paused_reason: "cold_archived",
  };

  it("moves archive to trash and flags row deleted", async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      {
        table: "hermes_instances",
        op: "update",
        result: { data: { id: VALID_INSTANCE_ID }, error: null },
        capture: (payload) => { updatePayload = payload; },
      },
    ]);
    let invokedCmd: string | undefined;
    const deps: ColdStorageDeps = {
      runHostScript: async (script) => {
        invokedCmd = script;
        return { ok: true, stdout: "", stderr: "" };
      },
      now: () => new Date("2026-05-16T12:00:00.000Z"),
      env: {},
    };

    const result = await purgeArchive(supabase as never, VALID_INSTANCE_ID, {}, deps);
    expect(result).toMatchObject({ ok: true });
    expect(invokedCmd).toContain("mv");
    expect(invokedCmd).toContain(`trash/${VALID_INSTANCE_ID}-`);
    expect(updatePayload).toMatchObject({
      lifecycle_state: "deleted",
      archive_uri: null,
    });
  });

  it("skipTrash performs a direct rm", async () => {
    const supabase = makeSupabase([
      { table: "hermes_instances", op: "select", result: { data: coldRow, error: null } },
      { table: "hermes_instances", op: "update", result: { data: { id: VALID_INSTANCE_ID }, error: null } },
    ]);
    let invokedCmd: string | undefined;
    const deps: ColdStorageDeps = {
      runHostScript: async (script) => {
        invokedCmd = script;
        return { ok: true, stdout: "", stderr: "" };
      },
      now: () => new Date("2026-05-16T12:00:00.000Z"),
      env: {},
    };
    const result = await purgeArchive(supabase as never, VALID_INSTANCE_ID, { skipTrash: true }, deps);
    expect(result).toMatchObject({ ok: true, trashUri: "" });
    expect(invokedCmd).toContain("rm -rf");
    expect(invokedCmd).not.toContain("trash/");
  });
});
