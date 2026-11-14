import { execFileSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";

const scriptPath = path.join(__dirname, "../../scripts/proxmox-host-perimeter-guard.sh");
const script = readFileSync(scriptPath, "utf8");

const runGuard = (args: string[], env: Record<string, string> = {}) =>
  execFileSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const rewriteInPlace = (contents: string, extraArgs: string[] = []) => {
  const dir = mkdtempSync(path.join(tmpdir(), "perimeter-guard-"));
  const target = path.join(dir, "nftables.conf");
  writeFileSync(target, contents);
  runGuard(["--rewrite-nft-only", target, ...extraArgs]);
  return { target, output: readFileSync(target, "utf8") };
};

const CF_ONLY = ["--cloudflare-origin-only"];

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
const VMBR1_INVALID_DROP = 'iifname "vmbr1" ct state invalid drop';
const VMBR1_NEW_DROP = 'iifname "vmbr1" ct state new drop';
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

// Inline-chain host config: no vmbr1 drops at all, unrestricted 8006 and
// 80/443 accepts, guest DHCP/DNS allows, masquerade NAT, and the VM isolation
// bridge table.
const INLINE_CHAIN_NFT = `#!/usr/sbin/nft -f

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
		ip saddr 10.250.0.0/16 oifname "vmbr0" masquerade
	}
}
table bridge hermes_vm_isolation {
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
}
`;

// Custom-chains host config: older { 22, 8006 } vmbr1 drop, NTP allow already
// present, and hivra_* guest service chains across inet filter, ip nat, and
// the bridge isolation table that must all survive the rewrite.
const CUSTOM_CHAINS_NFT = `#!/usr/sbin/nft -f

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
		iifname "vmbr0" ip daddr 10.250.20.99 tcp dport 3389 accept
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
		iifname "vmbr0" tcp dport 3389 dnat to 10.250.20.99
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
    expect(script).toContain("/etc/ssh/sshd_config.d/00-hermes-hardening.conf");
    expect(script).toContain("/etc/ssh/sshd_config.d/99-hermes-hardening.conf");
    expect(script).toContain("/etc/nftables.conf");
    expect(script).toContain("sshd -t");
    expect(script).toContain('nft -c -f "$NFT_CANDIDATE"');
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

  it("--check exits 0 on a hardened host (OpenSSH 10 sshd -T output)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perimeter-guard-check-"));
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);

    const nftConf = path.join(dir, "nftables.conf");
    writeFileSync(nftConf, INLINE_CHAIN_NFT);
    runGuard(["--rewrite-nft-only", nftConf]);

    const sshdDropin = path.join(dir, "00-hermes-hardening.conf");
    runGuard(["--write-sshd-dropin-only", sshdDropin]);

    const stub = (name: string, body: string) => {
      const target = path.join(binDir, name);
      writeFileSync(target, body);
      chmodSync(target, 0o755);
    };

    stub("id", "#!/usr/bin/env bash\necho 0\n");
    // OpenSSH 10 on Debian 13 has no challengeresponseauthentication line in
    // sshd -T output; kbdinteractiveauthentication covers it instead.
    stub(
      "sshd",
      `#!/usr/bin/env bash
if [ "$*" = "-T" ]; then
  printf '%s\n' \\
      "passwordauthentication no" \\
      "kbdinteractiveauthentication no" \\
      "permitrootlogin without-password" \\
      "maxauthtries 3" \\
      "x11forwarding no"
fi
`,
    );
    // The rewritten conf carries every required input/forward rule plus the
    // cloudflare_* sets, so it stands in for both `nft list chain` and
    // `nft list ruleset` output.
    stub("nft", '#!/usr/bin/env bash\ncat "$PERIMETER_GUARD_NFT_CONF"\n');

    const output = runGuard(["--check"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PERIMETER_GUARD_NFT_CONF: nftConf,
      PERIMETER_GUARD_SSHD_DROPIN: sshdDropin,
    });
    expect(output).toContain("done");
  });

  describe("--rewrite-nft-only on an inline-chain host config", () => {
    it("defines the Cloudflare IPv4/IPv6 sets inside table inet filter", () => {
      const { output } = rewriteInPlace(INLINE_CHAIN_NFT);
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
      const { output } = rewriteInPlace(INLINE_CHAIN_NFT);
      expect(output).toContain(NTP_ACCEPT);
      // Guests can still ping their gateway and run IPv6 neighbour discovery.
      expect(output.indexOf('iifname "vmbr1" meta l4proto { icmp, ipv6-icmp } accept')).toBeLessThan(
        output.indexOf(VMBR1_NEW_DROP),
      );
      expect(output).toContain(VMBR1_TCP_DROP);
      expect(output).not.toMatch(/^\s*iifname "vmbr1" drop$/m);
      expect(output).toContain(VMBR1_INVALID_DROP);

      const ntpIdx = output.indexOf(NTP_ACCEPT);
      const tcpDropIdx = output.indexOf(VMBR1_TCP_DROP);
      const dropIdx = output.indexOf(VMBR1_NEW_DROP);
      const wanIdx = output.indexOf("tcp dport 22 accept");
      expect(ntpIdx).toBeGreaterThan(-1);
      expect(ntpIdx).toBeLessThan(tcpDropIdx);
      expect(tcpDropIdx).toBeLessThan(dropIdx);
      expect(dropIdx).toBeLessThan(wanIdx);
    });

    it("preserves the guest DHCP and DNS allows on vmbr1", () => {
      const { output } = rewriteInPlace(INLINE_CHAIN_NFT);
      expect(output).toContain('iifname "vmbr1" udp dport 67 accept');
      expect(output).toContain('iifname "vmbr1" udp dport 53 accept');
      expect(output).toContain('iifname "vmbr1" tcp dport 53 accept');
    });

    it("restricts 8006 to tailscale0 and leaves 80/443 open by default", () => {
      const { output } = rewriteInPlace(INLINE_CHAIN_NFT);
      expect(output).not.toMatch(/^\s*tcp dport 8006 accept$/m);
      expect(output).toContain(TAILSCALE_8006);
      expect(output).toMatch(/^\s*tcp dport \{ 80, 443 \} accept$/m);
      for (const rule of CF_ACCEPTS) {
        expect(output).not.toContain(rule);
      }
    });

    it("restricts 80/443 to the Cloudflare sets only with --cloudflare-origin-only", () => {
      const { output } = rewriteInPlace(INLINE_CHAIN_NFT, CF_ONLY);
      expect(output).not.toMatch(/^\s*tcp dport 8006 accept$/m);
      expect(output).not.toMatch(/^\s*tcp dport \{ 80, 443 \} accept$/m);
      expect(output).toContain(TAILSCALE_8006);
      for (const rule of CF_ACCEPTS) {
        expect(output).toContain(rule);
      }
      expect(output).toContain('iif "lo" accept');
    });

    it("drops vmbr1 forwards to private/link-local space before the WAN accept", () => {
      const { output } = rewriteInPlace(INLINE_CHAIN_NFT);
      expect(output).toContain(RFC1918_FWD_DROP);
      expect(output.indexOf(RFC1918_FWD_DROP)).toBeLessThan(
        output.indexOf('iifname "vmbr1" oifname "vmbr0" accept'),
      );
    });

    it("leaves the output chain, NAT table, and bridge isolation table intact", () => {
      const { output } = rewriteInPlace(INLINE_CHAIN_NFT);
      expect(output).toContain("chain output {");
      expect(output).toContain("table ip nat {");
      expect(output).toContain("masquerade");
      expect(output).toContain("table bridge hermes_vm_isolation {");
    });

    it("is byte-identical on a second run", () => {
      const { target, output } = rewriteInPlace(INLINE_CHAIN_NFT);
      runGuard(["--rewrite-nft-only", target]);
      expect(readFileSync(target, "utf8")).toBe(output);
      const cf = rewriteInPlace(INLINE_CHAIN_NFT, CF_ONLY);
      runGuard(["--rewrite-nft-only", cf.target, ...CF_ONLY]);
      expect(readFileSync(cf.target, "utf8")).toBe(cf.output);
    });
  });

  describe("--rewrite-nft-only on a custom-chains host config", () => {
    it("replaces the legacy { 22, 8006 } vmbr1 drop with the hardened pair", () => {
      const { output } = rewriteInPlace(CUSTOM_CHAINS_NFT);
      expect(output).not.toContain("{ 22, 8006 } drop");
      expect(output).toContain(VMBR1_TCP_DROP);
      expect(output.indexOf(NTP_ACCEPT)).toBeLessThan(output.indexOf(VMBR1_TCP_DROP));
      expect(output.indexOf(VMBR1_TCP_DROP)).toBeLessThan(output.indexOf("tcp dport 22 accept"));
    });

    it("hardens 8006 and 80/443 while preserving every hivra_* rule", () => {
      const { output } = rewriteInPlace(CUSTOM_CHAINS_NFT, CF_ONLY);
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
        "dnat to 10.250.20.99",
        "jump hivra_guacamole_windows_2097_2098",
        "chain hivra_guacamole_windows_2097_2098 {",
        'iifname "vmtab2097i0" oifname "vmtab2098i0" accept',
      ]) {
        expect(output).toContain(preserved);
      }
    });

    it("keeps earlier guest-to-guest/DNAT accepts ahead of the forward drop", () => {
      const { output } = rewriteInPlace(CUSTOM_CHAINS_NFT);
      expect(output).toContain(RFC1918_FWD_DROP);
      const guestAcceptIdx = output.indexOf('iifname "vmbr1" oifname "vmbr1" accept');
      const dropIdx = output.indexOf(RFC1918_FWD_DROP);
      const wanIdx = output.indexOf('iifname "vmbr1" oifname "vmbr0" accept');
      expect(guestAcceptIdx).toBeGreaterThan(-1);
      expect(guestAcceptIdx).toBeLessThan(dropIdx);
      expect(dropIdx).toBeLessThan(wanIdx);
    });
  });
  describe("--rewrite-nft-only rule ordering", () => {
    // WAN accept above the established/related accept: a bare vmbr1 drop
    // anchored before the first WAN accept would also drop guest replies.
    const WAN_FIRST_NFT = `table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;
		tcp dport 22 accept
		ct state established,related accept
		tcp dport 8006 accept
		tcp dport { 80, 443 } accept
		iifname "vmbr1" udp dport 67 accept
		iifname "vmbr1" udp dport 53 accept
		iifname "vmbr1" tcp dport 22 accept
		iifname "vmbr1" accept
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
		iifname "vmbr1" oifname "vmbr0" accept
	}
}
`;

    it("only drops new or invalid guest traffic so replies still reach the established accept", () => {
      const { output } = rewriteInPlace(WAN_FIRST_NFT);
      expect(output).not.toMatch(/^\s*iifname "vmbr1" drop$/m);
      const establishedIdx = output.indexOf("ct state established,related accept");
      const newDropIdx = output.indexOf(VMBR1_NEW_DROP);
      expect(newDropIdx).toBeGreaterThan(-1);
      // The drop lands above the established accept here, which is only safe
      // because it is limited to ct state new/invalid.
      expect(newDropIdx).toBeLessThan(establishedIdx);
      expect(output.indexOf(VMBR1_INVALID_DROP)).toBeLessThan(establishedIdx);
    });

    it("hoists explicit guest DHCP/DNS allows above the drop but not host-port or blanket accepts", () => {
      const { output } = rewriteInPlace(WAN_FIRST_NFT);
      const newDropIdx = output.indexOf(VMBR1_NEW_DROP);
      expect(output.indexOf('iifname "vmbr1" udp dport 67 accept')).toBeLessThan(newDropIdx);
      expect(output.indexOf('iifname "vmbr1" udp dport 53 accept')).toBeLessThan(newDropIdx);
      expect(output.indexOf('iifname "vmbr1" tcp dport 22 accept')).toBeGreaterThan(newDropIdx);
      expect(output.search(/^\s*iifname "vmbr1" accept$/m)).toBeGreaterThan(newDropIdx);
    });

    it("puts the guest block ahead of every accept or jump, whatever its prefix", () => {
      const conf = `table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;
		iif "lo" accept
		meta l4proto tcp tcp dport 8006 accept
		jump host_services
		ip6 saddr ::/0 tcp dport 22 accept
		ct state established,related accept
		counter drop
	}
	chain host_services {
		tcp dport 22 accept
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
}
`;
      const { output } = rewriteInPlace(conf);
      const input = output.slice(output.indexOf("chain input"), output.indexOf("chain host_services"));
      const blockIdx = input.indexOf(NTP_ACCEPT);
      expect(blockIdx).toBeGreaterThan(input.indexOf('iif "lo" accept'));
      for (const later of [
        "meta l4proto tcp tcp dport 8006 accept",
        "jump host_services",
        "ip6 saddr ::/0 tcp dport 22 accept",
        "counter drop",
      ]) {
        expect(input.indexOf(VMBR1_NEW_DROP)).toBeLessThan(input.indexOf(later));
      }
    });

    it("does not hoist a port range covering a host port, and hoists commented guest allows", () => {
      const conf = WAN_FIRST_NFT.replace(
        '\t\tiifname "vmbr1" udp dport 53 accept',
        '\t\tiifname "vmbr1" udp dport 53 accept comment "dns"\n\t\tiifname "vmbr1" tcp dport 1-1024 accept',
      );
      const { output } = rewriteInPlace(conf);
      const newDropIdx = output.indexOf(VMBR1_NEW_DROP);
      expect(output.indexOf('iifname "vmbr1" udp dport 53 accept comment "dns"')).toBeLessThan(newDropIdx);
      expect(output.indexOf('iifname "vmbr1" tcp dport 1-1024 accept')).toBeGreaterThan(newDropIdx);
    });

    it("upgrades a bare vmbr1 drop written by an earlier guard release", () => {
      const legacy = INLINE_CHAIN_NFT.replace(
        "\t\ttcp dport 22 accept",
        '\t\tiifname "vmbr1" drop\n\t\ttcp dport 22 accept',
      );
      const { output } = rewriteInPlace(legacy);
      expect(output).not.toMatch(/^\s*iifname "vmbr1" drop$/m);
      expect(output.split(VMBR1_NEW_DROP)).toHaveLength(2);
    });
  });

  describe("--apply", () => {
    const setupApply = (opts: { caddyfile?: string } = {}) => {
      const dir = mkdtempSync(path.join(tmpdir(), "perimeter-guard-apply-"));
      const binDir = path.join(dir, "bin");
      mkdirSync(binDir);
      const sshdDir = path.join(dir, "sshd_config.d");
      mkdirSync(sshdDir);
      const nftConf = path.join(dir, "nftables.conf");
      writeFileSync(nftConf, INLINE_CHAIN_NFT);
      const caddyDir = path.join(dir, "caddy");
      mkdirSync(caddyDir);
      if (opts.caddyfile) writeFileSync(path.join(caddyDir, "Caddyfile"), opts.caddyfile);
      const stub = (name: string, body: string) => {
        const target = path.join(binDir, name);
        writeFileSync(target, body);
        chmodSync(target, 0o755);
      };
      stub("id", "#!/usr/bin/env bash\necho 0\n");
      stub("sshd", '#!/usr/bin/env bash\n[ "$1" = "-t" ] && exit "${SSHD_T_EXIT:-0}"\nexit 0\n');
      stub("systemctl", "#!/usr/bin/env bash\nexit 0\n");
      // nft: -c validates, -f loads (records the loaded file), list prints the
      // last loaded file so the post-apply check sees what was applied.
      stub(
        "nft",
        `#!/usr/bin/env bash
