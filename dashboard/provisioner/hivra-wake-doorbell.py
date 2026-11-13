#!/usr/bin/env python3
"""Hivra wake doorbell: watches a sleeping computer's mailbox or Discord bot from the host.

Python 3 standard library only. One file, three entry points:

  serve    Runs as its own unprivileged user (hivra-wake-doorbell.service).
           Listens on a unix socket (/run/hivra-doorbell/ctl.sock) that only
           root may use (SO_PEERCRED). Holds each armed computer's IMAP
           credentials in memory only, never on disk, and watches its INBOX
           read-only until it is disarmed.
  ctl      One JSON request read from stdin (never argv) to the doorbell;
           prints the JSON answer. Exit 0 when ok, 1 when the doorbell said
           no, 2 when it could not be reached.
  arm-from-guest <vmid> <arm_id> <fingerprint> [email|discord]
           Used by Hivra's arm host script: reads the one credential line the
           guest's read program printed (stdin), checks its fingerprint is the
           one the owner opted in with, and arms the doorbell. Prints one
           HIVRA_DOORBELL_ARM line that never holds a credential.

Arming (before the computer sleeps, while it is still running):
  1. Hivra's arm host script reads the mail settings from the computer's own
     ~/.hermes/.env through the vmid-bound guest exec and hands them here over
     the control socket. They never reach Hivra's servers or its database.
  2. The doorbell logs in, records UIDNEXT and UIDVALIDITY with STATUS, opens
     INBOX with EXAMINE (read-only: nothing is ever marked seen), and only then
     answers armed. Only after that answer does Hivra stop the computer, so a
     message that lands during the stop is above the baseline and still wakes.

Watching: IDLE when the server offers it, otherwise a NOOP poll. New UIDs are
read with UID FETCH ... BODY.PEEK[HEADER.FIELDS (...)]; only the sender and the
bulk-mail headers are read, never a body. The commands are an allowlist: SELECT,
STORE, EXPUNGE, COPY, MOVE, APPEND and every other command that could change
the mailbox are refused before they are sent. A changed UIDVALIDITY wakes.

Who wakes the computer: a sender Hermes would answer. With EMAIL_ALLOWED_USERS
(or GATEWAY_ALLOWED_USERS) set, only an exact listed address. Without a list,
any sender (fail toward awake: Hermes may know pairings the host cannot see).
Never the mailbox's own address, and never automated mail (no-reply style
addresses, Auto-Submitted, Precedence bulk/list/junk, List-Unsubscribe,
X-Auto-Response-Suppress), the same rules Hermes's email adapter applies.

Waking: the doorbell asks the wake proxy's root helper (`request` on
/run/hivra-ingress/ctl.sock, as the doorbell user, always reason "doorbell"),
which signs a wake-request to Hivra with the host credential. The doorbell
never holds that credential. It forgets the mail credentials as soon as it
rings, and asks again every FIRE_RETRY seconds until Hivra disarms it (every
wake does), because a ring that lands while the computer is still going to
sleep is answered "awake" and must be repeated once it sleeps. Past FIRE_MAX it
stops only if Hivra's last answer said the computer is awake; a ring that never
got through (Hivra or the network down, no host credential) keeps asking every
FIRE_SLOW seconds, so a sleeping computer is never left deaf.

Fail toward awake. A watch that cannot reach the mailbox for WATCH_FAIL seconds
rings. A doorbell that restarts has lost the credentials it held, so it rings
for every computer its state file says was armed. The state file holds only
vmids and arm ids.

Discord (the same service, its own section below). The arm host script reads
the bot token and Hermes's Discord reply settings from the computer's own
~/.hermes/.env the same way and hands them over the same socket; the token
lives in memory only. The doorbell checks the bot's login budget
(GET /gateway/bot session_start_limit), opens its own gateway session and
answers armed only once Discord said READY, so a message sent during the stop
is already seen. It asks only for the GUILDS, GUILD_MESSAGES and
DIRECT_MESSAGES intents, never MESSAGE_CONTENT. A message wakes when it is not
from the bot itself and is a DM, mentions the bot, replies to the bot, is in a
free-response channel (or a thread under one, or a thread the bot owns), or
when Hermes answers without a mention; another bot's message only as
DISCORD_ALLOW_BOTS says. On a wake it asks for the wake as for mail, then sends
one typing indicator to that channel (POST /channels/{id}/typing). It never
posts a message: a reply would hide that message from Hermes's own catch-up.
After the disarm it stays connected for DISCORD_LINGER seconds while the agent
comes back, then closes. A dropped session is resumed where Discord allows;
fresh logins are capped per arm and need budget left, and a session that
cannot be kept for WATCH_FAIL seconds, a refused token, or a spent budget ring.

Nothing host-specific lives in this file, and nothing secret is ever logged.
"""

import asyncio
import base64
import email.parser
import email.policy
import email.utils
import hashlib
import ipaddress
import json
import os
import pwd
import re
import signal
import socket
import ssl
import stat
import struct
import sys
import time
import urllib.parse

VERSION = "hivra-wake-doorbell/2"

CTL_TIMEOUT = 5.0
CTL_MAX_LINE = 64 * 1024
ARM_TIMEOUT = 10.0
CONNECT_TIMEOUT = 8.0
COMMAND_TIMEOUT = 15.0
IDLE_SECONDS = 240.0
POLL_SECONDS = 30.0
FIRE_RETRY = 15.0
FIRE_MAX = 600.0
FIRE_SLOW = 60.0
WATCH_FAIL = 300.0
RECONNECT_BACKOFF = (2.0, 5.0, 10.0, 30.0, 60.0)
MAX_LINE = 64 * 1024
MAX_LITERAL = 256 * 1024
MAX_NEW_PER_CHECK = 200
MAX_ARMED = 256
WATCHDOG_SECONDS = 5.0
HELPER_CTL = "/run/hivra-ingress/ctl.sock"
ARM_PREFIX = "HIVRA_DOORBELL_ARM "
CRED_PREFIX = "HIVRA_EMAIL_CRED "
DISCORD_CRED_PREFIX = "HIVRA_DISCORD_CRED "
CRED_PREFIXES = {"email": (CRED_PREFIX, "HIVRA_EMAIL_CRED_NONE "), "discord": (DISCORD_CRED_PREFIX, "HIVRA_DISCORD_CRED_NONE ")}

# Discord. Public endpoints only; nothing host-specific.
DISCORD_REST_BASE = "https://discord.com/api/v10"
DISCORD_GATEWAY_HOST_SUFFIX = ".discord.gg"
# GUILDS (thread and channel names) | GUILD_MESSAGES | DIRECT_MESSAGES. Never MESSAGE_CONTENT (privileged).
DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12)
DISCORD_LINGER = 90.0
# Fresh logins left in the bot's daily budget below which the doorbell refuses to arm (Hermes needs its own).
DISCORD_MIN_LOGINS = 100
# Fresh logins one arm may make (the first one included); every other reconnect resumes.
DISCORD_MAX_IDENTIFIES = 4
DISCORD_MAX_MESSAGE = 8 * 1024 * 1024
DISCORD_MAX_HTTP = 1024 * 1024
DISCORD_MAX_MAP = 50_000
DISCORD_USER_AGENT = "DiscordBot (hivra-wake-doorbell, 2)"
# Close codes after which the token or the session settings will not work again.
DISCORD_FATAL_CLOSES = frozenset((4004, 4010, 4011, 4012, 4013, 4014))
# Close codes after which the session cannot be resumed.
DISCORD_FRESH_CLOSES = frozenset((4007, 4009))
DISCORD_BOT_SHAPE_RE = re.compile(r"^[A-Za-z0-9._-]{20,200}$")
SNOWFLAKE_RE = re.compile(r"^[0-9]{5,25}$")
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Only these IMAP commands are ever sent. Nothing here can change a mailbox.
ALLOWED_COMMANDS = frozenset(("CAPABILITY", "STARTTLS", "LOGIN", "STATUS", "EXAMINE", "UID FETCH", "IDLE", "NOOP", "LOGOUT"))
HEADER_FIELDS = "FROM AUTO-SUBMITTED PRECEDENCE X-AUTO-RESPONSE-SUPPRESS LIST-UNSUBSCRIBE"

# The same automated-sender rules as Hermes's email adapter (plugins/platforms/email/adapter.py).
NOREPLY_PATTERNS = ("noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster",
                    "bounce", "notifications@", "automated@", "auto-confirm", "auto-reply", "automailer")

VMID_RE = re.compile(r"^[0-9]{3,9}$")
ARM_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
FP_RE = re.compile(r"^[0-9a-f]{16}$")
HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")
ADDRESS_RE = re.compile(r"^[^\s@\"<>]{1,128}@[^\s@\"<>]{1,253}$")
SECURITY = {"tls": "tls", "ssl": "tls", "implicit": "tls", "starttls": "starttls", "plain": "plain", "none": "plain"}
MIN_VMID = 100
MAX_VMID = 999_999_999

