import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import {
  buildOrphanLvReapScript,
  buildRestoreCloneStopScript,
  classifyLeakedRestoreClones,
  computeOrphansForHost,
  filterUnownedOrphanLvs,
  findOrphanVmids,
  instanceIdFromVmName,
  isOrphanLvReapEnabled,
  isRestoreCloneReaperEnabled,
  isSafeVgLvPath,
  loadDbVmidsForHost,
  loadInstanceRowsByIds,
  loadLaneBindingTags,
  parseLiveVmsFromHostScript,
  parseOrphanLvReapOutput,
  parseOrphanLvsFromHostScript,
  parseRestoreCloneStopOutput,
  partitionOrphanVmAlerts,
  PROXMOX_ORPHAN_DISCOVERY_SCRIPT,
  PROXMOX_ORPHAN_DISCOVERY_TIMEOUT_MS,
  TEMPLATE_VMID_THRESHOLD,
  type InstanceLifecycleRow,
  type ProxmoxOrphanVm,
} from "../proxmox-orphan-detection";

describe("orphan discovery host budget", () => {
  it("allows the production LVM scan at least 90 seconds per host", () => {
    expect(PROXMOX_ORPHAN_DISCOVERY_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
  });
});

describe("orphan LV guest ownership guards", () => {
  it("excludes disks owned by either a QEMU VM or an LXC container", () => {
    expect(PROXMOX_ORPHAN_DISCOVERY_SCRIPT).toContain(
      'qm config "$lv_vmid" >/dev/null 2>&1 || pct config "$lv_vmid" >/dev/null 2>&1',
    );
  });
});

describe("orphan LV database ownership guard", () => {
  it("never reaps a config-less LV whose VMID is still owned by a live DB row", () => {
    const candidates = [
      { vmid: 1010, vgLv: "vg0/vm-1010-disk-0" },
      { vmid: 1246, vgLv: "vg0/vm-1246-disk-0" },
    ];

    expect(filterUnownedOrphanLvs(candidates, [1010])).toEqual([
      { vmid: 1246, vgLv: "vg0/vm-1246-disk-0" },
    ]);
  });
});

// Fixture mirroring real bundled SSH script output: one BEGIN/END block per
// running VM with a small subset of `qm config` lines.
const SAMPLE_STDOUT = `
BEGIN 401
name: hermes-power-1a2b3c4d
memory: 8192
cores: 4
END 401
BEGIN 407
name: canary-407
memory: 4096
cores: 2
END 407
BEGIN 412
name: hermes-free-aabbccdd
memory: 1024
cores: 1
END 412
BEGIN 9004
name: hermes-template
memory: 2048
cores: 2
END 9004
`;

describe("parseLiveVmsFromHostScript", () => {
  it("parses BEGIN/END blocks into typed live VM records", () => {
    const live = parseLiveVmsFromHostScript(SAMPLE_STDOUT);
    expect(live).toEqual([
      { vmid: 401, name: "hermes-power-1a2b3c4d", memoryMb: 8192, cores: 4, tags: [] },
      { vmid: 407, name: "canary-407", memoryMb: 4096, cores: 2, tags: [] },
      { vmid: 412, name: "hermes-free-aabbccdd", memoryMb: 1024, cores: 1, tags: [] },
    ]);
  });

  it("captures the VM's qm tags so lane attribution can see them", () => {
    const live = parseLiveVmsFromHostScript(`
BEGIN 401
name: hivra-cc-401
memory: 4096
cores: 2
tags: hivra-bind-${"a".repeat(32)};hivra-op-${"b".repeat(32)}
END 401
`);
    expect(live).toEqual([
      expect.objectContaining({
        vmid: 401,
        tags: [`hivra-bind-${"a".repeat(32)}`, `hivra-op-${"b".repeat(32)}`],
      }),
    ]);
  });

  it("drops template VMIDs (>= 9000) from the parsed list", () => {
    const live = parseLiveVmsFromHostScript(SAMPLE_STDOUT);
    expect(live.find((vm) => vm.vmid >= TEMPLATE_VMID_THRESHOLD)).toBeUndefined();
  });

  it("returns [] when stdout has no BEGIN/END blocks", () => {
    expect(parseLiveVmsFromHostScript("")).toEqual([]);
    expect(parseLiveVmsFromHostScript("noise\nlines\n")).toEqual([]);
  });

  it("tolerates missing optional fields (records null)", () => {
    const stdout = `BEGIN 500\nname: partial-only\nEND 500\n`;
    expect(parseLiveVmsFromHostScript(stdout)).toEqual([
      { vmid: 500, name: "partial-only", memoryMb: null, cores: null, tags: [] },
    ]);
  });

  it("ignores unrecognised config keys inside a block", () => {
    const stdout = `BEGIN 501\ncpu: kvm64\nname: with-extras\nmemory: 2048\nboot: order=scsi0\ncores: 2\nEND 501\n`;
    expect(parseLiveVmsFromHostScript(stdout)).toEqual([
      { vmid: 501, name: "with-extras", memoryMb: 2048, cores: 2, tags: [] },
    ]);
  });
});

describe("findOrphanVmids", () => {
  it("returns live VMIDs not present in the DB result", () => {
    expect(findOrphanVmids([401, 407, 412], [401, 412])).toEqual([407]);
  });

  it("returns [] when every live VMID has a DB row", () => {
    expect(findOrphanVmids([401, 412], [401, 412, 999])).toEqual([]);
  });

  it("returns the full live list when DB has no matching rows", () => {
    expect(findOrphanVmids([401, 412], [])).toEqual([401, 412]);
  });

  it("returns [] when live VMIDs are empty", () => {
    expect(findOrphanVmids([], [401, 412])).toEqual([]);
  });
});

describe("computeOrphansForHost", () => {
  it("flags canary-407-style orphans (live VM with no DB row)", () => {
    // Simulates the 2026-05-12 fixturenodea incident: 407 is running on the host
    // but only 401 and 412 have hermes_instances rows.
    const live = parseLiveVmsFromHostScript(SAMPLE_STDOUT);
    const dbVmids = [401, 412];

    const orphans = computeOrphansForHost("fixturenode4", live, dbVmids);

    expect(orphans).toEqual([
      {
        hostId: "fixturenode4",
        vmid: 407,
        name: "canary-407",
        memoryMb: 4096,
        cores: 2,
        tags: [],
      },
    ]);
  });

  it("never flags the other lane's computers on a shared host", () => {
    // Prod 2026-11: canary-lane agent VMs sit on the same physical hosts as
    // production ones. Their hivra-bind tag derives from a row in the OTHER
    // deployment's database — unreachable here — so the old vmid-only claim
    // reported every running canary box as an orphan forever.
    const mine = `hivra-bind-${"a".repeat(32)}`;
    const foreign = `hivra-bind-${"b".repeat(32)}`;
    const live = [
      { vmid: 401, name: "hivra-cc-401", memoryMb: 4096, cores: 2, tags: [foreign, "hivra-op-x"] },
      { vmid: 402, name: "hivra-cc-402", memoryMb: 4096, cores: 2, tags: [mine, "hivra-op-y"] },
      { vmid: 403, name: "hivra-cc-403", memoryMb: 4096, cores: 2, tags: [] },
      { vmid: 404, name: "hivra-guacamole-canary", memoryMb: 2048, cores: 2, tags: [] },
    ];
    const orphans = computeOrphansForHost("fixturenode4", live, [], new Set([mine]));
    // 401 is foreign-lane, 404 is a canary fixture — both are another lane's
    // business. 402 is ours-but-unclaimed and 403 is unattributed: real orphans.
    expect(orphans.map((vm) => vm.vmid)).toEqual([402, 403]);
  });

  it("still flags a VM tagged with our lane when no live row claims its vmid", () => {
    const mine = `hivra-bind-${"c".repeat(32)}`;
    const live = [{ vmid: 401, name: "hivra-cc-401", memoryMb: 4096, cores: 2, tags: [mine] }];
    const orphans = computeOrphansForHost("fixturenode4", live, [], new Set([mine]));
    expect(orphans.map((vm) => vm.vmid)).toEqual([401]);
  });

  it("keeps flagging bind-tagged VMs when the lane set is not provided", () => {
    const live = [{ vmid: 401, name: "hivra-cc-401", memoryMb: 4096, cores: 2, tags: [`hivra-bind-${"d".repeat(32)}`] }];
    const orphans = computeOrphansForHost("fixturenode4", live, []);
    expect(orphans.map((vm) => vm.vmid)).toEqual([401]);
  });

  it("returns [] when every live VM has a corresponding DB row", () => {
    const live = parseLiveVmsFromHostScript(SAMPLE_STDOUT);
    const dbVmids = [401, 407, 412];

    expect(computeOrphansForHost("fixturenode4", live, dbVmids)).toEqual([]);
  });

  it("skips template-range VMIDs even if accidentally passed through", () => {
    const liveWithTemplate = [
      { vmid: 401, name: "hermes-power", memoryMb: 8192, cores: 4 },
      { vmid: 9004, name: "hermes-template", memoryMb: 2048, cores: 2 },
      { vmid: 9005, name: "hermes-template-alt", memoryMb: 2048, cores: 2 },
    ];
    // 401 is in DB; template VMIDs are not — but they must still be skipped,
    // not reported as orphans.
    expect(computeOrphansForHost("fixturenode4", liveWithTemplate, [401])).toEqual([]);
  });

  it("stamps the correct hostId on each orphan", () => {
    const live = [{ vmid: 500, name: "stray", memoryMb: 1024, cores: 1 }];
    const orphans = computeOrphansForHost("fixturenode2", live, []);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.hostId).toBe("fixturenode2");
  });
});

