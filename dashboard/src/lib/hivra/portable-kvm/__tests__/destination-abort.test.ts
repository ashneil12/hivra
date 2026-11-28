import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPortableKvmDestinationAbortScript, parsePortableKvmDestinationAbortReceipt } from "../destination-abort";
import { serializePortableKvmDestinationPreparePermit, type PortableKvmDestinationPrepareInput } from "../destination-prepare";

const vmid = 9355;
const ownerId = "user_OfflineFixture";
const preparation: PortableKvmDestinationPrepareInput = {
  agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  generation: 3, checkpointSha256: "3".repeat(64), hostId: "offline-destination", vmid,
  bindingTag: "hivra-bind-" + "a".repeat(32), ip: "10.251.10.44", expiresAt: "2026-01-01T00:00:00.000Z",
  storageId: "local-lvm", volumeGroup: "pve", thinPool: "data", abortScope: { ownerId },
  profile: {
    machine: "pc-i440fx-8.1", cores: 2, memoryMb: 2048,
    network: { bridge: "hivra0", macAddress: "02:11:22:33:44:55" },
    attachment: { discard: true, ssd: false, ioThread: true },
    managed: {
      allocationOperationId: "33333333-3333-4333-8333-333333333333",
      cpu: { vendor: "AuthenticAMD", requiredFlags: ["aes", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] },
      cpuLimit: 1.25,
      cloudInit: { instanceId: "b".repeat(40), gateway: "10.251.10.1", nameservers: ["192.0.2.53"] },
    },
  },
  disk: { key: "scsi0", snapshotId: "4".repeat(64), bytes: 12 * 1024 ** 3, sha256: "5".repeat(64) },
};

const rootPaths: string[] = [];
const registry = "state/portable-kvm-destinations";
const job = "state/portable-kvm-destination-jobs/" + preparation.operationId;
const journal = registry + "/.abort-journal-" + preparation.operationId;
const snippet = "vz/snippets/hivra-portable-meta-" + preparation.operationId + ".yaml";
const cfg = "qemu/9355.conf";
const disk = "vm-9355-disk-0";
const seed = "vm-9355-cloudinit";
const nodes = "nodes/offline-destination/qemu-server";
const vgUuid = "V".repeat(32);
const lvUuids = { [disk]: "D".repeat(32), [seed]: "S".repeat(32) };
const hash = (wire: string) => createHash("sha256").update(wire).digest("hex");
const wire = serializePortableKvmDestinationPreparePermit(preparation);
const preparationSha256 = hash(wire);
const slot = `ipconfig0: ip=${preparation.ip}/24\nlock: backup\nname: hivra-slot-9355\nonboot: 0\ntags: hivra-slot-${"a".repeat(32)}\n`;
const converted = [
  "lock: backup", "onboot: 0", "name: hivra-portable-9355",
  `tags: ${preparation.bindingTag};hivra-op-33333333333343338333333333333333`,
  "net0: virtio=02:11:22:33:44:55,bridge=hivra0,firewall=1,link_down=1",
  `scsi0: local-lvm:${disk},replicate=0,size=12G`, `ide2: local-lvm:${seed},media=cdrom,size=4M`,
  `cicustom: meta=local:snippets/${snippet.split("/").at(-1)}`, "",
].join("\n");
const nativeRaw = converted + "\n[special:cloudinit]\nadded: nameserver\n";

