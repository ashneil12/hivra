import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const scriptPath = path.join(__dirname, "../../scripts/proxmox-host-perimeter-guard.sh");
const script = readFileSync(scriptPath, "utf8");

const runGuard = (args: string[]) =>
  execFileSync("bash", [scriptPath, ...args], { encoding: "utf8" });

const rewriteInPlace = (contents: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "perimeter-guard-"));
  const target = path.join(dir, "nftables.conf");
  writeFileSync(target, contents);
  runGuard(["--rewrite-nft-only", target]);
  return { target, output: readFileSync(target, "utf8") };
};

const CF_IPV4_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

const CF_IPV6_CIDRS = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const VMBR1_TCP_DROP = 'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop';
const VMBR1_DROP = 'iifname "vmbr1" drop';
const NTP_ACCEPT = 'iifname "vmbr1" udp dport 123 accept';
const TAILSCALE_8006 = 'iifname "tailscale0" tcp dport 8006 accept';
const RFC1918_FWD_DROP =
  'iifname "vmbr1" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop';
const CF_ACCEPTS = [
  "ip saddr @cloudflare_ipv4 tcp dport { 80, 443 } accept",
  "ip6 saddr @cloudflare_ipv6 tcp dport { 80, 443 } accept",
  "ip saddr @cloudflare_ipv4 udp dport 443 accept",
  "ip6 saddr @cloudflare_ipv6 udp dport 443 accept",
];

// pve21-style: no vmbr1 drops at all, unrestricted 8006 and 80/443 accepts,
// guest DHCP/DNS allows, masquerade NAT, and the VM isolation bridge table.
const PVE21_NFT = `#!/usr/sbin/nft -f

flush ruleset

table inet filter {
	chain input { type filter hook input priority filter; policy drop;
		iif "lo" accept
		ct state established,related accept
		ip protocol icmp accept
		ip6 nexthdr icmpv6 accept
		iifname "vmbr1" udp dport 67 accept
		iifname "vmbr1" udp dport 53 accept
		iifname "vmbr1" tcp dport 53 accept
		tcp dport 22 accept
		tcp dport 8006 accept
		tcp dport { 80, 443 } accept
	}
	chain forward { type filter hook forward priority filter; policy drop;
		ct state established,related accept
		iifname "vmbr1" oifname "vmbr0" accept
		iifname "vmbr0" oifname "vmbr1" accept
	}
	chain output {
		type filter hook output priority filter; policy accept;
	}
}
table ip nat {
	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		ip saddr 10.70.0.0/16 oifname "vmbr0" masquerade
	}
}
table bridge hermes_vm_isolation {
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
}
`;

// pve11-style: older { 22, 8006 } vmbr1 drop, NTP allow already present, and
// hivra_* guest service chains across inet filter, ip nat, and the bridge
// isolation table that must all survive the rewrite.
const PVE11_NFT = `#!/usr/sbin/nft -f

flush ruleset

table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;
		iif "lo" accept
		ct state established,related accept
		iifname "vmbr1" udp dport 123 accept
		iifname "vmbr1" udp dport 67 accept
		iifname "vmbr1" udp dport 53 jump hivra_private_dns
		iifname "vmbr1" tcp dport 53 jump hivra_private_dns
		iifname "vmbr1" jump hivra_omarchy_lab_dhcp
		iifname "vmbr1" tcp dport { 22, 8006 } drop
		tcp dport 22 accept
		tcp dport 8006 accept
		tcp dport { 80, 443 } accept
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
		ct state established,related accept
		iifname "vmbr1" oifname "vmbr1" accept
		jump hivra_omarchy_2099
		iifname "vmbr1" oifname "vmbr0" accept
		iifname "vmbr0" oifname "vmbr1" accept
	}
	chain hivra_private_dns {
		udp dport 53 accept
		tcp dport 53 accept
	}
	chain hivra_omarchy_lab_dhcp {
		udp dport 67 accept
		udp dport 68 accept
	}
	chain hivra_omarchy_2099 {
		iifname "vmbr0" ip daddr 10.70.0.99 tcp dport 3389 accept
	}
	chain output {
		type filter hook output priority filter; policy accept;
	}
}
table ip nat {
	chain prerouting {
		type nat hook prerouting priority dstnat; policy accept;
		jump hivra_omarchy_2099
	}
	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		jump hivra_omarchy_2099
		oifname "vmbr0" masquerade
	}
	chain hivra_omarchy_2099 {
		iifname "vmbr0" tcp dport 3389 dnat to 10.70.0.99
	}
}
table bridge hermes_vm_isolation {
	chain forward {
		type filter hook forward priority filter; policy drop;
		ct state established,related accept
		jump hivra_guacamole_windows_2097_2098
	}
	chain hivra_guacamole_windows_2097_2098 {
		iifname "vmtab2097i0" oifname "vmtab2098i0" accept
		iifname "vmtab2098i0" oifname "vmtab2097i0" accept
	}
}
`;

