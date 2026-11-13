#!/usr/bin/env python3
"""Hivra host wake proxy: the host-side front door for host-ingress computers.

Python 3 standard library only. One file, three entry points:

  helper   Runs as root (hivra-wake-helper.service). Owns everything privileged:
           the route files (with their ticket keys), the nap markers, the
           per-VM locks and QMP. Listens on a unix socket (ctl.sock) and
           answers one JSON line per connection. The peer is identified with
           SO_PEERCRED: root may send every command, the forwarder's user only
           wake (with a ticket), status and health, the wake doorbell's user
           (hivra-wake-doorbell.py) only request and health; anyone else is
           refused.
  proxy    Runs as an unprivileged user (hivra-wake-proxy.service). Listens on
           127.0.0.1:8080 and [::1]:8080 for the host connector
           (hivra-cf@<vmid>), finds the computer from the Host header and
           splices the request to the guest forwarder on <guest_ip>:18080.
           It never holds a key and never talks to QMP: a ticket wake is
           handed to the helper. Its own socket (fwd.sock) takes drain,
           undrain, napped, stats, reload and health from root only.
  ctl      `ctl <cmd> [vmid] [ms]`: one request to the helper, prints the JSON
           answer. Exit 0 when ok, 1 when the helper said no, 2 when the
           helper could not be reached.

Calls to Hivra (only once the install step wrote a host credential to
/etc/hivra/ingress/host-credential.json; without it the proxy calls nothing).
The helper reads the credential and signs each call; it has no network of its
own, so it hands the finished request to the forwarder (`post` on fwd.sock),
which sends it. The internet-facing forwarder never holds the credential, only
single-use signed requests bound to one path and body. Each call is a signed
POST (see sign_request):
  wake-report   after the helper resumed a napped VM, so Hivra sets the agent
                awake and takes its channel wake arms down at once.
  wake-request  `request` on the control socket, and a valid ticket for a VM
                that is not running (hibernated): Hivra runs its normal wake.

Fail toward awake. The proxy only ever resumes (QMP cont) a VM that is paused
AND carries a valid nap marker (/run/hivra-ingress-state/napped-<vmid> holding
the running QEMU pid). A paused VM without one is never touched, an unknown
host gets 503, and a drain that nobody finishes expires on its own.

Nothing host-specific lives in this file. Routes are read at run time from
/etc/hivra/ingress/routes/<vmid>.json (root only), checked against the
computer's binding tag in /etc/pve/qemu-server/<vmid>.conf, and only their
public half (hostname, vmid, guest address) is published to the forwarder.
Headers, cookies and bodies are never logged.
"""

import asyncio
import base64
import collections
import concurrent.futures
import errno
import fcntl
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import pwd
import random
import re
import signal
import socket
import stat
import struct
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import unquote

VERSION = "hivra-wake-proxy/2"

MAX_HEAD = 32 * 1024
HEAD_TIMEOUT = 10.0
MAX_RESPONSE_HEAD = 64 * 1024
MAX_INTERIM_RESPONSES = 5
GUEST_CONNECT_TIMEOUT = 1.0
CTL_TIMEOUT = 5.0
CTL_MAX_LINE = 16 * 1024
MAX_ROUTE_BYTES = 64 * 1024
TICKET_MAX_AHEAD = 120
REPLAY_WINDOW = 300
REPLAY_MAX = 20000
BAD_TICKET_LIMIT = 20
BAD_TICKET_WINDOW = 60.0
DRAIN_LEASE = 30.0
DRAIN_MAX_MS = 30000
VM_LOCK_WAIT = 3.0
QMP_TIMEOUT = 2.0
QGA_LOCK_WAIT = 30.0
FIXUP_AGENT_WAIT = 8.0
FIXUP_CALL_TIMEOUT = 5.0
FIXUP_EXEC_TIMEOUT = 12.0
FIXUP_SYNC_TIMEOUT = 1.0
HEALTH_DEADLINE = 3.0
HEALTH_INTERVAL = 0.05
NAPPED_CACHE_SECONDS = 1.0
ROUTE_POLL_SECONDS = 2.0
WATCHDOG_SECONDS = 5.0
WAKES_KEPT = 20
MAX_QMP_LINE = 1024 * 1024
RETRY_DELAY = 0.05
CREDENTIAL_MAX_BYTES = 4096
HIVRA_CALL_TIMEOUT = 5.0
HIVRA_ANSWER_MAX = 16 * 1024
REPORT_ATTEMPTS = 3
REPORT_BACKOFF = (0.5, 2.0)
REQUEST_MIN_INTERVAL = 5.0
WAKE_REPORT_PATH = "/api/hivra/ingress/wake-report"
WAKE_REQUEST_PATH = "/api/hivra/ingress/wake-request"
REQUEST_REASONS = frozenset(("ticket", "client", "doorbell", "ctl"))

# The guest fixup after a proxy wake: the host's clock, then drop the paused
# guest's dead :443 connections. It never touches the guest's tunnel unit,
# which is disabled for a host-ingress computer.
FIXUP_TEMPLATE = "date -s @%s >/dev/null; ss -K state established '( dport = :443 )' >/dev/null 2>&1 || true"

