/**
 * Shell building blocks shared by the box-side update stack: the hourly roll
 * script and the dashboard-driven update script. Both ask the dashboard which
 * immutable image to run, read what image a container really runs, report the
 * outcome, and check that the agent's sessions survived the swap.
 *
 * Each builder returns plain shell with no template placeholders left in it.
 * Shell parameter expansions use the `$var` / `$(...)` forms so the text can be
 * spliced into the generated scripts' template literals unchanged.
 */

/** Version of the box-side update stack that reports this protocol (update_stack_version). */
export const UPDATE_STACK_VERSION = 2;

const SHA256_DIGEST = "^sha256:[0-9a-f]{64}$";

/**
 * Functions that talk to the dashboard with the box's own bearer, the same
 * credentials the update reporter (`ru`) already uses from `$ENV_DIR/.env`.
 *
 * - `hermes_release_get <repo> <current-digest>`: prints the key=value reply of
 *   GET /api/u/<id>/release (action=roll|none|hold|legacy ...). Fails when the
 *   dashboard cannot be reached or the box has no credentials: callers treat
 *   that as "do not roll", never as permission to follow a floating tag.
 * - `hermes_release_report <kind> <status> <reason> <running> <target>`:
 *   reports one outcome. kind is updated|failed|rolled_back|paused; status is
 *   succeeded|failed; the digests are optional and validated before they are
 *   put on the URL.
 *
 * `ENV_DIR` must name the directory that holds the instance `.env`.
 */
export function buildReleaseClientShell(params: { instanceId: string }): string {
  const inst = params.instanceId;
  if (!/^[A-Za-z0-9_-]+$/.test(inst)) {
    throw new Error("buildReleaseClientShell: instance id must be a plain token");
  }
  return `# --- release client: ask the dashboard which image to run, report what happened ---
hermes_env_value() {
  [ -f "$ENV_DIR/.env" ] || return 1
  sed -n "s/^$1=//p" "$ENV_DIR/.env" | head -1
}
hermes_dashboard_creds() {
  command -v curl >/dev/null 2>&1 || return 1
  HERMES_DASH_URL="$(hermes_env_value HERMES_DASHBOARD_URL | sed 's:/*$::')"
  HERMES_DASH_KEY="$(hermes_env_value API_SERVER_KEY)"
  [ -n "$HERMES_DASH_URL" ] && [ -n "$HERMES_DASH_KEY" ]
}
hermes_release_get() {
  hermes_dashboard_creds || return 1
  curl -fsSGm15 -H "Authorization: Bearer $HERMES_DASH_KEY" \\
    --data-urlencode "repo=$1" --data-urlencode "cur=$2" \\
    "$HERMES_DASH_URL/api/u/${inst}/release"
}
hermes_release_report() {
  hermes_dashboard_creds || return 1
  extras="&k=$1&sv=${UPDATE_STACK_VERSION}"
  if printf '%s' "$4" | grep -Eq '${SHA256_DIGEST}'; then extras="$extras&i=$4"; fi
  if printf '%s' "$5" | grep -Eq '${SHA256_DIGEST}'; then extras="$extras&ti=$5"; fi
  curl -fsSGm10 -H "Authorization: Bearer $HERMES_DASH_KEY" \\
    --data-urlencode "r=$3" \\
    "$HERMES_DASH_URL/api/u/${inst}?s=$2&t=scheduled$extras" >/dev/null 2>&1
}
# Value of one key=value line of a release_get reply.
hermes_reply_field() {
  printf '%s\\n' "$1" | sed -n "s/^$2=//p" | head -1
}
# Registry digest (sha256:...) of an image id or ref, for the given repo.
hermes_image_digest() {
  docker image inspect "$1" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null \\
    | awk -v r="$2@" 'index($0, r) == 1 { print substr($0, length(r) + 1); exit }'
}
`;
}

/**
 * Session survival check. `hermes_sessions_snapshot <container>` prints one of
 *   ok <count>   state.db opened read-only, integrity ok, <count> session rows
 *   missing      the sessions mount exists but state.db does not
 *   corrupt      state.db failed its integrity check
 *   unknown      could not be read (no mount, no python3, locked)
 * and `hermes_sessions_survived <before> <after>` returns 0 when an update left
 * the sessions intact: the database must still open and pass its integrity
 * check, and the session count must not have dropped by more than 10% (at
 * least 5). Anything the check cannot read (unknown) does not block an update;
 * a database that existed and is gone, or that is corrupt, always does.
 */
export function buildSessionSurvivalShell(): string {
  return `# --- session survival: the agent's sessions must come through an update ---
hermes_sessions_snapshot() {
  src="$(docker inspect "$1" --format '{{range .Mounts}}{{println .Destination .Source}}{{end}}' 2>/dev/null \\
    | awk '$1 == "/home/hermes/.hermes" || $1 == "/home/hermes/.hermes/sessions" || $1 == "/root/.hermes/sessions" || $1 == "/opt/data/sessions" { print $2; exit }')"
  [ -n "$src" ] || { echo unknown; return 0; }
  [ -f "$src/state.db" ] || { echo missing; return 0; }
  command -v python3 >/dev/null 2>&1 || { echo unknown; return 0; }
  python3 - "$src/state.db" <<'HERMES_SESSIONS_PY' 2>/dev/null || echo unknown
import sqlite3, sys
try:
    conn = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=5)
    if conn.execute("pragma integrity_check").fetchone()[0] != "ok":
        print("corrupt")
    else:
        tables = {row[0] for row in conn.execute("select name from sqlite_master where type='table'")}
        count = conn.execute("select count(*) from sessions").fetchone()[0] if "sessions" in tables else 0
        print("ok %d" % count)
except sqlite3.OperationalError:
    print("unknown")
except sqlite3.DatabaseError:
    print("corrupt")
except Exception:
    print("unknown")
HERMES_SESSIONS_PY
}
hermes_sessions_survived() {
  before="$1"; after="$2"
  case "$after" in
    corrupt) [ "$before" = corrupt ] && return 0; return 1 ;;
    missing) case "$before" in ok\\ *) return 1 ;; *) return 0 ;; esac ;;
  esac
  case "$before" in ok\\ *) ;; *) return 0 ;; esac
  case "$after" in ok\\ *) ;; *) return 0 ;; esac
  before_n="\${before#ok }"; after_n="\${after#ok }"
  allowed_drop=$(( before_n / 10 )); [ "$allowed_drop" -lt 5 ] && allowed_drop=5
  [ "$after_n" -ge $(( before_n - allowed_drop )) ]
}
`;
}
