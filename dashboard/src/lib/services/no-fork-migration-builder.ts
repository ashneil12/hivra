import { gzipSync } from "zlib";

import { buildIdleGatedUpdateProvisioningScript } from "@/lib/services/idle-gated-update-builder";
import { buildReleaseClientShell } from "@/lib/services/box-release-shell";
import { WEBUI_PERSISTENT_INSTALL_ENV_LINES } from "@/lib/services/webui-runtime-env";

/**
 * One-click move of a RUNNING box from the Hivra Hermes fork image onto stock
 * upstream Hermes plus the Hivra overlay (docs/release/NO-FORK-MIGRATION.md).
 *
 * The script this module returns runs ON the box as root. It:
 *   1. checks the box is healthy, idle and has the disk it needs (changes nothing);
 *   2. writes a manifest of everything the user owns (chats, memory, skills, cron,
 *      config, keys by name, platform pairings, workspace files);
 *   3. stops the agent, backs up the state volume and the box files;
 *   4. switches the image (stock upstream by digest), lays the overlay over a fresh
 *      agent source, repairs the few config lines stock needs, starts the agent;
 *   5. checks health, the agent API, the overlay, and that the manifest still holds;
 *   6. on ANY failed check puts everything back exactly as it was (image, source,
 *      compose, env, config, state volume, web bundles) and says so;
 *   7. on success installs the self-update stack that follows upstream directly.
 *
 * It never touches the workspace volume, never deletes the old image on success
 * (the operator removes it after the soak), and never runs without the lock.
 * Progress is written to /var/lib/hermes-nofork-migrate-<id>/status.json for the
 * dashboard to read.
 */

export const NOFORK_UPSTREAM_REPO = "nousresearch/hermes-agent";
/**
 * What compose runs after the move: the official upstream image with the box's own overlay tools
 * (uv, gh, hermes) added locally. The tag is local-only and not pullable, so nothing can silently
 * swap it for a plain image; only the box's update script moves it.
 */
export const NOFORK_LOCAL_REPO = "hivra-local/hermes";
export const NOFORK_UPSTREAM_ALIAS = `${NOFORK_LOCAL_REPO}:stable`;
/** Where the Hivra overlay releases are published (immutable tags, registered in the release registry). */
export const NOFORK_OVERLAY_REPO = "ghcr.io/ashneil12/hivra-hermes";

/** Phases, in order. The dashboard turns these into plain-English progress. */
export const NOFORK_MIGRATION_PHASES = [
  "preflight",
  "snapshot",
  "switching",
  "verifying",
  "finishing",
] as const;
export type NoForkMigrationPhase = (typeof NOFORK_MIGRATION_PHASES)[number];
export type NoForkMigrationState = "running" | "done" | "rolled_back" | "failed" | "refused";

export interface NoForkMigrationStatus {
  state: NoForkMigrationState;
  phase: NoForkMigrationPhase | "idle" | "rollback";
  message: string;
  updatedAt: string;
  snapshot?: string;
  fromVersion?: string;
  toVersion?: string;
  checks?: string[];
}

export const NOFORK_STATUS_DIR = (instanceId: string) => `/var/lib/hermes-nofork-migrate-${instanceId}`;
export const NOFORK_SCRIPT_PATH = (instanceId: string) => `/usr/local/bin/hermes-nofork-migrate-${instanceId}`;

const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;
// repo[:tag][@sha256:digest] with no shell metacharacters
const SAFE_IMAGE_REF = /^[a-z0-9][a-z0-9._\-/:]*(@sha256:[0-9a-f]{64})?$/;

/**
 * Embedded data manifest tool. Runs on the host against the docker volumes.
 *   manifest <state_dir> <workspace_dir> <out.json>
 *   compare  <before.json> <after.json>        exit 1 and list every difference
 */