describe("proxmox-host-perimeter-guard.sh", () => {
  it("is valid bash and executable", () => {
    execFileSync("bash", ["-n", scriptPath]);
    expect(statSync(scriptPath).mode & 0o111).toBeTruthy();
  });

  it("audits and applies the sshd drop-in plus validated nftables rewrite", () => {
    expect(script).toContain("/etc/ssh/sshd_config.d/99-hermes-hardening.conf");
    expect(script).toContain("/etc/nftables.conf");
    expect(script).toContain("sshd -t");
    expect(script).toContain('nft -c -f "$NFT_CONF"');
    expect(script).toContain('nft -f "$NFT_CONF"');
    expect(script).toContain("systemctl reload ssh");
    expect(script).toContain("sshd -T");
    expect(script).toContain("bak-hermes-perimeter-");
  });

  it("--write-sshd-dropin-only writes the exact hardening directives", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perimeter-guard-sshd-"));
    const target = path.join(dir, "99-hermes-hardening.conf");
    runGuard(["--write-sshd-dropin-only", target]);
    const dropin = readFileSync(target, "utf8");
    for (const directive of [
      "# Managed by proxmox-host-perimeter-guard.sh",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "ChallengeResponseAuthentication no",
      "PermitRootLogin prohibit-password",
      "MaxAuthTries 3",
      "X11Forwarding no",
    ]) {
      expect(dropin).toContain(directive);
    }
  });

  describe("--rewrite-nft-only on a pve21-style config", () => {
    it("defines the Cloudflare IPv4/IPv6 sets inside table inet filter", () => {
      const { output } = rewriteInPlace(PVE21_NFT);
      const filterTable = output.slice(
        output.indexOf("table inet filter {"),
        output.indexOf("table ip nat {"),
      );
      expect(filterTable).toContain("set cloudflare_ipv4 {");
      expect(filterTable).toContain("type ipv4_addr");
      expect(filterTable).toContain("set cloudflare_ipv6 {");
      expect(filterTable).toContain("type ipv6_addr");
      expect(filterTable).toContain("flags interval");
      for (const cidr of [...CF_IPV4_CIDRS, ...CF_IPV6_CIDRS]) {
        expect(output).toContain(cidr);
      }
    });

    it("adds the vmbr1 guest-to-host input drops before the WAN accepts", () => {
      const { output } = rewriteInPlace(PVE21_NFT);
      expect(output).toContain(NTP_ACCEPT);
      expect(output).toContain(VMBR1_TCP_DROP);
      expect(output).toMatch(/^\s*iifname "vmbr1" drop$/m);

      const ntpIdx = output.indexOf(NTP_ACCEPT);
      const tcpDropIdx = output.indexOf(VMBR1_TCP_DROP);
      const dropIdx = output.indexOf(VMBR1_DROP);
      const wanIdx = output.indexOf("tcp dport 22 accept");
      expect(ntpIdx).toBeGreaterThan(-1);
      expect(ntpIdx).toBeLessThan(tcpDropIdx);
      expect(tcpDropIdx).toBeLessThan(dropIdx);
      expect(dropIdx).toBeLessThan(wanIdx);
    });

    it("preserves the guest DHCP and DNS allows on vmbr1", () => {
      const { output } = rewriteInPlace(PVE21_NFT);
      expect(output).toContain('iifname "vmbr1" udp dport 67 accept');
      expect(output).toContain('iifname "vmbr1" udp dport 53 accept');
      expect(output).toContain('iifname "vmbr1" tcp dport 53 accept');
    });

    it("restricts 8006 to tailscale0 and 80/443 to the Cloudflare sets", () => {
      const { output } = rewriteInPlace(PVE21_NFT);
      expect(output).not.toMatch(/^\s*tcp dport 8006 accept$/m);
      expect(output).not.toMatch(/^\s*tcp dport \{ 80, 443 \} accept$/m);
      expect(output).toContain(TAILSCALE_8006);
      for (const rule of CF_ACCEPTS) {
        expect(output).toContain(rule);
      }
      expect(output).toContain('iif "lo" accept');
    });

    it("drops vmbr1 forwards to private/link-local space before the WAN accept", () => {
      const { output } = rewriteInPlace(PVE21_NFT);
      expect(output).toContain(RFC1918_FWD_DROP);
      expect(output.indexOf(RFC1918_FWD_DROP)).toBeLessThan(
        output.indexOf('iifname "vmbr1" oifname "vmbr0" accept'),
      );
    });

    it("leaves the output chain, NAT table, and bridge isolation table intact", () => {
      const { output } = rewriteInPlace(PVE21_NFT);
      expect(output).toContain("chain output {");
      expect(output).toContain("table ip nat {");
      expect(output).toContain("masquerade");
      expect(output).toContain("table bridge hermes_vm_isolation {");
    });

    it("is byte-identical on a second run", () => {
      const { target, output } = rewriteInPlace(PVE21_NFT);
      runGuard(["--rewrite-nft-only", target]);
      expect(readFileSync(target, "utf8")).toBe(output);
    });
  });

  describe("--rewrite-nft-only on a pve11-style config", () => {
    it("replaces the legacy { 22, 8006 } vmbr1 drop with the hardened pair", () => {
      const { output } = rewriteInPlace(PVE11_NFT);
      expect(output).not.toContain("{ 22, 8006 } drop");
      expect(output).toContain(VMBR1_TCP_DROP);
      expect(output.indexOf(NTP_ACCEPT)).toBeLessThan(output.indexOf(VMBR1_TCP_DROP));
      expect(output.indexOf(VMBR1_TCP_DROP)).toBeLessThan(output.indexOf("tcp dport 22 accept"));
    });

    it("hardens 8006 and 80/443 while preserving every hivra_* rule", () => {
      const { output } = rewriteInPlace(PVE11_NFT);
      expect(output).not.toMatch(/^\s*tcp dport 8006 accept$/m);
      expect(output).not.toMatch(/^\s*tcp dport \{ 80, 443 \} accept$/m);
      expect(output).toContain(TAILSCALE_8006);
      for (const rule of CF_ACCEPTS) {
        expect(output).toContain(rule);
      }
      for (const preserved of [
        "jump hivra_private_dns",
        "jump hivra_omarchy_lab_dhcp",
        "chain hivra_private_dns {",
        "chain hivra_omarchy_lab_dhcp {",
        "jump hivra_omarchy_2099",
        "chain hivra_omarchy_2099 {",
        "dnat to 10.70.0.99",
        "jump hivra_guacamole_windows_2097_2098",
        "chain hivra_guacamole_windows_2097_2098 {",
        'iifname "vmtab2097i0" oifname "vmtab2098i0" accept',
      ]) {
        expect(output).toContain(preserved);
      }
    });

    it("keeps earlier guest-to-guest/DNAT accepts ahead of the forward drop", () => {
      const { output } = rewriteInPlace(PVE11_NFT);
      expect(output).toContain(RFC1918_FWD_DROP);
      const guestAcceptIdx = output.indexOf('iifname "vmbr1" oifname "vmbr1" accept');
      const dropIdx = output.indexOf(RFC1918_FWD_DROP);
      const wanIdx = output.indexOf('iifname "vmbr1" oifname "vmbr0" accept');
      expect(guestAcceptIdx).toBeGreaterThan(-1);
      expect(guestAcceptIdx).toBeLessThan(dropIdx);
      expect(dropIdx).toBeLessThan(wanIdx);
    });
  });
});
