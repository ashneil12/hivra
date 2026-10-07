import {
  buildReleaseClientShell,
  buildSessionSurvivalShell,
} from "@/lib/services/box-release-shell";

/**
 * Last-known-good, rollback and result reporting for the dashboard-driven
 * update script (buildWebUIBootstrapScript in update mode): the same safety the
 * hourly roller has, for the UPDATE NOW button, the fleet-sync cron and every
 * other applyLiveUpdate caller.
 *
 * How it works on the box:
 *   1. Before anything is overwritten, if the stack is running and healthy, the
 *      running image is tagged `<repo>:hermes-last-known-good` (a tag the disk
 *      cleanup already protects), docker-compose.yml is copied aside, and the
 *      agent's session count is recorded. A box that is not healthy has nothing
 *      good to return to, so it gets no rollback.
 *   2. An EXIT trap watches the script. If it fails after that point, the trap
 *      puts the previous image and compose file back and, once the live source
 *      volume was touched, reseeds it and recreates the stack, then waits for
 *      health. A failure before the live stack was touched only restores the
 *      alias and compose file: it never restarts a stack that was still running.
 *   3. Before the script reports healthy it checks the sessions came through and
 *      that the chat lane the dashboard itself probes (GET /api/sessions with the
 *      box's bearer) still answers if it answered before. A container can pass
 *      its own health check and still not serve chat, which is exactly how the
 *      dashboard's recovery sweep later flags a box. A failed check is a failed
 *      update and rolls back like any other.
 *   4. The outcome (kind, running digest, target digest, reason) goes to a
 *      result file the wrapper turns into the report to the dashboard. Only a
 *      change of image counts against a release: a config-only redeploy that
 *      fails is not the release's fault.
 */

export interface UpdateSafetyParams {
  instanceId: string;
  /** Container name prefix, e.g. agent-<id>. */
  containerName: string;
  /** Local image alias the compose file runs, e.g. ghcr.io/o/n:stable. */
  agentImage: string;
  /** Repository of agentImage, without tag. */
  repo: string;
  /** The shell command that reseeds the persistent agent source from agentImage. */
  agentSourceSeedCommand: string;
  /** Host the in-VM edge Caddy answers on (the update script's own FQDN). */
  fqdn: string;
}

/** Where the wrapper sends the update script's own output. */
export function updateLogPath(instanceId: string): string {
  return `/tmp/hermes-update-${instanceId}.log`;
}

export function updateResultFilePath(instanceId: string): string {
  return `/tmp/hermes-update-${instanceId}.result`;
}

