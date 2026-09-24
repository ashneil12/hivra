#!/usr/bin/python3 -IBS
"""The network of one attached agent (design 5.3, threats T5, T7, T24, T36, T37).

The agent runs in its own network namespace joined to the computer by a veth
pair. The computer accepts no connection from it and forwards its traffic only
to public destinations off the computer's own network. Two independent layers:

  1. nftables table inet hivra_attached_<short id>: input from the veth is
     dropped; forwarded traffic to private, local, link-local, multicast and
     reserved ranges, to every prefix the computer has a connected route to
     (set onlink), to every gateway in its routing table (set gateways) and to
     the Proxmox host's addresses is dropped; the rest is masqueraded out.
  2. systemd IP filtering on the agent unit: the same destinations plus every
     address the computer owns, applied with `systemctl set-property --runtime`.

    up <id>             root: create the namespace, veth, table and filters.
    down <id>           root: remove all of it.
    enforce <id>        root: run the enforcement probe inside the probe unit,
                        with canary listeners on 0.0.0.0 and ::; print the verdict.
    watchdog <id>       root, every minute: re-assert the view owner, and if the
                        namespace, table or computer network changed, stop the
                        agent, restore, probe again and only then start it.
    relay-guard <id>    root, before the DNS relay starts: pin its cgroup to
    relay-unguard <id>  127.0.0.53 port 53 only.
    state <id>          root: the observed network as JSON, for receipts.
    verify <id>         the agent, inside its unit: exactly lo and its veth, the
                        pinned resolver, and no route to the computer.
    probe <id>          the agent, inside the probe unit: nothing on the computer
                        answers; DNS resolves; public HTTPS works.
"""
import hashlib
import ipaddress
import json
import os
import re
import selectors
import socket
import ssl
import stat
import subprocess
import sys
import time

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
ATTACHMENTS = "/etc/hivra/attachments"
STATE_DIR = "/run/hivra-attached-state"
HELPERS = "/usr/local/lib/hivra"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "LANG": "C"}
HOST_LINK, AGENT_LINK, LINK_PREFIX = "198.18.0.1", "198.18.0.2", "198.18.0.0/30"
RESOLV = "nameserver 127.0.0.53\noptions edns0 trust-ad\n"
# Destinations always dropped, whatever the computer's own network looks like.
STATIC4 = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
           "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3")
STATIC6 = ("::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8")
# The systemd layer uses the same ranges; link-local and multicast by name.
SYSTEMD_STATIC = ("link-local", "multicast", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
                  "198.18.0.0/15", "fc00::/7")
PROBE_PORTS = (22, 53, 80, 443, 2019, 5555, 6080, 7681, 7682, 8006, 8080, 8088, 8090, 9222, 18789, 50080)
PROBE_HOST = "chatgpt.com"


def checked_id(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("invalid installation identity")
    return value


def names(installation):
    hexid = installation.replace("-", "")
    return {"netns": "hivra-" + hexid[:12], "host": "hvh" + hexid[:11], "agent": "hva" + hexid[:11],
            "table": "hivra_attached_" + hexid[:12], "unit": "hivra-attached-" + installation,
            "comment": "hivra-attached-" + hexid[:12]}


def run(args, timeout=20, check=True, stdin=None):
    result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout, env=ENV, check=False)
    if check and result.returncode != 0:
        raise ValueError("command failed: " + args[0] + " " + (args[1] if len(args) > 1 else ""))
    return result


def ip_json(*args):
    return json.loads(run(["ip", "-j", *args]).stdout or "[]")


def attachment_file(installation, name):
    path = ATTACHMENTS + "/" + installation + "/" + name
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 65536:
            raise ValueError("unsafe attachment file")
        return os.read(fd, 65537)
    finally:
        os.close(fd)


def recorded_network(installation):
    value = json.loads(attachment_file(installation, "network.json"))
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("installationId") != installation:
        raise ValueError("invalid recorded network")
    hosts = value.get("hostAddresses")
    if not isinstance(hosts, list) or len(hosts) > 32:
        raise ValueError("invalid recorded host addresses")
    return [str(ipaddress.ip_address(item)) for item in hosts]


