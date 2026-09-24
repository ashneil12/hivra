export const WEBUI_HERMES_HOME = "/home/hermes/.hermes";
export const WEBUI_HERMES_AGENT_DIR = `${WEBUI_HERMES_HOME}/hermes-agent`;
// The published agent image defaults this to /opt/data, but the split Hivra
// runtime stores projects under HERMES_HOME/workspace and also exposes the
// dedicated /workspace volume. Keep the legacy root for compatibility while
// explicitly allowing both workspace locations used by this topology.
export const WEBUI_HERMES_WRITE_SAFE_ROOTS =
  `/opt/data:${WEBUI_HERMES_HOME}/workspace:/workspace`;
const WEBUI_HERMES_SOURCE_BIN = `${WEBUI_HERMES_AGENT_DIR}/hermes`;
const WEBUI_HERMES_VENV_BIN = `${WEBUI_HERMES_AGENT_DIR}/.venv/bin/hermes`;
const WEBUI_PYTHON_USER_BASE = `${WEBUI_HERMES_HOME}/python`;
const WEBUI_PIP_CONFIG_FILE = `${WEBUI_HERMES_HOME}/pip.conf`;
// /usr/local/sbin:/usr/sbin:/sbin must be present — the WebUI image's
// The legacy WebUI init script runs `groupmod` during container init, which lives
// at /usr/sbin/groupmod on Debian. Without these entries, init dies with
// "groupmod: command not found" and webui crash-loops on every fresh
// deploy. Mirrors the canary 407 hotfix that previously had to be applied
// in-VM by editing docker-compose.yml + .env after the dashboard
// regenerated them.
export const WEBUI_RUNTIME_PATH = `${WEBUI_HERMES_HOME}/bin:${WEBUI_PYTHON_USER_BASE}/bin:/home/hermes/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/games:/usr/games`;

export const WEBUI_PERSISTENT_INSTALL_ENV_LINES = [
  `PATH=${WEBUI_RUNTIME_PATH}`,
  `GH_CONFIG_DIR=${WEBUI_HERMES_HOME}/gh`,
  `XDG_CONFIG_HOME=${WEBUI_HERMES_HOME}/.config`,
  // Pin the remaining XDG base dirs into the persisted, uid-1024-writable
  // HERMES_HOME volume — NOT their ~/.local/{state,share} & ~/.cache defaults.
  // The gateway container runs as uid 1024 with HOME defaulting to "/" (no
  // passwd entry; see the HOME pin in webui-instance-builder's gateway block),
  // and /home/hermes itself is root:root 0755, so a bare ~/.local is
  // uncreatable either way. The gateway's per-platform startup lock
  // (gateway/status.py _get_lock_dir → $XDG_STATE_HOME, else ~/.local/state)
  // therefore tried to mkdir "/.local" and every messaging platform —
  // Telegram, Signal, WhatsApp, Slack, … — crash-looped with
  // "PermissionError: [Errno 13] Permission denied: '/.local'". Redirecting
  // XDG_STATE_HOME here lands the lock under the writable volume. DATA/CACHE
  // are pinned alongside so any other XDG-respecting tool stays on-volume too.
  `XDG_STATE_HOME=${WEBUI_HERMES_HOME}/.local/state`,
  `XDG_DATA_HOME=${WEBUI_HERMES_HOME}/.local/share`,
  `XDG_CACHE_HOME=${WEBUI_HERMES_HOME}/.cache`,
  `PYTHONUSERBASE=${WEBUI_PYTHON_USER_BASE}`,
  `PIP_CONFIG_FILE=${WEBUI_PIP_CONFIG_FILE}`,
  `PIP_CACHE_DIR=${WEBUI_HERMES_HOME}/cache/pip`,
  // Where the agent pip-installs opt-in "lazy" features on first use
  // (tools/lazy_deps.py → HERMES_LAZY_INSTALL_TARGET). The agent image hardcodes
  // `ENV HERMES_LAZY_INSTALL_TARGET=/opt/data/lazy-packages`, which its s6
  // stage2-hook seeds + chowns at boot. These boxes bypass s6 entirely
  // (entrypoint:[] + the gateway-supervisor command), and their HERMES_HOME is
  // /home/hermes/.hermes — not /opt/data — so the hardcoded target was never
  // seeded and is root-owned/unreadable to uid 1024. Every lazy feature then
  // died with "lazy install target /opt/data/lazy-packages is not writable":
  // terminal.daytona, terminal.modal, ElevenLabs/mistral TTS, Firecrawl/Exa,
  // mem0/supermemory, and the platform connectors. Pinning it onto the
  // uid-1024-writable HERMES_HOME volume fixes them all (lazy_deps mkdir -p's
  // the leaf itself), and keeps installs persistent across image updates.
  `HERMES_LAZY_INSTALL_TARGET=${WEBUI_HERMES_HOME}/lazy-packages`,
  `PIPX_HOME=${WEBUI_HERMES_HOME}/pipx`,
  `PIPX_BIN_DIR=${WEBUI_HERMES_HOME}/bin`,
  `UV_CACHE_DIR=${WEBUI_HERMES_HOME}/cache/uv`,
  `UV_TOOL_DIR=${WEBUI_HERMES_HOME}/uv/tools`,
  `UV_TOOL_BIN_DIR=${WEBUI_HERMES_HOME}/bin`,
  `NPM_CONFIG_PREFIX=${WEBUI_HERMES_HOME}/npm`,
  `NPM_CONFIG_CACHE=${WEBUI_HERMES_HOME}/cache/npm`,
  `PNPM_HOME=${WEBUI_HERMES_HOME}/pnpm`,
  `YARN_GLOBAL_FOLDER=${WEBUI_HERMES_HOME}/yarn/global`,
  `YARN_CACHE_FOLDER=${WEBUI_HERMES_HOME}/cache/yarn`,
  `COREPACK_HOME=${WEBUI_HERMES_HOME}/corepack`,
  `CARGO_HOME=${WEBUI_HERMES_HOME}/cargo`,
  `RUSTUP_HOME=${WEBUI_HERMES_HOME}/rustup`,
  `GOPATH=${WEBUI_HERMES_HOME}/go`,
  `GOBIN=${WEBUI_HERMES_HOME}/bin`,
  `BUN_INSTALL=${WEBUI_HERMES_HOME}/bun`,
  `DENO_INSTALL=${WEBUI_HERMES_HOME}/deno`,
  `GEM_HOME=${WEBUI_HERMES_HOME}/gem`,
  `GEM_PATH=${WEBUI_HERMES_HOME}/gem`,
  `COMPOSER_HOME=${WEBUI_HERMES_HOME}/composer`,
  `DOTNET_CLI_HOME=${WEBUI_HERMES_HOME}/dotnet`,
];

