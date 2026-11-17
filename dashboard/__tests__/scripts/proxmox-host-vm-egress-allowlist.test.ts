import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const scriptPath = path.join(__dirname, "../../scripts/proxmox-host-vm-egress-allowlist.sh");
const TAG_A = `hivra-bind-${"a".repeat(32)}`;
const TAG_B = `hivra-bind-${"b".repeat(32)}`;

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "vm-egress-"));
  const qemu = path.join(root, "qemu-server");
  const policies = path.join(root, "egress");
  mkdirSync(qemu);
  mkdirSync(policies);
  // A tagged computer whose cloud-init drive holds the address it booted with.
  writeFileSync(path.join(qemu, "2104.conf"), [
    "name: hivra-cc-2104",
    `tags: ${TAG_A};hivra`,
    "net0: virtio=BC:24:11:AA:BB:01,bridge=vmbr1",
    "ipconfig0: ip=10.250.20.59/24,gw=10.250.20.1",
    "",
    "[special:cloudinit]",
    "ipconfig0: ip=10.250.20.51/24,gw=10.250.20.1",
    "",
  ].join("\n"));
  // VMID reused by another computer: its policy carries the old binding tag.
  writeFileSync(path.join(qemu, "2105.conf"), `name: x\ntags: ${TAG_A}\nipconfig0: ip=10.250.20.52/24\n`);
  writeFileSync(path.join(policies, "2104.json"), JSON.stringify({
    version: 1, vmid: 2104, binding_tag: TAG_A,
    sites: ["github.com", "api.example.com", "10.0.0.0/8", "bad host", "*.wild.com", "8.8.4.0/24"],
    required: ["hivra.cloud", "198.41.192.0/24"],
  }));
  writeFileSync(path.join(policies, "2105.json"), JSON.stringify({ version: 1, vmid: 2105, binding_tag: TAG_B, sites: ["x.com"], required: [] }));
  writeFileSync(path.join(policies, "2106.json"), JSON.stringify({ version: 1, vmid: 2106, binding_tag: TAG_A, sites: [], required: [] }));
  writeFileSync(path.join(policies, "notes.txt"), "ignored");
  const resolve = path.join(root, "resolve.json");
  writeFileSync(resolve, JSON.stringify({
    "github.com": ["140.82.112.3", "140.82.112.4"],
    "hivra.cloud": ["76.76.21.21"],
    "api.example.com": ["10.1.2.3"],
  }));
  return { root, qemu, policies, resolve };
}

function render(f: ReturnType<typeof fixture>) {
  return execFileSync("bash", [scriptPath, "--render"], {
    encoding: "utf8",
    env: { ...process.env, QEMU_CONF_DIR: f.qemu, EGRESS_POLICY_DIR: f.policies, EGRESS_RESOLVE_FIXTURE: f.resolve },
  });
}

describe("proxmox-host-vm-egress-allowlist --render", () => {
  const f = fixture();
  const out = render(f);

  it("limits the computer by the address it booted with", () => {
    expect(out).toContain("ip saddr 10.250.20.51 ip daddr @allow_2104 accept");
    expect(out).toContain("ip saddr 10.250.20.51 counter reject with icmpx admin-prohibited");
    expect(out).not.toContain("10.250.20.59");
  });

  it("keeps replies, DNS and clock sync open", () => {
    expect(out).toContain("ip saddr 10.250.20.51 ct state established,related accept");
    expect(out).toContain("ip saddr 10.250.20.51 meta l4proto { tcp, udp } th dport 53 accept");
    expect(out).toContain("ip saddr 10.250.20.51 udp dport 123 accept");
  });

  it("allows the resolved sites plus Hivra's required ones, and only public addresses", () => {
    const set = out.split("\n").find((line) => line.includes("elements ="));
    expect(set).toBe("\t\telements = { 8.8.4.0/24, 76.76.21.21/32, 140.82.112.3/32, 140.82.112.4/32, 198.41.192.0/24 }");
    expect(out).toContain("# note: vm 2104: 10.0.0.0/8 is not a public address; ignored");
    expect(out).toContain("# note: vm 2104: 'bad host' is not a host name; ignored");
    expect(out).toContain("# note: vm 2104: '*.wild.com' is not a host name; ignored");
    expect(out).toContain("# note: vm 2104: api.example.com did not resolve; nothing allowed for it this run");
  });

  it("never applies a policy to a VM that no longer carries its binding tag, or to a VM that is not here", () => {
    expect(out).toContain("# note: vm 2105: binding tag does not match this VM; not applied");
    expect(out).toContain("# note: vm 2106: no VM config on this host; not applied");
    expect(out).not.toContain("10.250.20.52");
    expect(out).toContain("# policies=1");
  });

  it("renders a ruleset nft accepts", () => {
    const nft = spawnSync("nft", ["--version"], { encoding: "utf8" });
    if (nft.status !== 0) return; // nft is not installed on this runner
    const file = path.join(f.root, "rules.nft");
    writeFileSync(file, out.split("\n").filter((line) => !line.startsWith("# ")).join("\n"));
    const check = spawnSync("nft", ["-c", "-f", file], { encoding: "utf8" });
    if (check.status !== 0 && /Operation not permitted|permission/i.test(check.stderr)) return; // no netlink rights here
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });
});

describe("proxmox-host-vm-egress-allowlist with no policies", () => {
  it("renders an empty table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vm-egress-empty-"));
    const out = execFileSync("bash", [scriptPath, "--render"], {
      encoding: "utf8",
      env: { ...process.env, QEMU_CONF_DIR: root, EGRESS_POLICY_DIR: path.join(root, "missing") },
    });
    expect(out).toContain("type filter hook forward priority -5; policy accept;");
    expect(out).not.toContain("ip saddr");
    expect(out).toContain("# policies=0");
  });
});