afterEach(() => {
  for (const root of rootPaths.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(stage: "slot" | "native" | "prepared" | "restore-failed" = "slot") {
  const root = mkdtempSync(join(tmpdir(), "destination-abort-"));
  rootPaths.push(root);
  for (const relative of [registry, "state/portable-kvm-destination-permits", "run/lock/hivra-vmids", "qemu",
    "pids", "lxc", "prov", "intents", "results", "references", "bin", nodes, "nodes/source/qemu-server", "vz/snippets",
    "devices/pve", "sys/net", "sys/block/dm-0/dm", "sys/block/dm-1/dm"]) {
    mkdirSync(join(root, relative), { recursive: true, mode: 0o700 });
  }
  const put = (path: string, bytes: string) => writeFileSync(join(root, path), bytes, { mode: 0o600 });
  const has = (path: string) => existsSync(join(root, path));
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  put("nodes/source/qemu-server/9455.conf", `ipconfig0: ip=${preparation.ip}/24\nlock: backup\n`);
  symlinkSync(join(root, cfg), join(root, nodes, "9355.conf"));
  put(`${registry}/.attempt-9355`, wire);
  put("state/portable-kvm-destination-permits/9355", wire);
  put(`${registry}/.abort-slot-9355`, JSON.stringify({ prepareSha256: preparationSha256, rawSha256: hash(slot) }));
  put(snippet, "instance-id: " + "b".repeat(40) + "\n");
  put("events", "");
  put(cfg, stage === "slot" ? slot : stage === "native" ? nativeRaw : converted);
  if (stage !== "slot") {
    const volumes = Object.fromEntries(Object.entries(lvUuids).map(([name, lvUuid]) => [name, { lvUuid, vgUuid }]));
    for (const [index, [name, id]] of Object.entries(lvUuids).entries()) {
      put("devices/dm-" + index, id);
      symlinkSync(join(root, "devices/dm-" + index), join(root, "devices/pve", name));
      put("sys/block/dm-" + index + "/dm/uuid", "LVM-" + vgUuid + id + "\n");
    }
    const lineage = { prepareSha256: preparationSha256, rawSha256: hash(nativeRaw), currentSha256: hash(converted), volumes };
    put(`${registry}/.abort-native-9355`, JSON.stringify(lineage));
    if (stage !== "native") {
      put(`${registry}/.abort-seed-9355`, JSON.stringify({ ...lineage, rawSha256: hash(converted) }));
      const reservation = JSON.stringify({
        ...Object.fromEntries(["agentId", "operationId", "generation", "checkpointSha256", "hostId", "vmid", "bindingTag",
          "storageId", "volumeGroup", "disk"].map(key => [key, preparation[key as keyof typeof preparation]])),
        rawConfigurationSha256: hash(converted), configurationSha256: hash(converted), volumeName: disk,
        deviceMapperUuid: "LVM-" + vgUuid + lvUuids[disk],
      }) + "\n";
      put(`${registry}/9355`, reservation);
      if (stage === "restore-failed") {
        mkdirSync(join(root, job), { recursive: true, mode: 0o700 });
        put(job + "/identity", reservation);
        put(job + "/restore.sh", "exact restore script fixture");
      }
    }
  }
  const tool = join(root, "tool");
  writeFileSync(tool, String.raw`#!/usr/bin/env python3
import hashlib
import json
import os
import sys
from pathlib import Path
name, *args = [Path(sys.argv[0]).name, *sys.argv[1:]]
r = Path(os.environ["ROOT"])
env = os.environ
cfg = r / "qemu/9355.conf"
devices = r / "devices/pve"
snippet = r / "${snippet}"

if name == "hostname" and args == ["-s"]:
    print(env.get("HOST", "offline-destination"))
elif name == "systemctl":
    print("LoadState=loaded\nActiveState=" + env.get("ACTIVE", "failed")
          + "\nMainPID=" + env.get("PID", "0") + "\nControlPID=0\nJob=" + env.get("JOB", ""))
elif name == "nft":
    print(env.get("NFT", '{"nftables":[]}'))
elif name == "pvesh":
    target = args[1]
    if target == "/cluster/resources":
        print(env.get("CLUSTER", json.dumps([dict(vmid=9355, node="offline-destination", type="qemu", status="stopped")]
                                            if cfg.exists() else [])))
    elif target == "/cluster/nextid":
        assert not cfg.exists()
        print(env.get("NEXTID", "9355"))
    elif target == "/cluster/ha/resources":
        print("[]")
    elif target == "/storage/local-lvm":
        print(json.dumps(dict(type="lvmthin", vgname="pve", thinpool="data", content="rootdir,images")))
    elif target == "/storage/local":
        print(json.dumps(dict(type="dir", path=str(r / "vz"), content="iso,snippets")))
    else:
        sys.exit(99)
elif name == "pvesm":
    if args == ["status", "--storage", "local-lvm"]:
        print("Name Type Status\nlocal-lvm lvmthin active")
    elif args == ["list", "local-lvm", "--vmid", "9355"]:
        print("Volid Format Type Size VMID")
        for device in devices.iterdir():
            print("local-lvm:" + device.name, "raw images 4096 9355")
    elif args[0] == "path":
        print(snippet if args[1].startswith("local:snippets/") else devices / args[1].split(":")[1])
    else:
        sys.exit(99)
elif name == "lvs":
    lvs = [dict(vg_name="pve", lv_name=f.name, pool_lv="data", lv_attr=env.get("ATTR", "Vwi-a-tz--"),
                origin="", origin_uuid="", vg_uuid="${vgUuid}", lv_uuid=f.read_text()) for f in devices.iterdir()]
    print(json.dumps({"report": [{"lv": lvs}]}))
elif name == "qm" and args == ["config", "9355", "--current", "1"]:
    print(cfg.read_text().split("\n[special:cloudinit]\n")[0], end="")
elif name == "qm" and args == ["status", "9355"]:
    print(env.get("STATUS", "status: stopped"))
elif name == "perl":
    program, vmid, sha256, selectors = args[-4:]
    assert vmid == "9355" and "PVE::QemuConfig->lock_config" in program and "PVE::QemuServer::check_running" in program
    if sha256:
        assert "PVE::QemuConfig->destroy_config" in program and "lvremove" in program
        assert sha256 == hashlib.sha256(cfg.read_bytes()).hexdigest()
        assert (r / "${journal}").is_file()
        with (r / "events").open("a") as f:
            f.write("native cleanup\n")
        if env.get("NATIVE_INTERRUPTED"):
            sys.exit(8)
        for selector in json.loads(selectors):
            vg, lv, exact_name = [s.split("=")[1] for s in selector.split(" && ")]
            assert vg == "${vgUuid}" and (devices / exact_name).read_text() == lv
            (devices / exact_name).unlink()
        cfg.unlink()
        (r / "${nodes}/9355.conf").unlink()
    else:
        assert not cfg.exists() and json.loads(selectors) == []
else:
    sys.exit(99)
`, { mode: 0o700 });
  for (const command of ["hostname", "systemctl", "pvesh", "pvesm", "lvs", "qm", "perl", "nft"]) {
    symlinkSync(tool, join(root, "bin", command));
  }
  const commands = {
    "/var/lib/hivra-sleep": "state", "/run/lock": "run/lock", "/etc/pve/qemu-server": "qemu", "/etc/pve/nodes": "nodes",
    "/etc/pve/lxc": "lxc", "/run/qemu-server": "pids", "/var/lib/vz/snippets": "vz/snippets", "/run/hivra-provision": "prov",
    "/var/lib/hivra/provision-operations": "intents", "/var/lib/hivra/provision-results": "results",
    "/var/lib/hivra/vmid-references": "references", "/usr/bin/perl": "bin/perl", '"/dev"': '"devices"',
    "/sys/class/block": "sys/block", "/sys/class/net": "sys/net",
  };
  function run(mode: "cleanup" | "verify-absent", env: Record<string, string> = {}, p = preparation, held?: string) {
    const script = Object.entries(commands).reduce((value, [from, to]) => value.replaceAll(from,
      from === '"/dev"' ? JSON.stringify(join(root, "devices")) : join(root, to)),
    buildPortableKvmDestinationAbortScript(mode, { preparation: p })).replaceAll("st_uid == 0", "st_uid == " + (process.getuid?.() ?? 0))
      .replaceAll("geteuid() == 0", "geteuid() == " + (process.getuid?.() ?? 0));
    const argv = held ? [join(root, "run/lock", held), "bash", "-s"] : ["-s"];
    return spawnSync(held ? "flock" : "bash", argv, {
      encoding: "utf8", input: script, timeout: 20000,
      env: { NODE_ENV: "test", ROOT: root, PATH: join(root, "bin") + ":/usr/bin:/bin", ...env },
    });
  }
  return { has, put, read, root, run };
}

it.each(["slot", "native", "prepared", "restore-failed"] as const)("cleans the exact %s and independently proves absence", stage => {
  const h = fixture(stage);
  expect(h.run("verify-absent").status).toBe(1);
  expect(h.run("cleanup")).toMatchObject({ status: 0, stdout: "", stderr: "" });
  expect(h.has(cfg)).toBe(false);
  expect(h.has(snippet)).toBe(false);
  expect(h.has(job)).toBe(false);
  expect(h.has("devices/pve/" + disk)).toBe(false);
  expect(h.has("devices/pve/" + seed)).toBe(false);
  expect(h.has("nodes/source/qemu-server/9455.conf")).toBe(true);
  expect(h.has(journal)).toBe(true);
  expect(h.run("cleanup").status).toBe(0);
  expect(h.read("events")).toBe("native cleanup\n");
  const verified = h.run("verify-absent");
  expect(verified.status).toBe(0);
  expect(parsePortableKvmDestinationAbortReceipt(verified.stdout, { preparation })).toEqual({
    state: "destination_abort_absent", preparationSha256,
  });
});

it.each([
  { HOST: "source" }, { ACTIVE: "activating" }, { PID: "77" }, { JOB: "5" }, { STATUS: "status: running" },
  { ATTR: "Vwi-aotz--" }, { CLUSTER: '[{"vmid":9355,"node":"source","type":"qemu","status":"stopped"}]' },
  { NFT: '{"nftables":[{"table":{"name":"hivra_portable_9355_fixture","family":"bridge"}}]}' },
] as Record<string, string>[])("refuses inconsistent host evidence (%j) before mutation", env => {
  const h = fixture("restore-failed");
  expect(h.run("cleanup", env).status).toBe(1);
  expect(h.has(cfg)).toBe(true);
  expect(h.has(journal)).toBe(false);
  expect(h.read("events")).toBe("");
});

it.each([
  { generation: 4 }, { operationId: "99999999-9999-4999-8999-999999999999" }, { abortScope: { ownerId: "user_Unrelated" } },
  { bindingTag: "hivra-bind-" + "b".repeat(32) }, { ip: "10.251.10.54" },
])("refuses stale or wrong preparation (%j)", changed => {
  const h = fixture("prepared");
  expect(h.run("cleanup", {}, { ...preparation, ...changed }).status).toBe(1);
  expect(h.read("events")).toBe("");
});

it("preserves a converted record with unconfirmed native lineage or a reused volume UUID", () => {
  const unknown = fixture("native");
  rmSync(join(unknown.root, registry, ".abort-native-9355"));
  expect(unknown.run("cleanup").status).toBe(1);
  const reused = fixture("prepared");
  reused.put("devices/pve/" + seed, "X".repeat(32));
  expect(reused.run("cleanup").stderr).toContain("destination_device_uuid_changed");
  reused.put("sys/block/dm-1/dm/uuid", "LVM-" + vgUuid + "X".repeat(32) + "\n");
  expect(reused.run("cleanup").stderr).toContain("destination_volume_lineage_mismatch");
  expect(unknown.read("events") + reused.read("events")).toBe("");
});

it("holds admission against a dispatcher and refuses a boot attempt or unknown restore artifact", () => {
  const h = fixture("restore-failed");
  const lock = "hivra-portable-kvm-job-" + preparation.operationId + ".lock";
  expect(h.run("cleanup", {}, preparation, lock).status).toBe(1);
  h.put(`${registry}/9355.boot-attempt`, "opaque");
  expect(h.run("cleanup").status).toBe(1);
  rmSync(join(h.root, registry, "9355.boot-attempt"));
  h.put(job + "/unexpected", "opaque");
  expect(h.run("cleanup").status).toBe(1);
  expect(h.read("events")).toBe("");
});

it("never replays an interrupted destructive attempt or accepts exact ID reuse as absence", () => {
  const h = fixture("prepared");
  expect(h.run("cleanup", { NATIVE_INTERRUPTED: "yes" }).status).toBe(1);
  expect(h.has(journal)).toBe(true);
  expect(h.run("cleanup").status).toBe(1);
  expect(h.run("verify-absent").status).toBe(1);
  expect(h.read("events")).toBe("native cleanup\n");
  const reused = fixture();
  expect(reused.run("cleanup").status).toBe(0);
  reused.put(cfg, slot);
  expect(reused.run("verify-absent").status).toBe(1);
  expect(reused.run("cleanup").status).toBe(1);
  expect(reused.has(cfg)).toBe(true);
});

it("validates the request and parses only one canonical matching independent receipt", () => {
  expect(() => buildPortableKvmDestinationAbortScript("cleanup", { preparation: { ...preparation, abortScope: undefined } })).toThrow();
  const h = fixture();
  expect(h.run("cleanup").status).toBe(0);
  const receipt = h.run("verify-absent").stdout;
  for (const invalid of ["", receipt + receipt, "log\n" + receipt, receipt.trim(),
    receipt.replace('"state":', '"extra":true,"state":'), receipt.replace('"state":', '"state":"ignored","state":')]) {
    expect(parsePortableKvmDestinationAbortReceipt(invalid, { preparation })).toBeNull();
  }
  expect(parsePortableKvmDestinationAbortReceipt(receipt, { preparation: { ...preparation, generation: 10 } })).toBeNull();
});
