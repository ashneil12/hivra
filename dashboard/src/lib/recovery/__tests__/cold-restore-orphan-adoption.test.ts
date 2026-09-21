import {
  parseDiscoveredVms,
  matchVmsToCandidates,
  pickKeeper,
  isAdoptableHealthCode,
  gatewayHostFromUrl,
  buildReapScript,
  countReaped,
  summarizeFleetDiscovery,
  DISCOVERY_SCRIPT,
  ORPHAN_RESTORE_CANDIDATE_LIFECYCLE_STATES,
  type DiscoveredAgentVm,
  type HostDiscoveryOutcome,
} from "@/lib/recovery/cold-restore-orphan-adoption";

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
