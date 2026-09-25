// What a Proxmox VE 9.2 host really printed for the live-usage reads, captured
// read-only on a Canary host for the usage design (2026-09-24): `qm config`,
// `pvesh get /cluster/resources --type vm --output-format json` and
// `qm guest cmd <vmid> get-fsinfo`. Values are as captured; the host's name,
// binding and operation tags, volume GUIDs and nameservers are replaced with
// placeholders, and each list keeps only the entries the tests need. The
// capture filtered out description lines, so the prepared computers' claim
// marker line is added back in the form their lifecycle adapter checks for.

export const FIXTURE_NODE = "fixturenode11";
export const BINDING_TAG = `hivra-bind-${"b".repeat(32)}`;
export const PREPARED_CLAIM = "33333333-3333-4333-8333-333333333333";

/** Ubuntu Desktop 1113, running (Hivra Cloud). */
export const CONFIG_1113 = `agent: enabled=1
balloon: 4096
boot: order=scsi0
ciuser: ubuntu
cores: 4
cpu: host
cpulimit: 4
cpuunits: 200
ide2: local-lvm:vm-1113-cloudinit,media=cdrom
memory: 8192
name: hivra-cc-1113
ostype: l26
scsi0: local-lvm:vm-1113-disk-0,discard=on,size=40G,ssd=1
scsihw: virtio-scsi-single
serial0: socket
tags: ${BINDING_TAG};hivra-op-${"c".repeat(32)}
vga: serial0
`;

/** Prepared Windows 2098: OVMF, TPM, a 64G SATA boot disk, an ISO second. */
export const CONFIG_2098 = `agent: enabled=1,fstrim_cloned_disks=1
bios: ovmf
boot: order=sata0;sata1
cores: 4
cpu: host
efidisk0: local-lvm:vm-2098-disk-0,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=4M
localtime: 0
machine: pc-q35-11.0
memory: 8192
name: hivra-windows-canary
onboot: 1
ostype: win11
parent: hivra-before-qga-recovery-20260914
sata0: local-lvm:vm-2098-disk-2,size=64G,ssd=1
sata1: local:iso/hivra-qga-tools.iso,media=cdrom,size=31264K
scsihw: virtio-scsi-single
sockets: 1
startup: order=30,up=15,down=60
tablet: 1
tags: ${BINDING_TAG}
tpmstate0: local-lvm:vm-2098-disk-1,size=4M,version=v2.0
vga: std
description: hivra-windows-operation%3A${PREPARED_CLAIM}
`;

/** Prepared Omarchy 2099: btrfs root on scsi0, the install ISOs still attached. */
export const CONFIG_2099 = `agent: enabled=1,fstrim_cloned_disks=1
bios: ovmf
boot: order=scsi0;ide2
cores: 4
cpu: host
efidisk0: local-lvm:vm-2099-disk-0,efitype=4m,pre-enrolled-keys=0,size=4M
ide2: local:iso/omarchy-4.0.2.iso,media=cdrom,size=6081790K
ide3: local:iso/hivra-omarchy-cidata-2099-019d13b0.iso,media=cdrom,size=368K
machine: q35
memory: 8192
name: hivra-omarchy-canary
onboot: 1
ostype: l26
parent: hivra-pre-qga-20260908
scsi0: local-lvm:vm-2099-disk-1,discard=on,iothread=1,size=40G
scsihw: virtio-scsi-single
serial0: socket
startup: order=30,up=15,down=60
description: hivra-omarchy-operation:${PREPARED_CLAIM}
`;

/** Ubuntu Desktop 1109, stopped. */
export const CONFIG_1109 = CONFIG_1113
  .replaceAll("1113", "1109")
  .replace("balloon: 4096", "balloon: 2048")
  .replace("cores: 4", "cores: 2")
  .replace("cpulimit: 4", "cpulimit: 2")
  .replace("memory: 8192", "memory: 4096");

/** /cluster/resources for the host: these VMs, and others the filter must drop. */
export const CLUSTER_RESOURCES = JSON.stringify([
  { cpu: 0.0109749940154479, disk: 0, diskread: 14256005370, diskwrite: 30847855616, id: "qemu/1113", maxcpu: 4, maxdisk: 42949672960, maxmem: 8589934592, mem: 4209631232, memhost: 5656186880, name: "hivra-cc-1113", netin: 7090017679, netout: 222274129, node: FIXTURE_NODE, status: "running", tags: `${BINDING_TAG};hivra-op-${"c".repeat(32)}`, template: 0, type: "qemu", uptime: 688433, vmid: 1113 },
  { cpu: 0.0127287016530799, disk: 0, id: "qemu/2098", maxcpu: 4, maxdisk: 68719476736, maxmem: 8589934592, mem: 3400466432, memhost: 8538865664, name: "hivra-windows-canary", node: FIXTURE_NODE, status: "running", tags: BINDING_TAG, template: 0, type: "qemu", uptime: 874461, vmid: 2098 },
  { cpu: 0.131693105564557, disk: 0, id: "qemu/2099", maxcpu: 4, maxdisk: 42949672960, maxmem: 8589934592, mem: 7828791296, memhost: 8166486016, name: "hivra-omarchy-canary", node: FIXTURE_NODE, status: "running", template: 0, type: "qemu", uptime: 688998, vmid: 2099 },
  { cpu: 0, disk: 0, id: "qemu/1109", maxcpu: 2, maxdisk: 42949672960, maxmem: 4294967296, mem: 0, name: "hivra-cc-1109", node: FIXTURE_NODE, status: "stopped", template: 0, type: "qemu", uptime: 0, vmid: 1109 },
  // Another customer's computer on the same host: never leaves it.
  { cpu: 0.5, disk: 0, id: "qemu/1130", maxcpu: 2, maxdisk: 42949672960, maxmem: 4294967296, mem: 3000000000, name: "hivra-cc-1130-other-customer", node: FIXTURE_NODE, status: "running", template: 0, type: "qemu", uptime: 1000, vmid: 1130 },
]);

