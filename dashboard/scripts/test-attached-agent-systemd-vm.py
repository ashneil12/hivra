#!/usr/bin/python3 -IB
"""Guest isolation matrix for one attached agent (design 8.2), run as root on a
real, disposable Ubuntu VM with real systemd.

Every probe of the agent runs INSIDE the running unit: the probe process joins
the unit's cgroup (so its IP filter and resource limits apply), enters its
namespaces with nsenter, and drops to the unit's UID and group with no
capabilities and no_new_privs. It never uses a lookalike systemd-run. The DNS
relay's probes join the relay's cgroup and namespaces the same way.

    neighbours            root: a neighbour namespace on a bridge with a
                          public-range on-link prefix (203.0.113.0/24, TEST-NET-3,
                          outside every static deny range), a global-range IPv6
                          prefix, a listener on an address that a policy table
                          uses as its gateway, an emulated Proxmox host
                          (203.0.113.9 on 8006 and 22), and a container on the
                          Docker bridge.
    matrix <id>           the checks against a running attachment; prints the
                          verdict JSON and exits 1 if any check failed.
    tree-hash             sha256 over ~/Hivra (names, modes, bytes), for Remove.
    removed <id> <hash>   after Remove: nothing of the attachment remains and
                          ~/Hivra is unchanged.

The verdict is kept even on failure. Evidence, not a product path.
"""
import grp
import hashlib
import ipaddress
import json
import os
import pwd
import re
import socket
import stat
import subprocess
import sys
import time

ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "LANG": "C"}
NEIGHBOUR_NS = "hvnb"
NEIGHBOUR = "203.0.113.2"
PROXMOX_HOST = "203.0.113.9"
OWN_BRIDGE = "203.0.113.1"
NEIGHBOUR6 = "2001:db8:77::2"
POLICY_ROUTE = "198.51.100.0/24"
NEIGHBOUR_PORTS = (22, 80, 443, 8006)
MARKER_PREFIX = "HIVRA_MARKER_"
# The computer secret inventory (design 5.3, "Filesystem hiding"): exact files
# and folders whose contents the agent must never read. Public host keys and
# program sources are not secrets.
SECRET_PATHS = ("/home/bux/.hivra/api-token", "/home/bux/.hivra/llm-provider.json", "/home/bux/.hivra/",
                "/root/", "/etc/cloudflared/", "/etc/hivra/keys/", "/etc/hivra/tunnel", "/var/lib/hivra/remote-desktop/",
                "/opt/hivra/remote-desktop/", "/var/lib/hivra/runtime-receipt", "/var/lib/hivra/runtime-sbom",
                "/var/lib/hivra/attachment-activation", "/var/lib/hivra/runtime-backups/", "/etc/shadow", "/etc/gshadow",
                "/etc/sudoers", "/var/lib/docker/", "/run/hivra-attached-state/")
SECRET_SUFFIXES = ("gateway-token", "_key", ".pem")


def run(args, timeout=120, check=True, stdin=None, env=None):
    result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout,
                            env=env or ENV, check=False)
    if check and result.returncode != 0:
        raise RuntimeError("%s failed (%d): %s" % (" ".join(args[:3]), result.returncode, result.stderr[-400:]))
    return result


def show(unit, prop):
    return run(["systemctl", "show", unit, "-p", prop, "--value"], check=False).stdout.strip()


def unit_names(installation):
    base = "hivra-attached-" + installation
    return {"agent": base + ".service", "socket": base + ".socket", "workspace": base + "-workspace.service",
            "network": base + "-network.service", "dns": base + "-dns.service", "dnssocket": base + "-dns.socket",
            "watchdog": base + "-watchdog.timer", "probe": base + "-probe.service"}


# ---- running a probe inside a unit ------------------------------------------------

def in_unit(unit, code, args=(), timeout=120, want_json=True):
    """Join the unit's cgroup and namespaces, drop to its uid, gid and groups, no caps, no_new_privs."""
    pid = int(show(unit, "MainPID") or 0)
    group = show(unit, "ControlGroup")
    if pid <= 1 or not group:
        raise RuntimeError(unit + " is not running")
    with open("/proc/%d/status" % pid) as source:
        status = source.read()
    uid = int(re.search(r"^Uid:\s+(\d+)", status, re.M).group(1))
    gid = int(re.search(r"^Gid:\s+(\d+)", status, re.M).group(1))
    # The unit's own supplementary groups, exactly as the kernel holds them.
    groups = re.search(r"^Groups:[ \t]*([0-9 \t]*)$", status, re.M).group(1).split()
    procs = "/sys/fs/cgroup" + group + "/cgroup.procs"

    def join():
        with open(procs, "w") as target:
            target.write(str(os.getpid()))

    command = ["nsenter", "-t", str(pid), "-a", "setpriv", "--reuid", str(uid), "--regid", str(gid),
               *(["--groups", ",".join(groups)] if groups else ["--clear-groups"]),
               "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--",
               "/usr/bin/python3", "-I", "-c", code, *[str(a) for a in args]]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=ENV, preexec_fn=join)
    if not want_json:
        return result
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "no result", "rc": result.returncode, "stderr": result.stderr[-600:]}


