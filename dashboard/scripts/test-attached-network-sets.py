#!/usr/bin/env python3
"""attached-network.py filter rendering from real `ip -j` shapes (T5, T36, T37). Pure: no root, no network.

Run: python3 dashboard/scripts/test-attached-network-sets.py
"""
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("attached_network", ROOT / "provisioner" / "attached-network.py")
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)

INSTALLATION = "33333333-3333-4333-8333-333333333333"
OWN = network.names(INSTALLATION)

# A My server guest on a public /24, with a global IPv6 prefix, Docker, Tailscale's
# policy table 52, a gateway outside the prefix (onlink) and a multipath route.
ADDRESSES = [
    {"ifname": "lo", "addr_info": [{"family": "inet", "local": "127.0.0.1", "prefixlen": 8}, {"family": "inet6", "local": "::1"}]},
    {"ifname": "eth0", "addr_info": [{"family": "inet", "local": "203.0.113.45", "prefixlen": 24},
                                     {"family": "inet6", "local": "2001:db8:45::10", "prefixlen": 64},
                                     {"family": "inet6", "local": "fe80::1%eth0", "prefixlen": 64}]},
    {"ifname": "docker0", "addr_info": [{"family": "inet", "local": "172.17.0.1", "prefixlen": 16}]},
    {"ifname": "tailscale0", "addr_info": [{"family": "inet", "local": "100.101.102.103", "prefixlen": 32}]},
    {"ifname": OWN["host"], "addr_info": [{"family": "inet", "local": "198.18.0.1", "prefixlen": 30}]},
]
ROUTES4 = [
    {"type": "unicast", "dst": "default", "gateway": "198.51.100.1", "dev": "eth0", "flags": ["onlink"]},
    {"type": "unicast", "dst": "203.0.113.0/24", "dev": "eth0", "protocol": "kernel", "scope": "link"},
    {"type": "unicast", "dst": "172.17.0.0/16", "dev": "docker0", "scope": "link"},
    {"type": "unicast", "dst": "198.18.0.0/30", "dev": OWN["host"], "scope": "link"},
    {"type": "unicast", "dst": "100.64.0.0/10", "dev": "tailscale0", "table": "52"},
    {"type": "unicast", "dst": "192.0.2.0/24", "table": "52", "nexthops": [{"gateway": "100.101.102.1"}, {"gateway": "100.101.102.2"}]},
    {"type": "local", "dst": "203.0.113.45", "table": "local", "dev": "eth0"},
    {"type": "broadcast", "dst": "203.0.113.255", "table": "local", "dev": "eth0"},
]
ROUTES6 = [
    {"type": "unicast", "dst": "2001:db8:45::/64", "dev": "eth0"},
    {"type": "unicast", "dst": "default", "gateway": "fe80::1", "dev": "eth0"},
    {"type": "unicast", "dst": "fe80::/64", "dev": "eth0"},
    {"type": "unicast", "dst": "2001:db8:99::/48", "via": {"family": "inet6", "host": "2001:db8:45::1"}, "dev": "eth0"},
]
HOSTS = ["198.51.100.20", "2001:db8:77::5"]


def fake_ip_json(*args):
    if args[:2] == ("addr", "show"):
        return ADDRESSES
    if args[:2] == ("-4", "route"):
        return ROUTES4
    if args[:2] == ("-6", "route"):
        return ROUTES6
    raise AssertionError(args)