def computer_facts(installation):
    """Addresses the computer owns, prefixes it is directly on, and its gateways, all tables, both families."""
    own = names(installation)
    addresses, onlink, gateways = set(), set(), set()
    for link in ip_json("addr", "show"):
        for entry in link.get("addr_info", []):
            if entry.get("family") in ("inet", "inet6") and entry.get("local"):
                addresses.add(str(ipaddress.ip_address(entry["local"].split("%")[0])))
    for family in ("-4", "-6"):
        for route in ip_json(family, "route", "show", "table", "all"):
            kind = route.get("type", "unicast")
            if route.get("dev") == own["host"]:
                continue
            hops = [route] + list(route.get("nexthops", []))
            for hop in hops:
                gateway = hop.get("gateway") or (hop.get("via") or {}).get("host")
                if gateway:
                    gateways.add(str(ipaddress.ip_address(gateway.split("%")[0])))
            destination = route.get("dst")
            if kind in ("unicast", "local", "broadcast") and destination not in (None, "default") and not route.get("gateway"):
                try:
                    network = ipaddress.ip_network(destination.split("%")[0], strict=False)
                except ValueError:
                    continue
                if kind == "unicast":
                    onlink.add(str(network))
    return {"addresses": sorted(addresses), "onlink": sorted(onlink), "gateways": sorted(gateways)}


def split_family(values):
    four, six = [], []
    for value in values:
        target = ipaddress.ip_network(value, strict=False)
        (four if target.version == 4 else six).append(str(target))
    return four, six


def nft_elements(values):
    return ("elements = { " + ", ".join(values) + " }; ") if values else ""


def render_table(installation, facts, hosts, include_relay):
    own = names(installation)
    onlink4, onlink6 = split_family(facts["onlink"])
    gateways4, gateways6 = split_family(facts["gateways"])
    hosts4, hosts6 = split_family(hosts)
    relay = ""
    if include_relay:
        path = '"system.slice/' + own["unit"] + '-dns.service"'
        relay = ("socket cgroupv2 level 2 " + path + " ip daddr != 127.0.0.53 drop; "
                 "socket cgroupv2 level 2 " + path + " meta l4proto { tcp, udp } th dport != 53 drop; "
                 "socket cgroupv2 level 2 " + path + " meta nfproto ipv6 drop; ")
    table = own["table"]
    host = '"' + own["host"] + '"'
    return ("add table inet " + table + "\n"
            "delete table inet " + table + "\n"
            "table inet " + table + " {\n"
            " set blocked4 { type ipv4_addr; flags interval; auto-merge; " + nft_elements(list(STATIC4) + hosts4) + "}\n"
            " set blocked6 { type ipv6_addr; flags interval; auto-merge; " + nft_elements(list(STATIC6) + hosts6) + "}\n"
            " set onlink4 { type ipv4_addr; flags interval; auto-merge; " + nft_elements(onlink4) + "}\n"
            " set onlink6 { type ipv6_addr; flags interval; auto-merge; " + nft_elements(onlink6) + "}\n"
            " set gateways4 { type ipv4_addr; flags interval; auto-merge; " + nft_elements(gateways4) + "}\n"
            " set gateways6 { type ipv6_addr; flags interval; auto-merge; " + nft_elements(gateways6) + "}\n"
            " chain input { type filter hook input priority -10; policy accept; iifname " + host + " drop; }\n"
            " chain forward { type filter hook forward priority -10; policy accept;"
            " iifname " + host + " meta nfproto ipv6 drop;"
            " iifname " + host + " ip daddr @blocked4 drop;"
            " iifname " + host + " ip daddr @onlink4 drop;"
            " iifname " + host + " ip daddr @gateways4 drop;"
            " iifname " + host + " ip saddr != " + AGENT_LINK + " drop;"
            " iifname " + host + " accept;"
            " oifname " + host + " ct state established,related accept;"
            " oifname " + host + " drop; }\n"
            " chain postrouting { type nat hook postrouting priority 100; policy accept;"
            " ip saddr " + AGENT_LINK + " oifname != " + host + " masquerade; }\n"
            " chain relayout { type filter hook output priority 0; policy accept; " + relay + "}\n"
            "}\n")


