import {
  parseDiscoveredVms,
  matchVmsToCandidates,
  pickKeeper,
  isAdoptableHealthCode,
  gatewayHostFromUrl,
  buildReapScript,
  countReaped,
  summarizeFleetDiscovery,
  runColdRestoreOrphanAdoptionSweep,
  DISCOVERY_SCRIPT,
  ORPHAN_RESTORE_CANDIDATE_LIFECYCLE_STATES,
  type DiscoveredAgentVm,
  type HostDiscoveryOutcome,
} from "@/lib/recovery/cold-restore-orphan-adoption";
import { locateProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";
import { applyRestoreRouting } from "@/lib/services/cold-storage-restore-routing";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  locateProxmoxInstanceAcrossFleet: jest.fn(),
}));
jest.mock("@/lib/services/cold-storage-restore-routing", () => ({
  applyRestoreRouting: jest.fn(),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn(() => ({})),
  runProxmoxHostScript: jest.fn(),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const ID_A = "00000000-0000-4000-8000-000000001007";
const ID_B = "00000000-0000-4000-8000-000000001037";

function vm(p: Partial<DiscoveredAgentVm> & { vmid: number; name: string }): DiscoveredAgentVm {
  return { hostSlug: "fixturenode12", privateIp: "10.250.20.61", healthCode: 200, ...p };
}

describe("parseDiscoveredVms", () => {
  it("parses VMINFO lines and keeps only hermes-* names", () => {
    const stdout = [
      `VMINFO 1211 hermes-${ID_A} 10.250.20.61 200`,
      `VMINFO 1216 hermes-${ID_A} 10.250.20.66 200`,
      "VMINFO 1300 some-other-vm 10.250.20.70 200", // not hermes-*
      "garbage line that should be ignored",
      "VMINFO 9007 hermes-template 10.250.20.99 200", // template range, dropped
      `VMINFO 1230 hermes-${ID_B} none 000`, // no ip, unhealthy
    ].join("\n");
    const out = parseDiscoveredVms("fixturenode12", stdout);
    expect(out).toEqual([
      { hostSlug: "fixturenode12", vmid: 1211, name: `hermes-${ID_A}`, privateIp: "10.250.20.61", healthCode: 200 },
      { hostSlug: "fixturenode12", vmid: 1216, name: `hermes-${ID_A}`, privateIp: "10.250.20.66", healthCode: 200 },
      { hostSlug: "fixturenode12", vmid: 1230, name: `hermes-${ID_B}`, privateIp: null, healthCode: 0 },
    ]);
  });

  it("returns [] for empty / noise-only output", () => {
    expect(parseDiscoveredVms("fixturenode1", "")).toEqual([]);
    expect(parseDiscoveredVms("fixturenode1", "qm: command not found\n")).toEqual([]);
  });
});

describe("matchVmsToCandidates", () => {
  it("groups by instance id, ignoring VMs for non-candidate ids", () => {
    const vms = [
      vm({ vmid: 1211, name: `hermes-${ID_A}` }),
      vm({ vmid: 1216, name: `hermes-${ID_A}` }),
      vm({ vmid: 1230, name: `hermes-${ID_B}` }),
      vm({ vmid: 1240, name: "hermes-ffffffff-0000-0000-0000-000000000000" }), // unknown id
    ];
    const map = matchVmsToCandidates(vms, new Set([ID_A]));
    expect([...map.keys()]).toEqual([ID_A]);
    expect(map.get(ID_A)).toHaveLength(2);
  });
});

describe("pickKeeper", () => {
  it("keeps the lowest-vmid healthy clone and marks the rest dupes", () => {
    const vms = [
      vm({ vmid: 1230, name: `hermes-${ID_A}` }),
      vm({ vmid: 1211, name: `hermes-${ID_A}` }),
      vm({ vmid: 1216, name: `hermes-${ID_A}` }),
    ];
    const picked = pickKeeper(vms);
    expect(picked?.keeper.vmid).toBe(1211);
    expect(picked?.dupes.map((d) => d.vmid).sort()).toEqual([1216, 1230]);
  });

  it("ignores unhealthy / IP-less clones when choosing a keeper", () => {
    const vms = [
      vm({ vmid: 1211, name: `hermes-${ID_A}`, healthCode: 502 }),
      vm({ vmid: 1216, name: `hermes-${ID_A}`, privateIp: null }),
      vm({ vmid: 1230, name: `hermes-${ID_A}`, healthCode: 200, privateIp: "10.250.20.80" }),
    ];
    const picked = pickKeeper(vms);
    expect(picked?.keeper.vmid).toBe(1230);
    // both others remain as dupes (they are still this instance's clones)
    expect(picked?.dupes.map((d) => d.vmid).sort()).toEqual([1211, 1216]);
  });

  it("returns null when no clone is healthy yet (leave for next sweep)", () => {
    const vms = [
      vm({ vmid: 1211, name: `hermes-${ID_A}`, healthCode: 0 }),
      vm({ vmid: 1216, name: `hermes-${ID_A}`, healthCode: 502 }),
    ];
    expect(pickKeeper(vms)).toBeNull();
  });

  it("adopts an auth-gated clone (302/401/403), not just a bare 200", () => {
    // Regression: post auth-hardening /health 302-redirects to /login, so a
    // healthy restored clone reports 302 (or 401/403), never a bare 200.
    // Demanding 200 left healthy restores unadopted forever.
    const vms = [
      vm({ vmid: 1216, name: `hermes-${ID_A}`, healthCode: 302 }),
      vm({ vmid: 1230, name: `hermes-${ID_A}`, healthCode: 401 }),
    ];
    const picked = pickKeeper(vms);
    expect(picked?.keeper.vmid).toBe(1216);
  });
});

describe("isAdoptableHealthCode", () => {
  it("accepts serving codes (2xx/3xx/401/403) and rejects not-ready ones", () => {
    for (const ok of [200, 204, 301, 302, 307, 308, 401, 403]) {
      expect(isAdoptableHealthCode(ok)).toBe(true);
    }
    for (const bad of [0, 404, 500, 502, 503]) {
      expect(isAdoptableHealthCode(bad)).toBe(false);
    }
    expect(isAdoptableHealthCode(null)).toBe(false);
  });
});

describe("DISCOVERY_SCRIPT", () => {
  it("follows redirects so an auth-gated /health resolves instead of capturing the bare 302", () => {
    expect(DISCOVERY_SCRIPT).toContain("curl -sSL");
    expect(DISCOVERY_SCRIPT).not.toContain("curl -s -o /dev/null");
  });
});

describe("gatewayHostFromUrl", () => {
  it("extracts the host from a gateway url", () => {
    expect(gatewayHostFromUrl("https://00000000000000000000.hermesos.cloud")).toBe(
      "00000000000000000000.hermesos.cloud",
    );
    expect(gatewayHostFromUrl("https://x.agents.hermesos.cloud/health")).toBe("x.agents.hermesos.cloud");
  });
});

describe("buildReapScript", () => {
  it("only emits reap calls for well-formed hermes-<uuid> names within vmid range", () => {
    const script = buildReapScript([
      { vmid: 1216, expectedName: `hermes-${ID_A}` },
      { vmid: 1230, expectedName: `hermes-${ID_B}` },
      { vmid: 9007, expectedName: `hermes-${ID_A}` }, // template range — dropped
      { vmid: 1240, expectedName: "hermes-not-a-uuid" }, // bad name — dropped
    ]);
    expect(script).toContain(`reap_one 1216 hermes-${ID_A}`);
    expect(script).toContain(`reap_one 1230 hermes-${ID_B}`);
    expect(script).not.toContain("9007");
    expect(script).not.toContain("not-a-uuid");
    // the runtime name re-check guard must be present
    expect(script).toContain('if [ "$name" != "$expect" ]');
  });
});

describe("countReaped", () => {
  it("counts only REAP_OK lines", () => {
    const out = ["REAP_OK 1216", "REAP_SKIP_NAME 1230 hermes-other", "REAP_FAIL 1240", "REAP_OK 1250"].join("\n");
    expect(countReaped(out)).toBe(2);
  });
});

describe("summarizeFleetDiscovery", () => {
  const okHost = (hostSlug: string, vms: DiscoveredAgentVm[]): HostDiscoveryOutcome => ({
    hostSlug,
    ok: true,
    vms,
  });

  it("reports complete=true and flattens VMs when every host scanned", () => {
    const out = summarizeFleetDiscovery([
      okHost("fixturenode11", [vm({ vmid: 1121, name: `hermes-${ID_A}` })]),
      okHost("fixturenode12", [vm({ vmid: 1230, name: `hermes-${ID_B}` })]),
    ]);
    expect(out.complete).toBe(true);
    expect(out.failedHosts).toEqual([]);
    expect(out.vms.map((v) => v.vmid).sort()).toEqual([1121, 1230]);
  });

  it("reports complete=false when any host scan failed (2026-07-07 leak class)", () => {
    // The clone for a stranded restore lived on fixturenodea, whose discovery scan
    // timed out. Treating the failed scan as "no clones" made the sweep reset
    // the row to cold_archived while the clone kept running — every subsequent
    // Start then leaked another clone. A failed host MUST poison completeness.
    const out = summarizeFleetDiscovery([
      { hostSlug: "fixturenode11", ok: false, vms: [] },
      okHost("fixturenode12", []),
    ]);
    expect(out.complete).toBe(false);
    expect(out.failedHosts).toEqual(["fixturenode11"]);
  });

  it("reports complete=false with no outcomes conflated into the VM list", () => {
    const out = summarizeFleetDiscovery([
      { hostSlug: "fixturenode11", ok: false, vms: [vm({ vmid: 1121, name: `hermes-${ID_A}` })] },
    ]);
    // Defensive: a failed outcome's vms are never trusted.
    expect(out.vms).toEqual([]);
    expect(out.complete).toBe(false);
  });
});

describe("ORPHAN_RESTORE_CANDIDATE_LIFECYCLE_STATES", () => {
  it("covers restoring, failed, AND provisioning (Platinum fixturecase12 shape)", () => {
    // A user Redeploy / auto-restart over a stranded restore stamps
    // status='redeploying' → lifecycle_state='provisioning' without touching
    // lifecycle_substate='restoring_starting'. Omitting 'provisioning' left
    // that row (and its running clone) invisible to the self-heal for days.
    expect([...ORPHAN_RESTORE_CANDIDATE_LIFECYCLE_STATES].sort()).toEqual([
      "failed",
      "provisioning",
      "restoring",
    ]);
  });
});

describe("orphan restore claim safety", () => {
  const now = "2026-11-20T13:00:00.000Z";
  const candidate = {
    id: ID_A,
    user_id: "user_fixture",
    gateway_url: "https://fixture.example.com",
    config: null,
    proxmox_node: null,
    archive_uri: `free/${ID_A}/data-20261119T130000Z.tar.zst`,
    archive_sha256: "a".repeat(64),
    last_lifecycle_transition_at: "2026-11-20T12:40:00.000Z",
  };
  const locate = jest.mocked(locateProxmoxInstanceAcrossFleet);
  const host = jest.mocked(runProxmoxHostScript);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(now));
    locate.mockResolvedValue({ status: "gone" });
    host.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    jest.mocked(applyRestoreRouting).mockResolvedValue({ hostCaddy: { ok: true } } as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mockQueries(rows = [candidate], total = rows.length) {
    const selection = {
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      // The page fetch carries `count: "exact"`: the response's `count` is the
      // filter's total, not the slice length.
      range: jest.fn().mockImplementation(
        async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null, count: total }),
      ),
    };
    const write = {
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: ID_A }, error: null }),
    };
    const update = jest.fn().mockReturnValue(write);
    jest.mocked(supabaseAdmin!.from).mockImplementation((table) => {
      if (table === "proxmox_hosts") {
        return { select: () => ({ in: async () => ({ data: [{ id: "fixture" }], error: null }) }) } as never;
      }
      return { select: () => selection, update } as never;
    });
    return { selection, write, update };
  }

  it("waits beyond the full restore budget and checks the authoritative inventory before resetting", async () => {
    const { selection, write, update } = mockQueries();
    const summary = await runColdRestoreOrphanAdoptionSweep();
    expect(selection.lt).toHaveBeenCalledWith("last_lifecycle_transition_at", "2026-11-20T12:45:00.000Z");
    expect(locate).toHaveBeenCalledWith(candidate);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ lifecycle_state: "cold_archived" }));
    expect(write.eq).toHaveBeenCalledWith("last_lifecycle_transition_at", candidate.last_lifecycle_transition_at);
    expect(write.eq).toHaveBeenCalledWith("archive_uri", candidate.archive_uri);
    expect(summary.resetToCold).toBe(1);
  });

  it.each(["inconclusive", "found"] as const)("retains the claim when strict discovery reports %s", async (status) => {
    const { update } = mockQueries();
    locate.mockResolvedValue(status === "inconclusive" ? { status } : {
      status,
      found: { hostSlug: "maintenance-host", vmid: 231, privateIpv4: "192.0.2.4", gatewayFqdn: "fixture.example.com" },
    });
    const summary = await runColdRestoreOrphanAdoptionSweep();
    expect(update).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ resetToCold: 0, stillPending: 1 });
  });

  it("leaves a newer claim in place if the reset compare-and-set lost", async () => {
    const { write } = mockQueries();
    write.maybeSingle.mockResolvedValue({ data: null, error: null });
    const summary = await runColdRestoreOrphanAdoptionSweep();
    expect(write.eq).toHaveBeenCalledWith("last_lifecycle_transition_at", candidate.last_lifecycle_transition_at);
    expect(summary).toMatchObject({ resetToCold: 0, stillPending: 1 });
  });

  it("keeps positive adoption and binds both writes to the corresponding claim", async () => {
    const { write, update } = mockQueries();
    host.mockResolvedValue({ ok: true, stdout: `VMINFO 231 hermes-${ID_A} 192.0.2.4 200`, stderr: "" });
    const summary = await runColdRestoreOrphanAdoptionSweep();
    expect(locate).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(2);
    expect(write.eq).toHaveBeenCalledWith("last_lifecycle_transition_at", candidate.last_lifecycle_transition_at);
    expect(write.eq).toHaveBeenCalledWith("last_lifecycle_transition_at", now);
    expect(summary.adopted).toBe(1);
  });

  it("walks the whole matching set across sweeps instead of re-reading the first page", async () => {
    // Regression: the loader used to fetch a fixed 25 rows. When the front of
    // the set kept stopped clones — inconclusive locates that keep the row a
    // candidate forever — the same 25 loaded every sweep and candidate 26+
    // was never even fetched. The selection now rotates a bounded page across
    // the whole matching set on a deterministic order.
    const stuck = Array.from({ length: 25 }, (_, i) => ({
      ...candidate,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    const deep = { ...candidate, id: "00000000-0000-4000-8000-0000000000ff26" };
    const { selection } = mockQueries([...stuck, deep], 26);
    // The front page's clones are stopped (inconclusive → claims retained);
    // the deep candidate's is actually gone.
    locate.mockImplementation(async (c: { id: string }) =>
      c.id === deep.id ? { status: "gone" as const } : { status: "inconclusive" as const },
    );

    // Bucket 4 → page 0: the sweep sees only the front window, and the deep
    // candidate is never fetched (so never checked).
    jest.setSystemTime(new Date(2 * 60_000 * 4));
    const first = await runColdRestoreOrphanAdoptionSweep();
    expect(selection.range).toHaveBeenCalledWith(0, 24);
    expect(locate).not.toHaveBeenCalledWith(expect.objectContaining({ id: deep.id }));
    expect(first.resetToCold).toBe(0);
    expect(first.stillPending).toBe(25);

    // Bucket 5 → page 1: the window advanced — the tail candidate is loaded,
    // absence-checked, and reset under the same stopped-clone gate.
    jest.setSystemTime(new Date(2 * 60_000 * 5));
    const second = await runColdRestoreOrphanAdoptionSweep();
    expect(selection.range).toHaveBeenCalledWith(25, 49);
    expect(locate).toHaveBeenCalledWith(expect.objectContaining({ id: deep.id }));
    expect(second.resetToCold).toBe(1);
  });
});