log="${dir}/nft.log"
case "$1" in
  -c) echo "check $3" >> "$log"; exit "\${NFT_CHECK_EXIT:-0}" ;;
  -f) echo "load $2" >> "$log"; cp "$2" "${dir}/loaded.conf"; n=$(grep -c '^load' "$log"); [ "$n" = "1" ] && exit "\${NFT_LOAD_EXIT:-0}"; exit 0 ;;
  list) cat "${dir}/loaded.conf" ;;
esac
`,
      );
      const env = {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PERIMETER_GUARD_NFT_CONF: nftConf,
        PERIMETER_GUARD_SSHD_DROPIN: path.join(sshdDir, "00-hermes-hardening.conf"),
        PERIMETER_GUARD_SSHD_DROPIN_LEGACY: path.join(sshdDir, "99-hermes-hardening.conf"),
        PERIMETER_GUARD_CADDY_DIR: caddyDir,
      };
      const apply = (args: string[] = [], extra: Record<string, string> = {}) =>
        execFileSync("bash", [scriptPath, "--apply", ...args], {
          encoding: "utf8",
          env: { ...process.env, ...env, ...extra },
          stdio: ["ignore", "pipe", "pipe"],
        });
      return { dir, nftConf, sshdDir, env, apply };
    };

    it("validates a temp copy, shows the diff, then installs and loads it", () => {
      const { nftConf, apply } = setupApply();
      const output = apply();
      expect(output).toContain("nftables change to be applied:");
      expect(output).toContain("+" + "        " + VMBR1_NEW_DROP);
      expect(readFileSync(nftConf, "utf8")).toContain(VMBR1_NEW_DROP);
    });

    it("leaves the live file untouched when nft -c rejects the candidate", () => {
      const { nftConf, apply } = setupApply();
      expect(() => apply([], { NFT_CHECK_EXIT: "1" })).toThrow();
      expect(readFileSync(nftConf, "utf8")).toBe(INLINE_CHAIN_NFT);
    });

    it("restores and reloads the previous file when loading the new ruleset fails", () => {
      const { dir, nftConf, apply } = setupApply();
      expect(() => apply([], { NFT_LOAD_EXIT: "1" })).toThrow();
      expect(readFileSync(nftConf, "utf8")).toBe(INLINE_CHAIN_NFT);
      expect(readFileSync(path.join(dir, "loaded.conf"), "utf8")).toBe(INLINE_CHAIN_NFT);
    });

    it("restores the previous sshd drop-ins when sshd -t fails", () => {
      const { sshdDir, apply } = setupApply();
      const legacy = path.join(sshdDir, "99-hermes-hardening.conf");
      writeFileSync(legacy, "ClientAliveInterval 60\n");
      expect(() => apply([], { SSHD_T_EXIT: "1" })).toThrow();
      expect(readFileSync(legacy, "utf8")).toBe("ClientAliveInterval 60\n");
      expect(() => statSync(path.join(sshdDir, "00-hermes-hardening.conf"))).toThrow();
    });

    it("refuses --cloudflare-origin-only when a Caddy site is an sslip.io or raw IP host", () => {
      for (const site of ["agent-1.198-51-100-7.sslip.io", "198.51.100.7"]) {
        const { nftConf, apply } = setupApply({
          caddyfile: `{\n\temail ops@example.com\n}\n${site} {\n\treverse_proxy 10.250.0.2:8080\n}\n`,
        });
        let stderr = "";
        try {
          apply(CF_ONLY);
        } catch (err) {
          stderr = String((err as { stderr?: string }).stderr);
        }
        expect(stderr).toContain("--cloudflare-origin-only refused");
        expect(stderr).toContain(site);
        expect(readFileSync(nftConf, "utf8")).toBe(INLINE_CHAIN_NFT);
      }
    });

    it("refuses --cloudflare-origin-only for comma-continued, catch-all and placeholder sites", () => {
      for (const [caddyfile, reported] of [
        ["agent-2.198-51-100-8.sslip.io,\nwww.example.com {\n\trespond ok\n}\n", "agent-2.198-51-100-8.sslip.io"],
        [":443 {\n\trespond ok\n}\n", ":443"],
        ["{$GATEWAY_HOST} {\n\trespond ok\n}\n", "{$GATEWAY_HOST}"],
        ["import /srv/other/sites/*\n", "/srv/other/sites/*"],
        ["agent-3.198-51-100-9.sslip.io\nreverse_proxy 10.250.0.3:8080\n", "agent-3.198-51-100-9.sslip.io"],
      ]) {
        const { nftConf, apply } = setupApply({ caddyfile });
        let stderr = "";
        try {
          apply(CF_ONLY);
        } catch (err) {
          stderr = String((err as { stderr?: string }).stderr);
        }
        expect(stderr).toContain("--cloudflare-origin-only refused");
        expect(stderr).toContain(reported);
        expect(readFileSync(nftConf, "utf8")).toBe(INLINE_CHAIN_NFT);
      }
    });

    it("follows imports into files without a .caddy suffix", () => {
      const { dir, nftConf, apply } = setupApply({ caddyfile: "import tenants/*\n" });
      mkdirSync(path.join(dir, "caddy", "tenants"));
      writeFileSync(
        path.join(dir, "caddy", "tenants", "agent-4"),
        "agent-4.198-51-100-10.sslip.io {\n\treverse_proxy 10.250.0.4:8080\n}\n",
      );
      let stderr = "";
      try {
        apply(CF_ONLY);
      } catch (err) {
        stderr = String((err as { stderr?: string }).stderr);
      }
      expect(stderr).toContain("agent-4.198-51-100-10.sslip.io");
      expect(readFileSync(nftConf, "utf8")).toBe(INLINE_CHAIN_NFT);
    });

    it("refuses --cloudflare-origin-only when there is no Caddy config to check", () => {
      const { nftConf, apply } = setupApply();
      expect(() => apply(CF_ONLY)).toThrow();
      expect(readFileSync(nftConf, "utf8")).toBe(INLINE_CHAIN_NFT);
    });
  });
});