export const NOFORK_MANIFEST_PY = String.raw`#!/usr/bin/env python3
import hashlib, json, os, sqlite3, sys

SKIP_DIRS = {"cache", ".cache", "logs", "state", "hermes-agent", ".local", "uv", "yarn", "npm", "python",
             "lazy-packages", "backups", "bin", "installs", "plugin-update-checks", "sandboxes", "gh",
             ".config", "audio_cache", "image_cache", "pending_messages", "pipx", "go", "cargo", "rustup",
             "bun", "deno", "gem", "composer", "dotnet", "corepack", "pnpm"}
SKIP_FILES = {".clean_shutdown", "gateway.pid", "gateway.lock", "gateway_state.json", "gateway-starts.log", "auth.lock",
              "spawn-ledger.json", ".skills_prompt_snapshot.json", "channel_directory.json", "ticker_heartbeat",
              "ticker_last_success", "install_id"}
SKIP_SUFFIX = (".lock", "-wal", "-shm", ".pyc", ".log", ".tmp")
DB_SUFFIX = (".db", ".sqlite", ".sqlite3")
MAX_HASH = 20 * 1024 * 1024
MAX_IDS = 200000

def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def walk(root, top_skip):
    out = {}
    if not os.path.isdir(root):
        return out
    for d, dirs, files in os.walk(root):
        rel_d = os.path.relpath(d, root)
        if rel_d == ".":
            dirs[:] = [x for x in dirs if x not in top_skip]
        for f in files:
            p = os.path.join(d, f)
            rel = os.path.relpath(p, root)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            out[rel] = p
    return out

def leaves(text):
    try:
        import yaml
        data = yaml.safe_load(text)
    except Exception:
        return None
    flat = {}
    def walk_node(node, prefix):
        if isinstance(node, dict):
            for k, v in node.items():
                walk_node(v, prefix + "/" + str(k))
        else:
            flat[prefix] = json.dumps(node, sort_keys=True, default=str)
    walk_node(data, "")
    return flat

def db_summary(path):
    res = {}
    try:
        conn = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=10)
        tables = [r[0] for r in conn.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
        for t in tables:
            try:
                n = conn.execute('select count(*) from "%s"' % t).fetchone()[0]
            except Exception:
                continue
            ids = None
            if n <= MAX_IDS:
                try:
                    ids = [r[0] for r in conn.execute('select rowid from "%s"' % t)]
                except Exception:
                    ids = None
            res[t] = {"n": n, "ids": ids}
        conn.close()
    except Exception as e:
        res["__error__"] = {"n": -1, "ids": None, "err": str(e)[:120]}
    return res

def bundled_managed(state, user_modified):
    """Bundled skills Hermes itself owns and refreshes on update (never ones the user edited)."""
    names = set()
    try:
        for line in open(os.path.join(state, "skills", ".bundled_manifest"), errors="replace").read().splitlines():
            if ":" in line:
                names.add(line.split(":", 1)[0].strip())
    except OSError:
        pass
    return sorted(names - set(user_modified))

def build(state, workspace, user_modified):
    out = {"files": {}, "dbs": {}, "workspace": {}, "env_keys": [], "config_lines": [], "config_leaves": None,
           "bundled_managed": bundled_managed(state, user_modified)}
    for rel, p in sorted(walk(state, SKIP_DIRS).items()):
        base = os.path.basename(rel)
        if base in SKIP_FILES or base.endswith(SKIP_SUFFIX):
            continue
        if base.endswith(DB_SUFFIX):
            out["dbs"][rel] = db_summary(p)
            continue
        if rel == ".env":
            for line in open(p, errors="replace").read().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    out["env_keys"].append(line.split("=", 1)[0])
            continue
        if rel == "config.yaml":
            text = open(p, errors="replace").read()
            out["config_lines"] = [l.rstrip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
            out["config_leaves"] = leaves(text)
            continue
        size = os.path.getsize(p)
        out["files"][rel] = [size, sha(p) if size <= MAX_HASH else None]
    for rel, p in sorted(walk(workspace, set()).items()):
        size = os.path.getsize(p)
        out["workspace"][rel] = [size, sha(p) if size <= MAX_HASH else None]
    return out

def compare(before, after, allow_env_drop):
    bad = []
    managed = set(before.get("bundled_managed", []))
    for rel, v in before["files"].items():
        parts = rel.split("/")
        if parts[0] == "skills" and (parts[-1] == ".bundled_manifest" or managed & set(parts[1:])):
            continue  # a bundled skill Hermes refreshes itself; the ones the user edited are not in this set
        a = after["files"].get(rel)
        if a is None:
            bad.append("missing file: " + rel)
        elif a != v:
            bad.append("changed file: " + rel)
    for rel, v in before["workspace"].items():
        a = after["workspace"].get(rel)
        if a is None:
            bad.append("missing workspace file: " + rel)
        elif a != v:
            bad.append("changed workspace file: " + rel)
    for db, tables in before["dbs"].items():
        if db not in after["dbs"]:
            bad.append("missing database: " + db)
            continue
        for t, v in tables.items():
            a = after["dbs"][db].get(t)
            if t == "__error__":
                continue
            if a is None:
                bad.append("missing table: %s.%s" % (db, t))
                continue
            if a["n"] < v["n"]:
                bad.append("rows lost: %s.%s %d -> %d" % (db, t, v["n"], a["n"]))
            elif v["ids"] is not None and a["ids"] is not None and not set(v["ids"]) <= set(a["ids"]):
                bad.append("rows replaced: %s.%s" % (db, t))
    missing_keys = [k for k in before["env_keys"] if k not in after["env_keys"] and k not in allow_env_drop]
    for k in missing_keys:
        bad.append("env key gone: " + k)
    if before.get("config_leaves") is not None and after.get("config_leaves") is not None:
        for key, val in before["config_leaves"].items():
            if after["config_leaves"].get(key) != val:
                bad.append("config setting changed: " + key)
    else:
        kept = set(after["config_lines"])
        for line in before["config_lines"]:
            if line not in kept:
                bad.append("config line gone: " + line[:80])
    return bad

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "manifest":
        modified = json.load(open(sys.argv[5])) if len(sys.argv) > 5 else []
        data = build(sys.argv[2], sys.argv[3], modified)
        json.dump(data, open(sys.argv[4], "w"))
        print("files=%d workspace=%d dbs=%d env_keys=%d" % (len(data["files"]), len(data["workspace"]), len(data["dbs"]), len(data["env_keys"])))
    elif mode == "compare":
        bad = compare(json.load(open(sys.argv[2])), json.load(open(sys.argv[3])), set(sys.argv[4:]))
        for b in bad:
            print(b)
        sys.exit(1 if bad else 0)
`;

/** Edits the compose file's agent image lines. Fails before writing if the shape is unexpected. */
export const NOFORK_COMPOSE_PY = String.raw`#!/usr/bin/env python3
import re, sys
path, new_image = sys.argv[1], sys.argv[2]
text = open(path).read()
pattern = re.compile(r"^(\s+image:\s*)(\S*vanilla-hermes-agent\S*)$", re.M)
found = pattern.findall(text)
if len(found) < 2:
    print("compose: expected the gateway and official-dashboard image lines, found %d" % len(found), file=sys.stderr)
    sys.exit(2)
repos = {re.sub(r":[^:/]*$", "", f[1]) for f in found}
if len(repos) != 1:
    print("compose: agent image lines name more than one repository: %s" % sorted(repos), file=sys.stderr)
    sys.exit(3)
text = pattern.sub(lambda m: m.group(1) + new_image, text)
import os
open(path + ".tmp", "w").write(text)
os.replace(path + ".tmp", path)
print(sorted(repos)[0])
`;