PROBE_CONNECT = r"""
import json, socket, selectors, sys, time
targets, ports = json.loads(sys.argv[1]), json.loads(sys.argv[2])
sel = selectors.DefaultSelector(); reached = []; pending = {}; errors = {}
for t in targets:
    fam = socket.AF_INET6 if ":" in t else socket.AF_INET
    for p in ports:
        if p == 53 and t in ("127.0.0.53", "::ffff:127.0.0.53"):
            continue  # the agent's own DNS relay socket, in its own namespace
        s = socket.socket(fam, socket.SOCK_STREAM); s.setblocking(False)
        try:
            code = s.connect_ex((t, p))
        except OSError as e:
            code = e.errno
        if code == 0:
            reached.append("%s:%d" % (t, p)); s.close()
        elif code in (115, 11):
            sel.register(s, selectors.EVENT_WRITE, "%s:%d" % (t, p)); pending[s] = True
        else:
            errors[str(code)] = errors.get(str(code), 0) + 1; s.close()
deadline = time.monotonic() + 4
while pending and time.monotonic() < deadline:
    for key, _ in sel.select(timeout=max(0, deadline - time.monotonic())):
        s = key.fileobj; e = s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
        if e == 0: reached.append(key.data)
        else: errors[str(e)] = errors.get(str(e), 0) + 1
        sel.unregister(s); s.close(); pending.pop(s, None)
timeouts = len(pending)
for s in list(pending): sel.unregister(s); s.close()
print(json.dumps({"reached": sorted(reached), "tried": len(targets) * len(ports), "errors": errors, "timeouts": timeouts}))
"""

PROBE_PUBLIC = r"""
import json, socket, ssl, struct, os
out = {}
try:
    q = struct.pack(">HHHHHH", 0x4242, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(x)]) + x.encode() for x in "chatgpt.com".split(".")) + b"\x00\x00\x01\x00\x01"
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.bind(("127.0.0.1", 0)); u.settimeout(5)
    u.sendto(q, ("127.0.0.53", 53)); answer = u.recv(4096); u.close()
    out["dnsFrom127_0_0_1"] = answer[:2] == b"\x42\x42" and struct.unpack(">H", answer[6:8])[0] > 0
except OSError as e:
    out["dnsFrom127_0_0_1"] = False; out["dnsError"] = str(e)
try:
    ctx = ssl.create_default_context()
    with socket.create_connection(("chatgpt.com", 443), timeout=10) as raw:
        with ctx.wrap_socket(raw, server_hostname="chatgpt.com") as tls:
            tls.sendall(b"HEAD / HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n")
            out["publicHttps"] = tls.recv(16).startswith(b"HTTP/")
except OSError as e:
    out["publicHttps"] = False; out["httpsError"] = str(e)
# The agent's own localhost server: only it can reach it.
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1); port = srv.getsockname()[1]
c = socket.create_connection(("127.0.0.1", port), timeout=3); a, _ = srv.accept(); a.close(); c.close(); srv.close()
out["ownLocalhostServer"] = True
out["ownLocalhostPort"] = port
print(json.dumps(out))
"""

PROBE_FILES = r"""
import json, os, sys, errno, stat, grp, subprocess
installation, owner_pid, home = sys.argv[1], int(sys.argv[2]), sys.argv[3]
view = "/var/lib/hivra/agent-views/" + installation
out = {}
def attempt(name, fn):
    try:
        fn(); out[name] = "allowed"
    except OSError as e:
        out[name] = errno.errorcode.get(e.errno, str(e.errno))
attempt("ls_home_bux", lambda: os.listdir("/home/bux"))
attempt("read_computer_token", lambda: open("/home/bux/.hivra/api-token").read())
attempt("read_owner_environ", lambda: open("/proc/%d/environ" % owner_pid, "rb").read())
attempt("read_ttyd_socket_dir", lambda: os.listdir("/run/hivra-terminal"))
def connect_unix(path):
    import socket
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(2)
    try: s.connect(path)
    finally: s.close()
attempt("connect_box_terminal_socket", lambda: connect_unix("/run/hivra-box-terminal/ttyd.sock"))
attempt("connect_own_chat_socket", lambda: connect_unix("/run/hivra-attached/%s.sock" % installation))
attempt("replace_own_chat_socket", lambda: os.symlink("/run/hivra-box-terminal/ttyd.sock", "/run/hivra-attached/%s.sock.x" % installation))
attempt("connect_system_bus", lambda: connect_unix("/run/dbus/system_bus_socket"))
attempt("rm_agents_md", lambda: os.unlink(view + "/AGENTS.md"))
attempt("mv_agents_md", lambda: os.rename(view + "/AGENTS.md", view + "/AGENTS.old"))
attempt("ln_agents_md", lambda: os.symlink("/etc/hostname", view + "/AGENTS.override.md"))
attempt("create_in_starting_folder", lambda: open(view + "/new-file", "x").close())
attempt("chmod_setuid_in_home", lambda: (open(home + "/suid", "w").close(), os.chmod(home + "/suid", 0o4755)))
# The set of groups the process holds. systemd 249 lists the primary group
# again as a supplementary group and systemd 255 lists none, so compare sets.
out["groups"] = sorted(set(os.getgroups()) | {os.getgid()})
out["uid"] = os.getuid()
def run(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=20, input="")
        return r.returncode
    except FileNotFoundError:
        return "absent"
out["sudo_n_true"] = run(["sudo", "-n", "true"])
out["crontab"] = run(["crontab", "-"])
out["at_now"] = run(["at", "now"])
out["systemd_run_user"] = run(["systemd-run", "--user", "--unit", "hivra-escape", "sleep", "300"])
out["loginctl_linger"] = run(["loginctl", "enable-linger"])
# The mount the owner made inside ~/Hivra is not in the view (non-recursive clone).
try:
    out["owner_submount_visible"] = os.path.exists(view + "/Hivra/submount/" + "SUBMOUNT_MARKER")
except OSError:
    out["owner_submount_visible"] = False
out["view_listing_ok"] = os.path.isdir(view + "/Hivra")
print(json.dumps(out))
"""