class NetworkSets(unittest.TestCase):
    def setUp(self):
        self.original = network.ip_json
        network.ip_json = fake_ip_json
        self.facts = network.computer_facts(INSTALLATION)

    def tearDown(self):
        network.ip_json = self.original

    def test_facts_cover_every_connected_prefix_gateway_and_address(self):
        for prefix in ("203.0.113.0/24", "172.17.0.0/16", "100.64.0.0/10", "2001:db8:45::/64", "fe80::/64"):
            self.assertIn(prefix, self.facts["onlink"])
        self.assertNotIn("198.18.0.0/30", self.facts["onlink"], "the veth link is Hivra's own, in the static ranges")
        for gateway in ("198.51.100.1", "100.101.102.1", "100.101.102.2", "fe80::1", "2001:db8:45::1"):
            self.assertIn(gateway, self.facts["gateways"])
        for address in ("203.0.113.45", "2001:db8:45::10", "fe80::1", "127.0.0.1", "::1", "172.17.0.1", "100.101.102.103"):
            self.assertIn(address, self.facts["addresses"])

    def test_both_layers_name_every_prefix_gateway_and_host_address(self):
        table = network.render_table(INSTALLATION, self.facts, HOSTS, False)
        deny = network.systemd_deny(self.facts, HOSTS)
        self.assertTrue(network.covers(self.facts, HOSTS, table, deny))
        for value in ("203.0.113.0/24", "198.51.100.1/32", "100.101.102.1/32", "198.51.100.20/32", "2001:db8:45::/64",
                      "2001:db8:77::5/128", "10.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "198.18.0.0/15"):
            self.assertIn(value, table)
        for value in ("203.0.113.45/32", "2001:db8:45::10/128", "203.0.113.0/24", "198.51.100.1", "198.51.100.20",
                      "link-local", "multicast", "fc00::/7", "198.18.0.0/15"):
            self.assertIn(value, deny)
        # Input from the veth is dropped on every address the computer owns, whatever it is bound to.
        self.assertIn('chain input { type filter hook input priority -10; policy accept; iifname "' + OWN["host"] + '" drop; }', table)
        self.assertIn('iifname "' + OWN["host"] + '" meta nfproto ipv6 drop;', table)
        self.assertIn("ip saddr 198.18.0.2 oifname != \"" + OWN["host"] + "\" masquerade;", table)
        # Drops come before the accept inside the same base chain.
        self.assertLess(table.index("ip daddr @onlink4 drop"), table.index('iifname "' + OWN["host"] + '" accept'))
        self.assertLess(table.index("ip daddr @gateways4 drop"), table.index('iifname "' + OWN["host"] + '" accept'))
        # Atomic replacement: one transaction deletes the old table and adds the new one.
        self.assertTrue(table.startswith("add table inet " + OWN["table"] + "\ndelete table inet " + OWN["table"] + "\n"))

    def test_a_rendering_that_misses_a_prefix_or_gateway_is_refused(self):
        table = network.render_table(INSTALLATION, self.facts, HOSTS, False)
        deny = network.systemd_deny(self.facts, HOSTS)
        self.assertFalse(network.covers(self.facts, HOSTS, table.replace("203.0.113.0/24", "203.0.113.0/25"), deny))
        self.assertFalse(network.covers(self.facts, HOSTS, table, [item for item in deny if item != "198.51.100.1"]))
        self.assertFalse(network.covers(self.facts, HOSTS, table, [item for item in deny if item != "203.0.113.45/32"]))
        missing_gateway = dict(self.facts, gateways=[g for g in self.facts["gateways"] if g != "100.101.102.1"])
        self.assertFalse(network.covers(self.facts, HOSTS, network.render_table(INSTALLATION, missing_gateway, HOSTS, False), deny))

    def test_the_dns_relay_cgroup_is_pinned_to_the_resolver_port(self):
        guarded = network.render_table(INSTALLATION, self.facts, HOSTS, True)
        path = '"system.slice/' + OWN["unit"] + '-dns.service"'
        self.assertIn("socket cgroupv2 level 2 " + path + " ip daddr != 127.0.0.53 drop;", guarded)
        self.assertIn("socket cgroupv2 level 2 " + path + " meta l4proto { tcp, udp } th dport != 53 drop;", guarded)
        self.assertIn("socket cgroupv2 level 2 " + path + " meta nfproto ipv6 drop;", guarded)
        self.assertNotIn("cgroupv2", network.render_table(INSTALLATION, self.facts, HOSTS, False))

    def test_probe_targets_include_every_owned_address_mapped_forms_neighbours_and_gateways(self):
        targets = network.probe_targets(self.facts, HOSTS)
        for value in ("203.0.113.45", "::ffff:203.0.113.45", "203.0.113.1", "203.0.113.254", "198.51.100.1",
                      "2001:db8:45::10", "127.0.0.53", "198.18.0.1", "198.51.100.20"):
            self.assertIn(value, targets)
        for value in targets:
            ipaddress.ip_address(value)

    def test_names_fit_kernel_interface_limits(self):
        self.assertLessEqual(len(OWN["host"]), 15)
        self.assertLessEqual(len(OWN["agent"]), 15)
        self.assertNotEqual(OWN["host"], OWN["agent"])

    def test_source_never_runs_a_shell_or_a_path_based_privileged_file_call(self):
        source = (ROOT / "provisioner" / "attached-network.py").read_text()
        for forbidden in ("shell=True", "os.system(", "os.chown(", "os.chmod(", "shutil.", "rmtree", "--bind", "mountpoint"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main(verbosity=1)