mono = time.monotonic


def uptime():
    """Seconds since boot, from /proc/uptime; the monotonic clock where that is unreadable."""
    try:
        with open("/proc/uptime", "rb") as handle:
            return float(handle.read().split()[0])
    except (OSError, ValueError, IndexError):
        return mono()


class Config(object):
    """Paths and limits. The defaults are the host's; tests point them at a temporary tree."""

    def __init__(self, **overrides):
        self.run_dir = "/run/hivra-doorbell"
        self.helper_ctl = HELPER_CTL
        self.root_uids = (0,)
        self.idle_seconds = IDLE_SECONDS
        self.poll_seconds = POLL_SECONDS
        self.fire_retry = FIRE_RETRY
        self.fire_max = FIRE_MAX
        self.fire_slow = FIRE_SLOW
        # Tests only: a fake mail server on loopback.
        self.allow_private_imap = False
        self.watch_fail = WATCH_FAIL
        self.reconnect_backoff = RECONNECT_BACKOFF
        self.arm_timeout = ARM_TIMEOUT
        self.connect_timeout = CONNECT_TIMEOUT
        self.command_timeout = COMMAND_TIMEOUT
        self.discord_rest = DISCORD_REST_BASE
        self.discord_linger = DISCORD_LINGER
        self.discord_min_logins = DISCORD_MIN_LOGINS
        self.discord_max_identifies = DISCORD_MAX_IDENTIFIES
        # Tests only: a CA file for a test TLS mailbox.
        self.test_ca_file = None
        # Tests only: accept a gateway address that is not wss://*.discord.gg (a loopback fake).
        self.test_any_gateway = False
        self.clock = uptime
        for key, value in overrides.items():
            if not hasattr(self, key):
                raise TypeError("unknown config key: %s" % key)
            setattr(self, key, value)

    @property
    def ctl_path(self):
        return os.path.join(self.run_dir, "ctl.sock")

    @property
    def state_path(self):
        return os.path.join(self.run_dir, "armed.json")


def log(event, **fields):
    record = {"event": event}
    record.update({key: value for key, value in fields.items() if value is not None})
    try:
        sys.stderr.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass



def ring_settled(answer):
    """Whether Hivra itself answered that the computer is awake: only then may a ring past FIRE_MAX stop.
    A ring that never reached Hivra (no answer, a refusal, no host credential) keeps going."""
    return bool(answer and answer.get("ok") is True and answer.get("state") == "awake")

async def resolve_public(host, port, cfg):
    """The first globally routable address `host` resolves to. Raises ImapError("address_refused") when it has
    none (loopback, private, link-local, shared, reserved), ImapError("connect_failed") when it does not resolve."""
    try:
        infos = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP),
            cfg.connect_timeout)
    except (OSError, asyncio.TimeoutError, UnicodeError):
        raise ImapError("connect_failed")
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if address.is_global or cfg.allow_private_imap:
            return str(address)
    raise ImapError("address_refused")


