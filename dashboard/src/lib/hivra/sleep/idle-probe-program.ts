// The program that reads an agent computer's own idle signals from inside the
// guest. The host hands it to that VMID's guest agent (see
// buildIdleProbeHostScript in ../agent-sleep-scripts.ts), it runs as root with
// a minimal environment, and it prints exactly one line, "HIVRA_IDLE <json>".
//
// Counts and times only. It never prints tokens, prompts, names or paths, and
// it never opens the remote desktop session file (that file holds session
// secrets). Any failure inside it prints no line at all and exits non-zero, so
// the host side reads "no answer" and the agent is treated as busy.
//
// Pure (no server imports) so the tests can run the program itself.

export const IDLE_PROBE_PREFIX = "HIVRA_IDLE ";
export const IDLE_PROBE_VERSION = 1;

export const IDLE_PROBE_PROGRAM = String.raw`import calendar, json, os, re, signal, subprocess, sys, time
# hivra-idle-probe v1. Runs as root via the guest agent. Counts and times only.
def _alarm(*_): raise TimeoutError()
def _fail(*_):
    sys.stderr.write("HIVRA_IDLE_FAILURE\n")
    os._exit(3)
sys.excepthook = _fail
signal.signal(signal.SIGALRM, _alarm)
signal.alarm(8)
T0 = time.time()
ME = os.getpid()
HOME = "/home/bux"
os.environ["PATH"] = "/usr/sbin:/usr/bin:/sbin:/bin"
OUT = {"v": 1, "errors": []}
def err(k): OUT["errors"].append(k)
def iso(t): return None if t is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
def rd(p, n=262144):
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
        try: return os.read(fd, n).decode("utf-8", "replace")
        finally: os.close(fd)
    except OSError: return None
def rjson(p, n=262144):
    s = rd(p, n)
    try: return json.loads(s) if s else None
    except ValueError: return None
def newest(root, depth, budget):
    best, stack, seen = None, [(root, 0)], 0
    while stack and seen < budget:
        d, k = stack.pop()
        try: it = os.scandir(d)
        except OSError: continue
        with it:
            for e in it:
                seen += 1
                try:
                    if e.is_dir(follow_symlinks=False):
                        if k < depth: stack.append((e.path, k + 1))
                    elif e.is_file(follow_symlinks=False):
                        m = e.stat(follow_symlinks=False).st_mtime
                        best = m if best is None or m > best else best
                except OSError: pass
    return best
def parse_ts(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0: return v / 1000.0 if v > 1e11 else float(v)
    if not isinstance(v, str): return None
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$", v.strip())
    if not m: return None
    y, mo, d, h, mi, s, tz = m.groups()
    try: t = calendar.timegm((int(y), int(mo), int(d), int(h), int(mi), int(s), 0, 0, 0))
    except (ValueError, OverflowError): return None
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1; tz = tz[1:].replace(":", "")
        t -= sign * (int(tz[:2]) * 3600 + int(tz[2:]) * 60)
    elif not tz: t += time.altzone if time.localtime().tm_isdst > 0 else time.timezone
    return t
# ---- processes (one /proc pass). The probe itself is never counted. ----
procs = {}
for p in os.listdir("/proc"):
    if not p.isdigit() or int(p) == ME: continue
    st = rd("/proc/%s/stat" % p, 4096)
    if not st: continue
    try:
        r = st.rsplit(")", 1)[1].split()
        comm = st[st.index("(") + 1:st.rindex(")")]
        cmd = (rd("/proc/%s/cmdline" % p, 4096) or "").replace("\0", " ").strip()
        procs[int(p)] = (comm, int(r[1]), cmd)
    except (ValueError, IndexError): pass
def children(pid): return [q for q, v in procs.items() if v[1] == pid]
# ---- chat runs (files written by the gateway) ----
runs, last = 0, []
rroot = HOME + "/.hivra/chat-runs"
try: names = os.listdir(rroot)
except OSError: names = []
for n in names[:500]:
    s = rjson("%s/%s/status.json" % (rroot, n), 8192)
    s = s if isinstance(s, dict) else {}
    if s.get("state") in ("starting", "running"):
        pid = s.get("runnerPid")
        if s.get("state") == "starting" or (isinstance(pid, int) and pid in procs and n in procs[pid][2]): runs += 1
    for k in ("finishedAt", "startedAt"):
        t = parse_ts(s.get(k))
        if t: last.append(t)
# ---- coding CLI transcripts (terminal driven runs never reach chat-runs) ----
for d in (HOME + "/.claude/projects", HOME + "/.codex/sessions"):
    t = newest(d, 5, 4000)
    if t: last.append(t)
cli_busy = sum(1 for v in procs.values() if v[0] in ("claude", "codex") or re.search(r"(^|/)(claude|codex)( |$)", v[2]))
# ---- terminals: a ttyd child is one open terminal tab ----
term = sum(len(children(p)) for p, v in procs.items() if v[0] == "ttyd")
tmux_att = 0
for sock in ("hivra-agent", "hivra-box"):
    try:
        r = subprocess.run(["/usr/sbin/runuser", "-u", "bux", "--", "tmux", "-L", sock, "list-sessions", "-F",
                            "#{session_attached} #{session_activity}"], capture_output=True, text=True, timeout=2)
        for ln in r.stdout.splitlines():
            a, act = (ln.split() + ["0", "0"])[:2]
            tmux_att += int(a) > 0
            if act.isdigit() and int(act) > 0: last.append(float(act))
    except Exception: err("tmux")
# ---- sockets: established connections per local port ----
def gateway_hex():
    for ln in (rd("/proc/net/route", 65536) or "").splitlines()[1:]:
        c = ln.split()
        try:
            if len(c) > 7 and c[1] == "00000000" and int(c[3], 16) & 2: return c[2].upper()
        except ValueError: pass
    return None
GW = gateway_hex()
def est(ports, skip_gateway=False):
    n = 0
    for f in ("/proc/net/tcp", "/proc/net/tcp6"):
        for ln in (rd(f, 4 << 20) or "").splitlines()[1:]:
            c = ln.split()
            try:
                if len(c) > 3 and c[3] == "01" and int(c[1].rsplit(":", 1)[1], 16) in ports:
                    peer = c[2].rsplit(":", 1)[0].upper()
                    if skip_gateway and GW and (peer == GW or peer.endswith("FFFF0000" + GW)): continue
                    n += 1
            except ValueError: pass
    return n
APP_PORTS = {5555, 18789, 50080, 9119, 9120, 3101}
DESK_PORTS = {8090, 8088, 6080, 5900, 47984, 47989, 47990, 48010}
app_conns = est(APP_PORTS)
desk_conns = est(DESK_PORTS)
gw_conns = est({8080})
# The host's own maintenance logins come from the guest's default gateway. With
# no gateway known every ssh connection counts, which keeps the agent awake.
ssh = est({22}, skip_gateway=True)
# ---- schedulers: the next time something runs by itself ----
nexts = []
def hermes_jobs(p):
    j = rjson(p, 1 << 20)
    jobs = j.get("jobs", []) if isinstance(j, dict) else j if isinstance(j, list) else []
    for job in jobs[:1000]:
        if not isinstance(job, dict) or job.get("enabled", True) is False: continue
        if job.get("state") in ("paused", "completed", "error") or job.get("paused_at"): continue
        t = parse_ts(job.get("next_run_at"))
        if t: nexts.append(t)
        if job.get("state") == "running": OUT["schedRunning"] = OUT.get("schedRunning", 0) + 1
hermes_jobs(HOME + "/.hermes/cron/jobs.json")
try:
    for prof in os.listdir(HOME + "/.hermes/profiles")[:50]: hermes_jobs("%s/.hermes/profiles/%s/cron/jobs.json" % (HOME, prof))
except OSError: pass
for p in (HOME + "/.openclaw/cron/jobs-state.json", HOME + "/.openclaw/cron/jobs.json"):
    stack, seen = [rjson(p, 1 << 20)], 0
    while stack and seen < 20000:
        x = stack.pop(); seen += 1
        if isinstance(x, dict):
            if x.get("enabled") is False: continue
            t = parse_ts(x.get("nextRunAtMs"))
            if t: nexts.append(t)
            stack.extend(x.values())
        elif isinstance(x, list): stack.extend(x[:2000])
a0 = rjson("/opt/a0/usr/scheduler/tasks.json", 1 << 20)
if isinstance(a0, dict) and a0.get("tasks"): nexts.append(time.time())
def has_cron_jobs(text):
    for ln in (text or "").splitlines():
        s = ln.strip()
        if not s or s.startswith("#") or re.match(r"[A-Za-z_][A-Za-z0-9_]*\s*=", s): continue
        return True
    return False
if has_cron_jobs(rd("/var/spool/cron/crontabs/bux", 65536)): nexts.append(time.time())
try:
    if [n for n in os.listdir("/var/spool/cron/atjobs") if not n.startswith(".")]: nexts.append(time.time())
except OSError: pass
try:
    r = subprocess.run(["systemctl", "show", "--state=active", "-p", "Id,NextElapseUSecRealtime", "--", "*.timer"],
                       capture_output=True, text=True, timeout=2)
    OUT["sysTimers"] = r.stdout.count("Id=")
except Exception: err("timers")
future = [t for t in nexts if t >= T0 - 300]
# ---- chat channels ----
ch = []
def active(unit):
    try:
        return subprocess.run(["systemctl", "is-active", "--quiet", unit], timeout=2).returncode == 0
    except Exception: return False
tg = rd("/etc/bux/tg.env", 8192) or ""
if re.search(r"^TG_BOT_TOKEN=\S", tg, re.M) and active("bux-tg"): ch.append("telegram:bux-tg")
env = rd(HOME + "/.hermes/.env", 65536) or ""
hermes_gw = any("hermes" in v[2] and " gateway" in v[2] for v in procs.values())
for k, name in (("TELEGRAM_BOT_TOKEN", "telegram"), ("DISCORD_BOT_TOKEN", "discord"), ("SLACK_BOT_TOKEN", "slack"),
                ("WHATSAPP_", "whatsapp"), ("SIGNAL_", "signal"), ("MATRIX_ACCESS_TOKEN", "matrix"), ("MATTERMOST_TOKEN", "mattermost"),
                ("EMAIL_", "email")):
    if re.search(r"^%s\w*=\S" % k, env, re.M): ch.append("hermes:" + name + ("" if hermes_gw else ":down"))
cfg = rd(HOME + "/.hermes/config.yaml", 262144) or ""
for name in re.findall(r"^  (\w+):\s*\n(?:    .*\n)*?    enabled:\s*true", cfg, re.M):
    tag = "hermes:" + name + ("" if hermes_gw else ":down")
    if tag not in ch: ch.append(tag)
oc = rjson(HOME + "/.openclaw/openclaw.json", 262144)
if isinstance(oc, dict) and isinstance(oc.get("channels"), dict):
    for name, c in oc["channels"].items():
        if isinstance(c, dict) and c.get("enabled", True) is not False: ch.append("openclaw:" + re.sub(r"\W", "", name)[:20])
# ---- result ----
la = (rd("/proc/loadavg", 128) or "0 0 0").split()[:3]
OUT.update({
    "activeRuns": runs + OUT.pop("schedRunning", 0),
    "cliProcesses": cli_busy,
    "openConnections": app_conns,
    "gatewayConnections": gw_conns,
    "terminalAttached": term > 0 or tmux_att > 0,
    "terminalClients": term,
    "sshSessions": ssh,
    "desktopAttached": desk_conns > 0,
    "lastUsedAt": iso(max(last) if last else None),
    "nextJobAt": iso(min(future) if future else None),
    "liveChannels": sorted(set(ch)),
    "loadavg": [float(x) for x in la],
    "cpus": os.cpu_count() or 0,
    "uptimeS": int(float((rd("/proc/uptime", 64) or "0").split()[0])),
    "now": iso(T0),
    "ms": int((time.time() - T0) * 1000),
})
sys.stdout.write("HIVRA_IDLE " + json.dumps(OUT, separators=(",", ":"), sort_keys=True) + "\n")
`;
