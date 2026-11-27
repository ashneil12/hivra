import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootPortableKvmDestination, enablePortableKvmDestinationNetwork,
  releasePortableKvmDestinationLock, serializePortableKvmDestinationBootProfile, verifyPortableKvmQuarantinedDestination,
} from "../destination-boot";
import { serializePortableKvmDestinationReservation } from "../destination-disk";

jest.mock("server-only", () => ({}));

const ownerId = "user_fixture";
const agentId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const bootId = "33333333-3333-4333-8333-333333333333";
const connectorId = "44444444-4444-4444-8444-444444444444";
const tunnelId = "55555555-5555-4555-8555-555555555555";
const machineId = "a".repeat(32);
const tokenHash = "b".repeat(64);
const bindingTag = "hivra-bind-" + tokenHash.slice(0, 32);
const source = { hostId: "qa-source", vmid: 9343, ip: "192.0.2.3", bindingTag };
const destination = { hostId: "qa-destination", vmid: 9344, ip: "192.0.2.4", bindingTag };
const nic = "virtio=02:23:45:AB:CD:EF,bridge=vmbr1,firewall=1";
const config = [
  "agent: 1", "arch: x86_64", "bios: seabios", "machine: pc-i440fx-9.2", "ostype: l26", "boot: order=scsi0",
  "scsihw: virtio-scsi-single", "lock: backup", "memory: 2048", "onboot: 0", "scsi0: local-lvm:vm-9344-disk-0,replicate=0",
  "tags: " + bindingTag, "net0: " + nic + ",link_down=1", "",
].join("\n");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const saved = process.env;
const roots = new Set<string>();