const SCRIPT_BODY = String.raw`#!/usr/bin/env bash
# hermes-nofork-migrate: move this box from the Hivra Hermes fork image to stock upstream Hermes plus
# the Hivra overlay, keeping everything the user owns, and put it all back if any check fails.
# Usage: hermes-nofork-migrate-@INST@ [run|status]      (env HERMES_MIGRATE_FORCE=1 skips the idle gate)
set -uo pipefail
INST="@INST@"
EXPECT_UPSTREAM="@EXPECT_UPSTREAM@"
OVERLAY_IMAGE="@OVERLAY_IMAGE@"
ALIAS="@ALIAS@"
DIR="/opt/hermes/instances/$INST"
ENV_DIR="$DIR"
G="agent-$INST-gateway"
D="agent-$INST-official-dashboard"
STATE_VOL="agent-\${INST}_webui-state"
WORK_VOL="agent-\${INST}_webui-workspace"
SOURCE_VOLUME="agent-\${INST}_agent-source"
SOURCE_RUNTIME_DIR="/home/hermes/.hermes/hermes-agent"
SOURCE_BACKUP_VOL="agent-\${INST}_agent-source-prenofork"
STATUS_DIR="/var/lib/hermes-nofork-migrate-$INST"
STATUS="$STATUS_DIR/status.json"
LOG="/var/log/hermes-nofork-migrate.log"
BACKUP_ROOT="/var/backups/hermes-nofork-$INST"
MARK="/run/hermes-last-active-$INST"
PAUSE="/var/lib/hermes-roll-paused-$INST"
DIRECT="/var/lib/hermes-upstream-direct-$INST"
GOVERNED="/var/lib/hermes-release-governed-$INST"
DONE_MARK="/var/lib/hermes-nofork-migrated-$INST"
LKG_TAG="hivra-local/pre-nofork:$INST"
IDLE_MIN=45
MIN_FREE_GB=8
mkdir -p "$STATUS_DIR" "$(dirname "$LOG")" 2>/dev/null
ts() { date -u -Iseconds; }
log() { echo "$(ts) $*" >> "$LOG"; echo "$*"; }
CHECKS=""
note_check() { CHECKS="$CHECKS$1; "; }
# status <state> <phase> <message> [extra-json-fields]
status() {
  python3 - "$STATUS" "$1" "$2" "$3" "$(ts)" "\${SNAP:-}" "\${FROM_VERSION:-}" "\${TO_VERSION:-}" "$CHECKS" <<'PYS'
import json, os, sys
path, state, phase, msg, at, snap, frm, to, checks = sys.argv[1:10]
d = {"state": state, "phase": phase, "message": msg[:400], "updatedAt": at}
if snap: d["snapshot"] = snap
if frm: d["fromVersion"] = frm
if to: d["toVersion"] = to
if checks: d["checks"] = [c for c in checks.split("; ") if c]
open(path + ".tmp", "w").write(json.dumps(d))
os.replace(path + ".tmp", path)
PYS
}

if [ "\${1:-run}" = status ]; then cat "$STATUS" 2>/dev/null || echo '{"state":"idle","phase":"idle","message":"not started"}'; exit 0; fi
if [ "\${1:-run}" = cleanup ]; then
  # After the soak: drop the kept copy of the old image and old agent files, and old backups (keeps the newest two).
  docker rmi "$LKG_TAG" >/dev/null 2>&1; docker volume rm "$SOURCE_BACKUP_VOL" >/dev/null 2>&1
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf
  echo "cleaned up"; exit 0
fi

exec 9>"/var/lock/hermes-nofork-migrate-$INST.lock"
flock -n 9 || { echo "another migration is running"; exit 3; }

@RELEASE_CLIENT@
report() { hermes_release_report "$@" >/dev/null 2>&1 || log "dashboard report failed ($1) - continuing"; }

refuse() { log "REFUSED: $1 - nothing was changed"; status refused preflight "$1"; exit 1; }
health_of() { docker inspect "$1" -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none; }
wait_healthy() {
  for _ in $(seq 1 60); do
    sleep 5
    hg="$(health_of "$G")"; hd="$(health_of "$D")"
    [ "$hg" = unhealthy ] && return 1
    if { [ "$hg" = healthy ] || [ "$hg" = none ]; } && { [ "$hd" = healthy ] || [ "$hd" = none ]; }; then return 0; fi
  done
  return 1
}
gw_api_code() {
  docker exec -i "$G" python3 - "$1" <<'PYA' 2>/dev/null
import os, sys, urllib.request
req = urllib.request.Request("http://127.0.0.1:8642" + sys.argv[1], headers={"Authorization": "Bearer " + os.environ.get("API_SERVER_KEY", "")})
try:
    print(urllib.request.urlopen(req, timeout=10).status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print(0)
PYA
}
image_version() {
  docker run --rm --entrypoint sh "$1" -c 'python3 -c "import json;d=json.load(open(\"/opt/hermes/install-stamp.json\"));print(d.get(\"displayVersion\") or d.get(\"version\") or \"unknown\")" 2>/dev/null || echo unknown' 2>/dev/null | head -1
}
assemble_local_image() {
  stock="$1"; tag="$2"
  cid="$(docker create "$stock" 2>> "$LOG")" || return 1
  asm_ok=1
  for b in "$DIR"/overlay/bin/*; do
    [ -f "$b" ] || continue
    docker cp "$b" "$cid:/usr/local/bin/$(basename "$b")" >> "$LOG" 2>&1 || asm_ok=0
  done
  if [ "$asm_ok" = 1 ]; then
    docker commit -c "LABEL io.hivra.assembled=local" -c "LABEL io.hivra.upstream.image=$stock" "$cid" "$tag" >/dev/null 2>> "$LOG" || asm_ok=0
  fi
  docker rm "$cid" >/dev/null 2>&1
  [ "$asm_ok" = 1 ]
}
reseed_agent_source() {
  ref="$1"
  source_image_id="$(docker image inspect "$ref" -f '{{.Id}}' 2>/dev/null)"
  [ -n "$source_image_id" ] || { log "cannot resolve source image id for $ref"; return 1; }
  overlay_args=""
  [ -d "$DIR/overlay/files" ] && [ "$2" = overlay ] && overlay_args="-v $DIR/overlay:/overlay:ro"
  docker run --rm --user root -v "$SOURCE_VOLUME:$SOURCE_RUNTIME_DIR" $overlay_args --entrypoint sh "$ref" -lc '
    set -e
    target="$1"; source_image_id="$2"
    test -f /opt/hermes/pyproject.toml
    find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a /opt/hermes/. "$target/"
    if [ -d /overlay/files ]; then cp -a /overlay/files/. "$target/"; fi
    if [ -d "$target/.venv" ]; then
      find "$target/.venv" -type f \( -path "*/bin/*" -o -name "__editable__*.py" -o -name "*.pth" -o -name "direct_url.json" \) -print 2>/dev/null | while IFS= read -r script; do
        tmp="\${script}.hermes-relocate.$$"
        sed "s|/opt/hermes|$target|g" "$script" > "$tmp" && { chmod --reference="$script" "$tmp" 2>/dev/null || true; mv -f "$tmp" "$script"; } || { rm -f "$tmp"; exit 1; }
      done
    fi
    [ -x "$target/.venv/bin/python" ] && [ -x "$target/.venv/bin/hermes" ] || { echo "venv executables missing" >&2; exit 1; }
    cd "$target" && "$target/.venv/bin/hermes" --version
    "$target/.venv/bin/python" -c "import pathlib,sys,hermes_cli; r=pathlib.Path(sys.argv[1]).resolve(); m=pathlib.Path(hermes_cli.__file__).resolve(); raise SystemExit(0 if r in m.parents else 1)" "$target"
    printf "%s\n" "$source_image_id" > "$target/.hermes-image-id"
    chown -R 1024:1024 "$target"; chmod -R u+w "$target"
  ' -- "$SOURCE_RUNTIME_DIR" "$source_image_id" >> "$LOG" 2>&1
}

rollback() {
  reason="$1"
  log "ROLLBACK: $reason"
  if [ "\${REVERTING:-0}" = 1 ]; then status running rollback "Going back to the previous version"
  else status running rollback "Something did not check out ($reason). Putting your agent back exactly as it was"; fi
  # Keep what the new version said, so the operator can see why (the backup directory is kept).
  for c in "$G" "$D"; do
    docker logs --tail 150 "$c" > "$SNAP/diag-$c.log" 2>&1 || true
    docker inspect "$c" -f '{{json .State.Health}}' > "$SNAP/diag-$c-health.json" 2>/dev/null || true
  done
  docker cp "$G:/home/hermes/.hermes/logs/gateway.log" "$SNAP/diag-gateway-file.log" >/dev/null 2>&1 || cp "$STATE_DIR/logs/gateway.log" "$SNAP/diag-gateway-file.log" 2>/dev/null || true
  docker cp "$G:/home/hermes/.hermes/logs/errors.log" "$SNAP/diag-errors.log" >/dev/null 2>&1 || true
  docker compose stop official-dashboard gateway >> "$LOG" 2>&1 || true
  if [ "\${REVERTING:-0}" = 1 ]; then
    # Going back restores the data as it was at the move. Keep what has happened since, so nothing is lost.
    tar -C "$STATE_DIR" --exclude=./cache --exclude=./.cache --exclude=./hermes-agent -czf "$SNAP/state-at-revert.tgz" . \
      && log "kept the current data at $SNAP/state-at-revert.tgz" || log "warning: could not keep the current data"
  fi
  cp -a "$SNAP/docker-compose.yml" "$DIR/docker-compose.yml"
  for f in .env hermes.env config.yaml Caddyfile; do [ -f "$SNAP/$f" ] && cp -a "$SNAP/$f" "$DIR/$f"; done
  # The new version may have upgraded the databases in place. Restore the saved state.
  if [ -f "$SNAP/state.tgz" ]; then
    find "$STATE_DIR" -mindepth 1 -maxdepth 1 ! -name hermes-agent ! -name cache ! -name .cache -exec rm -rf {} + 2>/dev/null
    tar -C "$STATE_DIR" -xzf "$SNAP/state.tgz" >> "$LOG" 2>&1 || log "CRITICAL: state restore failed"
  fi
  for m in webchat dash; do [ -f "$SNAP/$m.tgz" ] && { rm -rf "$DIR/$m"; tar -C "$DIR" -xzf "$SNAP/$m.tgz"; }; done
  rm -rf "$DIR/overlay" "$DIR/overlay.new" "$DIR/upstream.ref"
  rm -f "$DONE_MARK"
  # the update units go back to the ones this box had (they follow the old image repository)
  if [ -d "$SNAP/units" ]; then
    for u in "$SNAP"/units/*; do
      case "$(basename "$u")" in
        *.service|*.timer) cp -a "$u" /etc/systemd/system/ ;;
        *) cp -a "$u" /usr/local/bin/ ;;
      esac
    done
    systemctl daemon-reload 2>/dev/null || true
  fi
  docker rmi "$ALIAS" >/dev/null 2>&1 || true
  docker tag "$LKG_TAG" "$OLD_ALIAS" 2>/dev/null
  rb_ok=1
  docker run --rm --user root -v "$SOURCE_BACKUP_VOL:/from:ro" -v "$SOURCE_VOLUME:/to" --entrypoint sh "$LKG_TAG" -c 'find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; cp -a /from/. /to/' >> "$LOG" 2>&1 \
    || { rb_ok=0; log "CRITICAL: could not restore the old agent source"; }
  if [ "$rb_ok" = 1 ] && docker compose up -d --force-recreate official-dashboard gateway >> "$LOG" 2>&1 && wait_healthy; then
    python3 "$STATUS_DIR/manifest.py" manifest "$STATE_DIR" "$WORK_DIR" "$SNAP/after-rollback.json" >> "$LOG" 2>&1
    if python3 "$STATUS_DIR/manifest.py" compare "$SNAP/before.json" "$SNAP/after-rollback.json" >> "$LOG" 2>&1; then
      note_check "rolled back, all data identical"
      rm -f "$DIRECT"; [ -f "$SNAP/was-governed" ] && : > "$GOVERNED"
      [ "$PAUSED_BY_US" = 1 ] && rm -f "$PAUSE"
      for u in roll refresh; do systemctl start "hermes-$u-$INST.timer" 2>/dev/null || true; done
      if [ "\${REVERTING:-0}" = 1 ]; then status rolled_back rollback "Back on the previous version. Your data is as it was when you moved; what happened since is kept at $SNAP/state-at-revert.tgz"
      else status rolled_back rollback "Not updated: $reason. Your agent is back exactly as it was."; fi
      report rolled_back failed "upstream migration rolled back: $reason" "" ""
      exit 1
    fi
  fi
  status failed rollback "Rollback needs attention: $reason. Backup kept at $SNAP"
  report failed failed "upstream migration failed and rollback needs attention: $reason" "" ""
  exit 2
}

# ------------------------------------------------------------------ revert (operator, during the soak)
if [ "\${1:-run}" = revert ]; then
  [ -f "$DONE_MARK" ] || { echo "nothing to revert: this agent was not moved"; exit 1; }
  cd "$DIR" || exit 1
  SNAP="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshot"])' "$DONE_MARK")"
  [ -f "$SNAP/state.tgz" ] || { echo "backup $SNAP is gone; cannot revert"; exit 1; }
  docker image inspect "$LKG_TAG" >/dev/null 2>&1 || { echo "the old image was cleaned up; cannot revert"; exit 1; }
  docker volume inspect "$SOURCE_BACKUP_VOL" >/dev/null 2>&1 || { echo "the old agent files were cleaned up; cannot revert"; exit 1; }
  RUNNING_ID="$(docker inspect "$G" -f '{{.Image}}' 2>/dev/null)"
  OLD_ALIAS="$(cat "$SNAP/old-alias")"
  STATE_DIR="$(docker volume inspect "$STATE_VOL" -f '{{.Mountpoint}}')"; WORK_DIR="$(docker volume inspect "$WORK_VOL" -f '{{.Mountpoint}}')"
  PAUSED_BY_US=0; CHECKS=""; REVERTING=1
  for u in roll refresh; do systemctl stop "hermes-$u-$INST.timer" 2>/dev/null || true; done
  rollback "operator asked to go back to the previous version"
fi

# ------------------------------------------------------------------ phase 1: preflight (changes nothing)
status running preflight "Checking this agent is ready"
[ -d "$DIR" ] || refuse "instance directory missing"
cd "$DIR" || refuse "cannot enter the instance directory"
[ ! -e "$DONE_MARK" ] || refuse "this agent is already on upstream Hermes"
command -v python3 >/dev/null || refuse "python3 missing"
RUNNING_ID="$(docker inspect "$G" -f '{{.Image}}' 2>/dev/null)"
[ -n "$RUNNING_ID" ] || refuse "the agent container is not running"
[ "$(health_of "$G")" = healthy ] || refuse "the agent is not healthy right now"
[ "$(health_of "$D")" = healthy ] || [ "$(health_of "$D")" = none ] || refuse "the dashboard container is not healthy right now"
docker compose config --quiet >> "$LOG" 2>&1 || refuse "compose file does not validate"
OLD_REPO="$(grep -E '^\s+image:\s*\S*vanilla-hermes-agent\S*$' docker-compose.yml | head -1 | sed -E 's/^\s+image:\s*//; s/:[^:/]*$//')"
[ -n "$OLD_REPO" ] || refuse "cannot find the current agent image in the compose file"
OLD_ALIAS="$OLD_REPO:stable"
STATE_DIR="$(docker volume inspect "$STATE_VOL" -f '{{.Mountpoint}}' 2>/dev/null)"
WORK_DIR="$(docker volume inspect "$WORK_VOL" -f '{{.Mountpoint}}' 2>/dev/null)"
[ -d "$STATE_DIR" ] && [ -d "$WORK_DIR" ] || refuse "cannot find the agent's data volumes"
if [ "\${HERMES_MIGRATE_FORCE:-0}" != 1 ]; then
  /usr/local/bin/hermes-idle-sampler-"$INST" >/dev/null 2>&1 || true
  [ -f "$MARK" ] || refuse "no idle marker yet; try again later"
  idle_min=$(( ( $(date +%s) - $(stat -c %Y "$MARK") ) / 60 ))
  [ "$idle_min" -ge "$IDLE_MIN" ] || refuse "the agent was active $idle_min minutes ago; it moves after $IDLE_MIN idle minutes"
fi
STATE_KB="$(du -sk --exclude=cache --exclude=.cache --exclude=hermes-agent "$STATE_DIR" 2>/dev/null | cut -f1)"
FREE_KB="$(df --output=avail -k /var/lib/docker | tail -1 | tr -d ' ')"
NEED_KB=$(( MIN_FREE_GB * 1024 * 1024 + STATE_KB * 2 ))
if ! docker image inspect "$OVERLAY_IMAGE" >/dev/null 2>&1; then
  [ "$FREE_KB" -ge "$NEED_KB" ] || refuse "not enough free disk: $((FREE_KB / 1048576)) GB free, $((NEED_KB / 1048576)) GB needed to download the new version"
  status running preflight "Downloading the Hivra add-on files"
  docker pull -q "$OVERLAY_IMAGE" >> "$LOG" 2>&1 || refuse "could not download the Hivra add-on files"
fi
# The overlay release names the exact stock upstream image it was built on.
UPSTREAM_IMAGE="$(docker image inspect "$OVERLAY_IMAGE" -f '{{index .Config.Labels "io.hivra.upstream.image"}}' 2>/dev/null)"
case "$UPSTREAM_IMAGE" in nousresearch/hermes-agent@sha256:*) ;; *) refuse "the add-on release does not name a pinned upstream image" ;; esac
[ -z "$EXPECT_UPSTREAM" ] || [ "$EXPECT_UPSTREAM" = "$UPSTREAM_IMAGE" ] || refuse "the add-on release was built on a different upstream image than expected"
FREE_KB="$(df --output=avail -k /var/lib/docker | tail -1 | tr -d ' ')"
if ! docker image inspect "$UPSTREAM_IMAGE" >/dev/null 2>&1; then
  [ "$FREE_KB" -ge "$NEED_KB" ] || refuse "not enough free disk: $((FREE_KB / 1048576)) GB free, $((NEED_KB / 1048576)) GB needed to download the new version"
  status running preflight "Downloading the new version"
  docker pull -q "$UPSTREAM_IMAGE" >> "$LOG" 2>&1 || refuse "could not download the new version"
fi
docker image inspect "$UPSTREAM_IMAGE" -f '{{range .RepoDigests}}{{println .}}{{end}}' | grep -qF "\${UPSTREAM_IMAGE#*@}" || refuse "the downloaded version does not match its pinned digest"
FREE_KB="$(df --output=avail -k /var/lib/docker | tail -1 | tr -d ' ')"
[ "$FREE_KB" -ge $(( 3 * 1024 * 1024 + STATE_KB * 2 )) ] || refuse "not enough free disk to take a backup safely"
TO_VERSION="$(image_version "$UPSTREAM_IMAGE")"
FROM_VERSION="$(docker exec "$G" sh -c 'hermes --version 2>/dev/null | head -1' | tr -d '\r' | cut -c1-60)"
ENABLED_PLUGINS="$(python3 - "$STATE_DIR/config.yaml" <<'PYP'
import re, sys
try: lines = open(sys.argv[1], errors="replace").read().splitlines()
except OSError: lines = []
on = False
for l in lines:
    if re.match(r"^plugins:\s*$", l): on = True; continue
    if on and re.match(r"^\S", l): break
    m = re.match(r"^\s+-\s+(\S+)\s*$", l) if on else None
    if m: print(m.group(1))
PYP
)"
note_check "box healthy"; note_check "disk ok"
log "preflight ok: $FROM_VERSION -> $TO_VERSION"

# ------------------------------------------------------------------ phase 2: snapshot
SNAP="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
status running snapshot "Stopping the agent briefly, writing down what it holds, and backing it up"
mkdir -p "$SNAP" "$STATUS_DIR/work" || refuse "cannot create the backup directory"
chmod 700 "$BACKUP_ROOT" "$SNAP"
cat > "$STATUS_DIR/manifest.py" <<'PYM'
@MANIFEST_PY@
PYM
cat > "$STATUS_DIR/compose_edit.py" <<'PYC'
@COMPOSE_PY@
PYC
# Quiesce: the old timers must not fire in the middle, and the agent must not write while we copy.
for u in roll refresh; do systemctl stop "hermes-$u-$INST.timer" 2>/dev/null || true; done
PAUSED_BY_US=0
[ -e "$PAUSE" ] || { echo "paused by the upstream migration $(ts)" > "$PAUSE"; PAUSED_BY_US=1; }
docker tag "$RUNNING_ID" "$LKG_TAG" || refuse "cannot keep a copy of the current image"
docker compose stop official-dashboard gateway >> "$LOG" 2>&1 || { docker compose up -d official-dashboard gateway >> "$LOG" 2>&1; refuse "could not stop the agent cleanly"; }
STOPPED=1
# Bundled skills the user edited must survive untouched; Hermes refreshes the ones they did not edit.
docker run --rm -e HERMES_HOME=/h -v "$STATE_DIR:/h:ro" --user 0 --entrypoint /opt/hermes/.venv/bin/python "$RUNNING_ID" -c '
import json, sys
sys.path.insert(0, "/opt/hermes")
from tools.skills_sync import list_user_modified_bundled_skills as f
print(json.dumps([str(x.get("name")) for x in f()]))' 2>> "$LOG" | tail -1 > "$SNAP/user-modified-skills.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$SNAP/user-modified-skills.json" 2>/dev/null || { docker compose up -d official-dashboard gateway >> "$LOG" 2>&1; refuse "could not tell which built-in skills you have edited"; }
python3 "$STATUS_DIR/manifest.py" manifest "$STATE_DIR" "$WORK_DIR" "$SNAP/before.json" "$SNAP/user-modified-skills.json" >> "$LOG" 2>&1 || { docker compose up -d official-dashboard gateway >> "$LOG" 2>&1; refuse "could not read the agent's data"; }
SESS_BEFORE="$(python3 - "$STATE_DIR/state.db" <<'PYS2'
import sqlite3, sys
try:
    c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=5)
    print(c.execute("select count(*) from sessions").fetchone()[0])
except Exception:
    print(-1)
PYS2
)"
cp -a docker-compose.yml .env hermes.env config.yaml Caddyfile "$SNAP/" 2>/dev/null
[ -d webchat ] && tar -C "$DIR" -czf "$SNAP/webchat.tgz" webchat 2>/dev/null
[ -d dash ] && tar -C "$DIR" -czf "$SNAP/dash.tgz" dash 2>/dev/null
mkdir -p "$SNAP/units"
cp -a "/usr/local/bin/hermes-roll-$INST" "/usr/local/bin/hermes-refresh-$INST" "/usr/local/bin/hermes-idle-sampler-$INST" "$SNAP/units/" 2>/dev/null
cp -a /etc/systemd/system/hermes-roll-"$INST"* /etc/systemd/system/hermes-refresh-"$INST"* "$SNAP/units/" 2>/dev/null
[ -e "$GOVERNED" ] && echo governed > "$SNAP/was-governed"
if ! tar -C "$STATE_DIR" --exclude=./cache --exclude=./.cache --exclude=./hermes-agent -cf - . | gzip -1 > "$SNAP/state.tgz.tmp"; then
  rm -f "$SNAP/state.tgz.tmp"
  STOPPED=0; docker compose up -d official-dashboard gateway >> "$LOG" 2>&1
  [ "$PAUSED_BY_US" = 1 ] && rm -f "$PAUSE"
  for u in roll refresh; do systemctl start "hermes-$u-$INST.timer" 2>/dev/null || true; done
  refuse "the backup could not be written"
fi
mv "$SNAP/state.tgz.tmp" "$SNAP/state.tgz"
printf '%s\n' "$RUNNING_ID" > "$SNAP/old-image-id"; printf '%s\n' "$OLD_ALIAS" > "$SNAP/old-alias"
# The old agent source (its venv already matches the old image): kept as a volume so a rollback never
# has to rebuild it, which would need the network.
docker volume rm "$SOURCE_BACKUP_VOL" >/dev/null 2>&1 || true
docker volume create "$SOURCE_BACKUP_VOL" >/dev/null 2>&1 \
  && docker run --rm --user root -v "$SOURCE_VOLUME:/from:ro" -v "$SOURCE_BACKUP_VOL:/to" --entrypoint sh "$LKG_TAG" -c 'cp -a /from/. /to/' >> "$LOG" 2>&1 \
  || { docker volume rm "$SOURCE_BACKUP_VOL" >/dev/null 2>&1; docker compose up -d official-dashboard gateway >> "$LOG" 2>&1; refuse "could not keep a copy of the current agent files"; }
note_check "backup written"
log "snapshot at $SNAP ($(du -sh "$SNAP" | cut -f1))"
# From here on, nothing is refused: every failure rolls back.

# ------------------------------------------------------------------ phase 3: switching
status running switching "Installing the new version"
rm -rf "$DIR/overlay.new"; mkdir -p "$DIR/overlay.new/files" "$DIR/overlay.new/web"
OV_CID="$(docker create "$OVERLAY_IMAGE" 2>> "$LOG")" || rollback "cannot read the add-on image"
docker cp "$OV_CID:/opt/hermes/hivra_overlay/FILES.txt" "$DIR/overlay.new/FILES.txt" >> "$LOG" 2>&1 || { docker rm "$OV_CID" >/dev/null 2>&1; rollback "the add-on image has no file list"; }
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$DIR/overlay.new/files/$(dirname "$f")"
  docker cp "$OV_CID:/opt/hermes/$f" "$DIR/overlay.new/files/$f" >> "$LOG" 2>&1 || { docker rm "$OV_CID" >/dev/null 2>&1; rollback "could not copy add-on file $f"; }
done < "$DIR/overlay.new/FILES.txt"
mkdir -p "$DIR/overlay.new/bin"
for b in /usr/local/bin/uv /usr/local/bin/uvx /usr/bin/gh; do
  docker cp "$OV_CID:$b" "$DIR/overlay.new/bin/$(basename "$b")" >> "$LOG" 2>&1 || { docker rm "$OV_CID" >/dev/null 2>&1; rollback "could not copy $b"; }
done
for w in webchat_dist web_dist_dash; do
  docker cp "$OV_CID:/opt/hermes/hermes_cli/$w" "$DIR/overlay.new/web/$w" >> "$LOG" 2>&1 || { docker rm "$OV_CID" >/dev/null 2>&1; rollback "could not copy the $w web files"; }
done
docker rm "$OV_CID" >/dev/null 2>&1
printf '#!/bin/sh\nexec /opt/hermes/bin/hermes "$@"\n' > "$DIR/overlay.new/bin/hermes"
chmod 755 "$DIR/overlay.new/bin/"* ; chmod -R a+rX "$DIR/overlay.new"
note_check "add-on files staged"
# plugins the config enables must exist somewhere in the new tree
for p in $ENABLED_PLUGINS; do
  if [ ! -e "$DIR/overlay.new/files/plugins/$p" ] && ! docker run --rm --entrypoint sh "$UPSTREAM_IMAGE" -c "test -e /opt/hermes/plugins/$p" 2>/dev/null; then
    log "warning: enabled plugin $p is not in the new version or the add-on files"
    note_check "plugin $p missing (warning)"
  fi
done
rm -rf "$DIR/overlay"; mv "$DIR/overlay.new" "$DIR/overlay"
# compose: point both services at the upstream alias
python3 "$STATUS_DIR/compose_edit.py" "$DIR/docker-compose.yml" "$ALIAS" >> "$LOG" 2>&1 || rollback "the compose file has an unexpected shape"
assemble_local_image "$UPSTREAM_IMAGE" "$ALIAS" || rollback "cannot add the box tools to the new image"
docker compose config --quiet >> "$LOG" 2>&1 || rollback "the edited compose file does not validate"
# env: the fork guarded HERMES_HOME itself; stock trusts the file, so a stale line must go
for f in "$DIR/.env" "$DIR/hermes.env" "$STATE_DIR/.env"; do
  [ -f "$f" ] || continue
  if grep -qE '^HERMES_HOME=' "$f" && ! grep -qE '^HERMES_HOME=/home/hermes/.hermes$' "$f"; then
    sed -i '/^HERMES_HOME=/d' "$f" && log "removed a stale HERMES_HOME line from $(basename "$f")"
  fi
done
# managed Venice boxes: stock does not auto-pair Venice media tools, the config says so explicitly
if grep -qE '^VENICE_API_KEY=.+' "$DIR/.env" "$DIR/hermes.env" "$STATE_DIR/.env" 2>/dev/null; then
  for cfg in "$DIR/config.yaml" "$STATE_DIR/config.yaml"; do
    [ -f "$cfg" ] || continue
    for k in image_gen video_gen stt; do
      grep -qE "^$k:" "$cfg" || printf '%s:\n  provider: venice\n' "$k" >> "$cfg"
    done
  done
  note_check "venice media providers set"
fi
# static web surfaces served by Caddy
for m in webchat_dist:webchat web_dist_dash:dash; do
  src="\${m%%:*}"; dst="\${m##*:}"
  rm -rf "$DIR/$dst.new"; cp -a "$DIR/overlay/web/$src" "$DIR/$dst.new" && rm -rf "$DIR/$dst" && mv "$DIR/$dst.new" "$DIR/$dst" || rollback "could not install the $dst web files"
  chmod -R a+rX "$DIR/$dst"
done
reseed_agent_source "$ALIAS" overlay || rollback "could not prepare the new agent files"
note_check "new files installed"
docker compose up -d --force-recreate official-dashboard gateway >> "$LOG" 2>&1 || rollback "the new version would not start"
STOPPED=0

# ------------------------------------------------------------------ phase 4: verifying
status running verifying "Starting the new version and checking everything"
wait_healthy || rollback "the new version did not become healthy"
note_check "containers healthy"
NEW_ID="$(docker image inspect "$ALIAS" -f '{{.Id}}')"
[ "$(docker inspect "$G" -f '{{.Image}}' 2>/dev/null)" = "$NEW_ID" ] || rollback "the agent is not running the new image"
[ "$(docker inspect "$D" -f '{{.Image}}' 2>/dev/null)" = "$NEW_ID" ] || rollback "the dashboard container is not running the new image"
code=0
for _ in 1 2 3 4 5 6; do code="$(gw_api_code /api/sessions)"; [ "$code" = 200 ] && break; sleep 5; done
[ "$code" = 200 ] || rollback "the agent's API did not answer with its key (got $code)"
note_check "agent API answers"
docker exec "$G" "$SOURCE_RUNTIME_DIR/.venv/bin/python" -c 'import hivra_overlay' >> "$LOG" 2>&1 || rollback "the Hivra add-on files did not load"
docker exec "$G" sh -c 'command -v uv && command -v gh && command -v hermes' >> "$LOG" 2>&1 || rollback "uv, gh or hermes is not on the agent's PATH"
note_check "add-on files load"
NEW_VER="$(docker exec "$G" sh -c 'hermes --version 2>/dev/null | head -1' | tr -d '\r')"
case "$NEW_VER" in *"$TO_VERSION"*|*upstream*) ;; *) log "version line: $NEW_VER" ;; esac
sleep 20
wait_healthy || rollback "the new version became unhealthy after starting"
python3 "$STATUS_DIR/manifest.py" manifest "$STATE_DIR" "$WORK_DIR" "$SNAP/after.json" >> "$LOG" 2>&1 || rollback "could not re-read the agent's data"
DIFF="$(python3 "$STATUS_DIR/manifest.py" compare "$SNAP/before.json" "$SNAP/after.json" HERMES_HOME 2>&1)" || { log "data differences: $DIFF"; rollback "something in your data changed ($(echo "$DIFF" | head -1))"; }
note_check "all your data identical"
SESS_AFTER="$(python3 - "$STATE_DIR/state.db" <<'PYS3'
import sqlite3, sys
try:
    c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=5)
    print(c.execute("select count(*) from sessions").fetchone()[0])
except Exception:
    print(-1)
PYS3
)"
[ "$SESS_BEFORE" -lt 0 ] || [ "$SESS_AFTER" -ge "$SESS_BEFORE" ] || rollback "chats were lost ($SESS_BEFORE before, $SESS_AFTER after)"
note_check "chats intact ($SESS_AFTER)"

# ------------------------------------------------------------------ phase 5: finishing
status running finishing "Turning on updates straight from upstream"
echo "nousresearch/hermes-agent:stable" > "$DIR/upstream.ref"
: > "$DIRECT"; rm -f "$GOVERNED"
@UNITS_SCRIPT@
systemctl daemon-reload
if [ "$PAUSED_BY_US" = 1 ]; then rm -f "$PAUSE"; fi
for u in roll refresh; do systemctl start "hermes-$u-$INST.timer" 2>/dev/null || true; done
printf '{"from":"%s","to":"%s","at":"%s","snapshot":"%s","oldImage":"%s"}\n' "$FROM_VERSION" "$TO_VERSION" "$(ts)" "$SNAP" "$LKG_TAG" > "$DONE_MARK"
note_check "self-update on"
status done finishing "Your agent now runs the latest Hermes ($TO_VERSION). Backup kept at $SNAP"
report updated succeeded "moved to upstream Hermes $TO_VERSION" "" ""
log "DONE $FROM_VERSION -> $TO_VERSION"
exit 0
`;

