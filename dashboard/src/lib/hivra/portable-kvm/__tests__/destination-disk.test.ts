import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPortableKvmDestinationDiskScript,
  parsePortableKvmDestinationDiskReceipt,
  serializePortableKvmDestinationReservation,
} from "../destination-disk";

jest.mock("server-only", () => ({}));

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const image = Buffer.concat([Buffer.alloc(512, 12), Buffer.alloc(512)]);
const blank = Buffer.alloc(image.length, 41);
const tag = "hivra-bind-" + "a".repeat(32);
const volume = "local-lvm:vm-9344-disk-0";
const config = [
  "agent: enabled=1", "arch: x86_64", "bios: seabios", "machine: pc-i440fx-9.2", "ostype: l26",
  "boot: order=scsi0", "scsihw: virtio-scsi-single", "lock: backup",
  "scsi0: " + volume + ",discard=on,iothread=1", "tags: qa;" + tag, "",
].join("\n");
const baseReservation = {
  agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  generation: 2, checkpointSha256: "3".repeat(64), hostId: "qa-destination", vmid: 9344, bindingTag: tag,
  configurationSha256: digest(config), rawConfigurationSha256: digest(config),
  storageId: "local-lvm", volumeName: "vm-9344-disk-0", volumeGroup: "pve", deviceMapperUuid: "LVM-" + "A".repeat(64),
  disk: { key: "scsi0" as const, snapshotId: "4".repeat(64), sha256: digest(image), bytes: image.length },
};
const roots = new Set<string>();
const fakePassword = "a".repeat(64);

afterEach(() => {
  for (const dir of roots) rmSync(dir, { force: true, recursive: true });
  roots.clear();
});