export const WEBUI_PERSISTENT_INSTALL_ENV_KEYS = WEBUI_PERSISTENT_INSTALL_ENV_LINES.map(
  (line) => line.split("=", 1)[0]
);

// Every BANKR_* line buildBankrEnvLines can emit, in the managed list's order.
// Hivra writes these keys on a webfree box: they are upserted whenever a wallet
// is deliverable and removed only by the per-run reconcile for a user-connected
// wallet (see WEBUI_CLEARABLE_RUNTIME_ENV_KEYS).
export const WEBUI_BANKR_RUNTIME_ENV_KEYS = [
  "BANKR_AGENT_WALLET_ADDRESS",
  "BANKR_WALLET_ADDRESS",
  "BANKR_AGENT_API_KEY",
  "BANKR_API_KEY",
  "BANKR_AGENT_WALLET_ID",
  "BANKR_AGENT_WITHDRAWAL_DESTINATION",
] as const;

// Per-instance managed runtime env keys that are NOT static install lines but
// MUST be repaired into the live /state/.env on every update. Their values come
// from the freshly generated hermes.env (buildHermesEnvFile), not from a static
// line here. Without listing a key here, a dashboard-side feature flip never
// reaches an already-provisioned instance: the update path preserves
// /state/.env and only re-applies the managed key set.
//   - BROWSER_CDP_URL: the agent↔sidecar CDP bridge endpoint (gated on the
//     bridge + sidecar opt-in).
//   - HERMES_BROWSER_SIDECAR_URL: in CDP mode this is set to a "disabled"
//     sentinel so the agent's Vex browser_sidecar probe fails and those HTTP
//     tools never register; it must reach the live agent to take effect.
//   - DAYTONA_API_KEY: the BYO Daytona cloud-sandbox key a user saves in the
//     console's Terminal Execution card. It MUST be listed here — the key is
//     entered against an already-provisioned box, so without the managed
//     repair the update would preserve the old /state/.env and the key would
//     silently never reach the agent (terminal.backend=daytona would then fail
//     and fall back to local, looking like the feature is broken).
//   - TAVILY_API_KEY / FIRECRAWL_API_KEY: same shape — user-entered search keys
//     from instance settings. They were emitted into hermes.env but NOT listed
//     here, so on every already-provisioned box a newly-added key was never
//     added to /state/.env and an edited key kept its old value FOREVER. Web
//     search silently stayed broken/stale no matter how many times the user
//     re-saved. (Found 2026-07-16 while fixing the Daytona path.)
//   - BANKR_* (WEBUI_BANKR_RUNTIME_ENV_KEYS): the agent's Bankr wallet
//     identity/creds. Same shape, and the omission defeated a path built
//     specifically to reach live boxes — instance-orchestrator calls
//     resolveBankrRuntimeEnvPlanForUpdate() on the UPDATE path and feeds the
//     config into webUIParams, but buildBankrEnvLines' output landed only in
//     the freshly generated hermes.env, which an update discards in favour of
//     the persisted /state/.env. So a wallet attached to an existing agent
//     never reached it. Values are DB-resolved (a Hivra-provisioned wallet, or
//     a key the user connected from their own Bankr account), so re-applying
//     them is a convergence, not a surprise.
// These only appear in the generated hermes.env when the relevant feature is
// on; the repair copies whichever are present (`[ -n "$managed_env_line" ] ||
// continue`), so listing a key a given box doesn't use is a no-op rather than a
// clobber. That skip is why every key here MUST be emitted conditionally — an
// unconditional `KEY=` line for an unset value is a non-empty *line*, so the
// repair would happily overwrite a live value with empty. buildBankrEnvLines
// returns [] with no config, and the tavily/firecrawl/daytona lines are each
// `if (key)`-gated, so all of them are absent-not-empty when unset.
// This list is the UPSERT half. Removing a key the user cleared is the CLEAR
// half — see WEBUI_CLEARABLE_RUNTIME_ENV_KEYS below.
// On BANKR_AGENT_WITHDRAWAL_DESTINATION specifically: an earlier note here
// claimed a cleared destination would keep paying out to the old address. That
// is NOT reachable — both setters (api/instances/[id]/bankr-wallet/
// withdraw-destination and api/hivra/agents/[id]/bankr-wallet/set-destination)
// require a valid `0x…` EVM address via a non-optional zod regex, so a user can
// only RE-POINT a destination, never null one. Re-pointing lands via the upsert
// above. The destination leaves the box only with the rest of BANKR_*, through
// the per-run clear described on the clearable list below.
// Deliberately NOT listed:
//   - the provider/model keys (HERMES_INFERENCE_PROVIDER, OPENAI_BASE_URL, the
//     provider key var) — config.yaml owns provider/model and the update path
//     actively scrubs stale env pins; managing them here would fight that
//     contract.
//   - API_SERVER_KEY — NOT frozen, so nothing to fix: it is a compose
//     `environment:` entry, and the compose file is regenerated unconditionally
//     on every redeploy. It also has its own apiServerKey drift self-heal.
//   - HERMES_BROWSER_SIDECAR_AUTH_TOKEN — written to BOTH compose and
//     hermes.env, so the compose copy is already fresh each redeploy. It is
//     `p.webuiPassword` and emitted unconditionally, so listing it would rewrite
//     live auth material fleet-wide on every update to chase a stale copy the
//     sidecar tolerates by design (it runs warn-only when the token is unset).
export const WEBUI_MANAGED_RUNTIME_ENV_KEYS = [
  // The gateway supervisor loads persisted /state/.env with override semantics.
  // Re-pin the API-server bind contract or a legacy
  // API_SERVER_HOST=127.0.0.1 survives redeploy: Docker's localhost healthcheck
  // passes while the sibling dashboard gets connection refused forever.
  "API_SERVER_ENABLED",
  "API_SERVER_HOST",
  "API_SERVER_PORT",
  "TERMINAL_ENV",
  "TERMINAL_STRICT_BACKEND",
  "BROWSER_CDP_URL",
  "HERMES_BROWSER_SIDECAR_URL",
  "DAYTONA_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  ...WEBUI_BANKR_RUNTIME_ENV_KEYS,
];