def systemd_deny(facts, hosts):
    values = list(SYSTEMD_STATIC)
    values += [value + ("/32" if ":" not in value else "/128") for value in facts["addresses"]]
    values += facts["onlink"] + facts["gateways"] + hosts
    unique = []
    for value in values:
        if value not in unique:
            unique.append(value)
    return unique


def covers(facts, hosts, table_text, deny):
    """Both layers name every connected prefix, every gateway and every host address, or nothing is applied."""
    for value in facts["onlink"] + facts["gateways"] + hosts:
        target = str(ipaddress.ip_network(value, strict=False))
        rendered = target if not target.endswith(("/32", "/128")) else target.rsplit("/", 1)[0]
        if rendered not in table_text and target not in table_text:
            return False
        if value not in deny and target not in deny:
            return False
    for value in facts["addresses"]:
        if value + ("/32" if ":" not in value else "/128") not in deny:
            return False
    return True


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def relay_cgroup_exists(installation):
    return os.path.isdir("/sys/fs/cgroup/system.slice/" + names(installation)["unit"] + "-dns.service")


def iptables_rules(own):
    comment = ["-m", "comment", "--comment", own["comment"]]
    return [["FORWARD", "-i", own["host"], *comment, "-j", "ACCEPT"],
            ["FORWARD", "-o", own["host"], "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", *comment, "-j", "ACCEPT"]]


def apply_iptables(own, present):
    """Docker and ufw default the iptables FORWARD policy to DROP. Accept only this veth there;
    the nftables table above still drops every private destination (a drop in any base chain wins)."""
    if run(["sh", "-c", "command -v iptables"], check=False).returncode != 0:
        return False
    for rule in iptables_rules(own):
        exists = run(["iptables", "-w", "5", "-C", *rule], check=False).returncode == 0
        if present and not exists:
            run(["iptables", "-w", "5", "-I", rule[0], "1", *rule[1:]])
        elif not present:
            while run(["iptables", "-w", "5", "-C", *rule], check=False).returncode == 0:
                run(["iptables", "-w", "5", "-D", *rule])
    return True


def write_state(installation, value):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    info = os.lstat(STATE_DIR)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("unsafe network state directory")
    path = STATE_DIR + "/" + installation + ".json"
    temporary = path + ".next"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def read_state(installation):
    try:
        with open(STATE_DIR + "/" + installation + ".json", "rb") as source:
            return json.loads(source.read(65536))
    except FileNotFoundError:
        return None


def netns_present(own):
    return any(item.get("name") == own["netns"] for item in (ip_json("netns", "list") or []))


def link_present(name):
    return run(["ip", "link", "show", "dev", name], check=False).returncode == 0


def table_present(own):
    return run(["nft", "list", "table", "inet", own["table"]], check=False).returncode == 0


def apply_filters(installation, facts, hosts):
    own = names(installation)
    deny = systemd_deny(facts, hosts)
    for unit in (own["unit"] + ".service", own["unit"] + "-probe.service"):
        run(["systemctl", "set-property", "--runtime", unit, "IPAddressDeny=", "IPAddressDeny=" + " ".join(deny)])
    return deny