VMID_RE = re.compile(r"^[0-9]{3,9}$")
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")
TAG_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
HEX_64_128_RE = re.compile(r"^[0-9a-f]{64,128}$")
HEX_64_RE = re.compile(r"^[0-9a-f]{64}$")
HOST_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
ORIGIN_RE = re.compile(r"^https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
TEST_ORIGIN_RE = re.compile(r"^http://127\.0\.0\.1:[0-9]{1,5}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MAC_RE = re.compile(r"^[0-9a-f]{64}$")
EXP_RE = re.compile(r"^[0-9]{1,12}$")
HTTP_TCHAR_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
PID_RE = re.compile(rb"^\s*([0-9]{1,10})\s*$")
MIN_VMID = 100
MAX_VMID = 999_999_999

ROOT_COMMANDS = frozenset(("wake", "status", "drain", "undrain", "napped", "stats", "reload", "health", "request"))
FORWARDER_COMMANDS = frozenset(("wake", "status", "health", "request"))
# The wake doorbell may only ask Hivra for a wake (always as "doorbell") and read health.
DOORBELL_COMMANDS = frozenset(("health", "request"))
FWD_COMMANDS = frozenset(("drain", "undrain", "napped", "stats", "reload", "health", "post"))
HIVRA_PATHS = frozenset((WAKE_REPORT_PATH, WAKE_REQUEST_PATH))

mono = time.monotonic


class Config(object):
    """Paths and limits. The defaults are the host's; tests point them at a temporary tree."""

    def __init__(self, **overrides):
        self.routes_dir = "/etc/hivra/ingress/routes"
        self.run_dir = "/run/hivra-ingress"
        self.fwd_dir = "/run/hivra-ingress-fwd"
        self.state_dir = "/run/hivra-ingress-state"
        self.qemu_dir = "/var/run/qemu-server"
        self.pve_dir = "/etc/pve/qemu-server"
        self.lock_dir = "/run/lock"
        self.proc_dir = "/proc"
        self.listen = [("127.0.0.1", 8080), ("::1", 8080)]
        self.forwarder_user = "hivra-ingress"
        self.root_uids = (0,)
        self.forwarder_uid = None
        self.doorbell_user = "hivra-doorbell"
        self.doorbell_uid = None
        self.allow_loopback_guests = False
        self.fixup = True
        self.head_timeout = HEAD_TIMEOUT
        self.vm_lock_wait = VM_LOCK_WAIT
        self.drain_lease = DRAIN_LEASE
        self.health_deadline = HEALTH_DEADLINE
        self.credential_path = "/etc/hivra/ingress/host-credential.json"
        # Tests only: lets the credential name a plain-http loopback origin.
        self.allow_test_origin = False
        for key, value in overrides.items():
            if not hasattr(self, key):
                raise TypeError("unknown config key: %s" % key)
            setattr(self, key, value)

    @property
    def ctl_path(self):
        return os.path.join(self.run_dir, "ctl.sock")

    @property
    def fwd_path(self):
        return os.path.join(self.fwd_dir, "fwd.sock")

    @property
    def public_routes_path(self):
        return os.path.join(self.run_dir, "routes.json")

    def marker_path(self, vmid):
        return os.path.join(self.state_dir, "napped-%d" % vmid)

    def resolved_forwarder_uid(self):
        if self.forwarder_uid is not None:
            return self.forwarder_uid
        try:
            return pwd.getpwnam(self.forwarder_user).pw_uid
        except KeyError:
            return None

    def resolved_doorbell_uid(self):
        if self.doorbell_uid is not None:
            return self.doorbell_uid
        try:
            return pwd.getpwnam(self.doorbell_user).pw_uid
        except KeyError:
            return None

    def resolved_forwarder_gid(self):
        try:
            return pwd.getpwnam(self.forwarder_user).pw_gid
        except KeyError:
            return None


def log(event, **fields):
    """One JSON line on stderr (the journal). Callers pass only fixed fields: never headers, cookies or bodies."""
    record = {"event": event, "at": round(time.time(), 3)}
    record.update(fields)
    try:
        sys.stderr.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def parse_vmid(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and VMID_RE.match(value):
        value = int(value)
    if isinstance(value, int) and MIN_VMID <= value <= MAX_VMID:
        return value
    return None


# ---------------------------------------------------------------- routes

def conf_tags(text):
    """Tags of the VM's current config (the part before any [snapshot] section), split on ';' like the sleep scripts."""
    for line in text.splitlines():
        if line.startswith("["):
            break
        if line.startswith("tags:"):
            return [tag.strip() for tag in line[5:].strip().split(";") if tag.strip()]
    return []


def binding_matches(cfg, vmid, binding_tag):
    try:
        with open(os.path.join(cfg.pve_dir, "%d.conf" % vmid), "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read(1024 * 1024)
    except OSError:
        return False
    return binding_tag in conf_tags(text)


def guest_address_ok(cfg, value):
    try:
        address = ipaddress.IPv4Address(value)
    except (ipaddress.AddressValueError, ValueError):
        return False
    if address.is_loopback:
        return bool(cfg.allow_loopback_guests)
    shared = address in ipaddress.IPv4Network("100.64.0.0/10")
    return (address.is_private or shared) and not (address.is_unspecified or address.is_multicast or address.is_link_local)


def parse_route(cfg, raw, file_vmid):
    """The route file's fields this proxy uses. Unknown fields are kept out, not refused, so later stages can add theirs."""
    if not isinstance(raw, dict):
        raise ValueError("not_object")
    if raw.get("version", 1) != 1:
        raise ValueError("version")
    vmid = parse_vmid(raw.get("vmid"))
    if vmid is None or vmid != file_vmid:
        raise ValueError("vmid")
    hostname = raw.get("hostname")
    if not isinstance(hostname, str) or not HOSTNAME_RE.match(hostname):
        raise ValueError("hostname")
    tag = raw.get("binding_tag")
    if not isinstance(tag, str) or not TAG_RE.match(tag):
        raise ValueError("binding_tag")
    guest_ip = raw.get("guest_ip")
    if not isinstance(guest_ip, str) or not guest_address_ok(cfg, guest_ip):
        raise ValueError("guest_ip")
    guest_port = raw.get("guest_port", 18080)
    if isinstance(guest_port, bool) or not isinstance(guest_port, int) or not 1 <= guest_port <= 65535:
        raise ValueError("guest_port")
    key = raw.get("ticket_key")
    if not isinstance(key, str) or not HEX_64_128_RE.match(key):
        raise ValueError("ticket_key")
    generation = raw.get("generation", 0)
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 0:
        raise ValueError("generation")
    return {"vmid": vmid, "hostname": hostname, "binding_tag": tag, "guest_ip": guest_ip,
            "guest_port": guest_port, "ticket_key": key, "generation": generation}


def load_routes(cfg):
    """Every valid, bound route by vmid, and the problems found (by file, never by content)."""
    routes, problems = {}, []
    try:
        names = sorted(os.listdir(cfg.routes_dir))
    except OSError:
        return routes, [{"file": "*", "reason": "routes_dir_unreadable"}]
    for name in names:
        match = re.match(r"^([0-9]{3,9})\.json$", name)
        if not match:
            continue
        path = os.path.join(cfg.routes_dir, name)
        try:
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ROUTE_BYTES:
                raise ValueError("not_regular")
            with open(path, "rb") as handle:
                raw = json.loads(handle.read(MAX_ROUTE_BYTES + 1).decode("utf-8"))
            route = parse_route(cfg, raw, int(match.group(1)))
        except (OSError, ValueError) as error:
            reason = str(error) if isinstance(error, ValueError) and re.match(r"^[a-z_]{1,32}$", str(error)) else "unreadable"
            problems.append({"file": name, "reason": reason})
            continue
        if not binding_matches(cfg, route["vmid"], route["binding_tag"]):
            problems.append({"file": name, "reason": "binding_mismatch"})
            continue
        routes[route["vmid"]] = route
    by_host = collections.defaultdict(list)
    for route in routes.values():
        by_host[route["hostname"]].append(route["vmid"])
    for hostname, vmids in by_host.items():
        if len(vmids) > 1:
            for vmid in vmids:
                routes.pop(vmid, None)
                problems.append({"file": "%d.json" % vmid, "reason": "duplicate_hostname"})
    return routes, problems


def public_routes(routes):
    """The half of the routes the forwarder may see: no keys, no binding tags."""
    return {"version": 1, "routes": [
        {"vmid": r["vmid"], "hostname": r["hostname"], "guest_ip": r["guest_ip"], "guest_port": r["guest_port"],
         "generation": r["generation"]}
        for r in sorted(routes.values(), key=lambda item: item["vmid"])]}


def write_atomic(path, data, mode, gid=None):
    directory = os.path.dirname(path)
    tmp = os.path.join(directory, ".%s.%d.tmp" % (os.path.basename(path), os.getpid()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.chmod(tmp, mode)
        if gid is not None:
            os.chown(tmp, -1, gid)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- tickets

def ticket_mac(key_hex, vmid, exp, nonce):
    message = b"wake\x00" + str(vmid).encode("ascii") + b"\x00" + str(exp).encode("ascii") + b"\x00" + nonce.encode("ascii")
    return hmac.new(bytes.fromhex(key_hex), message, hashlib.sha256).hexdigest()


def mint_ticket(key_hex, vmid, exp, nonce):
    """v1.<exp>.<nonce>.<hmac>. The server mints the same thing; here for tests and for operators."""
    return "v1.%d.%s.%s" % (exp, nonce, ticket_mac(key_hex, vmid, exp, nonce))


def check_ticket(ticket, key_hex, vmid, now):
    """(ok, reason, nonce, exp). Reasons are fixed words; the ticket itself is never echoed."""
    if not isinstance(ticket, str) or len(ticket) > 256:
        return False, "malformed", None, None
    parts = ticket.split(".")
    if len(parts) != 4 or parts[0] != "v1" or not EXP_RE.match(parts[1]) or not NONCE_RE.match(parts[2]) \
            or not MAC_RE.match(parts[3]):
        return False, "malformed", None, None
    exp, nonce = int(parts[1]), parts[2]
    if not hmac.compare_digest(ticket_mac(key_hex, vmid, exp, nonce), parts[3]):
        return False, "bad_mac", None, None
    if exp < now:
        return False, "expired", None, None
    if exp > now + TICKET_MAX_AHEAD:
        return False, "too_far", None, None
    return True, "ok", nonce, exp


class ReplaySet(object):
    """Nonces seen in the last REPLAY_WINDOW seconds (at least until the ticket expires), bounded."""

    def __init__(self, limit=REPLAY_MAX):
        self.limit = limit
        self.seen = {}

    def claim(self, vmid, nonce, exp, now):
        if len(self.seen) >= self.limit:
            for key in [key for key, until in self.seen.items() if until < now]:
                del self.seen[key]
        key = (vmid, nonce)
        until = self.seen.get(key)
        if until is not None and until >= now:
            return "replayed"
        if len(self.seen) >= self.limit:
            return "replay_full"
        self.seen[key] = max(exp, now + REPLAY_WINDOW)
        return "ok"


# ---------------------------------------------------------------- calls to Hivra (blocking; run in threads)

def load_credential(cfg):
    """The host credential document, or None when there is none or it is not exactly what the install step writes."""
    try:
        info = os.lstat(cfg.credential_path)
        if not stat.S_ISREG(info.st_mode) or info.st_size > CREDENTIAL_MAX_BYTES:
            return None
        with open(cfg.credential_path, "rb") as handle:
            doc = json.loads(handle.read(CREDENTIAL_MAX_BYTES + 1).decode("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or sorted(doc) != ["credential", "generation", "host_id", "origin", "version"]:
        return None
    generation = doc.get("generation")
    origin = doc.get("origin")
    if doc.get("version") != 1 or not isinstance(doc.get("host_id"), str) or not HOST_ID_RE.match(doc["host_id"]) \
            or isinstance(generation, bool) or not isinstance(generation, int) or not 1 <= generation <= 1000000000 \
            or not isinstance(doc.get("credential"), str) or not HEX_64_RE.match(doc["credential"]) \
            or not isinstance(origin, str) \
            or not (ORIGIN_RE.match(origin) or (cfg.allow_test_origin and TEST_ORIGIN_RE.match(origin))):
        return None
    return doc


def sign_request(credential, path, body, timestamp, nonce):
    """The signature Hivra checks (src/lib/hivra/ingress/host-credential.ts, signHostRequest)."""
    message = "\n".join(("hivra-ingress-host-request-v1", path, credential["host_id"], str(credential["generation"]),
                          str(timestamp), nonce, hashlib.sha256(body).hexdigest()))
    return hmac.new(bytes.fromhex(credential["credential"]), message.encode("utf-8"), hashlib.sha256).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A signed call goes to exactly one place: a redirect is an error, never followed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signed_call(cfg, path, payload):
    """The finished, signed request for one call to Hivra, or None without a credential. Runs in the helper."""
    credential = load_credential(cfg)
    if credential is None:
        return None
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    timestamp = int(time.time())
    nonce = base64.urlsafe_b64encode(os.urandom(18)).decode("ascii").rstrip("=")
    return {"url": credential["origin"] + path, "body": body, "headers": {
        "X-Hivra-Host": credential["host_id"],
        "X-Hivra-Generation": str(credential["generation"]),
        "X-Hivra-Timestamp": str(timestamp),
        "X-Hivra-Nonce": nonce,
        "X-Hivra-Signature": sign_request(credential, path, body.encode("utf-8"), timestamp, nonce),
    }}


SIGNED_HEADERS = frozenset(("X-Hivra-Host", "X-Hivra-Generation", "X-Hivra-Timestamp", "X-Hivra-Nonce", "X-Hivra-Signature"))


def call_target_ok(cfg, url):
    """Only Hivra's two host paths, on an https origin (a loopback http one in tests)."""
    for path in HIVRA_PATHS:
        if isinstance(url, str) and url.endswith(path):
            origin = url[:-len(path)]
            return bool(ORIGIN_RE.match(origin) or (cfg.allow_test_origin and TEST_ORIGIN_RE.match(origin)))
    return False


def post_json(url, headers, body):
    """One POST, no proxy, no redirect. {"ok", "status", "answer"} or {"ok": False, "error"}. Runs in the forwarder; never logs."""
    request = urllib.request.Request(url, data=body.encode("utf-8"), method="POST",
                                     headers=dict(headers, **{"Content-Type": "application/json", "User-Agent": VERSION}))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=HIVRA_CALL_TIMEOUT) as response:
            status, raw = response.status, response.read(HIVRA_ANSWER_MAX)
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            raw = error.read(HIVRA_ANSWER_MAX)
        except (OSError, ValueError):
            raw = b""
        finally:
            error.close()
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        return {"ok": False, "error": "unreachable"}
    try:
        answer = json.loads(raw.decode("utf-8")) if raw else {}
    except ValueError:
        answer = {}
    if not isinstance(answer, dict):
        answer = {}
    return {"ok": 200 <= status < 300 and answer.get("ok") is True, "status": status, "answer": answer}


# ---------------------------------------------------------------- QMP and the guest agent (blocking; run in threads)

class Fail(Exception):
    def __init__(self, reason):
        Exception.__init__(self, reason)
        self.reason = reason


class Chan(object):
    """Line reader on a raw socket. Every wait is bounded by an absolute deadline."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def send(self, obj, deadline):
        try:
            self.sock.settimeout(max(0.05, deadline - mono()))
            self.sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))
        except socket.timeout:
            raise Fail("timeout")
        except OSError:
            raise Fail("socket_error")

    def line(self, deadline):
        while b"\n" not in self.buf:
            left = deadline - mono()
            if left <= 0:
                raise Fail("timeout")
            try:
                self.sock.settimeout(left)
                chunk = self.sock.recv(65536)
            except socket.timeout:
                raise Fail("timeout")
            except OSError:
                raise Fail("socket_error")
            if not chunk:
                raise Fail("eof")
            self.buf += chunk
            if len(self.buf) > MAX_QMP_LINE:
                raise Fail("too_large")
        line, _, self.buf = self.buf.partition(b"\n")
        return line


def unix_connect(path, deadline, retry):
    while True:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(max(0.05, min(2.0, deadline - mono())))
            sock.connect(path)
            return sock
        except OSError as error:
            sock.close()
            if error.errno in (errno.ENOENT, errno.ENOTDIR):
                raise Fail("socket_missing")
            transient = error.errno in (errno.ECONNREFUSED, errno.EAGAIN, errno.ECONNRESET, errno.EINTR) \
                or isinstance(error, socket.timeout)
            if not (retry and transient) or mono() + RETRY_DELAY >= deadline:
                raise Fail("socket_error")
        time.sleep(RETRY_DELAY)


def loads_object(raw):
    try:
        value = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise Fail("protocol")
    if not isinstance(value, dict):
        raise Fail("protocol")
    return value


def qmp_run(chan, command, deadline, seq):
    want = "hivra-%d" % seq
    chan.send({"execute": command, "id": want}, deadline)
    while True:
        message = loads_object(chan.line(deadline))
        if "event" in message:
            continue
        if "return" in message or "error" in message:
            if "id" in message and message["id"] != want:
                continue
            if "error" in message:
                raise Fail("qmp_error")
            return message["return"]
        raise Fail("protocol")


def qmp(cfg, vmid, action):
    """One short QMP session: greeting, capabilities, the command, query-status. Returns the status after."""
    deadline = mono() + QMP_TIMEOUT
    sock = unix_connect(os.path.join(cfg.qemu_dir, "%d.qmp" % vmid), deadline, retry=True)
    try:
        chan = Chan(sock)
        if "QMP" not in loads_object(chan.line(deadline)):
            raise Fail("protocol")
        qmp_run(chan, "qmp_capabilities", deadline, 0)
        if action != "status":
            qmp_run(chan, action, deadline, 1)
        ret = qmp_run(chan, "query-status", deadline, 2)
    finally:
        sock.close()
    status = ret.get("status") if isinstance(ret, dict) else None
    if not isinstance(status, str) or not re.match(r"^[a-z_-]{1,24}$", status):
        raise Fail("protocol")
    return status


def read_pid(path):
    try:
        with open(path, "rb") as handle:
            raw = handle.read(64)
    except FileNotFoundError:
        return None
    except OSError:
        return -1
    match = PID_RE.match(raw)
    return int(match.group(1)) if match else -1


def marker_state(cfg, vmid):
    """none, valid (it holds the running QEMU's pid) or stale (anything else)."""
    marked = read_pid(cfg.marker_path(vmid))
    if marked is None:
        return "none"
    if marked <= 0:
        return "stale"
    running = read_pid(os.path.join(cfg.qemu_dir, "%d.pid" % vmid))
    if running is None or running != marked or not os.path.isdir(os.path.join(cfg.proc_dir, str(marked))):
        return "stale"
    return "valid"


def remove_marker(cfg, vmid):
    try:
        os.unlink(cfg.marker_path(vmid))
    except FileNotFoundError:
        pass


def take_flock(path, wait):
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return None
    end = mono() + wait
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError:
            if mono() >= end:
                os.close(fd)
                return None
            time.sleep(0.02)


def release_flock(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def wake_vm(cfg, vmid, binding_tag):
    """Resume a napped VM under the sleep scripts' per-VM lock. Never resumes a VM without a valid marker."""
    t0 = mono()
    result = {"ok": False, "vmid": vmid, "woke": None, "reason": "internal_error", "cont_ms": 0, "lock_ms": 0}
    fd = take_flock(os.path.join(cfg.lock_dir, "hivra-vm-%d.lock" % vmid), cfg.vm_lock_wait)
    result["lock_ms"] = int((mono() - t0) * 1000)
    if fd is None:
        result["reason"] = "vm_busy"
        return result
    try:
        if not binding_matches(cfg, vmid, binding_tag):
            result["reason"] = "binding_mismatch"
            return result
        marker = marker_state(cfg, vmid)
        if marker == "stale":
            remove_marker(cfg, vmid)
            log("marker_stale", vmid=vmid)
        try:
            status = qmp(cfg, vmid, "status")
        except Fail as error:
            result["reason"] = "qmp_" + error.reason
            return result
        if status == "running":
            if marker == "valid":
                remove_marker(cfg, vmid)
            result.update(ok=True, woke="already", reason="ok")
            return result
        if status != "paused":
            result["reason"] = "unexpected_state"
            return result
        if marker != "valid":
            result["reason"] = "not_napped"
            return result
        t1 = mono()
        try:
            status = qmp(cfg, vmid, "cont")
        except Fail as error:
            result["reason"] = "qmp_" + error.reason
            return result
        result["cont_ms"] = int((mono() - t1) * 1000)
        if status != "running":
            result["reason"] = "unconfirmed"
            return result
        remove_marker(cfg, vmid)
        result.update(ok=True, woke="nap", reason="ok")
        return result
    finally:
        release_flock(fd)


def qga_sync(chan, deadline):
    sid = random.randint(1, 2 ** 31 - 1)
    chan.send({"execute": "guest-sync-delimited", "arguments": {"id": sid}}, deadline)
    while True:
        raw = chan.line(deadline).lstrip(b"\xff").strip()
        if not raw:
            continue
        try:
            message = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            continue
        if isinstance(message, dict) and message.get("return") == sid:
            return


def qga_call(chan, payload, deadline):
    chan.send(payload, deadline)
    while True:
        raw = chan.line(deadline).lstrip(b"\xff").strip()
        if not raw:
            continue
        message = loads_object(raw)
        if "error" in message:
            raise Fail("guest_error")
        if "return" in message:
            return message["return"]
        raise Fail("protocol")


def host_epoch():
    sec, nsec = divmod(time.time_ns(), 10 ** 9)
    return "%d.%09d" % (sec, nsec)


def fixup_vm(cfg, vmid):
    """Set the guest clock and drop its stale :443 connections, under the guest agent lock. Never restarts a tunnel."""
    t0 = mono()
    fd = take_flock(os.path.join(cfg.lock_dir, "hivra-qga-%d.lock" % vmid), QGA_LOCK_WAIT)
    if fd is None:
        return {"ok": False, "reason": "qga_lock_busy", "ms": int((mono() - t0) * 1000)}
    try:
        deadline = mono() + FIXUP_AGENT_WAIT
        reason = "agent_timeout"
        while mono() < deadline:
            try:
                sock = unix_connect(os.path.join(cfg.qemu_dir, "%d.qga" % vmid), deadline, retry=False)
            except Fail as error:
                reason = error.reason
                time.sleep(0.15)
                continue
            try:
                chan = Chan(sock)
                qga_sync(chan, min(deadline, mono() + FIXUP_SYNC_TIMEOUT))
                command = FIXUP_TEMPLATE % host_epoch()
                pid = qga_call(chan, {"execute": "guest-exec", "arguments": {
                    "path": "/bin/sh", "arg": ["-c", command], "capture-output": False}}, mono() + FIXUP_CALL_TIMEOUT)
                if not isinstance(pid, dict) or not isinstance(pid.get("pid"), int):
                    raise Fail("protocol")
                exec_deadline = mono() + FIXUP_EXEC_TIMEOUT
                while True:
                    state = qga_call(chan, {"execute": "guest-exec-status", "arguments": {"pid": pid["pid"]}},
                                     min(exec_deadline, mono() + FIXUP_CALL_TIMEOUT))
                    if isinstance(state, dict) and state.get("exited"):
                        code = state.get("exitcode")
                        return {"ok": code == 0, "reason": "ok" if code == 0 else "exit_nonzero",
                                "ms": int((mono() - t0) * 1000)}
                    if mono() >= exec_deadline:
                        return {"ok": False, "reason": "exec_timeout", "ms": int((mono() - t0) * 1000)}
                    time.sleep(0.03)
            except Fail as error:
                reason = error.reason
                if reason not in ("timeout", "eof", "socket_error"):
                    return {"ok": False, "reason": reason, "ms": int((mono() - t0) * 1000)}
                time.sleep(0.15)
            finally:
                sock.close()
        return {"ok": False, "reason": reason, "ms": int((mono() - t0) * 1000)}
    finally:
        release_flock(fd)


# ---------------------------------------------------------------- shared async helpers

def peer_uid(writer):
    sock = writer.get_extra_info("socket")
    if sock is None:
        return None
    try:
        raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        return struct.unpack("3i", raw)[1]
    except (OSError, AttributeError, struct.error):
        return None


async def unix_request(path, request, timeout):
    """One JSON line to a unix socket and its one-line answer, or None when the other side cannot be reached."""
    writer = None
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path, limit=CTL_MAX_LINE * 4), timeout)
        writer.write((json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8"))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout)
        answer = json.loads(line.decode("utf-8"))
        return answer if isinstance(answer, dict) else None
    except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        return None
    finally:
        if writer is not None:
            writer.close()


async def serve_json_line(reader, writer, dispatch):
    try:
        try:
            line = await asyncio.wait_for(reader.readline(), CTL_TIMEOUT)
            request = json.loads(line.decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("not an object")
        except (ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError):
            answer = {"ok": False, "error": "bad_request"}
        else:
            answer = await dispatch(request)
        writer.write((json.dumps(answer, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8"))
        await writer.drain()
    except (OSError, ConnectionError):
        pass
    finally:
        writer.close()


async def bind_unix(path, handler, mode, gid=None):
    try:
        if stat.S_ISSOCK(os.lstat(path).st_mode):
            os.unlink(path)
    except FileNotFoundError:
        pass
    server = await asyncio.start_unix_server(handler, path=path, limit=CTL_MAX_LINE)
    os.chmod(path, mode)
    if gid is not None:
        os.chown(path, -1, gid)
    return server


class Notifier(object):
    """sd_notify over $NOTIFY_SOCKET (READY=1, WATCHDOG=1). Silent when systemd did not ask."""

    def __init__(self):
        self.address = os.environ.get("NOTIFY_SOCKET") or None
        if self.address and self.address.startswith("@"):
            self.address = "\x00" + self.address[1:]

    def send(self, message):
        if not self.address:
            return
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sock.connect(self.address)
            sock.sendall(message.encode("ascii"))
        except OSError:
            pass
        finally:
            sock.close()


# ---------------------------------------------------------------- the root helper

class Helper(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.routes = {}
        self.replay = ReplaySet()
        self.wakes = collections.defaultdict(lambda: collections.deque(maxlen=WAKES_KEPT))
        self.last_authed = {}
        self.pending = {}
        self.background = set()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="hivra-wake-helper")
        self.requests = {}
        self.request_last = {}
        self.server = None

    def role(self, uid):
        if uid is None:
            return None
        if uid in self.cfg.root_uids:
            return "root"
        forwarder = self.cfg.resolved_forwarder_uid()
        if forwarder is not None and uid == forwarder:
            return "forwarder"
        doorbell = self.cfg.resolved_doorbell_uid()
        if doorbell is not None and uid == doorbell:
            return "doorbell"
        return None

    async def start(self):
        await self.reload()
        gid = self.cfg.resolved_forwarder_gid() if os.geteuid() == 0 else None
        self.server = await bind_unix(self.cfg.ctl_path, self.handle, 0o660, gid)
        log("helper_ready", version=VERSION, routes=len(self.routes))

    async def stop(self):
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        for task in list(self.background):
            task.cancel()
        self.pool.shutdown(wait=False, cancel_futures=True)

    async def reload(self):
        loop = asyncio.get_running_loop()
        routes, problems = await loop.run_in_executor(self.pool, load_routes, self.cfg)
        self.routes = routes
        for problem in problems:
            log("route_dropped", **problem)
        gid = self.cfg.resolved_forwarder_gid() if os.geteuid() == 0 else None
        data = (json.dumps(public_routes(routes), separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        try:
            await loop.run_in_executor(self.pool, write_atomic, self.cfg.public_routes_path, data, 0o640, gid)
        except OSError:
            log("routes_publish_failed")
        forwarder = await unix_request(self.cfg.fwd_path, {"cmd": "reload"}, CTL_TIMEOUT)
        return {"ok": True, "routes": len(routes), "dropped": len(problems), "forwarder": bool(forwarder and forwarder.get("ok"))}

    async def handle(self, reader, writer):
        role = self.role(peer_uid(writer))
        if role is None:
            log("ctl_refused")
            try:
                writer.write(b'{"error":"forbidden","ok":false}\n')
                await writer.drain()
            except (OSError, ConnectionError):
                pass
            writer.close()
            return

        async def dispatch(request):
            return await self.dispatch(role, request)

        await serve_json_line(reader, writer, dispatch)

    async def dispatch(self, role, request):
        command = request.get("cmd")
        allowed = ROOT_COMMANDS if role == "root" else DOORBELL_COMMANDS if role == "doorbell" else FORWARDER_COMMANDS
        if command not in allowed:
            return {"ok": False, "error": "forbidden" if command in ROOT_COMMANDS else "unknown_command"}
        try:
            if command == "health":
                forwarder = await unix_request(self.cfg.fwd_path, {"cmd": "health"}, CTL_TIMEOUT)
                credential = await asyncio.get_running_loop().run_in_executor(self.pool, load_credential, self.cfg)
                return {"ok": True, "version": VERSION, "routes": len(self.routes),
                        "forwarder": bool(forwarder and forwarder.get("ok")), "credential": credential is not None}
            if command == "reload":
                return await self.reload()
            if command == "stats" and request.get("vmid") is None:
                return await self.stats(None)
            vmid = parse_vmid(request.get("vmid"))
            if vmid is None:
                return {"ok": False, "error": "bad_vmid"}
            if command == "wake":
                return await self.wake(role, vmid, request)
            if command == "status":
                state = await asyncio.get_running_loop().run_in_executor(self.pool, marker_state, self.cfg, vmid)
                return {"ok": True, "vmid": vmid, "napped": state == "valid", "route": vmid in self.routes}
            if command == "stats":
                return await self.stats(vmid)
            if command == "request":
                return await self.request(role, vmid, request)
            if command == "drain":
                ms = request.get("ms", 2000)
                if isinstance(ms, bool) or not isinstance(ms, int) or not 0 <= ms <= DRAIN_MAX_MS:
                    return {"ok": False, "error": "bad_ms"}
                answer = await unix_request(self.cfg.fwd_path, {"cmd": "drain", "vmid": vmid, "ms": ms},
                                            CTL_TIMEOUT + ms / 1000.0)
                return answer if answer is not None else {"ok": False, "error": "forwarder_down"}
            # undrain, napped
            answer = await unix_request(self.cfg.fwd_path, {"cmd": command, "vmid": vmid}, CTL_TIMEOUT)
            return answer if answer is not None else {"ok": False, "error": "forwarder_down"}
        except Exception as error:  # a command must always get an answer
            log("ctl_error", cmd=command, kind=type(error).__name__)
            return {"ok": False, "error": "internal_error"}

    async def stats(self, vmid):
        forwarder = await unix_request(self.cfg.fwd_path, {"cmd": "stats", "vmid": vmid}, CTL_TIMEOUT) or {}
        traffic = forwarder.get("vms") if isinstance(forwarder.get("vms"), dict) else {}
        vmids = [vmid] if vmid is not None else sorted(set(self.routes) | set(self.wakes))
        vms = {}
        for item in vmids:
            seen = traffic.get(str(item)) if isinstance(traffic.get(str(item)), dict) else {}
            vms[str(item)] = {
                "route": item in self.routes,
                "inflight": seen.get("inflight", 0),
                "streams": seen.get("streams", 0),
                "draining": bool(seen.get("draining", False)),
                "last_any_at": seen.get("last_any_at"),
                "last_authed_at": self.last_authed.get(item),
                "wakes": list(self.wakes.get(item, ())),
            }
        answer = {"ok": True, "forwarder": bool(forwarder.get("ok")), "vms": vms}
        if vmid is not None:
            answer.update(vmid=vmid, **vms[str(vmid)])
        return answer

    async def wake(self, role, vmid, request):
        route = self.routes.get(vmid)
        if route is None:
            return {"ok": False, "vmid": vmid, "error": "unknown_vmid"}
        ticket = request.get("ticket")
        if role == "forwarder" or ticket is not None:
            now = int(time.time())
            ok, reason, nonce, exp = check_ticket(ticket, route["ticket_key"], vmid, now)
            if ok:
                reason = self.replay.claim(vmid, nonce, exp, now)
                ok = reason == "ok"
            if not ok:
                log("ticket_refused", vmid=vmid, reason=reason)
                return {"ok": False, "vmid": vmid, "error": "ticket_" + reason}
            self.last_authed[vmid] = round(time.time(), 3)
            source = "ticket"
        else:
            source = request.get("from") if isinstance(request.get("from"), str) and re.match(r"^[a-z_]{1,16}$", request.get("from")) else "ctl"
        task = self.pending.get(vmid)
        if task is None:
            task = asyncio.get_running_loop().create_task(self.run_wake(vmid, route, source))
            self.pending[vmid] = task
            task.add_done_callback(lambda _task, key=vmid: self.pending.pop(key, None))
        result = dict(await asyncio.shield(task))
        if source == "ticket" and not result.get("ok") and result.get("reason") == "qmp_socket_missing":
            # A signed wake for a VM that is not running at all (hibernated): only Hivra can start it.
            asked = await self.request_wake(vmid, "ticket")
            if asked.get("ok"):
                return {"ok": False, "vmid": vmid, "error": "waking", "requested": True, "state": asked.get("state")}
        return result

    async def run_wake(self, vmid, route, source):
        loop = asyncio.get_running_loop()
        t0 = mono()
        result = await loop.run_in_executor(self.pool, wake_vm, self.cfg, vmid, route["binding_tag"])
        result["ms"] = int((mono() - t0) * 1000)
        if result["ok"]:
            entry = {"at": round(time.time(), 3), "from": source, "woke": result["woke"], "ms": result["ms"]}
            self.wakes[vmid].append(entry)
            if result["woke"] == "nap":
                self.spawn(self.report_wake(vmid, entry))
        else:
            result["error"] = result["reason"]
        log("wake", vmid=vmid, source=source, ok=result["ok"], woke=result["woke"], reason=result["reason"],
            ms=result["ms"], cont_ms=result["cont_ms"], lock_ms=result["lock_ms"])
        if result["ok"] and result["woke"] == "nap" and self.cfg.fixup:
            self.spawn(self.run_fixup(vmid))
        return result

    async def call(self, path, payload):
        """Sign one call here, have the forwarder send it. {"ok", "status", "answer"} or {"ok": False, "error"}."""
        signed = await asyncio.get_running_loop().run_in_executor(self.pool, signed_call, self.cfg, path, payload)
        if signed is None:
            return {"ok": False, "error": "no_credential"}
        answer = await unix_request(self.cfg.fwd_path, dict(signed, cmd="post"), HIVRA_CALL_TIMEOUT + 2.0)
        return answer if answer is not None else {"ok": False, "error": "forwarder_down"}

    async def request(self, role, vmid, request):
        """`request`: ask Hivra to wake a VM. The forwarder may ask only for its own routes, as a client wake."""
        reason = request.get("from")
        if role == "forwarder":
            if vmid not in self.routes:
                return {"ok": False, "vmid": vmid, "error": "unknown_vmid"}
            reason = "client"
        elif role == "doorbell":
            reason = "doorbell"
        elif not (isinstance(reason, str) and reason in REQUEST_REASONS):
            reason = "ctl"
        return await self.request_wake(vmid, reason)

    async def request_wake(self, vmid, reason):
        """wake-request to Hivra, at most one in flight per VM and one per REQUEST_MIN_INTERVAL; a repeat gets the last answer."""
        last = self.request_last.get(vmid)
        if last is not None and mono() - last[0] < REQUEST_MIN_INTERVAL:
            return dict(last[1], throttled=True)
        task = self.requests.get(vmid)
        if task is None:
            task = asyncio.get_running_loop().create_task(self.run_request(vmid, reason))
            self.requests[vmid] = task
            task.add_done_callback(lambda _task, key=vmid: self.requests.pop(key, None))
        return dict(await asyncio.shield(task))

    async def run_request(self, vmid, reason):
        t0 = mono()
        try:
            outcome = await self.call(WAKE_REQUEST_PATH, {"vmid": vmid, "reason": reason})
        except Exception as error:
            outcome = {"ok": False, "error": type(error).__name__}
        answer = outcome.get("answer") if isinstance(outcome.get("answer"), dict) else {}
        state = answer.get("state") if isinstance(answer.get("state"), str) and re.match(r"^[a-z_]{1,24}$", answer.get("state")) else None
        result = {"ok": bool(outcome.get("ok")), "vmid": vmid, "state": state}
        if not result["ok"]:
            error = outcome.get("error") or answer.get("error") or "status_%s" % outcome.get("status")
            result["error"] = error if isinstance(error, str) and re.match(r"^[a-z0-9_]{1,32}$", error) else "refused"
        log("wake_request", vmid=vmid, reason=reason, ok=result["ok"], state=state, status=outcome.get("status"),
            error=result.get("error"), ms=int((mono() - t0) * 1000))
        # A host with no credential asks again at once once it has one; anything else is held for the interval.
        if result.get("error") != "no_credential":
            self.request_last[vmid] = (mono(), result)
        return result

    async def report_wake(self, vmid, entry):
        """wake-report to Hivra after a nap was resumed here. Retried on a network error or a 5xx; silent without a credential."""
        payload = {"vmid": vmid, "woke": entry["woke"], "at": entry["at"], "from": entry["from"]}
        outcome = {}
        for attempt in range(REPORT_ATTEMPTS):
            try:
                outcome = await self.call(WAKE_REPORT_PATH, payload)
            except Exception as error:
                outcome = {"ok": False, "error": type(error).__name__}
            if outcome.get("ok") or outcome.get("error") == "no_credential":
                break
            status = outcome.get("status")
            if isinstance(status, int) and 400 <= status < 500:
                break
            if attempt + 1 < REPORT_ATTEMPTS:
                await asyncio.sleep(REPORT_BACKOFF[min(attempt, len(REPORT_BACKOFF) - 1)])
        if outcome.get("error") != "no_credential":
            answer = outcome.get("answer") if isinstance(outcome.get("answer"), dict) else {}
            action = answer.get("action") if isinstance(answer.get("action"), str) and re.match(r"^[a-z_]{1,24}$", answer.get("action")) else None
            log("wake_report", vmid=vmid, ok=bool(outcome.get("ok")), status=outcome.get("status"), action=action,
                attempts=attempt + 1)
        return outcome

    def spawn(self, coro):
        task = asyncio.get_running_loop().create_task(coro)
        self.background.add(task)
        task.add_done_callback(self.background.discard)
        return task

    async def run_fixup(self, vmid):
        try:
            outcome = await asyncio.get_running_loop().run_in_executor(self.pool, fixup_vm, self.cfg, vmid)
        except Exception as error:
            outcome = {"ok": False, "reason": type(error).__name__}
        log("fixup", vmid=vmid, ok=outcome.get("ok"), reason=outcome.get("reason"), ms=outcome.get("ms"))


# ---------------------------------------------------------------- the unprivileged forwarder

class Request(object):
    __slots__ = ("method", "target", "version", "lines", "headers")

    def header(self, name):
        values = [value for key, value in self.headers if key == name]
        return values

    def connection_tokens(self):
        tokens = set()
        for value in self.header("connection"):
            tokens.update(part.strip().lower() for part in value.split(","))
        return tokens

    @property
    def is_upgrade(self):
        return bool(self.header("upgrade")) and "upgrade" in self.connection_tokens()


def parse_request_head(head):
    """The request line and headers, or None when the head is malformed."""
    if b"\x00" in head:
        return None
    try:
        text = head.decode("latin-1")
    except UnicodeDecodeError:
        return None
    lines = text[:-4].split("\r\n") if text.endswith("\r\n\r\n") else None
    if not lines:
        return None
    parts = lines[0].split(" ")
    if len(parts) != 3 or not HTTP_TCHAR_RE.match(parts[0]) or parts[2] not in ("HTTP/1.1", "HTTP/1.0"):
        return None
    if not (parts[1].startswith("/") or (parts[1] == "*" and parts[0] == "OPTIONS")):
        return None
    request = Request()
    request.method, request.target, request.version = parts
    request.lines, request.headers = [], []
    for line in lines[1:]:
        if not line or line[0] in " \t" or ":" not in line or "\r" in line or "\n" in line:
            return None
        name, _, value = line.partition(":")
        if not HTTP_TCHAR_RE.match(name):
            return None
        request.lines.append((name.lower(), line))
        request.headers.append((name.lower(), value.strip()))
    return request


def request_host(request):
    hosts = request.header("host")
    if len(hosts) != 1:
        return None
    host = hosts[0].strip().lower()
    if host.startswith("["):
        return None
    host = host.rsplit(":", 1)[0] if ":" in host else host
    host = host.rstrip(".")
    return host if HOSTNAME_RE.match(host) else None


def internal_path(target):
    path = target.split("?", 1)[0].split("#", 1)[0]
    decoded = unquote(path).lower()
    return decoded, decoded == "/__hivra" or decoded.startswith("/__hivra/")


def rebuild_head(request):
    """The head as sent to the guest: X-Hivra-Wake removed, Connection: close unless it is an upgrade."""
    upgrade = request.is_upgrade
    drop = {"x-hivra-wake"}
    if not upgrade:
        drop.update(("connection", "keep-alive", "proxy-connection"))
    lines = ["%s %s %s" % (request.method, request.target, request.version)]
    lines.extend(line for name, line in request.lines if name not in drop)
    if not upgrade:
        lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")


def parse_response_head(head):
    """(status, content type) of a response head, or (None, '') when it cannot be read."""
    try:
        text = head.decode("latin-1")
        lines = text.split("\r\n")
        parts = lines[0].split(" ", 2)
        status = int(parts[1]) if len(parts) >= 2 and parts[0].startswith("HTTP/1.") and parts[1].isdigit() else None
    except (ValueError, IndexError):
        return None, ""
    ctype = ""
    for line in lines[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "content-type":
            ctype = value.strip().lower()
    return status, ctype


REASONS = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
           408: "Request Timeout", 429: "Too Many Requests", 431: "Request Header Fields Too Large",
           503: "Service Unavailable", 504: "Gateway Timeout"}

ASLEEP_PAGE = (b"<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"5\">"
               b"<title>Waking up</title></head><body><p>This computer is asleep. It will be back in a moment.</p>"
               b"</body></html>\n")

WAKING_PAGE = (b"<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"5\">"
               b"<title>Waking up</title></head><body><p>This computer is waking up. This page will refresh in a moment.</p>"
               b"</body></html>\n")


class Forwarder(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.by_host = {}
        self.by_vmid = {}
        self.routes_key = None
        self.inflight = collections.Counter()
        self.streams = collections.Counter()
        self.draining = {}
        self.last_any = {}
        self.bad_tickets = collections.defaultdict(collections.deque)
        self.napped_cache = {}
        self.servers = []
        self.bound = []
        self.tasks = set()

    # routes -------------------------------------------------------------

    def refresh_routes(self, force=False):
        try:
            info = os.stat(self.cfg.public_routes_path)
            key = (info.st_ino, info.st_mtime_ns, info.st_size)
        except OSError:
            key = None
        if key == self.routes_key and not force:
            return
        by_host, by_vmid = {}, {}
        if key is not None:
            try:
                with open(self.cfg.public_routes_path, "rb") as handle:
                    doc = json.loads(handle.read(4 * 1024 * 1024).decode("utf-8"))
                for item in doc.get("routes", []) if isinstance(doc, dict) else []:
                    vmid = parse_vmid(item.get("vmid")) if isinstance(item, dict) else None
                    if vmid is None or not isinstance(item.get("hostname"), str) or not HOSTNAME_RE.match(item["hostname"]):
                        continue
                    if not isinstance(item.get("guest_ip"), str) or not guest_address_ok(self.cfg, item["guest_ip"]):
                        continue
                    port = item.get("guest_port")
                    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                        continue
                    route = {"vmid": vmid, "hostname": item["hostname"], "guest_ip": item["guest_ip"], "guest_port": port}
                    by_host[route["hostname"]] = route
                    by_vmid[vmid] = route
            except (OSError, ValueError, AttributeError):
                log("routes_unreadable")
                by_host, by_vmid = {}, {}
        self.by_host, self.by_vmid, self.routes_key = by_host, by_vmid, key
        log("routes_loaded", routes=len(by_vmid))

    async def poll_routes(self):
        while True:
            await asyncio.sleep(ROUTE_POLL_SECONDS)
            self.refresh_routes()

    # lifecycle ----------------------------------------------------------

    async def start(self):
        self.refresh_routes(force=True)
        for host, port in self.cfg.listen:
            family = socket.AF_INET6 if ":" in host else socket.AF_INET
            try:
                server = await asyncio.start_server(self.handle_client, host=host, port=port, family=family,
                                                    limit=MAX_HEAD, reuse_address=True)
            except OSError as error:
                log("listen_failed", host=host, port=port, errno=error.errno)
                continue
            self.servers.append(server)
            self.bound.append(server.sockets[0].getsockname()[:2])
        if not self.servers:
            raise RuntimeError("no listener could be bound")
        self.servers.append(await bind_unix(self.cfg.fwd_path, self.handle_ctl, 0o600))
        task = asyncio.get_running_loop().create_task(self.poll_routes())
        self.tasks.add(task)
        log("proxy_ready", version=VERSION, listeners=len(self.bound), routes=len(self.by_vmid))

    async def stop(self):
        for task in list(self.tasks):
            task.cancel()
        for server in self.servers:
            server.close()
        for server in self.servers:
            await server.wait_closed()
        self.servers = []
        for vmid in list(self.draining):
            self.undrain(vmid)

    # control socket (root only) ----------------------------------------

    async def handle_ctl(self, reader, writer):
        uid = peer_uid(writer)
        if uid is None or uid not in self.cfg.root_uids:
            log("fwd_ctl_refused")
            writer.close()
            return
        await serve_json_line(reader, writer, self.dispatch_ctl)

    async def dispatch_ctl(self, request):
        command = request.get("cmd")
        if command not in FWD_COMMANDS:
            return {"ok": False, "error": "unknown_command"}
        if command == "health":
            return {"ok": True, "version": VERSION, "routes": len(self.by_vmid), "listeners": len(self.bound)}
        if command == "post":
            return await self.post(request)
        if command == "reload":
            self.refresh_routes(force=True)
            self.napped_cache.clear()
            return {"ok": True, "routes": len(self.by_vmid)}
        if command == "stats":
            vmid = parse_vmid(request.get("vmid")) if request.get("vmid") is not None else None
            vmids = [vmid] if vmid is not None else sorted(set(self.by_vmid) | set(self.last_any) | set(self.inflight))
            return {"ok": True, "vms": {str(item): {
                "inflight": self.inflight.get(item, 0), "streams": self.streams.get(item, 0),
                "draining": item in self.draining, "last_any_at": self.last_any.get(item)} for item in vmids}}
        vmid = parse_vmid(request.get("vmid"))
        if vmid is None:
            return {"ok": False, "error": "bad_vmid"}
        if command == "drain":
            ms = request.get("ms", 2000)
            if isinstance(ms, bool) or not isinstance(ms, int) or not 0 <= ms <= DRAIN_MAX_MS:
                return {"ok": False, "error": "bad_ms"}
            return await self.drain(vmid, ms)
        self.undrain(vmid)
        self.napped_cache.pop(vmid, None)
        log(command, vmid=vmid)
        return {"ok": True, "vmid": vmid}

    async def post(self, request):
        """Send one call the helper signed. Only to Hivra's host paths, only the signed headers; never logged."""
        url, headers, body = request.get("url"), request.get("headers"), request.get("body")
        if not call_target_ok(self.cfg, url) or not isinstance(body, str) or len(body) > CREDENTIAL_MAX_BYTES \
                or not isinstance(headers, dict) or set(headers) != SIGNED_HEADERS \
                or not all(isinstance(value, str) and len(value) <= 128 and "\r" not in value and "\n" not in value
                           for value in headers.values()):
            return {"ok": False, "error": "bad_call"}
        return await asyncio.get_running_loop().run_in_executor(None, post_json, url, headers, body)

    def undrain(self, vmid):
        handle = self.draining.pop(vmid, None)
        if handle is not None:
            handle.cancel()

    def lease_expired(self, vmid):
        if self.draining.pop(vmid, None) is not None:
            log("drain_expired", vmid=vmid)

    async def drain(self, vmid, ms):
        """Stop new requests for the VM and wait for in-flight ones. Open upgrades or SSE streams mean busy."""
        if self.streams[vmid] > 0:
            return {"ok": False, "vmid": vmid, "error": "busy", "streams": self.streams[vmid], "inflight": self.inflight[vmid]}
        self.undrain(vmid)
        self.draining[vmid] = asyncio.get_running_loop().call_later(self.cfg.drain_lease, self.lease_expired, vmid)
        deadline = mono() + ms / 1000.0
        while self.inflight[vmid] > 0:
            if self.streams[vmid] > 0 or mono() >= deadline or vmid not in self.draining:
                streams, inflight = self.streams[vmid], self.inflight[vmid]
                self.undrain(vmid)
                return {"ok": False, "vmid": vmid, "error": "busy", "streams": streams, "inflight": inflight}
            await asyncio.sleep(0.02)
        log("drained", vmid=vmid)
        return {"ok": True, "vmid": vmid, "inflight": 0, "streams": 0}

    # HTTP ---------------------------------------------------------------

    async def reply(self, writer, status, body, content_type="application/json", extra=()):
        if isinstance(body, dict):
            body = (json.dumps(body, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        head = ["HTTP/1.1 %d %s" % (status, REASONS.get(status, "Error")),
                "Content-Type: %s" % content_type, "Content-Length: %d" % len(body),
                "Cache-Control: no-store", "Connection: close"]
        head.extend(extra)
        try:
            writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)
            await writer.drain()
        except (OSError, ConnectionError):
            pass

    async def handle_client(self, reader, writer):
        try:
            await self.serve(reader, writer)
        except (OSError, ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as error:
            log("proxy_error", kind=type(error).__name__)
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def serve(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), self.cfg.head_timeout)
        except asyncio.TimeoutError:
            await self.reply(writer, 408, {"error": "header_timeout"})
            return
        except asyncio.LimitOverrunError:
            await self.reply(writer, 431, {"error": "header_too_large"})
            return
        except asyncio.IncompleteReadError:
            return
        if len(head) > MAX_HEAD:
            await self.reply(writer, 431, {"error": "header_too_large"})
            return
        request = parse_request_head(head)
        host = request_host(request) if request is not None else None
        if request is None or host is None:
            await self.reply(writer, 400, {"error": "bad_request"})
            return
        path, internal = internal_path(request.target)
        route = self.by_host.get(host)
        if internal:
            if path == "/__hivra/wake" and request.method == "POST" and route is not None:
                await self.ticket_wake(request, route, writer)
            elif path == "/__hivra/wake" and request.method != "POST":
                await self.reply(writer, 405, {"error": "method_not_allowed"}, extra=("Allow: POST",))
            elif path == "/__hivra/wake":
                await self.reply(writer, 503, {"error": "unknown_host"})
            else:
                await self.reply(writer, 404, {"error": "not_found"})
            return
        if route is None:
            await self.reply(writer, 503, {"error": "unknown_host"})
            return
        vmid = route["vmid"]
        self.last_any[vmid] = round(time.time(), 3)
        if vmid in self.draining or await self.is_napped(vmid):
            await self.asleep(request, writer)
            return
        await self.forward(request, route, reader, writer)

    async def asleep(self, request, writer):
        accept = ",".join(request.header("accept")).lower()
        extra = ("Retry-After: 5",)
        if "text/html" in accept:
            await self.reply(writer, 503, ASLEEP_PAGE, "text/html; charset=utf-8", extra)
        else:
            await self.reply(writer, 503, {"error": "asleep"}, extra=extra)

    async def waking(self, request, writer):
        """503 with Retry-After: 5. A browser gets a page that refreshes itself; an API call or a webhook gets JSON."""
        accept = ",".join(request.header("accept")).lower()
        extra = ("Retry-After: 5",)
        if "text/html" in accept:
            await self.reply(writer, 503, WAKING_PAGE, "text/html; charset=utf-8", extra)
        else:
            await self.reply(writer, 503, {"error": "unreachable"}, extra=extra)

    async def is_napped(self, vmid):
        """A marker exists and the helper says it is valid. Unknown (helper down) counts as napped: no request reaches a paused VM."""
        try:
            info = os.stat(self.cfg.marker_path(vmid))
        except FileNotFoundError:
            self.napped_cache.pop(vmid, None)
            return False
        except OSError:
            return True
        key = (info.st_ino, info.st_mtime_ns)
        cached = self.napped_cache.get(vmid)
        if cached is not None and cached[0] == key and mono() - cached[2] < NAPPED_CACHE_SECONDS:
            return cached[1]
        answer = await unix_request(self.cfg.ctl_path, {"cmd": "status", "vmid": vmid}, CTL_TIMEOUT)
        napped = True if answer is None or not answer.get("ok") else bool(answer.get("napped"))
        self.napped_cache[vmid] = (key, napped, mono())
        return napped

    def bad_ticket_limited(self, vmid):
        window = self.bad_tickets[vmid]
        now = mono()
        while window and now - window[0] > BAD_TICKET_WINDOW:
            window.popleft()
        return len(window) >= BAD_TICKET_LIMIT

    async def ticket_wake(self, request, route, writer):
        vmid = route["vmid"]
        if self.bad_ticket_limited(vmid):
            await self.reply(writer, 429, {"error": "rate_limited"}, extra=("Retry-After: 60",))
            return
        tickets = request.header("x-hivra-wake")
        if len(tickets) != 1:
            self.bad_tickets[vmid].append(mono())
            await self.reply(writer, 403, {"error": "forbidden"})
            return
        t0 = mono()
        answer = await unix_request(self.cfg.ctl_path, {"cmd": "wake", "vmid": vmid, "ticket": tickets[0]}, 15.0)
        if answer is None:
            await self.reply(writer, 503, {"error": "helper_down"}, extra=("Retry-After: 5",))
            return
        if not answer.get("ok"):
            error = answer.get("error") if isinstance(answer.get("error"), str) else "wake_failed"
            if error.startswith("ticket_"):
                self.bad_tickets[vmid].append(mono())
                await self.reply(writer, 403, {"error": "forbidden"})
            else:
                await self.reply(writer, 503, {"error": error, "vmid": vmid}, extra=("Retry-After: 5",))
            return
        self.napped_cache.pop(vmid, None)
        t1 = mono()
        healthy = await self.guest_healthy(route, self.cfg.health_deadline)
        receipt = {"vmid": vmid, "woke": answer.get("woke"), "cont_ms": answer.get("cont_ms", 0),
                   "guest_ms": int((mono() - t1) * 1000), "ms": int((mono() - t0) * 1000)}
        if healthy:
            await self.reply(writer, 200, receipt)
        else:
            receipt["error"] = "guest_unhealthy"
            await self.reply(writer, 504, receipt)

    async def guest_healthy(self, route, deadline_s):
        """GET guest:18080/healthz answers 200 ok, retried every 50 ms until the deadline."""
        deadline = mono() + deadline_s
        probe = ("GET /healthz HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n" % route["hostname"]).encode("latin-1")
        while True:
            writer = None
            try:
                left = max(0.05, deadline - mono())
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(route["guest_ip"], route["guest_port"]), min(0.5, left))
                writer.write(probe)
                await writer.drain()
                data = await asyncio.wait_for(reader.read(4096), min(1.0, max(0.05, deadline - mono())))
                head, _, body = data.partition(b"\r\n\r\n")
                status, _ = parse_response_head(head)
                if status == 200 and b"ok" in body:
                    return True
            except (OSError, asyncio.TimeoutError, ConnectionError):
                pass
            finally:
                if writer is not None:
                    writer.close()
            if mono() + HEALTH_INTERVAL >= deadline:
                return False
            await asyncio.sleep(HEALTH_INTERVAL)

    async def forward(self, request, route, reader, writer):
        vmid = route["vmid"]
        self.inflight[vmid] += 1
        streaming = False
        guest_writer = None
        tasks = []
        try:
            try:
                guest_reader, guest_writer = await asyncio.wait_for(
                    asyncio.open_connection(route["guest_ip"], route["guest_port"], limit=MAX_RESPONSE_HEAD),
                    GUEST_CONNECT_TIMEOUT)
            except (OSError, asyncio.TimeoutError):
                # A computer that is starting (a hibernated one being restored) is not up yet.
                await self.waking(request, writer)
                return
            guest_writer.write(rebuild_head(request))
            await guest_writer.drain()

            async def upstream():
                ok = await pump(reader, guest_writer)
                if ok:
                    try:
                        if guest_writer.can_write_eof():
                            guest_writer.write_eof()
                    except (OSError, RuntimeError):
                        pass
                return ok

            async def downstream():
                nonlocal streaming
                for _ in range(MAX_INTERIM_RESPONSES + 1):
                    head = await read_response_head(guest_reader)
                    if not head:
                        return
                    status, ctype = parse_response_head(head)
                    if status is not None and (status == 101 or ctype.startswith("text/event-stream")) and not streaming:
                        streaming = True
                        self.streams[vmid] += 1
                    writer.write(head)
                    await writer.drain()
                    if status is None or not (100 <= status < 200) or status == 101:
                        break
                await pump(guest_reader, writer)

            up = asyncio.ensure_future(upstream())
            down = asyncio.ensure_future(downstream())
            tasks = [up, down]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if up in done and not down.done():
                if up.exception() is None and up.result():
                    await asyncio.wait([down])
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            for task in tasks:
                try:
                    await task
                except BaseException:
                    pass
            if guest_writer is not None:
                guest_writer.close()
            if streaming:
                self.streams[vmid] -= 1
            self.inflight[vmid] -= 1


async def read_response_head(reader):
    """A response head (through the blank line). Anything unreadable comes back as raw bytes to pass through."""
    try:
        return await reader.readuntil(b"\r\n\r\n")
    except asyncio.IncompleteReadError as error:
        return error.partial
    except asyncio.LimitOverrunError:
        return await reader.read(MAX_RESPONSE_HEAD)


async def pump(reader, writer):
    """Copy until EOF. True on a clean EOF, False when either side failed."""
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                return True
            writer.write(data)
            await writer.drain()
    except (OSError, ConnectionError, asyncio.IncompleteReadError):
        return False


# ---------------------------------------------------------------- entry points

async def run_service(service):
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(signum, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    await service.start()
    notifier = Notifier()
    notifier.send("READY=1")

    async def watchdog():
        while True:
            notifier.send("WATCHDOG=1")
            await asyncio.sleep(WATCHDOG_SECONDS)

    beat = loop.create_task(watchdog())
    try:
        await stop.wait()
    finally:
        beat.cancel()
        notifier.send("STOPPING=1")
        await service.stop()


def ctl_main(argv, cfg=None):
    cfg = cfg or Config()
    if not argv or argv[0] not in ROOT_COMMANDS:
        sys.stderr.write("usage: hivra-wake-proxy.py ctl <%s> [vmid] [ms]\n" % "|".join(sorted(ROOT_COMMANDS)))
        return 2
    request = {"cmd": argv[0]}
    if len(argv) > 1:
        request["vmid"] = parse_vmid(argv[1])
        if request["vmid"] is None:
            sys.stderr.write("bad vmid\n")
            return 2
    if len(argv) > 2:
        if not re.match(r"^[0-9]{1,5}$", argv[2]):
            sys.stderr.write("bad ms\n")
            return 2
        request["ms"] = int(argv[2])
    timeout = CTL_TIMEOUT + request.get("ms", 0) / 1000.0 + (15.0 if argv[0] in ("wake", "request") else 0.0)
    answer = asyncio.run(unix_request(cfg.ctl_path, request, timeout))
    if answer is None:
        sys.stdout.write('{"error":"unreachable","ok":false}\n')
        return 2
    sys.stdout.write(json.dumps(answer, separators=(",", ":"), sort_keys=True) + "\n")
    return 0 if answer.get("ok") else 1


def main(argv):
    mode = argv[0] if argv else ""
    if mode == "helper":
        asyncio.run(run_service(Helper(Config())))
        return 0
    if mode == "proxy":
        asyncio.run(run_service(Forwarder(Config())))
        return 0
    if mode == "ctl":
        return ctl_main(argv[1:])
    sys.stderr.write("usage: hivra-wake-proxy.py helper|proxy|ctl <cmd> [vmid] [ms]\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