// The CLEAR half of the managed-key contract. The repair above is upsert-only —
// it skips keys whose line is absent from the generated env — so CLEARING a key
// in the dashboard left the old value on the box forever. That is its own silent
// failure: the user hits Save, the API says 200, and the agent keeps using the
// secret they just deleted.
//
// Listing a key here means: "absent from the generated env => the user turned it
// off => delete it from /state/.env". THE ENTIRE SAFETY OF THAT RULE RESTS ON
// ABSENCE BEING UNAMBIGUOUS. So a key may only join this list when its value is
// derived from a PURE read of the already-fetched instance row
// (getRuntimeAgentSettings(instance.config)) — absent there genuinely means unset.
//
// BANKR_* (WEBUI_BANKR_RUNTIME_ENV_KEYS) is deliberately EXCLUDED from this static
// list, and the reason generalises. `[]` from buildBankrEnvLines means "no wallet",
// "nothing deliverable" OR "the wallet lookup just threw" — indistinguishable at
// this layer. Clearing on absence would erase live wallet credentials off every box
// that hit a transient DB hiccup during a fleet-wide redeploy. Absence must mean
// "the user cleared it", never "we failed to look it up".
// A user CAN now clear it: Disconnect on a wallet connected from the user's own
// Bankr account. So BANKR_* is cleared only by a per-run flag instead
// (WebUIDeployParams.bankrRuntimeReconcile, action "clear_user_disconnected"),
// which the orchestrator's resolveBankrRuntimeEnvPlanForUpdate() sets only after
// the lookup SUCCEEDED and found a revoked user-connected row, with every wallet
// address that row has delivered (its current one plus the earlier wallets it
// recorded when a reconnect replaced them, since a connect or disconnect can
// skip the restart). The update script then clears BANKR_* only from a file
// whose BANKR_AGENT_WALLET_ADDRESS is one of those addresses, so it removes only
// what the row's deliveries wrote, once: the flag stays set on every later
// update while the row stays revoked, but the address line is gone after the
// first clear, so a BANKR_API_KEY the user later sets for their own use is
// never touched. A
// lookup or decrypt failure, a missing row and every Hivra-provisioned row leave
// BANKR_* exactly as they are. A run delivering a user-connected wallet
// ("replace_user_connected") lists BANKR_* too: the pass skips every key that
// run delivers, so only a key the new wallet doesn't set (a replaced wallet's
// withdrawal destination) goes.
//
// BROWSER_CDP_URL is INCLUDED even though it fails the pure-read test above.
// That rule is a proxy for the thing that actually matters: absence must never be
// able to mean "the value is still correct but we failed to see it". BROWSER_CDP_URL
// can't hit that case. It is not a looked-up secret — it is a pointer to a sibling
// container, emitted by the same `agentBrowserCdpEnabled() && browserSidecarEnabled`
// expression that gates whether buildBrowserSidecarServiceBlock emits the container
// at all, in the SAME run off the SAME params. So the URL and its target cannot
// disagree, and every way the line goes absent leaves it pointing at nothing:
//   - user turned the sidecar off        -> no service in compose -> --remove-orphans
//                                           deletes the container.
//   - tier/RAM check said no this run    -> same: no service, same removal.
//   - HERMES_AGENT_BROWSER_CDP_ENABLED=false (the fleet-wide kill switch) -> the
//     container survives but CDP mode is meant to stop; keeping the URL is what
//     defeats the switch on already-provisioned boxes.
// The earlier note excluded it because absence is AMBIGUOUS (disabled vs. capacity).
// It is — but the ambiguity is irrelevant, because all three readings want the same
// action: drop it. Left behind, tools/browser_tool.py `_get_cdp_override()` reads it
// and connects over CDP to a container that no longer exists. The config.yaml merge
// the old note pointed at only touches the Vex `browser_sidecar` toolset list; it
// never clears this env pin, so nothing else was reconciling it.
//
// HERMES_BROWSER_SIDECAR_URL stays EXCLUDED — the symmetry is a trap. It is not
// omitted when the sidecar is off; it is only ever emitted (as the literal
// "disabled" sentinel) in CDP mode, so it goes absent on exactly the same runs as
// BROWSER_CDP_URL. But a STALE sentinel is already the correct end state: with no
// sidecar container, tools/browser_sidecar.py `_is_sidecar_available()` must fail so
// the toolset stays unregistered, and the sentinel makes it fail instantly on the
// missing URL scheme. Clearing it would hand the probe its _DEFAULT_URL
// (http://browser-sidecar:8789) and turn that instant failure into a real network
// probe on a 3s timeout for the same unregistered outcome. Nothing gained, startup
// latency lost. (The one case clearing WOULD help — kill switch off while the sidecar
// still runs, where the Vex HTTP tools should re-register — is a deliberate
// fleet-wide flip, not a user action, and is better handled there than by paying the
// probe on every sidecar-off box.)
export const WEBUI_CLEARABLE_RUNTIME_ENV_KEYS = [
  "BROWSER_CDP_URL",
  "DAYTONA_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
];