function fakeHost(current = config, raw = current, capacity = blank) {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-destination-"));
  roots.add(root);
  for (const dir of ["bin", "state/portable-kvm-destinations", "stage", "dev/pve", "pve", "run", "lock", "sys/0:0/dm"]) {
    mkdirSync(join(root, dir), { mode: 0o700, recursive: true });
  }
  const reservation = { ...baseReservation, configurationSha256: digest(current), rawConfigurationSha256: digest(raw) };
  const path = join(root, "dev/dm-0");
  const marker = join(root, "state/portable-kvm-destinations/9344");
  writeFileSync(marker, serializePortableKvmDestinationReservation(reservation), { mode: 0o600 });
  writeFileSync(path, capacity);
  symlinkSync(path, join(root, "dev/pve/vm-9344-disk-0"));
  writeFileSync(join(root, "sys/0:0/dm/uuid"), reservation.deviceMapperUuid);
  writeFileSync(join(root, "current"), current);
  writeFileSync(join(root, "pve/9344.conf"), raw);
  writeFileSync(join(root, "image"), image);
  writeFileSync(join(root, "pressure"), "full avg10=0.50 avg60=0.50 avg300=0.50 total=1\n");
  writeFileSync(join(root, "events"), "");
  const put = (name: string, ...lines: string[]) =>
    writeFileSync(join(root, "bin", name), ["#!/bin/bash", "set -euo pipefail", ...lines, ""].join("\n"), { mode: 0o700 });
  put("hostname", 'echo "$TEST_HOST"');
  put("qm", 'case "$*" in',
    '  "status 9344") echo "status: $TEST_VM_STATUS" ;;',
    '  "config 9344 --current 1") cat "$TEST_ROOT/current" ;;',
    '  *) exit 99 ;;', "esac");
  put("pvesm", 'case "$*" in',
    '  "status --storage local-lvm") echo Header; echo "local-lvm $TEST_STORAGE_TYPE active" ;;',
    '  "path ' + volume + '") echo "$TEST_PATH" ;;',
    '  *) exit 99 ;;', "esac");
  const args = `--repo sftp:cold:hivra-portable-computers/${reservation.agentId}-${reservation.operationId} --no-cache dump --quiet ${reservation.disk.snapshotId} /scsi0.raw`;
  put("restic", '[ "$*" = "' + args + '" ]',
    '[ "$RESTIC_PASSWORD" = "' + fakePassword + '" ] && [ -z "${RESTIC_PASSWORD_FILE+x}" ]',
    `[ "$(sha256sum < "$TEST_ROOT/dev/dm-0" | cut -d' ' -f1)" = "${digest(capacity)}" ]`,
    'echo dump >>"$TEST_ROOT/events"', 'cat "$TEST_ROOT/image"',
    `if [ "$TEST_CONFIG_DRIFT" = yes ]; then echo 'name: changed' >>"$TEST_ROOT/current"; fi`,
    `if [ "$TEST_PRESSURE_DRIFT" = yes ]; then echo 'full avg10=1.01 avg60=0.50 avg300=0.50 total=1' >"$TEST_ROOT/pressure"; fi`,
    'exit "$TEST_RESTIC_EXIT"');
  put("dd", '[ "$#" -eq 4 ] && [[ "$1" =~ ^if=/proc/self/fd/[0-9]+$ ]] && [ "$2 $3 $4" = "iflag=direct bs=4M status=none" ]',
    '[ -z "${RESTIC_PASSWORD+x}" ]', 'echo readback >>"$TEST_ROOT/events"',
    'case "$TEST_READBACK" in',
    '  corrupt) tr "\\014" "\\015" < "${1#if=}" ;;',
    '  short) head -c 512 "${1#if=}" ;;',
    '  interrupted) cat "${1#if=}"; exit 1 ;;',
    '  drift) cat "${1#if=}"; echo "onboot: 1" >>"$TEST_ROOT/current" ;;',
    '  *) cat "${1#if=}" ;;', "esac");

  const run = (input = reservation, env: Record<string, string> = {}, password = fakePassword, heldLock?: string) => {
    const uid = process.getuid?.() ?? 0;
    const script = buildPortableKvmDestinationDiskScript(input)
      .replaceAll("/var/lib/hivra-sleep", join(root, "state"))
      .replaceAll("/var/lib/hivra/portable-kvm-restore-staging", join(root, "stage"))
      .replaceAll("/etc/pve/qemu-server", join(root, "pve"))
      .replaceAll("/run/qemu-server", join(root, "run"))
      .replaceAll("/run/lock", join(root, "lock"))
      .replaceAll('"/dev/', '"' + root + "/dev/")
      .replaceAll("/sys/dev/block", join(root, "sys"))
      .replace("/proc/pressure/io", join(root, "pressure"))
      .replaceAll("info.st_uid == 0", "info.st_uid == " + uid)
      .replace("parent.st_uid == 0", "parent.st_uid == " + uid)
      .replace("os.geteuid() == 0", "os.geteuid() == " + uid)
      .replaceAll("stat.S_ISBLK", "stat.S_ISREG")
      .replace('struct.unpack("=Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0]', "info.st_size");
    return spawnSync(heldLock ? "flock" : "bash",
      heldLock ? [join(root, "lock", heldLock), "bash", "-c", script] : ["-c", script], {
      input: password + "\n", encoding: "utf8", timeout: 5000,
      env: {
        NODE_ENV: "test", PATH: join(root, "bin") + ":/usr/bin:/bin", TEST_ROOT: root, RESTIC_PASSWORD_FILE: "not-used",
        TEST_HOST: "qa-destination", TEST_VM_STATUS: "stopped", TEST_STORAGE_TYPE: "lvmthin",
        TEST_PATH: join(root, "dev/pve/vm-9344-disk-0"), TEST_CONFIG_DRIFT: "", TEST_RESTIC_EXIT: "0",
        TEST_READBACK: "ok", TEST_PRESSURE_DRIFT: "", ...env,
      },
    });
  };
  return { root, marker, reservation, path, run, capacity, events: () => readFileSync(join(root, "events"), "utf8") };
}

