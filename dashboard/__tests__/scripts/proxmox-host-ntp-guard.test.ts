import { execFileSync } from "child_process";
import { readFileSync, statSync } from "fs";
import path from "path";

const scriptPath = path.join(__dirname, "../../scripts/proxmox-host-ntp-guard.sh");
const script = readFileSync(scriptPath, "utf8");

describe("proxmox-host-ntp-guard.sh", () => {
  it("is valid bash and executable", () => {
    execFileSync("bash", ["-n", scriptPath]);
    expect(statSync(scriptPath).mode & 0o111).toBeTruthy();
  });

  it("pins Proxmox hosts to reachable Hetzner chrony sources", () => {
    expect(script).toContain("/etc/chrony/conf.d/hermes-hetzner-ntp.conf");
    expect(script).toContain("server 213.239.239.165 iburst");
    expect(script).toContain("server ntp1.hetzner.de iburst");
    expect(script).toContain("server ntp2.hetzner.de iburst");
    expect(script).toContain("server ntp3.hetzner.de iburst");
    expect(script).toContain("allow 10.250.0.0/16");
    expect(script).toContain("pool[[:space:]]+2\\.debian\\.pool\\.ntp\\.org");
  });

  it("fails loudly unless chrony reaches Leap status Normal", () => {
    expect(script).toContain("chronyc tracking");
    expect(script).toContain("/^Leap status/");
    expect(script).toContain("Leap status: Normal");
    expect(script).toContain("chrony did not reach Leap status: Normal via Hetzner NTP");
  });

  it("persists and verifies the vmbr1 guest NTP nftables allow rule", () => {
    expect(script).toContain('/etc/nftables.conf');
    expect(script).toContain('table inet filter');
    expect(script).toContain('table bridge hermes_vm_isolation');
    expect(script).toContain('iifname "vmbr1" udp dport 123 accept');
    expect(script).toContain('nft -c -f "$NFT_CONF"');
    expect(script).toContain("runtime nftables input chain missing vmbr1 UDP/123 allow rule");
  });
});