beforeEach(() => {
  const pair = [source, destination].map(({ hostId, vmid, ip }) => ({ hostId, vmid, ip }));
  process.env = { ...saved, VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
    VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
    HIVRA_KVM_PORTABLE_QA_ENABLED: "true", HIVRA_KVM_PORTABLE_QA_OWNER_ID: ownerId, HIVRA_KVM_PORTABLE_QA_AGENT_ID: agentId,
    HIVRA_KVM_PORTABLE_QA_PLACEMENTS: JSON.stringify(pair),
  };
});
afterEach(() => {
  process.env = saved;
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

const fake = String.raw`#!/usr/bin/python3
import json, os, re, subprocess, sys
from pathlib import Path
r = Path(os.environ["TEST_ROOT"])
cmd, a = Path(sys.argv[0]).name, sys.argv[1:]
cfg, pid, fw = r / "pve/9344.conf", r / "run/9344.pid", r / "firewall"
def event(s):
    with (r / "events").open("a") as f:
        f.write(s + "\n")
if cmd == "hostname" and a == ["-s"]:
    print(os.getenv("TEST_HOST", "qa-destination"))
elif cmd == "pvesh" and a == ["get", "/cluster/ha/resources", "--output-format", "json"]:
    print(os.getenv("TEST_HA", "[]"))
elif cmd == "pvesm" and a == ["status", "--storage", "local-lvm"]:
    print("Header\nlocal-lvm lvmthin active")
elif cmd == "pvesm" and a == ["path", "local-lvm:vm-9344-disk-0"]:
    print(r / "dev/pve/vm-9344-disk-0")
elif cmd == "qm" and a == ["config", "9344", "--current", "1"]:
    print(cfg.read_text(), end="")
elif cmd == "qm" and a == ["status", "9344"]:
    print("status: " + ("running" if pid.exists() else "stopped"))
elif cmd == "qm" and a == ["start", "9344", "--skiplock", "1"]:
    assert fw.exists() and "link_down=1" in cfg.read_text() and not pid.exists()
    event("start")
    pid.write_text("141592\n")
    (r / "net/tap9344i0/master/bridge").mkdir(parents=True)
elif cmd == "qm" and a == ["set", "9344", "--skiplock", "1", "--net0", "virtio=02:23:45:AB:CD:EF,bridge=vmbr1,firewall=1"]:
    assert fw.exists() and pid.exists()
    event("link_up")
    cfg.write_text(cfg.read_text().replace(",link_down=1", ""))
elif cmd == "qm" and a == ["unlock", "9344"]:
    assert not fw.exists() and (r / "sleep/portable-kvm-destinations/9344.released").exists()
    assert pid.exists() and "lock: backup\n" in cfg.read_text() and "link_down=1" not in cfg.read_text()
    event("unlock")
    cfg.write_text(cfg.read_text().replace("lock: backup\n", ""))
elif cmd == "qm" and a[:3] == ["guest", "exec", "9344"]:
    assert pid.exists() and a[-3] == "02:23:45:ab:cd:ef" and a[-1] == "192.0.2.4"
    assert "hivra-cf-tunnel.service" in a[-4] and "Generated Connector ID" in a[-4]
    compile(a[-4], "guest_probe", "exec")
    carrier = a[-2]
    assert (carrier == "0") == ("link_down=1" in cfg.read_text())
    assert (carrier != "1") == fw.exists()
    event("qga_" + carrier)
    proof = {"machineId": os.getenv("TEST_MACHINE", "a" * 32),
             "bootId": os.getenv("TEST_BOOT", "33333333-3333-4333-8333-333333333333")}
    if carrier == "1":
        proof["connectorId"] = os.getenv("TEST_CONNECTOR", "44444444-4444-4444-8444-444444444444")
    if os.getenv("TEST_RUN_GUEST"):
        dev = r / "net/ens18"
        dev.mkdir(exist_ok=True)
        (dev / "address").write_text(a[-3])
        (dev / "carrier").write_text("0" if carrier == "0" else "1")
        (r / "machine-id").write_text(proof["machineId"])
        (r / "boot-id").write_text(proof["bootId"])
        (r / "proc/456").mkdir(parents=True, exist_ok=True)
        exe = r / "proc/456/exe"
        if not exe.is_symlink():
            exe.symlink_to("/usr/local/bin/cloudflared")
        guest = a[-4].replace(str(r / "net"), str(r / "guest-net")).replace(
            'Path("/proc",', 'Path("' + str(r / "proc") + '",').replace(
            "/etc/machine-id", str(r / "machine-id")).replace(
            "/proc/sys/kernel/random/boot_id", str(r / "boot-id"))
        if not (r / "guest-net").is_dir():
            (r / "guest-net").mkdir()
            (r / "guest-net/ens18").symlink_to(dev)
        result = subprocess.run(["/usr/bin/python3", "-I", "-c", guest, *a[-3:]], capture_output=True, text=True)
        print(json.dumps({"exited": 1, "exitcode": result.returncode, "out-data": result.stdout}))
    else:
        print(json.dumps({"exited": 1, "exitcode": 0, "out-data": json.dumps(proof)}))
elif cmd == "systemctl" and a == ["show", "--property=FragmentPath,DropInPaths,LoadState", "hivra-cf-tunnel.service"]:
    print("FragmentPath=/etc/systemd/system/hivra-cf-tunnel.service\nDropInPaths=\nLoadState=loaded")
elif cmd == "systemctl" and a == ["show", "--property=ActiveState,InvocationID,MainPID", "hivra-cf-tunnel.service"]:
    print("ActiveState=active\nInvocationID=" + "1" * 32 + "\nMainPID=456")
elif cmd == "ip" and a == ["-j", "-4", "address", "show", "dev", "ens18"]:
    print(json.dumps([{"addr_info": [{"local": "192.0.2.4", "scope": "global"}]}]))
elif cmd == "journalctl":
    assert a == ["--boot=0", "--unit=hivra-cf-tunnel.service", "--no-pager", "--output=json", "--lines=10",
                 "--grep=Generated Connector ID:", "_SYSTEMD_INVOCATION_ID=" + "1" * 32, "_PID=456",
                 "_EXE=/usr/local/bin/cloudflared"]
    print(json.dumps({"MESSAGE": "2026-11-27T20:20:00Z INF Generated Connector ID: 44444444-4444-4444-8444-444444444444"}))
elif cmd == "nft" and a == ["-f", "-"]:
    rules = sys.stdin.read().splitlines()
    m = re.fullmatch(r"create table bridge (hivra_portable_9344_[a-f0-9]{24})", rules[0])
    assert m and not fw.exists() and len(rules) == 5
    assert 'prerouting iifname { "tap9344i0", "fwpr9344p0" } drop' in rules[2]
    assert 'postrouting oifname { "tap9344i0", "fwpr9344p0" } drop' in rules[4]
    event("install_fence")
    fw.write_text(m[1])
elif cmd == "nft" and a == ["-j", "list", "tables", "bridge"]:
    print(json.dumps({"nftables": [{"table": {"family": "bridge", "name": fw.read_text()}}] if fw.exists() else []}))
elif cmd == "nft" and a[:4] == ["-j", "list", "table", "bridge"]:
    name = fw.read_text()
    assert a[4:] == [name]
    rows = [{"table": {"family": "bridge", "name": name}}]
    for hook, key in (("prerouting", "iifname"), ("postrouting", "oifname")):
        rows.append({"chain": {"family": "bridge", "table": name, "name": hook, "type": "filter",
                               "hook": hook, "prio": -300, "policy": "accept"}})
        rows.append({"rule": {"family": "bridge", "table": name, "chain": hook, "expr": [
            {"match": {"op": "==", "left": {"meta": {"key": key}}, "right": {"set": ["fwpr9344p0", "tap9344i0"]}}},
            {"drop": None},
        ]}})
    if os.getenv("TEST_NFT_DRIFT"):
        rows.pop()
    print(json.dumps({"nftables": rows}))
elif cmd == "nft" and a[:3] == ["delete", "table", "bridge"]:
    assert a[3:] == [fw.read_text()] and "link_down=1" not in cfg.read_text()
    event("delete_fence")
    fw.unlink()
else:
    raise RuntimeError("unexpected fixture command")
`;

function host(current = config) {
  const root = mkdtempSync(join(tmpdir(), "portable-boot-"));
  roots.add(root);
  for (const dir of ["bin", "sleep/portable-kvm-destinations", "pve", "lxc", "run", "lock", "net/vmbr1/bridge",
    "dev/pve", "sys/0:0/dm"]) mkdirSync(join(root, dir), { mode: 0o700, recursive: true });
  const disk = { key: "scsi0" as const, bytes: 512, sha256: "6".repeat(64), snapshotId: "7".repeat(64) };
  const reservation = { agentId, operationId, generation: 2, hostId: destination.hostId, vmid: destination.vmid,
    bindingTag, checkpointSha256: "8".repeat(64), configurationSha256: digest(current), rawConfigurationSha256: digest(current),
    storageId: "local-lvm", volumeName: "vm-9344-disk-0", volumeGroup: "pve", deviceMapperUuid: "LVM-" + "A".repeat(64), disk,
  };
  const profile = { reservation, machineId, ip: destination.ip };
  const diskReceipt = { state: "disk_restored_verified" as const, reservation, readback: { sha256: disk.sha256, bytes: disk.bytes } };
  const registry = join(root, "sleep/portable-kvm-destinations");
  const bootMarker = join(registry, "9344.boot");
  writeFileSync(join(registry, "9344"), serializePortableKvmDestinationReservation(reservation), { mode: 0o600 });
  writeFileSync(bootMarker, serializePortableKvmDestinationBootProfile(profile), { mode: 0o600 });
  writeFileSync(join(root, "pve/9344.conf"), current);
  writeFileSync(join(root, "events"), "");
  writeFileSync(join(root, "meminfo"), "MemAvailable: 80000000 kB\n");
  writeFileSync(join(root, "pressure"), "full avg10=0.10 avg60=0.10 avg300=0.10 total=1\n");
  writeFileSync(join(root, "dev/dm-0"), Buffer.alloc(disk.bytes));
  writeFileSync(join(root, "sys/0:0/dm/uuid"), reservation.deviceMapperUuid);
  symlinkSync(join(root, "dev/dm-0"), join(root, "dev/pve/vm-9344-disk-0"));
  for (const name of ["hostname", "qm", "pvesh", "pvesm", "nft", "systemctl", "ip", "journalctl"]) {
    writeFileSync(join(root, "bin", name), fake, { mode: 0o700 });
  }
  const lease = {
    agent_id: agentId, owner_id: ownerId, operation_id: operationId, generation: 2, checkpoint_sha256: reservation.checkpointSha256,
    phase: "restore_claimed", source, destination, expires_at: new Date(Date.now() + 900_000).toISOString(),
    destination_evidence: { destination, checkpointSha256: reservation.checkpointSha256, coldBootVerified: true,
      destinationConnectorBlocked: true, bootId, reservationSha256: digest(serializePortableKvmDestinationReservation(reservation)) },
    connector_evidence: { destination, sourceFenced: true, sourceConnectorOff: true, destinationConnectorReady: true, bootId, connectorId },
  };
  const agent = { id: agentId, user_id: ownerId, infrastructure_binding_token_enforced: true,
    infrastructure_binding_token_hash: tokenHash, operation_kind: "wake", operation_payload: { portable_kvm: true }, cf_tunnel_id: tunnelId,
    status: "running", desired_state: "running", sleep_state: "waking", operation_id: operationId, sleep_generation: 2,
    proxmox_host: source.hostId, vmid: source.vmid, ip: source.ip,
  };
  const env: Record<string, string> = {};
  const runHostScript = jest.fn(async (request: { hostId: string; script: string; timeoutMs: number }) => {
    expect(request.hostId).toBe(destination.hostId);
    const uid = process.getuid?.() ?? 0;
    const script = request.script
      .replaceAll("/var/lib/hivra-sleep", join(root, "sleep"))
      .replaceAll("/etc/pve/qemu-server", join(root, "pve"))
      .replaceAll("/etc/pve/lxc", join(root, "lxc"))
      .replaceAll("/run/qemu-server", join(root, "run"))
      .replaceAll("/run/lock", join(root, "lock"))
      .replaceAll("/proc/meminfo", join(root, "meminfo"))
      .replaceAll("/proc/pressure/io", join(root, "pressure"))
      .replaceAll('"/dev/', '"' + root + "/dev/")
      .replaceAll("/sys/dev/block", join(root, "sys"))
      .replaceAll("/sys/class/net", join(root, "net"))
      .replaceAll("info.st_uid == 0", "info.st_uid == " + uid)
      .replaceAll("os.geteuid() == 0", "os.geteuid() == " + uid)
      .replaceAll("stat.S_ISBLK", "stat.S_ISREG")
      .replace('struct.unpack("=Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0]', "info.st_size");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8", timeout: 4500,
      env: { NODE_ENV: "test", TEST_ROOT: root, PATH: join(root, "bin") + ":/usr/bin:/bin", ...env },
    });
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  });
  const adapter = { runHostScript, readAuthority: jest.fn(async () => ({ lease, agent })) };
  const commit = () => {
    lease.phase = "placement_committed";
    Object.assign(agent, { proxmox_host: destination.hostId, vmid: destination.vmid, ip: destination.ip });
  };
  return { adapter, lease, env, agent, bootMarker, commit, root, profile,
    boot: () => bootPortableKvmDestination({ ownerId, profile, diskReceipt }, adapter),
    events: () => readFileSync(join(root, "events"), "utf8"),
  };
}