PROBE_SECRETS = r"""
import json, os, sys
installation = sys.argv[1]; patterns = json.loads(sys.argv[2])
own = "/etc/hivra/attachments/" + installation + "/"
own_ok = {own + name for name in ("instance-token", "binding.json", "computer.json", "resolv.conf", "network.json", "probe.json")}
readable, flagged, sockets = 0, [], []
for root in ("/etc", "/var", "/opt", "/run", "/srv", "/root", "/home"):
    for base, dirs, files in os.walk(root, onerror=lambda e: None):
        if base.startswith(("/proc", "/sys")): continue
        for name in files:
            path = os.path.join(base, name)
            try:
                info = os.lstat(path)
            except OSError:
                continue
            if __import__("stat").S_ISSOCK(info.st_mode):
                if os.access(path, os.W_OK): sockets.append(path)
                continue
            if not __import__("stat").S_ISREG(info.st_mode) or not os.access(path, os.R_OK): continue
            try:
                with open(path, "rb") as f: f.read(1)
            except OSError:
                continue
            readable += 1
            if path in own_ok: continue
            if path.endswith(".pub"): continue
            if any(path.startswith(p) for p in patterns[0]) or any(path.endswith(p) for p in patterns[1]): flagged.append(path)
print(json.dumps({"readableFiles": readable, "flagged": sorted(flagged)[:50], "connectableSockets": sorted(sockets)}))
"""

PROBE_MEMORY = r"""
import json
chunks = []
try:
    for _ in range(4096):
        chunks.append(bytearray(1024 * 1024))
except MemoryError:
    pass
print(json.dumps({"allocatedMb": len(chunks)}))
"""

PROBE_RELAY = r"""
import json, socket, sys
targets = json.loads(sys.argv[1])
reached = []
for host, port in targets:
    s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM); s.settimeout(2)
    try:
        s.connect((host, port)); reached.append("%s:%d" % (host, port))
    except OSError:
        pass
    finally:
        s.close()
import struct
q = struct.pack(">HHHHHH", 0x4343, 0x0100, 1, 0, 0, 0) + b"\x07chatgpt\x03com\x00\x00\x01\x00\x01"
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.settimeout(5)
try:
    u.sendto(q, ("127.0.0.53", 53)); upstream = u.recv(4096)[:2] == b"\x43\x43"
except OSError:
    upstream = False
print(json.dumps({"reached": reached, "upstreamDnsWorks": upstream}))
"""


# ---- the computer's own facts --------------------------------------------------

def own_addresses():
    out = set()
    for link in json.loads(run(["ip", "-j", "addr", "show"]).stdout):
        for entry in link.get("addr_info", []):
            if entry.get("local"):
                out.add(entry["local"].split("%")[0])
    return sorted(out)


def listening_ports():
    ports = set()
    for line in run(["ss", "-Hltnu"]).stdout.splitlines():
        fields = line.split()
        if len(fields) >= 5:
            port = fields[4].rsplit(":", 1)[-1]
            if port.isdigit():
                ports.add(int(port))
    return sorted(ports)


def mapped(addresses):
    out = list(addresses)
    for value in addresses:
        if ipaddress.ip_address(value).version == 4:
            out.append("::ffff:" + value)
    return out


def default_gateway():
    for route in json.loads(run(["ip", "-j", "-4", "route", "show", "default"]).stdout):
        if route.get("gateway"):
            return route["gateway"]
    return None


def canary_listeners():
    four = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    four.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    four.bind(("0.0.0.0", 0))
    four.listen(64)
    port = four.getsockname()[1]
    six = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    six.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    six.bind(("::", port))
    six.listen(64)
    return [four, six], port


def drain(listeners):
    count = 0
    for item in listeners:
        item.setblocking(False)
        while True:
            try:
                connection, _ = item.accept()
            except (BlockingIOError, InterruptedError):
                break
            connection.close()
            count += 1
    return count


# ---- neighbours ------------------------------------------------------------------

LISTENER = r"""
import socket, sys, threading
def serve(family, host, port):
    s = socket.socket(family, socket.SOCK_STREAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if family == socket.AF_INET6: s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind((host, port)); s.listen(64)
    while True:
        c, _ = s.accept(); c.sendall(b"HIVRA-NEIGHBOUR\n"); c.close()
for port in (22, 80, 443, 8006):
    threading.Thread(target=serve, args=(socket.AF_INET, "0.0.0.0", port), daemon=True).start()
    threading.Thread(target=serve, args=(socket.AF_INET6, "::", port), daemon=True).start()
threading.Event().wait()
"""