def do_up(installation):
    own = names(installation)
    hosts = recorded_network(installation)
    if not netns_present(own):
        run(["ip", "netns", "add", own["netns"]])
    if not link_present(own["host"]):
        run(["ip", "link", "add", own["host"], "type", "veth", "peer", "name", own["agent"]])
        run(["ip", "link", "set", own["agent"], "netns", own["netns"]])
    run(["sysctl", "-q", "-w", "net.ipv6.conf." + own["host"] + ".disable_ipv6=1"])
    if HOST_LINK + "/30" not in run(["ip", "-4", "addr", "show", "dev", own["host"]]).stdout:
        run(["ip", "addr", "add", HOST_LINK + "/30", "dev", own["host"]])
    run(["ip", "link", "set", own["host"], "up"])
    # The namespace keeps ::1 on its loopback but gets no IPv6 on its veth, so no IPv6 route out.
    run(["ip", "netns", "exec", own["netns"], "sysctl", "-q", "-w", "net.ipv6.conf." + own["agent"] + ".disable_ipv6=1"])
    run(["ip", "-n", own["netns"], "link", "set", "lo", "up"])
    if AGENT_LINK + "/30" not in run(["ip", "-n", own["netns"], "-4", "addr", "show", "dev", own["agent"]]).stdout:
        run(["ip", "-n", own["netns"], "addr", "add", AGENT_LINK + "/30", "dev", own["agent"]])
    run(["ip", "-n", own["netns"], "link", "set", own["agent"], "up"])
    run(["ip", "-n", own["netns"], "route", "replace", "default", "via", HOST_LINK, "dev", own["agent"]])
    forwarding = run(["sysctl", "-n", "net.ipv4.ip_forward"]).stdout.strip()
    if forwarding != "1":
        run(["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"])
    facts = computer_facts(installation)
    table_text = render_table(installation, facts, hosts, relay_cgroup_exists(installation))
    if not covers(facts, hosts, table_text, systemd_deny(facts, hosts)):
        raise ValueError("a connected prefix or gateway is missing from the rendered filters")
    run(["nft", "-f", "-"], stdin=table_text)
    iptables = apply_iptables(own, True)
    deny = apply_filters(installation, facts, hosts)
    applied = {"version": 1, "installationId": installation, "factsSha256": digest({"facts": facts, "hosts": hosts}),
               "denySha256": digest(deny), "iptables": iptables, "forwardingWasOn": forwarding == "1"}
    write_state(installation, applied)
    return do_state(installation)


def do_down(installation):
    own = names(installation)
    apply_iptables(own, False)
    if table_present(own):
        run(["nft", "delete", "table", "inet", own["table"]])
    if link_present(own["host"]):
        run(["ip", "link", "delete", own["host"]])
    if netns_present(own):
        run(["ip", "netns", "delete", own["netns"]])
    try:
        os.unlink(STATE_DIR + "/" + installation + ".json")
    except FileNotFoundError:
        pass
    return do_state(installation)


def do_state(installation):
    own = names(installation)
    result = {"version": 1, "installationId": installation, "netns": netns_present(own),
              "veth": link_present(own["host"]), "table": table_present(own), "relayGuard": False,
              "factsCurrent": False}
    if result["table"]:
        listed = run(["nft", "list", "chain", "inet", own["table"], "relayout"], check=False).stdout
        result["relayGuard"] = "cgroupv2" in listed
    applied = read_state(installation)
    if applied is not None:
        try:
            facts = computer_facts(installation)
            result["factsCurrent"] = applied.get("factsSha256") == digest({"facts": facts, "hosts": recorded_network(installation)})
        except (ValueError, OSError):
            result["factsCurrent"] = False
    return result


def do_relay_guard(installation, on=True):
    own = names(installation)
    if not table_present(own):
        raise ValueError("network table missing")
    facts = computer_facts(installation)
    hosts = recorded_network(installation)
    run(["nft", "-f", "-"], stdin=render_table(installation, facts, hosts, on))
    return do_state(installation)


def probe_targets(facts, hosts):
    targets = set(facts["addresses"]) | set(facts["gateways"]) | set(hosts) | {"127.0.0.1", "127.0.0.53", HOST_LINK}
    for prefix in facts["onlink"]:
        network = ipaddress.ip_network(prefix, strict=False)
        if network.num_addresses > 2:
            targets.add(str(network.network_address + 1))
            targets.add(str(network.broadcast_address - 1))
    for value in list(targets):
        address = ipaddress.ip_address(value)
        if address.version == 4:
            targets.add("::ffff:" + value)
    return sorted(targets)


