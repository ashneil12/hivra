// The idle probe, driven by an agent wake profile (agent-profiles/*). Used only
// while HIVRA_AGENT_PROFILES is on; otherwise IDLE_PROBE_PROGRAM runs as it
// always has.
//
// The program is fixed text; everything that differs per agent type comes in
// as one compact JSON object (base64 inside the program, so no quoting can
// break it). It prints the same one line, "HIVRA_IDLE <json>", with the same
// fields, plus "profile" (the type it evaluated) and, when the CPU safety net
// ran, "cpuBusy". For the agent types the old program knew it gives the same
// answer on the same computer (see the comparison tests); it adds:
//   - any profile's own busy processes, activity, schedules, channels and ports
//   - the chat safety net: an established connection to a known chat service
//     that no declared channel's own process holds is "unknown:<platform>". The services' addresses come
//     from the server and are also resolved here, on the guest, in the
//     background with a short deadline, so a service whose addresses differ by
//     region or edge is still seen; a name that fails or is late adds nothing
//   - the CPU safety net: an agent process at or above the threshold is busy
//     (counted in cliProcesses, which both gates already read as busy)
//
// Counts and times only. Never a token, a prompt, a name or a path.
//
// Pure (no server imports) so the tests can run the program itself.

import { TELEGRAM_ENV_VALUE_PY } from "./idle-probe-program";

