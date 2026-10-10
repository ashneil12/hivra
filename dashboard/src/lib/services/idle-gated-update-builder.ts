import { gzipSync } from "zlib";
import { deploymentScopedDefault } from "@/lib/deployment-channel";
import { WEBUI_PERSISTENT_INSTALL_ENV_LINES } from "@/lib/services/webui-runtime-env";
import { buildAgentActivityProbeShell } from "@/lib/services/agent-activity-probe";
import {
  buildReleaseClientShell,
  buildSessionSurvivalShell,
} from "@/lib/services/box-release-shell";

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
if [ -e "/var/lib/hermes-release-governed-$INST" ] || [ -e "/var/lib/hermes-upstream-direct-$INST" ]; then
  # The dashboard pins this box to an exact release: extract the static
  # surfaces from the image the gateway runs, and never pull a floating tag.
  IMG="$(docker inspect "agent-$INST-gateway" -f '{{.Image}}' 2>/dev/null)"
  [ -n "$IMG" ] || { echo "$(ts) gateway image unknown" >>$LOG; exit 1; }
else
  docker compose pull official-dashboard gateway >/dev/null 2>>$LOG || docker pull "$IMG" >/dev/null 2>>$LOG || { echo "$(ts) pull failed" >>$LOG; exit 1; }
