import { gzipSync } from "zlib";

/**
 * Guest-side jobs for moving an old Hermes agent onto an official Hermes computer
 * (docs/release/HERMES-OFFICIAL-MOVE.md, "The data / How the bytes travel / The jobs").
 *
 * Every job is a bash script started as a detached systemd unit that writes
 * `${MOVE_STATUS_DIR(moveId)}/<job>.json` atomically. Secrets (the move key, signed URLs) are
 * only ever written to mode-600 files inside the move directory by the launcher, read through
 * `openssl -pass file:` and `curl -K`, and deleted by the job when it ends. They never appear in
 * a process argument, a log or a status message.
 */

export interface MovePart { name: string; bytes: number; sha256: string }
export interface MoveCounts { sessions: number; messages: number; skills: number; cronJobs: number; profiles: number; envKeys: string[] }
export type MoveJobName = "pack" | "upload" | "restart-old" | "unpack" | "stop-new-gateway";
export interface MoveJobStatus { state: "running" | "done" | "failed"; step: string; message: string; updatedAt: string; result?: Record<string, unknown> }

export const MOVE_STATUS_DIR = (moveId: string) => `/var/lib/hivra-move/${moveId}`;

/** Parts are at most this many bytes (the project upload limit is 50 MB). */
export const MOVE_PART_BYTES = 45_000_000;
/** Refuse to move more than this (zip + workspace archive, before encryption). */
export const MOVE_MAX_BYTES = 8 * 1024 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_HEX = /^[0-9a-f]{64}$/;
const PART_NAME = /^part-\d{3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`invalid ${what}`);
}
function checkMoveId(v: string) { need(typeof v === "string" && UUID.test(v), "move id"); }
function checkInstanceId(v: string) { need(typeof v === "string" && UUID.test(v), "instance id"); }
function checkKey(v: string) { need(typeof v === "string" && KEY_HEX.test(v), "move key"); }
function checkPartName(v: string) { need(typeof v === "string" && PART_NAME.test(v), "part name"); }
function checkUrl(v: string) {
  need(typeof v === "string" && v.length <= 4096 && /^https:\/\/[^\s"'\\`$<>]+$/.test(v), "signed url");
  let ok = false;
  try { ok = new URL(v).protocol === "https:"; } catch { /* invalid */ }
  need(ok, "signed url");
}
function checkCounts(c: MoveCounts) {
  for (const k of ["sessions", "messages", "skills", "cronJobs", "profiles"] as const) {
    need(Number.isSafeInteger(c?.[k]) && c[k] >= 0, `count ${k}`);
  }
  need(Array.isArray(c.envKeys) && c.envKeys.length <= 2000 && c.envKeys.every((k) => typeof k === "string" && ENV_KEY.test(k)), "env key names");
}
function uniqueNames(names: string[]) { need(new Set(names).size === names.length && names.length > 0 && names.length <= 400, "part list"); }

function b64(s: string): string { return Buffer.from(s, "utf8").toString("base64"); }
function sh(strings: TemplateStringsArray, ...values: unknown[]): string {
  // String.raw with `@{` standing for bash's `${` (so TS interpolation stays usable).
  return String.raw(strings, ...values).replaceAll("@{", "${");
}

// ---------------------------------------------------------------------------------------------
// Embedded Python (python3, standard library only)
// ---------------------------------------------------------------------------------------------

/**
 * Shared by pack and unpack: Hermes backup exclusion rules (mirrors upstream hermes_cli/backup.py
 * and home_data_layout.py) and the counts used before the move and after it.
 */
const COMMON_PY = String.raw`#!/usr/bin/env python3
import json, os, re, sqlite3, sys

# --- upstream hermes_cli/backup.py exclusion rules ---
EXCLUDED_DIRS = {"hermes-agent", "__pycache__", ".git", "node_modules", "backups", "state-snapshots",
                 "checkpoints", "browser-profiles", "browser-profile", ".venv", "venv", "site-packages",
                 ".cache", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
# LOCAL_RUNTIME_ROOT_DIRS | (PM_RUNTIME_ROOT_DIRS - {"cache"}) | browser_profiles | SECRET_CACHE_FILES
EXCLUDED_ROOT_DIRS = {"models", "runtimes", "node", "installs", "tools", "browser_profiles",
                      "bws_cache.json", "bws_cache.enc.json", "op_cache.json", "photon-sidecar.json"}
# Package-manager trees the old Hivra image keeps under the Hermes home. Regenerable, often huge.
HIVRA_EXTRA_ROOT_DIRS = {".local", "uv", "yarn", "npm", "python", "lazy-packages", "pipx", "go", "cargo",
                         "rustup", "bun", "deno", "gem", "composer", "dotnet", "corepack", "pnpm"}
KEPT_CACHE_SUBDIRS = {"images", "audio", "videos", "documents", "screenshots", "citations", "generated"}
EXCLUDED_SUFFIXES = (".pyc", ".pyo", ".db-wal", ".db-shm", ".db-journal")
EXCLUDED_NAMES = {".backup.lock", "gateway.pid", "cron.pid"}
EXCLUDED_PREFIXES = ("state.db.pre-update-emergency-", "state.db.retired-wal-")


def root_entry(parts):
    if len(parts) >= 3 and parts[0] == "profiles":
        return parts[2]
    return parts[0] if parts else None


def in_excluded_root_dir(parts):
    entry = root_entry(parts)
    if entry in EXCLUDED_ROOT_DIRS or entry in HIVRA_EXTRA_ROOT_DIRS:
        return True
    p = parts
    if len(p) >= 3 and p[0] == "profiles":
        p = p[2:]
    return len(p) >= 2 and p[0] == "cache" and p[1] not in KEPT_CACHE_SUBDIRS


def should_exclude_file(name):
    return name in EXCLUDED_NAMES or name.startswith(EXCLUDED_PREFIXES) or name.endswith(EXCLUDED_SUFFIXES)


def walk_files(root):
    """Yield (abs_path, rel_posix) for every regular file a backup holds."""
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root)
        rel_parts = () if rel_dir == "." else tuple(rel_dir.split(os.sep))
        is_root = not rel_parts
        kept = []
        for d in sorted(dirnames):
            if d in EXCLUDED_DIRS and not (d == "hermes-agent" and not is_root):
                continue
            if in_excluded_root_dir(rel_parts + (d,)):
                continue
            if os.path.islink(os.path.join(dirpath, d)):
                continue
            kept.append(d)
        dirnames[:] = kept
        for f in sorted(filenames):
            if should_exclude_file(f):
                continue
            if is_root and f in EXCLUDED_ROOT_DIRS:
                continue
            p = os.path.join(dirpath, f)
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if not (st.st_mode & 0o170000) == 0o100000:
                continue
            yield p, "/".join(rel_parts + (f,))


def db_count(path, table):
    if not os.path.isfile(path):
        return 0
    try:
        conn = sqlite3.connect(path, timeout=30)
        try:
            have = conn.execute("select 1 from sqlite_master where type='table' and name=?", (table,)).fetchone()
            if not have:
                return 0
            return int(conn.execute('select count(*) from "%s"' % table).fetchone()[0])
        finally:
            conn.close()
    except Exception:
        return -1


def env_names(path):
    names = []
    try:
        with open(path, errors="replace") as fh:
            for line in fh.read().splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                if s.startswith("export "):
                    s = s[7:].strip()
                k = s.split("=", 1)[0].strip()
                if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k):
                    names.append(k)
    except OSError:
        pass
    return names


def count_skills(home):
    n = 0
    root = os.path.join(home, "skills")
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if (d not in EXCLUDED_DIRS or d == "hermes-agent") and not os.path.islink(os.path.join(dirpath, d))]
        if "SKILL.md" in filenames:
            n += 1
    return n


def count_cron(home):
    p = os.path.join(home, "cron", "jobs.json")
    try:
        with open(p) as fh:
            data = json.load(fh)
    except Exception:
        return 0
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        jobs = data.get("jobs")
        if isinstance(jobs, list):
            return len(jobs)
        return len(data)
    return 0


def count_profiles(home):
    root = os.path.join(home, "profiles")
    try:
        return len([e for e in os.listdir(root) if os.path.isdir(os.path.join(root, e))])
    except OSError:
        return 0


def counts(home):
    db = os.path.join(home, "state.db")
    return {"sessions": db_count(db, "sessions"), "messages": db_count(db, "messages"),
            "skills": count_skills(home), "cronJobs": count_cron(home), "profiles": count_profiles(home),
            "envKeys": sorted(set(env_names(os.path.join(home, ".env"))))}


def read_text(path):
    try:
        with open(path, errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def model_block(text):
    """provider / base_url / default of the top-level model: block (no YAML library needed)."""
    out = {}
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^model:\s+([^#\s].*?)\s*(#.*)?$", line)
        if m:
            out["default"] = m.group(1).strip("\"'")
            return out
        if re.match(r"^model:\s*(#.*)?$", line):
            indent = None
            for nxt in lines[i + 1:]:
                if not nxt.strip() or nxt.lstrip().startswith("#"):
                    continue
                if not nxt.startswith((" ", "\t")):
                    break
                cur = len(nxt) - len(nxt.lstrip())
                if indent is None:
                    indent = cur
                if cur != indent:
                    continue
                mm = re.match(r"^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$", nxt)
                if mm:
                    v = re.sub(r"\s+#.*$", "", mm.group(2)).strip().strip("\"'")
                    out[mm.group(1)] = v
            return out
    return out


def has_managed(home):
    needle = "/api/managed-venice"
    homes = [home]
    prof = os.path.join(home, "profiles")
    if os.path.isdir(prof):
        homes += [os.path.join(prof, e) for e in sorted(os.listdir(prof))]
    for h in homes:
        if needle in read_text(os.path.join(h, ".env")) or needle in read_text(os.path.join(h, "config.yaml")):
            return True
    return False
`;

/** Pack side: counts, zipper, result assembly. */
export const MOVE_PACK_PY = COMMON_PY + String.raw`

def checkpoint_dbs(home):
    for p, rel in walk_files(home):
        if not (p.endswith(".db") or p.endswith(".sqlite") or p.endswith(".sqlite3")):
            continue
        try:
            st = os.stat(p)
            conn = sqlite3.connect(p, timeout=30)
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
            finally:
                conn.close()
            # the box runs these databases as another user: never leave root-owned sidecars behind
            for suffix in ("-wal", "-shm", "-journal"):
                side = p + suffix
                if os.path.exists(side):
                    try:
                        os.chown(side, st.st_uid, st.st_gid)
                    except OSError:
                        pass
        except Exception:
            pass


def make_zip(home, out):
    import zipfile
    checkpoint_dbs(home)
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True, strict_timestamps=False) as zf:
        for p, rel in walk_files(home):
            try:
                zf.write(p, rel)
                n += 1
            except OSError:
                continue
    return n


def build_result(counts_path, parts_dir, out):
    import hashlib
    c = json.load(open(counts_path))
    managed = bool(c.pop("managedModel", False))
    parts = []
    total = 0
    for name in sorted(os.listdir(parts_dir)):
        if not re.match(r"^part-\d{3}$", name):
            continue
        h = hashlib.sha256()
        size = 0
        with open(os.path.join(parts_dir, name), "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
                size += len(chunk)
        parts.append({"name": name, "bytes": size, "sha256": h.hexdigest()})
        total += size
    doc = {"parts": parts, "counts": c, "managedModel": managed, "totalBytes": total}
    tmp = out + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(doc, fh)
    os.replace(tmp, out)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "counts":
        c = counts(sys.argv[2])
        c["managedModel"] = has_managed(sys.argv[2])
        json.dump(c, open(sys.argv[3], "w"))
    elif mode == "zip":
        print(make_zip(sys.argv[2], sys.argv[3]))
    elif mode == "result":
        build_result(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        sys.exit(2)
`;

/** Unpack side: wiring save, config/env fixup, count verification. */
export const MOVE_UNPACK_PY = COMMON_PY + String.raw`

REMOVE_ENV_EXACT = {"HERMES_INSTANCE_ID", "HERMES_DASHBOARD_URL", "BROWSER_CDP_URL",
                    "HERMES_BROWSER_SIDECAR_AUTH_TOKEN", "TERMINAL_ENV", "TERMINAL_STRICT_BACKEND", "HERMES_HOME"}
REMOVE_ENV_PREFIX = ("API_SERVER_",)
MANAGED_EXTRA_REMOVE = {"HERMES_INFERENCE_PROVIDER"}
OLD_HOME = "/home/hermes/.hermes"
NEW_HOME = "/home/bux/.hermes"
BASE_RE = re.compile(r"^https://[A-Za-z0-9.:/_-]+$")
MODEL_RE = re.compile(r"^[A-Za-z0-9_.:/-]+$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def env_value(text, key):
    val = ""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("export "):
            s = s[7:].strip()
        if s.startswith(key + "="):
            val = s.split("=", 1)[1].strip()
    return val.strip("\"'")


def write_secret(path, data):
    tmp = path + ".next"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def save_wiring(home, out):
    cfg = model_block(read_text(os.path.join(home, "config.yaml")))
    env = read_text(os.path.join(home, ".env"))
    doc = {"provider": cfg.get("provider", ""), "base_url": cfg.get("base_url", ""), "default": cfg.get("default", ""),
           "openai_api_key": env_value(env, "OPENAI_API_KEY"), "openai_base_url": env_value(env, "OPENAI_BASE_URL")}
    write_secret(out, json.dumps(doc))


def rewrite_env(path, managed, wiring):
    if not os.path.isfile(path):
        return []
    removed = []
    out = []
    for line in read_text(path).splitlines():
        s = line.strip()
        k = None
        if s and not s.startswith("#") and "=" in s:
            body = s[7:].strip() if s.startswith("export ") else s
            k = body.split("=", 1)[0].strip()
        if k is not None and (k in REMOVE_ENV_EXACT or k.startswith(REMOVE_ENV_PREFIX)
                              or (managed and k in MANAGED_EXTRA_REMOVE)):
            removed.append(k)
            continue
        if managed and k == "VENICE_API_KEY":
            line = "VENICE_API_KEY=" + wiring["openai_api_key"]
        elif managed and k == "VENICE_BASE_URL":
            line = "VENICE_BASE_URL=" + wiring["openai_base_url"]
        out.append(line)
    write_secret(path, "\n".join(out) + ("\n" if out else ""))
    return removed


def set_env(path, pairs):
    keep = [ln for ln in read_text(path).splitlines()
            if not any(ln.strip().startswith(k + "=") or ln.strip().startswith("export " + k + "=") for k, _ in pairs)]
    keep += [k + "=" + v for k, v in pairs]
    write_secret(path, "\n".join(keep) + "\n")


def rewrite_paths(path):
    if not os.path.isfile(path):
        return False
    text = read_text(path)
    if OLD_HOME not in text:
        return False
    st = os.stat(path)
    tmp = path + ".next"
    with open(tmp, "w") as fh:
        fh.write(text.replace(OLD_HOME, NEW_HOME))
    os.chmod(tmp, st.st_mode & 0o777)
    os.replace(tmp, path)
    return True


def fixup(home, wiring_path, managed):
    homes = [home]
    prof = os.path.join(home, "profiles")
    if os.path.isdir(prof):
        homes += [os.path.join(prof, e) for e in sorted(os.listdir(prof)) if os.path.isdir(os.path.join(prof, e))]
    rewritten = 0
    for h in homes:
        if rewrite_paths(os.path.join(h, "config.yaml")):
            rewritten += 1
    if rewrite_paths(os.path.join(home, "cron", "jobs.json")):
        rewritten += 1
    wiring = {}
    if managed:
        wiring = json.load(open(wiring_path))
        if not (BASE_RE.match(wiring.get("base_url", "")) and KEY_RE.match(wiring.get("openai_api_key", ""))
                and BASE_RE.match(wiring.get("openai_base_url", ""))):
            print("the new computer has no managed model wiring to keep")
            sys.exit(2)
    removed = []
    for h in homes:
        removed += rewrite_env(os.path.join(h, ".env"), managed, wiring)
    set_default = None
    if managed:
        set_env(os.path.join(home, ".env"), [("OPENAI_API_KEY", wiring["openai_api_key"]),
                                             ("OPENAI_BASE_URL", wiring["openai_base_url"])])
        imported = model_block(read_text(os.path.join(home, "config.yaml"))).get("default", "")
        if not imported:
            d = wiring.get("default", "")
            if d and MODEL_RE.match(d):
                set_default = d
    print(json.dumps({"rewritten": rewritten, "removed": sorted(set(removed)), "baseUrl": wiring.get("base_url"),
                      "setDefault": set_default}))


def verify(home, expected_path):
    exp = json.load(open(expected_path))
    ec = exp["counts"]
    managed = bool(exp.get("managedModel"))
    got = counts(home)
    bad = []
    if got["sessions"] < ec["sessions"]:
        bad.append("chats: %d of %d" % (got["sessions"], ec["sessions"]))
    if got["messages"] < ec["messages"]:
        bad.append("messages: %d of %d" % (got["messages"], ec["messages"]))
    for k, label in (("skills", "skills"), ("cronJobs", "scheduled tasks"), ("profiles", "profiles")):
        if got[k] != ec[k]:
            bad.append("%s: %d of %d" % (label, got[k], ec[k]))
    gone = set(REMOVE_ENV_EXACT) | (MANAGED_EXTRA_REMOVE if managed else set())
    have = set(got["envKeys"])
    missing = [k for k in ec["envKeys"] if k not in have and k not in gone and not k.startswith(REMOVE_ENV_PREFIX)]
    if missing:
        bad.append("settings missing: " + ", ".join(sorted(missing)[:10]))
    print(json.dumps(got))
    if bad:
        sys.stderr.write("; ".join(bad) + "\n")
        sys.exit(1)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "wiring-save":
        save_wiring(sys.argv[2], sys.argv[3])
    elif mode == "fixup":
        fixup(sys.argv[2], sys.argv[3], sys.argv[4] == "1")
    elif mode == "verify":
        verify(sys.argv[2], sys.argv[3])
    else:
        sys.exit(2)
`;

const STATUS_PY = String.raw`import json, os, sys, time
d = os.environ["MOVE_DIR"]
job = os.environ["MOVE_JOB"]
state, step, message = sys.argv[1], sys.argv[2], sys.argv[3]
doc = {"state": state, "step": step, "message": message, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
rf = os.path.join(d, job + ".result.json")
if state == "done" and os.path.exists(rf):
    try:
        doc["result"] = json.load(open(rf))
    except Exception:
        pass
tmp = os.path.join(d, job + ".json.tmp")
with open(tmp, "w") as fh:
    json.dump(doc, fh)
os.replace(tmp, os.path.join(d, job + ".json"))
`;

// ---------------------------------------------------------------------------------------------
// Launcher (shared by old and new guests)
// ---------------------------------------------------------------------------------------------

interface JobFile { path: string; content: string }

function buildLauncher(moveId: string, job: MoveJobName, script: string, files: JobFile[] = []): string {
  const dir = MOVE_STATUS_DIR(moveId);
  const unit = `hivra-move-${job}-${moveId}`;
  const lines = [
    "set -e",
    `D=${dir}`,
    `install -d -m 700 /var/lib/hivra-move "$D"`,
    `if systemctl is-active --quiet ${unit}.service 2>/dev/null; then echo "already running"; exit 3; fi`,
    `systemctl reset-failed ${unit}.service >/dev/null 2>&1 || true`,
  ];
  for (const f of files) {
    need(/^[a-z0-9./-]+$/.test(f.path) && !f.path.includes(".."), "job file path");
    lines.push(`install -d -m 700 "$(dirname "$D/${f.path}")"`);
    lines.push(`( umask 077; printf '%s' '${b64(f.content)}' | base64 -d > "$D/${f.path}" )`);
  }
  lines.push(
    `rm -f "$D/${job}.json" "$D/${job}.result.json"`,
    `printf '%s' '${gzipSync(Buffer.from(script, "utf8")).toString("base64")}' | base64 -d | gunzip > "$D/${job}.sh"`,
    `chmod 700 "$D/${job}.sh"`,
    `systemd-run --unit=${unit} --collect --property=Type=exec /bin/bash "$D/${job}.sh" >/dev/null`,
    `echo started`,
  );
  return lines.join("\n");
}

function prelude(moveId: string, job: MoveJobName): string {
  return sh`#!/usr/bin/env bash
set -u -o pipefail
export LC_ALL=C
D=${MOVE_STATUS_DIR(moveId)}
JOB=${job}
STATUS_PY='${STATUS_PY}'
st() { MOVE_DIR="$D" MOVE_JOB="$JOB" python3 -I -c "$STATUS_PY" "$@"; }
`;
}

// ---------------------------------------------------------------------------------------------
// OLD guest
// ---------------------------------------------------------------------------------------------

function oldCommon(instanceId: string): string {
  return sh`INST=${instanceId}
INSTDIR=/opt/hermes/instances/$INST
STATE_SRC=/var/lib/docker/volumes/agent-@{INST}_webui-state/_data
WS_SRC=/var/lib/docker/volumes/agent-@{INST}_webui-workspace/_data
PROJECT_LABEL="com.docker.compose.project=agent-$INST"
PAUSE=/var/lib/hermes-roll-paused-$INST
TOKEN=$(printf '%s' "$INST" | sed 's/[^A-Za-z0-9_.@:-]/_/g')

# Everything on this box that can start the agent's containers again: the roll and static-refresh
# timers of the update stack (the roller also honours the pause marker). Autoheal only restarts
# containers that are running and unhealthy, and the containers are "unless-stopped".
pause_updates() {
  if [ ! -e "$PAUSE" ]; then
    echo "paused for a move to the official Hermes $(date -u +%FT%TZ)" > "$PAUSE" && : > "$D/pause-wrote-marker"
  fi
  local u t
  for u in roll refresh; do
    t="hermes-$u-$TOKEN.timer"
    if systemctl is-enabled --quiet "$t" 2>/dev/null && ! grep -qx "$t" "$D/paused-timers" 2>/dev/null; then
      echo "$t" >> "$D/paused-timers"
    fi
    systemctl disable --now "$t" >/dev/null 2>&1 || true
  done
  local i s busy
  for i in $(seq 1 60); do
    busy=0
    for u in roll refresh; do
      s=$(systemctl is-active "hermes-$u-$TOKEN.service" 2>/dev/null || true)
      case "$s" in inactive|failed|unknown|"") ;; *) busy=1 ;; esac
    done
    [ "$busy" = 0 ] && return 0
    sleep 5
  done
  return 1
}

resume_updates() {
  if [ -e "$D/pause-wrote-marker" ]; then rm -f "$PAUSE" "$D/pause-wrote-marker"; fi
  local t
  if [ -f "$D/paused-timers" ]; then
    while read -r t; do
      if [ -n "$t" ]; then systemctl enable --now "$t" >/dev/null 2>&1 || true; fi
    done < "$D/paused-timers"
    rm -f "$D/paused-timers"
  fi
  return 0
}

project_ids() { docker ps -aq --filter "label=$PROJECT_LABEL" 2>/dev/null; }

start_containers() {
  local ids
  ids=$(project_ids)
  if [ -n "$ids" ]; then docker start $ids >/dev/null 2>&1 || true; fi
  if [ -d "$INSTDIR" ]; then (cd "$INSTDIR" && timeout 300 docker compose up -d >/dev/null 2>&1) || true; fi
  ids=$(project_ids)
  if [ -n "$ids" ]; then docker start $ids >/dev/null 2>&1 || true; fi
}

gateway_running() {
  local g
  g=$(docker ps -q --filter "label=$PROJECT_LABEL" --filter "label=com.docker.compose.service=gateway" --filter status=running 2>/dev/null)
  if [ -n "$g" ]; then return 0; fi
  g=$(docker ps -aq --filter "label=$PROJECT_LABEL" --filter "label=com.docker.compose.service=gateway" 2>/dev/null)
  if [ -n "$g" ]; then return 1; fi
  g=$(docker ps -q --filter "label=$PROJECT_LABEL" --filter status=running 2>/dev/null)
  [ -n "$g" ]
}
`;
}

export function buildPackCommand(p: { moveId: string; instanceId: string; keyHex: string }): string {
  checkMoveId(p.moveId); checkInstanceId(p.instanceId); checkKey(p.keyHex);
  const script = prelude(p.moveId, "pack") + oldCommon(p.instanceId) + sh`
KEY="$D/key"
W="$D/work"
FINISHED=0

recover() {
  start_containers
  resume_updates
}
cleanup() { rm -rf "$W" "$KEY" "$D/bundle.enc" "$D/counts.json"; }
fail() {
  FINISHED=1
  cleanup
  recover
  rm -rf "$D/parts"
  st failed "$1" "$2"
  exit 1
}
on_exit() {
  if [ "$FINISHED" != 1 ]; then
    FINISHED=1
    cleanup
    recover
    st failed unexpected "Packing stopped unexpectedly. Your agent was started again as it was."
  fi
}
trap on_exit EXIT

rm -rf "$W" "$D/parts"
mkdir -p "$W" "$D/parts"
chmod 700 "$W" "$D/parts"
st running checking "Checking your agent's data on the old computer."

[ -d "$INSTDIR" ] || fail checking "This computer does not hold this agent, so nothing was moved."
[ -d "$STATE_SRC" ] || fail checking "The agent's data volume was not found, so nothing was moved."
case "$(systemctl is-active hermes-nofork-migrate-$INST.service 2>/dev/null || true)" in
  inactive|failed|unknown|"") ;;
  *) fail checking "An update of this agent is still running. Try the move again in a few minutes." ;;
esac
[ -n "$(project_ids)" ] || fail checking "This agent has no containers on this computer, so nothing was moved."
command -v openssl >/dev/null 2>&1 || fail checking "This computer cannot encrypt the move (openssl is missing)."
command -v python3 >/dev/null 2>&1 || fail checking "This computer cannot pack the move (python3 is missing)."

cat > "$D/pack_tool.py" <<'PY'
${MOVE_PACK_PY}
PY

st running counting "Counting your chats, skills and settings."
python3 -I "$D/pack_tool.py" counts "$STATE_SRC" "$D/counts.json" || fail counting "Could not read the agent's data, so nothing was moved."

RAW=$(du -sb "$STATE_SRC" "$WS_SRC" 2>/dev/null | awk '{s+=$1} END {print s+0}')
CAP=${MOVE_MAX_BYTES}
if [ "$RAW" -gt "$CAP" ]; then RAW=$CAP; fi
AVAIL=$(df -B1 --output=avail "$D" | tail -1 | tr -d ' ')
[ "$AVAIL" -ge $((RAW * 3 + 536870912)) ] || fail checking "The old computer does not have enough free disk space to pack the move, so nothing was moved."

st running stopping "Pausing updates and stopping your agent so its data is consistent."
pause_updates || fail stopping "Automatic updates on the old computer could not be paused, so nothing was moved. Your agent was started again."
IDS=$(project_ids)
docker stop -t 60 $IDS >/dev/null 2>&1 || true
[ -z "$(docker ps -q --filter "label=$PROJECT_LABEL" 2>/dev/null)" ] || fail stopping "Your agent could not be stopped cleanly, so nothing was moved. It was started again."

st running zipping "Packing your chats, memory, skills and settings."
python3 -I "$D/pack_tool.py" zip "$STATE_SRC" "$W/hermes-home.zip" >/dev/null || fail zipping "Packing your agent's settings failed. Your agent was started again."

st running archiving "Packing your workspace files."
WS_NAME=workspace.tar.zst
if [ -d "$WS_SRC" ]; then WS_DIR="$WS_SRC"; else mkdir -p "$W/emptyws"; WS_DIR="$W/emptyws"; fi
if command -v zstd >/dev/null 2>&1; then
  tar -C "$WS_DIR" --exclude=node_modules --exclude=.venv --exclude=venv --exclude=__pycache__ --exclude=.cache -cf - . | zstd -q -T0 -3 -o "$W/$WS_NAME"
  RC=$?
else
  WS_NAME=workspace.tar.gz
  tar -C "$WS_DIR" --exclude=node_modules --exclude=.venv --exclude=venv --exclude=__pycache__ --exclude=.cache -cf - . | gzip -3 > "$W/$WS_NAME"
  RC=$?
fi
[ "$RC" = 0 ] || fail archiving "Packing your workspace files failed. Your agent was started again."
TOTAL=$(( $(stat -c %s "$W/hermes-home.zip") + $(stat -c %s "$W/$WS_NAME") ))
[ "$TOTAL" -le "$CAP" ] || fail archiving "Your agent's data is larger than the 8 GB this move supports, so nothing was moved. Your agent was started again."

st running encrypting "Encrypting your data."
tar -C "$W" -cf "$W/bundle.tar" hermes-home.zip "$WS_NAME" || fail encrypting "Packing your data failed. Your agent was started again."
rm -f "$W/hermes-home.zip" "$W/workspace.tar.zst" "$W/workspace.tar.gz"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt -pass "file:$KEY" -in "$W/bundle.tar" -out "$D/bundle.enc" \
  || fail encrypting "Encrypting your data failed. Your agent was started again."
rm -f "$W/bundle.tar"

st running splitting "Splitting your data into parts for upload."
split -b ${MOVE_PART_BYTES} -d -a 3 "$D/bundle.enc" "$D/parts/part-" || fail splitting "Splitting your data failed. Your agent was started again."
rm -f "$D/bundle.enc"
python3 -I "$D/pack_tool.py" result "$D/counts.json" "$D/parts" "$D/$JOB.result.json" || fail splitting "Checking your packed data failed. Your agent was started again."

FINISHED=1
cleanup
st done packed "Your data is packed and encrypted. Your agent stays stopped until the move finishes."
`;
  return buildLauncher(p.moveId, "pack", script, [{ path: "key", content: p.keyHex }]);
}

export function buildUploadCommand(p: { moveId: string; instanceId: string; uploads: { name: string; url: string }[] }): string {
  checkMoveId(p.moveId); checkInstanceId(p.instanceId);
  need(Array.isArray(p.uploads), "upload list");
  p.uploads.forEach((u) => { checkPartName(u.name); checkUrl(u.url); });
  uniqueNames(p.uploads.map((u) => u.name));
  const dir = MOVE_STATUS_DIR(p.moveId);
  const files = p.uploads.map((u) => ({
    path: `up/${u.name}.curl`,
    content: [
      `url = "${u.url}"`,
      `upload-file = "${dir}/parts/${u.name}"`,
      `request = "PUT"`,
      `header = "x-upsert: true"`,
      `header = "content-type: application/octet-stream"`,
      `header = "cache-control: max-age=3600"`,
      `proto = "=https"`,
      `fail`, `silent`, `show-error`,
      `retry = 3`, `retry-delay = 5`, `retry-all-errors`,
      `connect-timeout = 30`, `max-time = 1200`,
      `output = "/dev/null"`,
      "",
    ].join("\n"),
  }));
  const script = prelude(p.moveId, "upload") + sh`
FINISHED=0
cleanup() { rm -rf "$D/up"; }
fail() { FINISHED=1; cleanup; st failed "$1" "$2"; exit 1; }
trap '[ "$FINISHED" = 1 ] || { FINISHED=1; cleanup; st failed unexpected "Copying your data stopped unexpectedly. Your agent stays stopped; the move can be retried."; }' EXIT

N=$(ls "$D"/up/part-*.curl 2>/dev/null | wc -l)
[ "$N" -gt 0 ] || fail uploading "There is nothing to copy."
I=0
for cfg in "$D"/up/part-*.curl; do
  I=$((I + 1))
  name=$(basename "$cfg" .curl)
  [ -f "$D/parts/$name" ] || fail uploading "A packed part is missing on the old computer, so the data was not copied."
  st running uploading "Copying your data: part $I of $N."
  curl -K "$cfg" || fail uploading "Copying part $I of $N failed. Your agent stays stopped; the move can be retried."
done
python3 -I -c 'import json,sys; json.dump({"uploaded": int(sys.argv[1])}, open(sys.argv[2], "w"))' "$N" "$D/$JOB.result.json"
FINISHED=1
cleanup
st done uploaded "Your data is copied. Your agent stays stopped until the move finishes."
`;
  return buildLauncher(p.moveId, "upload", script, files);
}

export function buildRestartOldCommand(p: { moveId: string; instanceId: string }): string {
  checkMoveId(p.moveId); checkInstanceId(p.instanceId);
  const script = prelude(p.moveId, "restart-old") + oldCommon(p.instanceId) + sh`
FINISHED=0
trap '[ "$FINISHED" = 1 ] || { FINISHED=1; st failed unexpected "Starting your old agent stopped unexpectedly."; }' EXIT
st running starting "Starting your old agent again."
[ -d "$INSTDIR" ] || { FINISHED=1; st failed starting "The old agent's files were not found on this computer."; exit 1; }
resume_updates
start_containers
for i in $(seq 1 60); do
  if gateway_running; then
    FINISHED=1
    st done started "Your old agent is running again."
    exit 0
  fi
  sleep 3
done
FINISHED=1
st failed starting "Your old agent's containers did not start."
exit 1
`;
  return buildLauncher(p.moveId, "restart-old", script);
}

export function buildReadOldStatusCommand(moveId: string, job: "pack" | "upload" | "restart-old"): string {
  checkMoveId(moveId);
  need(job === "pack" || job === "upload" || job === "restart-old", "job name");
  return `cat ${MOVE_STATUS_DIR(moveId)}/${job}.json 2>/dev/null || true`;
}

// ---------------------------------------------------------------------------------------------
// NEW guest
// ---------------------------------------------------------------------------------------------

const NEW_COMMON = sh`AGENT_USER=bux
AGENT_HOME=/home/bux
HH=/home/bux/.hermes
HBIN=/home/bux/.local/bin/hermes
BUX_UID=$(id -u bux 2>/dev/null || echo 0)
RUNDIR=/run/user/$BUX_UID
ubux() { sudo -u bux -H env HOME=$AGENT_HOME XDG_RUNTIME_DIR=$RUNDIR DBUS_SESSION_BUS_ADDRESS=unix:path=$RUNDIR/bus "$@"; }
user_manager() {
  loginctl enable-linger bux >/dev/null 2>&1 || true
  systemctl start "user@$BUX_UID.service" >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 20); do [ -S "$RUNDIR/bus" ] && return 0; sleep 1; done
  return 1
}
stop_gateway() {
  local u
  if [ -S "$RUNDIR/bus" ]; then
    for u in $(ubux systemctl --user list-unit-files 'hermes-gateway*.service' --no-legend 2>/dev/null | awk '{print $1}'); do
      ubux systemctl --user stop "$u" >/dev/null 2>&1 || true
    done
  fi
  return 0
}
`;

export function buildUnpackGuestScript(p: {
  moveId: string; keyHex: string;
  downloads: { name: string; url: string; sha256: string; bytes: number }[];
  expectedCounts: MoveCounts; managedModel: boolean;
}): string {
  checkMoveId(p.moveId); checkKey(p.keyHex); checkCounts(p.expectedCounts);
  need(typeof p.managedModel === "boolean", "managedModel");
  need(Array.isArray(p.downloads), "download list");
  p.downloads.forEach((d) => {
    checkPartName(d.name); checkUrl(d.url);
    need(typeof d.sha256 === "string" && SHA256.test(d.sha256), "sha256");
    need(Number.isSafeInteger(d.bytes) && d.bytes > 0 && d.bytes <= 100_000_000, "part size");
  });
  uniqueNames(p.downloads.map((d) => d.name));
  const dir = MOVE_STATUS_DIR(p.moveId);
  const files: JobFile[] = [
    { path: "key", content: p.keyHex },
    { path: "expected.json", content: JSON.stringify({ counts: p.expectedCounts, managedModel: p.managedModel }) },
    { path: "parts.tsv", content: p.downloads.map((d) => `${d.name} ${d.bytes} ${d.sha256}`).join("\n") + "\n" },
    ...p.downloads.map((d) => ({
      path: `dl/${d.name}.curl`,
      content: [
        `url = "${d.url}"`,
        `output = "${dir}/dl/${d.name}"`,
        `proto = "=https"`, `tlsv1.2`,
        `fail`, `silent`, `show-error`,
        `retry = 3`, `retry-delay = 5`, `retry-all-errors`,
        `connect-timeout = 30`, `max-time = 1200`,
        "",
      ].join("\n"),
    })),
  ];
  const script = prelude(p.moveId, "unpack") + NEW_COMMON + sh`
MANAGED=${p.managedModel ? 1 : 0}
KEY="$D/key"
W="$D/work"
WIRING="$D/managed-wiring.json"
IMPORT_DIR="$AGENT_HOME/.hivra-move-import"
FINISHED=0

cleanup() { rm -rf "$W" "$D/dl" "$D/bundle.enc" "$KEY" "$WIRING" "$IMPORT_DIR" "$D/expected.json" "$D/parts.tsv"; }
fail() {
  FINISHED=1
  cleanup
  st failed "$1" "$2"
  exit 1
}
trap '[ "$FINISHED" = 1 ] || { FINISHED=1; cleanup; st failed unexpected "Unpacking stopped unexpectedly. The new computer was left stopped."; }' EXIT

rm -rf "$W"
mkdir -p "$W"
chmod 700 "$W"
st running checking "Checking the new computer."

[ -x "$HBIN" ] || fail checking "The official Hermes is not installed on the new computer."
for c in openssl python3 tar curl; do command -v $c >/dev/null 2>&1 || fail checking "The new computer is missing $c."; done
if [ -e /workspace ] || [ -L /workspace ]; then
  [ -L /workspace ] && [ "$(readlink /workspace)" = "$AGENT_HOME/workspace" ] \
    || fail checking "The new computer already has a /workspace folder, so nothing was unpacked."
fi
SUM=$(awk '{s+=$2} END {print s+0}' "$D/parts.tsv")
AVAIL=$(df -B1 --output=avail "$D" | tail -1 | tr -d ' ')
[ "$AVAIL" -ge $((SUM * 4 + 1073741824)) ] || fail checking "The new computer does not have enough free disk space to unpack your data."

cat > "$D/unpack_tool.py" <<'PY'
${MOVE_UNPACK_PY}
PY

N=$(wc -l < "$D/parts.tsv")
I=0
while read -r name bytes sha; do
  I=$((I + 1))
  st running downloading "Downloading your data: part $I of $N."
  curl -K "$D/dl/$name.curl" || fail downloading "Downloading part $I of $N failed."
  [ "$(stat -c %s "$D/dl/$name" 2>/dev/null || echo -1)" = "$bytes" ] || fail downloading "Part $I of $N arrived with the wrong size."
  [ "$(sha256sum "$D/dl/$name" | awk '{print $1}')" = "$sha" ] || fail downloading "Part $I of $N did not match its checksum."
done < "$D/parts.tsv"

st running decrypting "Decrypting your data."
while read -r name bytes sha; do cat "$D/dl/$name" >> "$D/bundle.enc"; rm -f "$D/dl/$name"; done < "$D/parts.tsv"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass "file:$KEY" -in "$D/bundle.enc" -out "$W/bundle.tar" \
  || fail decrypting "Your data could not be decrypted."
rm -f "$D/bundle.enc"
tar -C "$W" -xf "$W/bundle.tar" || fail decrypting "Your data could not be unpacked."
rm -f "$W/bundle.tar"
[ -f "$W/hermes-home.zip" ] || fail decrypting "The packed data has no Hermes settings in it."
WS_FILE=$(ls "$W"/workspace.tar.* 2>/dev/null | head -1)

st running stopping "Stopping the new computer's Hermes while your data goes in."
systemctl stop bux-hermes >/dev/null 2>&1 || true
user_manager || true
stop_gateway
if [ "$MANAGED" = 1 ]; then
  python3 -I "$D/unpack_tool.py" wiring-save "$HH" "$WIRING" || fail stopping "Could not read the new computer's model settings."
fi

st running importing "Restoring your chats, memory, skills and settings with Hermes's own importer."
install -d -m 700 -o bux -g bux "$IMPORT_DIR"
cp "$W/hermes-home.zip" "$IMPORT_DIR/hermes-home.zip"
chown bux:bux "$IMPORT_DIR/hermes-home.zip"
timeout 1800 sudo -u bux -H env HOME=$AGENT_HOME HERMES_HOME=$HH "$HBIN" import "$IMPORT_DIR/hermes-home.zip" --force </dev/null >"$D/import.log" 2>&1 \
  || fail importing "Hermes could not import your data. The new computer was left stopped."
rm -rf "$IMPORT_DIR" "$W/hermes-home.zip"

st running workspace "Restoring your workspace files."
mkdir -p "$AGENT_HOME/workspace"
if [ -n "$WS_FILE" ]; then
  case "$WS_FILE" in
    *.zst) command -v zstd >/dev/null 2>&1 || apt-get install -y zstd >/dev/null 2>&1 || true
           tar -C "$AGENT_HOME/workspace" --zstd --no-same-owner --no-overwrite-dir -xf "$WS_FILE" || fail workspace "Your workspace files could not be restored." ;;
    *)     tar -C "$AGENT_HOME/workspace" -z --no-same-owner --no-overwrite-dir -xf "$WS_FILE" || fail workspace "Your workspace files could not be restored." ;;
  esac
fi
rm -rf "$W"
chown -R bux:bux "$AGENT_HOME/workspace"
[ -L /workspace ] || ln -s "$AGENT_HOME/workspace" /workspace || fail workspace "Could not link /workspace to your files."

st running settings "Adjusting settings for the new computer."
FIX=$(python3 -I "$D/unpack_tool.py" fixup "$HH" "$WIRING" "$MANAGED") || fail settings "Could not adjust your settings for the new computer. ($FIX)"
chmod 700 "$HH"
chown -R bux:bux "$HH"
hermes_cfg() { sudo -u bux -H env HOME=$AGENT_HOME HERMES_HOME=$HH "$HBIN" config set "$1" "$2" >/dev/null 2>&1; }
if [ "$MANAGED" = 1 ]; then
  BASEURL=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["base_url"])' "$WIRING")
  SETDEFAULT=$(printf '%s' "$FIX" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("setDefault") or "")')
  hermes_cfg model.provider custom || fail settings "Could not set the model provider."
  hermes_cfg model.base_url "$BASEURL" || fail settings "Could not set the model endpoint."
  if [ -n "$SETDEFAULT" ]; then hermes_cfg model.default "$SETDEFAULT" || fail settings "Could not set the model."; fi
fi
find "$HH" -maxdepth 3 -name .env -exec chmod 600 {} +
chown -R bux:bux "$HH"

st running verifying "Checking that everything arrived."
COUNTS=$(python3 -I "$D/unpack_tool.py" verify "$HH" "$D/expected.json" 2>"$D/verify.err") \
  || fail verifying "Some of your data did not arrive ($(head -c 300 "$D/verify.err" | tr '\n' ' ')). The new computer was left stopped."

st running starting "Starting Hermes on the new computer."
systemctl start bux-hermes || fail starting "Hermes did not start on the new computer."
GATEWAY=stopped
if user_manager; then
  if [ ! -f "$AGENT_HOME/.config/systemd/user/hermes-gateway.service" ]; then
    ubux env HERMES_HOME=$HH "$HBIN" gateway install >"$D/gateway-install.log" 2>&1 || true
  fi
  ubux systemctl --user daemon-reload >/dev/null 2>&1 || true
  ubux systemctl --user enable hermes-gateway.service >/dev/null 2>&1 || true
  ubux systemctl --user restart hermes-gateway.service >/dev/null 2>&1 || true
  for i in $(seq 1 30); do
    if [ "$(ubux systemctl --user is-active hermes-gateway.service 2>/dev/null || true)" = active ]; then GATEWAY=running; break; fi
    sleep 1
  done
fi
if [ "$(systemctl is-active bux-hermes 2>/dev/null || true)" != active ]; then
  fail starting "Hermes stopped right after starting on the new computer."
fi
python3 -I -c 'import json,sys; json.dump({"counts": json.loads(sys.argv[1]), "gateway": sys.argv[2]}, open(sys.argv[3], "w"))' "$COUNTS" "$GATEWAY" "$D/$JOB.result.json"
FINISHED=1
cleanup
if [ "$GATEWAY" = running ]; then
  st done finished "Your data is on the new computer and Hermes is running."
else
  st done finished "Your data is on the new computer, but the chat and scheduled-task service did not start."
fi
`;
  return buildLauncher(p.moveId, "unpack", script, files);
}

export function buildStopNewGatewayGuestScript(moveId: string): string {
  checkMoveId(moveId);
  const script = prelude(moveId, "stop-new-gateway") + NEW_COMMON + sh`
st running stopping "Stopping the chat and scheduled-task service on the new computer."
stop_gateway
for i in $(seq 1 15); do
  s=$(ubux systemctl --user is-active hermes-gateway.service 2>/dev/null || true)
  case "$s" in active|activating|deactivating) sleep 1 ;; *) st done stopped "The new computer's chat service is stopped."; exit 0 ;; esac
done
st failed stopping "The new computer's chat service did not stop."
exit 1
`;
  return buildLauncher(moveId, "stop-new-gateway", script);
}

export function buildReadNewStatusGuestScript(moveId: string, job: "unpack" | "stop-new-gateway"): string {
  checkMoveId(moveId);
  need(job === "unpack" || job === "stop-new-gateway", "job name");
  return `cat ${MOVE_STATUS_DIR(moveId)}/${job}.json 2>/dev/null || true\n`;
}

// ---------------------------------------------------------------------------------------------

export function parseMoveJobStatus(stdout: string | null | undefined): MoveJobStatus | null {
  if (typeof stdout !== "string") return null;
  const text = stdout.trim();
  if (!text) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // tolerate banner/noise lines around the JSON
    const line = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}")).pop();
    if (!line) return null;
    try { doc = JSON.parse(line); } catch { return null; }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  if (o.state !== "running" && o.state !== "done" && o.state !== "failed") return null;
  if (typeof o.step !== "string" || typeof o.message !== "string" || typeof o.updatedAt !== "string" || !o.updatedAt) return null;
  const out: MoveJobStatus = { state: o.state, step: o.step, message: o.message, updatedAt: o.updatedAt };
  if (o.result && typeof o.result === "object" && !Array.isArray(o.result)) out.result = o.result as Record<string, unknown>;
  return out;
}
