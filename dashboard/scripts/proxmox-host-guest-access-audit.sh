#!/usr/bin/env bash
# proxmox-host-guest-access-audit.sh: record every time something on a Proxmox
# host connects INTO a guest computer, so the computer's owner can see it.
#
# What counts as a connection into a computer, seen on its host:
#   - a command run inside it through the QEMU guest agent
#     (`qm guest exec`, `pvesh create .../agent/exec`), or a guest-agent call
#     that changes it (`qm guest cmd <vmid> fsfreeze-freeze`, `qm guest passwd`);
#   - a file read or written through the guest agent, `pct push/pull`, or an
#     scp/sftp/rsync session to the guest's address;
#   - a console or screen opened on it (`qm terminal`, `qm monitor`,
#     `qm vncproxy`, `pct enter`, `pvesh .../vncproxy|termproxy|spiceproxy`);
#   - an SSH session from the host to the guest's address;
#   - read-only guest-agent status calls (`qm guest cmd <vmid> ping|info|
#     get-fsinfo|...`) are recorded too, as "status".
# Starting, stopping, resizing or reconfiguring a VM is not a connection into
# it and is not recorded here.
#
# Who: each record is tied to the login session on the host that ran it (the
# audit "ses"). A session's SSH key fingerprint, or failing that its source
# address, is looked up in /etc/hivra/access-actors.conf:
#     key  SHA256:<fingerprint>  system|staff  <label...>
#     addr <IPv4 or CIDR>        system|staff  <label...>
# Anything not listed is recorded as staff, "Unrecognised login", so an
# unexpected connection is disclosed rather than hidden. Commands with no
# login session (the host's own timers and services) are "system", "Hivra's
# services on the server".
#
# What is NOT kept: command arguments, file names, file contents and output.
# A command record keeps only the program's name (bash, cat, python3).
#
# How: auditd watches qm, pct, pvesh and ssh for execution (key
# hivra_guest_access). --collect (a one-minute timer) turns new audit records
# into lines in a spool, /var/lib/hivra/access-audit/spool.jsonl. Hivra's
# dashboard reads the spool with --drain and stores hourly counts per computer.
#
# Usage:
#   sudo proxmox-host-guest-access-audit.sh --install    audit rules, actors file, timer
#   sudo proxmox-host-guest-access-audit.sh --collect    read new audit records into the spool
#   sudo proxmox-host-guest-access-audit.sh --drain N [MAX]
#                                                        drop spool lines up to N, print the next MAX
#   sudo proxmox-host-guest-access-audit.sh --check      exit 1 unless rules, timer and spool are healthy
#   sudo proxmox-host-guest-access-audit.sh --uninstall  remove rules and timer (spool kept)
#   proxmox-host-guest-access-audit.sh --parse-raw FILE  parse raw audit text, print events (tests; no root)
#
# Environment (tests): QEMU_CONF_DIR, LXC_CONF_DIR, ACCESS_STATE_DIR,
# ACCESS_ACTORS_CONF, ACCESS_SESSIONS_FIXTURE (JSON {"<ses>": {"addr": ..,
# "fp": ..}} used instead of the audit and SSH logs).
# Bash 3.2 compatible.

set -euo pipefail

QEMU_CONF_DIR="${QEMU_CONF_DIR:-/etc/pve/qemu-server}"
LXC_CONF_DIR="${LXC_CONF_DIR:-/etc/pve/lxc}"
ACCESS_STATE_DIR="${ACCESS_STATE_DIR:-/var/lib/hivra/access-audit}"
ACCESS_ACTORS_CONF="${ACCESS_ACTORS_CONF:-/etc/hivra/access-actors.conf}"
RULES_FILE="/etc/audit/rules.d/60-hivra-guest-access.rules"
INSTALL_PATH="/usr/local/sbin/hivra-guest-access-audit"
AUDIT_KEY="hivra_guest_access"
MODE=""
ARG1=""
ARG2=""