describe("partitionOrphanVmAlerts", () => {
  const hostId = "test-node";
  const tag = "hivra-operator-test-node+401+operator-service";
  const [vm] = parseLiveVmsFromHostScript(`
BEGIN 401
name: operator-service
tags: keep-existing;${tag}
END 401
`);

  it("reports an exact operator registration separately and still alerts on ordinary orphans", () => {
    const untagged = { ...vm, vmid: 402, tags: [] };
    const candidates = computeOrphansForHost(hostId, [vm, untagged], []);

    expect(partitionOrphanVmAlerts(candidates)).toEqual({
      orphans: [{ ...untagged, hostId }],
      operatorVmids: [401],
    });
  });

  it.each([
    ["another host", { hostId: "other-node" }],
    ["a copied tag on a clone", { vmid: 402 }],
    ["a renamed VM", { name: "replacement" }],
    ["missing config metadata", { name: null }],
    ["an extended tag rather than an exact match", { tags: [`${tag}-extra`] }],
    ["an existing bind tag", { tags: [tag, `hivra-bind-${"a".repeat(32)}`] }],
    ["an existing managed operation tag", { tags: [tag, `hivra-op-${"b".repeat(32)}`] }],
    ["a restore clone", {
      name: "hermes-00000000-0000-4000-8000-000000000001",
      tags: ["hivra-operator-test-node+401+hermes-00000000-0000-4000-8000-000000000001"],
    }],
  ])("keeps alerting on %s", (_description, overrides) => {
    const candidate = { ...vm, hostId, ...overrides };

    expect(partitionOrphanVmAlerts([candidate])).toEqual({
      orphans: [candidate],
      operatorVmids: [],
    });
  });
});