/** QGA get-fsinfo for 1113 (Ubuntu 22.04, QGA 6.2): snap loops, the EFI partition and ext4 root. */
export const FSINFO_1113 = JSON.stringify([
  { name: "loop6", mountpoint: "/snap/lxd/40575", type: "squashfs", "total-bytes": 120979456, "used-bytes": 120979456, disk: [] },
  { name: "loop5", mountpoint: "/snap/core20/2922", type: "squashfs", "total-bytes": 66977792, "used-bytes": 66977792, disk: [] },
  { name: "sda15", mountpoint: "/boot/efi", type: "vfat", "total-bytes": 109395456, "used-bytes": 6342144, disk: [{ dev: "/dev/sda15", "bus-type": "scsi", serial: "0QEMU_QEMU_HARDDISK_drive-scsi0", bus: 0, target: 0, unit: 0 }] },
  { name: "loop0", mountpoint: "/snap/lxd/38800", type: "squashfs", "total-bytes": 96206848, "used-bytes": 96206848, disk: [] },
  { name: "sda1", mountpoint: "/", type: "ext4", "total-bytes": 41412915200, "used-bytes": 21686575104, disk: [{ dev: "/dev/sda1", "bus-type": "scsi", serial: "0QEMU_QEMU_HARDDISK_drive-scsi0", bus: 0, target: 0, unit: 0 }] },
], null, 2);

/** QGA get-fsinfo for Windows 2098: a CD, two System Reserved volumes and C:\. */
export const FSINFO_2098 = JSON.stringify([
  { name: "\\\\?\\Volume{22222222-2222-4222-8222-222222222222}\\", mountpoint: "D:\\", type: "CDFS", "total-bytes": 32014336, "used-bytes": 32014336, disk: [{ "bus-type": "sata" }] },
  { name: "\\\\?\\Volume{44444444-4444-4444-8444-444444444444}\\", mountpoint: "System Reserved", type: "FAT32", "total-bytes": 268435456, "used-bytes": 36392960, disk: [{ "bus-type": "sata", serial: "QM00013" }] },
  { name: "\\\\?\\Volume{55555555-5555-4555-8555-555555555555}\\", mountpoint: "System Reserved", type: "NTFS", "total-bytes": 903868416, "used-bytes": 818708480, disk: [{ "bus-type": "sata", serial: "QM00013" }] },
  { name: "\\\\?\\Volume{66666666-6666-4666-8666-666666666666}\\", mountpoint: "C:\\", type: "NTFS", "total-bytes": 67523047424, "used-bytes": 27970359296, disk: [{ "bus-type": "sata", serial: "QM00013" }] },
], null, 2);

/** QGA get-fsinfo for Omarchy 2099: two ISOs, /boot and a btrfs root. */
export const FSINFO_2099 = JSON.stringify([
  { name: "sr1", mountpoint: "/run/media/hivra/cidata", type: "iso9660", "total-bytes": 376832, "used-bytes": 376832, disk: [{ "bus-type": "sata", serial: "QEMU_DVD-ROM_QM00007" }] },
  { name: "sr0", mountpoint: "/run/media/hivra/OMARCHY_202608", type: "iso9660", "total-bytes": 6227752960, "used-bytes": 6227752960, disk: [{ "bus-type": "sata", serial: "QEMU_DVD-ROM_QM00003" }] },
  { name: "sda1", mountpoint: "/boot", type: "vfat", "total-bytes": 2143281152, "used-bytes": 42622976, disk: [{ "bus-type": "scsi", serial: "0QEMU_QEMU_HARDDISK_drive-scsi0" }] },
  { name: "sda2", mountpoint: "/", type: "btrfs", "total-bytes": 40353300480, "used-bytes": 26912878592, disk: [{ "bus-type": "scsi", serial: "0QEMU_QEMU_HARDDISK_drive-scsi0" }] },
], null, 2);

/** What `qm guest cmd 1109 ...` prints for a stopped computer (exit 2). */
export const QGA_NOT_RUNNING_1109 = "VM 1109 is not running";

/** The line the usage script prints for 1113 from the captures above. */
export const USAGE_LINE_1113 = `HIVRA_USAGE_V1 ${JSON.stringify({
  config: { agent: true, balloon: 4096, cores: 4, cpulimit: 4, diskBytes: 42949672960, memory: 8192, ostype: "l26" },
  guest: { rc: 0, readable: true, root: { fs: "ext4", mount: "/", total: 41412915200, used: 21686575104 } },
  resources: true,
  v: 1,
  vm: { cpu: 0.0109749940154479, maxcpu: 4, maxdisk: 42949672960, maxmem: 8589934592, mem: 4209631232, status: "running", uptime: 688433 },
})}`;
