#!/usr/bin/env python3
"""Hivra local bridge: lets an agent run one command on the owner's own computer.

This is a separate, user-mode run of the connector's outbound channel. Start it
yourself, as yourself, with `python3 hivra_bridge.py run`; stopping the process
is the off switch. Nothing listens on this machine: the bridge dials out to
Hivra's relay and holds one control socket.

It speaks exactly one message, `exec`: an argument list (never a shell string),
a working folder inside a folder you allowed in the config, a time limit (at
most 120 s) and an output cap (at most 1 MiB). It returns stdout, stderr and the
exit status. There is no shell, no terminal, no port forwarding and no file
transfer.

Every request must carry a ticket minted by Hivra's control plane only after
you approved that exact command in the Hivra dashboard. The ticket is bound to
you, one agent, this computer and the exact argument list; it lives at most
120 s and works once. Every request, allowed or refused, is appended to
log.jsonl next to the config.

Standard library only (Python 3.8+). Exit status 3 means Hivra revoked this
bridge; it does not restart by itself.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import signal
import stat
import subprocess
import sys
import threading
import time

import hivra_connector as hc

VERSION = "2026.11.11.1"
EXIT_REVOKED = hc.EXIT_REVOKED
TICKET_MAX_LIFETIME_SECONDS = 120
MAX_TIMEOUT_SECONDS = 120
DEFAULT_TIMEOUT_SECONDS = 30
MAX_OUTPUT_BYTES = 1024 * 1024
DEFAULT_OUTPUT_BYTES = 256 * 1024
MAX_ARGV_ITEMS = 64
MAX_ARG_LENGTH = 4096
MAX_REPLY_BYTES = 900 * 1024  # the relay's socket messages top out at 1 MiB
DEFAULT_CONFIG = os.path.join("~", ".config", "hivra-bridge", "config.json")
LOG_NAME = "log.jsonl"
CHILD_ENV_KEYS = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL")


class BridgeError(Exception):
    """A request the bridge refuses. `code` is what the agent is told."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


# --- configuration --------------------------------------------------------


def load_bridge_config(path):
    path = os.path.expanduser(path)
    if os.name == "posix":
        mode = os.stat(path).st_mode
        if mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise hc.ConnectorError("%s must not be readable by anyone else (chmod 600)" % path)
    base = hc.load_config(path)
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    bridge_key = str(raw.get("bridgeKey", ""))
    if len(bridge_key) != 64 or not all(c in "0123456789abcdef" for c in bridge_key):
        raise hc.ConnectorError("bridgeKey must be 64 hex characters")
    owner = str(raw.get("ownerId", ""))
    if not owner or len(owner) > 200:
        raise hc.ConnectorError("ownerId is missing")
    computer = str(raw.get("computerId", ""))
    if computer != base["connectionId"]:
        raise hc.ConnectorError("computerId must equal connectionId")
    folders = raw.get("allowedFolders")
    if not isinstance(folders, list) or not folders:
        raise hc.ConnectorError("allowedFolders must list at least one folder; your home folder is not allowed by default")
    allowed = []
    for folder in folders:
        folder = os.path.expanduser(str(folder))
        if not os.path.isabs(folder) or not os.path.isdir(folder):
            raise hc.ConnectorError("allowed folder is not an existing absolute folder: %s" % folder)
        real = os.path.realpath(folder)
        if real == os.path.sep:
            raise hc.ConnectorError("the root folder cannot be allowed")
        if real == os.path.realpath(os.path.expanduser("~")):
            raise hc.ConnectorError("your whole home folder cannot be allowed; list the folders you mean")
        allowed.append(real)
    base.update({
        "bridgeKey": bridge_key,
        "ownerId": owner,
        "computerId": computer,
        "allowedFolders": allowed,
        "logPath": os.path.join(os.path.dirname(path), LOG_NAME),
    })
    return base


# --- request validation, cwd and tickets -----------------------------------


def argv_hash(argv):
    """sha256 over the UTF-8 items joined by NUL; the control plane computes the same."""
    return hashlib.sha256("\0".join(argv).encode("utf-8")).hexdigest()