it("fences before starting and exposes only the same boot after CAS", async () => {
  const h = host();
  h.env.TEST_RUN_GUEST = "true";
  const bootReceipt = await h.boot();
  expect(bootReceipt).toEqual({
    state: "destination_quarantined", bootId, profileSha256: digest(serializePortableKvmDestinationBootProfile(h.profile)),
  });
  expect(h.events()).toBe("install_fence\nstart\nqga_0\n");
  const input = { ownerId, profile: h.profile, bootReceipt };
  h.lease.phase = "destination_verified";
  await expect(verifyPortableKvmQuarantinedDestination(input, h.adapter)).resolves.toEqual(bootReceipt);
  await expect(enablePortableKvmDestinationNetwork(input, h.adapter)).rejects.toThrow("active pilot lease");
  expect(h.events()).toBe("install_fence\nstart\nqga_0\nqga_0\n");
  expect(h.adapter.runHostScript).toHaveBeenCalledTimes(2);
  h.commit();
  await expect(enablePortableKvmDestinationNetwork(input, h.adapter)).resolves.toEqual({
    ...bootReceipt, state: "destination_network_enabled", connectorId,
  });
  expect(h.events()).toBe("install_fence\nstart\nqga_0\nqga_0\nqga_0\nlink_up\nqga_2\ndelete_fence\nqga_1\n");
  await expect(enablePortableKvmDestinationNetwork(input, h.adapter)).resolves.toMatchObject({ connectorId });
  expect(h.events()).toMatch(/delete_fence\nqga_1\nqga_1\n$/);
  expect(h.adapter.readAuthority).toHaveBeenCalledTimes(5);
});

