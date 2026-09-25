import { gzipSync } from "zlib";
import { deploymentScopedDefault } from "@/lib/deployment-channel";
import { WEBUI_PERSISTENT_INSTALL_ENV_LINES } from "@/lib/services/webui-runtime-env";
import { buildAgentActivityProbeShell } from "@/lib/services/agent-activity-probe";

/**
 * Idle-gated update stack provisioner.
 *
 * Replaces the legacy per-instance DAILY auto-update (which force-recreated the
 * gateway + official-dashboard containers at a fixed 06:00, interrupting live
 * agent turns) with an IDLE-GATED stack that only recreates the backend when the
 * agent is demonstrably idle.
 *
 * Three units (all proven in production):
 *   1. idle-sampler (every 3 min): stamps /run/hermes-last-active-<INST> whenever
 *      the agent is processing a turn: a gateway turn (messaging, cron, scheduled
 *      tasks: gateway_state.json active_agents) or a web-chat turn running in
 *      official-dashboard (a fresh turn marker). It runs the same probe as the
 *      in-flight update gate (agent-activity-probe.ts). Fail-safe: unknown/stale
 *      => BUSY.
 *   2. roll (hourly): idle-gated recreate of gateway+official-dashboard onto the
 *      latest :stable — only when idle >= 45 min and a new image exists. A
 *      20-hour cooldown suppresses repeat work for the same image, but never
 *      blocks a newly published image. Saves last-known-good, health-checks,
 *      rolls back + pauses on failure, re-extracts static surfaces on success.
 *   3. refresh (every 3h): pull + re-extract the static /webchat + /dash surfaces
 *      with NO container restart (zero downtime).
 *
 * Scope:
 *   - backend === "gateway": emit the full stack (sampler+roll+refresh) AND
 *     remove/disable any pre-existing daily hermes-auto-update-<INST> units.
 *   - backend === "webui": do NOT emit the stack; ONLY remove/disable the daily
 *     hermes-auto-update-<INST> units (webui is being retired; leave it frozen).
 */

const DEFAULT_AGENT_IMAGE_REPO = "ghcr.io/ashneil12/vanilla-hermes-agent";
const DEFAULT_CANARY_AGENT_IMAGE_REPO =
  "ghcr.io/ashneil12/vanilla-hermes-agent-canary";

/**
 * Match the systemd-token sanitiser used by webui-instance-builder.ts so the
 * unit names this stack writes line up with the rest of the per-instance units.
 */
function systemdSafeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.@:-]/g, "_");
}

/**
 * Embed a file body into the provisioning script as a base64(+gzip) payload that
 * the guest decodes with `base64 -d | gunzip`. This is the established pattern
 * for the auto-update units (renderEmbeddedFileWrite in hetzner-instance-builders)
 * and it sidesteps every shell-in-TS heredoc escaping hazard: the body is opaque
 * bytes until the guest decodes it, so backticks, ${}, $(), and heredoc
 * delimiters inside the script are preserved verbatim.
 */
function renderEmbeddedFileWrite(
  path: string,
  content: string,
  options?: { chmod?: string }
): string {
  const raw = Buffer.from(content, "utf8");
  const compressed = gzipSync(raw, { level: 9 });
  const shouldCompress = compressed.length < raw.length;
  const encoded = (shouldCompress ? compressed : raw).toString("base64");
  const decodePipeline = shouldCompress ? "base64 -d | gunzip" : "base64 -d";

  // Write-then-rename: the update path rewrites these files on live boxes, and a
  // running bash reads its script incrementally, so truncating a script mid-run
  // (the hourly roll, or the 3-minute sampler) would execute garbage. The rename
  // leaves a running process on the old inode.
  const staged = `${path}.hermes-new`;
  return `printf '%s' '${encoded}' | ${decodePipeline} > ${staged}${
    options?.chmod ? `\nchmod ${options.chmod} ${staged}` : ""
  }\nmv -f ${staged} ${path}`;
}

