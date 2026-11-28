import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPortableKvmSlotClaimScript } from "../slot-claim";

const slot = { hostId: "pve-fixture", vmid: 9355, ip: "10.251.20.50", bindingTag: `hivra-bind-${"a".repeat(32)}` };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portable-kvm-slot-"));
  roots.push(root);
  for (const dir of ["run/lock", "qemu", "bin", "intents", "ledger", "pids"]) mkdirSync(join(root, dir), { recursive: true });
  const tool = join(root, "tool");
  writeFileSync(tool, String.raw`#!/usr/bin/env python3
import hashlib
import os
import sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
r = Path(os.environ["ROOT"])
cfg = r / "qemu/9355.conf"
if name == "hostname":
    print("pve-fixture")
elif name == "lvs":
    print(os.environ.get("VOLUME", ""))
elif name == "pvesh" and args == ["get", "/cluster/nextid", "--vmid", "9355"]:
    print("9355")
elif name == "pvesh" and args == ["get", "/cluster/ha/resources", "--output-format", "json"]:
    print(os.environ.get("HA", "[]"))
elif name == "qm" and args == ["status", "9355"]:
    print(os.environ.get("STATUS", "status: stopped"))
elif name == "qm" and args == ["config", "9355", "--current", "1"]:
    print(cfg.read_text().replace("boot: \n", "boot:  \n"), end="")
elif name == "qm" and args[:4] == ["create", "9355", "--start", "0"]:
    assert not cfg.exists()
    assert (r / "run/lock/hermes-proxmox-provision.lock.d/pid").is_file()
    opts = dict(zip(args[4::2], args[5::2]))
    assert opts.keys() == {"--onboot", "--lock", "--name", "--tags", "--ipconfig0"}
    cfg.write_text("boot: \n" + "".join(k[2:] + ": " + v + "\n" for k, v in sorted(opts.items())))
elif name == "perl":
    assert "lock_config" in args[-3] and "destroy_config" in args[-3]
    assert args[-2:] == ["9355", hashlib.sha1(cfg.read_bytes()).hexdigest()]
    cfg.unlink()
else:
    raise SystemExit(99)
`, { mode: 0o700 });
  for (const cmd of ["hostname", "lvs", "pvesh", "qm", "perl"]) symlinkSync(tool, join(root, "bin", cmd));
  const run = (action: "reserve" | "verify" | "release", env: Record<string, string> = {}, target = slot) => {
    const script = buildPortableKvmSlotClaimScript(action, target).replaceAll("/run/lock", join(root, "run/lock"))
      .replaceAll("/etc/pve/qemu-server", join(root, "qemu")).replaceAll("/run/qemu-server", join(root, "pids"))
      .replaceAll("/var/lib/hivra/provision-operations", join(root, "intents"))
      .replaceAll("/var/lib/hivra/vmid-references", join(root, "ledger")).replaceAll("/usr/bin/perl", join(root, "bin/perl"))
      .replaceAll("== 0", "== " + (process.getuid?.() ?? 0));
    return spawnSync("bash", ["-s"], {
      input: script, encoding: "utf8", env: { NODE_ENV: "test", ROOT: root, PATH: join(root, "bin") + ":/usr/bin:/bin", ...env },
    });
  };
  return { root, run, cfg: join(root, "qemu/9355.conf") };
}

it("reserves both resources as a stopped diskless VM record and releases only that exact record", () => {
  const { cfg, root, run } = fixture();
  expect(run("reserve")).toMatchObject({ status: 0, stdout: "HIVRA_PORTABLE_SLOT_V1 reserve\n", stderr: "" });
  expect(readFileSync(cfg, "utf8")).toBe(
    `boot: \nipconfig0: ip=${slot.ip}/24\nlock: backup\nname: hivra-slot-9355\nonboot: 0\ntags: hivra-slot-${"a".repeat(32)}\n`,
  );
  expect(run("reserve").status).toBe(0);
  expect(run("verify")).toMatchObject({ status: 0, stdout: "HIVRA_PORTABLE_SLOT_V1 verify\n", stderr: "" });
  expect(run("release", {}, { ...slot, bindingTag: `hivra-bind-${"b".repeat(32)}` }).stderr).toContain("binding_mismatch");
  expect(run("release", { VOLUME: "vm-9355-disk-0" }).stderr).toContain("slot_already_has_volumes");
  expect(run("release", { STATUS: "status: running" }).stderr).toContain("not_stopped");
  expect(existsSync(cfg)).toBe(true);
  expect(run("release")).toMatchObject({ status: 0, stdout: "HIVRA_PORTABLE_SLOT_V1 release\n", stderr: "" });
  expect(existsSync(cfg)).toBe(false);
  expect(run("verify").stderr).toContain("destination_slot_missing");
  expect(existsSync(join(root, "run/lock/hermes-proxmox-provision.lock.d"))).toBe(false);
});

it.each([
  ["qemu/123.conf", "ipconfig0: ip=10.251.20.50/24\n", "slot_ip_in_use"],
  ["intents/operation-123.selected", "vmid=9355\n", "slot_provision_pending"],
  ["intents/operation-123.selected", "ip=10.251.20.50\n", "slot_provision_pending"],
  ["ledger/other.hivra.list", "9355\n", "slot_vmid_referenced"],
])("refuses a conflicting %s", (at, content, reason) => {
  const { root, run, cfg } = fixture();
  writeFileSync(join(root, at), content);
  expect(run("reserve")).toMatchObject({ status: 1, stderr: expect.stringContaining(reason) });
  expect(existsSync(cfg)).toBe(false);
});

it("refuses occupied locks, HA-managed IDs and the excluded VMID without changing host state", () => {
  const { root, run, cfg } = fixture();
  const legacy = join(root, "run/lock/hermes-proxmox-provision.lock.d");
  mkdirSync(legacy);
  expect(run("reserve").status).toBe(1);
  expect(existsSync(legacy)).toBe(true);
  rmSync(legacy, { recursive: true });
  expect(run("reserve", { HA: '[{"sid":"vm:9355"}]' }).stderr).toContain("slot_is_ha_managed");
  expect(() => buildPortableKvmSlotClaimScript("reserve", { ...slot, vmid: 9302 })).toThrow();
  expect(existsSync(cfg)).toBe(false);
});