it("recovers a lost pre-CAS response without issuing a second start or booting a stopped prior attempt", async () => {
  const h = host();
  const receipt = await h.boot();
  await expect(h.boot()).resolves.toEqual(receipt);
  expect(h.events()).toBe("install_fence\nstart\nqga_0\nqga_0\n");
  rmSync(join(h.root, "run/9344.pid"));
  await expect(h.boot()).rejects.toThrow("observation failed");
  expect(h.events()).toBe("install_fence\nstart\nqga_0\nqga_0\n");
});

it.each(["wrong host", "wrong machine", "HA", "wrong reservation", "extra NIC", "link not down", "cloud-init", "nft drift", "pressure"])(
  "never reports pre-CAS readiness for %s", async reason => {
    const h = host(reason === "link not down" ? config.replace(",link_down=1", "")
      : reason === "extra NIC" ? config + "net1: " + nic + "\n"
      : reason === "cloud-init" ? config + "ide2: local-lvm:cloudinit,media=cdrom\n" : config);
    if (reason === "wrong host") h.env.TEST_HOST = source.hostId;
    if (reason === "wrong machine") h.env.TEST_MACHINE = "f".repeat(32);
    if (reason === "wrong reservation") writeFileSync(h.bootMarker, "another reservation\n");
    if (reason === "nft drift") h.env.TEST_NFT_DRIFT = "true";
    if (reason === "pressure") writeFileSync(join(h.root, "pressure"), "full avg10=1.10 avg60=0.10 avg300=0.10 total=1\n");
    if (reason === "HA") h.env.TEST_HA = '[{"sid":"vm:9344"}]';
    await expect(h.boot()).rejects.toThrow("observation failed");
    expect(h.events()).toBe(reason === "wrong machine" ? "install_fence\nstart\nqga_0\n"
      : reason === "nft drift" ? "install_fence\n" : "");
  },
);

