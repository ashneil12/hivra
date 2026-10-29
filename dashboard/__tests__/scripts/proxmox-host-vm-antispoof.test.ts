import { execFileSync, spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const scriptPath = path.join(__dirname, "../../scripts/proxmox-host-vm-antispoof.sh");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "vm-antispoof-"));
  const qemu = path.join(root, "qemu-server");
  const lxc = path.join(root, "lxc");
  mkdirSync(qemu);
  mkdirSync(lxc);
  // Static-IP Hermes guest, with an older MAC in a snapshot section that must be ignored.
  writeFileSync(
    path.join(qemu, "1148.conf"),
    [
      "name: hermes-atlas-00000000",
      "net0: virtio=BC:24:11:AA:BB:01,bridge=vmbr1",
      "ipconfig0: ip=10.250.20.51/24,gw=10.250.20.1",
      "",
      "[snap1]",
      "net0: virtio=BC:24:11:00:00:99,bridge=vmbr1",
      "ipconfig0: ip=10.250.20.99/24",
      "",
    ].join("\n"),
  );
  // A BYO-ISO desktop: no ipconfig, so MAC pin only.
  writeFileSync(path.join(qemu, "2097.conf"), "name: win\nnet0: e1000=BC:24:11:AA:BB:02,bridge=vmbr1\n");
  // A DHCP guest with two NICs.
  writeFileSync(
    path.join(qemu, "2099.conf"),
    "name: lab\nnet0: virtio=BC:24:11:AA:BB:06,bridge=vmbr1\nipconfig0: ip=dhcp\nnet1: virtio=BC:24:11:AA:BB:07,bridge=vmbr1\nipconfig1: ip=10.250.20.77/24\n",
  );
  // Templates never run.
  writeFileSync(path.join(qemu, "9000.conf"), "template: 1\nnet0: virtio=BC:24:11:AA:BB:03,bridge=vmbr1\n");
  // The "model=...,macaddr=..." form and a long e1000 model name, both real Proxmox shapes.
  writeFileSync(path.join(qemu, "2100.conf"), "name: a\nnet0: model=virtio,macaddr=BC:24:11:AA:BB:08,bridge=vmbr1\nipconfig0: ip=10.250.20.80/24\n");
  writeFileSync(path.join(qemu, "2101.conf"), "name: b\nnet0: e1000-82540em=BC:24:11:AA:BB:09,bridge=vmbr1\n");
  // ipconfig changed while running: the guest still has the value on its cloud-init drive.
  writeFileSync(
    path.join(qemu, "2102.conf"),
    "name: c\nnet0: virtio=BC:24:11:AA:BB:0A,bridge=vmbr1\nipconfig0: ip=10.250.20.91/24\n\n[special:cloudinit]\nipconfig0: ip=10.250.20.90/24\n",
  );
  writeFileSync(
    path.join(lxc, "1010.conf"),
    "hostname: ct\nnet0: name=eth0,bridge=vmbr1,hwaddr=BC:24:11:AA:BB:04,ip=10.250.20.70/24,gw=10.250.20.1,type=veth\n",
  );
  return { root, qemu, lxc };
}

function render(f: ReturnType<typeof fixture>) {
  return execFileSync("bash", [scriptPath, "--render"], {
    encoding: "utf8",
    env: { ...process.env, QEMU_CONF_DIR: f.qemu, LXC_CONF_DIR: f.lxc },
  });
}