def parse_vmid(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        vmid = value
    elif isinstance(value, str) and VMID_RE.match(value):
        vmid = int(value)
    else:
        return None
    return vmid if MIN_VMID <= vmid <= MAX_VMID else None


# ---------------------------------------------------------------- arm requests

class BadRequest(Exception):
    pass


def clean_text(value, limit):
    if not isinstance(value, str) or not value or len(value) > limit or any(ch in value for ch in "\r\n\x00"):
        raise BadRequest()
    return value


def parse_arm(request):
    """The arm request, checked. Raises BadRequest. The password is only ever checked, never echoed."""
    vmid = parse_vmid(request.get("vmid"))
    arm_id = request.get("arm_id")
    if vmid is None or not isinstance(arm_id, str) or not ARM_ID_RE.match(arm_id):
        raise BadRequest()
    channel = request.get("channel")
    if channel == "discord":
        return parse_discord_arm(request, vmid, arm_id)
    if channel != "email":
        raise BadRequest()
    imap = request.get("imap")
    if not isinstance(imap, dict):
        raise BadRequest()
    host = clean_text(imap.get("host"), 253).strip()
    if not HOST_RE.match(host):
        raise BadRequest()
    port = imap.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise BadRequest()
    security = SECURITY.get(str(imap.get("security", "")).strip().lower())
    if security is None:
        raise BadRequest()
    verify = imap.get("verify")
    if not isinstance(verify, bool):
        raise BadRequest()
    user = clean_text(imap.get("user"), 320)
    password = clean_text(imap.get("password"), 1024)
    own = str(request.get("self") or "").strip().lower()
    allowed = request.get("allowed", [])
    if not isinstance(allowed, list) or len(allowed) > 500:
        raise BadRequest()
    listed = set()
    for entry in allowed:
        if not isinstance(entry, str) or len(entry) > 320:
            raise BadRequest()
        entry = entry.strip().lower()
        if entry:
            listed.add(entry)
    return {
        "vmid": vmid, "arm_id": arm_id, "channel": "email",
        "imap": {"host": host, "port": port, "security": security, "verify": verify, "user": user, "password": password},
        "self": own, "allowed": frozenset(listed),
    }


def channel_key(value):
    """A free-response channel entry as Hermes compares it: an id, or a name without its leading #."""
    return value.strip().lstrip("#").strip().lower()


def parse_discord_arm(request, vmid, arm_id):
    """The Discord arm request, checked. Raises BadRequest. The token is only ever checked, never echoed."""
    rules = request.get("discord")
    if not isinstance(rules, dict):
        raise BadRequest()
    token = clean_text(rules.get("token"), 200)
    if not DISCORD_BOT_SHAPE_RE.match(token):
        raise BadRequest()
    flags = {}
    for key in ("require_mention", "thread_require_mention", "wake_all_guild"):
        value = rules.get(key)
        if not isinstance(value, bool):
            raise BadRequest()
        flags[key] = value
    allow_bots = rules.get("allow_bots")
    if allow_bots not in ("none", "mentions", "all"):
        raise BadRequest()
    free = rules.get("free_channels", [])
    if not isinstance(free, list) or len(free) > 500:
        raise BadRequest()
    listed = set()
    for entry in free:
        if not isinstance(entry, str) or len(entry) > 100 or any(ch in entry for ch in "\r\n\x00"):
            raise BadRequest()
        key = channel_key(entry)
        if key:
            listed.add(key)
    return {
        "vmid": vmid, "arm_id": arm_id, "channel": "discord", "token": token,
        "rules": dict(flags, allow_bots=allow_bots, free_channels=frozenset(listed)),
    }


def is_automated(address, headers):
    addr = address.lower()
    if any(pattern in addr for pattern in NOREPLY_PATTERNS):
        return True
    auto = headers.get("Auto-Submitted")
    if auto and auto.strip().lower() != "no":
        return True
    precedence = headers.get("Precedence")
    if precedence and precedence.strip().lower() in ("bulk", "list", "junk"):
        return True
    return bool(headers.get("X-Auto-Response-Suppress")) or bool(headers.get("List-Unsubscribe"))


def sender_wakes(raw_headers, own, allowed):
    """Whether a message with these header bytes would be answered by Hermes, as far as the host can tell."""
    try:
        parsed = email.parser.BytesHeaderParser(policy=email.policy.compat32).parsebytes(raw_headers or b"")
        headers = {key: str(parsed.get(key) or "") for key in
                   ("From", "Auto-Submitted", "Precedence", "X-Auto-Response-Suppress", "List-Unsubscribe")}
    except Exception:
        return False
    address = email.utils.parseaddr(headers["From"])[1].strip().lower()
    if not address or not ADDRESS_RE.match(address):
        return False
    if own and address == own:
        return False
    if is_automated(address, headers):
        return False
    if allowed:
        return address in allowed
    return True


# ---------------------------------------------------------------- IMAP

class ImapError(Exception):
    def __init__(self, reason):
        Exception.__init__(self, reason)
        self.reason = reason


def quote(value):
    """An IMAP quoted string, or None when the value needs a literal."""
    if any(ord(ch) > 126 or ord(ch) < 32 for ch in value):
        return None
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Response(object):
    """One response line, with any literals it carried, in order."""

    def __init__(self, text, literals):
        self.text = text
        self.literals = literals


class Imap(object):
    """A small, read-only IMAP4rev1 client. Every command goes through `command`, which enforces ALLOWED_COMMANDS."""

    def __init__(self, cfg, params):
        self.cfg = cfg
        self.params = params
        self.reader = None
        self.writer = None
        self.seq = 0
        self.capabilities = frozenset()
        # Set while a command or IDLE is in flight, so a cancelled watch knows how to leave cleanly.
        self.busy = False
        self.idling = False

    def tls_context(self):
        if self.cfg.test_ca_file:
            context = ssl.create_default_context(cafile=self.cfg.test_ca_file)
        else:
            context = ssl.create_default_context()
        if not self.params["verify"]:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        return context

    async def open(self):
        params = self.params
        security = params["security"]
        # "plain" only ever comes from the computer's own settings, where Hermes already logs in the same way.
        context = self.tls_context() if security == "tls" else None
        # The doorbell connects from the host's own address, which every guest forwarder allows: only a public
        # mail server, resolved here and connected to by the address that was checked (never the host itself,
        # another guest or anything private), so a computer's settings cannot point it at internal services.
        address = await resolve_public(params["host"], params["port"], self.cfg)
        try:
            self.reader, self.writer = await asyncio.wait_for(
                asyncio.open_connection(address, params["port"], ssl=context,
                                        server_hostname=params["host"] if context else None, limit=MAX_LINE * 2),
                self.cfg.connect_timeout)
        except (OSError, asyncio.TimeoutError, ssl.SSLError, ValueError):
            raise ImapError("connect_failed")
        greeting = await self.read_response()
        if not greeting.text.upper().startswith(("* OK", "* PREAUTH")):
            raise ImapError("bad_greeting")
        await self.load_capabilities(greeting.text)
        if security == "starttls":
            if "STARTTLS" not in self.capabilities:
                raise ImapError("no_starttls")
            await self.command("STARTTLS")
            try:
                await asyncio.wait_for(self.writer.start_tls(self.tls_context(), server_hostname=params["host"]),
                                       self.cfg.connect_timeout)
            except (OSError, asyncio.TimeoutError, ssl.SSLError, AttributeError):
                raise ImapError("starttls_failed")
            self.capabilities = frozenset()
            await self.load_capabilities("")

    async def load_capabilities(self, greeting):
        found = re.search(r"\[CAPABILITY ([^\]]*)\]", greeting, re.I)
        if not found:
            untagged, _ = await self.command("CAPABILITY")
            for response in untagged:
                if response.text.upper().startswith("* CAPABILITY "):
                    found = re.match(r"\* CAPABILITY (.*)$", response.text, re.I)
        if found:
            self.capabilities = frozenset(item.upper() for item in found.group(1).split())

    async def login(self):
        if "LOGINDISABLED" in self.capabilities:
            raise ImapError("login_disabled")
        parts = []
        for value in (self.params["user"], self.params["password"]):
            quoted = quote(value)
            parts.append(quoted if quoted is not None else value.encode("utf-8"))
        try:
            await self.command("LOGIN", *parts)
        except ImapError as error:
            raise ImapError("login_failed" if error.reason == "refused" else error.reason)

    async def readline(self):
        try:
            line = await asyncio.wait_for(self.reader.readuntil(b"\r\n"), self.cfg.command_timeout)
        except asyncio.LimitOverrunError:
            raise ImapError("line_too_long")
        except (asyncio.IncompleteReadError, OSError, ConnectionError):
            raise ImapError("connection_lost")
        if len(line) > MAX_LINE:
            raise ImapError("line_too_long")
        return line[:-2]

    async def read_response(self, wait=None):
        """One logical response: a line, and every literal it announces with the text that follows it."""
        if wait is not None:
            try:
                first = await asyncio.wait_for(self.readline(), wait)
            except asyncio.TimeoutError:
                return None
        else:
            first = await self.readline()
        text = [first]
        literals = []
        while True:
            found = re.search(rb"\{([0-9]{1,9})\+?\}$", text[-1])
            if not found:
                break
            size = int(found.group(1))
            if size > MAX_LITERAL:
                raise ImapError("literal_too_large")
            try:
                literals.append(await asyncio.wait_for(self.reader.readexactly(size), self.cfg.command_timeout))
            except (asyncio.IncompleteReadError, OSError, ConnectionError, asyncio.TimeoutError):
                raise ImapError("connection_lost")
            text.append(await self.readline())
        return Response(b" ".join(text).decode("utf-8", "replace"), literals)

    async def send(self, data):
        try:
            self.writer.write(data)
            await asyncio.wait_for(self.writer.drain(), self.cfg.command_timeout)
        except (OSError, ConnectionError, asyncio.TimeoutError):
            raise ImapError("connection_lost")

    async def command(self, name, *args):
        """Sends one allowed command. Returns (untagged responses, tagged text). A NO or BAD raises ImapError("refused")."""
        if name not in ALLOWED_COMMANDS:
            raise ImapError("command_not_allowed")
        self.seq += 1
        tag = "D%04d" % self.seq
        self.busy = True
        head = (tag + " " + name).encode("ascii")
        for arg in args:
            if isinstance(arg, bytes):
                await self.send(head + b" {%d}\r\n" % len(arg))
                ready = await self.read_response()
                if not ready.text.startswith("+"):
                    raise ImapError("refused")
                head = arg
            else:
                head += b" " + arg.encode("ascii")
        await self.send(head + b"\r\n")
        untagged = []
        while True:
            response = await self.read_response()
            if response.text.startswith(tag + " "):
                status = response.text[len(tag) + 1:].split(" ", 1)[0].upper()
                self.busy = False
                if status != "OK":
                    raise ImapError("refused")
                return untagged, response.text
            if response.text.startswith("+"):
                raise ImapError("unexpected_continuation")
            untagged.append(response)

    async def status(self):
        untagged, _ = await self.command("STATUS", "INBOX", "(UIDNEXT UIDVALIDITY)")
        for response in untagged:
            if response.text.upper().startswith("* STATUS "):
                uidnext = re.search(r"UIDNEXT ([0-9]{1,10})", response.text, re.I)
                validity = re.search(r"UIDVALIDITY ([0-9]{1,10})", response.text, re.I)
                if uidnext and validity:
                    return int(validity.group(1)), int(uidnext.group(1))
        raise ImapError("no_status")

    async def examine(self):
        untagged, tagged = await self.command("EXAMINE", "INBOX")
        validity = None
        for text in [response.text for response in untagged] + [tagged]:
            found = re.search(r"\[UIDVALIDITY ([0-9]{1,10})\]", text, re.I)
            if found:
                validity = int(found.group(1))
        if validity is None:
            raise ImapError("no_uidvalidity")
        return validity

    async def fetch_from(self, first_uid):
        """(uid, header bytes) for every message with a UID at or above first_uid, read without setting \\Seen."""
        untagged, _ = await self.command("UID FETCH", "%d:*" % first_uid,
                                         "(UID BODY.PEEK[HEADER.FIELDS (%s)])" % HEADER_FIELDS)
        out = []
        for response in untagged:
            if not re.match(r"^\* [0-9]+ FETCH ", response.text, re.I):
                continue
            uid = re.search(r"UID ([0-9]{1,10})", response.text, re.I)
            if uid is None or int(uid.group(1)) < first_uid:
                continue
            out.append((int(uid.group(1)), response.literals[0] if response.literals else b""))
        return out

    async def idle(self, seconds):
        """IDLE until the server says something changed or `seconds` pass. True when it reported new mail."""
        await self.send(("D%04d IDLE\r\n" % (self.seq + 1)).encode("ascii"))
        self.seq += 1
        tag = "D%04d" % self.seq
        self.busy = True
        ready = await self.read_response()
        if not ready.text.startswith("+"):
            raise ImapError("idle_refused")
        self.idling = True
        changed = False
        deadline = mono() + seconds
        while mono() < deadline:
            response = await self.read_response(wait=max(0.05, deadline - mono()))
            if response is None:
                break
            if re.match(r"^\* [0-9]+ (EXISTS|RECENT)", response.text, re.I):
                changed = True
                break
            if response.text.upper().startswith("* BYE"):
                raise ImapError("connection_lost")
        await self.send(b"DONE\r\n")
        self.idling = False
        while True:
            response = await self.read_response()
            if response.text.startswith(tag + " "):
                self.busy = False
                if response.text[len(tag) + 1:].split(" ", 1)[0].upper() != "OK":
                    raise ImapError("refused")
                return changed
            if re.match(r"^\* [0-9]+ (EXISTS|RECENT)", response.text, re.I):
                changed = True

    async def close(self):
        if self.writer is None:
            return
        try:
            if self.idling:
                # A watch cancelled in IDLE: end it, then the IDLE's own answer is read as an untagged line.
                self.idling = False
                self.busy = False
                await self.send(b"DONE\r\n")
            if self.reader is not None and not self.reader.at_eof() and not self.busy:
                await asyncio.wait_for(self.command("LOGOUT"), 2.0)
        except (ImapError, asyncio.TimeoutError, OSError):
            pass
        try:
            self.writer.close()
        except (OSError, RuntimeError):
            pass
        self.writer = None
        self.reader = None


# ---------------------------------------------------------------- one armed computer

class Watch(object):
    """One armed computer: its credentials (memory only), its baseline, and the task watching or ringing."""

    def __init__(self, doorbell, arm):
        self.doorbell = doorbell
        self.cfg = doorbell.cfg
        self.vmid = arm["vmid"]
        self.arm_id = arm["arm_id"]
        self.params = arm["imap"]
        self.own = arm["self"]
        self.allowed = arm["allowed"]
        self.state = "arming"
        self.uidvalidity = None
        self.next_uid = None
        self.imap = None
        self.task = None
        self.fired_reason = None
        self.fired_at = None
        self.requests = 0
        self.last_answer = None

    def view(self):
        return {"vmid": self.vmid, "arm_id": self.arm_id, "state": self.state, "uidvalidity": self.uidvalidity,
                "uidnext": self.next_uid, "fired": self.fired_reason, "requests": self.requests,
                "last_state": (self.last_answer or {}).get("state")}

    def armed_answer(self):
        return {"ok": True, "vmid": self.vmid, "arm_id": self.arm_id, "uidvalidity": self.uidvalidity, "uidnext": self.next_uid,
                "idle": "IDLE" in self.imap.capabilities}

    def armed_log(self):
        return {"idle": "IDLE" in self.imap.capabilities}

    async def halt(self, close_code=None):
        """Service shutdown: stops the task and the mailbox connection, keeping the state as it is."""
        task, self.task = self.task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if self.imap is not None:
            await self.imap.close()

    async def connect(self):
        imap = Imap(self.cfg, self.params)
        try:
            await imap.open()
            await imap.login()
        except BaseException:
            await imap.close()
            raise
        return imap

    async def arm(self):
        """Log in, take the baseline with STATUS, open INBOX read-only. Raises ImapError."""
        self.imap = await self.connect()
        try:
            validity, uidnext = await self.imap.status()
            examined = await self.imap.examine()
        except BaseException:
            await self.imap.close()
            self.imap = None
            raise
        if examined != validity:
            await self.imap.close()
            self.imap = None
            raise ImapError("uidvalidity_moved")
        self.uidvalidity = validity
        self.next_uid = uidnext
        self.state = "armed"

    def start(self):
        self.task = asyncio.get_running_loop().create_task(self.watch())

    async def check(self):
        """Reads the headers of every new message. True when one of them would be answered."""
        found = await self.imap.fetch_from(self.next_uid)
        wake = len(found) > MAX_NEW_PER_CHECK
        for uid, headers in found[:MAX_NEW_PER_CHECK]:
            if uid >= self.next_uid:
                self.next_uid = uid + 1
            if not wake and sender_wakes(headers, self.own, self.allowed):
                wake = True
        return wake

    async def watch(self):
        failing_since = None
        attempt = 0
        try:
            while self.state == "armed":
                try:
                    if self.imap is None:
                        self.imap = await self.connect()
                        if await self.imap.examine() != self.uidvalidity:
                            await self.ring("uidvalidity")
                            return
                    if await self.check():
                        await self.ring("mail")
                        return
                    failing_since = None
                    attempt = 0
                    if "IDLE" in self.imap.capabilities:
                        await self.imap.idle(self.cfg.idle_seconds)
                    else:
                        await asyncio.sleep(self.cfg.poll_seconds)
                        await self.imap.command("NOOP")
                except ImapError as error:
                    if self.imap is not None:
                        await self.imap.close()
                        self.imap = None
                    now = self.cfg.clock()
                    if failing_since is None:
                        failing_since = now
                    log("watch_error", vmid=self.vmid, reason=error.reason, attempt=attempt)
                    if now - failing_since >= self.cfg.watch_fail:
                        await self.ring("watch_failed")
                        return
                    backoff = self.cfg.reconnect_backoff
                    await asyncio.sleep(backoff[min(attempt, len(backoff) - 1)])
                    attempt += 1
        except asyncio.CancelledError:
            raise
        except Exception as error:  # an unexpected fault must still end in a ring, never a deaf computer
            log("watch_fault", vmid=self.vmid, kind=type(error).__name__)
            await self.ring("fault")

    async def ring(self, reason):
        """Forget the mail credentials, then ask for the wake until disarmed (or, past FIRE_MAX, Hivra says awake)."""
        if self.imap is not None:
            await self.imap.close()
            self.imap = None
        self.params = None
        self.state = "fired"
        self.fired_reason = reason
        self.fired_at = self.cfg.clock()
        self.doorbell.persist()
        log("ring", vmid=self.vmid, reason=reason)
        while self.state == "fired":
            answer = await self.doorbell.request_wake(self.vmid)
            self.requests += 1
            self.last_answer = answer
            log("wake_request", vmid=self.vmid, ok=bool(answer and answer.get("ok")),
                state=(answer or {}).get("state"), error=(answer or {}).get("error"))
            if self.cfg.clock() - self.fired_at >= self.cfg.fire_max:
                if ring_settled(answer):
                    self.state = "expired"
                    log("ring_expired", vmid=self.vmid, requests=self.requests)
                    self.doorbell.forget(self)
                    return
                # Hivra never said the computer is awake: keep asking, more slowly, never deaf.
                await asyncio.sleep(self.cfg.fire_slow)
                continue
            await asyncio.sleep(self.cfg.fire_retry)

    async def stop(self):
        self.state = "disarmed"
        self.params = None
        if self.task is not None and self.task is not asyncio.current_task():
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        if self.imap is not None:
            await self.imap.close()
            self.imap = None


# ---------------------------------------------------------------- Discord

class DiscordError(Exception):
    def __init__(self, reason):
        Exception.__init__(self, reason)
        self.reason = reason


def discord_message_wakes(message, bot_id, rules, threads, names):
    """Whether Hermes would answer this MESSAGE_CREATE, as far as the host can tell. Waking once too often only costs a wake."""
    if not isinstance(message, dict) or not bot_id:
        return False
    author = message.get("author") if isinstance(message.get("author"), dict) else {}
    author_id = str(author.get("id") or "")
    if not author_id or author_id == bot_id:
        return False
    # Ordinary messages and replies; system notices (joins, pins, thread starts) never wake.
    if message.get("type", 0) not in (0, 19):
        return False
    content = message.get("content") if isinstance(message.get("content"), str) else ""
    mentions = message.get("mentions") if isinstance(message.get("mentions"), list) else []
    mentioned = any(isinstance(m, dict) and str(m.get("id") or "") == bot_id for m in mentions) \
        or ("<@%s>" % bot_id) in content or ("<@!%s>" % bot_id) in content
    ref = message.get("referenced_message")
    replied = isinstance(ref, dict) and isinstance(ref.get("author"), dict) and str(ref["author"].get("id") or "") == bot_id
    if author.get("bot") or message.get("webhook_id"):
        if rules["allow_bots"] == "none":
            return False
        if rules["allow_bots"] == "mentions":
            return mentioned
    if not message.get("guild_id"):
        return True
    if mentioned or replied:
        return True
    if rules["wake_all_guild"] or not rules["require_mention"]:
        return True
    free = rules["free_channels"]
    if "*" in free:
        return True
    channel_id = str(message.get("channel_id") or "")
    parent, owner = threads.get(channel_id, (None, None))
    for cid in (channel_id, parent):
        if cid and (cid in free or names.get(cid) in free):
            return True
    return parent is not None and owner == bot_id and not rules["thread_require_mention"]


def tls_context_for(cfg):
    if cfg.test_ca_file:
        return ssl.create_default_context(cafile=cfg.test_ca_file)
    return ssl.create_default_context()


async def open_stream(cfg, url):
    """(reader, writer, Host header, request path) for an http(s) or ws(s) address."""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        raise DiscordError("bad_address")
    if parts.scheme not in ("https", "wss", "http", "ws") or not parts.hostname:
        raise DiscordError("bad_address")
    secure = parts.scheme in ("https", "wss")
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(
            parts.hostname, port or (443 if secure else 80), ssl=tls_context_for(cfg) if secure else None,
            server_hostname=parts.hostname if secure else None, limit=64 * 1024), cfg.connect_timeout)
    except (OSError, asyncio.TimeoutError, ssl.SSLError, ValueError):
        raise DiscordError("connect_failed")
    host = parts.hostname if port is None else "%s:%d" % (parts.hostname, port)
    return reader, writer, host, (parts.path or "/") + ("?" + parts.query if parts.query else "")