export function buildUpdateSafetyPrelude(p: UpdateSafetyParams): string {
  const gateway = `${p.containerName}-gateway`;
  return `# ── Last-known-good + rollback (update mode) ───────────────────────────
ENV_DIR="$INSTANCE_DIR"
HERMES_RESULT_FILE="${updateResultFilePath(p.instanceId)}"
HERMES_LKG_TAG="${p.repo}:hermes-last-known-good"
HERMES_LKG_COMPOSE="$INSTANCE_DIR/.docker-compose.yml.hermes-update-lkg"
HERMES_UPDATE_ARMED=0
HERMES_STACK_TOUCHED=0
HERMES_LKG_READY=0
HERMES_LKG_DIGEST=""
HERMES_SESS_BEFORE="unknown"
HERMES_CHAT_BEFORE=""
HERMES_FAIL_REASON=""
# Set by a pinned update just before it pulls the release image, so a release
# whose image cannot be pulled is the one that gets blamed.
HERMES_PINNED_DIGEST=""
rm -f "$HERMES_RESULT_FILE"
${buildReleaseClientShell({ instanceId: p.instanceId })}
${buildSessionSurvivalShell()}
# Rollback names the compose command through a variable so the forward path's
# own invocations stay the only literal ones in the script. (timeout needs a
# real command, so this cannot be a shell function.)
HERMES_COMPOSE="docker compose"
hermes_write_result() {
  {
    printf 'kind=%s\\n' "$1"
    [ -z "$2" ] || printf 'running=%s\\n' "$2"
    [ -z "$3" ] || printf 'target=%s\\n' "$3"
    [ -z "$4" ] || printf 'reason=%s\\n' "$(printf '%s' "$4" | tr -d '\\n' | head -c 300)"
  } > "$HERMES_RESULT_FILE" 2>/dev/null || true
}
# HTTP status of the chat lane the dashboard probes, through the in-VM edge Caddy.
# 000 when it cannot be reached or the box has no key.
hermes_chat_lane_status() {
  chat_key="$(hermes_env_value API_SERVER_KEY)"
  [ -n "$chat_key" ] && command -v curl >/dev/null 2>&1 || { echo 000; return 0; }
  curl -s -k -L -o /dev/null -w '%{http_code}' --max-time 8 \\
    --resolve ${shq(p.fqdn)}:80:127.0.0.1 --resolve ${shq(p.fqdn)}:443:127.0.0.1 \\
    -H "Authorization: Bearer $chat_key" http://${p.fqdn}/api/sessions 2>/dev/null || echo 000
}
hermes_gateway_is_healthy() {
  [ "$(docker inspect --format='{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}{{end}}' ${gateway} 2>/dev/null || true)" = "healthy" ]
}
hermes_update_snapshot_lkg() {
  gw_state="$(docker inspect --format='running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ${gateway} 2>/dev/null || true)"
  case "$gw_state" in
    "running=true health=healthy"|"running=true health=none") ;;
    *)
      echo "[webui-update] stack is not healthy before this update: no last-known-good to roll back to"
      return 0
      ;;
  esac
  lkg_iid="$(docker inspect --format='{{.Image}}' ${gateway} 2>/dev/null || true)"
  [ -n "$lkg_iid" ] || return 0
  docker tag "$lkg_iid" "$HERMES_LKG_TAG" || return 0
  if [ -f docker-compose.yml ]; then cp -p docker-compose.yml "$HERMES_LKG_COMPOSE" || return 0; fi
  HERMES_LKG_DIGEST="$(hermes_image_digest "$lkg_iid" ${shq(p.repo)})"
  HERMES_SESS_BEFORE="$(hermes_sessions_snapshot ${gateway})"
  HERMES_CHAT_BEFORE="$(hermes_chat_lane_status)"
  HERMES_LKG_READY=1
  HERMES_UPDATE_ARMED=1
  echo "[webui-update] last-known-good saved: $lkg_iid (sessions before: $HERMES_SESS_BEFORE, chat lane: $HERMES_CHAT_BEFORE)"
}
hermes_update_rollback() {
  set +e
  reason="$1"
  [ "$HERMES_LKG_READY" = 1 ] || { hermes_write_result failed "" "$HERMES_PINNED_DIGEST" "$reason"; return 1; }
  target_iid="$(docker image inspect ${p.agentImage} --format '{{.Id}}' 2>/dev/null || true)"
  target_digest=""
  [ -z "$target_iid" ] || target_digest="$(hermes_image_digest "$target_iid" ${shq(p.repo)})"
  blame=""
  if [ -n "$target_digest" ] && [ "$target_digest" != "$HERMES_LKG_DIGEST" ]; then blame="$target_digest"; fi
  # A pinned pull that failed leaves the alias on the old image: blame the release it named.
  if [ -z "$blame" ] && [ -n "$HERMES_PINNED_DIGEST" ] && [ "$HERMES_PINNED_DIGEST" != "$HERMES_LKG_DIGEST" ]; then blame="$HERMES_PINNED_DIGEST"; fi
  echo "[webui-update] ROLLBACK to last-known-good: $reason" >&2
  docker tag "$HERMES_LKG_TAG" ${p.agentImage} || { hermes_write_result failed "" "$blame" "$reason (rollback could not restore the image)"; return 1; }
  if [ -f "$HERMES_LKG_COMPOSE" ]; then cp -p "$HERMES_LKG_COMPOSE" docker-compose.yml; fi
  if [ "$HERMES_STACK_TOUCHED" != 1 ]; then
    echo "[webui-update] the running stack was not touched; image alias and compose file restored" >&2
    hermes_write_result failed "$HERMES_LKG_DIGEST" "$blame" "$reason"
    return 0
  fi
  ${p.agentSourceSeedCommand}
  timeout 240s $HERMES_COMPOSE up -d --force-recreate
  restored=0
  for _ in $(seq 1 90); do
    if hermes_gateway_is_healthy; then restored=1; break; fi
    sleep 2
  done
  if [ "$restored" = 1 ]; then
    echo "[webui-update] rollback applied: image, compose file and agent source restored to last-known-good" >&2
    hermes_write_result rolled_back "$HERMES_LKG_DIGEST" "$blame" "$reason"
  else
    echo "[webui-update] CRITICAL: rollback did not bring the gateway healthy" >&2
    hermes_write_result failed "$HERMES_LKG_DIGEST" "$blame" "$reason (rollback also unhealthy)"
  fi
  return 0
}
# Why the script failed, in the script's own words: its last error-looking line.
hermes_last_log_error() {
  grep -E 'FATAL|ERROR|CRITICAL|did not become|did not converge|no space left|unhealthy|failed' "${updateLogPath(p.instanceId)}" 2>/dev/null \\
    | tail -n 1 | tr -d '[:cntrl:]' | cut -c1-200
}
hermes_update_exit_trap() {
  rc=$?
  trap - EXIT
  set +e
  if [ "$rc" != 0 ]; then
    reason="\${HERMES_FAIL_REASON:-}"
    [ -n "$reason" ] || reason="$(hermes_last_log_error)"
    [ -n "$reason" ] || reason="update script exited with status $rc"
    if [ "$HERMES_UPDATE_ARMED" = 1 ]; then
      hermes_update_rollback "$reason"
    elif [ ! -f "$HERMES_RESULT_FILE" ]; then
      hermes_write_result failed "" "$HERMES_PINNED_DIGEST" "$reason"
    fi
  fi
  exit "$rc"
}
trap hermes_update_exit_trap EXIT
hermes_update_verify() {
  [ "$HERMES_LKG_READY" = 1 ] || return 0
  sess_after="$(hermes_sessions_snapshot ${gateway})"
  echo "[webui-update] sessions after update: $sess_after (before: $HERMES_SESS_BEFORE)"
  if ! hermes_sessions_survived "$HERMES_SESS_BEFORE" "$sess_after"; then
    HERMES_FAIL_REASON="sessions did not survive the update (before: $HERMES_SESS_BEFORE, after: $sess_after)"
    echo "[webui-update] FATAL: $HERMES_FAIL_REASON" >&2
    return 1
  fi
  # Only a lane that answered before can be blamed on this update.
  case "$HERMES_CHAT_BEFORE" in
    2??)
      chat_after=000
      for _ in 1 2 3 4 5 6; do
        chat_after="$(hermes_chat_lane_status)"
        case "$chat_after" in 2??) break ;; esac
        sleep 5
      done
      case "$chat_after" in
        2??) echo "[webui-update] chat lane answers ($chat_after)" ;;
        *)
          HERMES_FAIL_REASON="chat lane stopped answering after the update (HTTP $chat_after, was $HERMES_CHAT_BEFORE)"
          echo "[webui-update] FATAL: $HERMES_FAIL_REASON" >&2
          return 1
          ;;
      esac
      ;;
  esac
  return 0
}
hermes_update_commit() {
  HERMES_UPDATE_ARMED=0
  running_iid="$(docker inspect --format='{{.Image}}' ${gateway} 2>/dev/null || true)"
  hermes_write_result updated "$(hermes_image_digest "$running_iid" ${shq(p.repo)})" "" ""
  docker rmi "$HERMES_LKG_TAG" >/dev/null 2>&1 || true
  rm -f "$HERMES_LKG_COMPOSE"
  # A healthy update rebuilt the stack: that is the repair a paused hourly roll
  # was waiting for. Its next tick tells the dashboard the pause is cleared.
  rm -f "/var/lib/hermes-roll-paused-${p.instanceId}"
}
hermes_update_snapshot_lkg
`;
}