describe("proxmox-host-vm-antispoof --render", () => {
  const out = render(fixture());

  it("replaces one bridge table atomically, hooked before every other bridge rule", () => {
    expect(out.startsWith(
      "table bridge hermes_vm_antispoof\ndelete table bridge hermes_vm_antispoof\ntable bridge hermes_vm_antispoof {",
    )).toBe(true);
    expect(out).toContain("type filter hook prerouting priority -300; policy accept;");
  });

  it("pins a static-IP guest to its MAC and IP, allowing only DHCP discover and ARP probes from 0.0.0.0", () => {
    const q = 'iifname "tap1148i0"';
    expect(out).toContain(`${q} ether saddr != bc:24:11:aa:bb:01 drop`);
    expect(out).toContain(`${q} arp saddr ether != bc:24:11:aa:bb:01 drop`);
    expect(out).toContain(`${q} arp saddr ip != { 0.0.0.0, 10.250.20.51 } drop`);
    expect(out).toContain(`${q} ip saddr 0.0.0.0 udp sport 68 udp dport 67 accept`);
    expect(out).toContain(`${q} ip saddr != 10.250.20.51 drop`);
    expect(out).toContain(`${q} ip6 saddr != { ::, fe80::/10 } drop`);
    // The DHCP allowance must come before the source-IP drop or it never matches.
    expect(out.indexOf(`${q} ip saddr 0.0.0.0`)).toBeLessThan(out.indexOf(`${q} ip saddr != 10.250.20.51`));
  });

  it("ignores snapshot sections and templates", () => {
    expect(out).not.toContain("bc:24:11:00:00:99");
    expect(out).not.toContain("10.250.20.99");
    expect(out).not.toContain("tap9000i0");
  });

  it("pins guests without a static IPv4 by MAC only, per NIC", () => {
    expect(out).toContain('iifname "tap2097i0" ether saddr != bc:24:11:aa:bb:02 drop');
    expect(out).not.toMatch(/iifname "tap2097i0" (arp saddr ip !=|ip saddr !=)/);
    expect(out).toContain('iifname "tap2099i0" ether saddr != bc:24:11:aa:bb:06 drop');
    expect(out).not.toMatch(/iifname "tap2099i0" ip saddr !=/);
    expect(out).toContain('iifname "tap2099i1" ip saddr != 10.250.20.77 drop');
  });

  it("covers containers through their veth", () => {
    expect(out).toContain('iifname "veth1010i0" ether saddr != bc:24:11:aa:bb:04 drop');
    expect(out).toContain('iifname "veth1010i0" ip saddr != 10.250.20.70 drop');
  });

  it("drops VLAN-tagged frames first, so a VID 0 tag cannot hide spoofed ARP", () => {
    for (const port of ["tap1148i0", "tap2097i0", "veth1010i0"]) {
      const vlan = out.indexOf(`iifname "${port}" ether type { 8021q, 8021ad } drop`);
      expect(vlan).toBeGreaterThan(-1);
      expect(vlan).toBeLessThan(out.indexOf(`iifname "${port}" ether saddr`));
    }
  });

  it("keeps MAC-only NICs from claiming any pinned address or gateway", () => {
    expect(out).toMatch(/set pinned_v4 \{\n\t\ttype ipv4_addr\n\t\telements = \{ 10\.250\.20\.1, 10\.250\.20\.51, 10\.250\.20\.70, 10\.250\.20\.77, 10\.250\.20\.80, 10\.250\.20\.90 \}/);
    expect(out).toContain('iifname "tap2097i0" arp saddr ip @pinned_v4 drop');
    expect(out).toContain('iifname "tap2097i0" ip saddr @pinned_v4 drop');
    expect(out).toContain('iifname "tap2099i0" arp saddr ip @pinned_v4 drop');
    expect(out).not.toContain('iifname "tap1148i0" arp saddr ip @pinned_v4');
  });

  it("drops guest router advertisements and redirects", () => {
    expect(out).toContain('iifname "tap1148i0" icmpv6 type { nd-router-advert, nd-redirect } drop');
  });

  it("reads macaddr= and long model names, and prefers the applied cloud-init address", () => {
    expect(out).toContain('iifname "tap2100i0" ether saddr != bc:24:11:aa:bb:08 drop');
    expect(out).toContain('iifname "tap2101i0" ether saddr != bc:24:11:aa:bb:09 drop');
    expect(out).toContain('iifname "tap2102i0" ip saddr != 10.250.20.90 drop');
    expect(out).not.toContain("10.250.20.91");
  });

  it("reports what it pinned", () => {
    const tail = out.trim().split("\n");
    expect(tail.pop()).toBe("# pinned 8 NIC(s), 5 with a static IPv4");
    expect(tail.pop()).toBe("# skipped_count=0");
  });
});

describe("proxmox-host-vm-antispoof --render with bad configs", () => {
  it("skips an unreadable or MAC-less NIC without failing the whole table", () => {
    const f = fixture();
    writeFileSync(path.join(f.qemu, "3000.conf"), Buffer.from([0x6e, 0x65, 0x74, 0x30, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));
    writeFileSync(path.join(f.qemu, "3001.conf"), "name: x\nnet0: virtio,bridge=vmbr1\n");
    const out = render(f);
    expect(out).toContain('iifname "tap1148i0" ether saddr != bc:24:11:aa:bb:01 drop');
    expect(out).toContain("# skipped: qemu 3001 net0: no MAC in config");
    expect(out).toMatch(/# skipped_count=[12]\n/);
  });
});

describe("proxmox-host-vm-antispoof --apply and --check", () => {
  function stubs(nftBody: string) {
    const f = fixture();
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    const log = path.join(f.root, "nft.log");
    writeFileSync(path.join(bin, "id"), "#!/usr/bin/env bash\necho 0\n");
    writeFileSync(path.join(bin, "nft"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n${nftBody}\n`);
    chmodSync(path.join(bin, "id"), 0o755);
    chmodSync(path.join(bin, "nft"), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      QEMU_CONF_DIR: f.qemu,
      LXC_CONF_DIR: f.lxc,
      ANTISPOOF_LOCK: path.join(f.root, "lock"),
      ANTISPOOF_TMPDIR: f.root,
      SYS_CLASS_NET: path.join(f.root, "sys-class-net"),
    };
    mkdirSync(env.SYS_CLASS_NET);
    return { f, env, log };
  }

  it("validates with nft -c before loading", () => {
    const { env, log } = stubs("exit 0");
    const res = spawnSync("bash", [scriptPath, "--apply"], { encoding: "utf8", env });
    expect(res.status).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls[0]).toMatch(/^-c -f /);
    expect(calls[1]).toMatch(/^-f /);
  });

  it("never loads a ruleset that fails nft -c", () => {
    const { env, log } = stubs('[ "$1" = "-c" ] && exit 1; exit 0');
    const res = spawnSync("bash", [scriptPath, "--apply"], { encoding: "utf8", env });
    expect(res.status).not.toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("refuses to load an empty table while guest ports exist (configs not mounted)", () => {
    const { f, env, log } = stubs("exit 0");
    writeFileSync(path.join(env.SYS_CLASS_NET, "tap1148i0"), "");
    const empty = path.join(f.root, "empty");
    mkdirSync(empty);
    const res = spawnSync("bash", [scriptPath, "--apply"], {
      encoding: "utf8",
      env: { ...env, QEMU_CONF_DIR: empty, LXC_CONF_DIR: empty },
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("refusing to load an empty table");
    expect(() => readFileSync(log, "utf8")).toThrow();
  });

  it("refuses --apply without root", () => {
    const { env } = stubs("exit 0");
    writeFileSync(path.join(env.PATH.split(":")[0], "id"), "#!/usr/bin/env bash\necho 1000\n");
    const res = spawnSync("bash", [scriptPath, "--apply"], { encoding: "utf8", env });
    expect(res.status).toBe(2);
  });

  it("--check passes when the live table matches and fails on drift", () => {
    const { f, env } = stubs("exit 0");
    // nft lists the hook priority by name.
    const rendered = render(f).replace("priority -300;", "priority dstnat;");
    const live = path.join(f.root, "live.nft");
    writeFileSync(live, rendered.replace(/^\s*#.*$/gm, ""));
    writeFileSync(path.join(env.PATH.split(":")[0], "nft"), `#!/usr/bin/env bash\ncat "${live}"\n`);
    expect(spawnSync("bash", [scriptPath, "--check"], { encoding: "utf8", env }).status).toBe(0);
    writeFileSync(live, rendered.replace('iifname "tap1148i0" ip saddr != 10.250.20.51 drop', ""));
    const drift = spawnSync("bash", [scriptPath, "--check"], { encoding: "utf8", env });
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain("DRIFT");
  });

  it("--check fails when the table is missing, a NIC is unpinned, or a live port has no config", () => {
    const { f, env } = stubs("exit 1");
    expect(spawnSync("bash", [scriptPath, "--check"], { encoding: "utf8", env }).stdout).toContain("is not loaded");
    const live = path.join(f.root, "live.nft");
    writeFileSync(live, render(f).replace("priority -300;", "priority dstnat;").replace(/^\s*#.*$/gm, ""));
    writeFileSync(path.join(env.PATH.split(":")[0], "nft"), `#!/usr/bin/env bash\ncat "${live}"\n`);
    writeFileSync(path.join(env.SYS_CLASS_NET, "tap4000i0"), "");
    const orphan = spawnSync("bash", [scriptPath, "--check"], { encoding: "utf8", env });
    expect(orphan.status).toBe(1);
    expect(orphan.stdout).toContain("tap4000i0");
  });
});
