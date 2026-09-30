#!/usr/bin/env python3
"""One-purpose first-boot enrollment. Not an agent or a readiness authority.

Recipe 2026.09.24.1: the server may be powered on long after it was created,
so this helper measures its 15 minutes from this machine's first boot, not
from an absolute expiry. Hivra's receiver is the authority: it accepts the
proof only inside the window Hivra opened when it powered this server on.
This check is a convenience that stops a late guest from calling at all.
"""
import base64
import hashlib
import http.client
import json
import os
import re
import signal
import ssl
import stat
import sys
import time
from urllib.parse import urlsplit

# cloud-init writes this file with its per-instance write_files module, into
# /run (tmpfs), during the instance's first boot only. It is gone after any
# reboot, so while it exists the current boot is the first boot and
# /proc/uptime is the time since the first boot.
CONFIG_PATH = "/run/hivra/first-boot-enrollment.json"
UPTIME_PATH = "/proc/uptime"
HOST_KEY_PATH = "/etc/ssh/ssh_host_ed25519_key.pub"
CALLBACK_PATH = "/api/infrastructure/first-boot/enroll"
RECIPE_VERSION = "2026.09.24.1"
CONFIG_VERSION = 2
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TOKEN_RE = re.compile(r"^hbe1_[A-Za-z0-9_-]{43}$")
ID_RE = re.compile(r"^[1-9][0-9]{0,15}$")
KEY_RE = re.compile(r"^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [\x21-\x7e]{1,128})?$")
PREFIX = bytes.fromhex("0000000b7373682d6564323535313900000020")
TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504}
MAX_RESPONSE = 4096
MAX_ATTEMPTS = 6
WINDOW_SECONDS = 90
SETUP_WINDOW_SECONDS = 900


class EnrollmentFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise EnrollmentFailure(code)


def read_uptime(path=UPTIME_PATH):
    """Seconds since this boot, from the kernel; independent of the wall clock."""
    try:
        with open(path, "r", encoding="ascii") as handle:
            raw = handle.read(128)
        seconds = float(raw.split()[0])
    except (OSError, ValueError, IndexError, UnicodeError):
        fail("BOOT_CLOCK_UNAVAILABLE")
    if seconds != seconds or seconds < 0 or seconds == float("inf"):
        fail("BOOT_CLOCK_UNAVAILABLE")
    return seconds


def validate_config(value, uptime=read_uptime):
    fields = {"version", "recipeVersion", "orderId", "attemptId", "token", "callbackUrl"}
    if not isinstance(value, dict) or set(value) != fields:
        fail("INVALID_CONFIGURATION")
    if type(value["version"]) is not int or value["version"] != CONFIG_VERSION:
        fail("INVALID_CONFIGURATION")
    if value["recipeVersion"] != RECIPE_VERSION:
        fail("INVALID_CONFIGURATION")
    for field in ("orderId", "attemptId"):
        if not isinstance(value[field], str) or not UUID_RE.fullmatch(value[field]):
            fail("INVALID_CONFIGURATION")
    if not isinstance(value["token"], str) or not TOKEN_RE.fullmatch(value["token"]):
        fail("INVALID_CONFIGURATION")
    url = value["callbackUrl"]
    if not isinstance(url, str) or len(url) > 2048 or re.search(r"[\x00-\x20\x7f\\]", url):
        fail("INVALID_CONFIGURATION")
    try:
        endpoint = urlsplit(url)
        valid = (endpoint.scheme == "https" and endpoint.hostname
                 and endpoint.username is None and endpoint.password is None
                 and endpoint.port in (None, 443) and endpoint.path == CALLBACK_PATH
                 and not endpoint.query and not endpoint.fragment)
    except ValueError:
        valid = False
    if not valid:
        fail("INVALID_CONFIGURATION")
    # Within 15 minutes of this machine's first boot (see CONFIG_PATH).
    if uptime() >= SETUP_WINDOW_SECONDS:
        fail("ENROLLMENT_EXPIRED")
    return value


def read_config(path=CONFIG_PATH):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
                fail("UNSAFE_CONFIGURATION_FILE")
            content = handle.read(MAX_RESPONSE + 1)
            if len(content) > MAX_RESPONSE:
                fail("INVALID_CONFIGURATION")
            value = json.loads(content)
            return validate_config(value), (info.st_dev, info.st_ino)
    except EnrollmentFailure:
        raise
    except (OSError, ValueError, UnicodeError):
        fail("INVALID_CONFIGURATION")


def remove_config(identity, path=CONFIG_PATH):
    try:
        current = os.lstat(path)
        if (current.st_dev, current.st_ino) != identity or not stat.S_ISREG(current.st_mode):
            fail("CONFIGURATION_CHANGED")
        os.unlink(path)
    except EnrollmentFailure:
        raise
    except OSError:
        fail("CONFIGURATION_REMOVAL_FAILED")


def canonical_key(raw):
    if not isinstance(raw, str) or len(raw) > 256:
        fail("INVALID_HOST_KEY")
    match = KEY_RE.fullmatch(raw)
    if not match:
        fail("INVALID_HOST_KEY")
    try:
        blob = base64.b64decode(match[1], validate=True)
    except ValueError:
        fail("INVALID_HOST_KEY")
    if len(blob) != 51 or blob[:19] != PREFIX or not any(blob[19:]):
        fail("INVALID_HOST_KEY")
    public_key = "ssh-ed25519 " + base64.b64encode(blob).decode("ascii")
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    return public_key, fingerprint