def validate_request(request):
    if not isinstance(request, dict):
        raise BridgeError("invalid_request", "The request is not an object.")
    argv = request.get("argv")
    if not isinstance(argv, list) or not 1 <= len(argv) <= MAX_ARGV_ITEMS:
        raise BridgeError("invalid_request", "argv must be a list of 1 to %d strings." % MAX_ARGV_ITEMS)
    for item in argv:
        if not isinstance(item, str) or len(item) > MAX_ARG_LENGTH or "\0" in item:
            raise BridgeError("invalid_request", "Every argv item must be a string without NUL, at most %d characters." % MAX_ARG_LENGTH)
    if not argv[0]:
        raise BridgeError("invalid_request", "argv[0] is empty.")
    cwd = request.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or not cwd or "\0" in cwd or len(cwd) > 4096):
        raise BridgeError("invalid_request", "cwd must be a folder path.")
    timeout = request.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= MAX_TIMEOUT_SECONDS:
        raise BridgeError("invalid_request", "timeoutSeconds must be 1 to %d." % MAX_TIMEOUT_SECONDS)
    cap = request.get("maxOutputBytes", DEFAULT_OUTPUT_BYTES)
    if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= MAX_OUTPUT_BYTES:
        raise BridgeError("invalid_request", "maxOutputBytes must be 1 to %d." % MAX_OUTPUT_BYTES)
    return {"argv": list(argv), "cwd": cwd, "timeoutSeconds": timeout, "maxOutputBytes": cap}


def resolve_cwd(config, cwd):
    """The real folder to run in. Omitted means the first allowed folder; anything else must sit inside one."""
    if cwd is None:
        return config["allowedFolders"][0]
    expanded = os.path.expanduser(cwd)
    if not os.path.isabs(expanded):
        raise BridgeError("cwd_not_allowed", "cwd must be an absolute path inside an allowed folder.")
    real = os.path.realpath(expanded)  # follows symlinks, so a link cannot lead out
    for folder in config["allowedFolders"]:
        if real == folder or real.startswith(folder.rstrip(os.path.sep) + os.path.sep):
            if not os.path.isdir(real):
                raise BridgeError("cwd_not_allowed", "That folder does not exist.")
            return real
    raise BridgeError("cwd_not_allowed", "That folder is not inside a folder this bridge allows.")