async def read_http_head(reader, timeout):
    """The status code and headers (lower-case names) of one HTTP/1.1 response."""
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout)
    except (asyncio.LimitOverrunError, asyncio.IncompleteReadError, OSError, ConnectionError, asyncio.TimeoutError):
        raise DiscordError("http_failed")
    lines = head[:-4].decode("latin-1").split("\r\n")
    status = re.match(r"^HTTP/1\.[01] ([0-9]{3})", lines[0])
    if not status:
        raise DiscordError("http_failed")
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return int(status.group(1)), headers


def dechunk(data):
    out = []
    pos = 0
    try:
        while True:
            end = data.index(b"\r\n", pos)
            size = int(data[pos:end].split(b";")[0].strip(), 16)
            if size == 0:
                return b"".join(out)
            out.append(data[end + 2:end + 2 + size])
            pos = end + 2 + size + 2
    except ValueError:
        raise DiscordError("http_failed")


def close_writer(writer):
    try:
        writer.close()
    except (OSError, RuntimeError):
        pass


async def discord_http(cfg, method, path, token, body=None):
    """One REST call to Discord: (status, JSON body or None). Raises DiscordError when it cannot be made."""
    reader, writer, host, full = await open_stream(cfg, cfg.discord_rest.rstrip("/") + path)
    try:
        payload = b"" if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        head = ("%s %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bot %s\r\nUser-Agent: %s\r\nAccept: application/json\r\n"
                "Content-Length: %d\r\nConnection: close\r\n%s\r\n"
                % (method, full, host, token, DISCORD_USER_AGENT, len(payload),
                   "Content-Type: application/json\r\n" if body is not None else ""))
        try:
            writer.write(head.encode("latin-1") + payload)
            await asyncio.wait_for(writer.drain(), cfg.command_timeout)
        except (OSError, ConnectionError, asyncio.TimeoutError):
            raise DiscordError("http_failed")
        status, headers = await read_http_head(reader, cfg.command_timeout)
        chunks, total = [], 0
        while True:
            try:
                part = await asyncio.wait_for(reader.read(65536), cfg.command_timeout)
            except (OSError, ConnectionError, asyncio.TimeoutError):
                raise DiscordError("http_failed")
            if not part:
                break
            total += len(part)
            if total > DISCORD_MAX_HTTP:
                raise DiscordError("http_too_large")
            chunks.append(part)
        data = b"".join(chunks)
        if "chunked" in headers.get("transfer-encoding", "").lower():
            data = dechunk(data)
        try:
            parsed = json.loads(data.decode("utf-8")) if data else None
        except (ValueError, UnicodeDecodeError):
            parsed = None
        return status, parsed
    finally:
        close_writer(writer)


