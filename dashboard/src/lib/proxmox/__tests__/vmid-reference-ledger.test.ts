import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildVmidReferenceLedgerScript,
  resolveVmidReferencePlane,
  VMID_REFERENCE_DIRECTORY,
  type VmidReferenceLedger,
} from "../vmid-reference-ledger";

const PROD = "prodplanefixture";
const CANARY = "canaryplanefixture";

/**
 * Minimal allocator in the shape all three real allocators share: host
 * inventory + this plane's DB reservations + other planes' published ledger,
 * lowest free VMID in range, then record. Hosts are simulated by a temp dir.
 */
function allocate(dir: string, ledger: VmidReferenceLedger, hostVmids: number[], dbReserved: number[]) {
  const script = `set -euo pipefail
${buildVmidReferenceLedgerScript(ledger).replaceAll(VMID_REFERENCE_DIRECTORY, dir)}
claimed_vmids="$(printf '%s\\n' ${hostVmids.join(" ") || "''"})"
RESERVED_VMIDS='${dbReserved.join("\n")}'
[ -z "$RESERVED_VMIDS" ] || claimed_vmids="$(printf '%s\\n%s\\n' "$claimed_vmids" "$RESERVED_VMIDS")"
hivra_vmid_reference_sync
[ -z "$HIVRA_FOREIGN_VMIDS" ] || claimed_vmids="$(printf '%s\\n%s\\n' "$claimed_vmids" "$HIVRA_FOREIGN_VMIDS")"
VMID=""
for c in $(seq 1100 1120); do
  printf '%s\\n' "$claimed_vmids" | grep -qx "$c" && continue
  VMID="$c"; break
done
[ -n "$VMID" ]
hivra_vmid_reference_record "$VMID"
echo "SELECTED $VMID"`;
  const result = spawnSync("bash", [], { input: script, encoding: "utf8" });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  return Number(result.stdout.match(/SELECTED (\d+)/)?.[1]);
}