def do_neighbours():
    names = [item.get("name") for item in json.loads(run(["ip", "-j", "netns", "list"]).stdout or "[]")]
    if NEIGHBOUR_NS not in names:
        run(["ip", "netns", "add", NEIGHBOUR_NS])
        run(["ip", "link", "add", "hvnbh", "type", "veth", "peer", "name", "hvnbn"])
        run(["ip", "link", "set", "hvnbn", "netns", NEIGHBOUR_NS])
        run(["ip", "addr", "add", OWN_BRIDGE + "/24", "dev", "hvnbh"])
        run(["ip", "-6", "addr", "add", "2001:db8:77::1/64", "dev", "hvnbh", "nodad"])
        run(["ip", "link", "set", "hvnbh", "up"])
        run(["ip", "-n", NEIGHBOUR_NS, "link", "set", "lo", "up"])
        for address in (NEIGHBOUR + "/24", PROXMOX_HOST + "/24"):
            run(["ip", "-n", NEIGHBOUR_NS, "addr", "add", address, "dev", "hvnbn"])
        run(["ip", "-n", NEIGHBOUR_NS, "-6", "addr", "add", NEIGHBOUR6 + "/64", "dev", "hvnbn", "nodad"])
        run(["ip", "-n", NEIGHBOUR_NS, "link", "set", "hvnbn", "up"])
        run(["ip", "-n", NEIGHBOUR_NS, "route", "add", "default", "via", OWN_BRIDGE])
        # A policy table like Tailscale's (52): the neighbour is a gateway there.
        run(["ip", "route", "add", POLICY_ROUTE, "via", NEIGHBOUR, "table", "52"])
        subprocess.Popen(["ip", "netns", "exec", NEIGHBOUR_NS, "/usr/bin/python3", "-I", "-c", LISTENER],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=ENV)
    if run(["docker", "inspect", "hvnb-web"], check=False).returncode != 0:
        run(["docker", "run", "-d", "--rm", "--name", "hvnb-web", "busybox", "httpd", "-f", "-p", "80"], timeout=300)
    time.sleep(2)
    container = run(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "hvnb-web"]).stdout.strip()
    host_reach = run(["curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", "http://" + container + "/"], check=False).stdout
    neighbour_reach = run(["python3", "-c", "import socket;s=socket.create_connection(('%s',8006),3);print(s.recv(32).decode().strip())" % PROXMOX_HOST],
                          check=False).stdout.strip()
    return {"neighbourNamespace": NEIGHBOUR_NS, "onlinkPublicPrefix": "203.0.113.0/24", "neighbour": NEIGHBOUR,
            "proxmoxHost": PROXMOX_HOST, "policyGateway": NEIGHBOUR, "container": container,
            "rootReachesContainer": host_reach, "rootReachesProxmoxHost": neighbour_reach}


# ---- the matrix ----------------------------------------------------------------

def gateway_json(method, route, body=None, token=None):
    token = token or open("/home/bux/.hivra/api-token").read().strip()
    args = ["curl", "-s", "-m", "180", "-o", "/dev/stdout", "-w", "\n%{http_code}", "-X", method,
            "-H", "Authorization: Bearer " + token, "-H", "Content-Type: application/json"]
    if body is not None:
        args += ["-d", json.dumps(body)]
    result = run(args + ["http://127.0.0.1:8080" + route], check=False)
    text, _, code = result.stdout.rpartition("\n")
    return int(code or 0), text


def owner_surfaces():
    """The owner's Files and Terminal through the gateway, as the browser reaches them."""
    files_code, _ = gateway_json("GET", "/api/files?path=.")
    terminal_code, _ = gateway_json("GET", "/terminal/")
    box_code, _ = gateway_json("GET", "/box-terminal/")
    return {"files": files_code, "terminal": terminal_code, "boxTerminal": box_code}


def sweep(agent_unit, targets, ports):
    return in_unit(agent_unit, PROBE_CONNECT, [json.dumps(targets), json.dumps(sorted(set(ports)))])


def remove_nft_layer(installation):
    table = "hivra_attached_" + installation.replace("-", "")[:12]
    run(["nft", "delete", "table", "inet", table])


def remove_systemd_layer(units):
    for unit in (units["agent"], units["probe"]):
        run(["systemctl", "set-property", "--runtime", unit, "IPAddressDeny="])


def restore_layers(installation):
    return json.loads(run(["/usr/local/lib/hivra/attached-network", "up", installation]).stdout)


def planted_repository(units, installation):
    """T10: the agent plants a repository whose settings run programs; the owner then
    uses the four Git routes and Files through the gateway. No marker may appear."""
    view = "/var/lib/hivra/agent-views/%s/Hivra" % installation
    plant = r"""
import os, subprocess, sys, json
view = sys.argv[1]; repo = view + "/planted"
os.makedirs(repo, exist_ok=True)
def git(*a): subprocess.run(["git", "-C", repo, *a], capture_output=True, env={"HOME": os.environ.get("HOME", "/tmp"), "PATH": "/usr/bin:/bin"})
git("init", "-q")
marker = "/home/bux/HIVRA_MARKER_"
git("config", "core.fsmonitor", "touch " + marker + "fsmonitor; echo")
git("config", "diff.hv.textconv", "sh -c 'touch " + marker + "textconv; cat \"$0\"'")
git("config", "filter.hv.clean", "sh -c 'touch " + marker + "clean; cat'")
git("config", "filter.hv.smudge", "sh -c 'touch " + marker + "smudge; cat'")
os.makedirs(repo + "/.git/info", exist_ok=True)
open(repo + "/.git/info/attributes", "w").write("* filter=hv diff=hv\n")
for hook in ("pre-commit", "post-checkout", "reference-transaction"):
    path = repo + "/.git/hooks/" + hook
    open(path, "w").write("#!/bin/sh\ntouch " + marker + hook + "\n"); os.chmod(path, 0o755)
open(repo + "/page.html", "w").write("<script>alert(1)</script>\n")
open(repo + "/image.svg", "w").write('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n')
other = view + "/redirect"
os.makedirs(other, exist_ok=True)
open(other + "/.git", "w").write("gitdir: /home/bux/.hivra\n")
print(json.dumps({"planted": True}))
"""
    planted = in_unit(units["agent"], plant, [view])
    routes = {}
    for method, route, body in (("GET", "/api/git/status?repo=planted", None), ("GET", "/api/git/diff?repo=planted", None),
                                ("POST", "/api/git/commit", {"repo": "planted", "message": "x"}),
                                ("POST", "/api/git/checkout", {"repo": "planted", "branch": "main"}),
                                ("GET", "/api/git/status?repo=redirect", None)):
        code, _ = gateway_json(method, route, body)
        routes[method + " " + route.split("?")[0] + ("" if "redirect" not in route else " (redirect)")] = code
    files = {}
    for name in ("planted/page.html", "planted/image.svg"):
        code, text = gateway_json("GET", "/api/file?path=" + name)
        files["read " + name] = code
    code, _ = gateway_json("POST", "/api/file", {"path": "planted/page.html", "content": "<p>owner saved</p>\n"})
    files["save planted/page.html"] = code
    time.sleep(2)
    markers = run(["sh", "-c", "find / -xdev -name '" + MARKER_PREFIX + "*' 2>/dev/null | head -5"], check=False).stdout.split()
    return {"planted": planted, "routes": routes, "files": files, "markers": markers}