// Bootstrap precondition: every WebUI bootstrap script runs `docker run busybox`
// several times to fix volume ownership before `docker compose up`. The host-side
// `hermes-disk-cleanup` (and the inline volume-safe cleanup) runs
// `docker image prune -af --filter "until=24h"`, which evicts `busybox:latest`
// when no live container references it. After eviction the bootstrap re-pulls
// from Docker Hub, and 30+ tenants on one host share one outbound NAT IP — the
// unauthenticated 100/6h rate limit trips and the entire wave fails before
// `docker compose up` runs. We patch this defensively: prefer the cached image,
// pull only when missing, and if Docker Hub is unreachable retag an
// already-present GHCR/registry image as `busybox:latest`. node:22-alpine is
// part of every WebUI compose (dashboard-sidecar service) so it's guaranteed
// to be on the VM; alpine/caddy:2 are additional fallbacks for legacy layouts.
export function buildEnsureBusyboxAvailableScript(): string {
  return `# Make sure 'docker run busybox' below cannot fail on Docker Hub rate-limit.
if ! docker image inspect busybox >/dev/null 2>&1; then
  if ! docker image pull --quiet busybox >/dev/null 2>&1; then
    echo "[ensure-busybox] busybox pull from Docker Hub failed (likely rate-limited); retagging a cached image" >&2
    for hermes_busybox_fallback in node:22-alpine alpine caddy:2; do
      if docker image inspect "$hermes_busybox_fallback" >/dev/null 2>&1; then
        docker tag "$hermes_busybox_fallback" busybox:latest
        echo "[ensure-busybox] tagged $hermes_busybox_fallback as busybox:latest"
        break
      fi
    done
  fi
fi
`;
}