/**
 * Derive the agent image repository (no tag) from an optional explicit image
 * ref. `ghcr.io/owner/name:stable` -> `ghcr.io/owner/name`. A bare repo with no
 * tag is returned unchanged. Registry ports (`host:5000/name`) are preserved:
 * only a trailing `:tag` on the final path segment is stripped.
 */
function resolveAgentImageRepo(agentImage?: string): string {
  const ref = agentImage?.trim();
  if (!ref) {
    return deploymentScopedDefault({
      production: DEFAULT_AGENT_IMAGE_REPO,
      canary: DEFAULT_CANARY_AGENT_IMAGE_REPO,
    });
  }
  const lastSlash = ref.lastIndexOf("/");
  const lastColon = ref.lastIndexOf(":");
  // A colon that appears after the final slash denotes the tag separator.
  if (lastColon > lastSlash) {
    return (
      ref.slice(0, lastColon) ||
      deploymentScopedDefault({
        production: DEFAULT_AGENT_IMAGE_REPO,
        canary: DEFAULT_CANARY_AGENT_IMAGE_REPO,
      })
    );
  }
  return ref;
}

/**
 * Removal snippet for the legacy daily hermes-auto-update-<INST> units. Mirrors
 * the !autoUpdateEnabled branch of buildAutoUpdateTimerProvisioningScript exactly
 * (disable --now, rm the exec/service/timer, daemon-reload, reset-failed).
 */
function buildDailyAutoUpdateRemoval(instanceId: string): string {
  const timerName = `hermes-auto-update-${instanceId}`;
  const executablePath = `/usr/local/bin/${timerName}`;
  const servicePath = `/etc/systemd/system/${timerName}.service`;
  const timerPath = `/etc/systemd/system/${timerName}.timer`;
  return `systemctl disable --now ${timerName}.timer >/dev/null 2>&1 || true
rm -f ${executablePath} ${servicePath} ${timerPath}
systemctl daemon-reload
systemctl reset-failed ${timerName}.service ${timerName}.timer >/dev/null 2>&1 || true`;
}