fi
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
ENV_DIR="$DIR"
REPORTED="/var/lib/hermes-reported-digest-\${INST}"
PAUSE_REPORTED="/var/lib/hermes-roll-pause-reported-\${INST}"
GOVERNED="/var/lib/hermes-release-governed-\${INST}"
# Set by the no-fork migration: this box follows stock upstream Hermes by itself. The Hivra
# overlay (add-only files) lives in $OVERLAY_DIR and is laid over every fresh agent source.
DIRECT="/var/lib/hermes-upstream-direct-\${INST}"
UPSTREAM_SOAK_H=24
OVERLAY_DIR="\${DIR}/overlay"
${buildReleaseClientShell({ instanceId: INST })}
${buildSessionSurvivalShell()}
# Best-effort report to the dashboard: never changes what the roll does.
report() { hermes_release_report "$@" || log "release report failed ($1)"; }
# Pause the roller and tell the dashboard. $1 = reason (kept as the pause
# marker text), $2 = kind (paused|failed|rolled_back), $3 = digest the roll was
# moving to (set only when the image itself is the suspect), $4 = digest now running.
pause_roll() {
  echo "auto-roll paused $(ts): $1" > "$PAUSE"
  if hermes_release_report "$2" failed "$1" "\${4:-\${CUR_DIGEST:-}}" "\${3:-}"; then touch "$PAUSE_REPORTED"; else log "release report failed ($2)"; fi
}
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
if b"def managed_gateway_command(" in original:
    # Current-generation compose: the supervisor already runs the existing venv without syncing,
    # so there is no old uv command to rewrite.
    raise SystemExit(0)
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
# Lay the box's overlay tools (uv, gh, hermes) over a stock upstream image, locally, with no Hivra build.
assemble_local_image() {
  stock="$1"; tag="$2"
  [ -d "$OVERLAY_DIR/bin" ] || { docker tag "$stock" "$tag"; return $?; }
  cid="$(docker create "$stock" 2>>"$LOG")" || return 1
  asm_ok=1
  for b in "$OVERLAY_DIR"/bin/*; do
    [ -f "$b" ] || continue
    docker cp "$b" "$cid:/usr/local/bin/$(basename "$b")" >>"$LOG" 2>&1 || asm_ok=0
  done
  if [ "$asm_ok" = 1 ]; then
    docker commit -c "LABEL io.hivra.assembled=local" -c "LABEL io.hivra.upstream.image=$stock" "$cid" "$tag" >/dev/null 2>>"$LOG" || asm_ok=0
  fi
  docker rm "$cid" >/dev/null 2>&1
  [ "$asm_ok" = 1 ]
}
reseed_agent_source() {
  ref="$1"
  source_image_id="$(docker image inspect "$ref" -f '{{.Id}}' 2>/dev/null)"
  [ -n "$source_image_id" ] || { log "cannot resolve source image id for $ref"; return 1; }
  overlay_args=""
  [ -d "$OVERLAY_DIR/files" ] && overlay_args="-v $OVERLAY_DIR:/overlay:ro"
  docker run --rm --user root -v "$SOURCE_VOLUME:$SOURCE_RUNTIME_DIR" $overlay_args --entrypoint sh "$ref" -lc '
    set -e
    target="$1"
    source_image_id="$2"
    test -f /opt/hermes/pyproject.toml
    find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a /opt/hermes/. "$target/"
    if [ -d /overlay/files ]; then cp -a /overlay/files/. "$target/"; fi
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
cd "$DIR" 2>/dev/null || { log "no inst dir"; exit 1; }
RUNNING="$(docker inspect "$G" -f '{{.Image}}' 2>/dev/null)"
CUR_DIGEST=""
[ -n "$RUNNING" ] && CUR_DIGEST="$(hermes_image_digest "$RUNNING" "$REPO")"
if [ -f "$PAUSE" ]; then
  log "PAUSED ($(cat "$PAUSE" 2>/dev/null)) - skip"
  # Tell the dashboard once per pause marker, including markers written before
  # it listened: a paused box is otherwise invisible until someone reads this log.
  if [ "$PAUSE" -nt "$PAUSE_REPORTED" ]; then
    if hermes_release_report paused failed "$(head -c 300 "$PAUSE" 2>/dev/null)" "$CUR_DIGEST" ""; then touch "$PAUSE_REPORTED"; else log "release report failed (paused)"; fi
  fi
  exit 0
fi
if [ -e "$PAUSE_REPORTED" ]; then
  # An operator cleared the pause: say the box is healthy again.
  if hermes_release_report updated succeeded "auto-roll pause cleared" "$CUR_DIGEST" ""; then rm -f "$PAUSE_REPORTED"; fi
fi
SOURCE_IMAGE="$(docker exec "$G" cat "$SOURCE_STAMP" 2>/dev/null || true)"
# The dashboard decides which image this box runs. It answers: roll to an exact
# digest, nothing to do, nothing offered (hold), or "legacy" while the registry
# has no release of this repository (then the floating :stable tag is followed
# exactly as before). A lookup that fails never falls back to a floating tag.
if ! REPLY="$(hermes_release_get "$REPO" "$CUR_DIGEST" 2>>"$LOG")"; then
  if [ -e "$DIRECT" ]; then
    # A box that follows upstream by itself never waits for the control plane.
    log "release lookup failed (dashboard unreachable or no credentials) - following upstream directly"
    REPLY="action=legacy"
  else
    log "release lookup failed (dashboard unreachable or no credentials) - skip"
    exit 0
  fi
fi
ACTION="$(hermes_reply_field "$REPLY" action)"
TARGET_REF=""
TARGET_DIGEST=""
case "$ACTION" in
  legacy)
    rm -f "$GOVERNED"
    if [ -e "$DIRECT" ]; then
      # Follow stock upstream Hermes by ourselves: pull the official image (Docker verifies the content
      # against its digest), let a new one soak, then add the box's own overlay tools on top locally.
      # Nothing here asks Hivra for an image.
      UP_REF="$(cat "$DIR/upstream.ref" 2>/dev/null)"
      case "$UP_REF" in nousresearch/hermes-agent:*|nousresearch/hermes-agent@sha256:*) ;; *) UP_REF="nousresearch/hermes-agent:stable" ;; esac
      docker pull -q "$UP_REF" >/dev/null 2>>"$LOG" || { log "upstream pull failed for $UP_REF - skip"; exit 0; }
      UP_DIGEST="$(docker image inspect "$UP_REF" -f '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | grep -m1 '^nousresearch/hermes-agent@sha256:')"
      [ -n "$UP_DIGEST" ] || { log "upstream image has no registry digest - skip"; exit 0; }
      CUR_UP="$(docker image inspect "$IMG" -f '{{index .Config.Labels "io.hivra.upstream.image"}}' 2>/dev/null)"
      if [ "$CUR_UP" = "$UP_DIGEST" ] && [ "$(docker image inspect "$IMG" -f '{{.Id}}' 2>/dev/null)" = "$RUNNING" ]; then
        log "already on the latest upstream image \${UP_DIGEST#*@} - no roll"
        exit 0
      fi
      # A new upstream image waits UPSTREAM_SOAK_H hours, so a bad release can be pulled upstream first.
      SEEN="/var/lib/hermes-upstream-seen-\${INST}-\${UP_DIGEST#*@sha256:}"
      [ -e "$SEEN" ] || { date +%s > "$SEEN"; log "new upstream image \${UP_DIGEST#*@} first seen - soaking \${UPSTREAM_SOAK_H}h"; }
      seen_h=$(( ( $(date +%s) - $(stat -c %Y "$SEEN") ) / 3600 ))
      [ "$seen_h" -lt "$UPSTREAM_SOAK_H" ] && { log "upstream image \${UP_DIGEST#*@} seen \${seen_h}h ago (<\${UPSTREAM_SOAK_H}h) - skip"; exit 0; }
      TARGET_REF="\${REPO}:upstream-next"
      assemble_local_image "$UP_DIGEST" "$TARGET_REF" || { log "could not add the box's overlay tools to $UP_DIGEST - skip"; exit 0; }
      LATEST="$(docker image inspect "$TARGET_REF" -f '{{.Id}}' 2>/dev/null)"
    else
      docker compose pull official-dashboard gateway >/dev/null 2>>"$LOG" || docker pull "$IMG" >/dev/null 2>>"$LOG" || { log "pull failed"; exit 0; }
      LATEST="$(docker image inspect "$IMG" -f '{{.Id}}' 2>/dev/null)"
    fi
    ;;
  roll|none)
    : > "$GOVERNED"
    TARGET_DIGEST="$(hermes_reply_field "$REPLY" digest)"
    if [ "$ACTION" = none ]; then
      # Already on the target release. Tell the dashboard once per digest so a
      # box that never reported shows its version.
      if [ -n "$CUR_DIGEST" ] && [ "$(cat "$REPORTED" 2>/dev/null)" != "$CUR_DIGEST" ]; then
        if hermes_release_report updated succeeded "version sync" "$CUR_DIGEST" ""; then printf '%s\\n' "$CUR_DIGEST" > "$REPORTED"; fi
      fi
      log "on the target release \${TARGET_DIGEST:-unknown} - no roll"
      exit 0
    fi
    TARGET_REF="$(hermes_reply_field "$REPLY" image)"
    case "$TARGET_DIGEST" in sha256:*) ;; *) log "release reply has no digest - skip"; exit 0 ;; esac
    if [ "$TARGET_REF" != "\${REPO}@\${TARGET_DIGEST}" ]; then log "release reply names an image outside $REPO - skip"; exit 0; fi
    docker pull "$TARGET_REF" >/dev/null 2>>"$LOG" || { log "pull failed for $TARGET_REF"; exit 0; }
    LATEST="$(docker image inspect "$TARGET_REF" -f '{{.Id}}' 2>/dev/null)"
    ;;
  *)
    log "no release offered (action=\${ACTION:-none} \$(hermes_reply_field "$REPLY" reason)) - skip"
    exit 0
    ;;
esac
if [ -n "$LATEST" ] && [ "$LATEST" = "$RUNNING" ] && [ "$LATEST" = "$SOURCE_IMAGE" ]; then
  log "already on latest image and source - no roll"
  if [ -n "$CUR_DIGEST" ] && [ "$(cat "$REPORTED" 2>/dev/null)" != "$CUR_DIGEST" ]; then
    if hermes_release_report updated succeeded "version sync" "$CUR_DIGEST" ""; then printf '%s\\n' "$CUR_DIGEST" > "$REPORTED"; fi
  fi
  exit 0
fi
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
  pause_roll "managed runtime env migration failed; cleared by removing this file after repair" paused ""
  exit 1
fi
if ! assert_no_unmanaged_source_consumers; then
  log "shared agent source has unmanaged running consumers - aborting before service stop + PAUSING auto-roll"
  pause_roll "shared agent source has an unmanaged running consumer; clear only after coordinating every profile container" paused ""
  exit 1
fi
if ! migrate_gateway_runtime_contract >>"$LOG" 2>&1; then
  log "gateway runtime compose migration mismatch - aborting before service stop + PAUSING auto-roll"
  pause_roll "generated gateway supervisor command contract did not match; clear only after compose repair" paused ""
  exit 1
fi
if ! docker compose config --quiet >>"$LOG" 2>&1; then
  log "compose config invalid - aborting before service stop + PAUSING auto-roll"
  restore_gateway_runtime_contract || true
  pause_roll "compose config is invalid; cleared by removing this file after config repair" paused ""
  exit 1
fi
log "ROLL: idle \${idle_min}m, new image \${LATEST} (container \${RUNNING}, source \${SOURCE_IMAGE:-unstamped})"
[ -n "$RUNNING" ] && docker tag "$RUNNING" "$LKG" 2>/dev/null || { log "cannot save running image as LKG - aborting roll"; restore_gateway_runtime_contract || true; exit 1; }
log "saved LKG \${RUNNING}"
SESS_BEFORE="$(hermes_sessions_snapshot "$G")"
log "sessions before roll: $SESS_BEFORE"
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
  pause_roll "shared agent source remained in use after service stop; clear only after coordinating every profile container" paused ""
  exit 1
fi
# Point the local alias compose runs at the exact release, only now that the
# services are stopped: every earlier abort leaves the alias on the old image.
if [ -n "$TARGET_REF" ] && ! docker tag "$TARGET_REF" "$IMG" 2>>"$LOG"; then
  log "cannot point $IMG at $TARGET_REF - restoring services"
  restore_gateway_runtime_contract || true
  docker compose up -d official-dashboard gateway >>"$LOG" 2>&1 || true
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
  pause_roll "source reseed for \${LATEST} failed; cleared by removing this file" failed "$TARGET_DIGEST"
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
FAIL_REASON=""
if [ "$ok" != 1 ]; then
  FAIL_REASON="image \${LATEST} came up unhealthy"
elif [ "$(docker inspect "$G" -f '{{.Image}}' 2>/dev/null)" != "$LATEST" ]; then
  ok=0
  FAIL_REASON="image \${LATEST} is not what the gateway runs after the roll"
else
  SESS_AFTER="$(hermes_sessions_snapshot "$G")"
  log "sessions after roll: $SESS_AFTER"
  if ! hermes_sessions_survived "$SESS_BEFORE" "$SESS_AFTER"; then
    ok=0
    FAIL_REASON="sessions did not survive the roll to \${LATEST} (before: $SESS_BEFORE, after: $SESS_AFTER)"
  fi
fi
if [ "$ok" != 1 ]; then
  log "$FAIL_REASON (gw=\${hg:-} dash=\${hd:-}) - rolling back to LKG + PAUSING auto-roll"
  restore_gateway_runtime_contract || true
  rolled_back=0
  if docker image inspect "$LKG" >/dev/null 2>&1; then
    docker tag "$LKG" "$IMG" 2>/dev/null
    if reseed_agent_source "$LKG"; then
      if docker compose up -d --force-recreate official-dashboard gateway >>"$LOG" 2>&1; then
        log "rollback applied (container and source restored to last-known-good)"
        rolled_back=1
      else
        log "CRITICAL: rollback compose recreate failed"
      fi
    else
      log "CRITICAL: LKG source reseed failed; containers left stopped from failed roll"
    fi
  fi
  if [ "$rolled_back" = 1 ]; then kind=rolled_back; else kind=failed; fi
  pause_roll "$FAIL_REASON; cleared by removing this file" "$kind" "$TARGET_DIGEST"
  exit 1
fi
/usr/local/bin/hermes-refresh-"\${INST}" >/dev/null 2>&1 || true
docker rmi "$LKG" >/dev/null 2>&1 || true
commit_gateway_runtime_contract
printf '%s\\n' "$LATEST" > "$ROLLMARK"
NEW_DIGEST="$(hermes_image_digest "$LATEST" "$REPO")"
if hermes_release_report updated succeeded "rolled to \${TARGET_DIGEST:-$NEW_DIGEST}" "$NEW_DIGEST" "\${TARGET_DIGEST:-$NEW_DIGEST}"; then
  [ -n "$NEW_DIGEST" ] && printf '%s\\n' "$NEW_DIGEST" > "$REPORTED"
else
  log "release report failed (updated)"
fi
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
