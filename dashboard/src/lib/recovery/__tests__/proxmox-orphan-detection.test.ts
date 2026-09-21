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
  parseLiveVmsFromHostScript,
  parseOrphanLvReapOutput,
  parseOrphanLvsFromHostScript,
  parseRestoreCloneStopOutput,
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
      { vmid: 401, name: "hermes-power-1a2b3c4d", memoryMb: 8192, cores: 4 },
      { vmid: 407, name: "canary-407", memoryMb: 4096, cores: 2 },
      { vmid: 412, name: "hermes-free-aabbccdd", memoryMb: 1024, cores: 1 },
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
      { vmid: 500, name: "partial-only", memoryMb: null, cores: null },
    ]);
  });

  it("ignores unrecognised config keys inside a block", () => {
    const stdout = `BEGIN 501\ncpu: kvm64\nname: with-extras\nmemory: 2048\nboot: order=scsi0\ncores: 2\nEND 501\n`;
    expect(parseLiveVmsFromHostScript(stdout)).toEqual([
      { vmid: 501, name: "with-extras", memoryMb: 2048, cores: 2 },
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
      },
    ]);
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
      { vmid: 401, name: "x", memoryMb: null, cores: null },
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
