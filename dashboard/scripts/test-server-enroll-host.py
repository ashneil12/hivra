#!/usr/bin/env python3
"""Disposable-server check for the one-command server enrollment.

Runs ON a throwaway Linux server as root (a disposable CI runner, or a fresh
cloud VM made for this and deleted afterwards). It changes that server: it
creates and deletes users, installs a test CA, edits /etc/hosts and sudoers
drop-ins, installs a small package and leaves the server clean of everything
the setup script adds. Never run it on a server anyone uses.

What it checks against the real system (real useradd, visudo, sshd, sudo,
curl and bash), with a local fake Hivra origin standing in for /enroll and the
report endpoint (https://hivra-enroll.test, a test CA installed for curl):

- the command end to end: `curl ... | sudo bash` as root and as a user with
  passwordless sudo, under a real terminal; `--yes` without a terminal;
  `--yes` with a terminal still asks; no terminal and no `--yes` stops;
- the script's own checks and exact results: modes and owners under the real
  umask, the sudoers rule accepted by visudo and by sudo, the key line, the
  marker, the report it sends, the words it prints;
- a password-sudo user can't run it (the refusal path), and a refused or
  unanswered report rolls every change back;
- truncation: every byte prefix of the final line, and body line boundaries,
  cut by the network (curl exits early), run nothing, and a command named like
  a prefix of an entry function is never run; the refusal lines are served as
  HTTP 200 so `curl -f` pipes them and they print;
- uninstall, and that nothing the setup added remains;
- the sudo transport (spec 9.2) over a real sshd as the enrolled hivra user,
  with sudo's use_pty on and off: 1 MB of binary stdin arrives byte for byte,
  errexit, ERR traps, heredocs and exit codes behave as under `bash -s`, a
  96 KB script runs; T43 (a nohup child survives the channel closing after
  the early-finish marker); finding 6 (a package install under the unbounded
  command finishes after the channel closes and leaves dpkg consistent, while
  the bounded command's TERM/KILL would stop it); T28 diagnosis against real
  sudo (a password-only user, a rule for other commands, a missing
  /usr/bin/timeout).

Usage: HIVRA_DISPOSABLE_CI=1 python3 test-server-enroll-host.py --body PATH
Exit 0 only when every check passed. Output: one JSON line per check.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import pty
import pwd
import re
import select
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ORIGIN_HOST = "hivra-enroll.test"
ORIGIN = "https://" + ORIGIN_HOST
ACCOUNT = "K7QM-2XRA"
SUDOERS = b"hivra ALL=(ALL:ALL) NOPASSWD: ALL\n"
WORDS = "amber-falcon-river"
# The sudo transport exactly as src/lib/services/proxmox-sudo-transport.ts
# builds it. A jest test reads this file and checks both are identical.
SUDO_LOADER = ('printf "HIVRA_SUDO_V1\\n" >&2; IFS= read -r n && [[ $n =~ ^[1-9][0-9]{0,5}$ ]] && '
               'IFS= read -r -d "" -n "$n" s && [ "${#s}" -eq "$n" ] && eval "$s"')
SUDO_PREFIX = ("/usr/bin/sudo -n -- /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin "
               "LC_ALL=C HOME=/root ")
SUDO_TRUE_PROBE = "/usr/bin/sudo -n -- /usr/bin/true"
MISSING_TOOLS_PROBE = ("/bin/sh -c 'for p in /usr/bin/sudo /usr/bin/env /usr/bin/timeout /bin/bash; do "
                       "[ -x \"$p\" ] || printf \"missing %s\\n\" \"$p\"; done'")
TEST_USERS = ("hseops", "hsepw", "hselimited")
RESULTS = []


def sudo_command(seconds):
    limit = "" if seconds is None else "/usr/bin/timeout --signal=TERM --kill-after=1s %ds " % seconds
    return SUDO_PREFIX + limit + "/bin/bash --noprofile --norc -c '" + SUDO_LOADER + "'"


def frame(script, data=b""):
    body = script.encode()
    return str(len(body)).encode() + b"\n" + body + data


def record(name, ok, **detail):
    RESULTS.append({"check": name, "ok": bool(ok), **detail})
    print(json.dumps({"check": name, "ok": bool(ok), **detail}), flush=True)
    return ok


def run(argv, **kwargs):
    kwargs.setdefault("capture_output", True)
    return subprocess.run(argv, **kwargs)


def sh(command, **kwargs):
    return run(["bash", "-c", command], **kwargs)


def fingerprint(public_key):
    blob = base64.b64decode(public_key.split()[1])
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


def host_key():
    return " ".join(open("/etc/ssh/ssh_host_ed25519_key.pub").read().split()[:2])


# --- The fake Hivra origin ------------------------------------------------------


class Origin:
    """Serves the pinned body plus one final line, and takes reports."""

    def __init__(self, body, admin_public_key):
        self.body = body
        self.admin_public_key = admin_public_key
        self.codes = {}
        self.reports = []
        self.fetches = []
        self.lock = threading.Lock()

    def new_code(self, fetch="ok", report="accept"):
        code = "hse1_" + base64.b32encode(os.urandom(20)).decode().lower().rstrip("=")
        self.codes[code] = {"fetch": fetch, "report": report}
        return code

    def enroll_line(self, code):
        return ("{ hivra_enroll_entry \"$@\" HIVRA_ARGS_V1 '%s' '%s' '%s' '%s' HIVRA_END_V1; }"
                % (ORIGIN, code, self.admin_public_key, ACCOUNT)).encode()

    def served(self, code):
        return self.body + self.enroll_line(code) + b"\n"


def make_handler(origin):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def text(self, status, body):
            self.send_response(status)
            for key, value in (("Content-Type", "text/plain; charset=utf-8"), ("Cache-Control", "no-store, private"),
                               ("Content-Length", str(len(body)))):
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def code(self):
            match = re.fullmatch(r"Bearer (hse1_[a-z2-7]{32})", self.headers.get("Authorization") or "")
            return match.group(1) if match else None

        def do_GET(self):
            code = self.code()
            with origin.lock:
                origin.fetches.append({"path": self.path, "code": bool(code)})
            if self.path == "/enroll/uninstall":
                return self.text(200, origin.body + b'{ hivra_uninstall_entry "$@" HIVRA_END_V1; }\n')
            if self.path != "/enroll":
                return self.text(404, b"")
            if self.headers.get("Authorization") is None:
                return self.text(200, origin.body + b"{ hivra_refuse 'missing_code'; }\n")
            entry = origin.codes.get(code) if code else None
            if entry is None:
                return self.text(200, origin.body + b"{ hivra_refuse 'expired_or_used'; }\n")
            payload = origin.served(code)
            if entry["fetch"].startswith("cut:"):
                # Promise the whole script, send a prefix, then drop the
                # connection: curl exits with an error after piping the prefix.
                cut = int(entry["fetch"][4:])
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload[:cut])
                self.wfile.flush()
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                return None
            return self.text(200, payload)

        def do_POST(self):
            code = self.code()
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            entry = origin.codes.get(code) if code else None
            report = {"code_known": entry is not None, "raw": raw.decode("utf-8", "replace"),
                      "peer": self.client_address[0], "path": self.path,
                      "content_type": self.headers.get("Content-Type")}
            with origin.lock:
                origin.reports.append(report)
            if self.path != "/api/infrastructure/server-enrollments/report" or entry is None:
                return self.text(401, b"HIVRA_ENROLLMENT v1\nstatus=not_usable\n")
            mode = entry["report"]
            if mode == "drop":
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                return None
            if mode == "refuse":
                return self.text(401, b"HIVRA_ENROLLMENT v1\nstatus=not_usable\n")
            if mode == "ipv4":
                return self.text(422, b"HIVRA_ENROLLMENT v1\nstatus=ipv4_required\n")
            try:
                body = json.loads(raw)
                keys = {"version", "scriptVersion", "kind", "consent", "hostPublicKey", "adminKeyFingerprint",
                        "sshPort", "reenrollment", "facts"}
                facts = {"hostname", "osId", "osVersionId", "architecture", "cpuCount", "memoryBytes",
                         "virtualization", "proxmoxVersion", "sshMatchRules"}
                valid = (set(body) == keys and set(body["facts"]) == facts and body["version"] == 1
                         and body["kind"] == "enrolled" and body["hostPublicKey"] == host_key()
                         and body["adminKeyFingerprint"] == fingerprint(origin.admin_public_key)
                         and isinstance(body["sshPort"], int)
                         and report["content_type"] == "application/json")
            except (ValueError, KeyError, TypeError):
                valid = False
            report["valid"] = valid
            if not valid:
                return self.text(400, b"HIVRA_ENROLLMENT v1\nstatus=invalid_report\n")
            entry["enrollment"] = entry.get("enrollment") or str(uuid.uuid4())
            return self.text(200, ("HIVRA_ENROLLMENT v1\nstatus=accepted\nenrollment=%s\nwords=%s\nhost=%s\n"
                                   % (entry["enrollment"], WORDS, fingerprint(host_key()))).encode())

    return Handler


def start_origin(origin, work):
    """A test CA the system trusts, a certificate for hivra-enroll.test, the
    name in /etc/hosts, and an HTTPS server on 127.0.0.1:443."""
    ca_key, ca_cert = os.path.join(work, "ca.key"), os.path.join(work, "ca.crt")
    key, csr, cert = os.path.join(work, "o.key"), os.path.join(work, "o.csr"), os.path.join(work, "o.crt")
    ext = os.path.join(work, "o.ext")
    open(ext, "w").write("subjectAltName=DNS:%s\n" % ORIGIN_HOST)
    for argv in (["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", ca_key, "-out", ca_cert,
                  "-days", "1", "-subj", "/CN=hivra-enroll-test-ca"],
                 ["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr,
                  "-subj", "/CN=" + ORIGIN_HOST],
                 ["openssl", "x509", "-req", "-in", csr, "-CA", ca_cert, "-CAkey", ca_key, "-CAcreateserial",
                  "-out", cert, "-days", "1", "-extfile", ext]):
        run(argv, check=True)
    shutil.copyfile(ca_cert, "/usr/local/share/ca-certificates/hivra-enroll-test.crt")
    run(["update-ca-certificates"], check=True)
    hosts = open("/etc/hosts").read()
    if ORIGIN_HOST not in hosts:
        open("/etc/hosts", "a").write("127.0.0.1 %s\n" % ORIGIN_HOST)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), make_handler(origin))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def stop_origin(server):
    server.shutdown()
    try:
        os.remove("/usr/local/share/ca-certificates/hivra-enroll-test.crt")
    except FileNotFoundError:
        pass
    run(["update-ca-certificates", "--fresh"])
    lines = [line for line in open("/etc/hosts").read().splitlines(True) if ORIGIN_HOST not in line]
    open("/etc/hosts", "w").write("".join(lines))


# --- Running commands the way a person does -------------------------------------


def pty_run(command, answers=(), password=None, user=None, timeout=120):
    """Run `command` in bash under a new pseudo-terminal that becomes the
    controlling terminal (as a person's login terminal is), answering each
    [y/N] prompt in order and any sudo password prompt with `password`. For
    `user`, the child drops to that user itself: `su -c` would start a new
    session without the terminal."""
    argv = ["bash", "--noprofile", "--norc", "-c", command]
    pid, master = pty.fork()
    if pid == 0:
        if user:
            entry = pwd.getpwnam(user)
            os.initgroups(user, entry.pw_gid)
            os.setgid(entry.pw_gid)
            os.setuid(entry.pw_uid)
            os.chdir(entry.pw_dir)
            os.environ.update({"HOME": entry.pw_dir, "USER": user, "LOGNAME": user,
                               "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
        os.execvp(argv[0], argv)
    output = b""
    pending = list(answers)
    passwords = 0
    deadline = time.time() + timeout
    while True:
        if time.time() > deadline:
            os.kill(pid, signal.SIGKILL)
            raise AssertionError("timed out: " + output.decode("utf-8", "replace")[-2000:])
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                break
            output += chunk
            if pending and re.search(rb"\[y/N\] $", output):
                os.write(master, pending.pop(0).encode() + b"\n")
                output += b"<answered>"
            if password is not None and re.search(rb"password for [a-z]+: ?$", output) and passwords < 3:
                passwords += 1
                os.write(master, password.encode() + b"\n")
                output += b"<password>"
    _, status = os.waitpid(pid, 0)
    os.close(master)
    code = os.waitstatus_to_exitcode(status)
    return code, output.decode("utf-8", "replace").replace("\r\n", "\n")


def fetch_command(code, flags="", sudo=True):
    return ("curl -fsS --proto '=https' -H 'Authorization: Bearer %s' %s/enroll | %s%s"
            % (code, ORIGIN, "sudo bash" if sudo else "bash", (" -s -- " + flags) if flags else ""))


UNINSTALL = "curl -fsS --proto '=https' %s/enroll/uninstall | sudo bash" % ORIGIN


def mode_of(path):
    info = os.lstat(path)
    return stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid


def hivra_exists():
    try:
        pwd.getpwnam("hivra")
        return True
    except KeyError:
        return False


def clean_state():
    """Nothing the setup script adds is on the server."""
    return {"user": hivra_exists(), "home": os.path.exists("/home/hivra"),
            "sudoers": os.path.exists("/etc/sudoers.d/hivra-enrollment"),
            "sudoers_tmp": os.path.exists("/etc/sudoers.d/.hivra-enrollment.new"),
            "marker": os.path.exists("/etc/hivra/enrollment.json")}


def is_clean():
    return not any(clean_state().values())


# --- Checks ---------------------------------------------------------------------


def check_enrolled(label, origin, admin_public_key, terminal_output, consent):
    passwd = pwd.getpwnam("hivra")
    shadow = [line.split(":") for line in open("/etc/shadow").read().splitlines() if line.startswith("hivra:")][0]
    keys_path = os.path.join(passwd.pw_dir, ".ssh/authorized_keys")
    marker = json.load(open("/etc/hivra/enrollment.json"))
    report = [r for r in origin.reports if r.get("valid")][-1]
    body = json.loads(report["raw"])
    sudo_list = run(["sudo", "-l", "-U", "hivra"], text=True).stdout
    detail = {
        "shadow": shadow[1], "shell": passwd.pw_shell,
        "etc_hivra": mode_of("/etc/hivra"), "marker": mode_of("/etc/hivra/enrollment.json"),
        "sudoers": mode_of("/etc/sudoers.d/hivra-enrollment"), "ssh_dir": mode_of(os.path.join(passwd.pw_dir, ".ssh")),
        "authorized_keys": mode_of(keys_path), "marker_status": marker["status"],
        "report_facts": body["facts"], "consent": body["consent"],
    }
    uid, gid = passwd.pw_uid, passwd.pw_gid
    ok = (shadow[1] == "*"
          and detail["etc_hivra"] == (0o755, 0, 0) and detail["marker"] == (0o644, 0, 0)
          and detail["sudoers"] == (0o440, 0, 0) and detail["ssh_dir"] == (0o700, uid, gid)
          and detail["authorized_keys"] == (0o600, uid, gid)
          and open("/etc/sudoers.d/hivra-enrollment", "rb").read() == SUDOERS
          and open(keys_path).read() == "restrict %s hivra-enrollment\n" % admin_public_key
          and run(["visudo", "-c"]).returncode == 0 and "NOPASSWD: ALL" in sudo_list
          and marker["status"] == "reported" and marker["enrollment"] == origin.codes_by_report
          and "adminKeyFingerprint" in marker and "code" not in json.dumps(marker)
          and body["consent"] == consent and body["hostPublicKey"] == host_key()
          and body["facts"]["osId"] == "ubuntu" and body["facts"]["architecture"] == "x86_64"
          and ("Done. Hivra shows the same three words: amber falcon river" in terminal_output))
    return record(label + ": exact changes, report and marker", ok, **detail)


def enroll_scenarios(origin, admin_public_key):
    # 1. The command is missing its code: the refusal is HTTP 200, curl -f
    #    pipes it, and it prints one sentence (review finding 9).
    result = sh("curl -fsS --proto '=https' %s/enroll | bash" % ORIGIN, text=True)
    record("missing code: HTTP 200 refusal prints", result.returncode == 1
           and "missing its one-time code" in result.stderr and is_clean(), stderr=result.stderr[-300:])
    result = sh("curl -fsS --proto '=https' -H 'Authorization: Bearer hse1_%s' %s/enroll | bash"
                % ("a" * 32, ORIGIN), text=True)
    record("unknown code: HTTP 200 refusal prints", result.returncode == 1
           and "expired, was already used" in result.stderr and is_clean(), stderr=result.stderr[-300:])

    # 2. No terminal and no --yes: stops before sending or changing anything.
    code = origin.new_code()
    before = len(origin.reports)
    result = sh("setsid -w bash -c %s </dev/null" % json.dumps(fetch_command(code, sudo=False)), text=True)
    record("no terminal, no --yes: nothing sent or changed", result.returncode == 1 and is_clean()
           and len(origin.reports) == before and "needs a terminal" in result.stderr, stderr=result.stderr[-300:])

    # 3. --yes on a terminal still asks; "n" changes and sends nothing.
    status, output = pty_run(fetch_command(code, "--yes", sudo=False), answers=("n",))
    record("terminal with --yes still asks; n changes nothing", status == 1 and "Continue? [y/N]" in output
           and ACCOUNT in output and "@" not in output.split("Continue only if")[1] and is_clean()
           and len(origin.reports) == before, tail=output[-400:])

    # 4. Root, real terminal, yes: exact results.
    origin.codes_by_report = None
    status, output = pty_run(fetch_command(code, sudo=False), answers=("y",))
    origin.codes_by_report = origin.codes[code].get("enrollment")
    ok = status == 0 and check_enrolled("root, terminal", origin, admin_public_key, output, "terminal")
    if not ok:
        record("root, terminal output", False, tail=output[-1500:])
    return code


def rerun_prompt(origin):
    code = origin.new_code()
    status, output = pty_run(fetch_command(code, sudo=False), answers=("n",))
    return record("re-run on an enrolled server says only what the server knows", status == 1
                  and "already ran on this server" in output and "can't tell whether that Hivra account confirmed it" in output
                  and json.load(open("/etc/hivra/enrollment.json"))["status"] == "reported", tail=output[-500:])


def uninstall(label, user=None):
    command = UNINSTALL if user else UNINSTALL.replace("| sudo bash", "| bash")
    status, output = pty_run(command, answers=("y",), user=user)
    etc_hivra_kept = os.path.isdir("/etc/hivra")
    return record(label + ": uninstall removes the user, the rule and the marker", status == 0 and is_clean()
                  and etc_hivra_kept and "Done. The hivra user and Hivra's sudo rule are gone." in output,
                  state=clean_state(), etc_hivra_kept=etc_hivra_kept, tail=output[-300:])


def create_user(name, sudo_rule=None, password=None, public_key=None):
    run(["userdel", "-r", name])
    run(["useradd", "--create-home", "--shell", "/bin/bash", name], check=True)
    if password:
        run(["chpasswd"], input=("%s:%s\n" % (name, password)).encode(), check=True)
    if sudo_rule:
        path = "/etc/sudoers.d/zz-" + name
        open(path, "w").write(sudo_rule + "\n")
        os.chmod(path, 0o440)
        run(["visudo", "-cf", path], check=True)
    if public_key:
        home = pwd.getpwnam(name).pw_dir
        os.makedirs(home + "/.ssh", mode=0o700, exist_ok=True)
        open(home + "/.ssh/authorized_keys", "w").write(public_key + "\n")
        run(["chown", "-R", "%s:%s" % (name, name), home + "/.ssh"], check=True)
        os.chmod(home + "/.ssh/authorized_keys", 0o600)


def remove_users():
    for name in TEST_USERS:
        run(["pkill", "-u", name])
        run(["userdel", "-r", name])
        try:
            os.remove("/etc/sudoers.d/zz-" + name)
        except FileNotFoundError:
            pass


def sudo_user_scenarios(origin, admin_public_key):
    create_user("hseops", sudo_rule="hseops ALL=(ALL:ALL) NOPASSWD: ALL")
    code = origin.new_code()
    # Dry run as the user, without sudo: prints, says what it skipped.
    status, output = pty_run(fetch_command(code, "--dry-run", sudo=False), user="hseops")
    record("sudo user: --dry-run without root changes and sends nothing", status == 0 and is_clean()
           and "Skipped without root" in output and '"kind":"enrolled"' in output, tail=output[-300:])
    origin.codes_by_report = None
    status, output = pty_run(fetch_command(code), answers=("y",), user="hseops")
    origin.codes_by_report = origin.codes[code].get("enrollment")
    if not (status == 0 and check_enrolled("passwordless sudo user, terminal", origin, admin_public_key, output,
                                           "terminal")):
        record("passwordless sudo user output", False, tail=output[-1500:])
    uninstall("passwordless sudo user", user="hseops")

    # A user whose sudo needs a password can't run it without authenticating:
    # three wrong passwords, and sudo -n, both change and send nothing.
    create_user("hsepw", sudo_rule="hsepw ALL=(ALL:ALL) ALL", password="correct-horse-" + uuid.uuid4().hex)
    code = origin.new_code()
    before = len(origin.reports)
    status, output = pty_run(fetch_command(code), answers=("y",), password="wrong-password", user="hsepw")
    record("password sudo user: wrong password changes and sends nothing", status != 0 and is_clean()
           and len(origin.reports) == before and "password for hsepw" in output, tail=output[-400:])
    status, output = pty_run(fetch_command(code).replace("sudo bash", "sudo -n bash"), user="hsepw")
    record("password sudo user: sudo -n refuses before anything runs", status != 0 and is_clean()
           and len(origin.reports) == before and "password is required" in output, tail=output[-300:])


def rollback_scenarios(origin):
    for mode, text in (("refuse", "already used"), ("ipv4", "only reach servers over IPv4")):
        code = origin.new_code(report=mode)
        status, output = pty_run(fetch_command(code, sudo=False), answers=("y",))
        record("report refused (%s): every change rolled back" % mode, status == 1 and is_clean() and text in output
               and "This server undid every change." in output, state=clean_state(), tail=output[-300:])
    code = origin.new_code(report="drop")
    started = time.time()
    status, output = pty_run(fetch_command(code, sudo=False), answers=("y",), timeout=300)
    record("no answer: retried, rolled back, no-answer text", status == 1 and is_clean()
           and "Hivra didn't confirm it received this server's report" in output,
           seconds=round(time.time() - started), state=clean_state(), tail=output[-300:])


def no_terminal_yes(origin, admin_public_key):
    code = origin.new_code()
    origin.codes_by_report = None
    result = sh("setsid -w bash -c %s </dev/null" % json.dumps(fetch_command(code, "--yes", sudo=False)), text=True)
    origin.codes_by_report = origin.codes[code].get("enrollment")
    ok = result.returncode == 0 and check_enrolled("no terminal with --yes", origin, admin_public_key,
                                                   result.stderr, "no_terminal")
    if not ok:
        record("no terminal output", False, stderr=result.stderr[-1500:])
    result = sh("setsid -w bash -c %s </dev/null" % json.dumps(UNINSTALL.replace("| sudo bash", "| bash -s -- --yes")),
                text=True)
    record("no terminal with --yes: uninstall", result.returncode == 0 and is_clean(), stderr=result.stderr[-300:])


def truncation(origin):
    """Cut by the network: the fake origin promises the whole script, sends a
    prefix and drops the connection, so curl pipes the prefix and fails."""
    marker = "/tmp/hse-prefix-ran"
    code = origin.new_code()
    line = origin.enroll_line(code)
    entry_prefixes = set()
    for entry in ("hivra_enroll_entry", "hivra_refuse", "hivra_uninstall_entry"):
        for index in range(1, len(entry)):
            entry_prefixes.add(entry[:index])
    for name in entry_prefixes:
        path = "/usr/local/bin/" + name
        open(path, "w").write("#!/bin/sh\necho ran >> %s\n" % marker)
        os.chmod(path, 0o755)
    body_len = len(origin.body)
    line_starts = [index + 1 for index, byte in enumerate(origin.body) if byte == 0x0a]
    # Every proper prefix of the final line (the whole line without its
    # newline is complete and runs), and every 25th line boundary of the body.
    cuts = sorted(set([body_len + k for k in range(0, len(line))] + line_starts[::25]))
    failures = []
    reports_before = len(origin.reports)
    for cut in cuts:
        origin.codes[code]["fetch"] = "cut:%d" % cut
        result = sh(fetch_command(code, sudo=False) + " 2>&1", text=True, timeout=30)
        output = result.stdout
        # A cut inside the body defines functions and runs none (bash exits
        # 0); a cut inside the final line is an unclosed brace group, which
        # bash refuses (non-zero). Neither may run anything.
        in_final_line = cut > body_len
        if (in_final_line and result.returncode == 0) or not is_clean() or os.path.exists(marker) \
                or "Hivra server setup" in output:
            failures.append({"cut": cut, "rc": result.returncode, "out": output[-200:]})
    origin.codes[code]["fetch"] = "ok"
    for name in entry_prefixes:
        os.remove("/usr/local/bin/" + name)
    record("truncation: %d network cuts (every byte of the final line, body lines) ran nothing" % len(cuts),
           not failures and len(origin.reports) == reports_before, failures=failures[:5])
    # The complete download does run (without a terminal it stops at step 5).
    result = sh("setsid -w bash -c %s </dev/null" % json.dumps(fetch_command(code, sudo=False)), text=True)
    record("truncation: the complete download runs", "Hivra server setup - script" in result.stderr and is_clean())


# --- The sudo transport over a real sshd ----------------------------------------


class Ssh:
    def __init__(self, work, user, private_key):
        self.user = user
        self.key = private_key
        self.known = os.path.join(work, "known_hosts")
        open(self.known, "w").write("127.0.0.1 %s\n" % host_key())

    def argv(self, command):
        return ["ssh", "-T", "-i", self.key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + self.known,
                "-o", "HostKeyAlgorithms=ssh-ed25519", "-p", "22", "%s@127.0.0.1" % self.user, command]

    def run(self, command, data=b"", timeout=120):
        return run(self.argv(command), input=data, timeout=timeout)


def set_use_pty(on):
    path = "/etc/sudoers.d/00-hse-use-pty"
    open(path, "w").write("Defaults %suse_pty\n" % ("" if on else "!"))
    os.chmod(path, 0o440)
    run(["visudo", "-cf", path], check=True)


LOADER_PROBE = r"""set -Eeuo pipefail
trap 'echo "ERR-TRAP $?" >&2' ERR
f() { return 7; }
digest=$(sha256sum | cut -d' ' -f1)
echo "SHA $digest"
echo "UID $(id -u) HOME $HOME PATH $PATH LC_ALL $LC_ALL"
if f; then :; else echo "F=$?"; fi
cat <<'EOT'
heredoc $not_expanded
EOT
exit 3
"""


def transport_suite(label, ssh, work):
    data = bytearray(os.urandom(1024 * 1024))
    for index, byte in enumerate(b"\x00\r\x03\x04\n\x00\x1a\r\n"):
        data[1000 + index] = byte
    data = bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    command = sudo_command(58)
    result = ssh.run(command, frame(LOADER_PROBE, data))
    # The login-mode form of a script with its own stdin (the script in argv,
    # the data on stdin). Under plain `bash -s` a command that reads stdin
    # would swallow the rest of the script itself.
    local = run(["bash", "--noprofile", "--norc", "-c", LOADER_PROBE], input=data,
                env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin", "LC_ALL": "C",
                     "HOME": "/root"})
    stderr = result.stderr.decode("utf-8", "replace")
    record(label + ": 1 MB binary stdin, errexit, traps, heredoc, exit code as under bash -s",
           result.returncode == 3 == local.returncode and result.stdout == local.stdout
           and ("SHA " + digest).encode() in result.stdout and b"UID 0 HOME /root" in result.stdout
           and b"PATH /usr/local/sbin:/usr/local/bin:" in result.stdout
           and stderr.startswith("HIVRA_SUDO_V1\n"),
           stdout=result.stdout.decode()[:400], stderr=stderr[:200], local=local.stdout.decode()[:400])
    result = ssh.run(command, frame("set -e\nfalse\necho SHOULD-NOT-PRINT\n"))
    record(label + ": errexit inside the loader aborts", result.returncode == 1 and b"SHOULD-NOT" not in result.stdout)
    big = "# " + "x" * (96 * 1024) + "\necho BIG-OK\n"
    result = ssh.run(command, frame(big))
    record(label + ": a 96 KB script runs", result.returncode == 0 and result.stdout == b"BIG-OK\n")
    # sudo logs one constant line per operation, no script byte.
    time.sleep(2)
    since = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time()))
    time.sleep(1.1)
    ssh.run(command, frame("echo SECRET-SCRIPT-BODY-%s\n" % label))
    time.sleep(1.5)
    log = run(["journalctl", "--since", since, "-t", "sudo", "--no-pager", "-o", "cat"], text=True).stdout
    lines = [line for line in log.splitlines() if "COMMAND=" in line]
    record(label + ": the auth log has one constant command line and no script body", len(lines) == 1
           and "SECRET-SCRIPT-BODY" not in log and "HIVRA_SUDO_V1" in lines[0], lines=lines)
    # T43: a nohup child started inside the exact command survives the runner
    # closing the channel as soon as it sees the early-finish marker.
    stamp = "/tmp/hse-t43-%s" % uuid.uuid4().hex
    script = ("nohup bash -c 'sleep 12; date > %s' >/dev/null 2>&1 &\necho HIVRA_T43_MARKER\nsleep 30\n" % stamp)
    process = subprocess.Popen(ssh.argv(sudo_command(598)), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    process.stdin.write(frame(script))
    process.stdin.close()
    seen = process.stdout.readline()
    process.kill()
    process.wait()
    time.sleep(16)
    record(label + ": T43 a nohup child survives the early channel close", seen.strip() == b"HIVRA_T43_MARKER"
           and os.path.exists(stamp))
    # Finding 6: the script itself after the channel closes.
    for limit, expect in ((None, True), (5, False)):
        stamp = "/tmp/hse-f6-%s" % uuid.uuid4().hex
        process = subprocess.Popen(ssh.argv(sudo_command(limit)), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        process.stdin.write(frame("echo STARTED\nsleep 10\ndate > %s\n" % stamp))
        process.stdin.close()
        process.stdout.readline()
        time.sleep(1)
        process.kill()
        process.wait()
        time.sleep(14)
        record(label + ": the script %s the channel close (%s)" % (
            "finishes after" if expect else "is stopped by its remote limit after",
            "unbounded" if limit is None else "bounded %ds" % limit), os.path.exists(stamp) == expect)


def package_install_survives(label, ssh):
    """Finding 6 with real packages: an install under the unbounded command
    (as gVisor Prepare now runs) finishes after the channel closes, and dpkg
    is left consistent."""
    run(["apt-get", "update", "-qq"], timeout=300)
    run(["apt-get", "remove", "-y", "-qq", "sl"], timeout=300)
    process = subprocess.Popen(ssh.argv(sudo_command(None)), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    process.stdin.write(frame("echo STARTED\nDEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sl\n"))
    process.stdin.close()
    process.stdout.readline()
    time.sleep(0.5)
    process.kill()
    process.wait()
    for _ in range(120):
        if run(["pgrep", "-f", "apt-get install"]).returncode != 0:
            break
        time.sleep(1)
    audit = run(["dpkg", "--audit"], text=True).stdout
    installed = run(["dpkg-query", "-W", "-f=${Status}", "sl"], text=True).stdout
    record(label + ": a package install finishes after the channel closes; dpkg --audit is clean",
           installed == "install ok installed" and audit.strip() == "", installed=installed, audit=audit[:300])
    run(["apt-get", "remove", "-y", "-qq", "sl"], timeout=300)


def diagnosis(work, keypair):
    """T28 against real sudo: no sentinel, then the two fixed probes."""
    private, public = keypair
    create_user("hsepw", sudo_rule="hsepw ALL=(ALL:ALL) ALL", password="pw-" + uuid.uuid4().hex, public_key=public)
    create_user("hselimited", sudo_rule="hselimited ALL=(ALL) NOPASSWD: /usr/bin/true", public_key=public)
    for user, expected in (("hsepw", "password_required"), ("hselimited", "command_not_allowed")):
        ssh = Ssh(work, user, private)
        result = ssh.run(sudo_command(58), frame("echo reached\n"))
        missing = ssh.run(MISSING_TOOLS_PROBE).stdout.decode()
        sudo_true = ssh.run(SUDO_TRUE_PROBE).returncode
        found = "missing_tool" if missing.strip() else ("command_not_allowed" if sudo_true == 0 else "password_required")
        record("T28 %s: no sentinel, diagnosis %s" % (user, expected), result.returncode != 0
               and b"HIVRA_SUDO_V1" not in result.stderr and b"reached" not in result.stdout and found == expected,
               found=found, stderr=result.stderr.decode()[:200])
    # A missing tool: renamed for the check on this throwaway server only.
    os.rename("/usr/bin/timeout", "/usr/bin/timeout.hse-moved")
    try:
        ssh = Ssh(work, "hselimited", private)
        result = ssh.run(sudo_command(58), frame("echo reached\n"))
        missing = ssh.run(MISSING_TOOLS_PROBE).stdout.decode()
        record("T28 missing /usr/bin/timeout: no sentinel, diagnosis names it", result.returncode != 0
               and b"HIVRA_SUDO_V1" not in result.stderr and missing.strip() == "missing /usr/bin/timeout",
               missing=missing)
    finally:
        os.rename("/usr/bin/timeout.hse-moved", "/usr/bin/timeout")


def environment():
    release = dict(line.split("=", 1) for line in open("/etc/os-release").read().splitlines() if "=" in line)
    return {"os": release.get("PRETTY_NAME", "").strip('"'), "kernel": os.uname().release,
            "sudo": run(["sudo", "-V"], text=True).stdout.splitlines()[0],
            "openssh": run(["ssh", "-V"], text=True).stderr.strip(),
            "bash": run(["bash", "--version"], text=True).stdout.splitlines()[0],
            "use_pty_in_sudoers": "use_pty" in open("/etc/sudoers").read(),
            "virt": run(["systemd-detect-virt"], text=True).stdout.strip()}


def script_version(body):
    match = re.search(rb"^hse_version\(\) \{\n  printf '%s' '([0-9.]+)'\n\}$", body, re.M)
    return match.group(1).decode() if match else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--body", required=True)
    parser.add_argument("--enroll-for-runner", metavar="ADMIN_PUBLIC_KEY_FILE",
                        help="leave the server enrolled with this admin key for a runner test")
    parser.add_argument("--login-key", metavar="PUBLIC_KEY_FILE",
                        help="with --enroll-for-runner: create hsepw and hselimited with this key")
    args = parser.parse_args()
    if os.environ.get("HIVRA_DISPOSABLE_CI") != "1" or os.geteuid() != 0 or sys.platform != "linux":
        raise SystemExit("Refusing: run only as root on a disposable Linux server with HIVRA_DISPOSABLE_CI=1.")
    body = open(args.body, "rb").read()
    # Bind the evidence to the exact script: the body's sha256 is what
    # /enroll/script.sha256 publishes for this release.
    print(json.dumps({"environment": environment(), "scriptBodySha256": hashlib.sha256(body).hexdigest(),
                      "scriptVersion": script_version(body)}), flush=True)
    work = tempfile.mkdtemp(prefix="hse-host-")
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "hse-admin", "-f", os.path.join(work, "admin")],
        check=True)
    admin_private = os.path.join(work, "admin")
    admin_public = " ".join(open(admin_private + ".pub").read().split()[:2])
    if args.enroll_for_runner:
        admin_public = " ".join(open(args.enroll_for_runner).read().split()[:2])
    origin = Origin(body, admin_public)
    origin.codes_by_report = None
    server = start_origin(origin, work)
    keep_users = False
    try:
        if args.enroll_for_runner:
            code = origin.new_code()
            status, output = pty_run(fetch_command(code, sudo=False), answers=("y",))
            origin.codes_by_report = origin.codes[code].get("enrollment")
            check_enrolled("runner fixture enrollment", origin, admin_public, output, "terminal")
            if args.login_key:
                public = open(args.login_key).read().strip()
                create_user("hsepw", sudo_rule="hsepw ALL=(ALL:ALL) ALL", password="pw-" + uuid.uuid4().hex,
                            public_key=public)
                create_user("hselimited", sudo_rule="hselimited ALL=(ALL) NOPASSWD: /usr/bin/true",
                            public_key=public)
                create_user("hseops", sudo_rule="hseops ALL=(ALL:ALL) NOPASSWD: ALL", public_key=public)
            print(json.dumps({"host_key": host_key(), "host_fingerprint": fingerprint(host_key())}), flush=True)
            keep_users = True
            return 0 if all(result["ok"] for result in RESULTS) else 1
        enroll_scenarios(origin, admin_public)
        rerun_prompt(origin)
        ssh = Ssh(work, "hivra", admin_private)
        for on in (True, False):
            set_use_pty(on)
            transport_suite("use_pty %s" % ("on" if on else "off"), ssh, work)
        set_use_pty(True)
        package_install_survives("use_pty on", ssh)
        set_use_pty(False)
        package_install_survives("use_pty off", ssh)
        os.remove("/etc/sudoers.d/00-hse-use-pty")
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", os.path.join(work, "login")], check=True)
        diagnosis(work, (os.path.join(work, "login"),
                         " ".join(open(os.path.join(work, "login.pub")).read().split()[:2])))
        uninstall("root")
        remove_users()
        sudo_user_scenarios(origin, admin_public)
        remove_users()
        no_terminal_yes(origin, admin_public)
        rollback_scenarios(origin)
        truncation(origin)
    finally:
        stop_origin(server)
        if not keep_users:
            remove_users()
        for path in ("/etc/sudoers.d/00-hse-use-pty",):
            if os.path.exists(path):
                os.remove(path)
        shutil.rmtree(work, ignore_errors=True)
    leftovers = clean_state()
    record("nothing the setup added remains; test users, CA and hosts entry removed", not any(leftovers.values())
           and not any(os.path.exists("/home/" + name) for name in TEST_USERS)
           and ORIGIN_HOST not in open("/etc/hosts").read(), state=leftovers)
    failed = [result["check"] for result in RESULTS if not result["ok"]]
    print(json.dumps({"summary": {"checks": len(RESULTS), "failed": failed}}), flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