/** Runs where the update reports healthy: check the sessions, then disarm the rollback. */
export const UPDATE_VERIFY_CALL = `hermes_update_verify || exit 1
hermes_update_commit`;

/** Marks the point where the live stack's shared source is about to change. */
export const UPDATE_STACK_TOUCHED = "HERMES_STACK_TOUCHED=1";

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The part of the wrapper that turns the result file into the extra query
 * fields of the dashboard report. Digests are validated before they are put on
 * the URL. Prints nothing when the update left no result.
 */
export function buildUpdateResultExtrasShell(instanceId: string): string {
  const file = updateResultFilePath(instanceId);
  return `hermes_result_field() { sed -n "s/^$1=//p" "${file}" 2>/dev/null | head -1; }
hermes_result_extras() {
  [ -f "${file}" ] || return 0
  kind="$(hermes_result_field kind)"
  case "$kind" in updated|failed|rolled_back) ;; *) return 0 ;; esac
  extras="&k=$kind"
  running="$(hermes_result_field running)"
  target="$(hermes_result_field target)"
  if printf '%s' "$running" | grep -Eq '^sha256:[0-9a-f]{64}$'; then extras="$extras&i=$running"; fi
  if printf '%s' "$target" | grep -Eq '^sha256:[0-9a-f]{64}$'; then extras="$extras&ti=$target"; fi
  printf '%s' "$extras"
}
hermes_result_reason() { hermes_result_field reason; }`;
}