TOOL_PROBE = r"""
import errno, json, os, subprocess
out = {"ran": True}
def rc(args):
    try:
        return subprocess.run(args, capture_output=True, input="", timeout=20).returncode
    except FileNotFoundError:
        return "absent"
def err(fn):
    try:
        fn(); return "allowed"
    except OSError as e:
        return errno.errorcode.get(e.errno, str(e.errno))
home = os.environ["HOME"]
out["sudo_n_true"] = rc(["sudo", "-n", "true"])
open(home + "/suid-probe", "w").close()
out["setuid"] = err(lambda: os.chmod(home + "/suid-probe", 0o4755))
out["crontab"] = rc(["crontab", "-"]); out["at_now"] = rc(["at", "now"])
out["systemd_run_user"] = rc(["systemd-run", "--user", "sleep", "300"]); out["loginctl_linger"] = rc(["loginctl", "enable-linger"])
out["ls_home_bux"] = err(lambda: os.listdir("/home/bux")); out["read_token"] = err(lambda: open("/home/bux/.hivra/api-token").read())
out["groups"] = sorted(set(os.getgroups()) | {os.getgid()}); out["uid"] = os.getuid()
out["seccomp"] = [l.split()[1] for l in open("/proc/self/status") if l.startswith("Seccomp:")][0]
out["no_new_privs"] = [l.split()[1] for l in open("/proc/self/status") if l.startswith("NoNewPrivs:")][0]
json.dump(out, open(home + "/.hivra-tool-probe.json", "w"))
"""


def codex_tool_probe(installation, home):
    """Ask the attached Codex, through the owner's gateway, to run the probe as a
    tool (the stub model answers RUN:<command> with one exec_command call)."""
    import base64
    target = os.path.join(home, ".hivra-tool-probe.json")
    if os.path.lexists(target):
        os.unlink(target)
    encoded = base64.b64encode(TOOL_PROBE.encode()).decode()
    command = "echo " + encoded + " | base64 -d | python3 -"
    code, text = gateway_json("POST", "/agents/%s/api/chat" % installation, {"message": "RUN:" + command})
    for _ in range(30):
        if os.path.exists(target):
            break
        time.sleep(2)
    try:
        with open(target) as source:
            return json.load(source)
    except (OSError, ValueError):
        return {"ran": False, "chatStatus": code, "chatTail": text[-400:]}