def mask_bytes(payload, mask):
    if not payload:
        return b""
    size = len(payload)
    key = (mask * (size // 4 + 1))[:size]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(size, "big")


class WebSocket(object):
    """A small RFC 6455 client: masked text frames out, whole messages in, pings answered."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.reader = None
        self.writer = None
        self.closed = False

    async def connect(self, url):
        self.reader, self.writer, host, path = await open_stream(self.cfg, url)
        key = base64.b64encode(os.urandom(16))
        request = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
                   "Sec-WebSocket-Version: 13\r\nUser-Agent: %s\r\n\r\n" % (path, host, key.decode("ascii"), DISCORD_USER_AGENT))
        try:
            self.writer.write(request.encode("latin-1"))
            await asyncio.wait_for(self.writer.drain(), self.cfg.command_timeout)
        except (OSError, ConnectionError, asyncio.TimeoutError):
            raise DiscordError("connect_failed")
        status, headers = await read_http_head(self.reader, self.cfg.command_timeout)
        accept = base64.b64encode(hashlib.sha1(key + WS_GUID).digest()).decode("ascii")
        if status != 101 or headers.get("sec-websocket-accept") != accept:
            raise DiscordError("upgrade_refused")

    async def send_frame(self, opcode, payload):
        if self.writer is None or self.closed:
            raise DiscordError("connection_lost")
        size = len(payload)
        if size < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | size)
        elif size < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, size)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, size)
        mask = os.urandom(4)
        try:
            self.writer.write(head + mask + mask_bytes(payload, mask))
            await asyncio.wait_for(self.writer.drain(), self.cfg.command_timeout)
        except (OSError, ConnectionError, asyncio.TimeoutError, RuntimeError):
            raise DiscordError("connection_lost")

    async def send_json(self, value):
        await self.send_frame(0x1, json.dumps(value, separators=(",", ":")).encode("utf-8"))

    async def read_exact(self, size, timeout):
        try:
            return await asyncio.wait_for(self.reader.readexactly(size), timeout)
        except (asyncio.IncompleteReadError, OSError, ConnectionError, asyncio.TimeoutError):
            raise DiscordError("connection_lost")

    async def recv(self, timeout):
        """One whole message: ("text", str), ("close", code), or ("skipped", None) for a binary or oversized one."""
        parts, total, kind, oversized = [], 0, None, False
        while True:
            first, second = struct.unpack("!BB", await self.read_exact(2, timeout))
            opcode, size = first & 0x0F, second & 0x7F
            if second & 0x80:
                raise DiscordError("bad_frame")
            if size == 126:
                size = struct.unpack("!H", await self.read_exact(2, timeout))[0]
            elif size == 127:
                size = struct.unpack("!Q", await self.read_exact(8, timeout))[0]
            if opcode >= 0x8:
                if size > 125:
                    raise DiscordError("bad_frame")
                payload = await self.read_exact(size, timeout) if size else b""
                if opcode == 0x8:
                    self.closed = True
                    return "close", struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                if opcode == 0x9:
                    await self.send_frame(0xA, payload)
                continue
            if opcode in (0x1, 0x2) and kind is None:
                kind = opcode
            elif opcode != 0x0 or kind is None:
                raise DiscordError("bad_frame")
            total += size
            oversized = oversized or total > DISCORD_MAX_MESSAGE
            remaining = size
            while remaining:
                chunk = await self.read_exact(min(remaining, 65536), timeout)
                remaining -= len(chunk)
                if not oversized:
                    parts.append(chunk)
            if oversized:
                parts = []
            if first & 0x80:
                break
        if oversized or kind != 0x1:
            return "skipped", None
        try:
            return "text", b"".join(parts).decode("utf-8")
        except UnicodeDecodeError:
            return "skipped", None

    async def close(self, code):
        if self.writer is None:
            return
        if not self.closed:
            self.closed = True
            try:
                self.writer.write(struct.pack("!BB", 0x88, 0x82) + b"\x00\x00\x00\x00" + struct.pack("!H", code))
                await asyncio.wait_for(self.writer.drain(), 2.0)
            except (OSError, ConnectionError, asyncio.TimeoutError, RuntimeError):
                pass
        close_writer(self.writer)
        self.writer = None
        self.reader = None


class DiscordWatch(object):
    """One armed computer's Discord bot: its token (memory only), its own gateway session, and the ring."""

    def __init__(self, doorbell, arm):
        self.doorbell = doorbell
        self.cfg = doorbell.cfg
        self.vmid = arm["vmid"]
        self.arm_id = arm["arm_id"]
        self.token = arm["token"]
        self.rules = arm["rules"]
        self.state = "arming"
        # The email watch's mailbox connection; a Discord watch never has one.
        self.imap = None
        self.ws = None
        self.task = None
        self.ring_task = None
        self.linger_task = None
        self.ready = None
        # 4000 leaves the session resumable; a disarm ends it with 1000.
        self.close_code = 4000
        self.bot_id = None
        self.gateway_url = None
        self.session_id = None
        self.resume_url = None
        self.seq = None
        self.identifies = 0
        self.login_remaining = None
        self.heartbeat_acked = True
        self.threads = {}
        self.names = {}
        self.fired_reason = None
        self.fired_at = None
        self.requests = 0
        self.last_answer = None
        self.typing = None

    def view(self):
        return {"vmid": self.vmid, "arm_id": self.arm_id, "channel": "discord", "state": self.state,
                "session": self.session_id is not None, "identifies": self.identifies,
                "login_remaining": self.login_remaining, "fired": self.fired_reason, "requests": self.requests,
                "typing": self.typing, "last_state": (self.last_answer or {}).get("state")}

    def armed_answer(self):
        return {"ok": True, "vmid": self.vmid, "arm_id": self.arm_id, "channel": "discord",
                "login_remaining": self.login_remaining}

    def armed_log(self):
        return {"channel": "discord", "identifies": self.identifies}

    def gateway_ok(self, url):
        if not isinstance(url, str) or len(url) > 512:
            return False
        try:
            parts = urllib.parse.urlsplit(url)
            parts.port
        except ValueError:
            return False
        if self.cfg.test_any_gateway:
            return parts.scheme in ("ws", "wss") and bool(parts.hostname)
        host = (parts.hostname or "").lower()
        return parts.scheme == "wss" and host.endswith(DISCORD_GATEWAY_HOST_SUFFIX) and not parts.username

    async def check_budget(self):
        """GET /gateway/bot: the token works, the gateway address, and fresh logins left today. Raises DiscordError."""
        status, body = await discord_http(self.cfg, "GET", "/gateway/bot", self.token)
        if status == 401:
            raise DiscordError("token_refused")
        if status == 429:
            raise DiscordError("rate_limited")
        if status != 200 or not isinstance(body, dict):
            raise DiscordError("gateway_unavailable")
        limit = body.get("session_start_limit")
        remaining = limit.get("remaining") if isinstance(limit, dict) else None
        if isinstance(remaining, bool) or not isinstance(remaining, int):
            raise DiscordError("gateway_unavailable")
        self.login_remaining = remaining
        if remaining < self.cfg.discord_min_logins:
            raise DiscordError("login_budget")
        if not self.gateway_ok(body.get("url")):
            raise DiscordError("bad_gateway")
        self.gateway_url = body["url"]

    async def arm(self):
        """Checks the budget, opens the gateway session, and returns once Discord said READY. Raises DiscordError."""
        await self.check_budget()
        loop = asyncio.get_running_loop()
        self.ready = loop.create_future()
        self.task = loop.create_task(self.run())
        await self.ready

    def start(self):
        """The session already runs from the arm."""

    def fail_ready(self, reason):
        if self.ready is not None and not self.ready.done():
            self.ready.set_exception(DiscordError(reason))

    async def run(self):
        try:
            kind, detail, established = await self.session(False)
            if not established:
                self.fail_ready(detail)
                return
            await self.keep(kind, detail)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # an unexpected fault must still end in a ring, never a deaf computer
            log("discord_fault", vmid=self.vmid, kind=type(error).__name__)
            self.fail_ready("fault")
            self.fire("fault")

    async def keep(self, kind, detail):
        """After a session ends while armed: resume it, or log in afresh within the budget, or ring."""
        failing_since = None
        attempt = 0
        while self.state == "armed":
            if kind == "fatal":
                self.fire(detail)
                return
            if kind == "fresh":
                self.session_id = None
                self.seq = None
            backoff = self.cfg.reconnect_backoff
            await asyncio.sleep(backoff[min(attempt, len(backoff) - 1)])
            if self.state != "armed":
                return
            if self.session_id is None:
                if self.identifies >= self.cfg.discord_max_identifies:
                    self.fire("login_budget")
                    return
                try:
                    await self.check_budget()
                except DiscordError as error:
                    if error.reason in ("login_budget", "token_refused"):
                        self.fire(error.reason)
                        return
                    kind, detail, established = "lost", error.reason, False
                else:
                    kind, detail, established = await self.session(False)
            else:
                kind, detail, established = await self.session(True)
            log("discord_session_ended", vmid=self.vmid, kind=kind, reason=detail, established=established)
            if established:
                failing_since, attempt = None, 0
                continue
            now = self.cfg.clock()
            failing_since = now if failing_since is None else failing_since
            if now - failing_since >= self.cfg.watch_fail:
                self.fire("watch_failed")
                return
            attempt += 1

    def after_close(self, code):
        if code in DISCORD_FATAL_CLOSES:
            return "fatal", "token_refused" if code == 4004 else "gateway_refused"
        if code in DISCORD_FRESH_CLOSES:
            return "fresh", "session_expired"
        return "resume", "closed"

    def take_ready(self, data):
        user = data.get("user") if isinstance(data, dict) else None
        bot_id = str(user.get("id") or "") if isinstance(user, dict) else ""
        session_id = data.get("session_id") if isinstance(data, dict) else None
        if not SNOWFLAKE_RE.match(bot_id) or not isinstance(session_id, str) or not 0 < len(session_id) <= 128:
            return False
        self.bot_id = bot_id
        self.session_id = session_id
        resume = data.get("resume_gateway_url")
        self.resume_url = resume if self.gateway_ok(resume) else None
        return True

    async def heartbeat(self, ws, interval):
        """Beats every interval; a beat that was never acknowledged means a dead link, so the socket is dropped."""
        await asyncio.sleep(interval * (0.2 + 0.6 * (os.urandom(1)[0] / 255.0)))
        while True:
            if not self.heartbeat_acked:
                log("discord_zombie", vmid=self.vmid)
                if ws.writer is not None:
                    close_writer(ws.writer)
                return
            self.heartbeat_acked = False
            try:
                await ws.send_json({"op": 1, "d": self.seq})
            except DiscordError:
                return
            await asyncio.sleep(interval)

    async def session(self, resume):
        """One gateway connection, until it ends. (kind, reason, established): kind is resume, fresh, fatal or lost."""
        url = self.resume_url if resume and self.resume_url else self.gateway_url
        ws = WebSocket(self.cfg)
        self.ws = ws
        beat = None
        established = False
        try:
            await ws.connect(url.rstrip("/") + "/?v=10&encoding=json")
            kind, text = await ws.recv(self.cfg.command_timeout)
            hello = self.decode(text) if kind == "text" else None
            data = hello.get("d") if hello and hello.get("op") == 10 else None
            interval = data.get("heartbeat_interval") if isinstance(data, dict) else None
            if isinstance(interval, bool) or not isinstance(interval, (int, float)) or not 0 < interval <= 600_000:
                return "lost", "no_hello", False
            interval = max(interval / 1000.0, 0.05)
            self.heartbeat_acked = True
            beat = asyncio.get_running_loop().create_task(self.heartbeat(ws, interval))
            if resume and self.session_id:
                await ws.send_json({"op": 6, "d": {"token": self.token, "session_id": self.session_id, "seq": self.seq}})
            else:
                self.identifies += 1
                await ws.send_json({"op": 2, "d": {"token": self.token, "intents": DISCORD_INTENTS, "large_threshold": 50,
                                                   "properties": {"os": "linux", "browser": "hivra-doorbell",
                                                                  "device": "hivra-doorbell"}}})
            while True:
                kind, text = await ws.recv(interval * 2 + 10.0)
                if kind == "close":
                    out = self.after_close(text)
                    return out[0], out[1], established
                payload = self.decode(text) if kind == "text" else None
                if payload is None:
                    continue
                seq = payload.get("s")
                if isinstance(seq, int) and not isinstance(seq, bool):
                    self.seq = seq
                op = payload.get("op")
                if op == 0:
                    event = payload.get("t")
                    if event == "READY":
                        if not self.take_ready(payload.get("d")):
                            return "fatal", "bad_ready", established
                        established = True
                        if self.state == "arming":
                            self.state = "armed"
                            if self.ready is not None and not self.ready.done():
                                self.ready.set_result(True)
                    elif event == "RESUMED":
                        established = True
                    else:
                        self.on_dispatch(event, payload.get("d"))
                elif op == 1:
                    await ws.send_json({"op": 1, "d": self.seq})
                elif op == 11:
                    self.heartbeat_acked = True
                elif op == 7:
                    return "resume", "reconnect", established
                elif op == 9:
                    return ("resume" if payload.get("d") is True else "fresh"), "invalid_session", established
        except DiscordError as error:
            return "lost", error.reason, established
        finally:
            if beat is not None:
                beat.cancel()
            await ws.close(self.close_code)
            if self.ws is ws:
                self.ws = None

    @staticmethod
    def decode(text):
        try:
            value = json.loads(text)
        except (TypeError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def remember_thread(self, item):
        if not isinstance(item, dict) or len(self.threads) >= DISCORD_MAX_MAP:
            return
        tid, parent = str(item.get("id") or ""), str(item.get("parent_id") or "")
        if SNOWFLAKE_RE.match(tid) and SNOWFLAKE_RE.match(parent):
            self.threads[tid] = (parent, str(item.get("owner_id") or ""))

    def remember_name(self, item):
        if not isinstance(item, dict) or len(self.names) >= DISCORD_MAX_MAP:
            return
        cid, name = str(item.get("id") or ""), item.get("name")
        if SNOWFLAKE_RE.match(cid) and isinstance(name, str) and len(name) <= 100:
            self.names[cid] = channel_key(name)

    def on_dispatch(self, event, data):
        if not isinstance(data, dict):
            return
        if event == "MESSAGE_CREATE":
            if self.state == "armed" and discord_message_wakes(data, self.bot_id, self.rules, self.threads, self.names):
                channel_id = str(data.get("channel_id") or "")
                self.fire("message", channel_id if SNOWFLAKE_RE.match(channel_id) else None)
        elif event == "GUILD_CREATE":
            for item in (data.get("channels") or [])[:5000] if isinstance(data.get("channels"), list) else []:
                self.remember_name(item)
            for item in (data.get("threads") or [])[:5000] if isinstance(data.get("threads"), list) else []:
                self.remember_thread(item)
        elif event in ("CHANNEL_CREATE", "CHANNEL_UPDATE"):
            self.remember_name(data)
        elif event in ("THREAD_CREATE", "THREAD_UPDATE"):
            self.remember_thread(data)
        elif event == "THREAD_LIST_SYNC":
            for item in (data.get("threads") or [])[:5000] if isinstance(data.get("threads"), list) else []:
                self.remember_thread(item)
        elif event in ("THREAD_DELETE", "CHANNEL_DELETE"):
            self.threads.pop(str(data.get("id") or ""), None)
            self.names.pop(str(data.get("id") or ""), None)

    def fire(self, reason, channel_id=None):
        """Starts ringing (once). The gateway session stays up until the disarm's linger ends."""
        if self.state != "armed":
            return
        self.state = "fired"
        self.fired_reason = reason
        self.fired_at = self.cfg.clock()
        self.doorbell.persist()
        log("ring", vmid=self.vmid, reason=reason, channel="discord")
        self.ring_task = asyncio.get_running_loop().create_task(self.ring(channel_id))

    async def ring(self, channel_id):
        while self.state == "fired":
            answer = await self.doorbell.request_wake(self.vmid)
            self.requests += 1
            self.last_answer = answer
            log("wake_request", vmid=self.vmid, ok=bool(answer and answer.get("ok")),
                state=(answer or {}).get("state"), error=(answer or {}).get("error"))
            if channel_id and self.typing is None and answer and answer.get("ok") and self.token:
                await self.send_typing(channel_id)
            if self.cfg.clock() - self.fired_at >= self.cfg.fire_max:
                if ring_settled(answer):
                    self.state = "expired"
                    log("ring_expired", vmid=self.vmid, requests=self.requests)
                    self.doorbell.forget(self)
                    await self.stop()
                    return
                await asyncio.sleep(self.cfg.fire_slow)
                continue
            await asyncio.sleep(self.cfg.fire_retry)

    async def send_typing(self, channel_id):
        """One typing indicator, so the sender sees the agent coming. Never a message."""
        try:
            status, _ = await asyncio.wait_for(
                discord_http(self.cfg, "POST", "/channels/%s/typing" % channel_id, self.token), self.cfg.command_timeout)
            self.typing = status
        except (DiscordError, asyncio.TimeoutError):
            self.typing = 0
        log("discord_typing", vmid=self.vmid, status=self.typing)

    def linger(self):
        """The disarm: stop ringing, stay connected while the agent comes back, then close."""
        self.state = "lingering"
        current = asyncio.current_task()
        if self.ring_task is not None and self.ring_task is not current:
            self.ring_task.cancel()
        self.doorbell.lingering[self.vmid] = self
        self.linger_task = asyncio.get_running_loop().create_task(self.end_linger())

    async def end_linger(self):
        await asyncio.sleep(self.cfg.discord_linger)
        if self.doorbell.lingering.get(self.vmid) is self:
            del self.doorbell.lingering[self.vmid]
        await self.stop()

    async def halt(self, close_code):
        current = asyncio.current_task()
        self.close_code = close_code
        for task in (self.ring_task, self.linger_task, self.task):
            if task is not None and task is not current and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        if self.ws is not None:
            await self.ws.close(close_code)
            self.ws = None

    async def stop(self):
        if self.state != "expired":
            self.state = "disarmed"
        await self.halt(1000)
        self.token = None
        self.fail_ready("stopped")
        if self.ready is not None and self.ready.done() and not self.ready.cancelled():
            self.ready.exception()


# ---------------------------------------------------------------- the service

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
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path, limit=CTL_MAX_LINE * 2), timeout)
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


def write_atomic(path, data):
    temp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)