def b64url_decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class TicketVerifier:
    """Checks a ticket's signature, binding and expiry, and refuses a second use."""

    def __init__(self, config, clock=time.time):
        self.config = config
        self.clock = clock
        self.seen = {}
        self.lock = threading.Lock()

    def verify(self, ticket, request):
        now = int(self.clock())
        try:
            body, signature = str(ticket).split(".")
            expected = base64.urlsafe_b64encode(hmac.new(self.config["bridgeKey"].encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip("=")
            if not hmac.compare_digest(expected, signature):
                raise ValueError("signature")
            claims = json.loads(b64url_decode(body).decode("utf-8"))
        except (ValueError, TypeError, UnicodeError):
            raise BridgeError("ticket_invalid", "The ticket is not valid.")
        if not isinstance(claims, dict) or claims.get("v") != 1:
            raise BridgeError("ticket_invalid", "The ticket is not valid.")
        exp, iat, jti = claims.get("exp"), claims.get("iat"), claims.get("jti")
        if not isinstance(exp, int) or not isinstance(iat, int) or not isinstance(jti, str) or not 16 <= len(jti) <= 64:
            raise BridgeError("ticket_invalid", "The ticket is not valid.")
        if exp <= now:
            raise BridgeError("ticket_expired", "The ticket has expired.")
        if exp > now + TICKET_MAX_LIFETIME_SECONDS or exp - iat > TICKET_MAX_LIFETIME_SECONDS or exp <= iat:
            raise BridgeError("ticket_invalid", "The ticket lives too long.")
        agent = claims.get("agent")
        if not isinstance(agent, str) or not agent:
            raise BridgeError("ticket_invalid", "The ticket names no agent.")
        if claims.get("aud") != self.config["connectionId"] or claims.get("computer") != self.config["computerId"]:
            raise BridgeError("ticket_wrong_computer", "The ticket is for another computer.")
        if claims.get("owner") != self.config["ownerId"]:
            raise BridgeError("ticket_wrong_owner", "The ticket is for another owner.")
        with self.lock:
            for key in [key for key, until in self.seen.items() if until <= now]:
                del self.seen[key]
            if jti in self.seen:
                raise BridgeError("ticket_replayed", "The ticket was already used.")
            self.seen[jti] = exp
        if claims.get("argv") != argv_hash(request["argv"]):
            raise BridgeError("ticket_argv_mismatch", "The ticket was not issued for this command.")
        if (claims.get("cwd") or "") != (request["cwd"] or ""):
            raise BridgeError("ticket_argv_mismatch", "The ticket was not issued for this folder.")
        return {"agent": agent, "jti": jti}


# --- running one command ----------------------------------------------------


def child_env():
    return {key: os.environ[key] for key in CHILD_ENV_KEYS if key in os.environ}


def run_command(request, cwd, on_start=None):
    """Run argv without a shell and no stdin. Returns the reply fields for the request."""
    started = time.monotonic()
    cap = request["maxOutputBytes"]
    try:
        process = subprocess.Popen(
            request["argv"], cwd=cwd, env=child_env(), shell=False,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, close_fds=True,
        )
    except FileNotFoundError:
        return {"stdout": "", "stderr": "command not found: %s\n" % request["argv"][0], "exitCode": 127, "truncated": False, "durationMs": 0}
    except OSError as error:
        return {"stdout": "", "stderr": "could not start: %s\n" % error, "exitCode": 126, "truncated": False, "durationMs": 0}
    if on_start:
        on_start(process)
    state = {"used": 0, "truncated": False}
    lock = threading.Lock()
    chunks = {"out": [], "err": []}

    def drain(stream, key):
        while True:
            data = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
            if not data:
                return
            with lock:
                room = cap - state["used"]
                if len(data) > room:
                    state["truncated"] = True
                    data = data[: max(room, 0)]
                state["used"] += len(data)
                if data:
                    chunks[key].append(data)

    readers = [threading.Thread(target=drain, args=(process.stdout, "out"), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, "err"), daemon=True)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=request["timeoutSeconds"])
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_group(process)
        process.wait()
    for reader in readers:
        reader.join(timeout=5)
    process.stdout.close()
    process.stderr.close()
    stdout = b"".join(chunks["out"]).decode("utf-8", errors="replace")
    stderr = b"".join(chunks["err"]).decode("utf-8", errors="replace")
    code = process.returncode
    if timed_out:
        stderr += "\nhivra-bridge: stopped after %d seconds\n" % request["timeoutSeconds"]
        code = 124
    elif code is not None and code < 0:
        code = 128 + (-code)
    return {"stdout": stdout, "stderr": stderr, "exitCode": code, "truncated": state["truncated"],
            "durationMs": int((time.monotonic() - started) * 1000)}


def kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, AttributeError):
        try:
            process.kill()
        except OSError:
            pass