def matrix(installation):
    units = unit_names(installation)
    hexid = installation.replace("-", "")
    account = "hva_" + hexid[:24]
    user = pwd.getpwnam(account)
    verdict = {"version": 1, "installationId": installation, "kernel": os.uname().release,
               "os": open("/etc/os-release").read().split("PRETTY_NAME=")[1].split("\n")[0].strip('"'),
               "systemd": run(["systemctl", "--version"]).stdout.splitlines()[0], "checks": {}}
    checks = verdict["checks"]

    def check(name, passed, detail):
        checks[name] = {"pass": bool(passed), "detail": detail}

    run(["systemctl", "stop", units["watchdog"]], check=False)
    gateway_pid = int(show("bux-hivra-chat.service", "MainPID") or 0)
    addresses = own_addresses()
    listeners, canary_port = canary_listeners()
    try:
        ports = sorted(set(listening_ports()) | {canary_port, 22, 53, 80, 443, 7681, 7682, 8006, 8080, 8088})
        own_targets = sorted(set(mapped(addresses) + ["127.0.0.1", "127.0.0.53", "127.0.0.54", "::1", "198.18.0.1"]))
        container = run(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "hvnb-web"], check=False).stdout.strip()
        neighbour_targets = [t for t in (NEIGHBOUR, PROXMOX_HOST, NEIGHBOUR6, container, default_gateway(), "169.254.169.254") if t]
        verdict["targets"] = {"own": own_targets, "neighbours": neighbour_targets, "ports": ports, "canaryPort": canary_port}

        # T5/T7/T37 with both layers.
        both_own = sweep(units["agent"], own_targets, ports)
        both_neighbours = sweep(units["agent"], neighbour_targets, sorted(set(NEIGHBOUR_PORTS) | {canary_port}))
        check("T5_own_addresses_both_layers", not both_own.get("reached") and "error" not in both_own, both_own)
        check("T7_T37_neighbours_gateway_container_both_layers", not both_neighbours.get("reached") and "error" not in both_neighbours, both_neighbours)
        public = in_unit(units["agent"], PROBE_PUBLIC)
        check("dns_https_own_localhost_both_layers", public.get("dnsFrom127_0_0_1") and public.get("publicHttps") and public.get("ownLocalhostServer"), public)

        # Each layer alone.
        remove_nft_layer(installation)
        try:
            nft_off_own = sweep(units["agent"], own_targets, ports)
            nft_off_neighbours = sweep(units["agent"], neighbour_targets, sorted(set(NEIGHBOUR_PORTS) | {canary_port}))
            check("T5_T37_systemd_layer_alone", not nft_off_own.get("reached") and not nft_off_neighbours.get("reached")
                  and "error" not in nft_off_own, {"own": nft_off_own, "neighbours": nft_off_neighbours})
            refused = json.loads(run(["/usr/local/lib/hivra/attached-network", "enforce", installation], timeout=200, check=False).stdout or "{}")
            check("enforcement_probe_refuses_without_nft", refused.get("state") == "refused", refused)
        finally:
            restore_layers(installation)
        remove_systemd_layer(units)
        try:
            sd_off_own = sweep(units["agent"], own_targets, ports)
            sd_off_neighbours = sweep(units["agent"], neighbour_targets, sorted(set(NEIGHBOUR_PORTS) | {canary_port}))
            sd_off_public = in_unit(units["agent"], PROBE_PUBLIC)
            check("T5_T37_nft_layer_alone", not sd_off_own.get("reached") and not sd_off_neighbours.get("reached")
                  and "error" not in sd_off_own and sd_off_public.get("publicHttps"),
                  {"own": sd_off_own, "neighbours": sd_off_neighbours, "publicHttps": sd_off_public.get("publicHttps")})
            refused = json.loads(run(["/usr/local/lib/hivra/attached-network", "enforce", installation], timeout=200, check=False).stdout or "{}")
            check("enforcement_probe_refuses_without_systemd_filter", refused.get("state") == "refused", refused)
        finally:
            restore_layers(installation)
        verdict["canaryConnections"] = drain(listeners)
        check("canary_listeners_untouched", verdict["canaryConnections"] == 0, verdict["canaryConnections"])
    finally:
        for item in listeners:
            item.close()

    # T4, T9, T15, T31 (access on), T32, T33 file facts.
    run(["mkdir", "-p", "/home/bux/Hivra/submount"])
    run(["mount", "-t", "tmpfs", "-o", "size=1m", "hvsub", "/home/bux/Hivra/submount"])
    run(["sh", "-c", "echo x > /home/bux/Hivra/submount/SUBMOUNT_MARKER"])
    try:
        files = in_unit(units["agent"], PROBE_FILES, [installation, gateway_pid, user.pw_dir])
    finally:
        run(["umount", "/home/bux/Hivra/submount"], check=False)
        run(["rmdir", "/home/bux/Hivra/submount"], check=False)
    denied = lambda value: value in ("EACCES", "EPERM", "EROFS", "ENOENT", "ECONNREFUSED")
    check("T4_owner_home_token_environ", all(denied(files.get(k)) for k in ("ls_home_bux", "read_computer_token", "read_owner_environ"))
          and files.get("owner_submount_visible") is False, {k: files.get(k) for k in ("ls_home_bux", "read_computer_token", "read_owner_environ", "owner_submount_visible")})
    check("T5_terminal_socket", denied(files.get("connect_box_terminal_socket")) and denied(files.get("read_ttyd_socket_dir")),
          {k: files.get(k) for k in ("connect_box_terminal_socket", "read_ttyd_socket_dir")})
    check("T6_system_bus", denied(files.get("connect_system_bus")), files.get("connect_system_bus"))
    # The setuid refusal is RestrictSUIDSGID, a seccomp filter only the unit's
    # own processes carry; it is checked from Codex's tool below.
    check("T9_no_sudo_own_group_only", files.get("sudo_n_true") not in (0,) and files.get("groups") == [user.pw_gid],
          dict({k: files.get(k) for k in ("sudo_n_true", "groups")}, agentGid=user.pw_gid))
    check("T15_agent_cannot_open_or_replace_chat_socket", denied(files.get("connect_own_chat_socket")) and denied(files.get("replace_own_chat_socket")),
          {k: files.get(k) for k in ("connect_own_chat_socket", "replace_own_chat_socket")})
    check("T32_no_work_outside_unit", all(files.get(k) != 0 for k in ("crontab", "at_now", "systemd_run_user", "loginctl_linger")),
          {k: files.get(k) for k in ("crontab", "at_now", "systemd_run_user", "loginctl_linger")})
    check("T33_starting_folder_immutable", all(denied(files.get(k)) for k in ("rm_agents_md", "mv_agents_md", "ln_agents_md", "create_in_starting_folder")),
          {k: files.get(k) for k in ("rm_agents_md", "mv_agents_md", "ln_agents_md", "create_in_starting_folder")})
    socket_path = "/run/hivra-attached/%s.sock" % installation
    others = {}
    for who in ("nobody", "hivra-desktop-broker"):
        try:
            pwd.getpwnam(who)
        except KeyError:
            others[who] = "no such user"
            continue
        result = run(["setpriv", "--reuid", who, "--regid", "nogroup", "--clear-groups", "python3", "-c",
                      "import socket;s=socket.socket(socket.AF_UNIX);s.connect('%s')" % socket_path], check=False)
        others[who] = "refused" if result.returncode != 0 else "connected"
    check("T15_other_users_cannot_open_chat_socket", all(v != "connected" for v in others.values()), others)
    bux_home = run(["setpriv", "--reuid", "bux", "--regid", "bux", "--init-groups", "ls", user.pw_dir], check=False)
    check("T11_owner_cannot_read_agent_home", bux_home.returncode != 0, bux_home.stderr.strip()[-200:])

    # T6/T8: path sockets and readable secrets inside the unit.
    secrets = in_unit(units["agent"], PROBE_SECRETS, [installation, json.dumps([SECRET_PATHS, SECRET_SUFFIXES])], timeout=300)
    # Justified: journald (the unit's own logging), PID 1's notify socket (it
    # ignores a unit without NotifyAccess), and userdb's DynamicUser lookup
    # (read-only NSS answers). Everything else must be unreachable.
    allowed_sockets = ("/run/systemd/journal/", "/run/systemd/userdb/io.systemd.DynamicUser", "/run/systemd/notify")
    unexpected = [s for s in secrets.get("connectableSockets", []) if not s.startswith(allowed_sockets)]
    check("T8_readable_secret_sweep_empty", secrets.get("flagged") == [], {"flagged": secrets.get("flagged"), "readableFiles": secrets.get("readableFiles")})
    check("T6_path_socket_sweep_matches_allowlist", unexpected == [], {"connectable": secrets.get("connectableSockets"), "unexpected": unexpected})
    abstract = [line.split()[4] for line in run(["ss", "-Hxl"]).stdout.splitlines() if len(line.split()) > 4 and line.split()[4].startswith("@")]
    abstract_probe = in_unit(units["agent"], r"""
import json, socket, sys
reached = []
for name in json.loads(sys.argv[1]):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(1)
    try:
        s.connect("\0" + name[1:]); reached.append(name)
    except OSError:
        pass
    finally:
        s.close()
print(json.dumps({"reached": reached}))
""", [json.dumps(abstract[:64])])
    check("T6_abstract_sockets_unreachable", abstract_probe.get("reached") == [], {"listed": len(abstract), "reached": abstract_probe.get("reached")})

    # T36: the DNS relay from its own cgroup and namespaces.
    relay_targets = [["127.0.0.1", 7681], ["127.0.0.1", 8080], ["127.0.0.54", 53], ["127.0.0.53", 80], ["127.0.0.53", 5355]]
    relay_targets += [[address, 22] for address in addresses if ":" not in address]
    relay = in_unit(units["dns"], PROBE_RELAY, [json.dumps(relay_targets)]) if int(show(units["dns"], "MainPID") or 0) > 1 else {"error": "relay not running"}
    check("T36_relay_reaches_only_resolver", relay.get("reached") == [] and relay.get("upstreamDnsWorks") is True, relay)

    # T10: planted repository through the owner's gateway routes.
    planted = planted_repository(units, installation)
    check("T10_git_routes_404_files_bytes_only_no_marker", all(code == 404 for code in planted["routes"].values())
          and planted["files"].get("read planted/page.html") == 200 and not planted["markers"], planted)

    # T9/T32/T4 again from the agent's own process tree: a command Codex runs
    # as a tool inherits the unit's seccomp filter (RestrictSUIDSGID,
    # SystemCallFilter), which a probe that only joins the namespaces does not.
    tool = codex_tool_probe(installation, user.pw_dir)
    check("T9_T32_T4_from_codex_tool", tool.get("ran") is True and tool.get("sudo_n_true") not in (0,)
          and tool.get("setuid") in ("EPERM", "EACCES") and all(tool.get(k) != 0 for k in ("crontab", "at_now", "systemd_run_user", "loginctl_linger"))
          and tool.get("ls_home_bux") in ("EACCES", "ENOENT") and tool.get("read_token") in ("EACCES", "ENOENT")
          and tool.get("groups") == [user.pw_gid], tool)

    # T22: memory past MemoryMax: the kernel kills inside the unit only; the
    # chat instance and the owner's gateway keep running.
    since = time.strftime("%Y-%m-%d %H:%M:%S")
    memory = in_unit(units["agent"], PROBE_MEMORY, want_json=False, timeout=180)
    time.sleep(3)
    kernel = run(["journalctl", "-k", "--since", since, "--no-pager", "-o", "cat"], check=False).stdout
    killed = [line for line in kernel.splitlines() if "Killed process" in line or "oom_memcg=" in line]
    confined = bool(killed) and all("hivra-attached-" + installation in line for line in killed if "oom_memcg=" in line)
    gateway_ok = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8080/healthz"], check=False).stdout
    check("T22_memory_limit_contained", confined and gateway_ok == "200" and show(units["agent"], "ActiveState") == "active",
          {"memoryMax": show(units["agent"], "MemoryMax"), "kernel": killed[-2:], "probeRc": memory.returncode,
           "agentState": show(units["agent"], "ActiveState"), "gatewayHealthz": gateway_ok})
    run(["systemctl", "start", units["socket"]], check=False)

    # Owner surfaces after attach.
    surfaces = owner_surfaces()
    check("owner_files_terminal_after_attach", surfaces == {"files": 200, "terminal": 200, "boxTerminal": 200}, surfaces)
    run(["systemctl", "start", units["watchdog"]], check=False)
    verdict["pass"] = all(item["pass"] for item in checks.values())
    return verdict