export function buildWebUIPersistentStatePermissionRepairCommand(containerName: string): string {
  return `# Repair WebUI persistent state cache ownership before container start.
# This preserves sessions/workspaces while fixing root-owned cache/tool dirs
# that can make the legacy init script crash-loop before /health ever serves.
docker run --rm -i -u 0:0 \\
  -v ${containerName}_webui-state:/state \\
  busybox sh <<'SH'
set -e
# Pre-create the gateway runtime dirs (hooks/audio_cache/image_cache/pairing)
# alongside the cache/tool dirs. On a FRESH (born-webfree) volume these don't
# exist yet, and the official-dashboard container — which shares this volume but
# runs as the image-default root (no user: directive) — would otherwise create
# them root:0 mode 700 when "hermes dashboard" first initializes HERMES_HOME.
# The gateway runs as uid 1024 and scandirs .hermes/hooks via
# gateway/hooks.py discover_and_load(); a root:700 hooks dir gives it
# PermissionError [Errno 13] -> the gateway exits and crash-loops, :8642 never
# binds, and the agent chat is dead while the static /webchat UI still 200s.
# Creating them here (owned by 1024 via the chown below) means root reuses them
# instead of minting them, so a born-webfree gateway never trips on them.
# See memory reference_webfree-blank-chat-triage (failure mode B).
mkdir -p /state /state/hermes-agent \\
  /state/hooks /state/audio_cache /state/image_cache /state/pairing \\
  /state/cache /state/cache/uv /state/cache/uv/tools /state/cache/pip /state/cache/npm /state/cache/yarn \\
  /state/uv/tools /state/npm /state/yarn/global /state/python /state/logs
touch /state/logs/errors.log /state/logs/agent.log
# Tolerate the SQLite WAL race (idle instances checkpoint *.db-wal/-shm away
# mid-recurse) so set -e doesn't abort state-permission repair before start.
chown -R 1024:1024 /state 2>/dev/null || true
chmod 755 /state /state/hermes-agent \\
  /state/hooks /state/audio_cache /state/image_cache /state/pairing \\
  /state/cache /state/cache/uv /state/cache/uv/tools \\
  /state/cache/pip /state/cache/npm /state/cache/yarn /state/uv /state/uv/tools \\
  /state/npm /state/yarn /state/yarn/global /state/python /state/logs
chmod 664 /state/logs/errors.log /state/logs/agent.log
chmod -R u+rwX,go+rX /state/cache /state/uv /state/npm /state/yarn /state/python
SH
`;
}