def do_enforce(installation):
    """Canary listeners on every address the computer owns, then the probe from inside the probe unit."""
    own = names(installation)
    facts = computer_facts(installation)
    hosts = recorded_network(installation)
    listeners = []
    try:
        four = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        four.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        four.bind(("0.0.0.0", 0))
        four.listen(16)
        listeners.append(four)
        port = four.getsockname()[1]
        six = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        six.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        six.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        six.bind(("::", port))
        six.listen(16)
        listeners.append(six)
        probe = {"version": 1, "installationId": installation, "ports": sorted(set(PROBE_PORTS) | {port}),
                 "targets": probe_targets(facts, hosts), "resolveHost": PROBE_HOST}
        path = ATTACHMENTS + "/" + installation + "/probe.json"
        temporary = path + ".next"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
        with os.fdopen(fd, "w") as output:
            json.dump(probe, output, sort_keys=True, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        unit = own["unit"] + "-probe.service"
        run(["systemctl", "reset-failed", unit], check=False)
        started = run(["systemctl", "start", unit], timeout=120, check=False)
        shown = run(["systemctl", "show", unit, "--property=Result,ExecMainStatus"]).stdout
        properties = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)
        accepted = 0
        for item in listeners:
            while _accept(item):
                accepted += 1
    finally:
        for item in listeners:
            item.close()
    passed = started.returncode == 0 and properties.get("Result") == "success" and properties.get("ExecMainStatus") == "0" and accepted == 0
    return {"version": 1, "installationId": installation, "state": "enforced" if passed else "refused",
            "targets": len(probe["targets"]), "ports": len(probe["ports"]), "canaryConnections": accepted}


def _accept(listener):
    listener.setblocking(False)
    try:
        connection, _ = listener.accept()
    except (BlockingIOError, InterruptedError):
        return None
    connection.close()
    return True


def agent_active(own):
    return run(["systemctl", "is-active", own["unit"] + ".service"], check=False).stdout.strip() == "active"


def do_watchdog(installation):
    own = names(installation)
    actions = []
    record = json.loads(attachment_file(installation, "binding.json"))
    if record.get("workspace") is True:
        result = run([HELPERS + "/attached-workspace", "reassert", installation], check=False)
        if result.returncode == 0 and '"reasserted":true' in result.stdout:
            actions.append("workspace_owner_restored")
    observed = do_state(installation)
    intact = observed["netns"] and observed["veth"] and observed["table"] and observed["factsCurrent"]
    if relay_cgroup_exists(installation) and not observed["relayGuard"]:
        intact = False
    if not intact:
        was_active = agent_active(own)
        run(["systemctl", "stop", own["unit"] + ".service"], timeout=60)
        actions.append("agent_stopped")
        do_up(installation)
        actions.append("network_restored")
        verdict = do_enforce(installation)
        actions.append("probe_" + verdict["state"])
        if verdict["state"] == "enforced" and was_active:
            run(["systemctl", "start", own["unit"] + ".service"], timeout=60)
            actions.append("agent_started")
    result = {"version": 1, "installationId": installation, "actions": actions}
    if actions:
        print("Hivra watchdog: " + ", ".join(actions), file=sys.stderr)
    return result


# ---- inside the agent's own units (runs as the agent) ----

def do_verify(installation):
    if os.geteuid() == 0:
        raise ValueError("verify runs as the agent, not as root")
    own = names(installation)
    interfaces = sorted(name for _, name in socket.if_nameindex())
    if interfaces != sorted(["lo", own["agent"]]):
        raise ValueError("the agent is not in its own network namespace")
    with open("/etc/resolv.conf", "r") as source:
        if source.read(4096) != RESOLV:
            raise ValueError("the resolver is not the pinned relay")
    default = False
    with open("/proc/self/net/route", "r") as source:
        for line in source.read(65536).splitlines()[1:]:
            fields = line.split()
            if len(fields) > 2 and fields[1] == "00000000":
                gateway = socket.inet_ntoa(bytes.fromhex(fields[2])[::-1])
                default = fields[0] == own["agent"] and gateway == HOST_LINK
    if not default:
        raise ValueError("unexpected default route")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        if probe.connect_ex((HOST_LINK, 8080)) == 0:
            raise ValueError("the computer answered on its veth address")
    return {"version": 1, "installationId": installation, "verified": True}