def do_watchdog_checks(installation):
    """T24 and T37's watchdog path: a missing table and a new on-link prefix both stop
    the agent, restore, re-probe and only then start it again."""
    units = unit_names(installation)
    result = {"checks": {}}
    table = "hivra_attached_" + installation.replace("-", "")[:12]
    run(["systemctl", "start", units["watchdog"]])
    since = time.strftime("%Y-%m-%d %H:%M:%S")
    run(["nft", "delete", "table", "inet", table])
    deadline = time.monotonic() + 150
    restored = False
    while time.monotonic() < deadline:
        if run(["nft", "list", "table", "inet", table], check=False).returncode == 0:
            restored = True
            break
        time.sleep(3)
    time.sleep(8)
    journal = run(["journalctl", "-u", "hivra-attached-%s-watchdog.service" % installation, "--since", since, "--no-pager", "-o", "cat"], check=False).stdout
    result["checks"]["T24_table_deleted_watchdog_restores"] = {
        "pass": restored and "agent_stopped" in journal and "probe_enforced" in journal
        and show(units["agent"], "ActiveState") == "active", "detail": journal.strip().splitlines()[-4:]}
    # A new on-link prefix appears (someone changed the computer's network by hand).
    since = time.strftime("%Y-%m-%d %H:%M:%S")
    run(["ip", "link", "add", "hvnew", "type", "dummy"])
    run(["ip", "addr", "add", "192.0.2.1/24", "dev", "hvnew"])
    run(["ip", "link", "set", "hvnew", "up"])
    try:
        deadline = time.monotonic() + 150
        covered = False
        while time.monotonic() < deadline:
            listed = run(["nft", "list", "set", "inet", table, "onlink4"], check=False).stdout
            if "192.0.2.0/24" in listed:
                covered = True
                break
            time.sleep(3)
        time.sleep(8)
        deny = show(units["agent"], "IPAddressDeny")
        journal = run(["journalctl", "-u", "hivra-attached-%s-watchdog.service" % installation, "--since", since, "--no-pager", "-o", "cat"], check=False).stdout
        result["checks"]["T37_new_onlink_prefix_watchdog_updates_both_layers"] = {
            "pass": covered and "192.0.2.0/24" in deny and "agent_stopped" in journal and "probe_enforced" in journal
            and show(units["agent"], "ActiveState") == "active",
            "detail": {"journal": journal.strip().splitlines()[-4:], "denyHasPrefix": "192.0.2.0/24" in deny}}
    finally:
        run(["ip", "link", "delete", "hvnew"], check=False)
    # Break the mount: the unit refuses to start while its view does not match its grant.
    run(["systemctl", "stop", units["socket"], units["agent"]], check=False)
    run(["/usr/local/lib/hivra/attached-workspace", "unmount", installation], check=False)
    started = run(["systemctl", "start", units["agent"]], check=False, timeout=60)
    state = show(units["agent"], "ActiveState")
    status = run(["systemctl", "status", units["agent"], "--no-pager", "-n", "5"], check=False).stdout
    result["checks"]["T24_broken_view_refuses_to_start"] = {
        "pass": started.returncode != 0 and state != "active" and "view_not_as_granted" in run(
            ["journalctl", "-u", units["agent"], "-n", "30", "--no-pager", "-o", "cat"], check=False).stdout,
        "detail": {"startRc": started.returncode, "state": state, "status": status.strip().splitlines()[-3:]}}
    run(["systemctl", "reset-failed", units["agent"]], check=False)
    run(["systemctl", "restart", units["workspace"]], timeout=120)
    run(["systemctl", "start", units["socket"], units["agent"]], timeout=120)
    result["pass"] = all(item["pass"] for item in result["checks"].values())
    return result