export function buildWebUIToolchainDiagnosticCommand(containerName: string): string {
  return `docker exec --user 1024 -i ${containerName} /bin/sh <<'SH'
set -e
export HOME=/home/hermes
export HERMES_HOME="${WEBUI_HERMES_HOME}"
missing_required=""
for required_bin in hermes hermes-cli git node npm; do
  if ! command -v "$required_bin" >/dev/null 2>&1; then
    missing_required="$missing_required $required_bin"
  fi
done
if [ -n "$missing_required" ]; then
  echo "[webui-toolchain-check] missing required commands:$missing_required" >&2
  echo "[webui-toolchain-check] PATH=$PATH" >&2
  if [ -n "\${HERMES_HOME:-}" ] && [ -f "$HERMES_HOME/.env" ]; then
    echo "[webui-toolchain-check] managed env excerpt from $HERMES_HOME/.env:" >&2
    sed -n '/^\\(PATH\\|PYTHONUSERBASE\\|PIP_CONFIG_FILE\\|PIP_CACHE_DIR\\|NPM_CONFIG_PREFIX\\|UV_TOOL_BIN_DIR\\)=/p' "$HERMES_HOME/.env" >&2 || true
  fi
  exit 127
fi

hermes_path="$(command -v hermes || true)"
resolved_hermes="$(readlink -f "$hermes_path" 2>/dev/null || printf "%s" "$hermes_path")"
if [ -x "${WEBUI_HERMES_VENV_BIN}" ] && [ "$resolved_hermes" != "${WEBUI_HERMES_VENV_BIN}" ]; then
  echo "[webui-hermes-cli-check] Hermes CLI shim should resolve to ${WEBUI_HERMES_VENV_BIN}, got \${resolved_hermes:-<empty>}" >&2
  echo "[webui-hermes-cli-check] hermes path=\${hermes_path:-<missing>}; PATH=$PATH" >&2
  exit 1
fi

if ! hermes --help >/tmp/hermes-cli-startup.log 2>&1; then
  echo "[webui-hermes-cli-check] Hermes CLI failed to start" >&2
  echo "[webui-hermes-cli-check] hermes path=\${hermes_path:-<missing>}" >&2
  echo "[webui-hermes-cli-check] resolved hermes=\${resolved_hermes:-<missing>}" >&2
  echo "[webui-hermes-cli-check] PATH=$PATH" >&2
  cat /tmp/hermes-cli-startup.log >&2 || true
  exit 1
fi

if [ -z "\${HERMES_HOME:-}" ]; then
  echo "[webui-log-writability-check] HERMES_HOME is unset; PATH=$PATH" >&2
  exit 1
fi

if ! mkdir -p "$HERMES_HOME/logs"; then
  echo "[webui-log-writability-check] cannot create Hermes log directory at $HERMES_HOME/logs" >&2
  ls -ld "$HERMES_HOME" "$HERMES_HOME/logs" >&2 || true
  exit 1
fi

if ! : >> "$HERMES_HOME/logs/errors.log"; then
  echo "[webui-log-writability-check] cannot write $HERMES_HOME/logs/errors.log" >&2
  ls -ld "$HERMES_HOME" "$HERMES_HOME/logs" >&2 || true
  ls -l "$HERMES_HOME/logs/errors.log" >&2 || true
  exit 1
fi

# Validate python -m site --user-base resolves into mounted WebUI state.
python_bin="$(command -v python3 || command -v python || true)"
if [ -z "$python_bin" ]; then
  echo "[webui-python-durability-check] python runtime not found; PATH=$PATH" >&2
  exit 127
fi

pip_bin="$(command -v pip || true)"
if [ "$pip_bin" != "${WEBUI_HERMES_HOME}/bin/pip" ]; then
  echo "[webui-python-durability-check] expected pip wrapper at ${WEBUI_HERMES_HOME}/bin/pip, got \${pip_bin:-<missing>}" >&2
  echo "[webui-python-durability-check] PATH=$PATH" >&2
  exit 127
fi

if [ "\${PYTHONUSERBASE:-}" != "${WEBUI_PYTHON_USER_BASE}" ]; then
  echo "[webui-python-durability-check] PYTHONUSERBASE must be ${WEBUI_PYTHON_USER_BASE}, got \${PYTHONUSERBASE:-<unset>}" >&2
  exit 1
fi

if [ "\${PIP_CONFIG_FILE:-}" != "${WEBUI_PIP_CONFIG_FILE}" ]; then
  echo "[webui-python-durability-check] PIP_CONFIG_FILE must be ${WEBUI_PIP_CONFIG_FILE}, got \${PIP_CONFIG_FILE:-<unset>}" >&2
  exit 1
fi

if [ ! -f "${WEBUI_PIP_CONFIG_FILE}" ]; then
  echo "[webui-python-durability-check] missing durable pip config at ${WEBUI_PIP_CONFIG_FILE}" >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]*user[[:space:]]*=[[:space:]]*true[[:space:]]*$' "${WEBUI_PIP_CONFIG_FILE}"; then
  echo "[webui-python-durability-check] ${WEBUI_PIP_CONFIG_FILE} must default pip installs to the durable user base" >&2
  sed -n '1,120p' "${WEBUI_PIP_CONFIG_FILE}" >&2 || true
  exit 1
fi

actual_user_base="$("$python_bin" -m site --user-base 2>/tmp/hermes-python-user-base.err || true)"
if [ "$actual_user_base" != "${WEBUI_PYTHON_USER_BASE}" ]; then
  echo "[webui-python-durability-check] python user base mismatch: expected ${WEBUI_PYTHON_USER_BASE}, got \${actual_user_base:-<empty>}" >&2
  cat /tmp/hermes-python-user-base.err >&2 || true
  "$python_bin" -m site >&2 || true
  exit 1
fi

actual_user_site="$("$python_bin" -m site --user-site 2>/tmp/hermes-python-user-site.err || true)"
case "$actual_user_site" in
  ${WEBUI_PYTHON_USER_BASE}/*) ;;
  *)
    echo "[webui-python-durability-check] python user site must live under ${WEBUI_PYTHON_USER_BASE}, got \${actual_user_site:-<empty>}" >&2
    cat /tmp/hermes-python-user-site.err >&2 || true
    "$python_bin" -m site >&2 || true
    exit 1
    ;;
esac

if ! "$python_bin" - <<'PY' >/tmp/hermes-python-user-site-enabled.log 2>&1
import site

if site.ENABLE_USER_SITE is not True:
    raise SystemExit(f"ENABLE_USER_SITE={site.ENABLE_USER_SITE!r}")
PY
then
  echo "[webui-python-durability-check] python user site is disabled" >&2
  cat /tmp/hermes-python-user-site-enabled.log >&2 || true
  "$python_bin" -m site >&2 || true
  exit 1
fi

if ! "$python_bin" -m pip --version >/tmp/hermes-python-pip-version.log 2>&1; then
  echo "[webui-python-durability-check] python -m pip is unavailable for the durable pip wrapper" >&2
  cat /tmp/hermes-python-pip-version.log >&2 || true
  exit 127
fi
SH`;
}

