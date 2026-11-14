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

/**
 * Reads one KEY=value from a .env text the way python-dotenv does for plain
 * files: the last assignment wins, an optional "export " is allowed, and one
 * pair of matching quotes is removed. Shared by the Telegram probe and the
 * token read, so the fingerprint on both sides comes from the same value.
 */
export const TELEGRAM_ENV_VALUE_PY = String.raw`def env_value(text, key):
    v = None
    for ln in (text or "").splitlines():
        m = re.match(r"^\s*(?:export\s+)?" + key + r"\s*=(.*)$", ln)
        if m: v = m.group(1).strip()
    if v is None: return None
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'": v = v[1:-1]
    else: v = re.split(r"\s+#", v, 1)[0].strip()
    return v or None`;

export const IDLE_PROBE_PROGRAM = String.raw`import calendar, errno, json, os, re, signal, subprocess, sys, time
# hivra-idle-probe v1. Runs as root via the guest agent. Counts and times only.
# BaseException, so no "except OSError" or "except Exception" below can swallow the alarm.
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
os.environ["PATH"] = "/usr/sbin:/usr/bin:/sbin:/bin"
OUT = {"v": 1, "errors": []}
def err(k):
    if k not in OUT["errors"]: OUT["errors"].append(k)
def iso(t): return None if t is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
# A file that is not there is fine. A file that is there and cannot be read is
# an error: the answer is then unknown, and an unknown answer never lets the
# agent sleep. /proc files are read in a loop to the end, because one read of a
# multi-record file such as /proc/net/tcp stops after about 4 KB.
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
${TELEGRAM_ENV_VALUE_PY}
def active(unit):
    try:
        return subprocess.run(["systemctl", "is-active", "--quiet", unit], timeout=2).returncode == 0
    except Exception: err("systemctl"); return False
tg = rd("/etc/bux/tg.env", 8192) or ""
if re.search(r"^TG_BOT_TOKEN=\S", tg, re.M) and active("bux-tg"): ch.append("telegram:bux-tg")
env = rd(HOME + "/.hermes/.env", 65536) or ""
hermes_gw = any("hermes" in v[2] and " gateway" in v[2] for v in procs.values())
def hermes_ch(name):
    tag = "hermes:" + name + ("" if hermes_gw else ":down")
    if tag not in ch: ch.append(tag)
# Hermes's own record of the platforms its gateway runs (gateway/status.py). Every
# platform in it is live, whatever its state, except Hivra's own chat API and the
# CLI, and a platform the gateway itself marked disabled. While the gateway runs
# the record must be there and readable: otherwise the answer is unknown.
NOT_CHANNELS = ("api_server", "local")
def gateway_platforms(p, required):
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
        if name and name not in NOT_CHANNELS: hermes_ch(name)
gateway_platforms(HOME + "/.hermes/gateway_state.json", hermes_gw)
try:
    for prof in sorted(os.listdir(HOME + "/.hermes/profiles"))[:50]: gateway_platforms("%s/.hermes/profiles/%s/gateway_state.json" % (HOME, prof), False)
except OSError: pass
# The .env and config.yaml are a second source: they also name a channel whose gateway is down.
for k, name in (("TELEGRAM_BOT_TOKEN", "telegram"), ("DISCORD_BOT_TOKEN", "discord"), ("SLACK_BOT_TOKEN", "slack"),
                ("WHATSAPP_(?!CLOUD_)", "whatsapp"), ("WHATSAPP_CLOUD_", "whatsapp_cloud"), ("SIGNAL_", "signal"),
                ("MATRIX_ACCESS_TOKEN", "matrix"), ("MATRIX_PASSWORD", "matrix"), ("MATTERMOST_TOKEN", "mattermost"),
                ("EMAIL_", "email"), ("TWILIO_ACCOUNT_SID", "sms"), ("BLUEBUBBLES_SERVER_URL", "bluebubbles"),
                ("DINGTALK_CLIENT_ID", "dingtalk"), ("FEISHU_APP_ID", "feishu"), ("QQ_APP_ID", "qqbot"),
                ("WECOM_BOT_ID", "wecom"), ("WECOM_CALLBACK_CORP_ID", "wecom_callback"), ("WEIXIN_TOKEN", "weixin"),
                ("GOOGLE_CHAT_SERVICE_ACCOUNT_JSON", "google_chat"), ("IRC_SERVER", "irc"), ("LINE_CHANNEL_ACCESS_TOKEN", "line"),
                ("TEAMS_CLIENT_ID", "teams"), ("SIMPLEX_WS_URL", "simplex"), ("NTFY_TOPIC", "ntfy"),
                ("PHOTON_PROJECT_ID", "photon"), ("RAFT_PROFILE", "raft"), ("BUZZ_RELAY_URL", "buzz")):
    if re.search(r"^%s\w*=\S" % k, env, re.M): hermes_ch(name)
cfg = rd(HOME + "/.hermes/config.yaml", 262144) or ""
for name in re.findall(r"^  (\w+):\s*\n(?:    .*\n)*?    enabled:\s*true", cfg, re.M): hermes_ch(name)
# Per-channel facts for the wake adapters. Modes and host names only, never a secret.
def env_on(key): return (env_value(env, key) or "").lower() in ("true", "1", "yes", "on")
def host_of(url):
    m = re.match(r"^(?:[a-z][a-z0-9+.-]*://)?(?:[^@/]*@)?(\[[0-9a-fA-F:.]+\]|[^:/?#\s]+)", (url or "").strip())
    h = m.group(1).lower() if m else ""
    return h if re.match(r"^[a-z0-9.\[\]:-]{1,253}$", h) else None
def yaml_block(text, key):
    # The lines indented under "key:" (any depth), or the rest of its line when written inline.
    out, ind = None, None
    for ln in text.splitlines():
        m = re.match(r"^(\s*)%s:\s*(.*)$" % key, ln)
        if ind is None and m:
            ind, out = len(m.group(1)), [m.group(2)]
        elif ind is not None:
            if ln.strip() and len(ln) - len(ln.lstrip()) <= ind: break
            out.append(ln)
    return None if out is None else "\n".join(out)
names = {t.split(":")[1] for t in ch if t.startswith("hermes:")}
facts = {}
if "discord" in names:
    blk = yaml_block(cfg, "missed_message_backfill") or ""
    # config.yaml wins over .env, as in the adapter; an empty config list falls through to .env.
    m = re.search(r"(?<!\w)enabled:\s*['\"]?(\w+)", blk)
    backfill = m.group(1).lower() in ("true", "1", "yes", "on") if m else env_on("DISCORD_MISSED_MESSAGE_BACKFILL")
    m = re.search(r"(?<!\w)channels:[ \t]*(.*)", blk)
    listed = ""
    if m:
        listed = m.group(1).strip().strip("'\"") or " ".join(re.findall(r"^\s*-\s*(\S+)", blk[m.end():], re.M))
    listed = listed or env_value(env, "DISCORD_MISSED_MESSAGE_BACKFILL_CHANNELS") or ""
    # Hermes has no switch that refuses DMs, so DMs are always allowed.
    facts["discord"] = {"backfill": backfill, "backfillChannels": len(re.findall(r"\d{5,}", listed)),
                        "backfillAllChannels": "*" in listed, "dmsAllowed": True}
if "matrix" in names:
    facts["matrix"] = {"homeserverHost": host_of(env_value(env, "MATRIX_HOMESERVER")),
                       "passwordLogin": bool(env_value(env, "MATRIX_PASSWORD")) and not env_value(env, "MATRIX_ACCESS_TOKEN")}
if "email" in names: facts["email"] = {"imapHost": host_of(env_value(env, "EMAIL_IMAP_HOST"))}
if "telegram" in names: facts.update(telegram={"webhookMode": bool(env_value(env, "TELEGRAM_WEBHOOK_URL"))})
if "slack" in names: facts["slack"] = {"socketMode": bool(env_value(env, "SLACK_APP_TOKEN"))}
if facts: OUT["channelFacts"] = facts
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

const TELEGRAM_FACTS_PY = String.raw`# Telegram wake facts: a fingerprint of the .env token, never the token.
import hashlib
tok = env_value(env, "TELEGRAM_BOT_TOKEN")
OUT["telegram"] = {
    "hermesFp": hashlib.sha256(tok.encode("utf-8")).hexdigest()[:16] if tok else None,
    "hermesTokenInEnv": bool(tok),
    "hermesWebhookMode": bool(env_value(env, "TELEGRAM_WEBHOOK_URL")),
    "hermesConfigToken": bool(re.search(r"^  telegram:\s*\n(?:    .*\n)*?    (?:bot_)?token:\s*\S", cfg, re.M)),
}
`;

const TELEGRAM_FACTS_ANCHOR = `oc = rjson(HOME + "/.openclaw/openclaw.json", 262144)\n`;

function withTelegramFacts(program: string): string {
  if (!program.includes(TELEGRAM_FACTS_ANCHOR)) throw new Error("idle probe: Telegram anchor missing");
  return program.replace(TELEGRAM_FACTS_ANCHOR, () => TELEGRAM_FACTS_PY + TELEGRAM_FACTS_ANCHOR);
}

/**
 * The probe with one more field, `telegram`, for an agent whose owner turned
 * on Telegram wake. Every other probe runs IDLE_PROBE_PROGRAM unchanged.
 */
export const IDLE_PROBE_TELEGRAM_PROGRAM = withTelegramFacts(IDLE_PROBE_PROGRAM);

/** Per-channel facts the probe reports for a live Hermes channel. Modes and host names only, never a secret. */
export interface ChannelProbeFacts {
  discord?: {
    /** Hermes replays messages missed while the gateway was down (config.yaml or .env). */
    backfill: boolean;
    /** Channel ids listed explicitly for the replay. 0 means Hermes's default set, which holds no DM. */
    backfillChannels: number;
    backfillAllChannels: boolean;
    /** Always true: Hermes has no switch that refuses DMs. */
    dmsAllowed: boolean;
  };
  matrix?: { homeserverHost: string | null; passwordLogin: boolean };
  email?: { imapHost: string | null };
  telegram?: { webhookMode: boolean };
  slack?: { socketMode: boolean };
}

const FACT_HOST = /^[a-z0-9.[\]:-]{1,253}$/;

function factRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function factHost(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && FACT_HOST.test(value) ? value : undefined;
}

/**
 * Strict read of the probe's `channelFacts`. Undefined when the probe sent
 * none; null when it sent something malformed, which a caller treats as
 * unknown (and unknown never lets an agent sleep).
 */
export function parseChannelProbeFacts(value: unknown): ChannelProbeFacts | null | undefined {
  if (value === undefined) return undefined;
  const row = factRecord(value);
  if (!row) return null;
  const out: ChannelProbeFacts = {};
  for (const key of Object.keys(row)) {
    if (!["discord", "matrix", "email", "telegram", "slack"].includes(key)) return null;
  }
  if (row.discord !== undefined) {
    const d = factRecord(row.discord);
    if (!d || typeof d.backfill !== "boolean" || typeof d.backfillAllChannels !== "boolean" || typeof d.dmsAllowed !== "boolean"
        || typeof d.backfillChannels !== "number" || !Number.isInteger(d.backfillChannels)
        || d.backfillChannels < 0 || d.backfillChannels > 100_000) return null;
    out.discord = { backfill: d.backfill, backfillChannels: d.backfillChannels, backfillAllChannels: d.backfillAllChannels, dmsAllowed: d.dmsAllowed };
  }
  if (row.matrix !== undefined) {
    const m = factRecord(row.matrix);
    const host = factHost(m?.homeserverHost);
    if (!m || host === undefined || typeof m.passwordLogin !== "boolean") return null;
    out.matrix = { homeserverHost: host, passwordLogin: m.passwordLogin };
  }
  if (row.email !== undefined) {
    const host = factHost(factRecord(row.email)?.imapHost);
    if (host === undefined) return null;
    out.email = { imapHost: host };
  }
  if (row.telegram !== undefined) {
    const t = factRecord(row.telegram);
    if (!t || typeof t.webhookMode !== "boolean") return null;
    out.telegram = { webhookMode: t.webhookMode };
  }
  if (row.slack !== undefined) {
    const sl = factRecord(row.slack);
    if (!sl || typeof sl.socketMode !== "boolean") return null;
    out.slack = { socketMode: sl.socketMode };
  }
  return out;
}