def tree_hash(root="/home/bux/Hivra"):
    digest = hashlib.sha256()
    for base, dirs, files in sorted(os.walk(root)):
        dirs.sort()
        for name in sorted(dirs + files):
            path = os.path.join(base, name)
            info = os.lstat(path)
            digest.update(("%s %o %d:%d\n" % (os.path.relpath(path, root), info.st_mode, info.st_uid, info.st_gid)).encode())
            if stat.S_ISREG(info.st_mode):
                with open(path, "rb") as source:
                    digest.update(hashlib.sha256(source.read()).digest())
    return digest.hexdigest()


def removed(installation, before):
    hexid = installation.replace("-", "")
    account, group = "hva_" + hexid[:24], "hvc_" + hexid[:24]
    units = run(["sh", "-c", "systemctl list-units --all --no-legend 'hivra-attached-%s*' | wc -l; ls /etc/systemd/system | grep -c %s || true" % (installation, installation)]).stdout.split()
    mounts = [line for line in open("/proc/self/mountinfo").read().splitlines() if installation in line]
    netns = [item.get("name") for item in json.loads(run(["ip", "-j", "netns", "list"]).stdout or "[]")]
    tables = run(["nft", "list", "tables"]).stdout
    account_gone = run(["getent", "passwd", account], check=False).returncode != 0
    groups_gone = all(run(["getent", "group", name], check=False).returncode != 0 for name in (account, group))
    processes = run(["pgrep", "-u", account], check=False).stdout.strip() if not account_gone else ""
    paths = [p for p in ("/var/lib/hivra/agent-homes/" + installation, "/var/lib/hivra/agent-views/" + installation,
                         "/opt/hivra/agent-installations/" + installation, "/etc/hivra/attachments/" + installation,
                         "/run/hivra-attached/%s.sock" % installation) if os.path.lexists(p)]
    after = tree_hash()
    checks = {
        "T23_workspace_unchanged": {"pass": after == before, "detail": {"before": before, "after": after}},
        "T23_no_units": {"pass": units == ["0", "0"], "detail": units},
        "T23_no_mounts": {"pass": mounts == [], "detail": mounts[:3]},
        "T23_no_network": {"pass": ("hivra-" + hexid[:12]) not in netns and ("hivra_attached_" + hexid[:12]) not in tables, "detail": netns},
        "T23_no_account_or_groups": {"pass": account_gone and groups_gone and not processes, "detail": {"account": account_gone, "groups": groups_gone}},
        "T23_no_paths": {"pass": paths == [], "detail": paths},
        "owner_files_terminal_after_remove": {"pass": owner_surfaces() == {"files": 200, "terminal": 200, "boxTerminal": 200}, "detail": owner_surfaces()},
    }
    return {"version": 1, "installationId": installation, "checks": checks, "pass": all(c["pass"] for c in checks.values())}


def main(argv):
    if os.geteuid() != 0:
        raise SystemExit("run as root on a disposable VM")
    command = argv[1] if len(argv) > 1 else ""
    if command == "neighbours":
        result = do_neighbours()
    elif command == "matrix" and len(argv) == 3:
        result = matrix(argv[2])
    elif command == "watchdog" and len(argv) == 3:
        result = do_watchdog_checks(argv[2])
    elif command == "tree-hash":
        result = {"treeSha256": tree_hash()}
    elif command == "removed" and len(argv) == 4:
        result = removed(argv[2], argv[3])
    else:
        raise SystemExit(__doc__)
    print(json.dumps(result, indent=1, sort_keys=True))
    if isinstance(result, dict) and result.get("pass") is False:
        raise SystemExit(1)


if __name__ == "__main__":
    main(sys.argv)