def reach(targets, ports, timeout):
    """Non-blocking connects to every target and port at once; list the ones that answered."""
    selector = selectors.DefaultSelector()
    reached, pending = [], {}
    for target in targets:
        family = socket.AF_INET6 if ":" in target else socket.AF_INET
        for port in ports:
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.setblocking(False)
            code = sock.connect_ex((target, port))
            if code == 0:
                reached.append(target + ":" + str(port))
                sock.close()
            elif code in (115, 11):  # EINPROGRESS, EAGAIN
                selector.register(sock, selectors.EVENT_WRITE, target + ":" + str(port))
                pending[sock] = True
            else:
                sock.close()
    deadline = time.monotonic() + timeout
    while pending and time.monotonic() < deadline:
        for key, _ in selector.select(timeout=max(0.0, deadline - time.monotonic())):
            sock = key.fileobj
            if sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0:
                reached.append(key.data)
            selector.unregister(sock)
            sock.close()
            pending.pop(sock, None)
    for sock in list(pending):
        selector.unregister(sock)
        sock.close()
    return sorted(reached)


def do_probe(installation):
    if os.geteuid() == 0:
        raise ValueError("the probe runs as the agent, not as root")
    probe = json.loads(attachment_file(installation, "probe.json"))
    if probe.get("installationId") != installation:
        raise ValueError("probe input belongs to another installation")
    targets = [str(ipaddress.ip_address(item)) for item in probe["targets"]][:256]
    ports = [int(item) for item in probe["ports"]][:64]
    reached = reach(targets, ports, 3.0)
    resolved = False
    try:
        resolved = bool(socket.getaddrinfo(probe["resolveHost"], 443, type=socket.SOCK_STREAM))
    except OSError:
        resolved = False
    https = False
    if resolved:
        try:
            context = ssl.create_default_context()
            with socket.create_connection((probe["resolveHost"], 443), timeout=10) as raw:
                with context.wrap_socket(raw, server_hostname=probe["resolveHost"]) as tls:
                    tls.sendall(b"HEAD / HTTP/1.1\r\nHost: " + probe["resolveHost"].encode() + b"\r\nConnection: close\r\n\r\n")
                    https = tls.recv(16).startswith(b"HTTP/")
        except OSError:
            https = False
    result = {"version": 1, "installationId": installation, "reached": reached, "dns": resolved, "https": https}
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    if reached or not resolved or not https:
        raise SystemExit(1)
    return None


COMMANDS = {"up": do_up, "down": do_down, "enforce": do_enforce, "watchdog": do_watchdog, "state": do_state,
            "relay-guard": lambda i: do_relay_guard(i, True), "relay-unguard": lambda i: do_relay_guard(i, False),
            "verify": do_verify, "probe": do_probe}
AGENT_COMMANDS = ("verify", "probe")


def main(argv):
    if len(argv) != 3 or argv[1] not in COMMANDS:
        raise SystemExit("usage: attached-network {" + "|".join(sorted(COMMANDS)) + "} <installation-id>")
    installation = checked_id(argv[2])
    if argv[1] not in AGENT_COMMANDS and os.geteuid() != 0:
        raise SystemExit("attached-network " + argv[1] + " requires root")
    result = COMMANDS[argv[1]](installation)
    if result is not None:
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    try:
        main(sys.argv)
    except SystemExit:
        raise
    except Exception as error:
        raise SystemExit("attached-network refused (" + type(error).__name__ + ")")