it.each(["new boot", "missing bridge fence", "host config drift"])(
  "refuses to reverify or release quarantine on %s", async reason => {
    const h = host();
    const bootReceipt = await h.boot();
    const input = { ownerId, profile: h.profile, bootReceipt };
    if (reason === "new boot") h.env.TEST_BOOT = connectorId;
    if (reason === "missing bridge fence") rmSync(join(h.root, "firewall"));
    if (reason === "host config drift") writeFileSync(join(h.root, "pve/9344.conf"), config + "name: changed\n");
    h.lease.phase = "destination_verified";
    await expect(verifyPortableKvmQuarantinedDestination(input, h.adapter)).rejects.toThrow("observation failed");
    h.commit();
    await expect(enablePortableKvmDestinationNetwork(input, h.adapter)).rejects.toThrow("observation failed");
    expect(h.events()).not.toMatch(/link_up|delete_fence/);
  },
);

it("does not dispatch with the flag off, an expiring lease or a mismatched live placement", async () => {
  const h = host();
  process.env.HIVRA_KVM_PORTABLE_QA_ENABLED = "false";
  await expect(h.boot()).rejects.toThrow("outside the enabled pilot");
  expect(h.adapter.readAuthority).not.toHaveBeenCalled();
  process.env.HIVRA_KVM_PORTABLE_QA_ENABLED = "true";
  const { expires_at } = h.lease;
  h.lease.expires_at = new Date(Date.now() + 30_000).toISOString();
  await expect(h.boot()).rejects.toThrow("active pilot lease");
  h.lease.expires_at = expires_at;
  h.agent.ip = "192.0.2.10";
  await expect(h.boot()).rejects.toThrow("not on an exact configured placement");
  expect(h.adapter.runHostScript).not.toHaveBeenCalled();
});