def fit_reply(reply):
    """Shrink stdout and stderr until the serialized reply fits one relay message."""
    while len(json.dumps(reply).encode()) > MAX_REPLY_BYTES:
        reply["truncated"] = True
        reply["stdout"] = reply["stdout"][: len(reply["stdout"]) // 2]
        reply["stderr"] = reply["stderr"][: len(reply["stderr"]) // 2]
    return reply


# --- the bridge --------------------------------------------------------------


class Bridge:
    def __init__(self, config, clock=time.time):
        self.config = config
        self.verifier = TicketVerifier(config, clock=clock)
        self.running = threading.Lock()  # one command at a time
        self.current = None
        self.log_lock = threading.Lock()

    def log_request(self, agent, request, cwd, exit_code, decision, reason=None):
        entry = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
            "computer": self.config["computerId"],
            "agent": agent,
            "argv": request.get("argv") if isinstance(request, dict) else None,
            "cwd": cwd,
            "exitCode": exit_code,
            "decision": decision,
        }
        if reason:
            entry["reason"] = reason
        with self.log_lock:
            fd = os.open(self.config["logPath"], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry) + "\n")

    def handle_exec(self, message):
        """Returns the reply for one exec message. Never raises."""
        request_id = message.get("id")
        reply = {"type": "exec_result", "id": request_id}
        agent = None
        request = None
        try:
            request = validate_request(message.get("request"))
            claims = self.verifier.verify(message.get("ticket"), request)
            agent = claims["agent"]
            cwd = resolve_cwd(self.config, request["cwd"])
        except BridgeError as error:
            raw = message.get("request") if isinstance(message.get("request"), dict) else {}
            self.log_request(agent, raw, raw.get("cwd"), None, "denied", error.code)
            reply.update({"ok": False, "error": error.code, "message": str(error)})
            return reply
        if not self.running.acquire(blocking=False):
            self.log_request(agent, request, cwd, None, "denied", "busy")
            reply.update({"ok": False, "error": "busy", "message": "The bridge is already running a command."})
            return reply
        try:
            result = run_command(request, cwd, on_start=lambda process: setattr(self, "current", process))
        finally:
            self.current = None
            self.running.release()
        self.log_request(agent, request, cwd, result["exitCode"], "approved")
        reply.update({"ok": True})
        reply.update(result)
        return fit_reply(reply)

    def stop_running(self):
        process = self.current
        if process is not None:
            kill_group(process)

    def control_session(self):
        """Hold one control socket until it drops. Returns 'revoked' or 'reconnect'."""
        control = hc.WebSocket(self.url("agent"), hc.connector_headers(self.config, "agent"))
        hc.log("bridge connected to Hivra")
        stop = threading.Event()

        def keepalive():
            while not stop.wait(hc.KEEPALIVE_SECONDS):
                try:
                    control.send_text('{"type":"ping"}')
                except (OSError, hc.ConnectorError):
                    return

        def execute(message):
            reply = self.handle_exec(message)
            try:
                control.send_text(json.dumps(reply))
            except (OSError, hc.ConnectorError):
                pass

        threading.Thread(target=keepalive, daemon=True).start()
        try:
            while True:
                incoming = control.receive()
                if incoming is None:
                    return "reconnect"
                if incoming[0] != 0x1:
                    continue
                try:
                    body = json.loads(incoming[1].decode())
                except ValueError:
                    continue
                if not isinstance(body, dict):
                    continue
                kind = body.get("type")
                if kind == "exec":
                    threading.Thread(target=execute, args=(body,), daemon=True).start()
                elif kind == "closing":
                    return "revoked" if body.get("reason") == "revoked" else "reconnect"
        except (OSError, hc.ConnectorError):
            return "reconnect"
        finally:
            stop.set()
            control.close()

    def url(self, suffix):
        return "%s/v1/hosts/%s/%s" % (self.config["relay"], self.config["connectionId"], suffix)

    def run(self):
        delay = 1.0
        while True:
            started = time.monotonic()
            try:
                outcome = self.control_session()
            except (OSError, hc.ConnectorError) as error:
                hc.log("relay unavailable: %s" % error)
                outcome = "reconnect"
            if outcome == "revoked":
                self.stop_running()
                hc.log("Hivra revoked this bridge. Exiting.")
                return EXIT_REVOKED
            if time.monotonic() - started > 60:
                delay = 1.0
            time.sleep(delay)
            delay = min(delay * 2, 60.0)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hivra-bridge", description="Let your Hivra agents run approved commands on this computer.")
    parser.add_argument("command", choices=["run", "check", "version"])
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    if args.command == "version":
        print(VERSION)
        return 0
    try:
        bridge = Bridge(load_bridge_config(args.config))
        if args.command == "check":
            hc.WebSocket(bridge.url("agent"), hc.connector_headers(bridge.config, "agent")).close()
            return 0
        return bridge.run()
    except (OSError, ValueError, hc.ConnectorError) as error:
        hc.log(str(error))
        return 2


if __name__ == "__main__":
    sys.exit(main())