describe("parseOrphanLvsFromHostScript", () => {
  it("parses ORPHAN_LV lines (config-less vm-<vmid>-* LVs) emitted alongside VM blocks", () => {
    // Same stdout the discovery script emits: BEGIN/END VM blocks PLUS
    // ORPHAN_LV lines for leftover LVs whose VMID has no qemu-server config.
    const stdout = `
BEGIN 401
name: hermes-power
memory: 8192
cores: 4
END 401
ORPHAN_LV 1246 vg0/vm-1246-cloudinit
ORPHAN_LV 1246 vg0/vm-1246-disk-0
ORPHAN_LV 1250 vg0/vm-1250-disk-0
`;
    expect(parseOrphanLvsFromHostScript(stdout)).toEqual([
      { vmid: 1246, vgLv: "vg0/vm-1246-cloudinit" },
      { vmid: 1246, vgLv: "vg0/vm-1246-disk-0" },
      { vmid: 1250, vgLv: "vg0/vm-1250-disk-0" },
    ]);
  });

  it("ignores the VM blocks so it composes with parseLiveVmsFromHostScript over the same stdout", () => {
    const stdout = `BEGIN 401\nname: x\nEND 401\nORPHAN_LV 1246 vg0/vm-1246-cloudinit\n`;
    // Live-VM parser ignores ORPHAN_LV lines; orphan-LV parser ignores blocks.
    expect(parseLiveVmsFromHostScript(stdout)).toEqual([
      { vmid: 401, name: "x", memoryMb: null, cores: null, tags: [] },
    ]);
    expect(parseOrphanLvsFromHostScript(stdout)).toEqual([
      { vmid: 1246, vgLv: "vg0/vm-1246-cloudinit" },
    ]);
  });

  it("drops template-range and malformed VMIDs", () => {
    const stdout = [
      `ORPHAN_LV ${TEMPLATE_VMID_THRESHOLD} vg0/vm-9000-disk-0`,
      "ORPHAN_LV 0 vg0/vm-0-disk-0",
      "ORPHAN_LV 1246 vg0/vm-1246-disk-0",
    ].join("\n");
    expect(parseOrphanLvsFromHostScript(stdout)).toEqual([
      { vmid: 1246, vgLv: "vg0/vm-1246-disk-0" },
    ]);
  });

  it("rejects unsafe vg/lv paths (defends interpolation into lvremove)", () => {
    const stdout = "ORPHAN_LV 1246 vg0/vm-1246;rm -rf /\n";
    // The `\S+` capture stops at whitespace, but a metachar-laden path is
    // still rejected by the strict name filter rather than reaching lvremove.
    expect(parseOrphanLvsFromHostScript(stdout)).toEqual([]);
  });

  it("returns [] for empty / noise-only output", () => {
    expect(parseOrphanLvsFromHostScript("")).toEqual([]);
    expect(parseOrphanLvsFromHostScript("noise\nORPHAN_LV malformed\n")).toEqual([]);
  });
});