class Doorbell(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.watches = {}
        # Discord sessions kept open for a while after their disarm, by vmid.
        self.lingering = {}
        self.server = None
        self.restored = []

    async def start(self):
        os.makedirs(self.cfg.run_dir, mode=0o700, exist_ok=True)
        lost = self.read_state()
        try:
            if stat.S_ISSOCK(os.lstat(self.cfg.ctl_path).st_mode):
                os.unlink(self.cfg.ctl_path)
        except FileNotFoundError:
            pass
        self.server = await asyncio.start_unix_server(self.handle, path=self.cfg.ctl_path, limit=CTL_MAX_LINE * 2)
        os.chmod(self.cfg.ctl_path, 0o600)
        # A restart lost every credential it held: each computer that was armed is woken instead of left deaf.
        for vmid, arm_id in lost:
            watch = Watch(self, {"vmid": vmid, "arm_id": arm_id, "imap": None, "self": "", "allowed": frozenset()})
            self.watches[vmid] = watch
            watch.task = asyncio.get_running_loop().create_task(watch.ring("restart"))
            self.restored.append(vmid)
        log("doorbell_ready", version=VERSION, rang_for_lost=len(lost))

    async def stop(self):
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        for watch in list(self.watches.values()):
            # Keeps the armed list on disk: a restart rings for each of them.
            await watch.halt(4000)
        for watch in list(self.lingering.values()):
            await watch.stop()
        self.lingering.clear()

    def read_state(self):
        try:
            with open(self.cfg.state_path, "rb") as handle:
                data = json.loads(handle.read(256 * 1024).decode("utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            log("state_unreadable")
            return []
        out = []
        for entry in data.get("armed", []) if isinstance(data, dict) else []:
            if not isinstance(entry, dict):
                continue
            vmid = parse_vmid(entry.get("vmid"))
            arm_id = entry.get("arm_id")
            if vmid is not None and isinstance(arm_id, str) and ARM_ID_RE.match(arm_id):
                out.append((vmid, arm_id))
        return out[:MAX_ARMED]

    def persist(self):
        entries = [{"vmid": w.vmid, "arm_id": w.arm_id} for w in self.watches.values() if w.state in ("armed", "fired")]
        try:
            write_atomic(self.cfg.state_path, (json.dumps({"armed": entries}, sort_keys=True) + "\n").encode("utf-8"))
        except OSError:
            log("state_write_failed")

    def forget(self, watch):
        if self.watches.get(watch.vmid) is watch:
            del self.watches[watch.vmid]
        self.persist()

    async def request_wake(self, vmid):
        return await unix_request(self.cfg.helper_ctl, {"cmd": "request", "vmid": vmid, "from": "doorbell"}, CTL_TIMEOUT + 10.0)

    async def helper_health(self):
        return await unix_request(self.cfg.helper_ctl, {"cmd": "health"}, CTL_TIMEOUT)

    async def handle(self, reader, writer):
        try:
            if peer_uid(writer) not in self.cfg.root_uids:
                log("ctl_refused")
                answer = {"ok": False, "error": "forbidden"}
            else:
                try:
                    line = await asyncio.wait_for(reader.readline(), CTL_TIMEOUT)
                    request = json.loads(line.decode("utf-8"))
                    if not isinstance(request, dict):
                        raise ValueError("not an object")
                except (ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                    answer = {"ok": False, "error": "bad_request"}
                else:
                    answer = await self.dispatch(request)
            writer.write((json.dumps(answer, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8"))
            await writer.drain()
        except (OSError, ConnectionError):
            pass
        finally:
            writer.close()

    async def dispatch(self, request):
        command = request.get("cmd")
        try:
            if command == "health":
                helper = await self.helper_health()
                return {"ok": True, "version": VERSION, "armed": sum(1 for w in self.watches.values() if w.state == "armed"),
                        "fired": sum(1 for w in self.watches.values() if w.state == "fired"),
                        "lingering": len(self.lingering),
                        "helper": bool(helper and helper.get("ok")), "credential": bool(helper and helper.get("credential"))}
            if command == "status":
                if request.get("vmid") is None:
                    held = dict(self.lingering)
                    held.update(self.watches)
                    return {"ok": True, "vms": {str(v): w.view() for v, w in sorted(held.items())}}
                vmid = parse_vmid(request.get("vmid"))
                if vmid is None:
                    return {"ok": False, "error": "bad_vmid"}
                watch = self.watches.get(vmid) or self.lingering.get(vmid)
                return {"ok": True, "vmid": vmid, "state": watch.state if watch else "none",
                        **({"watch": watch.view()} if watch else {})}
            if command == "arm":
                return await self.arm(request)
            if command == "disarm":
                return await self.disarm(request)
            return {"ok": False, "error": "unknown_command"}
        except Exception as error:  # a command must always get an answer
            log("ctl_error", cmd=command if command in ("health", "status", "arm", "disarm") else "other",
                kind=type(error).__name__)
            return {"ok": False, "error": "internal_error"}

    async def arm(self, request):
        try:
            arm = parse_arm(request)
        except BadRequest:
            return {"ok": False, "error": "bad_request"}
        vmid = arm["vmid"]
        if vmid not in self.watches and len(self.watches) >= MAX_ARMED:
            return {"ok": False, "vmid": vmid, "error": "too_many"}
        helper = await self.helper_health()
        if not (helper and helper.get("ok") and helper.get("credential")):
            # Without a way to ask Hivra for a wake, an arm would leave the computer deaf.
            return {"ok": False, "vmid": vmid, "error": "helper_unready"}
        previous = self.watches.pop(vmid, None)
        if previous is not None:
            await previous.stop()
        lingering = self.lingering.pop(vmid, None)
        if lingering is not None:
            # One doorbell session per computer: the old one closes before the new one logs in.
            await lingering.stop()
        watch = DiscordWatch(self, arm) if arm["channel"] == "discord" else Watch(self, arm)
        t0 = mono()
        try:
            await asyncio.wait_for(watch.arm(), self.cfg.arm_timeout)
        except asyncio.TimeoutError:
            await watch.stop()
            self.persist()
            return {"ok": False, "vmid": vmid, "error": "arm_timeout"}
        except (ImapError, DiscordError) as error:
            await watch.stop()
            self.persist()
            log("arm_failed", vmid=vmid, reason=error.reason)
            return {"ok": False, "vmid": vmid, "error": error.reason}
        self.watches[vmid] = watch
        watch.start()
        self.persist()
        log("armed", vmid=vmid, ms=int((mono() - t0) * 1000), **watch.armed_log())
        return watch.armed_answer()

    async def disarm(self, request):
        vmid = parse_vmid(request.get("vmid"))
        if vmid is None:
            return {"ok": False, "error": "bad_vmid"}
        arm_id = request.get("arm_id")
        watch = self.watches.get(vmid)
        if watch is None:
            return {"ok": True, "vmid": vmid, "was": "none"}
        if arm_id is not None and arm_id != watch.arm_id:
            # A disarm for an older arm never takes down the current one.
            return {"ok": True, "vmid": vmid, "was": "other_arm"}
        was = watch.state
        del self.watches[vmid]
        if isinstance(watch, DiscordWatch):
            watch.linger()
        else:
            await watch.stop()
        self.persist()
        log("disarmed", vmid=vmid, was=was)
        return {"ok": True, "vmid": vmid, "was": was}


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


# ---------------------------------------------------------------- command line

def read_stdin_json(limit=CTL_MAX_LINE):
    raw = sys.stdin.buffer.read(limit + 1)
    if len(raw) > limit:
        return None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def ctl_main(cfg=None):
    cfg = cfg or Config()
    request = read_stdin_json()
    if request is None:
        sys.stdout.write('{"error":"bad_request","ok":false}\n')
        return 2
    answer = asyncio.run(unix_request(cfg.ctl_path, request, CTL_TIMEOUT + cfg.arm_timeout + 2.0))
    if answer is None:
        sys.stdout.write('{"error":"unreachable","ok":false}\n')
        return 2
    sys.stdout.write(json.dumps(answer, separators=(",", ":"), sort_keys=True) + "\n")
    return 0 if answer.get("ok") else 1


def env_list(value):
    """An allowlist as Hermes reads it: a JSON list literal, or comma-separated."""
    value = (value or "").strip()
    if value.startswith("["):
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        if isinstance(parsed, list):
            return [str(item).strip().lower() for item in parsed if str(item).strip()]
    return [item.strip().lower() for item in value.split(",") if item.strip()]


def truthy(value, default):
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in ("true", "1", "yes")


def discord_arm_request(values, vmid, arm_id):
    """The Discord arm request from the computer's .env values, read the way Hermes reads them."""
    get = lambda key: values.get(key) if isinstance(values.get(key), str) else ""
    allow_bots = get("DISCORD_ALLOW_BOTS").strip().lower() or "none"
    return {
        "cmd": "arm", "vmid": vmid, "arm_id": arm_id, "channel": "discord",
        "discord": {
            "token": get("DISCORD_BOT_TOKEN").strip(),
            "require_mention": get("DISCORD_REQUIRE_MENTION").strip().lower() not in ("false", "0", "no", "off"),
            "thread_require_mention": get("DISCORD_THREAD_REQUIRE_MENTION").strip().lower() in ("true", "1", "yes", "on"),
            "allow_bots": allow_bots if allow_bots in ("none", "mentions", "all") else "none",
            "free_channels": env_list(get("DISCORD_FREE_RESPONSE_CHANNELS"))[:500],
            # config.yaml sets reply rules the host cannot read exactly: then every guild message wakes.
            "wake_all_guild": get("_yaml_gates") == "1",
        },
    }


def arm_request_from_guest(lines, vmid, arm_id, fingerprint, channel="email"):
    """Builds the arm request from the guest read program's output. (request, None) or (None, reason)."""
    prefix, none_prefix = CRED_PREFIXES[channel]
    found = [line[len(prefix):] for line in lines if line.startswith(prefix)]
    if len(found) != 1:
        none = [line for line in lines if line.startswith(none_prefix)]
        reason = none[0].split(" ", 1)[1].strip() if len(none) == 1 else "no_answer"
        return None, reason if re.match(r"^[a-z_]{1,40}$", reason) else "no_answer"
    try:
        doc = json.loads(found[0])
    except ValueError:
        return None, "bad_answer"
    values = doc.get("values") if isinstance(doc, dict) else None
    if not isinstance(values, dict) or doc.get("fp") != fingerprint:
        return None, "credential_changed"
    if channel == "discord":
        request = discord_arm_request(values, vmid, arm_id)
        try:
            parse_arm(request)
        except BadRequest:
            return None, "bad_settings"
        return request, None
    get = lambda key: values.get(key) if isinstance(values.get(key), str) else None
    address = (get("EMAIL_ADDRESS") or "").strip()
    port_text = (get("EMAIL_IMAP_PORT") or "993").strip()
    if not re.match(r"^[0-9]{1,5}$", port_text):
        return None, "bad_port"
    security = SECURITY.get((get("EMAIL_IMAP_SECURITY") or "tls").strip().lower())
    if security is None:
        return None, "bad_security"
    allowed = env_list(get("EMAIL_ALLOWED_USERS")) + env_list(get("GATEWAY_ALLOWED_USERS"))
    request = {
        "cmd": "arm", "vmid": vmid, "arm_id": arm_id, "channel": "email",
        "imap": {"host": (get("EMAIL_IMAP_HOST") or "").strip(), "port": int(port_text), "security": security,
                 "verify": truthy(get("EMAIL_IMAP_TLS_VERIFY"), True), "user": address,
                 "password": get("EMAIL_PASSWORD") or ""},
        "self": address.lower(), "allowed": allowed,
    }
    try:
        parse_arm(request)
    except BadRequest:
        return None, "bad_settings"
    return request, None


def arm_from_guest_main(argv, cfg=None):
    cfg = cfg or Config()

    def emit(answer):
        sys.stdout.write(ARM_PREFIX + json.dumps(answer, separators=(",", ":"), sort_keys=True) + "\n")

    vmid = parse_vmid(argv[0]) if len(argv) in (3, 4) else None
    channel = argv[3] if len(argv) == 4 else "email"
    if vmid is None or not ARM_ID_RE.match(argv[1]) or not FP_RE.match(argv[2]) or channel not in CRED_PREFIXES:
        emit({"ok": False, "error": "bad_arguments"})
        return 2
    raw = sys.stdin.buffer.read(CTL_MAX_LINE + 1)
    if len(raw) > CTL_MAX_LINE:
        emit({"ok": False, "error": "bad_answer"})
        return 1
    request, reason = arm_request_from_guest(raw.decode("utf-8", "replace").splitlines(), vmid, argv[1], argv[2], channel)
    raw = None
    if request is None:
        emit({"ok": False, "vmid": vmid, "error": reason})
        return 1
    answer = asyncio.run(unix_request(cfg.ctl_path, request, CTL_TIMEOUT + cfg.arm_timeout + 2.0))
    request = None
    if answer is None:
        emit({"ok": False, "vmid": vmid, "error": "doorbell_unreachable"})
        return 2
    keep = ("ok", "vmid", "arm_id", "uidvalidity", "uidnext", "idle", "channel", "login_remaining", "error")
    emit({key: answer.get(key) for key in keep if key in answer})
    return 0 if answer.get("ok") else 1


def main(argv):
    mode = argv[0] if argv else ""
    if mode == "serve":
        asyncio.run(run_service(Doorbell(Config())))
        return 0
    if mode == "ctl":
        return ctl_main()
    if mode == "arm-from-guest":
        return arm_from_guest_main(argv[1:])
    sys.stderr.write("usage: hivra-wake-doorbell.py serve | ctl < request.json | arm-from-guest <vmid> <arm_id> <fp> [email|discord]\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
