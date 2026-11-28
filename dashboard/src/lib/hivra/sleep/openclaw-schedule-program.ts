export const OPENCLAW_SQLITE_PATH = "~/.openclaw/state/openclaw.sqlite";

export const OPENCLAW_SQLITE_SCHEDULE_PY = String.raw`def openclaw_sqlite_jobs(p):
    try:
        try: os.lstat(p)
        except (FileNotFoundError, NotADirectoryError): return
        import pwd
        identity = {}
        if os.geteuid() == 0:
            user = pwd.getpwnam("bux")
            identity = {"user": user.pw_uid, "group": user.pw_gid, "extra_groups": []}
        r = subprocess.run([sys.executable, "-I", "-S", "-c", """
import json, sqlite3, stat, sys
from pathlib import Path
p = Path(sys.argv[1])
if not stat.S_ISREG(p.lstat().st_mode): sys.exit(1)
with sqlite3.connect(p.as_uri() + "?mode=ro", uri=True, timeout=0.25) as db:
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA trusted_schema=OFF")
    times, running = [], 0
    for i, (raw,) in enumerate(db.execute("SELECT CASE WHEN length(state_json) <= 8192 THEN state_json END FROM cron_jobs WHERE enabled = 1 LIMIT 1001")):
        if i >= 1000 or not isinstance(raw, str): sys.exit(1)
        state = json.loads(raw)
        due, active = state.get("nextRunAtMs"), state.get("runningAtMs")
        if active is not None:
            if type(active) is not int or active <= 0: sys.exit(1)
            running += 1
        if due is None and active is not None: continue
        if type(due) is not int or not (0 < due <= 253402300799000): sys.exit(1)
        times.append(due / 1000)
print(json.dumps([times, running]))
""", p], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1.5, check=True, env={}, **identity)
        times, running = json.loads(r.stdout)
        nexts.extend(times)
        OUT["schedRunning"] = OUT.get("schedRunning", 0) + running
    except (KeyError, OSError, ValueError, subprocess.SubprocessError):
        err("openclaw_schedule")
`;