describe("isSafeVgLvPath", () => {
  it("accepts real Proxmox vg/lv names", () => {
    expect(isSafeVgLvPath("vg0/vm-1246-cloudinit")).toBe(true);
    expect(isSafeVgLvPath("pve/vm-101-disk-0")).toBe(true);
    expect(isSafeVgLvPath("data.vg+1/vm-101-state-snap")).toBe(true);
  });

  it("rejects paths with shell metacharacters, spaces, or no slash", () => {
    expect(isSafeVgLvPath("vg0/vm-1246;rm -rf /")).toBe(false);
    expect(isSafeVgLvPath("vg0/vm 1246")).toBe(false);
    expect(isSafeVgLvPath("vm-1246-disk-0")).toBe(false);
    expect(isSafeVgLvPath("$(touch x)/lv")).toBe(false);
    expect(isSafeVgLvPath("")).toBe(false);
  });
});

describe("buildOrphanLvReapScript", () => {
  const candidates = [
    { vmid: 1246, vgLv: "vg0/vm-1246-cloudinit" },
    { vmid: 1246, vgLv: "vg0/vm-1246-disk-0" },
  ];

  it("re-checks QEMU and LXC config before lvremove (TOCTOU guard)", () => {
    const script = buildOrphanLvReapScript(candidates);
    expect(script).toContain(
      'qm config "$vmid" >/dev/null 2>&1 || pct config "$vmid" >/dev/null 2>&1',
    );
    expect(script).toContain("ORPHAN_LV_REAP_SKIP_HAS_CONFIG");
    expect(script).toContain('lvremove -f "$lvpath"');
    expect(script).toContain("ORPHAN_LV_REAP_OK");
    // Path must still match */vm-<vmid>-* at run time.
    expect(script).toContain('*/vm-"$vmid"-*) ;;');
    // One reap_one call per (quoted) candidate.
    expect(script).toContain("reap_one '1246' 'vg0/vm-1246-cloudinit'");
    expect(script).toContain("reap_one '1246' 'vg0/vm-1246-disk-0'");
  });

  it("drops unsafe candidates instead of interpolating them into the script", () => {
    const script = buildOrphanLvReapScript([
      { vmid: 1246, vgLv: "vg0/vm-1246-cloudinit" },
      { vmid: 1, vgLv: "vg0/vm-1; rm -rf /" },
      { vmid: Number.NaN, vgLv: "vg0/vm-2-disk-0" },
    ]);
    expect(script).toContain("reap_one '1246' 'vg0/vm-1246-cloudinit'");
    expect(script).not.toContain("rm -rf /");
    expect(script).not.toContain("NaN");
  });
});

describe("parseOrphanLvReapOutput", () => {
  it("buckets reap result lines into removed / skipped / failed", () => {
    const stdout = [
      "ORPHAN_LV_REAP_OK 1246 vg0/vm-1246-cloudinit",
      "ORPHAN_LV_REAP_OK 1246 vg0/vm-1246-disk-0",
      "ORPHAN_LV_REAP_SKIP_HAS_CONFIG 1250 vg0/vm-1250-disk-0",
      "ORPHAN_LV_REAP_SKIP_BAD_PATH 1251 vg0/other",
      "ORPHAN_LV_REAP_FAIL 1252 vg0/vm-1252-disk-0",
      "unrelated noise",
    ].join("\n");
    expect(parseOrphanLvReapOutput(stdout)).toEqual({
      removed: ["vg0/vm-1246-cloudinit", "vg0/vm-1246-disk-0"],
      skipped: ["vg0/vm-1250-disk-0", "vg0/other"],
      failed: ["vg0/vm-1252-disk-0"],
    });
  });

  it("returns empty buckets for no recognizable lines", () => {
    expect(parseOrphanLvReapOutput("")).toEqual({ removed: [], skipped: [], failed: [] });
  });
});