export function buildWebUIPersistentStateShimCommand(containerName: string): string {
  return `# Install durable Hermes CLI shims in the persisted WebUI PATH.
# /home/hermes/.local lives in the container layer and disappears
# when an image update recreates the container; /state/bin is the mounted
# webui-state volume and survives updates.
docker run --rm -i \\
  -v ${containerName}_webui-state:/state \\
  -v ${containerName}_agent-source:/agent-source:ro \\
  busybox sh <<'SH'
set -e
target="${WEBUI_HERMES_VENV_BIN}"
if [ ! -x /agent-source/.venv/bin/hermes ]; then
  target="${WEBUI_HERMES_SOURCE_BIN}"
  test -x /agent-source/hermes
fi
mkdir -p /state/bin
ln -sfn "$target" /state/bin/hermes
ln -sfn "$target" /state/bin/hermes-cli

# Install durable Python package-manager shims and log files. This keeps natural
# "pip install ..." behavior on the mounted /home/hermes/.hermes
# volume instead of the container-owned /usr/local site-packages path.
mkdir -p /state/bin /state/logs /state/cache/pip /state/python
touch /state/logs/errors.log /state/logs/agent.log
cat > /state/pip.conf <<'PIP_CONF'
[global]
cache-dir = ${WEBUI_HERMES_HOME}/cache/pip
disable-pip-version-check = true

[install]
user = true
PIP_CONF
cat > /state/bin/pip <<'PIP_SH'
#!/bin/sh
set -e
export PYTHONUSERBASE="\${PYTHONUSERBASE:-${WEBUI_PYTHON_USER_BASE}}"
export PIP_CONFIG_FILE="\${PIP_CONFIG_FILE:-${WEBUI_PIP_CONFIG_FILE}}"
export PIP_CACHE_DIR="\${PIP_CACHE_DIR:-${WEBUI_HERMES_HOME}/cache/pip}"
python_bin="$(command -v python3 || command -v python || true)"
if [ -z "$python_bin" ]; then
  echo "[webui-python-install] python runtime not found; PATH=$PATH" >&2
  exit 127
fi
exec "$python_bin" -m pip "$@"
PIP_SH
chmod 755 /state/bin/pip
ln -sfn pip /state/bin/pip3
chown -R 1024:1024 /state/bin /state/logs /state/cache /state/python /state/pip.conf
chmod 755 /state/logs
chmod 664 /state/logs/errors.log /state/logs/agent.log
chown -h 1024:1024 /state/bin/hermes /state/bin/hermes-cli /state/bin/pip3 2>/dev/null || true
SH
`;
}

export function buildWebUIContainerCliShimCommand(containerName: string): string {
  return `docker exec --user 1024 ${containerName} sh -lc 'set -e; export HOME=/home/hermes; export HERMES_HOME="${WEBUI_HERMES_HOME}"; mkdir -p "$HOME/.local/bin"; target="${WEBUI_HERMES_VENV_BIN}"; if [ ! -x "$target" ]; then target="${WEBUI_HERMES_SOURCE_BIN}"; test -x "$target"; fi; ln -sfn "$target" "$HOME/.local/bin/hermes"; ln -sfn "$target" "$HOME/.local/bin/hermes-cli"'
`;
}

// Symlink the Hermes CLI into /usr/local/bin so it resolves on the DEFAULT
// system PATH, not just the managed WebUI runtime PATH.
//
// The agent's terminal tool (vanilla-hermes-agent tools/environments/local.py)
// runs each shell turn through a *login-shell snapshot*: it sources the stock
// rc files and the captured PATH is the system default
// (/usr/local/bin:/usr/bin:/bin), which does NOT include
// /home/hermes/.hermes/bin or ~/.local/bin where the other Hermes CLI shims
// live. So `hermes ...` typed in an agent shell turn returned
// "hermes: command not found" even though the binary exists and resolves fine
// for the managed-PATH healthchecks. /usr/local/bin is on every login-shell
// PATH (and on the agent's _SANE_PATH fallback), so a symlink there is reachable
// from any agent shell regardless of how its PATH was constructed.
//
// Runs as root (uid 1024 cannot write /usr/local/bin) and is guarded on the
// container running + best-effort, so the update path — which only
// force-recreates the webui container and may catch the gateway mid-restart —
// never fails the deploy on this convenience shim. Call it for BOTH the webui
// container and the -gateway container: the agent that owns the terminal tool
// runs `hermes gateway run` inside the gateway, so that's where the shim matters
// most.
export function buildWebUIUsrLocalHermesShimCommand(containerName: string): string {
  return `if docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null | grep -qx true; then
  docker exec --user 0 ${containerName} sh -lc 'set -e; target="${WEBUI_HERMES_VENV_BIN}"; if [ ! -x "$target" ]; then target="${WEBUI_HERMES_SOURCE_BIN}"; fi; if [ ! -x "$target" ]; then echo "[webui-usrlocal-shim] no hermes binary at $target" >&2; exit 1; fi; ln -sfn "$target" /usr/local/bin/hermes; ln -sfn "$target" /usr/local/bin/hermes-cli' \\
    || echo "[webui-usrlocal-shim] WARN: failed to install /usr/local/bin hermes shim in ${containerName}" >&2
fi
`;
}