export const PROFILE_PROBE_BODY = String.raw`import base64, calendar, errno, hashlib, json, os, re, signal, socket, subprocess, sys, threading, time
# hivra-idle-probe v1 (profile). Runs as root via the guest agent. Counts and times only.
class _Timeout(BaseException): pass
def _alarm(*_): raise _Timeout()
def _fail(*_):
    sys.stderr.write("HIVRA_IDLE_FAILURE\n")
    os._exit(3)
sys.excepthook = _fail
signal.signal(signal.SIGALRM, _alarm)
signal.alarm(8)
T0 = time.time()
ME = os.getpid()
HOME = "/home/bux"
ROOT = ""
os.environ["PATH"] = "/usr/sbin:/usr/bin:/sbin:/bin"
PF = json.loads(base64.b64decode(PROFILE_B64).decode("utf-8"))
OUT = {"v": 1, "errors": [], "profile": PF["type"]}
# The chat services' names, resolved on the guest in the background (the server's own
# answers can differ by region or edge). Each lookup runs in a daemon thread; the
# safety net waits for them until DNS_DL at most, then uses what came back.
RES = {}
def _resolve(h):
    out = set()
    try:
        for fam, _, _, _, sa in socket.getaddrinfo(h, None, 0, socket.SOCK_STREAM):
            try:
                if fam == socket.AF_INET:
                    x = socket.inet_aton(sa[0])[::-1].hex().upper()
                    out.update((x, "0000000000000000FFFF0000" + x))
                elif fam == socket.AF_INET6:
                    b = socket.inet_pton(socket.AF_INET6, sa[0].split("%")[0])
                    out.add("".join(b[i:i + 4][::-1].hex().upper() for i in (0, 4, 8, 12)))
            except (OSError, ValueError): pass
    except Exception: pass
    RES[h] = out
_RT = []
for _e in PF["endpoints"]:
    for _h in _e.get("h", [])[:4]:
        try:
            _t = threading.Thread(target=_resolve, args=(_h,), daemon=True); _t.start(); _RT.append(_t)
        except RuntimeError: pass
DNS_DL = T0 + 2.0
def err(k):
    if k not in OUT["errors"]: OUT["errors"].append(k)
def iso(t): return None if t is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
def P(p): return HOME + p[1:] if p.startswith("~/") else ROOT + p
GONE = (errno.ENOENT, errno.ENOTDIR, errno.ESRCH)
def rdb(p, n):
    try: fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        if e.errno not in GONE: err("read")
        return None
    try:
        chunks, total = [], 0
        while total < n:
            b = os.read(fd, min(65536, n - total))
            if not b: break
            chunks.append(b); total += len(b)
        return b"".join(chunks)
    except OSError as e:
        if e.errno not in GONE: err("read")
        return None
    finally: os.close(fd)
def rd(p, n=262144):
    b = rdb(p, n)
    return None if b is None else b.decode("utf-8", "replace")
def rjson(p, n=262144):
    b = rdb(p, n + 1)
    if b is None: return None
    if len(b) > n: err("json"); return None
    try: return json.loads(b.decode("utf-8"))
    except ValueError: err("json"); return None
_C = {}
def rdc(p, n):
    k = ("t", p, n)
    if k not in _C: _C[k] = rd(P(p), n)
    return _C[k]
def rjc(p, n):
    k = ("j", p, n)
    if k not in _C: _C[k] = rjson(P(p), n)
    return _C[k]
def walk(o, at):
    for a in at: o = o.get(a) if isinstance(o, dict) else None
    return o
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
        procs[int(p)] = (comm, int(r[1]), cmd, int(r[11]) + int(r[12]))
    except (ValueError, IndexError): pass
TP = time.time()
def children(pid): return [q for q, v in procs.items() if v[1] == pid]
_CG = {}
def cgroup(pid):
    if pid not in _CG: _CG[pid] = rd("/proc/%d/cgroup" % pid, 8192) or ""
    return _CG[pid]
def match(pid, m):
    v = procs.get(pid)
    if not v or not m: return False
    if v[0] in m.get("comm", ()): return True
    if m.get("cmd") and re.search(m["cmd"], v[2]): return True
    if m.get("cmdAll") and all(s in v[2] for s in m["cmdAll"]): return True
    return bool(m.get("cgroup")) and re.search(m["cgroup"], cgroup(pid)) is not None
def running(m): return any(match(q, m) for q in procs)
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
# ---- the profile's activity directories and busy processes ----
for a in PF["activity"]:
    t = newest(P(a["path"]), a["depth"], a["budget"])
    if t: last.append(t)
cli_busy = sum(1 for q in procs if any(match(q, m) for m in PF["busy"]))
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
def tcp_rows():
    for f in ("/proc/net/tcp", "/proc/net/tcp6"):
        for ln in (rd(f, 4 << 20) or "").splitlines()[1:]:
            yield ln.split()
def est(ports, skip_gateway=False):
    n = 0
    for c in tcp_rows():
        try:
            if len(c) > 3 and c[3] == "01" and int(c[1].rsplit(":", 1)[1], 16) in ports:
                peer = c[2].rsplit(":", 1)[0].upper()
                if skip_gateway and GW and (peer == GW or peer.endswith("FFFF0000" + GW)): continue
                n += 1
        except ValueError: pass
    return n
APP_PORTS = set(PF["ports"])
DESK_PORTS = {8090, 8088, 6080, 5900, 47984, 47989, 47990, 48010}
app_conns = est(APP_PORTS)
desk_conns = est(DESK_PORTS)
gw_conns = est({8080})
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
def next_runs(p, key):
    stack, seen = [rjson(p, 1 << 20)], 0
    while stack and seen < 20000:
        x = stack.pop(); seen += 1
        if isinstance(x, dict):
            if x.get("enabled") is False: continue
            t = parse_ts(x.get(key))
            if t: nexts.append(t)
            stack.extend(x.values())
        elif isinstance(x, list): stack.extend(x[:2000])
def has_cron_jobs(text):
    for ln in (text or "").splitlines():
        s = ln.strip()
        if not s or s.startswith("#") or re.match(r"[A-Za-z_][A-Za-z0-9_]*\s*=", s): continue
        return True
    return False
for s in PF["schedules"]:
    k, p = s["kind"], P(s["path"])
    if k == "hermes-jobs":
        hermes_jobs(p)
        if s.get("profilesDir"):
            try:
                for prof in os.listdir(P(s["profilesDir"]))[:50]: hermes_jobs(P(s["profilesDir"]) + "/" + prof + s["profilePath"])
            except OSError: pass
    elif k == "json-next-run": next_runs(p, s["key"])
    elif k == "json-nonempty":
        j = rjson(p, 1 << 20)
        if isinstance(j, dict) and j.get(s["key"]): nexts.append(time.time())
    elif k == "crontab":
        if has_cron_jobs(rd(p, 65536)): nexts.append(time.time())
    elif k == "dir-nonempty":
        try:
            if [n for n in os.listdir(p) if not n.startswith(".")]: nexts.append(time.time())
        except OSError: pass
    else: err("profile")
try:
    r = subprocess.run(["systemctl", "show", "--state=active", "-p", "Id,NextElapseUSecRealtime", "--", "*.timer"],
                       capture_output=True, text=True, timeout=2)
    OUT["sysTimers"] = r.stdout.count("Id=")
except Exception: err("timers")
future = [t for t in nexts if t >= T0 - 300]
# ---- chat channels ----
ch = []
${TELEGRAM_ENV_VALUE_PY}
def active(unit):
    try:
        return subprocess.run(["systemctl", "is-active", "--quiet", unit], timeout=2).returncode == 0
    except Exception: err("systemctl"); return False
def add(tag):
    if tag not in ch: ch.append(tag)
def gateway_platforms(p, required, pre, sfx, ignore):
    b = rdb(p, (1 << 20) + 1)
    try: j = json.loads(b.decode("utf-8")) if b and len(b) <= 1 << 20 else None
    except ValueError: j = None
    pl = j.get("platforms") if isinstance(j, dict) else None
    if not isinstance(pl, dict):
        if required: err("gateway_state")
        return
    for k, v in list(pl.items())[:200]:
        if not isinstance(k, str) or (isinstance(v, dict) and v.get("state") == "disabled"): continue
        name = re.sub(r"[^a-z0-9_]", "", k.rsplit(":", 1)[-1].lower())[:30]
        if name and name not in ignore: add(pre + ":" + name + sfx)
for s in PF["channels"]:
    k = s["kind"]
    up = s.get("up")
    sfx = "" if not up or running(up) else ":down"
    pre = s.get("prefix", "")
    if k == "systemd-env":
        if re.search(r"^%s=\S" % s["key"], rd(P(s["path"]), 8192) or "", re.M) and active(s["unit"]): add(s["tag"])
    elif k == "systemd-active":
        if active(s["unit"]): add(s["tag"])
    elif k == "env-keys":
        text = rdc(s["path"], 65536) or ""
        for key, name in s["keys"]:
            if re.search(r"^%s\w*=\S" % key, text, re.M): add(pre + ":" + name + sfx)
    elif k == "gateway-state":
        gateway_platforms(P(s["path"]), bool(s["requiredWhileUp"] and up and not sfx), pre, sfx, s["ignore"])
        if s.get("profilesDir"):
            try:
                for prof in sorted(os.listdir(P(s["profilesDir"])))[:50]:
                    gateway_platforms(P(s["profilesDir"]) + "/" + prof + s["profilePath"], False, pre, sfx, s["ignore"])
            except OSError: pass
    elif k == "yaml-enabled":
        for name in re.findall(r"^  (\w+):\s*\n(?:    .*\n)*?    enabled:\s*true", rdc(s["path"], 262144) or "", re.M): add(pre + ":" + name + sfx)
    elif k == "json-channels":
        o = walk(rjc(s["path"], 262144), s["at"])
        if isinstance(o, dict):
            for name, c in o.items():
                if isinstance(c, dict) and c.get("enabled", True) is not False: add(pre + ":" + re.sub(r"\W", "", name)[:20] + sfx)
    else: err("profile")
# Per-channel facts for the wake adapters (Hermes's settings). Modes and host names only, never a secret.
FA = PF.get("facts")
if FA:
    env = rdc(FA["env"], 65536) or ""
    cfg = rdc(FA["config"], 262144) or ""
    def env_on(key): return (env_value(env, key) or "").lower() in ("true", "1", "yes", "on")
    def host_of(url):
        m = re.match(r"^(?:[a-z][a-z0-9+.-]*://)?(?:[^@/]*@)?(\[[0-9a-fA-F:.]+\]|[^:/?#\s]+)", (url or "").strip())
        h = m.group(1).lower() if m else ""
        return h if re.match(r"^[a-z0-9.\[\]:-]{1,253}$", h) else None
    def yaml_block(text, key):
        out, ind = None, None
        for ln in text.splitlines():
            m = re.match(r"^(\s*)%s:\s*(.*)$" % key, ln)
            if ind is None and m:
                ind, out = len(m.group(1)), [m.group(2)]
            elif ind is not None:
                if ln.strip() and len(ln) - len(ln.lstrip()) <= ind: break
                out.append(ln)
        return None if out is None else "\n".join(out)
    names = {t.split(":")[1] for t in ch if t.startswith(FA["prefix"] + ":")}
    facts = {}
    if "discord" in names:
        blk = yaml_block(cfg, "missed_message_backfill") or ""
        m = re.search(r"(?<!\w)enabled:\s*['\"]?(\w+)", blk)
        backfill = m.group(1).lower() in ("true", "1", "yes", "on") if m else env_on("DISCORD_MISSED_MESSAGE_BACKFILL")
        m = re.search(r"(?<!\w)channels:[ \t]*(.*)", blk)
        listed = ""
        if m:
            listed = m.group(1).strip().strip("'\"") or " ".join(re.findall(r"^\s*-\s*(\S+)", blk[m.end():], re.M))
        listed = listed or env_value(env, "DISCORD_MISSED_MESSAGE_BACKFILL_CHANNELS") or ""
        facts["discord"] = {"backfill": backfill, "backfillChannels": len(re.findall(r"\d{5,}", listed)),
                            "backfillAllChannels": "*" in listed, "dmsAllowed": True}
    if "matrix" in names:
        facts["matrix"] = {"homeserverHost": host_of(env_value(env, "MATRIX_HOMESERVER")),
                           "passwordLogin": bool(env_value(env, "MATRIX_PASSWORD")) and not env_value(env, "MATRIX_ACCESS_TOKEN")}
    if "email" in names: facts["email"] = {"imapHost": host_of(env_value(env, "EMAIL_IMAP_HOST"))}
    if "telegram" in names: facts.update(telegram={"webhookMode": bool(env_value(env, "TELEGRAM_WEBHOOK_URL"))})
    if "slack" in names: facts["slack"] = {"socketMode": bool(env_value(env, "SLACK_APP_TOKEN"))}
    if facts: OUT["channelFacts"] = facts
# Wake facts, read from where the profile says the credential lives: a fingerprint, never the value.
def loc_val(l):
    if l["kind"] == "env": return env_value(rdc(l["path"], 65536) or "", l["key"])
    if l["kind"] == "json":
        o = walk(rjc(l["path"], 262144), l["at"])
        if isinstance(o, str): return o or None
        return None if o is None or o is False or o == [] or o == {} else "set"
    if l["kind"] == "regex": return "set" if re.search(l["pattern"], rdc(l["path"], 262144) or "", re.M) else None
    err("profile"); return None
def fp_of(locs):
    vals = [loc_val(l) or "" for l in locs]
    return hashlib.sha256("\n".join(vals).encode("utf-8")).hexdigest()[:16] if vals and all(vals) else None
TG = PF.get("telegram")
if TG is not None:
    fp = fp_of(TG["credential"])
    OUT["telegram"] = {"hermesFp": fp, "hermesTokenInEnv": fp is not None,
                       "hermesWebhookMode": bool(TG["webhook"] and loc_val(TG["webhook"])),
                       "hermesConfigToken": any(bool(loc_val(l)) for l in TG["shadow"])}
if PF.get("fps") is not None: OUT["channelFps"] = {c: fp_of(locs) for c, locs in PF["fps"].items()}
# ---- the chat safety net: a connection to a chat service that no declared channel's process holds ----
for _t in _RT: _t.join(max(0.0, DNS_DL - time.time()))
WANT = {}
for e in PF["endpoints"]:
    addrs = set(e["a"])
    for h in e.get("h", [])[:4]: addrs.update(RES.get(h, ()))
    for a in addrs:
        for port in e["ports"]: WANT[(a.upper(), port)] = e["p"]
hits = []
if WANT:
    for c in tcp_rows():
        try:
            if len(c) > 9 and c[3] == "01":
                a, port = c[2].rsplit(":", 1)
                pl = WANT.get((a.upper(), int(port, 16)))
                if pl: hits.append((pl, c[9]))
        except ValueError: pass
if hits:
    need, owners = {i for _, i in hits}, {}
    for q in list(procs)[:5000]:
        try: fds = os.listdir("/proc/%d/fd" % q)
        except OSError: continue
        for fd in fds[:4096]:
            try: l = os.readlink("/proc/%d/fd/%s" % (q, fd))
            except OSError: continue
            if l.startswith("socket:[") and l[8:-1] in need: owners[l[8:-1]] = q
    # Only the process that holds the socket itself counts (its threads share its
    # descriptors). A process started under it (a second bot run from the agent's
    # terminal tool) is not the declared channel, and a unit's or container's
    # worker processes are matched by their cgroup, which they inherit.
    def held(pl, pid):
        for s in PF["channels"]:
            m = s.get("owner") or s.get("up")
            tag = s["tag"] if "tag" in s else s["prefix"] + ":" + pl
            if (s.get("platform", pl) != pl) or tag not in ch or not m: continue
            if pid is not None and match(pid, m): return True
        return False
    for pl, ino in hits:
        if not held(pl, owners.get(ino)): add("unknown:" + pl)
# ---- the CPU safety net: an agent process working hard right now is busy ----
CPU = PF.get("cpu")
if CPU:
    def owned(q):
        try: return os.stat("/proc/%d" % q).st_uid != 0
        except OSError: return False
    cand = [q for q, v in procs.items() if v[2] and (owned(q) or any(match(q, m) for m in PF["procs"]))][:3000]
    rest = CPU["ms"] / 1000.0 - (time.time() - TP)
    if rest > 0: time.sleep(rest)
    dt = max(time.time() - TP, 0.05)
    hz = os.sysconf("SC_CLK_TCK") or 100
    busy_cpu = 0
    for q in cand:
        st = rd("/proc/%d/stat" % q, 4096)
        if not st: continue
        try: r = st.rsplit(")", 1)[1].split(); ticks = int(r[11]) + int(r[12])
        except (ValueError, IndexError): continue
        if (ticks - procs[q][3]) * 100.0 / hz / dt >= CPU["pct"]: busy_cpu += 1
    OUT["cpuBusy"] = busy_cpu
    cli_busy += busy_cpu
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

/** The profile probe with its input: the JSON travels as base64 on the program's first line. */
export function buildProfileProbeProgram(profileJson: string): string {
  // Validates it is JSON at all; the server built it (agent-profiles probeProfileJson).
  JSON.parse(profileJson);
  const b64 = Buffer.from(profileJson, "utf8").toString("base64");
  return `PROFILE_B64 = "${b64}"\n${PROFILE_PROBE_BODY}`;
}