function refused(host: ReturnType<typeof fakeHost>, result: ReturnType<typeof host.run>, beforeWrite = true) {
  expect(result.status).toBe(1);
  expect(parsePortableKvmDestinationDiskReceipt(result.stdout, host.reservation)).toBeNull();
  expect(result.stderr).not.toContain(fakePassword);
  expect(readFileSync(host.path)).toEqual(beforeWrite ? host.capacity : image);
  expect(readdirSync(join(host.root, "stage"))).toEqual([]);
}

it("writes the complete verified image, including zero extents, then reads it separately", () => {
  const host = fakeHost();
  const result = host.run();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(host.events()).toBe("dump\nreadback\n");
  expect(readFileSync(host.path)).toEqual(image);
  expect(readdirSync(join(host.root, "stage"))).toEqual([]);
  expect(parsePortableKvmDestinationDiskReceipt(result.stdout, host.reservation)).toEqual({
    state: "disk_restored_verified", reservation: host.reservation, readback: { bytes: image.length, sha256: digest(image) },
  });
  expect(parsePortableKvmDestinationDiskReceipt(result.stdout.repeat(2), host.reservation)).toBeNull();
  expect(parsePortableKvmDestinationDiskReceipt(result.stdout.replace(digest(image), "e".repeat(64)), host.reservation)).toBeNull();
  expect(parsePortableKvmDestinationDiskReceipt(result.stdout, { ...host.reservation, generation: 3 })).toBeNull();
});

it("writes only scsi0 with a qualified ordinary generated NoCloud seed and serial console present", () => {
  const candidate = config +
    "cpu: host\ncpulimit: 2\nserial0: socket\nvga: serial0\n" +
    "ide2: local-lvm:vm-9344-cloudinit,media=cdrom,size=4M\nciuser: ubuntu\ncitype: nocloud\nciupgrade: 0\n" +
    "ipconfig0: ip=192.0.2.44/24,gw=192.0.2.1\nnameserver: 192.0.2.53\n" +
    "net0: virtio=02:11:22:33:44:55,bridge=vmbr27,firewall=1,link_down=1\n" +
    `cicustom: meta=local:snippets/hivra-portable-meta-${baseReservation.operationId}.yaml\n`;
  const host = fakeHost(candidate);
  const observed = host.run();
  expect(observed.stderr).toBe("");
  expect(parsePortableKvmDestinationDiskReceipt(observed.stdout, host.reservation)).toMatchObject({
    state: "disk_restored_verified",
  });
  expect(readFileSync(host.path)).toEqual(image);
  const bad = fakeHost(candidate.replace("meta=", "vendor="));
  refused(bad, bad.run());
});

it.each(["wrong host", "wrong generation", "wrong checkpoint", "symlink reservation", "public reservation", "running", "pid",
  "wrong dm uuid", "different storage", "different path", "different capacity", "bad key", "raw drift"])(
  "refuses %s before downloading or changing disk bytes", what => {
    const host = fakeHost(config, config, what === "different capacity" ? Buffer.alloc(2048, 41) : blank);
    const env: Record<string, string> = {};
    let input = host.reservation;
    if (what === "wrong host") env.TEST_HOST = "qa-other";
    if (what === "wrong generation") input = { ...input, generation: 3 };
    if (what === "wrong checkpoint") input = { ...input, checkpointSha256: "0".repeat(64) };
    if (what === "symlink reservation") {
      rmSync(host.marker);
      writeFileSync(host.marker + ".other", serializePortableKvmDestinationReservation(input), { mode: 0o600 });
      symlinkSync(host.marker + ".other", host.marker);
    }
    if (what === "public reservation") chmodSync(host.marker, 0o644);
    if (what === "running") env.TEST_VM_STATUS = "running";
    if (what === "pid") writeFileSync(join(host.root, "run/9344.pid"), "99");
    if (what === "wrong dm uuid") writeFileSync(join(host.root, "sys/0:0/dm/uuid"), "LVM-" + "B".repeat(64));
    if (what === "different storage") env.TEST_STORAGE_TYPE = "dir";
    if (what === "different path") env.TEST_PATH = host.path;
    if (what === "raw drift") writeFileSync(join(host.root, "pve/9344.conf"), config + "# drift\n");
    refused(host, host.run(input, env, what === "bad key" ? "bad" : fakePassword));
    expect(host.events()).toBe("");
  },
);