export function buildWebUIHermesPythonRuntimeCommand(containerName: string): string {
  // The Hermes Agent image (Debian 13 trixie) bakes a virtualenv whose
  // bin/python symlinks resolve to /usr/bin/python3 → /usr/bin/python3.13.
  // The WebUI image ships its own bundled Python 3.12 at /usr/local/bin/
  // python3 but lacks /usr/bin/python3 entirely, so when the persistent
  // state shim points hermes at the agent .venv binary the kernel reads
  // its shebang, follows the symlink chain to /usr/bin/python3, finds no
  // such file, and exits with "cannot execute: required file not found"
  // before any hermes subcommand (auth add, gateway run, etc.) can run.
  // Installing python3 from Debian trixie's main repo lands python 3.13
  // at /usr/bin/python3.13 and creates the /usr/bin/python3 symlink that
  // the agent venv expects.
  return `# Install the Python 3.13 interpreter expected by the agent venv.
docker exec --user 0 -i ${containerName} /bin/sh <<'SH'
set -e
if [ -x /usr/bin/python3 ]; then
  resolved="$(readlink -f /usr/bin/python3 2>/dev/null || true)"
  case "$resolved" in
    *python3.13*) exit 0 ;;
  esac
fi
echo "[webui-hermes-python-runtime] installing python3 for hermes-agent venv" >&2
if ! command -v apt-get >/dev/null 2>&1; then
  echo "[webui-hermes-python-runtime] apt-get unavailable; PATH=$PATH" >&2
  exit 127
fi
export DEBIAN_FRONTEND=noninteractive
if ! apt-get update >/tmp/hermes-webui-python-apt.log 2>&1; then
  echo "[webui-hermes-python-runtime] apt-get update failed" >&2
  cat /tmp/hermes-webui-python-apt.log >&2 || true
  exit 1
fi
if ! apt-get install -y --no-install-recommends python3 >/tmp/hermes-webui-python-apt.log 2>&1; then
  echo "[webui-hermes-python-runtime] apt-get install python3 failed" >&2
  cat /tmp/hermes-webui-python-apt.log >&2 || true
  exit 1
fi
if [ ! -x /usr/bin/python3 ]; then
  echo "[webui-hermes-python-runtime] /usr/bin/python3 missing after apt-get install" >&2
  exit 127
fi
SH`;
}

export function buildWebUIDeveloperToolBootstrapCommand(containerName: string): string {
  return `# Install WebUI developer tools inside recreated container.
docker exec --user 0 -i ${containerName} /bin/sh <<'SH'
set -e
missing_before=""
for required_bin in git node npm; do
  if ! command -v "$required_bin" >/dev/null 2>&1; then
    missing_before="$missing_before $required_bin"
  fi
done
if [ -z "$missing_before" ]; then
  exit 0
fi
echo "[webui-toolchain-bootstrap] installing missing developer tools:$missing_before" >&2
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  if ! apt-get update >/tmp/hermes-webui-toolchain-apt.log 2>&1; then
    echo "[webui-toolchain-bootstrap] apt-get update failed" >&2
    cat /tmp/hermes-webui-toolchain-apt.log >&2 || true
    exit 1
  fi
  if ! apt-get install -y --no-install-recommends git nodejs npm ca-certificates >/tmp/hermes-webui-toolchain-apt.log 2>&1; then
    echo "[webui-toolchain-bootstrap] apt-get install failed" >&2
    cat /tmp/hermes-webui-toolchain-apt.log >&2 || true
    exit 1
  fi
elif command -v apk >/dev/null 2>&1; then
  if ! apk add --no-cache git nodejs npm ca-certificates >/tmp/hermes-webui-toolchain-apk.log 2>&1; then
    echo "[webui-toolchain-bootstrap] apk add failed" >&2
    cat /tmp/hermes-webui-toolchain-apk.log >&2 || true
    exit 1
  fi
else
  echo "[webui-toolchain-bootstrap] no supported package manager; PATH=$PATH" >&2
  exit 127
fi
missing_after=""
for required_bin in git node npm; do
  if ! command -v "$required_bin" >/dev/null 2>&1; then
    missing_after="$missing_after $required_bin"
  fi
done
if [ -n "$missing_after" ]; then
  echo "[webui-toolchain-bootstrap] missing after install:$missing_after" >&2
  echo "[webui-toolchain-bootstrap] PATH=$PATH" >&2
  exit 127
fi
SH`;
}
