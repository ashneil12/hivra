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
    expect(out).not.toMatch(/iifname "tap2097i0" (arp saddr ip|ip saddr)/);
    expect(out).toContain('iifname "tap2099i0" ether saddr != bc:24:11:aa:bb:06 drop');
    expect(out).not.toMatch(/iifname "tap2099i0" ip saddr !=/);
    expect(out).toContain('iifname "tap2099i1" ip saddr != 10.250.20.77 drop');
  });

  it("covers containers through their veth", () => {
    expect(out).toContain('iifname "veth1010i0" ether saddr != bc:24:11:aa:bb:04 drop');
    expect(out).toContain('iifname "veth1010i0" ip saddr != 10.250.20.70 drop');
  });

  it("reports what it pinned", () => {
    expect(out.trim().split("\n").pop()).toBe("# pinned 5 NIC(s), 3 with a static IPv4");
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
    };
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

  it("refuses --apply without root", () => {
    const { env } = stubs("exit 0");
    writeFileSync(path.join(env.PATH.split(":")[0], "id"), "#!/usr/bin/env bash\necho 1000\n");
    const res = spawnSync("bash", [scriptPath, "--apply"], { encoding: "utf8", env });
    expect(res.status).toBe(2);
  });

  it("--check passes when the live table matches and fails on drift", () => {
    const { f, env } = stubs("exit 0");
    const rendered = render(f);
    const live = path.join(f.root, "live.nft");
    writeFileSync(live, rendered.replace(/^\s*#.*$/gm, ""));
    writeFileSync(path.join(env.PATH.split(":")[0], "nft"), `#!/usr/bin/env bash\ncat "${live}"\n`);
    expect(spawnSync("bash", [scriptPath, "--check"], { encoding: "utf8", env }).status).toBe(0);
    writeFileSync(live, rendered.replace('iifname "tap1148i0" ip saddr != 10.250.20.51 drop', ""));
    const drift = spawnSync("bash", [scriptPath, "--check"], { encoding: "utf8", env });
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain("DRIFT");
  });
});