log() { printf '[hivra-guest-access] %s\n' "$*" >&2; }
fatal() { printf '[hivra-guest-access] FATAL: %s\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,70p' "$0" | sed -n '/^#/!q;p' | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  --install) MODE="install" ;;
  --collect) MODE="collect" ;;
  --drain) MODE="drain"; ARG1="${2:-}"; ARG2="${3:-2000}" ;;
  --check) MODE="check" ;;
  --uninstall) MODE="uninstall" ;;
  --parse-raw) MODE="parse"; ARG1="${2:-}" ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

engine() {
  QEMU_CONF_DIR="$QEMU_CONF_DIR" LXC_CONF_DIR="$LXC_CONF_DIR" ACCESS_STATE_DIR="$ACCESS_STATE_DIR" \
  ACCESS_ACTORS_CONF="$ACCESS_ACTORS_CONF" AUDIT_KEY="$AUDIT_KEY" python3 -I - "$@" <<'PY'
import ipaddress, json, os, re, subprocess, sys, time

QEMU_DIR = os.environ["QEMU_CONF_DIR"]
LXC_DIR = os.environ["LXC_CONF_DIR"]
STATE = os.environ["ACCESS_STATE_DIR"]
ACTORS = os.environ["ACCESS_ACTORS_CONF"]
KEY = os.environ["AUDIT_KEY"]
SPOOL = os.path.join(STATE, "spool.jsonl")
SEQ = os.path.join(STATE, "seq")
SESSIONS = os.path.join(STATE, "sessions.json")
SPOOL_MAX_LINES = 200_000
UNSET = "4294967295"
PROGRAM = re.compile(r'^[A-Za-z0-9._+-]{1,40}$')
READONLY_QGA = {
    "ping", "info", "get-fsinfo", "get-osinfo", "get-time", "get-timezone", "get-host-name",
    "get-users", "get-vcpus", "get-memory-blocks", "get-memory-block-info", "network-get-interfaces",
    "fsfreeze-status",
}
SSH_OPTS_WITH_VALUE = set("BbcDEeFIiJLlmOoPpQRSWw")

# ---------------------------------------------------------------- guest map
def conf_lines(path):
    main, cloudinit, cur = {}, {}, "main"
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.rstrip("\n")
                if line.startswith("["):
                    cur = "cloudinit" if line.strip() == "[special:cloudinit]" else "other"
                    continue
                m = re.match(r'^([a-z0-9]+):\s*(.*)$', line)
                if not m:
                    continue
                if cur == "main":
                    main[m.group(1)] = m.group(2)
                elif cur == "cloudinit":
                    cloudinit[m.group(1)] = m.group(2)
    except OSError:
        pass
    return main, cloudinit

def ip_from(value):
    for item in value.split(","):
        if item.startswith("ip="):
            try:
                return str(ipaddress.IPv4Interface(item[3:]).ip)
            except ValueError:
                return None
    return None

def guest_ips():
    out = {}
    for directory, kind in ((QEMU_DIR, "qemu"), (LXC_DIR, "lxc")):
        if not os.path.isdir(directory):
            continue
        for name in os.listdir(directory):
            m = re.match(r'^(\d+)\.conf$', name)
            if not m:
                continue
            vmid = int(m.group(1))
            main, cloudinit = conf_lines(os.path.join(directory, name))
            for key in [k for k in main if re.match(r'^(ipconfig|net)\d+$', k)]:
                value = main[key]
                if kind == "qemu" and key.startswith("ipconfig"):
                    value = cloudinit.get(key) or value
                elif kind == "qemu":
                    continue
                ip = ip_from(value)
                if ip:
                    out[ip] = (vmid, kind)
    return out

# ---------------------------------------------------------------- actors
def load_actors():
    keys, nets = {}, []
    try:
        with open(ACTORS, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split(None, 3)
                if len(parts) < 4 or parts[2] not in ("system", "staff"):
                    continue
                label = parts[3][:80]
                if parts[0] == "key":
                    keys[parts[1]] = (parts[2], label)
                elif parts[0] == "addr":
                    try:
                        nets.append((ipaddress.ip_network(parts[1], strict=False), parts[2], label))
                    except ValueError:
                        pass
    except OSError:
        pass
    return keys, nets

def classify(session, auid, ses, keys, nets):
    if auid in ("", UNSET) or ses in ("", UNSET):
        return "system", "Hivra's services on the server"
    if session:
        fp = session.get("fp")
        if fp and fp in keys:
            return keys[fp]
        addr = session.get("addr")
        if addr:
            try:
                ip = ipaddress.ip_address(addr)
                for net, cls, label in nets:
                    if ip in net:
                        return cls, label
                if ip.is_loopback:
                    return "system", "Hivra's services on the server"
            except ValueError:
                pass
    return "staff", "Unrecognised login"

# ---------------------------------------------------------------- raw audit
RECORD = re.compile(r'^type=(\w+) msg=audit\((\d+)\.(\d+):(\d+)\): ?(.*)$')
FIELD = re.compile(r'(\w+(?:\[\d+\])?)=("(?:[^"]*)"|\'[^\']*\'|\S+)')

def unhex(value):
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    if value == "(null)":
        return ""
    try:
        return bytes.fromhex(value).decode("utf-8", "replace")
    except ValueError:
        return value

def parse_raw(text):
    events = {}
    for line in text.splitlines():
        m = RECORD.match(line.strip())
        if not m:
            continue
        rtype, sec, serial, body = m.group(1), int(m.group(2)), m.group(4), m.group(5)
        ev = events.setdefault(serial, {"at": sec, "argv": {}, "syscall": {}, "login": {}})
        fields = dict(FIELD.findall(body.split("\x1d")[0]))
        if rtype == "SYSCALL":
            ev["syscall"] = fields
        elif rtype == "EXECVE":
            for k, v in fields.items():
                am = re.match(r'^a(\d+)$', k)
                if am:
                    ev["argv"][int(am.group(1))] = unhex(v)
        elif rtype in ("USER_START", "USER_LOGIN"):
            # msg='op=... addr=... terminal=ssh res=success'
            inner = re.search(r"msg='(.*)'", body)
            more = dict(FIELD.findall(inner.group(1))) if inner else {}
            ev["login"] = {"pid": fields.get("pid", ""), "ses": fields.get("ses", ""), "addr": more.get("addr", ""),
                           "res": more.get("res", ""), "terminal": more.get("terminal", "")}
    return events

def argv_list(ev):
    a = ev["argv"]
    return [a[i] for i in sorted(a)] if a else []

def base(path):
    return os.path.basename(path or "")

def program_of(args):
    for item in args:
        name = base(item)
        if name and PROGRAM.match(name):
            return name
    return None

def after_dashdash(args):
    return args[args.index("--") + 1:] if "--" in args else []

def positional(args, with_value):
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
            continue
        if a.startswith("-"):
            skip = a in with_value
            continue
        out.append(a)
    return out

def vmid_of(value):
    return int(value) if value and re.match(r'^\d{3,9}$', value) else None

def ssh_target(args):
    """Return (host, remote_args) for an ssh argv (without argv[0])."""
    i, subsystem = 0, False
    while i < len(args):
        arg = args[i]
        if arg == "--":
            i += 1
            break
        if arg.startswith("-") and len(arg) > 1:
            flags = arg[1:]
            for j, ch in enumerate(flags):
                if ch == "s":
                    subsystem = True
                if ch in SSH_OPTS_WITH_VALUE:
                    if j == len(flags) - 1:
                        i += 1
                    break
            i += 1
            continue
        break
    if i >= len(args):
        return None, [], subsystem
    dest = args[i]
    if dest.startswith("ssh://"):
        dest = dest[6:]
    host = dest.rsplit("@", 1)[-1]
    host = host.split(":")[0] if host.count(":") == 1 else host
    return host, args[i + 1:], subsystem

def interpret(args, ips):
    """(vmid, kind, channel, program, source) or None for one argv."""
    idx = None
    for i, item in enumerate(args):
        if base(item) in ("qm", "pct", "pvesh", "ssh"):
            idx = i
            break
    if idx is None:
        return None
    tool, rest = base(args[idx]), args[idx + 1:]
    if tool == "qm" and rest:
        sub = rest[0]
        if sub == "guest" and len(rest) >= 3:
            op, vmid = rest[1], vmid_of(rest[2])
            if vmid is None:
                return None
            if op == "exec":
                return vmid, "qemu", "command", program_of(after_dashdash(rest[3:]) or positional(rest[3:], ("--timeout", "--pass-stdin", "--synchronous"))), "qm"
            if op == "exec-status":
                return None
            if op == "passwd":
                return vmid, "qemu", "command", "passwd", "qm"
            if op == "cmd" and len(rest) >= 4:
                command = rest[3]
                return vmid, "qemu", ("status" if command in READONLY_QGA else "command"), (command if PROGRAM.match(command) else None), "qm"
            return None
        if sub in ("terminal", "monitor", "vncproxy") and len(rest) >= 2:
            vmid = vmid_of(rest[1])
            if vmid is None:
                return None
            return vmid, "qemu", ("screen" if sub == "vncproxy" else "console"), None, "qm"
        return None
    if tool == "pct" and len(rest) >= 2:
        sub, vmid = rest[0], vmid_of(rest[1])
        if vmid is None:
            return None
        if sub in ("enter", "console"):
            return vmid, "lxc", "console", None, "pct"
        if sub == "exec":
            return vmid, "lxc", "command", program_of(after_dashdash(rest[2:])), "pct"
        if sub in ("push", "pull"):
            return vmid, "lxc", "files", None, "pct"
        return None
    if tool == "pvesh" and len(rest) >= 2:
        path = rest[1]
        m = re.match(r'^/?nodes/[^/]+/(qemu|lxc)/(\d+)/(.+)$', path)
        if not m:
            return None
        kind, vmid, tail = ("qemu" if m.group(1) == "qemu" else "lxc"), int(m.group(2)), m.group(3)
        if tail in ("vncproxy", "spiceproxy"):
            return vmid, kind, "screen", None, "pvesh"
        if tail == "termproxy":
            return vmid, kind, "console", None, "pvesh"
        if tail == "agent/exec":
            return vmid, kind, "command", None, "pvesh"
        if tail in ("agent/file-read", "agent/file-write"):
            return vmid, kind, "files", None, "pvesh"
        return None
    if tool == "ssh":
        host, remote, subsystem = ssh_target(rest)
        if not host or host not in ips:
            return None
        vmid, kind = ips[host]
        first = remote[0].split() if remote else []
        program = "sftp" if subsystem else program_of(first[:1]) if first else None
        channel = "files" if program in ("scp", "rsync", "sftp", "sftp-server") else "ssh"
        return vmid, kind, channel, program, "ssh"
    return None

def events_from(raw_events, sessions, ips, keys, nets):
    out = []
    for serial in sorted(raw_events, key=lambda s: (raw_events[s]["at"], int(s))):
        ev = raw_events[serial]
        sc = ev["syscall"]
        if not sc or sc.get("key", "").strip('"') != KEY or sc.get("success") == "no":
            continue
        args = argv_list(ev)
        hit = interpret(args, ips)
        if not hit:
            continue
        vmid, kind, channel, program, source = hit
        ses, auid = sc.get("ses", ""), sc.get("auid", "")
        actor_class, actor_label = classify(sessions.get(ses), auid, ses, keys, nets)
        out.append({"at": ev["at"], "vmid": vmid, "kind": kind, "channel": channel,
                    "actor_class": actor_class, "actor_label": actor_label,
                    "program": program, "source": source})
    return out

def logins_from(raw_events):
    found = {}
    for ev in raw_events.values():
        login = ev.get("login") or {}
        if login.get("ses") and login.get("ses") != UNSET and login.get("res") == "success":
            found[login["ses"]] = {"pid": login.get("pid", ""), "addr": login.get("addr", ""), "at": ev["at"]}
    return found

# ---------------------------------------------------------------- state
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default

def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

def ausearch(args, checkpoint):
    cmd = ["ausearch", "--raw", "--input-logs", "--checkpoint", checkpoint] + args
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode in (10, 11, 12):
        # The checkpoint no longer matches the logs (rotated): start again from today.
        try:
            os.remove(checkpoint)
        except OSError:
            pass
        r = subprocess.run(["ausearch", "--raw", "--input-logs", "--checkpoint", checkpoint, "-ts", "today"] + args,
                           capture_output=True, text=True, timeout=120)
    return r.stdout if r.returncode in (0, 1) else ""

def fingerprint_for(pid):
    if not re.match(r'^\d+$', pid or ""):
        return None
    try:
        r = subprocess.run(["journalctl", "--no-pager", "-o", "cat", f"_PID={pid}", "--since", "-2d"],
                           capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r'Accepted publickey for \S+ from \S+ port \d+ \S+: \S+ (SHA256:[A-Za-z0-9+/=]+)', r.stdout)
    return m.group(1) if m else None

def collect():
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    sessions = load_json(SESSIONS, {})
    login_raw = parse_raw(ausearch(["-m", "USER_START,USER_LOGIN"], os.path.join(STATE, "ck_login")))
    for ses, info in logins_from(login_raw).items():
        if ses not in sessions or sessions[ses].get("pid") != info["pid"]:
            info["fp"] = fingerprint_for(info["pid"])
            sessions[ses] = info
    cutoff = time.time() - 14 * 86400
    sessions = {k: v for k, v in sessions.items() if v.get("at", 0) >= cutoff}
    raw = parse_raw(ausearch(["-k", KEY], os.path.join(STATE, "ck_access")))
    keys, nets = load_actors()
    events = events_from(raw, sessions, guest_ips(), keys, nets)
    seq = int(load_json(SEQ, 0) or 0)
    lines = []
    for e in events:
        seq += 1
        e["seq"] = seq
        lines.append(json.dumps(e, separators=(",", ":")))
    if lines:
        with open(SPOOL, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        os.chmod(SPOOL, 0o600)
        write_atomic(SEQ, str(seq))
    write_atomic(SESSIONS, json.dumps(sessions))
    trim_spool()
    print(f"collected {len(lines)} event(s)", file=sys.stderr)

def read_spool():
    out = []
    try:
        with open(SPOOL, encoding="utf-8") as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return out

def trim_spool():
    rows = read_spool()
    if len(rows) > SPOOL_MAX_LINES:
        rows = rows[-SPOOL_MAX_LINES:]
        write_atomic(SPOOL, "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))

def drain(after, limit):
    rows = [r for r in read_spool() if int(r.get("seq", 0)) > after]
    write_atomic(SPOOL, "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
    shown = rows[:limit]
    for r in shown:
        print("HIVRA_ACCESS_V1 " + json.dumps(r, separators=(",", ":")))
    last = shown[-1]["seq"] if shown else after
    print("HIVRA_ACCESS_END " + json.dumps({"installed": True, "last_seq": last, "more": len(rows) > limit,
                                              "head_seq": int(load_json(SEQ, 0) or 0)}, separators=(",", ":")))

mode = sys.argv[1]
if mode == "parse":
    with open(sys.argv[2], encoding="utf-8") as fh:
        text = fh.read()
    fixture = os.environ.get("ACCESS_SESSIONS_FIXTURE")
    sessions = load_json(fixture, {}) if fixture else {}
    keys, nets = load_actors()
    for e in events_from(parse_raw(text), sessions, guest_ips(), keys, nets):
        print(json.dumps(e, separators=(",", ":"), sort_keys=True))
elif mode == "collect":
    collect()
elif mode == "drain":
    drain(int(sys.argv[2]), int(sys.argv[3]))
PY
}

with_lock() {
  mkdir -p "$ACCESS_STATE_DIR"
  chmod 0700 "$ACCESS_STATE_DIR"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$ACCESS_STATE_DIR/.lock"
    flock -w 60 9 || fatal "another run holds the access-audit lock"
  fi
}

case "$MODE" in
  parse)
    [ -n "$ARG1" ] && [ -r "$ARG1" ] || fatal "--parse-raw needs a readable file"
    engine parse "$ARG1"
    ;;
  collect)
    [ "$(id -u)" = 0 ] || fatal "--collect must run as root"
    with_lock
    engine collect
    ;;
  drain)
    [ "$(id -u)" = 0 ] || fatal "--drain must run as root"
    [[ "$ARG1" =~ ^[0-9]{1,15}$ ]] || fatal "--drain needs the last sequence number Hivra stored"
    [[ "$ARG2" =~ ^[1-9][0-9]{0,4}$ ]] || fatal "--drain MAX must be 1-99999"
    with_lock
    engine collect || log "collect failed; draining what the spool already holds"
    engine drain "$ARG1" "$ARG2"
    ;;
  check)
    problems=0
    command -v auditctl >/dev/null 2>&1 || { log "auditd is not installed"; problems=1; }
    [ -f "$RULES_FILE" ] || { log "rules file $RULES_FILE is missing"; problems=1; }
    if command -v auditctl >/dev/null 2>&1; then
      for path in /usr/sbin/qm /usr/sbin/pct /usr/bin/pvesh /usr/bin/ssh; do
        [ -e "$path" ] || continue
        auditctl -l 2>/dev/null | grep -F -- "-w $path -p x -k $AUDIT_KEY" >/dev/null || { log "live audit rule missing for $path"; problems=1; }
      done
    fi
    systemctl is-active --quiet hivra-guest-access-audit.timer 2>/dev/null || { log "collector timer is not active"; problems=1; }
    [ -f "$ACCESS_ACTORS_CONF" ] || { log "$ACCESS_ACTORS_CONF is missing: every login would be 'Unrecognised login'"; problems=1; }
    [ "$problems" = 0 ] && log "OK: audit rules loaded, collector timer active"
    exit "$problems"
    ;;
  install)
    [ "$(id -u)" = 0 ] || fatal "--install must run as root"
    command -v auditctl >/dev/null 2>&1 || fatal "auditd is not installed (apt-get install auditd), nothing changed"
    install -m 0755 "$0" "$INSTALL_PATH"
    install -d -m 0755 /etc/hivra
    install -d -m 0700 "$ACCESS_STATE_DIR"
    {
      echo "# Hivra: record connections into guest computers (see $INSTALL_PATH --help)."
      for path in /usr/sbin/qm /usr/sbin/pct /usr/bin/pvesh /usr/bin/ssh; do
        [ -e "$path" ] && echo "-w $path -p x -k $AUDIT_KEY"
      done
    } > "$RULES_FILE.tmp"
    mv -f "$RULES_FILE.tmp" "$RULES_FILE"
    if [ ! -f "$ACCESS_ACTORS_CONF" ]; then
      cat > "$ACCESS_ACTORS_CONF" <<'EOF'