describe("cross-plane host VMID reference ledger", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "vmid-ledger-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("never reuses a VMID another plane still references after its VM was destroyed out of band", () => {
    // Prod allocates 1100..1108 on a shared host.
    const prodRows: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      prodRows.push(allocate(dir, { plane: PROD, lane: "hermes", references: prodRows }, prodRows, prodRows));
    }
    expect(prodRows.at(-1)).toBe(1108);
    // An operator destroys VM 1108 out of band; prod's row still says 1108.
    const hostAfterDestroy = prodRows.filter(vmid => vmid !== 1108);
    // Canary knows nothing about prod's rows. Before the ledger it chose 1108.
    const canaryVmid = allocate(dir, { plane: CANARY, lane: "hivra", references: [] }, hostAfterDestroy, []);
    expect(canaryVmid).not.toBe(1108);
    expect(canaryVmid).toBe(1109);
  });

  it("publishes a plane's full DB set and records each selection", () => {
    allocate(dir, { plane: PROD, lane: "hermes", references: [1101, 1103] }, [1101, 1103], [1101, 1103]);
    expect(readFileSync(path.join(dir, `${PROD}.hermes.list`), "utf8").trim().split("\n")).toEqual(["1101", "1103", "1100"]);
    // The next allocation rewrites from the DB (1100 now persisted, 1103 deleted).
    allocate(dir, { plane: PROD, lane: "hermes", references: [1100, 1101] }, [1100, 1101], [1100, 1101]);
    expect(readFileSync(path.join(dir, `${PROD}.hermes.list`), "utf8").trim().split("\n")).toEqual(["1100", "1101", "1102"]);
  });

  it("never publishes over a good list when the plane's DB lookup failed", () => {
    allocate(dir, { plane: PROD, lane: "hermes", references: [1105] }, [1105], [1105]);
    allocate(dir, { plane: PROD, lane: "hermes", references: null }, [1105], []);
    expect(readFileSync(path.join(dir, `${PROD}.hermes.list`), "utf8").trim().split("\n")).toEqual(["1105", "1100"]);
    expect(readdirSync(dir).filter(name => name.startsWith("."))).toEqual([]);
  });

  it("does not treat its own plane's other lane as foreign, but keeps both lanes' lists", () => {
    allocate(dir, { plane: PROD, lane: "hivra", references: [1107] }, [1107], [1107]);
    // Same plane, other lane: its own DB set is authoritative, so 1100 stays free here.
    expect(allocate(dir, { plane: PROD, lane: "hermes", references: [1107] }, [1107], [1107])).toBe(1100);
    expect(readdirSync(dir).sort()).toEqual([`${PROD}.hermes.list`, `${PROD}.hivra.list`]);
    // Another plane skips both lanes' references.
    expect(allocate(dir, { plane: CANARY, lane: "hivra", references: [] }, [], [])).toBe(1101);
  });

  it("stays read-only without a resolvable plane, and ignores malformed list lines", () => {
    writeFileSync(path.join(dir, `${PROD}.hermes.list`), "1100\nnot-a-vmid\n1101; rm -rf /\n");
    expect(allocate(dir, { plane: null, lane: "hivra", references: [] }, [], [])).toBe(1101);
    expect(readdirSync(dir)).toEqual([`${PROD}.hermes.list`]);
  });

  it("derives the plane from the Supabase project ref", () => {
    expect(resolveVmidReferencePlane({ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" })).toBe("abcdefghijklmnop");
    expect(resolveVmidReferencePlane({ NEXT_PUBLIC_SUPABASE_URL: "" })).toBeNull();
    expect(resolveVmidReferencePlane({ NEXT_PUBLIC_SUPABASE_URL: "not a url" })).toBeNull();
    expect(buildVmidReferenceLedgerScript({ plane: "../etc", lane: "hermes", references: [1] }))
      .toContain("HIVRA_VMID_REFERENCE_PUBLISH=0");
  });
});

describe("real allocator scripts carry the ledger", () => {
  // Imported lazily so the pure ledger tests above never load service modules.
  const { buildProxmoxProvisionScript, buildProxmoxVmidAvailabilityScript } =
    jest.requireActual("@/lib/services/proxmox/script-builders") as typeof import("@/lib/services/proxmox/script-builders");
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "vmid-ledger-real-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("availability reports another plane's referenced VMID as occupied and publishes this plane", () => {
    writeFileSync(path.join(dir, `${PROD}.hermes.list`), "1108\n");
    const bin = path.join(dir, "bin");
    spawnSync("mkdir", [bin]);
    writeFileSync(path.join(bin, "qm"), "#!/bin/sh\nprintf '      VMID NAME\\n      1100 hivra-cc-1100 running\\n'\n", { mode: 0o755 });
    writeFileSync(path.join(bin, "lvs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const script = buildProxmoxVmidAvailabilityScript({
      vmidStart: 1100, vmidEnd: 1110,
      vmidLedger: { plane: CANARY, lane: "hermes", references: [1100] },
    }).replaceAll(VMID_REFERENCE_DIRECTORY, dir);
    const result = spawnSync("bash", [], { input: script, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("HERMES_PROXMOX_VMID_OCCUPIED 1108");
    expect(result.stdout).toContain("HERMES_PROXMOX_VMID_FREE 1101");
    expect(readFileSync(path.join(dir, `${CANARY}.hermes.list`), "utf8")).toBe("1100\n");
  });

  it("provision merges foreign references into the picker under its lock and records the VMID", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "00000000-0000-4000-8000-00000000c0de", vmName: "hermes-fixture-00000000", templateId: 9000,
      vmidStart: 1100, vmidEnd: 1150, ipLastOctetStart: 50, privateSubnetPrefix: "10.250.20", privateCidr: 24,
      privateGateway: "10.250.20.1", nameserver: "1.1.1.1", cores: 1, memoryMb: 1024,
      deployScript: "#!/usr/bin/env bash\necho deploy\n", vmSshUser: "hermes", vmSshKeyPath: "/etc/hivra/keys/vm",
      gatewayHost: "fixture.example.test", caddySitesDir: "/etc/caddy/hermes.d", apiServerKey: "a".repeat(64),
      reservedVmids: [1101], vmidLedger: { plane: PROD, lane: "hermes", references: [1101] },
    });
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
    const lock = script.indexOf('mkdir "$HERMES_PROXMOX_LOCK_DIR"');
    const sync = script.indexOf("\nhivra_vmid_reference_sync");
    const pick = script.indexOf('for candidate in $(seq "$VMID_START" "$VMID_END")');
    const record = script.indexOf('hivra_vmid_reference_record "$VMID"');
    expect(lock).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(lock);
    expect(pick).toBeGreaterThan(sync);
    expect(record).toBeGreaterThan(pick);
    expect(script).toContain("HIVRA_VMID_REFERENCE_PLANE='prodplanefixture'");
  });
});