function embedGz(content: string): string {
  return gzipSync(Buffer.from(content, "utf8"), { level: 9 }).toString("base64");
}

export function buildNoForkMigrationScript(params: {
  instanceId: string;
  /** The Hivra overlay release (add-on files, web bundles). It names the stock image it was built on. */
  overlayImage: string;
  /** Optional: refuse unless the overlay was built on exactly this stock upstream image. */
  expectUpstreamImage?: string;
}): string {
  const { instanceId, overlayImage } = params;
  const upstreamImage = params.expectUpstreamImage ?? "";
  if (!SAFE_TOKEN.test(instanceId)) throw new Error("buildNoForkMigrationScript: instance id must be a plain token");
  if (!SAFE_IMAGE_REF.test(overlayImage)) {
    throw new Error("buildNoForkMigrationScript: image reference has unsafe characters");
  }
  if (upstreamImage) {
    if (!SAFE_IMAGE_REF.test(upstreamImage) || !/@sha256:[0-9a-f]{64}$/.test(upstreamImage)) {
      throw new Error("buildNoForkMigrationScript: the upstream image must be pinned by digest");
    }
    if (!upstreamImage.startsWith(`${NOFORK_UPSTREAM_REPO}@`)) {
      throw new Error(`buildNoForkMigrationScript: the upstream image must come from ${NOFORK_UPSTREAM_REPO}`);
    }
  }

  // The post-migration self-update stack: same roll/refresh/sampler as every box, pointed at the
  // upstream alias. Embedded so the box never needs the dashboard to finish the switch.
  const unitsScript = buildIdleGatedUpdateProvisioningScript({
    instanceId,
    backend: "gateway",
    agentImage: NOFORK_UPSTREAM_ALIAS,
  });
  const unitsEmbedded = `printf '%s' '${embedGz(unitsScript)}' | base64 -d | gunzip | bash >> "$LOG" 2>&1 || log "warning: update units did not install cleanly"`;

  const body = SCRIPT_BODY.replace(/\\\$\{/g, "${")
    .replace(/@RELEASE_CLIENT@/g, () => buildReleaseClientShell({ instanceId }))
    .replace(/@MANIFEST_PY@/g, () => NOFORK_MANIFEST_PY.trimEnd())
    .replace(/@COMPOSE_PY@/g, () => NOFORK_COMPOSE_PY.trimEnd())
    .replace(/@UNITS_SCRIPT@/g, () => unitsEmbedded)
    .replace(/@INST@/g, instanceId)
    .replace(/@EXPECT_UPSTREAM@/g, upstreamImage)
    .replace(/@OVERLAY_IMAGE@/g, overlayImage)
    .replace(/@ALIAS@/g, NOFORK_UPSTREAM_ALIAS);
  return body;
}

/** Unused-line guard: the managed lines the update stack rewrites must stay a subset of the box env. */
export const NOFORK_MANAGED_ENV_LINE_COUNT = WEBUI_PERSISTENT_INSTALL_ENV_LINES.length;

/** Wrap the script so one SSH command installs it and starts it detached (survives the SSH session). */
export function buildNoForkMigrationLauncher(
  script: string,
  instanceId: string,
  options: { skipIdleGate?: boolean } = {}
): string {
  if (!SAFE_TOKEN.test(instanceId)) throw new Error("instance id must be a plain token");
  const path = NOFORK_SCRIPT_PATH(instanceId);
  const unit = `hermes-nofork-migrate-${instanceId}`;
  return [
    "set -e",
    `printf '%s' '${embedGz(script)}' | base64 -d | gunzip > ${path}.new`,
    `chmod 700 ${path}.new && mv -f ${path}.new ${path}`,
    `systemctl reset-failed ${unit}.service >/dev/null 2>&1 || true`,
    `systemd-run --unit=${unit} --collect --property=Type=exec${options.skipIdleGate ? " --setenv=HERMES_MIGRATE_FORCE=1" : ""} ${path} run >/dev/null`,
    `echo started`,
  ].join("\n");
}