# Who connects to this host. One rule per line:
#   key  SHA256:<ssh key fingerprint>  system|staff  <label shown to owners>
#   addr <IPv4 address or CIDR>        system|staff  <label shown to owners>
# Key rules win over address rules. Anything not listed shows as staff,
# "Unrecognised login". Find fingerprints with: ssh-keygen -lf <public key>.
EOF
      chmod 0644 "$ACCESS_ACTORS_CONF"
    fi
    augenrules --load >/dev/null 2>&1 || auditctl -R "$RULES_FILE" >/dev/null
    cat > /etc/systemd/system/hivra-guest-access-audit.service <<EOF
[Unit]
Description=Record connections into guest computers for their owners
After=auditd.service

[Service]
Type=oneshot
ExecStart=$INSTALL_PATH --collect
EOF
    cat > /etc/systemd/system/hivra-guest-access-audit.timer <<'EOF'
[Unit]
Description=Collect guest access records every minute

[Timer]
OnBootSec=60s
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now hivra-guest-access-audit.timer
    log "installed: audit rules, $ACCESS_ACTORS_CONF and a one-minute collector"
    ;;
  uninstall)
    [ "$(id -u)" = 0 ] || fatal "--uninstall must run as root"
    systemctl disable --now hivra-guest-access-audit.timer 2>/dev/null || true
    rm -f /etc/systemd/system/hivra-guest-access-audit.timer /etc/systemd/system/hivra-guest-access-audit.service
    systemctl daemon-reload
    if [ -f "$RULES_FILE" ]; then
      rm -f "$RULES_FILE"
      augenrules --load >/dev/null 2>&1 || true
      for path in /usr/sbin/qm /usr/sbin/pct /usr/bin/pvesh /usr/bin/ssh; do
        auditctl -W "$path" -p x -k "$AUDIT_KEY" >/dev/null 2>&1 || true
      done
    fi
    rm -f "$INSTALL_PATH"
    log "uninstalled: rules and timer removed (spool kept in $ACCESS_STATE_DIR, actors file kept)"
    ;;
esac