export function buildIdleGatedUpdateProvisioningScript(params: {
  instanceId: string;
  agentImage?: string;
  backend: "gateway" | "webui";
}): string {
  const dailyRemoval = buildDailyAutoUpdateRemoval(params.instanceId);

  // WebUI is being retired: only tear down the legacy daily auto-update, never
  // install the idle-gated stack.
  if (params.backend === "webui") {
    return `${dailyRemoval}\n`;
  }

  const INST = params.instanceId;
  const REPO = resolveAgentImageRepo(params.agentImage);
  const unitToken = systemdSafeToken(INST);
  const managedRuntimeEnvLines = [
    "HOME=/home/hermes",
    ...WEBUI_PERSISTENT_INSTALL_ENV_LINES,
  ];
  const managedRuntimeEnvKeys = managedRuntimeEnvLines
    .map((line) => line.slice(0, line.indexOf("=")))
    .join("|");
  const managedRuntimeEnvBody = managedRuntimeEnvLines.join("\n");

  // ---- unit bodies (embedded verbatim; template only INST and the repo) ----

  // hermes-idle-sampler-<INST> — stamp the "last active" marker whenever the
  // agent is processing a turn. Fail-safe: stale/unreadable => ACTIVE so the
  // roller never rolls into an in-flight turn.
  //
  // "A turn is running" comes from the shared agent activity probe
  // (agent-activity-probe.ts), the same code the in-flight update gate runs, so
  // the roll and system updates can never disagree about what busy means. It
  // sees gateway turns (messaging, cron, scheduled tasks: gateway_state.json
  // active_agents) and web-chat turns, which run inside official-dashboard and
  // are invisible to gateway_state.json (the agent's durable turn markers).
  const samplerScript = `#!/usr/bin/env bash
# hermes-idle-sampler — stamp the "last active" marker whenever the agent is
# processing a turn (a gateway turn: messaging, cron, scheduled tasks; or a
# web-chat turn in official-dashboard). Fail-safe: stale/unreadable => ACTIVE so
# the roller never rolls into an in-flight turn.
set -uo pipefail
INST="${INST}"
MARK="/run/hermes-last-active-\${INST}"
${buildAgentActivityProbeShell()}
hivra_agent_activity "agent-\${INST}-gateway" "agent-\${INST}-official-dashboard"
# Only a proven-idle probe with the gateway running counts as idle. A gateway
# that is not running is never proof of idle: the roll recreates both
# containers, and this sampler has always refused to call a box it cannot see
# running idle.
case "$HIVRA_GATEWAY_STATE" in
  "true "*) gateway_up=1 ;;
  *) gateway_up=0 ;;
esac
if [ "$HIVRA_ACTIVITY_VERDICT" != idle ] || [ "$gateway_up" != 1 ]; then
  date +%s > "$MARK"
elif [ ! -e "$MARK" ]; then
  # No prior BUSY sample exists: start the 45-minute proof window now.
  date +%s > "$MARK"
fi
`;

  // hermes-refresh-<INST> — pull latest :stable + re-extract the static
  // /webchat + /dash surfaces. NO container restart -> zero downtime.
  const refreshScript = `#!/usr/bin/env bash
# hermes-refresh: pull latest :stable + re-extract the static /webchat + /dash
# surfaces. NO container restart -> zero downtime.
set -uo pipefail
INST=${INST}
DIR=/opt/hermes/instances/$INST
IMG=${REPO}:stable
LOG=/var/log/hermes-refresh.log
ts(){ date -u -Iseconds; }
cd "$DIR" 2>/dev/null || { echo "$(ts) no inst dir"; exit 1; }
docker compose pull official-dashboard gateway >/dev/null 2>>$LOG || docker pull "$IMG" >/dev/null 2>>$LOG || { echo "$(ts) pull failed" >>$LOG; exit 1; }
for m in webchat_dist:webchat web_dist_dash:dash; do
  src=\${m%%:*}; dst=\${m##*:}; [ -d "$DIR/$dst" ] || continue
  docker run --rm -v "$DIR/$dst":/out --entrypoint sh "$IMG" -lc "if [ -d /opt/hermes/hermes_cli/$src ]; then cp -a /opt/hermes/hermes_cli/$src/. /out/ && chmod -R a+rX /out; else echo WARN-image-missing /opt/hermes/hermes_cli/$src; fi" >>$LOG 2>&1
  if [ -f "$DIR/$dst/index.html" ]; then
    keep=$(grep -oE "index-[A-Za-z0-9_-]+\\.(js|css)" "$DIR/$dst/index.html" | sort -u)
    for f in "$DIR/$dst"/assets/index-*.js "$DIR/$dst"/assets/index-*.css; do
      [ -e "$f" ] || continue; b=$(basename "$f")
      echo "$keep" | grep -qF "$b" || rm -f "$f"
    done
  fi
done
echo "$(ts) refreshed (no restart)" >>$LOG
`;

  // hermes-roll-<INST> — idle-gated backend update. Recreates gateway +
  // dashboard onto the latest :stable ONLY when idle >= IDLE_MIN, a new image
  // exists. A same-image MIN_ROLL_GAP_H cooldown avoids repeat work without
  // delaying new releases. Saves LKG; rolls back + PAUSES on unhealthy.
  const rollScript = `#!/usr/bin/env bash
# hermes-roll — idle-gated backend update. Recreates gateway + dashboard onto
# the latest :stable ONLY when idle >= IDLE_MIN and a new image exists. A
# same-image MIN_ROLL_GAP_H cooldown avoids repeat work without delaying new
# releases. Saves LKG; rolls back + PAUSES on unhealthy.
set -uo pipefail
INST="${INST}"
DIR="/opt/hermes/instances/\${INST}"
REPO="${REPO}"
IMG="\${REPO}:stable"
LKG="\${REPO}:hermes-roll-lkg"
G="agent-\${INST}-gateway"
D="agent-\${INST}-official-dashboard"
SOURCE_VOLUME="agent-\${INST}_agent-source"
SOURCE_STAMP="/home/hermes/.hermes/hermes-agent/.hermes-image-id"
SOURCE_RUNTIME_DIR="/home/hermes/.hermes/hermes-agent"
COMPOSE_PATH="\${DIR}/docker-compose.yml"
COMPOSE_BACKUP="\${DIR}/.docker-compose.yml.hermes-roll-lkg"
MARK="/run/hermes-last-active-\${INST}"
ROLLMARK="/var/lib/hermes-last-roll-\${INST}"
PAUSE="/var/lib/hermes-roll-paused-\${INST}"
LOG="/var/log/hermes-roll.log"
IDLE_MIN=45
MIN_ROLL_GAP_H=20
ts() { date -u -Iseconds; }
log() { echo "$(ts) $*" >> "$LOG"; }
repair_runtime_env_file() {
  file="$1"
  [ -f "$file" ] || return 0
  tmp="\${file}.hermes-runtime-env.$$"
  log_file="\${LOG:-/dev/stderr}"
  if ! awk -v log_file="$log_file" '
    /^[[:space:]]*($|#)/ { print; next }
    !/^[A-Za-z_][A-Za-z0-9_]*=/ {
      printf "invalid env key at line %d dropped from %s\\n", NR, FILENAME >> log_file
      next
    }
    !/^(${managedRuntimeEnvKeys})=/ { print }
  ' "$file" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  cat >> "$tmp" <<'HERMES_MANAGED_RUNTIME_ENV'
${managedRuntimeEnvBody}
HERMES_MANAGED_RUNTIME_ENV
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}
repair_runtime_env_files() {
  repair_runtime_env_file "$DIR/.env" &&
    repair_runtime_env_file "$DIR/hermes.env"
}
migrate_gateway_runtime_contract() {
  [ -f "$COMPOSE_PATH" ] || {
    echo "gateway runtime compose migration: missing $COMPOSE_PATH" >&2
    return 1
  }
  [ ! -e "$COMPOSE_BACKUP" ] || {
    echo "gateway runtime compose migration: stale backup exists at $COMPOSE_BACKUP" >&2
    return 1
  }
  python3 - "$COMPOSE_PATH" "$COMPOSE_BACKUP" <<'PY'
import os
import pathlib
import sys
import tempfile

compose_path = pathlib.Path(sys.argv[1])
backup_path = pathlib.Path(sys.argv[2])
original = compose_path.read_bytes()
pairs = (
    (
        b'status_cmd = ["uv", "run", "--extra", "messaging", "hermes", "gateway", "status"]',
        b'status_cmd = ["uv", "run", "--no-sync", "--extra", "messaging", "hermes", "gateway", "status"]',
        "status_cmd",
    ),
    (
        b'run_cmd = ["uv", "run", "--extra", "messaging", "hermes", "gateway", "run", "--replace", "--accept-hooks"]',
        b'run_cmd = ["uv", "run", "--no-sync", "--extra", "messaging", "hermes", "gateway", "run", "--replace", "--accept-hooks"]',
        "run_cmd",
    ),
)

updated = original
for mutable, immutable, label in pairs:
    mutable_count = original.count(mutable)
    immutable_count = original.count(immutable)
    if mutable_count + immutable_count != 1:
        print(
            "gateway runtime compose migration: "
            + label
            + " expected exactly one known form; mutable="
            + str(mutable_count)
            + " immutable="
            + str(immutable_count),
            file=sys.stderr,
        )
        raise SystemExit(2)
    updated = updated.replace(mutable, immutable)

for mutable, _immutable, label in pairs:
    if mutable in updated:
        print(
            "gateway runtime compose migration: mutable " + label + " remains after rewrite",
            file=sys.stderr,
        )
        raise SystemExit(3)

if updated == original:
    raise SystemExit(0)

stat = compose_path.stat()
backup_fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.st_mode & 0o7777)
try:
    with os.fdopen(backup_fd, "wb") as backup:
        backup.write(original)
        backup.flush()
        os.fsync(backup.fileno())
    try:
        os.chown(backup_path, stat.st_uid, stat.st_gid)
    except PermissionError:
        pass

    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=compose_path.parent, prefix=".docker-compose.hermes-runtime.", delete=False
        ) as temp:
            temp_name = temp.name
            temp.write(updated)
            temp.flush()
            os.fsync(temp.fileno())
        os.chmod(temp_name, stat.st_mode & 0o7777)
        try:
            os.chown(temp_name, stat.st_uid, stat.st_gid)
        except PermissionError:
            pass
        os.replace(temp_name, compose_path)
        temp_name = None
        directory_fd = os.open(compose_path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temp_name is not None:
            pathlib.Path(temp_name).unlink(missing_ok=True)
except Exception:
    backup_path.unlink(missing_ok=True)
    raise
PY
}
restore_gateway_runtime_contract() {
  [ -f "$COMPOSE_BACKUP" ] || return 0
  if mv -f "$COMPOSE_BACKUP" "$COMPOSE_PATH"; then
    log "restored pre-roll gateway runtime compose contract"
    return 0
  fi
  log "CRITICAL: failed to restore pre-roll gateway runtime compose contract"
  return 1
}
commit_gateway_runtime_contract() {
  rm -f "$COMPOSE_BACKUP"
}
assert_no_unmanaged_source_consumers() {
  unexpected=""
  for container_id in $(docker ps -q --filter "volume=$SOURCE_VOLUME" 2>/dev/null); do
    container_name="$(docker inspect "$container_id" -f '{{.Name}}' 2>/dev/null | sed 's|^/||')"
    case "$container_name" in
      "$G"|"$D") ;;
      *) unexpected="\${unexpected}\${unexpected:+,}\${container_name:-$container_id}" ;;
    esac
  done
  [ -z "$unexpected" ] || {
    log "shared agent source has unmanaged running consumers: $unexpected"
    return 1
  }
}
assert_agent_source_quiesced() {
  remaining="$(docker ps -q --filter "volume=$SOURCE_VOLUME" 2>/dev/null | paste -sd, -)"
  [ -z "$remaining" ] || {
    log "shared agent source still mounted by running containers after stop: $remaining"
    return 1
  }
}
reseed_agent_source() {
  ref="$1"
  source_image_id="$(docker image inspect "$ref" -f '{{.Id}}' 2>/dev/null)"
  [ -n "$source_image_id" ] || { log "cannot resolve source image id for $ref"; return 1; }
  docker run --rm --user root -v "$SOURCE_VOLUME:$SOURCE_RUNTIME_DIR" --entrypoint sh "$ref" -lc '
    set -e
    target="$1"
    source_image_id="$2"
    test -f /opt/hermes/pyproject.toml
    find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a /opt/hermes/. "$target/"
    assert_relocated_venv() {
      if find "$target/.venv" -type f \\( -path "*/bin/*" -o -name "__editable__*.py" -o -name "*.pth" -o -name "direct_url.json" \\) -exec grep -IlF /opt/hermes {} + 2>/dev/null | grep -q .; then
        echo "source reseed relocation left embedded /opt/hermes paths" >&2
        return 1
      fi
    }
    if [ -d "$target/.venv" ]; then
      find "$target/.venv" -type f \\( -path "*/bin/*" -o -name "__editable__*.py" -o -name "*.pth" -o -name "direct_url.json" \\) -print 2>/dev/null | while IFS= read -r script; do
        tmp="\${script}.hermes-relocate.$$"
        if sed "s|/opt/hermes|$target|g" "$script" > "$tmp"; then
          chmod --reference="$script" "$tmp" 2>/dev/null || true
          chown --reference="$script" "$tmp" 2>/dev/null || true
          mv -f "$tmp" "$script"
        else
          rm -f "$tmp"
          exit 1
        fi
      done
      assert_relocated_venv
    fi
    [ -x "$target/.venv/bin/python" ] && [ -x "$target/.venv/bin/hermes" ] || {
      echo "source reseed shipped venv executable validation failed" >&2
      exit 1
    }
    cd "$target"
    "$target/.venv/bin/hermes" --version
    if ! "$target/.venv/bin/python" -c "import pathlib,sys,hermes_cli; root=pathlib.Path(sys.argv[1]).resolve(); module=pathlib.Path(hermes_cli.__file__).resolve(); raise SystemExit(0 if root in module.parents else 1)" "$target"; then
      echo "source reseed relocated hermes_cli import validation failed" >&2
      exit 1
    fi
    assert_relocated_venv
    printf "%s\\n" "$source_image_id" > "$target/.hermes-image-id"
    [ "$(cat "$target/.hermes-image-id")" = "$source_image_id" ] || {
      echo "source reseed image stamp validation failed" >&2
      exit 1
    }
    chown -R 1024:1024 "$target"
    chmod -R u+w "$target"
  ' -- "$SOURCE_RUNTIME_DIR" "$source_image_id" >>"$LOG" 2>&1
}
[ -f "$PAUSE" ] && { log "PAUSED ($(cat "$PAUSE" 2>/dev/null)) - skip"; exit 0; }
cd "$DIR" 2>/dev/null || { log "no inst dir"; exit 1; }
docker compose pull official-dashboard gateway >/dev/null 2>>"$LOG" || docker pull "$IMG" >/dev/null 2>>"$LOG" || { log "pull failed"; exit 0; }
LATEST="$(docker image inspect "$IMG" -f '{{.Id}}' 2>/dev/null)"
RUNNING="$(docker inspect "$G" -f '{{.Image}}' 2>/dev/null)"
SOURCE_IMAGE="$(docker exec "$G" cat "$SOURCE_STAMP" 2>/dev/null || true)"
[ -n "$LATEST" ] && [ "$LATEST" = "$RUNNING" ] && [ "$LATEST" = "$SOURCE_IMAGE" ] && { log "already on latest image and source - no roll"; exit 0; }
if [ -f "$ROLLMARK" ]; then
  LAST_ROLLED_IMAGE="$(head -n 1 "$ROLLMARK" 2>/dev/null || true)"
  if [ "$LATEST" = "$LAST_ROLLED_IMAGE" ]; then
    gap_h=$(( ( $(date +%s) - $(stat -c %Y "$ROLLMARK") ) / 3600 ))
    [ "$gap_h" -lt "$MIN_ROLL_GAP_H" ] && { log "same image rolled \${gap_h}h ago (<\${MIN_ROLL_GAP_H}h) - skip"; exit 0; }
  else
    log "new image \${LATEST} differs from last rolled \${LAST_ROLLED_IMAGE:-unknown} - bypassing restart cooldown"
  fi
fi
if [ ! -f "$MARK" ]; then date +%s > "$MARK"; log "no idle marker yet - starting clock, skip"; exit 0; fi
idle_min=$(( ( $(date +%s) - $(stat -c %Y "$MARK") ) / 60 ))
[ "$idle_min" -lt "$IDLE_MIN" ] && { log "active \${idle_min}m ago (<\${IDLE_MIN}m idle) - defer"; exit 0; }
# The sampler runs every 3 minutes, so a turn may have started since its last
# sample. Take one more sample right before stopping anything.
/usr/local/bin/hermes-idle-sampler-"\${INST}" >/dev/null 2>&1 || date +%s > "$MARK"
idle_min=$(( ( $(date +%s) - $(stat -c %Y "$MARK") ) / 60 ))
[ "$idle_min" -lt "$IDLE_MIN" ] && { log "turn started since the last idle sample - defer"; exit 0; }
if ! repair_runtime_env_files; then
  log "managed runtime env migration failed - aborting before service stop + PAUSING auto-roll"
  echo "auto-roll paused $(ts): managed runtime env migration failed; cleared by removing this file after repair" > "$PAUSE"
  exit 1
fi
if ! assert_no_unmanaged_source_consumers; then
  log "shared agent source has unmanaged running consumers - aborting before service stop + PAUSING auto-roll"
  echo "auto-roll paused $(ts): shared agent source has an unmanaged running consumer; clear only after coordinating every profile container" > "$PAUSE"
  exit 1
fi
if ! migrate_gateway_runtime_contract >>"$LOG" 2>&1; then
  log "gateway runtime compose migration mismatch - aborting before service stop + PAUSING auto-roll"
  echo "auto-roll paused $(ts): generated gateway supervisor command contract did not match; clear only after compose repair" > "$PAUSE"
  exit 1
fi
if ! docker compose config --quiet >>"$LOG" 2>&1; then
  log "compose config invalid - aborting before service stop + PAUSING auto-roll"
  restore_gateway_runtime_contract || true
  echo "auto-roll paused $(ts): compose config is invalid; cleared by removing this file after config repair" > "$PAUSE"
  exit 1
fi
log "ROLL: idle \${idle_min}m, new image \${LATEST} (container \${RUNNING}, source \${SOURCE_IMAGE:-unstamped})"
[ -n "$RUNNING" ] && docker tag "$RUNNING" "$LKG" 2>/dev/null || { log "cannot save running image as LKG - aborting roll"; restore_gateway_runtime_contract || true; exit 1; }
log "saved LKG \${RUNNING}"
if ! docker compose stop official-dashboard gateway >>"$LOG" 2>&1; then
  log "failed to stop services cleanly - aborting roll"
  restore_gateway_runtime_contract || true
  docker compose up -d official-dashboard gateway >>"$LOG" 2>&1 || true
  exit 1
fi
if ! assert_agent_source_quiesced; then
  log "shared agent source did not quiesce - restoring services + PAUSING auto-roll"
  restore_gateway_runtime_contract || true
  docker compose up -d official-dashboard gateway >>"$LOG" 2>&1 || true
  echo "auto-roll paused $(ts): shared agent source remained in use after service stop; clear only after coordinating every profile container" > "$PAUSE"
  exit 1
fi
if ! reseed_agent_source "$IMG"; then
  log "source reseed failed for $IMG - restoring LKG source + PAUSING auto-roll"
  lkg_source_restored=0
  if docker image inspect "$LKG" >/dev/null 2>&1; then
    docker tag "$LKG" "$IMG" 2>/dev/null || true
    if reseed_agent_source "$LKG"; then
      lkg_source_restored=1
    else
      log "CRITICAL: LKG source restoration failed after target reseed failure; services remain stopped"
    fi
  else
    log "CRITICAL: LKG image missing after target reseed failure; services remain stopped"
  fi
  restore_gateway_runtime_contract || true
  if [ "$lkg_source_restored" = 1 ]; then
    if docker compose up -d --force-recreate official-dashboard gateway >>"$LOG" 2>&1; then
      log "services restored after source reseed failure"
    else
      log "CRITICAL: rollback compose recreate failed after source reseed failure"
    fi
  else
    log "CRITICAL: refusing to start services from an unverified partial source tree"
  fi
  echo "auto-roll paused $(ts): source reseed for \${LATEST} failed; cleared by removing this file" > "$PAUSE"
  exit 1
fi
docker compose up -d --force-recreate official-dashboard gateway >>"$LOG" 2>&1
ok=0
for _ in $(seq 1 60); do
  sleep 5
  hg="$(docker inspect "$G" -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none)"
  hd="$(docker inspect "$D" -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none)"
  [ "$hg" = unhealthy ] && break
  if { [ "$hg" = healthy ] || [ "$hg" = none ]; } && { [ "$hd" = healthy ] || [ "$hd" = none ]; }; then ok=1; break; fi
done
if [ "$ok" != 1 ]; then
  log "UNHEALTHY after roll (gw=$hg dash=$hd) - rolling back to LKG + PAUSING auto-roll"
  restore_gateway_runtime_contract || true
  if docker image inspect "$LKG" >/dev/null 2>&1; then
    docker tag "$LKG" "$IMG" 2>/dev/null
    if reseed_agent_source "$LKG"; then
      if docker compose up -d --force-recreate official-dashboard gateway >>"$LOG" 2>&1; then
        log "rollback applied (container and source restored to last-known-good)"
      else
        log "CRITICAL: rollback compose recreate failed"
      fi
    else
      log "CRITICAL: LKG source reseed failed; containers left stopped from failed roll"
    fi
  fi
  echo "auto-roll paused $(ts): image \${LATEST} came up unhealthy; cleared by removing this file" > "$PAUSE"
  exit 1
fi
/usr/local/bin/hermes-refresh-"\${INST}" >/dev/null 2>&1 || true
docker rmi "$LKG" >/dev/null 2>&1 || true
commit_gateway_runtime_contract
printf '%s\\n' "$LATEST" > "$ROLLMARK"
log "roll complete + healthy + UI re-extracted"
`;

  // ---- systemd unit files ----

  type UnitKind = {
    kind: string;
    description: string;
    timerDescription: string;
    onCalendar: string;
    script: string;
  };

  const units: UnitKind[] = [
    {
      kind: "idle-sampler",
      description: `Hermes idle sampler for ${INST}`,
      timerDescription: `Hermes idle sampler timer for ${INST}`,
      onCalendar: "*:0/3",
      script: samplerScript,
    },
    {
      kind: "roll",
      description: `Hermes idle-gated backend roll for ${INST}`,
      timerDescription: `Hermes idle-gated backend roll timer for ${INST}`,
      onCalendar: "*-*-* *:07:00",
      script: rollScript,
    },
    {
      kind: "refresh",
      description: `Hermes static-surface refresh for ${INST}`,
      timerDescription: `Hermes static-surface refresh timer for ${INST}`,
      onCalendar: "*-*-* 00/3:50:00",
      script: refreshScript,
    },
  ];

  const writeBlocks: string[] = [];
  const timerNames: string[] = [];
  const resetFailedNames: string[] = [];

  for (const unit of units) {
    const serviceName = `hermes-${unit.kind}-${unitToken}`;
    const executablePath = `/usr/local/bin/hermes-${unit.kind}-${INST}`;
    const servicePath = `/etc/systemd/system/${serviceName}.service`;
    const timerPath = `/etc/systemd/system/${serviceName}.timer`;

    const serviceFile = `[Unit]
Description=${unit.description}
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${executablePath}`;

    const timerFile = `[Unit]
Description=${unit.timerDescription}

[Timer]
OnCalendar=${unit.onCalendar}
Persistent=true
Unit=${serviceName}.service

[Install]
WantedBy=timers.target`;

    writeBlocks.push(
      `${renderEmbeddedFileWrite(executablePath, unit.script, { chmod: "+x" })}
${renderEmbeddedFileWrite(servicePath, serviceFile)}
${renderEmbeddedFileWrite(timerPath, timerFile)}`
    );
    timerNames.push(`${serviceName}.timer`);
    resetFailedNames.push(`${serviceName}.service ${serviceName}.timer`);
  }

  return `# Remove the legacy daily auto-update before installing the idle-gated stack.
${dailyRemoval}
# Idle-gated update stack: idle-sampler + roll + refresh.
${writeBlocks.join("\n")}
systemctl daemon-reload
systemctl reset-failed ${resetFailedNames.join(" ")} >/dev/null 2>&1 || true
systemctl enable --now ${timerNames.join(" ")} >/dev/null 2>&1 || true
`;
}