describe("isOrphanLvReapEnabled", () => {
  it("is OFF by default and only on for an explicit 'true'", () => {
    expect(isOrphanLvReapEnabled({})).toBe(false);
    expect(isOrphanLvReapEnabled({ HERMES_ORPHAN_LV_REAP_ENABLED: "false" })).toBe(false);
    expect(isOrphanLvReapEnabled({ HERMES_ORPHAN_LV_REAP_ENABLED: "1" })).toBe(false);
    expect(isOrphanLvReapEnabled({ HERMES_ORPHAN_LV_REAP_ENABLED: "  TRUE " })).toBe(true);
    expect(isOrphanLvReapEnabled({ HERMES_ORPHAN_LV_REAP_ENABLED: "true" })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Leaked restore clones (2026-07-07 incident class: 24 orphan VMs manufactured
// by the cold-restore retry loop — running onboot=1 clones named
// hermes-<instanceId> whose rows are cold_archived/deleted with a NULL vmid).
// ─────────────────────────────────────────────────────────────────────────────

const LEAK_ID_A = "00000000-0000-4000-8000-000000001046";
const LEAK_ID_B = "00000000-0000-4000-8000-000000001001";

function orphanVm(p: Partial<ProxmoxOrphanVm> & { vmid: number; name: string | null }): ProxmoxOrphanVm {
  return { hostId: "fixturenode11", memoryMb: 4096, cores: 2, ...p };
}

describe("loadInstanceRowsByIds", () => {
  it("looks up at most 100 ids per request and merges every chunk", async () => {
    const ids = Array.from(
      { length: 250 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const inCalls: string[][] = [];
    const supabase = {
      from: () => ({
        select: () => ({
          in: async (_column: string, list: string[]) => {
            inCalls.push(list);
            return {
              data: list.map((id) => ({ id, lifecycle_state: "cold_archived", proxmox_vmid: null })),
              error: null,
            };
          },
        }),
      }),
    };

    const rows = await loadInstanceRowsByIds(supabase as never, ids);

    expect(inCalls.map((list) => list.length)).toEqual([100, 100, 50]);
    expect(rows.size).toBe(250);
    expect(rows.get(ids[249]!)?.lifecycle_state).toBe("cold_archived");
  });
});

describe("instanceIdFromVmName", () => {
  it("extracts the uuid from the restore-clone signature hermes-<uuid>", () => {
    expect(instanceIdFromVmName(`hermes-${LEAK_ID_A}`)).toBe(LEAK_ID_A);
  });

  it("accepts a bare uuid name", () => {
    expect(instanceIdFromVmName(LEAK_ID_B)).toBe(LEAK_ID_B);
  });

  it("rejects provisioned-VM names (hermes-<name>-<id8>), templates, and noise", () => {
    expect(instanceIdFromVmName("hermes-power-1a2b3c4d")).toBeNull();
    expect(instanceIdFromVmName("hermes-free-aabbccdd")).toBeNull();
    expect(instanceIdFromVmName("hermes-template")).toBeNull();
    expect(instanceIdFromVmName("canary-407")).toBeNull();
    expect(instanceIdFromVmName(`wc-${LEAK_ID_A}`)).toBeNull();
    expect(instanceIdFromVmName(`hermes-${LEAK_ID_A}-extra`)).toBeNull();
    expect(instanceIdFromVmName("")).toBeNull();
    expect(instanceIdFromVmName(null)).toBeNull();
    expect(instanceIdFromVmName(undefined)).toBeNull();
  });
});

describe("classifyLeakedRestoreClones", () => {
  const rows = (entries: InstanceLifecycleRow[]): Map<string, InstanceLifecycleRow> =>
    new Map(entries.map((r) => [r.id, r]));

  it("classifies a running clone of a cold_archived row with NULL vmid (fixturecase11 shape)", () => {
    const out = classifyLeakedRestoreClones(
      "fixturenode11",
      [orphanVm({ vmid: 1148, name: `hermes-${LEAK_ID_A}` })],
      rows([{ id: LEAK_ID_A, lifecycle_state: "cold_archived", proxmox_vmid: null }]),
    );
    expect(out).toEqual([
      {
        hostId: "fixturenode11",
        vmid: 1148,
        name: `hermes-${LEAK_ID_A}`,
        instanceId: LEAK_ID_A,
        lifecycleState: "cold_archived",
      },
    ]);
  });

  it("classifies a deleted-row clone too", () => {
    const out = classifyLeakedRestoreClones(
      "fixturenode19",
      [orphanVm({ vmid: 1910, name: `hermes-${LEAK_ID_B}`, hostId: "fixturenode19" })],
      rows([{ id: LEAK_ID_B, lifecycle_state: "deleted", proxmox_vmid: null }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.lifecycleState).toBe("deleted");
  });

  it("NEVER classifies when the row still points at a vmid (another reconciler owns it)", () => {
    const out = classifyLeakedRestoreClones(
      "fixturenode11",
      [orphanVm({ vmid: 1104, name: `hermes-${LEAK_ID_A}` })],
      rows([{ id: LEAK_ID_A, lifecycle_state: "cold_archived", proxmox_vmid: 1110 }]),
    );
    expect(out).toEqual([]);
  });

  it("NEVER classifies live/transitional rows (active, restoring, provisioning, paused)", () => {
    for (const state of ["active", "restoring", "provisioning", "paused", "failed"]) {
      const out = classifyLeakedRestoreClones(
        "fixturenode11",
        [orphanVm({ vmid: 1140, name: `hermes-${LEAK_ID_A}` })],
        rows([{ id: LEAK_ID_A, lifecycle_state: state, proxmox_vmid: null }]),
      );
      expect(out).toEqual([]);
    }
  });

  it("ignores orphans with no matching row (plain orphans stay in the generic bucket)", () => {
    const out = classifyLeakedRestoreClones(
      "fixturenode11",
      [orphanVm({ vmid: 1148, name: `hermes-${LEAK_ID_A}` })],
      rows([]),
    );
    expect(out).toEqual([]);
  });

  it("ignores orphans whose names are not a uuid signature", () => {
    const out = classifyLeakedRestoreClones(
      "fixturenode11",
      [orphanVm({ vmid: 407, name: "canary-407" }), orphanVm({ vmid: 500, name: null })],
      rows([{ id: LEAK_ID_A, lifecycle_state: "cold_archived", proxmox_vmid: null }]),
    );
    expect(out).toEqual([]);
  });

  it("defensively drops template-range vmids even if passed through", () => {
    const out = classifyLeakedRestoreClones(
      "fixturenode11",
      [orphanVm({ vmid: 9007, name: `hermes-${LEAK_ID_A}` })],
      rows([{ id: LEAK_ID_A, lifecycle_state: "cold_archived", proxmox_vmid: null }]),
    );
    expect(out).toEqual([]);
  });
});

describe("buildRestoreCloneStopScript", () => {
  it("contains NO qm destroy — the sweep stops and flags, destruction stays human", () => {
    const script = buildRestoreCloneStopScript([
      { vmid: 1148, expectedName: `hermes-${LEAK_ID_A}` },
    ]);
    expect(script).not.toContain("qm destroy");
    expect(script).not.toContain("lvremove");
    expect(script).toContain('qm stop "$vmid" --timeout 25');
  });

  it("re-checks the exact observed name at run time (guard blocks a mismatched name)", () => {
    const script = buildRestoreCloneStopScript([
      { vmid: 1148, expectedName: `hermes-${LEAK_ID_A}` },
    ]);
    // The skip-on-name-mismatch guard must gate the stop: a VMID recycled to
    // another tenant between detect and stop reports a different name and is
    // left untouched.
    expect(script).toContain('if [ "${name:-}" != "$expect" ]; then echo "CLONE_STOP_SKIP_NAME');
    const guardIdx = script.indexOf("CLONE_STOP_SKIP_NAME");
    const stopIdx = script.indexOf('qm stop "$vmid"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(guardIdx);
  });

  it("drops template-range vmids and non-signature names at build time", () => {
    const script = buildRestoreCloneStopScript([
      { vmid: 9007, expectedName: `hermes-${LEAK_ID_A}` }, // template — dropped
      { vmid: 9100, expectedName: `hermes-${LEAK_ID_A}` }, // reserved — dropped
      { vmid: 1240, expectedName: "hermes-not-a-uuid" }, // bad name — dropped
      { vmid: 0, expectedName: `hermes-${LEAK_ID_A}` }, // bad vmid — dropped
      { vmid: 1148, expectedName: `hermes-${LEAK_ID_A}` }, // kept
    ]);
    expect(script).toContain(`stop_one '1148' 'hermes-${LEAK_ID_A}'`);
    expect(script).not.toContain("9007");
    expect(script).not.toContain("9100");
    expect(script).not.toContain("not-a-uuid");
    expect(script).not.toContain("'0'");
  });
});

describe("parseRestoreCloneStopOutput", () => {
  it("buckets stop result lines into stopped / skipped / failed", () => {
    const stdout = [
      "CLONE_STOP_OK 1148",
      "CLONE_STOP_SKIP_NAME 1121 hermes-recycled-tenant",
      "CLONE_STOP_FAIL 1139",
      "noise",
    ].join("\n");
    expect(parseRestoreCloneStopOutput(stdout)).toEqual({
      stopped: [1148],
      skipped: [1121],
      failed: [1139],
    });
  });

  it("returns empty buckets for empty output", () => {
    expect(parseRestoreCloneStopOutput("")).toEqual({ stopped: [], skipped: [], failed: [] });
  });
});

describe("isRestoreCloneReaperEnabled", () => {
  it("is OFF by default and only on for an explicit 'true'", () => {
    expect(isRestoreCloneReaperEnabled({})).toBe(false);
    expect(isRestoreCloneReaperEnabled({ HERMES_RESTORE_CLONE_REAPER_ENABLED: "false" })).toBe(false);
    expect(isRestoreCloneReaperEnabled({ HERMES_RESTORE_CLONE_REAPER_ENABLED: "1" })).toBe(false);
    expect(isRestoreCloneReaperEnabled({ HERMES_RESTORE_CLONE_REAPER_ENABLED: "true" })).toBe(true);
    expect(isRestoreCloneReaperEnabled({ HERMES_RESTORE_CLONE_REAPER_ENABLED: " TRUE " })).toBe(true);
  });
});

describe("loadDbVmidsForHost", () => {
  // PostgREST caps every response at max_rows even when the query asks for
  // more — the fake applies the same cap so a read that stops paginating
  // silently loses rows exactly like production would.
  const FAKE_POSTGREST_MAX_ROWS = 1000;
  type Row = Record<string, unknown>;

  const FILTER_METHODS = new Set(["eq", "neq", "is", "not", "gt", "gte", "lt", "lte", "in"]);

  function columnValue(row: Row, column: string): unknown {
    return row[column];
  }

  function valuesEqual(a: unknown, b: unknown): boolean {
    if (a == null || b == null) return false;
    return a === b || String(a) === String(b);
  }

  function compareValues(a: unknown, b: unknown): number {
    const sa = String(a);
    const sb = String(b);
    const na = Number(a);
    const nb = Number(b);
    if (sa.trim() !== "" && sb.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
      return na - nb;
    }
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  function rowMatches(row: Row, call: unknown[]): boolean {
    const [method, column, value] = call as [string, string, unknown];
    switch (method) {
      case "eq":
        return valuesEqual(columnValue(row, column), value);
      case "neq":
        return !valuesEqual(columnValue(row, column), value);
      case "is":
        return value === null ? columnValue(row, column) == null : columnValue(row, column) === value;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const current = columnValue(row, column);
        if (current == null) return false;
        const cmp = compareValues(current, value);
        if (method === "gt") return cmp > 0;
        if (method === "gte") return cmp >= 0;
        if (method === "lt") return cmp < 0;
        return cmp <= 0;
      }
      case "in":
        return (
          Array.isArray(value) &&
          value.some((candidate) => valuesEqual(columnValue(row, column), candidate))
        );
      case "not":
        return true;
      default:
        return true;
    }
  }

  // PostgREST chain fake: applies the real filters, ordering, limit and the
  // silent max_rows cap — the only way to prove the read pages past 1000.
  function fakeSupabase(tables: Record<string, Row[]>) {
    const calls: Array<{
      table: string;
      chain: unknown[][];
      inColumn: string;
      inValues: unknown[];
      neq: Array<[string, unknown]>;
    }> = [];
    const from = jest.fn((table: string) => {
      const call = {
        table,
        chain: [] as unknown[][],
        inColumn: "",
        inValues: [] as unknown[],
        neq: [] as Array<[string, unknown]>,
      };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "is", "not", "gt", "gte", "lt", "lte", "order", "limit", "range"]) {
        builder[method] = (...args: unknown[]) => {
          call.chain.push([method, ...args]);
          return builder;
        };
      }
      builder.in = (column: string, values: unknown[]) => {
        call.chain.push(["in", column, values]);
        call.inColumn = column;
        call.inValues = values;
        return builder;
      };
      builder.neq = (column: string, value: unknown) => {
        call.chain.push(["neq", column, value]);
        call.neq.push([column, value]);
        return builder;
      };
      builder.then = (resolve: (value: { data: unknown; error: null }) => unknown) => {
        let rows = (tables[table] ?? []).filter((row) =>
          call.chain
            .filter((c) => FILTER_METHODS.has(String(c[0])))
            .every((c) => rowMatches(row, c)),
        );
        for (const orderCall of call.chain.filter((c) => c[0] === "order")) {
          const column = String(orderCall[1]);
          const ascending = (orderCall[2] as { ascending?: boolean } | undefined)?.ascending !== false;
          rows = [...rows].sort((a, b) => {
            const av = columnValue(a, column);
            const bv = columnValue(b, column);
            if (av == null && bv == null) return 0;
            if (av == null) return ascending ? 1 : -1;
            if (bv == null) return ascending ? -1 : 1;
            const cmp = compareValues(av, bv);
            return ascending ? cmp : -cmp;
          });
        }
        const limitCall = call.chain.find((c) => c[0] === "limit");
        const cap = Math.min(
          limitCall ? Number(limitCall[1]) : FAKE_POSTGREST_MAX_ROWS,
          FAKE_POSTGREST_MAX_ROWS,
        );
        rows = rows.slice(0, cap);
        return Promise.resolve(resolve({ data: rows, error: null }));
      };
      return builder;
    });
    return { supabase: { from } as never, calls };
  }

  it("unions hermes_instances and hivra_agents VMIDs so agent computers are not orphans", async () => {
    // Prod 2026-11: one host reported 9 "running VMs with no matching
    // hermes_instances row" — every one was a live hivra_agents computer.
    const { supabase, calls } = fakeSupabase({
      hermes_instances: [
        { id: "inst-1", proxmox_node: "fixturenode11", proxmox_vmid: 401, lifecycle_state: "active" },
      ],
      hivra_agents: [
        { id: "agent-1", vmid: 407, proxmox_host: "fixturenode11", status: "running" },
        { id: "agent-2", vmid: null, proxmox_host: "fixturenode11", status: "running" },
        { id: "agent-3", vmid: "not-a-number", proxmox_host: "fixturenode11", status: "running" },
      ],
    });

    const vmids = await loadDbVmidsForHost(supabase, "fixturenode11", [401, 407, 999]);

    expect(vmids.sort()).toEqual([401, 407]);
    expect(calls.map((call) => call.table).sort()).toEqual(["hermes_instances", "hivra_agents"]);
    const agentCall = calls.find((call) => call.table === "hivra_agents");
    expect(agentCall?.inColumn).toBe("vmid");
    expect(agentCall?.inValues).toEqual([401, 407, 999]);
    expect(agentCall?.neq).toContainEqual(["status", "deleted"]);
  });

  it("owns agent VMIDs by resolved host: an empty proxmox_host counts for the default host", async () => {
    // resolveHivraProxmoxHost("") falls back to HIVRA_PROXMOX_HOST or "local" —
    // a raw .eq("proxmox_host", hostId) misses exactly those rows, so an
    // agent computer on the default host was reported as an orphan.
    const defaultHost = resolveHivraProxmoxHost(null);
    const { supabase } = fakeSupabase({
      hermes_instances: [],
      hivra_agents: [
        { id: "agent-1", vmid: 501, proxmox_host: null, status: "running" },
        { id: "agent-2", vmid: 502, proxmox_host: "", status: "running" },
        { id: "agent-3", vmid: 503, proxmox_host: "other-host", status: "running" },
      ],
    });

    const vmids = await loadDbVmidsForHost(supabase, defaultHost, [501, 502, 503]);

    expect(vmids.sort()).toEqual([501, 502]);
  });

  it("derives this lane's hivra-bind tag set from every row on the vmid, including deleted ones", async () => {
    // Rows of every status count for lane attribution: a deleted row's VM is
    // still our lane's computer (the vmid claim then flags it); only a tag no
    // row derives belongs to the other deployment lane.
    const ownHash = "f".repeat(64);
    const { supabase } = fakeSupabase({
      hermes_instances: [],
      hivra_agents: [
        { id: "agent-live", vmid: 601, status: "running", infrastructure_binding_token_hash: ownHash },
        { id: "agent-deleted", vmid: 602, status: "deleted", infrastructure_binding_token_hash: "e".repeat(64) },
        { id: "agent-nohash", vmid: 603, status: "running", infrastructure_binding_token_hash: "not-a-hash" },
        { id: "agent-unrelated", vmid: 999, status: "running", infrastructure_binding_token_hash: "d".repeat(64) },
      ],
    });

    const tags = await loadLaneBindingTags(supabase, [601, 602, 603]);

    expect(tags).toEqual(new Set([`hivra-bind-${ownHash.slice(0, 32)}`, `hivra-bind-${"e".repeat(32)}`]));
  });

  it("pages the fleet-wide agent claim read past the PostgREST row cap", async () => {
    // vmids collide across hosts, so the .in(vmid, liveVmids) read matches
    // agent rows from EVERY host while host filtering happens in code. With
    // 1000 foreign rows filling the first page, an unpaged read silently
    // drops this host's claim — and the reap guard then treats its LV as
    // unclaimed and deletes a live disk. The read must keyset-page until a
    // short page.
    const fillers = Array.from({ length: FAKE_POSTGREST_MAX_ROWS }, (_, i) => ({
      id: `agent-${String(i).padStart(4, "0")}`,
      vmid: 2050,
      proxmox_host: "other-host",
      status: "running",
    }));
    const claimed = {
      id: "agent-zz-claimed",
      vmid: 2050,
      proxmox_host: "fixturenode11",
      status: "running",
    };
    const { supabase, calls } = fakeSupabase({
      hermes_instances: [],
      hivra_agents: [...fillers, claimed],
    });

    const vmids = await loadDbVmidsForHost(supabase, "fixturenode11", [2050]);

    // Without pagination the 1000-row cap drops the claimed row and 2050 is
    // reported unclaimed — the data-loss path this guards against.
    expect(vmids).toEqual([2050]);
    // The second page was actually requested: a .gt keyset cursor on id.
    const agentChains = calls.filter((call) => call.table === "hivra_agents");
    expect(
      agentChains.some((call) =>
        call.chain.some((c) => c[0] === "gt" && c[1] === "id"),
      ),
    ).toBe(true);
  });

  it("returns an empty list without querying when there are no live VMIDs", async () => {
    const { supabase } = fakeSupabase({});
    await expect(loadDbVmidsForHost(supabase, "fixturenode11", [])).resolves.toEqual([]);
    expect((supabase as unknown as { from: jest.Mock }).from).not.toHaveBeenCalled();
  });
});