it("does not claim a connector without a current UUID and allows a read-only post-CAS retry", async () => {
  const h = host();
  const bootReceipt = await h.boot();
  h.commit();
  const input = { ownerId, profile: h.profile, bootReceipt };
  h.env.TEST_CONNECTOR = "not-a-connector";
  await expect(enablePortableKvmDestinationNetwork(input, h.adapter)).rejects.toThrow("observation failed");
  expect(h.events()).toMatch(/link_up\nqga_2\ndelete_fence\nqga_1\n$/);
  delete h.env.TEST_CONNECTOR;
  await expect(enablePortableKvmDestinationNetwork(input, h.adapter)).resolves.toMatchObject({ connectorId });
});

it("releases only the exact committed lock after independent edge verification and accepts its pinned retry", async () => {
  const h = host();
  const bootReceipt = await h.boot();
  h.commit();
  const input = { ownerId, profile: h.profile, bootReceipt };
  const networkReceipt = await enablePortableKvmDestinationNetwork(input, h.adapter);
  const verifyConnector = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const release = () => releasePortableKvmDestinationLock({ ...input, networkReceipt }, { ...h.adapter, verifyConnector });
  await expect(release()).rejects.toThrow("active pilot lease");
  expect(verifyConnector).not.toHaveBeenCalled();
  h.lease.phase = "connector_verified";
  h.lease.connector_evidence.connectorId = tunnelId;
  await expect(release()).rejects.toThrow("verified lease evidence");
  expect(verifyConnector).not.toHaveBeenCalled();
  h.lease.connector_evidence.connectorId = connectorId;
  await expect(release()).rejects.toThrow("unique ready edge connector");
  expect(h.events()).not.toContain("unlock");
  h.env.TEST_CONNECTOR = tunnelId;
  await expect(release()).rejects.toThrow("observation failed");
  expect(h.events()).not.toContain("unlock");
  delete h.env.TEST_CONNECTOR;
  await expect(release()).resolves.toEqual({ ...networkReceipt, state: "destination_lock_released" });
  expect(verifyConnector).toHaveBeenLastCalledWith({ agentId, tunnelId, connectorId });
  expect(h.events()).toMatch(/qga_1\nunlock\n$/);
  await expect(release()).resolves.toMatchObject({ state: "destination_lock_released" });
  await expect(enablePortableKvmDestinationNetwork(input, h.adapter)).rejects.toThrow("active pilot lease");
  expect(h.events().match(/unlock/g)).toHaveLength(1);
  rmSync(join(h.root, "sleep/portable-kvm-destinations/9344.released"));
  await expect(release()).rejects.toThrow("observation failed");
});