it.each(["hivra-computer-backup.lock", "hivra-vm-9344.backup.lock", "hivra-vm-9344.lock"])("refuses a held %s", lock => {
  const host = fakeHost();
  refused(host, host.run(host.reservation, {}, fakePassword, lock));
  expect(host.events()).toBe("");
});

it.each([
  config.replace("lock: backup\n", ""), config.replace("lock: backup", "lock: migrate"),
  config.replace(tag, tag + ";hivra-bind-" + "b".repeat(32)), config + "onboot: 1\n",
  config + "scsi1: local-lvm:vm-9344-disk-1\n", config + "efidisk0: local-lvm:vm-9344-disk-1\n",
  config + "args: -anything\n", config + "ide2: local-lvm:vm-9344-cloudinit,media=cdrom\n",
  config.replace(volume, "local-lvm:vm-9344-disk-1"), config.replace("discard=on", "media=cdrom"),
  config.replace("bios: seabios", "bios: ovmf"),
  config.replace("agent: enabled=1", "agent: enabled=1,type=other"),
])("rejects unsupported configurations even if the registered hashes match", candidate => {
  const host = fakeHost(candidate);
  refused(host, host.run());
  expect(host.events()).toBe("");
});

it("refuses pending config sections even with matching registered hashes", () => {
  const host = fakeHost(config, config + "[PENDING]\nmemory: 4096\n");
  refused(host, host.run());
  expect(host.events()).toBe("");
});

it.each(["short", "oversize", "corrupt", "download_failed", "configuration_drift", "pressure_drift"])(
  "leaves the destination unchanged when the staged input is %s", what => {
    const host = fakeHost();
    const env: Record<string, string> = {};
    if (what === "short") writeFileSync(join(host.root, "image"), image.subarray(0, 512));
    if (what === "oversize") writeFileSync(join(host.root, "image"), Buffer.concat([image, Buffer.alloc(1)]));
    if (what === "corrupt") writeFileSync(join(host.root, "image"), blank);
    if (what === "download_failed") env.TEST_RESTIC_EXIT = "1";
    if (what === "configuration_drift") env.TEST_CONFIG_DRIFT = "yes";
    if (what === "pressure_drift") env.TEST_PRESSURE_DRIFT = "yes";
    refused(host, host.run(host.reservation, env));
    expect(host.events()).toBe("dump\n");
  },
);

it.each(["full avg10=1.01 avg60=0.50 avg300=0.50 total=1\n", "some avg10=0.01 avg60=0.50 avg300=0.50 total=1\n"])(
  "refuses saturated or unavailable full pressure before downloading", pressure => {
    const host = fakeHost();
    writeFileSync(join(host.root, "pressure"), pressure);
    refused(host, host.run());
    expect(host.events()).toBe("");
  },
);

it.each(["corrupt", "short", "interrupted", "drift"])("never issues evidence when the independent readback is %s", mode => {
  const host = fakeHost();
  refused(host, host.run(host.reservation, { TEST_READBACK: mode }), false);
  expect(host.events()).toBe("dump\nreadback\n");
});

it("rejects unbounded images, non-scsi0 slots and volume identities for a different VM", () => {
  for (const input of [
    { ...baseReservation, disk: { ...baseReservation.disk, bytes: 40 * 1024 ** 3 + 512 } },
    { ...baseReservation, disk: { ...baseReservation.disk, bytes: 1025 } },
    { ...baseReservation, disk: { ...baseReservation.disk, key: "scsi1" as "scsi0" } },
    { ...baseReservation, volumeName: "vm-9343-disk-0" },
    { ...baseReservation, vmid: 9302, volumeName: "vm-9302-disk-0" },
  ]) expect(() => buildPortableKvmDestinationDiskScript(input)).toThrow();
});