def request_registration(callback_url, token, body, timeout):
    """Direct TLS; no proxy inheritance and no redirect processing."""
    endpoint = urlsplit(callback_url)
    connection = http.client.HTTPSConnection(
        endpoint.hostname, 443, timeout=timeout, context=ssl.create_default_context())
    try:
        connection.request("POST", CALLBACK_PATH, body=body, headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        response = connection.getresponse()
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            fail("INVALID_ACKNOWLEDGEMENT")
        return response.status, raw
    except ssl.SSLCertVerificationError:
        fail("TLS_VERIFICATION_FAILED")
    except (OSError, http.client.HTTPException):
        fail("NETWORK_UNAVAILABLE")
    finally:
        connection.close()


def metadata_server_id():
    """Metadata selects an ID; the control plane must independently verify it."""
    connection = http.client.HTTPConnection("169.254.169.254", timeout=5)
    try:
        connection.request("GET", "/hetzner/v1/metadata/instance-id")
        response = connection.getresponse()
        raw = response.read(65)
        if response.status != 200 or len(raw) > 64:
            fail("METADATA_UNAVAILABLE")
        value = raw.decode("ascii").strip()
        if not ID_RE.fullmatch(value) or int(value) > 9007199254740991:
            fail("METADATA_UNAVAILABLE")
        return value
    except EnrollmentFailure:
        raise
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        fail("METADATA_UNAVAILABLE")
    finally:
        connection.close()


def enroll(config, host_key, provider_id, request=request_registration,
           monotonic=time.monotonic, uptime=read_uptime, pause=time.sleep):
    config = validate_config(config, uptime)
    if not isinstance(provider_id, str) or not ID_RE.fullmatch(provider_id) or int(provider_id) > 9007199254740991:
        fail("METADATA_UNAVAILABLE")
    public_key, fingerprint = canonical_key(host_key)
    body = json.dumps({
        "version": 1, "orderId": config["orderId"], "attemptId": config["attemptId"],
        "providerServerId": provider_id, "hostPublicKey": public_key,
    }, separators=(",", ":")).encode("utf-8")
    deadline = monotonic() + WINDOW_SECONDS
    for attempt in range(MAX_ATTEMPTS):
        validate_config(config, uptime)
        remaining = deadline - monotonic()
        if remaining <= 0:
            fail("ENROLLMENT_TIMEOUT")
        try:
            status, raw = request(config["callbackUrl"], config["token"], body, min(5, remaining))
        except EnrollmentFailure as error:
            if error.code != "NETWORK_UNAVAILABLE":
                raise
            status, raw = 503, b""
        if monotonic() >= deadline:
            fail("ENROLLMENT_TIMEOUT")
        validate_config(config, uptime)
        if status == 200:
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeError):
                fail("INVALID_ACKNOWLEDGEMENT")
            if (not isinstance(result, dict)
                    or set(result) != {"version", "accepted", "orderId", "attemptId", "hostFingerprintSha256"}
                    or type(result["version"]) is not int or result["version"] != 1
                    or result["accepted"] is not True
                    or result["orderId"] != config["orderId"]
                    or result["attemptId"] != config["attemptId"]
                    or result["hostFingerprintSha256"] != fingerprint):
                fail("INVALID_ACKNOWLEDGEMENT")
            return {"ok": True, "orderId": config["orderId"],
                    "attemptId": config["attemptId"], "hostFingerprintSha256": fingerprint}
        if status not in TRANSIENT_STATUS:
            fail("ENROLLMENT_REJECTED")
        if attempt + 1 < MAX_ATTEMPTS:
            delay = min(5, deadline - monotonic())
            if delay <= 0:
                fail("ENROLLMENT_TIMEOUT")
            pause(delay)
    fail("ENROLLMENT_UNAVAILABLE")


def main():
    identity = None
    previous_alarm = None
    try:
        if os.geteuid() != 0:
            fail("ROOT_REQUIRED")
        # Socket timeouts alone do not bound DNS or a slow-drip response. This
        # one-shot Linux process has a hard total deadline as well as retry and
        # per-socket limits. The signal is never installed when imported.
        previous_alarm = signal.signal(signal.SIGALRM, lambda *_: fail("ENROLLMENT_TIMEOUT"))
        signal.setitimer(signal.ITIMER_REAL, WINDOW_SECONDS)
        config, identity = read_config()
        with open(HOST_KEY_PATH, "r", encoding="ascii") as handle:
            raw_key = handle.read(257).rstrip("\n")
        result = enroll(config, raw_key, metadata_server_id())
        remove_config(identity)
        identity = None
        print("HIVRA_BOOT_ENROLLMENT " + json.dumps(result, separators=(",", ":")))
        return 0
    except EnrollmentFailure as error:
        code = error.code
    except Exception:
        code = "ENROLLMENT_FAILED"
    finally:
        if previous_alarm is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_alarm)
    if identity is not None:
        try:
            remove_config(identity)
        except EnrollmentFailure:
            code = "CONFIGURATION_REMOVAL_FAILED"
    # Never echo a token, provider response, endpoint exception or traceback.
    print("HIVRA_BOOT_ENROLLMENT " + json.dumps({"ok": False, "code": code}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
