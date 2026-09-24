// Hetzner instance provisioning — WebUI mode.
//
// Sibling of hetzner-instance-builders.ts but drastically simplified:
// hermes-webui replaces the legacy `agent` chat/API container. The official
// upstream Hermes dashboard still runs as a sibling service so the browser
// handoff opens the real `hermes dashboard` UI instead of the custom WebUI app.
//
// Activated when `INSTANCE_BACKEND=webui` env is set OR the `instances.backend`
// Supabase column is "webui" for a given instance. The legacy gateway path is
// untouched in hetzner-instance-builders.ts.
//
// What's intentionally NOT here (vs the legacy builder):
//   - PATCH-001 `agent-web` dashboard overlay (official dashboard is separate)
//   - Profile-port range 8650-8670 (WebUI handles profiles internally)
//   - Separate API server credentials (the gateway health API reuses webuiPassword)
//   - PATCH-001 dashboard overlay routes
//   - Memory overlays / honcho / hindsight (TBD — add back when needed)

import "server-only";

import type { InstanceBankrAgentConfig } from "@/lib/billing/bankr-instance-wallets";
import {
  getAgentContainerCandidates,
  runtimeComposeServiceExpr,
} from "@/lib/services/agent-container";
import {
  buildHostCaddyReloadScript,
  buildHostTimeSyncRepairScript,
  buildSslipPlaceholderResolutionScript,
} from "@/lib/services/hetzner-instance-builders";
import { SIDECAR_SERVER_CODE, WEBUI_HANDOFF_APPENDAGE } from "@/lib/services/sidecar-script";
import {
  buildWebUISignalDaemonScript,
  WEBUI_SIGNAL_DAEMON_CONTAINER_PATH,
} from "@/lib/services/webui-signal-daemon";
import { buildCodexHermesAuthStore, type CodexVaultBundle } from "@/lib/codex-oauth";
import { deriveBrowserVncPassword } from "@/lib/browser-vnc";
import { deploymentScopedDefault } from "@/lib/deployment-channel";
import { buildWebUIDefaultModel } from "@/lib/webui/profiles";
import {
  buildEnsureBusyboxAvailableScript,
  buildWebUIContainerCliShimCommand,
  buildWebUIDeveloperToolBootstrapCommand,
  buildWebUIHermesPythonRuntimeCommand,
  buildWebUIPersistentStatePermissionRepairCommand,
  buildWebUIPersistentStateShimCommand,
  buildWebUIToolchainDiagnosticCommand,
  buildWebUIUsrLocalHermesShimCommand,
  WEBUI_HERMES_AGENT_DIR,
  WEBUI_HERMES_WRITE_SAFE_ROOTS,
  WEBUI_BANKR_RUNTIME_ENV_KEYS,
  WEBUI_CLEARABLE_RUNTIME_ENV_KEYS,
  WEBUI_MANAGED_RUNTIME_ENV_KEYS,
  WEBUI_PERSISTENT_INSTALL_ENV_KEYS,
  WEBUI_PERSISTENT_INSTALL_ENV_LINES,
} from "@/lib/services/webui-runtime-env";
import { PROVIDER_ID_MAP, resolveProviderBaseUrl } from "@/lib/services/provider-config";
import { ONBOARDING_RITUAL } from "@/lib/onboarding-ritual";
import {
  isOperatorosAgentImage,
  OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH,
} from "@/lib/operatoros-flavor";
import { FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN } from "@/lib/webui/soul-guard";
import { createHash } from "crypto";
import {
  resolveWebUITerminalBackend,
  WEBUI_TERMINAL_CONFIG_SYNC_PYTHON,
} from "@/lib/services/webui-terminal-config";
import {
  buildWebUIWsOrphanReapConfigYaml,
  buildWebUIWsOrphanReapRepairCommand,
  WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX,
} from "@/lib/services/webui-session-retention";

// Username for the official-dashboard's bundled "basic" password provider. The
// June-2026 agent-image hardening gates every non-loopback dashboard bind and
// FAILS CLOSED with no auth provider registered, so a webfree box must enable
// one or official-dashboard crash-loops. The dashboard-sidecar logs in
// headlessly with this username + the per-instance API_SERVER_KEY (= webuiPassword)
// as the password (POST /auth/password-login) and forwards the resulting gated
// session upstream, so the token-only SPA keeps working without exposing an
// unauthenticated public dashboard. A fixed username — the password is the
// secret. See reference_hardened_dashboard_auth_contract.
const DASHBOARD_BASIC_AUTH_USERNAME = "hivra";

// Stable token-signing secret for the basic provider, derived from the
// per-instance webuiPassword so the provider mints restart-stable sessions
// (otherwise it generates a random per-process secret and every dashboard
// restart invalidates the sidecar's cached session). Distinct from the password
// via a domain tag so the two are never the same bytes.
function deriveDashboardBasicAuthSecret(webuiPassword: string): string {
  return createHash("sha256")
    .update(`${webuiPassword}:hermes-dashboard-basic-auth`)
    .digest("hex");
}

// The four env vars the bundled "basic" password provider reads at startup
// (register(ctx) reads them once, at process start). Emitted BOTH inline into
// the compose `environment:` blocks (gateway + official-dashboard) AND into the
// compose .env (via buildWebUIComposeEnv). The inline copy is authoritative as
// DEFENCE-IN-DEPTH: compose `environment:` overrides `env_file`, and no writer
// of the instance-dir .env touches docker-compose.yml, so the provider stays
// registered no matter what rewrites .env. That matters because .env is a
// contested file: the dashboard's own update path overwrites it with the agent
// runtime env on every redeploy (this was the true cause of the fleet-wide
// /desktop cookie-lane strip of 2026-07 — NOT an "overlay", an earlier version
// of this comment misattributed it; fixed at source by re-seeding the generated
// compose env in canary #542 / prod #602), and an out-of-band host secrets-sync
// overlay MAY rewrite it too (unverified — never confirmed in code; see the
// corrected memory). Since #542/#602 already keep the .env copy correct, this
// inline copy is not load-bearing for that path — it earns its place because
// this is per-instance auth material and belongs at the strongest durability
// tier, immune to any future .env writer. No extra secret is exposed: PASSWORD
// is the per-instance webuiPassword, already inline in compose as API_SERVER_KEY
// et al. See project_dashboard_basicauth_env_overlay_strip (root cause
// corrected) and reference_hardened_dashboard_auth_contract.
function dashboardBasicAuthEnvLines(webuiPassword: string): string[] {
  return [
    `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${DASHBOARD_BASIC_AUTH_USERNAME}`,
    `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${webuiPassword}`,
    `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${deriveDashboardBasicAuthSecret(webuiPassword)}`,
    `HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS=43200`,
  ];
}

const DEFAULT_WEBUI_IMAGE = "ghcr.io/ashneil12/hermes-webui:stable";
// Update mode defaults to the floating :stable tag so a new push rolls out
// without a dashboard redeploy. Provision mode can use
// HERMES_WEBUI_AGENT_PROVISION_IMAGE to point at a template-baked image while
// HERMES_WEBUI_AGENT_UPDATE_IMAGE keeps updates on the moving tag.
const DEFAULT_AGENT_IMAGE = "ghcr.io/ashneil12/vanilla-hermes-agent:stable";
const WEBUI_INTERNAL_PORT = 8787;
/**
 * How long the agent parks a blocked dangerous-command approval before it gives
 * up and unwinds as denied (`approvals.gateway_timeout` in the box config.yaml).
 *
 * The agent's own code default is 300s, which is useless in the hosted product:
 * the approval is only visible inside the workspace iframe, so an owner who is
 * anywhere else has five minutes to notice. One hour, paired with the
 * hivra_approval_relay push notification, is a window a human can actually act in.
 *
 * Lower this back toward 300 if parked agents start distorting capacity
 * accounting — the relay still works at any value.
 */
const WEBUI_APPROVAL_GATEWAY_TIMEOUT_SECONDS = 3600;
// NOTE: The legacy chat-durability sidecar (was: "python -m sidecar" on
// port 8788) was removed from the WebUI fork — the sidecar/ directory
// no longer ships in the image, so the container crashlooped on every
// VM with "No module named sidecar". The dashboard's iframe surface
// talks to WebUI directly and does not depend on cursor-resumable SSE,
// so the service and its Caddyfile route are no longer emitted. The
// dashboard-side chat-jobs probes in lib/webui/client.ts will fall
// back gracefully when the sidecar 404s.

// Browser sidecar (services/browser-sidecar) — Pro-tier-gated, opt-in. Runs a
// persistent Playwright/Chromium context the agent drives via HTTP. Only
// emitted when (a) the user opted in via instance settings AND (b) the caller
// has resolved their tier as operator/fleet/command. Not emitted otherwise so
// free-tier VMs do not incur the ~1GB RAM footprint.
const BROWSER_SIDECAR_INTERNAL_PORT = 8789;
const BROWSER_SIDECAR_NOVNC_PORT = 6080;
// Prod and canary publish separate browser-sidecar packages. Override via
// HERMES_BROWSER_SIDECAR_IMAGE when a deployment needs an emergency pin.
const BROWSER_SIDECAR_PROD_IMAGE = "ghcr.io/ashneil12/hermes-browser-sidecar:stable";
const BROWSER_SIDECAR_CANARY_IMAGE =
  "ghcr.io/ashneil12/hermes-browser-sidecar-canary:stable";

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() ? v : fallback;
}

function resolveBrowserSidecarDefaultImage(): string {
  return deploymentScopedDefault({
    production: BROWSER_SIDECAR_PROD_IMAGE,
    canary: BROWSER_SIDECAR_CANARY_IMAGE,
  });
}

// Agent↔sidecar CDP bridge. The browser sidecar runs a PERSISTENT CDP Chromium
// on its noVNC display and the Hermes agent's generic `browser` toolset is
// pointed at it (BROWSER_CDP_URL) — so the browser the agent drives is exactly
// the one the live view shows, matching the Claude/Codex boxes. This is now the
// standard for every sidecar-enabled instance (prod + canary): both images build
// from services/browser-sidecar/Dockerfile, which bakes Chromium + the CDP proxy
// (docker/cdp-proxy.mjs), so neither is handed a dead BROWSER_CDP_URL.
const AGENT_CDP_PORT = 9223;
// Chrome binds 127.0.0.1 only + rejects non-localhost Host headers, so the agent
// (a sibling container) reaches CDP through a Host-rewriting proxy on this port.
const AGENT_CDP_PROXY_PORT = 9224;
// A BANKR_AGENT_WALLET_ADDRESS value the update script may compare against.
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
function agentBrowserCdpEnabled(): boolean {
  // Default ON. The sidecar's entrypoint runtime-gates the Chrome supervisor on
  // AGENT_CDP_ENABLED, so this only does anything where the sidecar is itself
  // enabled (Pro+ instances). Set HERMES_AGENT_BROWSER_CDP_ENABLED=false as a
  // kill switch if the CDP browser ever needs to be disabled fleet-wide.
  return env("HERMES_AGENT_BROWSER_CDP_ENABLED", "true") !== "false";
}

function managedVeniceDashboardUrl(wallet: "hermesos" | "card" = "hermesos"): string {
  const appBase = env("NEXT_PUBLIC_APP_URL", "https://hivra.cloud").replace(/\/+$/, "");
  return `${appBase}/dashboard/billing?managedVenice=deposit&wallet=${encodeURIComponent(wallet)}`;
}

function isHermesManagedVeniceEndpoint(p: WebUIDeployParams): boolean {
  return (
    p.dashboardProvider === "venice" &&
    p.inferenceProvider === "custom" &&
    typeof p.baseUrl === "string" &&
    p.baseUrl.includes("/api/managed-venice/v1")
  );
}

// Re-derive a managed-Venice proxy URL (`/api/managed-venice/...`) — or an
// `hven_` proxy key's URL — from the LIVE dashboard domain so a (re)deploy can
// never re-bake a stale pre-rebrand host (e.g. hermesos.cloud) that now 301s and
// silently kills inference. Genuine BYO/custom endpoints pass through unchanged.
// Mirrors resolveProviderBaseUrl's pinning so the on-VM .env matches what the
// dashboard's live API resolves to.
function pinManagedVeniceBaseUrl(baseUrl: string, apiKey?: string): string {
  if (baseUrl.includes("/api/managed-venice/")) {
    return resolveProviderBaseUrl("venice", baseUrl, apiKey) ?? baseUrl;
  }
  return baseUrl;
}

function resolveWebUIVeniceBaseUrl(p: WebUIDeployParams): string | null {
  const baseUrl = p.baseUrl?.trim() || "";
  if (p.dashboardProvider === "venice" || p.inferenceProvider === "venice") {
    // Route through resolveProviderBaseUrl so a managed `hven_` key or a stale
    // `/api/managed-venice/` URL is pinned to the LIVE proxy on every redeploy;
    // a genuine BYO Venice URL/key passes through (or falls back to the direct
    // api.venice.ai when no URL is stored). Returning the stored baseUrl
    // verbatim is what re-baked dead hermesos.cloud into managed boxes.
    return resolveProviderBaseUrl("venice", baseUrl || undefined, p.llmApiKey);
  }
  if (baseUrl.includes("api.venice.ai") || baseUrl.includes("/api/managed-venice/v1")) {
    return pinManagedVeniceBaseUrl(baseUrl, p.llmApiKey);
  }
  return null;
}

function buildWebUIVeniceNativeEnvLines(p: WebUIDeployParams): string[] {
  const baseUrl = resolveWebUIVeniceBaseUrl(p);
  if (!baseUrl || !p.llmApiKey) {
    return [];
  }
  return [`VENICE_API_KEY=${p.llmApiKey}`, `VENICE_BASE_URL=${baseUrl}`];
}

export interface WebUIDeployParams {
  instanceId: string;
  containerName: string;
  fqdn: string;
  cpuLimit?: number;
  ramLimit?: number;
  /**
   * RAM burst ceiling (MB) for the agent-bearing containers' cgroup memory
   * limit. When set above `ramLimit`, the gateway (where the agent runs) and the
   * official-dashboard surface are allowed up to this much RAM so the guest can
   * use burst headroom; the VM itself boots at the same ceiling. Absent / ≤
   * ramLimit → the limit stays at ramLimit (legacy behaviour, no overcommit).
   */
  ramBurstMb?: number;
  /**
   * Give the gateway root-equivalent control of the Docker daemon inside its
   * guest. This is safe only for a dedicated, single-tenant VM: mounting a
   * shared host socket would let one tenant control every container there.
   * Callers must prove that isolation boundary; the default is fail-closed.
   */
  gatewayDockerAccess?: boolean;
  /**
   * Execution backend selected in the dashboard's advanced configuration.
   * Docker is only effective when this deployment also proves a dedicated VM
   * and enables gatewayDockerAccess; Daytona additionally requires its key.
   */
  terminalBackend?: "local" | "docker" | "modal" | "daytona";
  /** OpenRouter / OpenAI-compat key passed through to hermes-agent */
  llmApiKey: string;
  /** "openrouter" | "openai" | "anthropic" | etc. */
  inferenceProvider: string;
  /** e.g. "kimi-k2.5", "claude-sonnet-4-6" */
  defaultModel: string;
  /**
   * Dashboard provider id selected by the user (e.g. "crof", "venice",
   * "codex"). This can differ from inferenceProvider because hermes-agent
   * collapses OpenAI-compatible providers to "custom"; WebUI still needs the
   * dashboard provider to seed the visible model picker correctly.
   */
  dashboardProvider?: string | null;
  /** Custom OpenAI-compatible base URL (e.g. https://crof.ai/v1) */
  baseUrl?: string;
  /**
   * Auxiliary "cheap" model for context summarization / compaction, emitted as
   * config.yaml `auxiliary.compression.{provider,model}`. compressionProvider is
   * a dashboard provider id (collapsed to the runtime provider via PROVIDER_ID_MAP
   * on emit); empty/absent provider falls back to the main model's provider.
   * An empty/absent model means "inherit the main model" — nothing is emitted.
   */
  compressionProvider?: string | null;
  compressionModel?: string | null;
  /**
   * Context engine: "compressor" (default) or "sliding" (streaming engine).
   * Emitted as config.yaml `context.engine` only when set; absent leaves the
   * agent on its own default.
   */
  contextEngine?: "compressor" | "sliding" | null;
  /** Per-instance password protecting the WebUI HTTP API */
  webuiPassword: string;
  /** Optional Tavily/Firecrawl/etc. */
  tavilyApiKey?: string;
  /** BYO Daytona cloud-sandbox key -> DAYTONA_API_KEY in the box .env. */
  daytonaApiKey?: string;
  firecrawlApiKey?: string;
  /** Override image, e.g. for canary tags */
  image?: string;
  /** Explicit agent runtime image used only to seed hermes-agent source for WebUI. */
  agentImage?: string;
  /** Reusable Codex OAuth bundle, written as hermes-agent auth.json. */
  codexAuthBundle?: CodexVaultBundle;
  /** Per-agent Bankr wallet, written transiently into VM config/env only. */
  bankr?: InstanceBankrAgentConfig | null;
  /**
   * Update mode only. Set by the orchestrator only when the wallet lookup
   * definitively resolved to a user-connected wallet. `walletAddresses` is
   * every wallet address that row has delivered: the current one, each
   * earlier wallet from the user's own Bankr account a reconnect replaced, and
   * a Hivra-created wallet a switch replaced. A connect or disconnect can skip
   * the restart, so the box may still hold any of them. The script changes a
   * file's BANKR_* only when the file's BANKR_AGENT_WALLET_ADDRESS is in this
   * set, and never touches a file holding any other address (it may be the
   * user's own configuration).
   * - "clear_user_disconnected" (with `bankr` null): the user disconnected the
   *   wallet. /state/.env's BANKR_* and config.yaml's `bankr:` blocks go only
   *   when /state/.env holds an address in the set, and each cloned profile
   *   .env holding one loses its BANKR_* lines. The first clear removes the
   *   address lines, so every later run while the row stays revoked changes
   *   nothing, including BANKR_* values the user sets afterwards for their
   *   own use.
   * - "replace_user_connected" (with `bankr` set): BANKR_* is upserted into
   *   /state/.env, any BANKR_* key the new wallet doesn't set (a replaced
   *   wallet's withdrawal destination) is dropped, the `bankr:` block is
   *   stripped (the agent copies it over BANKR_* on every config load and it
   *   can hold an older key), and each cloned profile .env holding an address
   *   in the set (the delivered one included: a new key for the same wallet
   *   replaces the old one) loses its BANKR_* lines, so the profile falls
   *   back to the container env this run delivers.
   * Absent (every Hivra-provisioned wallet, no wallet, a failed lookup) the
   * script is unchanged.
   */
  bankrRuntimeReconcile?:
    | { action: "clear_user_disconnected"; walletAddresses: readonly string[] }
    | { action: "replace_user_connected"; walletAddresses: readonly string[] };
  /**
   * Pro-tier-gated. If true, the docker-compose includes a `browser-sidecar`
   * service running the deterministic Playwright HTTP API. Caller is
   * responsible for verifying the user's tier qualifies — this builder does
   * not re-check; it just renders.
   */
  browserSidecarEnabled?: boolean;
  /**
   * User-facing agent name from the deploy form. Forwarded into the WebUI
   * container as `HERMES_WEBUI_BOT_NAME` so the "Assistant Name" preference
   * (Settings → Preferences) defaults to the name the user picked for the
   * agent, instead of the generic "Hermes" fallback.
   */
  agentName?: string | null;
  /**
   * Clean-slate BYOK deploy (deploy-card "Managed (Venice)? = OFF"). When true,
   * the box ships with NO inference provider, NO key, and NO model seeded — the
   * agent boots unconfigured so its NATIVE onboarding overlay fires
   * (setup.status → provider_configured=false) and the user connects a provider
   * / pastes a key AFTER the box is up. This deliberately avoids seeding a
   * half-configured provider with no key (the keyless-provider init brick).
   * provider/model/apiKey on this params object are unused when set.
   */
  unconfigured?: boolean;
  /**
   * Full authored persona soul (welcome persona picks: Bea/Sloane/…), resolved
   * by the caller via resolvePersonaSoulFromSystemPrompt from the instance's
   * stored agentSettings.systemPrompt. When set, a fresh provision seeds THIS
   * verbatim as the box's SOUL.md instead of the who-am-I onboarding ritual —
   * the box boots AS the persona the user hired rather than inventing a new
   * identity over it. Null/absent → existing ritual behavior (custom personas,
   * no-persona deploys: the zero-regression contract).
   */
  personaSoulPrompt?: string | null;
}

export interface WebUIProvisioningArtifacts {
  composeYaml: string;
  caddyfile: string;
  sidecarServerFile: string;
  signalDaemonFile: string;
  envFile: string;
  configYaml: string;
  hermesEnvFile: string;
  authStoreFile?: string;
}

type WebUIAgentImageMode = "provision" | "update";

function resolveWebUIAgentImage(
  p: WebUIDeployParams,
  mode: WebUIAgentImageMode = "provision"
): string {
  const sharedImage = env("HERMES_WEBUI_AGENT_IMAGE", DEFAULT_AGENT_IMAGE);
  const modeSpecificKey =
    mode === "update" ? "HERMES_WEBUI_AGENT_UPDATE_IMAGE" : "HERMES_WEBUI_AGENT_PROVISION_IMAGE";
  const resolved = p.agentImage || env(modeSpecificKey, sharedImage);

  // Operator OS remains lifecycle compatibility only. An already-existing row
  // may carry its exact pinned image into an update, but no fresh provision may
  // acquire the withheld runtime through an explicit parameter or an
  // environment override. Keep this guard at the shared image resolver so all
  // fresh Proxmox, Hetzner and generated-artifact paths fail closed together.
  if (mode === "provision" && isOperatorosAgentImage(resolved)) {
    throw new Error(
      "New Operator OS provisioning is unavailable until its complete runtime source and release evidence are public."
    );
  }

  return resolved;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildHermesDockerImageCleanupFunctions(): string {
  return `prune_dangling_docker_images() {
  # Docker's time-based image-prune filters have returned 0B reclaimed on
  # Hermes guests while dangling image IDs still existed. Remove explicit
  # dangling image IDs instead; no --volumes, no --force, so running
  # containers and user data remain protected by Docker itself.
  docker image ls -a --filter dangling=true -q 2>/dev/null | sort -u | while IFS= read -r image_id; do
    [ -n "$image_id" ] || continue
    docker image rm "$image_id" 2>/dev/null || true
  done
}
`;
}

export function buildHermesTaggedImageCleanupFunctions(): string {
  return `prune_old_unused_hermes_repo_images() {
  repo="$1"
  [ -n "$repo" ] || return 0
  cutoff_epoch="$(date -u -d '24 hours ago' +%s 2>/dev/null || echo 0)"
  [ "$cutoff_epoch" -gt 0 ] || return 0

  used_image_ids="$(docker ps -a --format '{{.Image}}' | while IFS= read -r container_image; do
    [ -n "$container_image" ] || continue
    docker image inspect "$container_image" --format '{{.Id}}' 2>/dev/null || true
  done | sort -u)"

  docker image ls "$repo" --format '{{.ID}} {{.Repository}}:{{.Tag}}' 2>/dev/null | while read -r image_id image_ref; do
    case "$image_ref" in
      *:hermes-last-known-good) continue ;;
    esac
    [ -n "$image_id" ] || continue
    if printf '%s\\n' "$used_image_ids" | grep -qx "$image_id"; then
      continue
    fi
    created="$(docker image inspect "$image_id" --format '{{.Created}}' 2>/dev/null || true)"
    created_epoch="$(date -u -d "$created" +%s 2>/dev/null || echo 0)"
    if [ "$created_epoch" -gt 0 ] && [ "$created_epoch" -lt "$cutoff_epoch" ]; then
      case "$image_ref" in
        *:"<none>"|"<none>":*) docker image rm "$image_id" 2>/dev/null || true ;;
        *) docker image rm "$image_ref" 2>/dev/null || true ;;
      esac
    fi
  done
}

prune_old_unused_hermes_agent_images() {
  for repo in 'ghcr.io/ashneil12/vanilla-hermes-agent' 'ghcr.io/ashneil12/vanilla-hermes-agent-canary' 'ghcr.io/ashneil12/hermes-webui' 'ghcr.io/ashneil12/operatoros-box' 'ghcr.io/ashneil12/browser-sidecar'; do
    prune_old_unused_hermes_repo_images "$repo"
  done
}
`;
}

// Reclaims the Chrome HTTP/GPU/service-worker cache that the browser-sidecar
// piles up inside each `*_browser-state` volume. That cache (profiles/<id>/...)
// is the dominant disk hog on heavy/long-lived browser tenants and is what fills
// a 29GB VM disk -> the next image pull partial-extracts -> exit-127 crash-loop.
// Pruning ONLY the rebuildable cache subdirs leaves the persistent profile
// (cookies/logins/IndexedDB) intact; Chrome rebuilds the cache on demand. The
// sidecar image also self-bounds via --disk-cache-size + pruneProfileCache; this
// is the host-side backstop for boxes whose disk fills from any cause.
// See finding_browser_sidecar_bloat_root_cause.
export function buildHermesBrowserSidecarCacheCleanupFunction(): string {
  return `prune_browser_sidecar_cache() {
  freed=0
  for vol_data in /var/lib/docker/volumes/*_browser-state/_data; do
    [ -d "\$vol_data/profiles" ] || continue
    for cname in Cache "Code Cache" GPUCache ShaderCache GrShaderCache DawnGraphiteCache DawnWebGPUCache CacheStorage ScriptCache component_crx_cache; do
      find "\$vol_data/profiles" -mindepth 1 -maxdepth 6 -type d -name "\$cname" -prune -exec rm -rf {} + 2>/dev/null && freed=1
    done
  done
  [ "\$freed" = "1" ] && echo "[browser-cache-cleanup] pruned browser-sidecar Chrome cache subdirs" || true
}
`;
}

export function buildHermesVolumeSafeUpdateCleanupFunctions(): string {
  return `${buildHermesBrowserSidecarCacheCleanupFunction()}
prune_official_dashboard_ephemeral_tool_envs() {
  # The dashboard's OCR/SFTP helpers build disposable virtual environments in
  # the container writable layer under /tmp. A single OCR environment is over
  # 5GB, which can leave a 30GB guest below the image-pull headroom threshold.
  # An update force-recreates this container anyway, so remove only these known
  # ephemeral paths before pulling. Customer state remains in named volumes.
  docker ps --format '{{.Names}}' 2>/dev/null | grep -- '-official-dashboard$' | while IFS= read -r dashboard_container; do
    [ -n "$dashboard_container" ] || continue
    docker exec -u 0 "$dashboard_container" sh -c \
      'rm -rf -- /tmp/ocrvenv /tmp/sftpvenv /tmp/node-compile-cache' \
      2>/dev/null && echo "[hermes-update-cleanup] pruned ephemeral tool envs from $dashboard_container" || true
  done
}

hermes_volume_safe_update_cleanup() {
  cleanup_phase="\${1:-manual}"
  echo "[hermes-update-cleanup] phase=\${cleanup_phase} disk before: $(df -h / 2>/dev/null | tail -1 || true)"
  docker system df 2>/dev/null || true

  if [ -x /usr/local/bin/hermes-disk-cleanup ]; then
    if ! /usr/local/bin/hermes-disk-cleanup; then
      echo "[hermes-update-cleanup] WARN: /usr/local/bin/hermes-disk-cleanup failed; continuing with inline volume-safe cleanup" >&2
    fi
  else
    echo "[hermes-update-cleanup] WARN: /usr/local/bin/hermes-disk-cleanup missing; using inline volume-safe cleanup" >&2
  fi

  # Free the browser-sidecar Chrome cache before the (large) image pull. This is
  # volume-content-safe (cache only) and prevents a ballooned browser-state from
  # failing the disk-headroom check and blocking an unrelated agent-image update.
  prune_browser_sidecar_cache
  prune_official_dashboard_ephemeral_tool_envs
  prune_dangling_docker_images
  prune_old_unused_hermes_agent_images
  # Plain \`-f\` (not \`-af\`) so tagged-but-unused images like
  # \`<repo>:hermes-last-known-good\` survive cleanup for the auto-update rollback path.
  docker image prune -f 2>/dev/null | tail -1 || true
  docker builder prune -af 2>/dev/null | tail -1 || true
  docker container prune -f --filter "until=24h" 2>/dev/null | tail -1 || true
  docker network prune -f 2>/dev/null | tail -1 || true
  ctr -n moby content prune references 2>/dev/null && echo "[hermes-update-cleanup] containerd content pruned" || true
  journalctl --vacuum-size=50M 2>/dev/null | tail -1 || true
  apt-get clean -qq 2>/dev/null || true
  find /var/lib/docker/containers -name '*-json.log' -type f -size +100M -exec truncate -s 0 {} \\; 2>/dev/null || true
  fstrim -av 2>/dev/null | tail -5 || true

  echo "[hermes-update-cleanup] phase=\${cleanup_phase} disk after: $(df -h / 2>/dev/null | tail -1 || true)"
  docker system df 2>/dev/null || true
}

hermes_verify_update_disk_headroom() {
  min_free_mb="\${HERMES_UPDATE_MIN_FREE_MB:-4096}"
  free_mb="$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4 + 0}')"
  if [ -z "$free_mb" ] || ! [ "$free_mb" -ge 0 ] 2>/dev/null; then
    echo "[hermes-update-cleanup] WARN: could not calculate free disk; continuing update" >&2
    return 0
  fi
  echo "[hermes-update-cleanup] free_mb=\${free_mb} min_free_mb=\${min_free_mb}"
  if [ "$free_mb" -lt "$min_free_mb" ] 2>/dev/null; then
    echo "ERROR: only \${free_mb}MB free after cleanup; refusing update before image pulls (need \${min_free_mb}MB)" >&2
    docker system df >&2 2>/dev/null || true
    return 1
  fi
}
`;
}

export function buildHermesMemoryGuardProvisioningScript(): string {
  return `cat > /usr/local/bin/hermes-memory-guard <<'__HERMES_MEMORY_GUARD__'
#!/bin/bash
set -u
LOG="/var/log/hermes-memory-guard.log"
mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1
echo "=== Hermes memory guard: $(date -u -Iseconds 2>/dev/null || date -u) ==="

MIN_SWAP_MB="\${HERMES_MIN_SWAP_MB:-2048}"
LOW_MEM_THRESHOLD_MB="\${HERMES_LOW_MEM_THRESHOLD_MB:-2048}"
HERMES_DISK_SWAP_MB="\${HERMES_DISK_SWAP_MB:-2048}"
mem_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
mem_mb=$((mem_kb / 1024))
active_swap_kb="$(awk 'NR>1 {sum += $3} END {print sum + 0}' /proc/swaps 2>/dev/null || echo 0)"
active_swap_mb=$((active_swap_kb / 1024))

echo "mem_mb=$mem_mb active_swap_mb=$active_swap_mb min_swap_mb=$MIN_SWAP_MB"
if [ "$active_swap_mb" -ge "$MIN_SWAP_MB" ] 2>/dev/null; then
  echo "swap already sufficient"
  exit 0
fi

if command -v modprobe >/dev/null 2>&1 && modprobe zram >/dev/null 2>&1 && [ -e /sys/block/zram0/disksize ]; then
  if swapon --noheadings --raw --show=NAME 2>/dev/null | grep -qx '/dev/zram0'; then
    echo "zram swap already active"
    exit 0
  fi
  swapoff /dev/zram0 >/dev/null 2>&1 || true
  if [ -e /sys/block/zram0/reset ]; then
    echo 1 > /sys/block/zram0/reset 2>/dev/null || true
  fi
  if [ -e /sys/block/zram0/comp_algorithm ]; then
    echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || true
  fi
  echo "$((MIN_SWAP_MB * 1024 * 1024))" > /sys/block/zram0/disksize
  if mkswap /dev/zram0 >/dev/null 2>&1 && swapon -p 100 /dev/zram0 >/dev/null 2>&1; then
    echo "enabled zram swap at \${MIN_SWAP_MB}MiB"
    exit 0
  fi
  echo "WARN: zram setup failed; considering disk swap fallback"
fi

if [ "$mem_mb" -ge "$LOW_MEM_THRESHOLD_MB" ] 2>/dev/null; then
  echo "zram unavailable but memory is above low-memory threshold; no disk swap fallback needed"
  exit 0
fi

swapfile=/swapfile
if swapon --noheadings --raw --show=NAME 2>/dev/null | grep -qx "$swapfile"; then
  echo "$swapfile already active"
  exit 0
fi
if [ ! -f "$swapfile" ]; then
  echo "creating disk swap fallback size=\${HERMES_DISK_SWAP_MB}MiB"
  fallocate -l "\${HERMES_DISK_SWAP_MB}M" "$swapfile" 2>/dev/null || dd if=/dev/zero of="$swapfile" bs=1M count="$HERMES_DISK_SWAP_MB" status=none
fi
chmod 600 "$swapfile"
mkswap -f "$swapfile" >/dev/null
swapon "$swapfile"
if ! grep -qE '^/swapfile[[:space:]]+none[[:space:]]+swap[[:space:]]+' /etc/fstab; then
  printf '%s\\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo "enabled disk swap fallback at $swapfile size=\${HERMES_DISK_SWAP_MB}MiB"
__HERMES_MEMORY_GUARD__
chmod +x /usr/local/bin/hermes-memory-guard

cat > /etc/systemd/system/hermes-memory-guard.service <<'__HERMES_MEMORY_GUARD_SERVICE__'
[Unit]
Description=Hermes low-memory swap guard
DefaultDependencies=no
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/hermes-memory-guard

[Install]
WantedBy=multi-user.target
__HERMES_MEMORY_GUARD_SERVICE__

systemctl daemon-reload
systemctl enable --now hermes-memory-guard.service >/dev/null 2>&1 || /usr/local/bin/hermes-memory-guard || true
`;
}

export function buildHermesAptQuiesceScript(): string {
  return `hermes_quiesce_background_apt() {
  log="/var/log/hermes-apt-quiesce.log"
  mkdir -p "$(dirname "$log")"
  echo "=== Hermes apt quiesce $(date -u -Iseconds 2>/dev/null || date -u) ===" >> "$log"

  # Cloud images can launch apt-daily/unattended-upgrades shortly after boot.
  # On 1GB guests that races Docker pulls, layer extraction, and WebUI first
  # start. Stop the background jobs for this provisioning run; timers remain
  # installed and will be available again after reboot.
  for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service packagekit.service; do
    systemctl stop "$unit" >> "$log" 2>&1 || true
  done

  for _ in $(seq 1 30); do
    if ! pgrep -af 'apt.systemd.daily|unattended-upgrade|packagekitd' >> "$log" 2>&1; then
      echo "background apt/packagekit jobs are quiet" >> "$log"
      return 0
    fi
    echo "waiting for background apt/packagekit jobs to stop" >> "$log"
    sleep 2
  done

  echo "WARN: background apt/packagekit jobs still running after wait; continuing with memory guard active" >> "$log"
  pgrep -af 'apt.systemd.daily|unattended-upgrade|packagekitd' >> "$log" 2>&1 || true
}

hermes_quiesce_background_apt
`;
}

function resolveWebUIRuntimeDefaultModel(p: WebUIDeployParams): string {
  if (isHermesManagedVeniceEndpoint(p)) {
    // Managed Venice is a dashboard/billing label over our OpenAI-compatible
    // proxy. If the WebUI seed is namespaced as @venice:<model>, first-launch
    // profile setup can rewrite config.yaml away from provider: custom and the
    // agent then asks for a provider-native key such as DEEPSEEK_API_KEY.
    return p.defaultModel;
  }

  const dashboardProvider = p.dashboardProvider?.trim();
  return dashboardProvider
    ? buildWebUIDefaultModel(p.defaultModel, dashboardProvider)
    : p.defaultModel;
}

function systemdSafeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.@:-]/g, "_");
}

export function buildWebUIProvisioningArtifacts(
  p: WebUIDeployParams,
  mode: WebUIAgentImageMode = "provision"
): WebUIProvisioningArtifacts {
  const image = p.image ?? env("HERMES_WEBUI_DOCKER_IMAGE", DEFAULT_WEBUI_IMAGE);
  const agentImage = resolveWebUIAgentImage(p, mode);
  const resolved = { ...p, image, agentImage };
  return {
    composeYaml: buildWebUICompose(resolved),
    caddyfile: buildWebUICaddyfile(p.fqdn, p.containerName, p.webuiPassword, {
      browserSidecarEnabled: p.browserSidecarEnabled === true,
      instanceId: p.instanceId,
    }),
    // WebUI sidecar = base + handoff appendage. Base stays byte-identical
    // to its pre-iframe-migration state (Hetzner agents need that to fit
    // their 32KB user_data ceiling); the appendage is concatenated only for
    // WebUI deploys and hooks the request handler to short-circuit
    // /webui-login + /webui-session-check.
    sidecarServerFile: SIDECAR_SERVER_CODE + WEBUI_HANDOFF_APPENDAGE,
    signalDaemonFile: buildWebUISignalDaemonScript(),
    envFile: buildWebUIComposeEnv(p),
    configYaml: buildWebUIConfigYaml(p, mode),
    hermesEnvFile: buildHermesEnvFile(p),
    authStoreFile: buildWebUIAuthStoreFile(p),
  };
}

// ── docker-compose.yml ─────────────────────────────────────────────────

// Renders the browser-sidecar service block, or the empty string if the
// feature is not enabled for this instance. Splice into the main compose
// template; never call directly elsewhere.
function buildBrowserSidecarServiceBlock(p: WebUIDeployParams): string {
  if (!p.browserSidecarEnabled) return "";
  const image = env("HERMES_BROWSER_SIDECAR_IMAGE", resolveBrowserSidecarDefaultImage());
  const dashboardUrl = env("NEXT_PUBLIC_APP_URL", "https://hivra.cloud");
  return `
  # Browser sidecar — Pro-tier-gated, opt-in. Deterministic Playwright HTTP API
  # the QA agent (Vex) drives. Persistent Chromium context survives restarts.
  # See services/browser-sidecar/ for the source. Layer 2 of tier gating
  # revalidates against the dashboard on container start; if the user's tier
  # has lapsed, the sidecar exits 0 and stays down.
  #
  # The "autoheal=true" label (rather than docker's restart-on-unhealthy
  # nonexistent native feature) lets the autoheal-watchdog sibling restart
  # this container when the healthcheck reports unhealthy. Plain
  # restart: unless-stopped only restarts on exit, not on stuck-but-running.
  browser-sidecar:
    image: ${image}
    container_name: ${p.containerName}-browser-sidecar
    restart: unless-stopped
    labels:
      - "autoheal=true"
    environment:
      - PORT=${BROWSER_SIDECAR_INTERNAL_PORT}
      - HOST=0.0.0.0
      - LOG_LEVEL=info
      - NODE_ENV=production
      - PROFILES_DIR=/var/lib/hermes-browser/profiles
      - FLOWS_DIR=/var/lib/hermes-browser/flows
      - SCREENSHOTS_DIR=/var/lib/hermes-browser/screenshots
      - SIGNING_SECRET=${p.webuiPassword}
      # Bearer the agent client sends on every tool route. The agent's
      # browser_sidecar.py reads HERMES_BROWSER_SIDECAR_AUTH_TOKEN from
      # the .env file generated by buildHermesEnvFile; both sides use
      # the same per-instance webuiPassword so a redeploy rotates them
      # in lockstep. When this env var is unset (e.g. on a VM that
      # hasn't picked up the new compose yet), the sidecar falls into
      # warn-only mode and lets requests through with a per-request
      # auth_disabled=true log.
      - SIDECAR_AUTH_TOKEN=${p.webuiPassword}
      - TIER_CHECK_URL=${dashboardUrl}/api/internal/tier-check
      - TIER_CHECK_INSTANCE_ID=${p.instanceId}
      - TIER_CHECK_TOKEN=${p.webuiPassword}
      # Run headed against Xvfb so the dashboard's "Browser" button shows what
      # the agent is actually doing live. Headed mode is also more reliable
      # against anti-bot than headless. Cost: ~50MB extra RAM.
      - PLAYWRIGHT_HEADLESS=false
      - DISPLAY=:99
      - NOVNC_INTERNAL_PORT=${BROWSER_SIDECAR_NOVNC_PORT}
      # VNC password gating the same-origin /vnc/ viewer (no signed URL). The
      # dashboard derives the same value from the instance api_server_key and
      # the /vnc/ RFB viewer sends it, so the open /vnc/ route isn't an
      # unauthenticated window into the agent's browser.
      - VNC_PASSWORD=${deriveBrowserVncPassword(p.webuiPassword)}${agentBrowserCdpEnabled() ? `
      # Persistent CDP Chromium the AGENT drives (BROWSER_CDP_URL points here), so
      # the agent's everyday browsing is what the live noVNC view shows. The
      # sidecar image's entrypoint launches Chrome + the host-header-fixing CDP
      # proxy on AGENT_CDP_PORT when AGENT_CDP_ENABLED=true.
      - AGENT_CDP_ENABLED=true
      - AGENT_CDP_PORT=${AGENT_CDP_PORT}
      - AGENT_CDP_PROXY_PORT=${AGENT_CDP_PROXY_PORT}` : ""}
    volumes:
      - browser-state:/var/lib/hermes-browser
    expose:
      - "${BROWSER_SIDECAR_INTERNAL_PORT}"
      - "${BROWSER_SIDECAR_NOVNC_PORT}"${agentBrowserCdpEnabled() ? `
      - "${AGENT_CDP_PROXY_PORT}"` : ""}
    networks:
      - hermes_net
    deploy:
      resources:
        limits:
          # Playwright + Chromium is the heavy thing here. ~750MB idle, peaks
          # ~1.2GB during heavy QA flows. CPU is bursty, half a core sustained.
          # Headroom (~50MB) covers the always-on Xvfb+x11vnc+websockify
          # display stack so noVNC seeding works without a separate seed-mode
          # restart. See docker/entrypoint.sh for rationale.
          cpus: "1.0"
          memory: 1320M
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:${BROWSER_SIDECAR_INTERNAL_PORT}/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    init: true

  # Watchdog: restarts any sibling container whose healthcheck reports
  # unhealthy. Only labeled containers (autoheal=true) are touched; leaving
  # webui and gateway unlabeled keeps their existing restart semantics
  # unchanged. Tiny image (~20 MB), idle CPU, idle RAM negligible.
  autoheal:
    image: willfarrell/autoheal:latest
    container_name: ${p.containerName}-autoheal
    restart: unless-stopped
    environment:
      - AUTOHEAL_CONTAINER_LABEL=autoheal
      - AUTOHEAL_INTERVAL=60
      - AUTOHEAL_START_PERIOD=120
      - DOCKER_SOCK=/var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - hermes_net
    deploy:
      resources:
        limits:
          cpus: "0.1"
          memory: 64M
    init: true
`;
}

function buildBrowserSidecarVolumeBlock(p: WebUIDeployParams): string {
  if (!p.browserSidecarEnabled) return "";
  return `  browser-state:
    name: ${p.containerName}_browser-state
`;
}

export function buildWebUICompose(p: WebUIDeployParams & { image: string; agentImage: string }): string {
  const cpu = p.cpuLimit && p.cpuLimit > 0 ? p.cpuLimit : 2;
  const ramMb = p.ramLimit && p.ramLimit > 0 ? p.ramLimit : 4096;
  // Burst ceiling for the agent-bearing containers (gateway + official-dashboard,
  // the two surfaces a user actively drives). Equals ramMb unless RAM burst is
  // active and handed us a higher ceiling — then the cgroup lets the agent use
  // the VM's full burst headroom before the kernel OOM-kills it back to a clean
  // restart. System sidecars (browser 1320M, autoheal 64M) keep fixed limits.
  const ramCeilingMb = p.ramBurstMb && p.ramBurstMb > ramMb ? p.ramBurstMb : ramMb;
  const browserSidecarServiceBlock = buildBrowserSidecarServiceBlock(p);
  const browserSidecarVolumeBlock = buildBrowserSidecarVolumeBlock(p);
  // Both agent-bearing services execute user commands: the messaging gateway
  // and the native Hermes dashboard used by browser chat. Advanced Cloud
  // Access therefore has to grant the same guest-VM Docker socket capability
  // to both. Keeping it on the gateway alone makes native chat silently run in
  // the dashboard container even when Hermes is configured for Docker.
  const agentDockerGroupAdd = p.gatewayDockerAccess
    ? `    group_add:
      - "\${HERMES_GUEST_DOCKER_GID:?guest Docker socket GID is required}"
`
    : "";
  const agentDockerSocketMount = p.gatewayDockerAccess
    ? "      - /var/run/docker.sock:/var/run/docker.sock\n"
    : "";
  // Dashboard origin + instance id the agent's aeon skill uses to gate
  // scheduled Aeon work against this instance's run-eligibility (a paused /
  // stopped / suspended VM must not keep its Aeon fork doing autonomous work).
  const aeonGateUrl = env("NEXT_PUBLIC_APP_URL", "https://hivra.cloud").replace(/\/+$/, "");

  return `services:
  gateway:
    image: ${p.agentImage}
    # Run the gateway on the AGENT image (webui-free). Bypass the agent image's
    # s6-overlay init with entrypoint:[] — s6 fatals as non-pid-1 under user:,
    # and the supervisor command runs hermes gateway directly (same as
    # official-dashboard). The supervisor uv-runs the agent-source mount, so the
    # actual gateway code was already the agent's; this drops the webui image.
    entrypoint: []
    container_name: ${p.containerName}-gateway
    restart: unless-stopped
    user: "1024:1024"
${agentDockerGroupAdd}    working_dir: ${WEBUI_HERMES_AGENT_DIR}
    env_file: .env
    environment:
      # api_server platform binds 127.0.0.1 by default — that makes it
      # unreachable from the sibling webui container. Setting HOST=0.0.0.0
      # binds all interfaces so webui (on the same docker network) can
      # POST chat turns to it. The KEY arms the bearer check on the
      # platform itself (the webui sends the same key as Authorization
      # bearer). Without KEY set, the api_server platform silently
      # skips starting at all — gateway_state.json shows api_server in
      # "retrying" with "failed to reconnect" forever.
      - API_SERVER_HOST=0.0.0.0
      - API_SERVER_PORT=8642
      - API_SERVER_KEY=${p.webuiPassword}
      - HERMES_HOME=/home/hermes/.hermes
      - HERMES_WRITE_SAFE_ROOT=${WEBUI_HERMES_WRITE_SAFE_ROOTS}
      # One gateway per container. Dedicated named-profile containers override
      # both this label and HERMES_HOME to their directory in the rw state mount.
      - HERMES_PROFILE_NAME=default
      # Kanban is intentionally shared across profiles so dispatcher/worker
      # handoff uses one DB. A named gateway must therefore keep the complete
      # webui-state root mounted rw, even though HERMES_HOME is profile-local.
      - HERMES_KANBAN_HOME=/home/hermes/.hermes
      # Agent source is shared at the base root even when HERMES_HOME points at
      # profiles/<name>; never derive this path from the profile home.
      - HERMES_WEBUI_AGENT_DIR=${WEBUI_HERMES_AGENT_DIR}
      # Pin HOME just like the official-dashboard service below. This service
      # runs as user "1024:1024" with no /etc/passwd entry, so without HOME the
      # gateway-supervisor (and the gateway it spawns) inherit HOME=/ and every
      # Path.home()-relative path resolves under "/". That broke the gateway's
      # per-platform startup lock (~/.local/state → /.local), crash-looping
      # Telegram/Signal/WhatsApp/Slack with "Permission denied: '/.local'". The
      # XDG_* pins in WEBUI_PERSISTENT_INSTALL_ENV_LINES then keep that lock (and
      # other XDG state) inside the uid-1024-writable HERMES_HOME volume, since
      # /home/hermes itself is root:root 0755 and ~/.local is uncreatable.
      - HOME=/home/hermes
      - HERMES_INSTANCE_ID=${p.instanceId}
      - HERMES_AEON_GATE_URL=${aeonGateUrl}
      # Hardened dashboard "basic" provider creds, inline (not only via .env) so
      # the sidecar's recovery fallback — which relaunches the dashboard INSIDE
      # this gateway container — still registers the provider regardless of what
      # rewrites .env (a compose environment entry overrides env_file). See
      # dashboardBasicAuthEnvLines.
${dashboardBasicAuthEnvLines(p.webuiPassword).map((line) => `      - ${line}`).join("\n")}
${WEBUI_PERSISTENT_INSTALL_ENV_LINES.map((line) => `      - ${line}`).join("\n")}
    command:
      - sh
      - -lc
      - |
          set -eu
          # Honour the compose-level HERMES_HOME contract. The default service
          # uses the rw webui-state root; a dedicated profile gateway points at
          # profiles/<name> inside that same rw shared volume. Kanban remains at
          # HERMES_KANBAN_HOME in the shared root by design.
          BASE_HOME="$\${HERMES_HOME:-/home/hermes/.hermes}"
          export HERMES_HOME="$$BASE_HOME"
          export PATH="$$BASE_HOME/bin:$$PATH"
          mkdir -p "$$BASE_HOME/gateway-profiles.d" "$$BASE_HOME/logs"
          # Self-heal a read-only agent venv before the gateway ever launches.
          # The supervisor below starts the gateway via 'uv run', which implicitly
          # re-syncs the venv and rewrites .venv/bin/hermes on EVERY start. If the
          # venv tree is read-only (a stray restore or 'chmod -R' on a
          # hand-managed instance leaves .venv/bin dr-xr-xr-x), uv cannot unlink
          # the old console script -> "failed to remove ... bin/hermes: Permission
          # denied (os error 13)" -> the gateway child exits and the supervisor
          # respawns it forever, stranding the agent workspace on a blank screen.
          # Restoring owner-write on the uid-1024-owned venv is safe + idempotent.
          # See infra_gateway_readonly_venv_crashloop.
          if [ -d "$$BASE_HOME/hermes-agent/.venv" ]; then
            chmod -R u+w "$$BASE_HOME/hermes-agent/.venv" 2>/dev/null || true
          fi
          exec python3 - <<'PY'
          import os
          import json as _json
          import re
          import signal
          import subprocess
          import sys
          import time
          from pathlib import Path

          def decode_quoted_env_value(value: str) -> str:
              if len(value) < 2 or value[0] != value[-1] or value[0] not in ("'", '"'):
                  return value
              inner = value[1:-1]
              if value[0] == "'":
                  return inner.replace("\\\\'", "'")
              replacements = {
                  "\\\\n": "\\n",
                  "\\\\r": "\\r",
                  "\\\\t": "\\t",
                  '\\\\"': '"',
                  "\\\\\\\\": "\\\\",
                  "\\\\$": "$",
              }
              for old, new in replacements.items():
                  inner = inner.replace(old, new)
              return inner

          def load_env_file(path: Path, env) -> None:
              if not path.exists():
                  return
              key_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
              for raw_line in path.read_text(errors="replace").splitlines():
                  line = raw_line.strip()
                  if not line or line.startswith("#") or "=" not in line:
                      continue
                  if line.startswith("export "):
                      line = line[len("export "):].lstrip()
                  key, value = line.split("=", 1)
                  key = key.strip()
                  if not key_pattern.match(key):
                      continue
                  env[key] = decode_quoted_env_value(value.strip())

          base_home = Path(os.environ["HERMES_HOME"])
          runtime_profile_name = os.environ.get("HERMES_PROFILE_NAME", "default").strip() or "default"
          if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", runtime_profile_name):
              raise RuntimeError("invalid HERMES_PROFILE_NAME: " + runtime_profile_name)
          active_dir = base_home / "gateway-profiles.d"
          active_dir.mkdir(parents=True, exist_ok=True)
          agent_dir = Path(os.environ["HERMES_WEBUI_AGENT_DIR"])
          children = {}
          env_sigs = {}
          spawn_times = {}
          fail_streak = {}
          cooldown_until = {}
          venv_dir = agent_dir / ".venv"

          def heal_readonly_venv():
              # uv's implicit sync on 'uv run' rewrites .venv/bin/hermes on every
              # gateway start; a read-only venv tree makes that unlink fail with
              # EACCES and crash-loops the gateway (blank workspace). Restore
              # owner-write on the uid-1024-owned venv — safe + idempotent. The
              # container-start preamble does this once; repeating it here also
              # heals a venv that goes read-only mid-life (e.g. a restore while
              # the container is up).
              if not venv_dir.is_dir():
                  return
              try:
                  subprocess.run(["chmod", "-R", "u+w", str(venv_dir)], check=False)
                  print("[gateway-supervisor] self-heal: restored owner-write on " + str(venv_dir), flush=True)
              except Exception as exc:
                  print("[gateway-supervisor] self-heal chmod failed: " + str(exc), flush=True)

          def env_file_sig(path):
              try:
                  st = path.stat()
                  return (st.st_mtime_ns, st.st_size)
              except OSError:
                  return None
          def managed_gateway_python():
              # A source .python-version is not the managed image's runtime
              # contract. Letting uv choose from it can replace the qualified
              # venv, dropping owner-installed extras and changing SQLite.
              # Only a genuinely absent venv may be created from image Python;
              # a broken/dangling existing environment must never be replaced.
              if not os.path.lexists(venv_dir):
                  return "/usr/bin/python3"

              def reject(reason):
                  raise RuntimeError("[gateway-supervisor] managed gateway Python environment invalid: " + reason + "; repair the existing environment before restart (automatic replacement refused)")

              try:
                  if not venv_dir.is_dir():
                      reject(".venv is not a readable directory")
                  cfg = {}
                  for line in (venv_dir / "pyvenv.cfg").read_text(encoding="utf-8").splitlines():
                      line = line.strip()
                      if not line or line.startswith("#"):
                          continue
                      key, separator, value = line.partition("=")
                      key, value = key.strip().lower(), value.strip()
                      if not separator or not key or (key in cfg and cfg[key] != value):
                          reject("malformed pyvenv.cfg")
                      cfg[key] = value
                  versions = [cfg[key] for key in ("version", "version_info") if key in cfg]
                  if not versions or not cfg.get("home"):
                      reject("pyvenv.cfg is missing interpreter metadata")
                  if not Path(cfg["home"]).is_absolute() or not Path(cfg["home"]).is_dir():
                      reject("pyvenv.cfg interpreter home is unavailable")
                  probe = "import json,sys; print(json.dumps({'version': list(sys.version_info[:3]), 'releaselevel': sys.version_info.releaselevel, 'serial': sys.version_info.serial, 'prefix': sys.prefix, 'base_prefix': sys.base_prefix}))"

                  def inspect_python(candidate):
                      if not candidate.is_file() or not os.access(candidate, os.X_OK):
                          reject("missing or non-executable venv interpreter")
                      completed = subprocess.run([str(candidate), "-I", "-c", probe], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
                      info = _json.loads(completed.stdout)
                      if Path(info["prefix"]).resolve() != venv_dir.resolve() or info["prefix"] == info["base_prefix"]:
                          reject("interpreter is not running in the managed venv")
                      if info["releaselevel"] != "final" or info["serial"] != 0:
                          reject("managed image interpreter is not a final Python release")
                      for version in versions:
                          match = re.fullmatch(r"([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:\\.final\\.0)?", version)
                          if not match or [int(part) for part in match.groups()] != info["version"]:
                              reject("pyvenv.cfg version does not match its interpreter")
                      return info

                  python = venv_dir / "bin" / "python"
                  info = inspect_python(python)
                  # uv prefers bin/python3 when inspecting an existing venv.
                  # Validate and select that same alias. In a copied venv it
                  # can be a distinct executable from bin/python even when
                  # both report identical interpreter metadata.
                  python3 = venv_dir / "bin" / "python3"
                  if os.path.lexists(python3):
                      if inspect_python(python3) != info:
                          reject("venv python aliases disagree")
                      return str(python3)
                  return str(python)
              except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
                  reject("interpreter/config validation failed")

          def managed_gateway_command(action):
              command = ["/usr/local/bin/uv", "run", "--project", str(agent_dir), "--python", managed_gateway_python(), "--no-python-downloads", "--inexact", "--extra", "messaging", "hermes", "gateway", action]
              if action == "run":
                  command.extend(["--replace", "--accept-hooks"])
              return command
          unset_keys = {
              "HERMES_INFERENCE_PROVIDER",
              "HERMES_MODEL",
              "HERMES_SUBAGENT_MODEL",
              "MODEL",
              "PROVIDER",
              "LLM_PROVIDER",
              "HERMES_WEBUI_DEFAULT_MODEL",
          }
          CANARY_SHAPE_PROBE_MARKER = "CANARY_SHAPE_PROBE"
          PLATFORM_REQUIRED_ENV_KEYS = {
              "telegram": ("TELEGRAM_BOT_TOKEN",),
              "discord": ("DISCORD_BOT_TOKEN",),
              "slack": ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"),
              "email": ("EMAIL_ADDRESS", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST", "EMAIL_SMTP_HOST"),
              "sms": ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"),
              "twilio": ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"),
              "signal": ("SIGNAL_ACCOUNT", "SIGNAL_HTTP_URL"),
              "dingtalk": ("DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"),
              "whatsapp": ("WHATSAPP_ENABLED",),
              "x": ("X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"),
              "twitter": ("X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"),
              "bluebubbles": ("BLUEBUBBLES_SERVER_URL", "BLUEBUBBLES_PASSWORD"),
              "matrix": ("MATRIX_HOMESERVER", "MATRIX_USER_ID", "MATRIX_ACCESS_TOKEN"),
              "mattermost": ("MATTERMOST_URL", "MATTERMOST_TOKEN"),
              "wecom": ("WECOM_BOT_ID", "WECOM_SECRET"),
              "wechat": ("WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN"),
              "weixin": ("WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN"),
              "feishu": ("FEISHU_APP_ID", "FEISHU_APP_SECRET"),
              "lark": ("FEISHU_APP_ID", "FEISHU_APP_SECRET"),
              "home_assistant": ("HASS_URL", "HASS_TOKEN"),
              "homeassistant": ("HASS_URL", "HASS_TOKEN"),
          }

          def seed_active_markers_from_existing_env() -> None:
              # Single-profile gateway: ONLY the "default"/base profile runs a
              # gateway. It hosts the api_server (the dashboard POSTs chat turns
              # to it), the cron scheduler, and the kanban dispatcher. Sub-profiles
              # under profiles/* keep their data and stay reachable via the
              # api_server profile switcher, but they no longer run their own
              # gateway: running a full gateway PER profile raced for the
              # singleton api_server port 8642 (whoever bound it first won; the
              # default profile lost and the dashboard's api_server "failed to
              # connect") and the per-profile status check false-positived on the
              # aggregate, so the default gateway was never restarted — wedging
              # the dashboard during disposable verification. Stale sub-profile
              # *.active markers from the old multi-profile supervisor are ignored
              # by active_profiles() below.
              marker = active_dir / (runtime_profile_name + ".active")
              if marker.exists():
                  return
              marker.write_text(str(base_home) + "\\n", encoding="utf-8")
              print("[gateway-supervisor] ensured active marker for profile=" + runtime_profile_name, flush=True)

          def active_profiles():
              # Single-profile: always and only the default/base profile, so
              # exactly one gateway ever binds the api_server port. Legacy
              # sub-profile *.active markers are intentionally ignored.
              return [(runtime_profile_name, base_home)]

          # Path/runtime-infra env keys are a function of THIS container's home,
          # NOT of the persisted profile .env. Older provisionings homed the agent
          # under /home/hermeswebui; that legacy .env survives in the webui-state
          # volume and, once load_env_file overlays it, repoints UV_CACHE_DIR /
          # PYTHONUSERBASE / XDG_* etc. at /home/hermeswebui paths this uid cannot
          # create -> 'uv run' dies with "Failed to initialize cache ... Permission
          # denied (os error 13)" on every gateway launch -> crash-loop -> blank
          # workspace. The live container env (os.environ, generated from the
          # compose file) already holds the CORRECT values, so re-pin these keys
          # AFTER the .env load so a stale persisted value can never override them.
          # Kept in lockstep with the dashboard's WEBUI_PERSISTENT_INSTALL_ENV_KEYS
          # (plus HOME, which the compose env sets separately).
          PINNED_INFRA_ENV_KEYS = ("HOME", ${WEBUI_PERSISTENT_INSTALL_ENV_KEYS.map((k) => JSON.stringify(k)).join(", ")})

          def profile_env(profile_home: Path):
              env = os.environ.copy()
              for key in unset_keys:
                  env.pop(key, None)
              load_env_file(profile_home / ".env", env)
              # Re-pin AFTER the .env load so a stale persisted value cannot win.
              env["HERMES_HOME"] = str(profile_home)
              # Explicit --project/cwd select the managed venv. Do not export
              # its path into Hermes tasks: their uv commands need their own
              # project environments, not the gateway's interpreter directory.
              env.pop("UV_PROJECT_ENVIRONMENT", None)
              for key in PINNED_INFRA_ENV_KEYS:
                  live = os.environ.get(key)
                  if live:
                      env[key] = live
              # Profile-local bin leads PATH (its shims win), then the re-pinned
              # live container PATH — never the stale .env PATH.
              env["PATH"] = str(base_home / "bin") + ":" + env.get("PATH", "")
              env.pop("HERMES_WEBUI_DEFAULT_MODEL", None)
              return env

          def usable_env_value(value) -> bool:
              if value is None:
                  return False
              normalized = str(value).strip()
              return bool(normalized) and CANARY_SHAPE_PROBE_MARKER not in normalized

          def platform_configured(platform_name: str, env) -> bool:
              required_keys = PLATFORM_REQUIRED_ENV_KEYS.get(str(platform_name or "").lower())
              if not required_keys:
                  return True
              return all(usable_env_value(env.get(key)) for key in required_keys)

          def stop_gateway_child(profile_name, child, reason):
              if child.poll() is not None:
                  return
              print("[gateway-supervisor] stopping gateway profile=" + profile_name + " reason=" + reason, flush=True)
              try:
                  os.killpg(child.pid, signal.SIGTERM)
              except ProcessLookupError:
                  return
              except Exception as exc:
                  print("[gateway-supervisor] process-group SIGTERM failed for profile=" + profile_name + ": " + str(exc), flush=True)
                  child.terminate()
              try:
                  child.wait(timeout=10)
                  return
              except Exception:
                  pass
              print("[gateway-supervisor] killing gateway profile=" + profile_name + " reason=" + reason, flush=True)
              try:
                  os.killpg(child.pid, signal.SIGKILL)
              except ProcessLookupError:
                  return
              except Exception as exc:
                  print("[gateway-supervisor] process-group SIGKILL failed for profile=" + profile_name + ": " + str(exc), flush=True)
                  child.kill()
              try:
                  child.wait(timeout=5)
              except Exception:
                  pass

          def mark_gateway_planned_stop(profile_home):
              # Tell the gateway that the SIGTERM we are about to send is an
              # intentional supervisor restart, NOT a crash, so it exits 0
              # cleanly instead of exit 1 with the "systemd Restart=on-failure
              # can revive the gateway" log. There is no systemd in this
              # container — THIS loop is the reviver — so an unexpected-signal
              # exit-1 here is both misleading in the logs and skips the
              # gateway's graceful shutdown (which closes the Signal SSE
              # subscription and other platform connections). We mirror what
              # 'hermes gateway stop' does: drop a short-lived planned-stop
              # marker naming the gateway PID before signalling it. The
              # gateway's shutdown handler / planned-stop watcher consumes the
              # marker and classifies the stop as planned. Best-effort: a
              # missing marker just means the old (harmless) exit-1 behaviour.
              try:
                  import json as _json
                  from datetime import datetime as _dt, timezone as _tz
                  raw = (profile_home / "gateway.pid").read_text(encoding="utf-8").strip()
                  try:
                      pid = int(_json.loads(raw).get("pid"))
                  except Exception:
                      pid = int(raw)
                  marker = {
                      "target_pid": pid,
                      # Intentionally null: the gateway falls back to PID
                      # equality (bounded by the marker's 60s TTL) when
                      # start_time is unknown, so we avoid reproducing the
                      # gateway's /proc start-time parsing here. A WRONG
                      # start_time would be worse than none (it would fail the
                      # match and revert to exit-1).
                      "target_start_time": None,
                      "stopper_pid": os.getpid(),
                      "written_at": _dt.now(_tz.utc).isoformat(),
                  }
                  (profile_home / ".gateway-planned-stop.json").write_text(_json.dumps(marker), encoding="utf-8")
              except FileNotFoundError:
                  pass  # No PID file yet — gateway never came up; nothing to mark.
              except Exception as exc:
                  print("[gateway-supervisor] could not write planned-stop marker: " + str(exc), flush=True)

          # ── Persisted signal-cli daemon ────────────────────────────────
          # The Signal platform (gateway/platforms/signal.py) needs an external
          # signal-cli daemon inside THIS container's netns. The staged script
          # installs a JRE + signal-cli into the persisted HERMES_HOME volume,
          # so image-update recreates can never wipe the Java runtime again
          # (prod containers have no sudo to reinstall it; the adapter itself
          # retries every 300s, so no gateway restart is needed once the
          # daemon binds). Managed only when SIGNAL_ACCOUNT + SIGNAL_HTTP_URL
          # are configured AND the URL points at loopback — a remote URL means
          # the tenant runs their own daemon elsewhere.
          SIGNAL_DAEMON_SCRIPT = "${WEBUI_SIGNAL_DAEMON_CONTAINER_PATH}"
          signal_state = {"child": None, "env_sig": None, "last_spawn": 0.0}

          def signal_http_url(env):
              url = str(env.get("SIGNAL_HTTP_URL") or "").strip().rstrip("/")
              if url and "://" not in url:
                  url = "http://" + url
              return url

          def signal_locally_managed(env):
              if not platform_configured("signal", env):
                  return False
              url = signal_http_url(env)
              if not url:
                  return False
              try:
                  from urllib.parse import urlparse
                  host = (urlparse(url).hostname or "").lower()
              except Exception:
                  return False
              return host in ("127.0.0.1", "localhost")

          def signal_daemon_reachable(env):
              import urllib.request
              try:
                  urllib.request.urlopen(signal_http_url(env) + "/api/v1/check", timeout=3).read()
                  return True
              except Exception:
                  return False

          def manage_signal_daemon(env, env_sig):
              child = signal_state["child"]
              if child is not None and child.poll() is not None:
                  print("[gateway-supervisor] signal-cli daemon exited code=" + str(child.returncode), flush=True)
                  signal_state["child"] = None
                  child = None
              if not signal_locally_managed(env):
                  if child is not None:
                      stop_gateway_child("signal-daemon", child, "signal_unconfigured")
                      signal_state["child"] = None
                  return
              if child is not None and signal_state["env_sig"] != env_sig:
                  # Credentials changed via the dashboard — restart the daemon
                  # with the new env (mirrors the gateway's env-change restart).
                  stop_gateway_child("signal-daemon", child, "env_changed")
                  signal_state["child"] = None
                  child = None
              if child is not None:
                  return
              signal_state["env_sig"] = env_sig
              if signal_daemon_reachable(env):
                  # Something already serves the URL (a legacy in-volume
                  # watchdog setup, or a tenant-run daemon) — never race it
                  # for the port.
                  return
              if time.time() - signal_state["last_spawn"] < 60:
                  # Respawn backoff: a JVM cold start takes >10s and a
                  # crash-looping daemon must not spin the supervisor.
                  return
              if not os.path.exists(SIGNAL_DAEMON_SCRIPT):
                  print("[gateway-supervisor] signal configured but " + SIGNAL_DAEMON_SCRIPT + " is missing", flush=True)
                  return
              log_path = base_home / "logs" / "signal-cli.log"
              log_path.parent.mkdir(parents=True, exist_ok=True)
              log_file = log_path.open("ab", buffering=0)
              signal_state["child"] = subprocess.Popen(["sh", SIGNAL_DAEMON_SCRIPT], env=env, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
              signal_state["last_spawn"] = time.time()
              print("[gateway-supervisor] started signal-cli daemon log=" + str(log_path), flush=True)

          def stop_all(_signum=None, _frame=None) -> None:
              signal_child = signal_state.get("child")
              if signal_child is not None:
                  stop_gateway_child("signal-daemon", signal_child, "supervisor_shutdown")
                  signal_state["child"] = None
              profile_homes = dict(active_profiles())
              for profile_name, child in list(children.items()):
                  home = profile_homes.get(profile_name)
                  if home is not None:
                      mark_gateway_planned_stop(home)
                  stop_gateway_child(profile_name, child, "supervisor_shutdown")
              sys.exit(0)

          signal.signal(signal.SIGTERM, stop_all)
          signal.signal(signal.SIGINT, stop_all)
          idle_logged = False
          heartbeat_skip_reasons = {}

          def _heartbeat_skip(_profile_name, _state_path, _reason):
              # Log a changed reason once, rather than flooding every 10s. The
              # stale timestamp remains the fail-safe signal to the updater.
              _key = str(_state_path)
              if heartbeat_skip_reasons.get(_key) == _reason:
                  return
              heartbeat_skip_reasons[_key] = _reason
              print("[gateway-supervisor] heartbeat skipped profile=" + _profile_name + " path=" + _key + " reason=" + _reason, flush=True)

          def _process_start_time(_pid):
              try:
                  return int(Path("/proc/" + str(_pid) + "/stat").read_text(encoding="utf-8").split()[21])
              except (FileNotFoundError, IndexError, PermissionError, ValueError, OSError):
                  return None

          def _looks_like_gateway_runtime(_pid):
              try:
                  _raw = Path("/proc/" + str(_pid) + "/cmdline").read_bytes()
                  _tokens = [part.decode("utf-8", errors="replace") for part in _raw.split(b"\\0") if part]
              except (FileNotFoundError, PermissionError, OSError):
                  return False
              if not _tokens:
                  return False
              _joined = " ".join(_tokens)
              if any(token == "gateway/run.py" or token.endswith("/gateway/run.py") for token in _tokens):
                  return True
              if any(token.rsplit("/", 1)[-1] in ("hermes-gateway", "hermes-gateway.exe") for token in _tokens):
                  return True
              return bool(re.search(r"(^|\\s)gateway\\s+(run|restart)(\\s|$)", _joined))

          def _process_env_value(_pid, _key):
              try:
                  _raw = Path("/proc/" + str(_pid) + "/environ").read_bytes()
              except (FileNotFoundError, PermissionError, OSError):
                  return None
              _prefix = (_key + "=").encode("utf-8")
              for _item in _raw.split(b"\\0"):
                  if _item.startswith(_prefix):
                      return _item[len(_prefix):].decode("utf-8", errors="replace")
              return None

          def _live_gateway_identity(_record, _expected_home):
              # Fail closed: a timestamp is refreshed only for a running Hermes
              # gateway whose persisted PID, process start-time, command line,
              # and process-level HERMES_HOME all still identify the same live
              # process. Missing/unreadable/legacy evidence stays stale/BUSY.
              if not isinstance(_record, dict):
                  return None
              if _record.get("gateway_state") != "running":
                  return None
              if _record.get("kind") != "hermes-gateway":
                  return None
              try:
                  _pid = int(_record.get("pid"))
              except (TypeError, ValueError):
                  return None
              if _pid <= 0:
                  return None
              _recorded_start = _record.get("start_time")
              _current_start = _process_start_time(_pid)
              if _recorded_start is None or _current_start != _recorded_start:
                  return None
              if not _looks_like_gateway_runtime(_pid):
                  return None
              try:
                  _process_home = _process_env_value(_pid, "HERMES_HOME")
                  if not _process_home:
                      return None
                  if Path(_process_home).resolve(strict=False) != _expected_home.resolve(strict=False):
                      return None
              except (OSError, RuntimeError, ValueError):
                  return None
              return (_pid, _current_start)

          def _read_heartbeat_record(_profile_name, _state_path):
              try:
                  _raw = _state_path.read_text(encoding="utf-8")
                  _record = _json.loads(_raw)
                  if not isinstance(_record, dict):
                      raise ValueError("state is not an object")
                  return _record
              except Exception as _exc:
                  _heartbeat_skip(_profile_name, _state_path, "unreadable:" + type(_exc).__name__)
                  return None

          def _heartbeat_candidates():
              _primary_path = base_home / "gateway_state.json"
              _primary_record = _read_heartbeat_record(runtime_profile_name, _primary_path)
              _primary_identity = _live_gateway_identity(_primary_record, base_home)
              if _primary_identity is not None:
                  yield (runtime_profile_name, base_home, _primary_path, _primary_record)
              else:
                  _heartbeat_skip(runtime_profile_name, _primary_path, "primary-gateway-identity-unverified")

              # The default gateway can multiplex named profile contexts in the
              # same container. Validate every named record independently: a
              # legacy profile switch can leave an orphaned base record while a
              # real named-profile gateway is still running. Requiring the base
              # record first would strand that live state behind the updater's
              # stale-state fail-safe. Exact PID + start time + command line +
              # process HERMES_HOME proof still fails closed per record, and the
              # unverified base record above is never refreshed. A dedicated
              # dealer container has its own HERMES_HOME/profile name and never
              # scans sibling state.
              if runtime_profile_name == "default":
                  _profiles_root = base_home / "profiles"
                  if _profiles_root.is_dir():
                      for _candidate in sorted((base_home / "profiles").glob("*/gateway_state.json")):
                          _candidate_name = _candidate.parent.name
                          _candidate_record = _read_heartbeat_record(_candidate_name, _candidate)
                          if _candidate_record is None:
                              continue
                          _candidate_identity = _live_gateway_identity(_candidate_record, base_home)
                          if _candidate_identity is None:
                              _heartbeat_skip(_candidate_name, _candidate, "named-gateway-identity-unverified")
                              continue
                          yield (_candidate_name, _candidate.parent, _candidate, _candidate_record)

          def _heartbeat_state_files():
              # Refresh gateway_state.json updated_at every supervisor tick so
              # the cross-container WebUI 120s freshness window stays warm even
              # when the gateway internal cron/kanban loops have stalled. The
              # gateway process still owns active platform failures, but it does
              # not clear stale status for integrations that were later disabled.
              # Scrub those here so the official dashboard cannot keep showing
              # month-old token/probe failures after the credential is gone.
              from datetime import datetime as _dt, timezone as _tz
              for _profile_name, _profile_home, _state_path, _data in _heartbeat_candidates():
                  try:
                      _env = profile_env(_profile_home)
                      _platforms = _data.get("platforms")
                      if isinstance(_platforms, dict):
                          _removed_platforms = []
                          for _platform in list(_platforms.keys()):
                              if str(_platform or "").lower() in PLATFORM_REQUIRED_ENV_KEYS and not platform_configured(_platform, _env):
                                  _platforms.pop(_platform, None)
                                  _removed_platforms.append(_platform)
                          if _removed_platforms:
                              print("[gateway-supervisor] scrubbed stale platform state for " + _profile_name + ": " + ",".join(_removed_platforms), flush=True)
                      _data["updated_at"] = _dt.now(_tz.utc).isoformat()
                      _tmp = _state_path.with_suffix(".json.tmp")
                      _tmp.write_text(_json.dumps(_data), encoding="utf-8")
                      _tmp.replace(_state_path)
                      heartbeat_skip_reasons.pop(str(_state_path), None)
                  except Exception as _exc:
                      print("[gateway-supervisor] heartbeat failed for " + _profile_name + ": " + str(_exc), flush=True)

          while True:
              seed_active_markers_from_existing_env()
              profiles = active_profiles()
              if not profiles:
                  if not idle_logged:
                      print("[gateway-supervisor] no active gateway profiles yet", flush=True)
                      idle_logged = True
                  time.sleep(10)
                  continue
              idle_logged = False

              for profile_name, profile_home in profiles:
                  profile_home.mkdir(parents=True, exist_ok=True)
                  (profile_home / "logs").mkdir(parents=True, exist_ok=True)
                  env = profile_env(profile_home)
                  current_sig = env_file_sig(profile_home / ".env")
                  child = children.get(profile_name)
                  needs_env_restart = False
                  if child is not None and child.poll() is None:
                      if env_sigs.get(profile_name) == current_sig:
                          continue
                      # Profile .env changed (a messaging credential was added or
                      # removed via the WebUI/dashboard) — restart the gateway so
                      # the new credentials take effect.
                      print("[gateway-supervisor] .env changed for profile=" + profile_name + "; restarting gateway", flush=True)
                      mark_gateway_planned_stop(profile_home)
                      stop_gateway_child(profile_name, child, "env_changed")
                      children.pop(profile_name, None)
                      needs_env_restart = True
                  if not needs_env_restart:
                      # Respect the backoff window opened by a deterministic fast
                      # failure (see the reap loop below). Skip even the status
                      # probe — it also shells out to 'uv' and would just re-hit
                      # the same broken venv/config every tick. An operator-driven
                      # env change bypasses this (needs_env_restart is handled
                      # above) so a credential fix applies immediately.
                      if time.time() < cooldown_until.get(profile_name, 0.0):
                          continue
                      status_cmd = managed_gateway_command("status")
                      status = subprocess.run(status_cmd, cwd=agent_dir, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                      if "Gateway is running" in status.stdout:
                          env_sigs.setdefault(profile_name, current_sig)
                          fail_streak[profile_name] = 0
                          cooldown_until.pop(profile_name, None)
                          continue
                  run_cmd = managed_gateway_command("run")
                  log_path = profile_home / "logs" / "gateway.log"
                  log_file = log_path.open("ab", buffering=0)
                  children[profile_name] = subprocess.Popen(run_cmd, cwd=agent_dir, env=env, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
                  spawn_times[profile_name] = time.time()
                  env_sigs[profile_name] = current_sig
                  print("[gateway-supervisor] started gateway profile=" + profile_name + " log=" + str(log_path), flush=True)

              for profile_name, child in list(children.items()):
                  if child.poll() is not None:
                      ran = time.time() - spawn_times.pop(profile_name, time.time())
                      print("[gateway-supervisor] gateway profile=" + profile_name + " exited code=" + str(child.returncode) + " after " + str(round(ran, 1)) + "s", flush=True)
                      children.pop(profile_name, None)
                      # A launch that exits almost immediately is a DETERMINISTIC
                      # startup failure (read-only venv, a stale .env pointing 'uv'
                      # at an uncreatable cache dir, a broken venv, etc.), not a
                      # transient crash. Respawning at full speed just keeps the
                      # workspace blank. On the FIRST fast failure, self-heal the
                      # one cause we can fix in place (a read-only venv); then open
                      # an escalating backoff window so the failure is visible in
                      # the log and the healthcheck can mark the container
                      # unhealthy instead of an endless silent restart loop.
                      if ran < 30:
                          n = fail_streak.get(profile_name, 0) + 1
                          fail_streak[profile_name] = n
                          if n == 1:
                              heal_readonly_venv()
                          backoff = min(60, 5 * (2 ** min(n - 1, 4)))
                          cooldown_until[profile_name] = time.time() + backoff
                          print("[gateway-supervisor] gateway profile=" + profile_name + " failing fast (" + str(n) + "x, code=" + str(child.returncode) + "); backing off " + str(backoff) + "s before retry — see logs/gateway.log", flush=True)
                      else:
                          fail_streak[profile_name] = 0
                          cooldown_until.pop(profile_name, None)

              try:
                  manage_signal_daemon(profile_env(base_home), env_file_sig(base_home / ".env"))
              except Exception as exc:
                  print("[gateway-supervisor] signal daemon management failed: " + str(exc), flush=True)

              _heartbeat_state_files()
              time.sleep(10)
          PY
    volumes:
      # This topology intentionally runs as numeric uid 1024, while the image's
      # named hermes user is uid 10000. The bootstrap regenerates this file
      # from the pulled image so libc/OpenSSH can resolve uid 1024 and its home.
      - ./runtime-passwd:/etc/passwd:ro
      - webui-state:/home/hermes/.hermes
      - agent-source:${WEBUI_HERMES_AGENT_DIR}
      - webui-workspace:/workspace
      # Persisted signal-cli daemon bootstrap (see webui-signal-daemon.ts).
      # Mounted read-only from the instance dir so the supervisor always runs
      # the builder-fresh copy, never a stale persisted one.
      - ./signal-daemon.sh:${WEBUI_SIGNAL_DAEMON_CONTAINER_PATH}:ro
${agentDockerSocketMount}    networks:
      - hermes_net
    deploy:
      resources:
        limits:
          # Match the agent/webui allocation — give the gateway-supervisor the
          # same CPU/RAM room as the tenant's main container. The old hard cap
          # (0.5 CPU / 512M) let heavy ("power user") sessions blow the
          # gateway's cgroup, OOM-killing the supervisor + the streaming worker
          # mid-turn (surfaces as "Response interrupted" while Proxmox/DB still
          # show the VM "running"; canary fixturenodea, 2026-06-02). It also strangled
          # the backup/cron jobs that run inside this container. System
          # containers shouldn't be sub-capped below the VM they run in.
          cpus: "${cpu}"
          memory: ${ramCeilingMb}M
    healthcheck:
      # The default profile must expose the API server on :8642 for WebUI chat,
      # cron controls, and /api/health/agent. PID 1 being alive is not enough:
      # a stuck supervisor can leave gateway_state.json fresh-but-"starting"
      # while no API server is reachable.
      # gateway-api-health
      test:
        - CMD
        - python
        - -c
        - "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8642/health', timeout=3).read()"
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 120s
    init: true

  # NOTE: The legacy chat-durability sidecar service was removed. The
  # WebUI fork no longer ships the sidecar Python module, so the
  # container crashlooped on every VM with "No module named sidecar".
  # The iframe surface does not require cursor-resumable SSE. The
  # Caddyfile route that used to proxy chat-jobs traffic to this
  # container is likewise removed; dashboard-side health probes in
  # lib/webui/client.ts tolerate the missing endpoint.

  # Official upstream Hermes dashboard. This is intentionally separate from
  # the custom WebUI service on 8787: the dashboard button should expose the
  # real Hermes dashboard surface, including the upstream Chat/TUI tab.
  official-dashboard:
    image: ${p.agentImage}
    container_name: ${p.containerName}-official-dashboard
    # Run as uid 1024 — the SAME user as the gateway service above — because
    # this container shares the webui-state volume (/home/hermes/.hermes) rw
    # with the gateway. The official dashboard owns the cron-management UI, so
    # when an owner edits a scheduled job it writes ~/.hermes/cron/jobs.json.
    # Running as root left that file root-owned, and the gateway (uid 1024)
    # then crash-logged "IOError reading jobs.json: [Errno 13] Permission
    # denied" every cron tick and lost/recovered schedule state — re-firing a
    # job and double-delivering to the end user (incident 2026-06-12, inst
    # fixturecase21). Pinning the writer to 1024 keeps every file in the shared
    # volume owned by 1024 so the gateway can always read its own cron state.
    user: "1024:1024"
${agentDockerGroupAdd}    # Bypass the image's s6/main-wrapper entrypoint for this auxiliary surface.
    # The wrapper expects /opt/data and is meant for the main agent runtime;
    # running it here either crashloops under Docker init or exits after
    # failing to cd. The Hermes CLI venv entrypoint is present in the image and
    # has the Python deps needed to serve the dashboard directly. Gate the
    # dashboard process on the gateway's real health on EVERY container start.
    # Compose depends_on only applies when Compose creates services; Docker's
    # unless-stopped boot recovery does not honour it, which previously let VM
    # stop/start recreate the dashboard deadlock.
    entrypoint: ["/bin/sh", "-c"]
    # NOTE: do NOT pass --tui here. Upstream moved --tui to a top-level chat flag
    # (hermes --tui ... = launch the modern TUI); the dashboard subcommand rejects
    # it ("unrecognized arguments: --tui") and the container crash-loops. The
    # dashboard server does not need it. (Incident 2026-06-05: an Aeon upstream
    # sync shipped this CLI change and crashed the live dashboard.)
    command:
      - |
        echo "[official-dashboard] waiting for gateway health before startup"
        dashboard_gateway_attempt=0
        until curl -fsS --max-time 3 http://${p.containerName}-gateway:8642/health >/dev/null 2>&1; do
          dashboard_gateway_attempt=$$((dashboard_gateway_attempt + 1))
          if [ "$$dashboard_gateway_attempt" -ge 90 ]; then
            echo "[official-dashboard] gateway did not become ready after 90 probes; startup failed" >&2
            exit 1
          fi
          sleep 2
        done
        exec /opt/hermes/.venv/bin/hermes dashboard --host 0.0.0.0 --port 9119 --no-open --insecure
    restart: unless-stopped
    env_file: .env
    environment:
      - HERMES_HOME=/home/hermes/.hermes
      - HERMES_WRITE_SAFE_ROOT=${WEBUI_HERMES_WRITE_SAFE_ROOTS}
      - HOME=/home/hermes
      - GATEWAY_HEALTH_URL=http://${p.containerName}-gateway:8642
      - HERMES_DASHBOARD_TUI=1
      # Do NOT set HERMES_DASHBOARD_TRUST_PROXY here. In the current agent
      # runtime that variable is not merely a forwarded-header trust switch:
      # it disables app.state.auth_required and hands authentication entirely
      # to the reverse proxy. The sidecar's password login would still mint
      # cookies in that mode, but the dashboard would ignore them and reject
      # /api/auth/ws-ticket, breaking every chat WebSocket. Keep the hardened
      # cookie gate active; uvicorn enables proxy headers for gated binds.
      # Pin the dashboard web_server's session-token bearer to the per-instance
      # webuiPassword (= API_SERVER_KEY). Without this, web_server.py mints a
      # random token.urlsafe per process start, which nothing outside the
      # container can know. Pinning it lets a remote client (Nous Hermes
      # Desktop in "remote gateway" mode) authenticate to /desktop/api/* with a
      # token the dashboard can hand the instance owner. Same value the edge
      # Caddy /desktop route checks as the bearer, so one token satisfies both
      # the edge and the web_server auth layers.
      - HERMES_DASHBOARD_SESSION_TOKEN=${p.webuiPassword}
      # Bundled "basic" password provider creds, inline in compose (not only in
      # .env). The June-2026 auth hardening FAILS CLOSED with no provider, so the
      # creds must survive every writer of the instance-dir .env. A compose
      # environment entry overrides env_file and no .env writer touches
      # docker-compose.yml, so this inline copy is authoritative and durable.
      # (The .env copy is itself kept correct across redeploys by the update-path
      # re-seed in canary #542 / prod #602 — which is what actually fixed the
      # 2026-07 fleet-wide strip; this inline block is defence-in-depth on top,
      # justified because these are per-instance auth creds.) The sidecar logs in
      # with USERNAME + API_SERVER_KEY (== the PASSWORD here). See
      # dashboardBasicAuthEnvLines.
${dashboardBasicAuthEnvLines(p.webuiPassword).map((line) => `      - ${line}`).join("\n")}
${WEBUI_PERSISTENT_INSTALL_ENV_LINES.map((line) => `      - ${line}`).join("\n")}
    # Both services share Hermes state. Starting the dashboard while the
    # gateway is still initialising can deadlock the dashboard server (it binds
    # 9119 but never answers HTTP). Its own entrypoint waits for gateway health,
    # including on VM restart. Keep Compose
    # free to start the waiting container: a service_healthy dependency could
    # strand it in Created when a slow gateway outlives the compose-up timeout.
    depends_on:
      - gateway
    volumes:
      - ./runtime-passwd:/etc/passwd:ro
      - webui-state:/home/hermes/.hermes
      - webui-workspace:/workspace
${agentDockerSocketMount}    expose:
      - "9119"
    networks:
      - hermes_net
    deploy:
      resources:
        limits:
          # Match the webui surface limits: /dashboard and /webui are
          # alternate entry points to the same VM; whichever one the user is on
          # should be allowed to use the full tier ceiling. The previous
          # hardcoded 0.5/768M throttled this container on every tier, making
          # the official dashboard feel slow even on paid VMs with 4 CPUs free.
          cpus: "${cpu}"
          memory: ${ramCeilingMb}M
    healthcheck:
      test: ["CMD", "curl", "-fsS", "--max-time", "3", "http://127.0.0.1:9119/api/status"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 120s

  # Browser handoff sidecar for the official dashboard link. WebUI's edge
  # Caddy rejects normal browser requests unless they carry the bearer token,
  # and redirects cannot attach Authorization headers. This sidecar reuses the
  # legacy signed /dashboard-login flow: Hermes Deploy redirects owners to a
  # short-lived HMAC URL, the sidecar sets an HttpOnly browser cookie, and
  # Caddy proxies that cookie-backed browser session to the official dashboard
  # without exposing the bearer in the URL or page source.
  dashboard-sidecar:
    image: node:22-alpine
    container_name: ${p.containerName}-dashboard-sidecar
    restart: unless-stopped
    working_dir: /opt/data
    # Sidecar shells out to "docker exec" for terminal/OAuth/profile flows
    # (see sidecar-script.ts). node:22-alpine ships without a docker CLI or
    # Python PTY runtime, so install both at boot, not during a user's terminal
    # start, and mount the host socket. Mirrors the
    # Hetzner sidecar in hetzner-instance-builders.ts.
    #
    # This container must stay root (apk add + the root-owned docker.sock),
    # so it cannot simply be pinned to uid 1024 like the dashboard above. It
    # also mounts webui-state (/home/hermes/.hermes) rw, so instead it heals
    # ownership back to 1024 on every boot — first thing, before anything
    # else writes — so a redeploy onto the new compose also repairs any box
    # that already has root-owned cron/.env/profile files left over from the
    # pre-fix dashboard (incident 2026-06-12). chown is best-effort: a failure
    # (e.g. nothing to repair) must never block the sidecar from starting.
    command: >
      sh -c "
      chown -R 1024:1024 /home/hermes/.hermes 2>/dev/null || true;
      apk add --no-cache docker-cli ca-certificates python3 2>/dev/null;
      node /opt/data/server.js
      "
    environment:
      - INSTANCE_ID=${p.instanceId}
      - API_SERVER_KEY=${p.webuiPassword}
      # Enables the sidecar's gated-dashboard auth bridge: it logs into the
      # official dashboard's bundled "basic" provider with this username + the
      # API_SERVER_KEY as the password, caches the gated session, and forwards
      # it so the token-only SPA authenticates against the hardened (gated)
      # dashboard. Must match HERMES_DASHBOARD_BASIC_AUTH_USERNAME in .env.
      - DASHBOARD_BASIC_AUTH_USERNAME=${DASHBOARD_BASIC_AUTH_USERNAME}
      - DASHBOARD_UPSTREAM_URL=http://${p.containerName}-official-dashboard:9119
      - WEBUI_TERMINAL_UPSTREAM_URL=http://${p.containerName}-official-dashboard:9119
      - HOST_PROFILES_DIR=/home/hermes/.hermes/profiles
      - MAIN_ENV_FILE=/home/hermes/.hermes/.env
      - TERMINAL_CWD=/workspace
      - TERMINAL_SHELL_CWD=/workspace
      - TERMINAL_TUI_CWD=/workspace
    volumes:
      - ./sidecar_server.js:/opt/data/server.js:ro
      - ./.env:/opt/data/.env:ro
      - webui-state:/home/hermes/.hermes
      - webui-workspace:/workspace
      - /var/run/docker.sock:/var/run/docker.sock
    expose:
      - "9090"
    networks:
      - hermes_net
    healthcheck:
      test: ["CMD", "node", "-e", "const http=require('http');const req=http.get('http://127.0.0.1:9090/dashboard-logout',res=>process.exit(res.statusCode&&res.statusCode<500?0:1));req.on('error',()=>process.exit(1));req.setTimeout(2000,()=>{req.destroy();process.exit(1);});"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 15s
    init: true
${browserSidecarServiceBlock}
networks:
  hermes_net:
    external: true

volumes:
  webui-state:
    name: ${p.containerName}_webui-state
  webui-workspace:
    name: ${p.containerName}_webui-workspace
  agent-source:
    name: ${p.containerName}_agent-source
${browserSidecarVolumeBlock}`;
}

// ── Caddyfile ──────────────────────────────────────────────────────────
function buildPublicCaddySiteLabel(fqdn: string): string {
  return fqdn === "localhost" ? ":80" : fqdn;
}

export function buildWebUICaddyfile(
  fqdn: string,
  containerName: string,
  bearerToken: string,
  opts: { browserSidecarEnabled?: boolean; instanceId?: string } = {},
): string {
  // HermesOS webui-free surface: file_server the tokenless rich-chat + dashboard
  // bundles from the instance dir (the caddy container mounts /opt/hermes/instances
  // read-only; the bootstrap extracts webchat_dist + dash there). Empty when no
  // instanceId (keeps older call sites byte-identical).
  const instanceDir = opts.instanceId ? `/opt/hermes/instances/${opts.instanceId}` : "";
  const browserSidecarEnabled = opts.browserSidecarEnabled === true;
  // Browser sidecar live view. Same-origin /vnc/ route (the proven box-tunnel
  // mechanism) — noVNC static + websockify
  // served on the instance's own origin, gated by the per-instance VNC password
  // the sidecar derives. No signed URL, no forward_auth, no cross-origin ESM
  // through a separate /browser-sidecar/novnc path (that layered approach was
  // fragile). The dashboard's /vnc/ RFB viewer (gatewayBase + VNC password)
  // connects here. The agent itself drives this Chrome over CDP separately.
  const browserSidecarNovncBlock = browserSidecarEnabled
    ? `
  # Live browser view: noVNC + websockify for the sidecar's Chrome on :6080.
  #   /vnc/core/rfb.js  — noVNC ESM (CORS-open so the dashboard viewer imports it)
  #   /vnc/websockify   — RFB websocket (VNC-password gated by the sidecar)
  handle_path /vnc/* {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Allow-Methods "GET, OPTIONS"
    header Access-Control-Allow-Headers "Content-Type"
    reverse_proxy ${containerName}-browser-sidecar:6080 {
      header_up -Origin
      flush_interval -1
    }
  }
`
    : "";
  // Cookie import: the dashboard POSTs a user-exported cookie file here
  // server-side (bearer = webuiPassword, same credential the rest of the
  // per-instance API uses) and the sidecar loads it into the agent's persistent
  // browser context. Exact path only — we expose just this one tool endpoint of
  // :8789, not the whole tool API.
  const browserSidecarCookieBlock = browserSidecarEnabled
    ? `
  handle /browser-sidecar/cookies/import {
    rewrite * /cookies/import
    reverse_proxy ${containerName}-browser-sidecar:${BROWSER_SIDECAR_INTERNAL_PORT} {
      header_up -Origin
    }
  }
`
    : "";
  // Caddy enforces auth at the edge. Without this, every request reached
  // WebUI's Python ThreadingHTTPServer + GIL-bound auth pipeline (`/health`
  // alone was timing 5+ s under contention in production). Caddy is Go +
  // async, so a header check is sub-millisecond and never blocks WebUI.
  //
  // `webuiPassword` is reused as the bearer token: it's already random
  // per-instance, already encrypted at rest in Supabase, and the dashboard
  // already sends it. No new credential to manage.
  //
  // HermesOS webui-free surface. file_server the TOKENLESS rich-chat + dashboard
  // bundles from the instance dir (bootstrap extracts them there; caddy mounts
  // /opt/hermes/instances read-only). The client reads #iframe_token and talks
  // to /desktop. NOT a mount_webchat proxy — that injects the bearer into the
  // HTML and would leak it on a public route. First-match-wins claims /,
  // /webchat, /dash, /desktop, and the Desktop Web browser-history document
  // routes before the legacy official-dashboard @public routes below.
  const webfreeBlock = instanceDir
    ? `
  handle /dash/api* {
    # The admin bundle is rooted at /dash, but the dashboard API itself is
    # rooted at /api. Strip only /dash here. Using handle_path /dash/api* would
    # strip the full /dash/api matcher prefix and incorrectly send /sessions
    # upstream instead of /api/sessions.
    uri strip_prefix /dash
    # The sidecar enforces the full dashboard auth contract here, including
    # cookie, bearer, X-Hermes-Session-Token, and query-token clients, then
    # attaches the gated upstream session cookie.
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      header_up -Origin
      lb_try_duration 30s
      lb_try_interval 1s
    }
  }
  @dashPluginAssets path /dash/dashboard-plugins /dash/dashboard-plugins/*
  handle @dashPluginAssets {
    uri strip_prefix /dash
    reverse_proxy ${containerName}-official-dashboard:9119 {
      header_up -Origin
      lb_try_duration 30s
      lb_try_interval 1s
    }
  }
  handle_path /webchat* {
    root * ${instanceDir}/webchat
    try_files {path} /index.html
    file_server
  }
  handle_path /dash* {
    root * ${instanceDir}/dash
    try_files {path} /index.html
    file_server
  }
  @hermesRoot path /
  handle @hermesRoot {
    root * ${instanceDir}/webchat
    file_server
  }
  # Hermes Desktop Web is built with a root-level browser-history router. Its
  # tokenless entry document lives at /webchat, but after mounting it navigates
  # to document paths such as /sessions and /chat. Keep those documents on the
  # webchat bundle. Falling through to the legacy @publicHtml handler below
  # serves the official-dashboard SPA instead, silently replacing Desktop Web
  # with the admin panel. /dash remains the explicit admin namespace; API,
  # sidecar, and native Desktop gateway paths stay protected/proxied below.
  @hermesDesktopDocument {
    method GET
    header_regexp Accept ".*text/html.*"
    not path /dash* /api* /_sidecar* /web-api* /browser-sidecar* /v1* /mcp* /acp* /desktop*
  }
  handle @hermesDesktopDocument {
    root * ${instanceDir}/webchat
    rewrite * /index.html
    file_server
  }
  # NOTE: the /desktop matchers + handlers are deliberately NOT redeclared in
  # this webfree block. The main site block below already defines
  # @desktopHeaderToken / @desktopBearer / @desktopQueryToken /
  # @desktopUnauthed plus the public /desktop/api/status passthrough.
  # Redeclaring them here produced DUPLICATE named matchers in the same site
  # block, which Caddy rejects with a fatal "named matcher already defined"
  # error at \`caddy validate\` time — so the entire edge config failed to load
  # on every webfree provision (regression from the #104 webui-free cutover).
  # The /dash/api handler above gives the embedded admin bundle the same
  # dashboard-session-cookie auth as the top-level official dashboard handoff.
  # Plugin assets are different: the dashboard loads
  # them with script/link tags that cannot send auth headers, so
  # @dashPluginAssets proxies only browser-loadable plugin assets directly to
  # the official dashboard's suffix-allowlisted asset route.
`
    : "";
  return `${buildPublicCaddySiteLabel(fqdn)} {
  # Compression is selectively applied: enabled for non-streaming paths
  # (static assets, JSON API responses, HTML — meaningful bandwidth wins
  # especially on Hetzner-direct deployments where this IS the edge
  # Caddy), explicitly disabled for SSE paths.
  #
  # Why exclude SSE: gzip/zstd's encoder buffers response bytes until it
  # has enough to emit a compressed block efficiently. That buffering
  # defeats reverse_proxy's flush_interval -1 — chat tokens accumulate in
  # the encoder's buffer instead of streaming to the browser, so the
  # response arrives as a single block at end-of-stream. Same root cause
  # the OUTER host Caddy patched in commit 1d66dd4f for Proxmox (it
  # dropped 'encode gzip' entirely there because it only proxies chat
  # traffic, so the bandwidth trade was negligible). Inner Caddy serves
  # the whole agent surface (UI bundle + auth probes + chat + tool API),
  # so we keep compression on for everything that isn't SSE.
  #
  # Path list: /api/chat/stream is the main SSE endpoint. /api/chats/
  # stream is the legacy alias rewritten below — match it BEFORE the
  # rewrite directive sees it (Caddyfile matchers run on request as
  # received). /api/chat-jobs/<id>/events is the durability sidecar's
  # cursor-resumable SSE — same buffering concern, so excluded too.
  # Any future SSE path additions need to be added here too.
  @sseStream path /api/chat/stream* /api/chats/stream* /api/chat-jobs/*
  @notSseStream not path /api/chat/stream* /api/chats/stream* /api/chat-jobs/*
  encode @notSseStream zstd gzip

  # Iframe embedding: strip webui Python's X-Frame-Options DENY and pin
  # frame-ancestors to exact dashboard origins (no wildcard).
  # canary.hermesos.cloud added so the canary dashboard can embed agents
  # provisioned by the canary environment. hivra.cloud added (Phase 0 of the
  # domain cutover) so the rebranded frontend can embed agents while the backend
  # stays on agents.hermesos.cloud. Safe to merge upstream — it just widens the
  # allowlist; prod simply never serves frames from an origin it doesn't use.
  header {
    -X-Frame-Options
    Content-Security-Policy "frame-ancestors 'self' https://hermesos.cloud https://dashboard.hermesos.cloud https://canary.hermesos.cloud https://hivra.cloud https://www.hivra.cloud"
  }

  @legacyChatStart path /api/chats/start
  rewrite @legacyChatStart /api/chat/start
  @legacyChatStream path /api/chats/stream
  rewrite @legacyChatStream /api/chat/stream
  @legacyChatStreamStatus path /api/chats/stream/status
  rewrite @legacyChatStreamStatus /api/chat/stream/status
  @legacyChatCancel path /api/chats/cancel
  rewrite @legacyChatCancel /api/chat/cancel
  @legacyChatSteer path /api/chats/steer
  rewrite @legacyChatSteer /api/chat/steer

  @options method OPTIONS
  handle @options {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Allow-Methods "GET, POST, OPTIONS"
    header Access-Control-Allow-Headers "Content-Type, Authorization, x-hermes-trace-id"
    header Access-Control-Max-Age "3600"
    respond 204
  }

  handle_path /_sidecar* {
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      lb_try_duration 10s
      lb_try_interval 1s
    }
  }

  # Nous Hermes Desktop "remote gateway" mode. The native desktop app points at
  # https://<fqdn>/desktop and proxies the upstream hermes-dashboard backend
  # (official-dashboard:9119): /desktop/api/* over HTTPS with an
  # "Authorization: Bearer <webuiPassword>" header, and
  # /desktop/api/ws?token=<webuiPassword> for the gateway WebSocket (WS clients
  # can't set the header, so the token rides in the query string — same dual
  # bearer/query pattern the chat routes use below). This is a DISTINCT surface
  # from the bearer-authed /api/* routes that proxy to the webui chat app:
  # Desktop speaks the upstream hermes-dashboard contract, which only the
  # official-dashboard service serves. strip_prefix /desktop so the backend sees
  # /api/status, /api/ws, etc. Placed before the header-only @authBearer/@public
  # handlers so a /desktop request is always claimed here (handle is
  # first-match-wins, source order preserved).
  # Auth comes in three forms and ALL must be accepted:
  #   - X-Hermes-Session-Token: <tok>  → the Desktop app's HTTP requests
  #     (apps/desktop/electron/main.cjs fetchJson sends this header, NOT
  #     Authorization: Bearer — missing it = every Desktop HTTP probe 401s).
  #   - ?token=<tok>                    → the Desktop gateway WebSocket
  #     (buildGatewayWsUrl; WS clients can't set headers).
  #   - Authorization: Bearer <tok>     → curl / generic REST clients.
  @desktopHeaderToken {
    path /desktop /desktop/*
    header X-Hermes-Session-Token "${bearerToken}"
  }
  @desktopBearer {
    path /desktop /desktop/*
    header Authorization "Bearer ${bearerToken}"
  }
  @desktopQueryToken {
    path /desktop /desktop/*
    query token=${bearerToken}
  }
  handle @desktopHeaderToken {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Expose-Headers "Content-Type, X-Stream-Id, X-Session-Id"
    uri strip_prefix /desktop
    # Routed through the sidecar (not official-dashboard directly): the hardened
    # image gates the dashboard, so the sidecar swaps this SPA token for a real
    # gated session cookie before forwarding. See buildWebUICompose / sidecar-script.
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      header_up -Origin
      flush_interval -1
      lb_try_duration 30s
      lb_try_interval 1s
    }
  }
  handle @desktopBearer {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Expose-Headers "Content-Type, X-Stream-Id, X-Session-Id"
    uri strip_prefix /desktop
    # Sidecar translates the SPA Bearer → gated session cookie (hardened image).
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      header_up -Origin
      flush_interval -1
      lb_try_duration 30s
      lb_try_interval 1s
    }
  }
  handle @desktopQueryToken {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Expose-Headers "Content-Type, X-Stream-Id, X-Session-Id"
    uri strip_prefix /desktop
    # Carries the SPA's ?token= WebSocket (and EventSource) upgrades. The sidecar
    # terminates the WS, mints a dashboard ws-ticket, and re-dials the gated
    # dashboard — so /api/ws works under the hardened image.
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      header_up -Origin
      flush_interval -1
      lb_try_duration 30s
      lb_try_interval 1s
    }
  }
  # The native Desktop app's FIRST move on a remote gateway is an
  # UNAUTHENTICATED probe of the gateway's public /api/status, to discover the
  # auth method ("token" vs OAuth) before the user has submitted a token
  # (apps/desktop settings/gateway-settings.tsx — "the auth method will appear
  # once it responds"). The upstream hermes-dashboard serves /api/status
  # publicly (see the official-dashboard healthcheck, which curls it with no
  # token). If we 401 that probe, the app reports "Could not reach this
  # gateway" and never shows the token field. So let exactly that one public
  # discovery path through unauthenticated; everything else stays gated below.
  @desktopPublicStatus {
    path /desktop/api/status
    method GET HEAD
  }
  handle @desktopPublicStatus {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Expose-Headers "Content-Type, X-Stream-Id, X-Session-Id"
    uri strip_prefix /desktop
    reverse_proxy ${containerName}-official-dashboard:9119 {
      header_up -Origin
      lb_try_duration 30s
      lb_try_interval 1s
    }
  }
  # Unauthenticated /desktop request — reject at the edge before it can reach
  # the backend (don't fall through to the webui chat handlers).
  @desktopUnauthed path /desktop /desktop/*
  handle @desktopUnauthed {
    respond 401
  }
${browserSidecarNovncBlock}
${browserSidecarCookieBlock}
${webfreeBlock}
  # Generated images come back from hermes-agent as absolute cache paths in
  # markdown, e.g. /home/hermes/.hermes/cache/images/foo.png. Browsers
  # cannot read container-local files, so route those paths to the sidecar,
  # which serves only authenticated image files from the mounted state volume.
  @generatedImagePath path /home/hermes/.hermes/cache/images/*
  handle @generatedImagePath {
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      lb_try_duration 10s
      lb_try_interval 1s
    }
  }
  @generatedProfileImagePath path_regexp generated_profile_image ^/home/hermes/\\.hermes/profiles/[A-Za-z0-9_-]+/cache/images/.+$
  handle @generatedProfileImagePath {
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      lb_try_duration 10s
      lb_try_interval 1s
    }
  }

  # Public endpoints — no auth required.
  # The root path / MUST be public so the SPA shell HTML loads — the
  # iframe-shim.js inside that HTML reads the bearer from location.hash
  # and patches fetch/XHR/SSE/WS to inject it on subsequent requests.
  # Without / in this list, the iframe gets 401 on the initial HTML load
  # and the browser shows a blank screen. (Fleet-wide blocker discovered
  # 2026-05-11 when every webui iframe started returning 401.)
  # /assets/* (the Vite JS/CSS bundles the shell references) must be public
  # for the same reason: script/link subresource loads cannot carry the
  # hash bearer, so a browser without the hermes_webui_session cookie
  # (third-party-cookie blocking, privacy extensions) 401s the bundle and
  # the SPA never mounts — same blank screen, one level deeper. The
  # upstream app serves /assets/* unauthenticated anyway.
  # Dashboard probes the rest unauth'd to detect liveness + onboarding.
  @public path / /health /api/auth/status /favicon.ico /favicon.svg /static/* /assets/* /login

  # SPA document navigations/reloads must also receive the public HTML shell:
  # hash-token auth only patches fetch/XHR/SSE/WS after the document loads,
  # so a browser navigation to /sessions, /settings, etc. cannot carry the
  # Authorization header. Keep data surfaces excluded so APIs remain bearer
  # or cookie-authenticated.
  @publicHtml {
    method GET
    header_regexp Accept ".*text/html.*"
    not path /api* /_sidecar* /web-api* /browser-sidecar* /v1* /mcp* /acp*
  }

  @dashboard_browser {
    header Cookie *hermes_dashboard_session=*
  }

  @webui_browser {
    header Cookie *hermes_webui_session=*
  }

  # Authenticated requests carry the API key as a bearer token. Caddy
  # validates here so the request never enters WebUI's Python auth path.
  @authBearer header Authorization "Bearer ${bearerToken}"

  # Same auth, query-string form. Used by EventSource and WebSocket which
  # cannot set the Authorization header from JS. The iframe-shim appends
  # "?token=<bearer>" to SSE/WS URLs (see hermes-webui/static/iframe-shim.js,
  # comment "@authQueryToken query token=<bearer> matcher for SSE auth to
  # land"). Without this matcher, EventSource on /api/chat/stream falls
  # through every other matcher and hits the 401 catch-all, surfacing as
  # "Error: Connection lost" in the chat. Order matters: this lives next
  # to @authBearer and its handle must precede the catch-all.
  @authQueryToken query token=${bearerToken}

  # NOTE: /api/chat/start is not gated at this layer. The former
  # hermes-warden compute-cap gate was decommissioned fleet-wide (2026-07).
  handle @public {
    reverse_proxy ${containerName}-official-dashboard:9119 {
      flush_interval -1
    }
  }

  handle @publicHtml {
    rewrite * /
    reverse_proxy ${containerName}-official-dashboard:9119 {
      flush_interval -1
    }
  }

  handle @dashboard_browser {
    forward_auth ${containerName}-dashboard-sidecar:9090 {
      uri /dashboard-session-check
      header_up Cookie {http.request.header.Cookie}
    }
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      header_up -Origin
      flush_interval -1
    }
  }

  handle @webui_browser {
    forward_auth ${containerName}-dashboard-sidecar:9090 {
      uri /webui-session-check
      header_up Cookie {http.request.header.Cookie}
    }
    # Proxy via the sidecar so it attaches the gated session cookie upstream.
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      lb_try_duration 30s
      lb_try_interval 1s
      header_up -Origin
      flush_interval -1
    }
  }

  # NOTE: The chat-jobs route used to proxy to a Python sidecar
  # container for cursor-resumable SSE. The fork dropped that module,
  # so the route and its container are no longer emitted. Requests to
  # /api/chat-jobs/(any) now fall through to the @authBearer handler
  # below and 404 against the WebUI (cleanly, vs. 502 from a
  # crashlooping container). The dashboard's chat-jobs client probes
  # handle 404 as "sidecar unavailable" and skip the resume path.

  handle @authBearer {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Expose-Headers "Content-Type, X-Stream-Id, X-Session-Id"
    # Sidecar translates the bearer → gated session cookie (hardened image).
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      lb_try_duration 30s
      lb_try_interval 1s
      header_up -Origin
      flush_interval -1
    }
  }

  # EventSource / WebSocket auth via ?token= query param. See the
  # @authQueryToken matcher comment above for the why. Same upstream as
  # @authBearer; flush_interval -1 keeps SSE chunks streaming byte-by-byte.
  handle @authQueryToken {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Expose-Headers "Content-Type, X-Stream-Id, X-Session-Id"
    # Sidecar translates the ?token= request (SSE/WS) → gated session upstream.
    reverse_proxy ${containerName}-dashboard-sidecar:9090 {
      lb_try_duration 30s
      lb_try_interval 1s
      header_up -Origin
      flush_interval -1
    }
  }

  handle {
    respond 401
  }
}
`;
}

// ── docker-compose .env (provider keys, no password) ──────────────────

/**
 * Resolve the canonical OAuth provider id for the WebUI's first-launch gate,
 * or null when no OAuth handshake is required. Read by the in-VM WebUI as
 * `HERMES_OAUTH_PROVIDER`; the WebUI auto-opens its embedded terminal and
 * runs `hermes auth add <provider> --type oauth` on first launch when this
 * is set and the agent has no auth.json yet.
 *
 * Detection precedence:
 *  - openai-codex (Code Explorer): intentionally excluded. Codex/ChatGPT
 *    auth uses the dashboard-managed device-code flow, which does not depend
 *    on WebUI chat or terminal state and avoids brittle browser callbacks.
 *  - nous (Nous Portal Auth): the dashboard stores `provider="nous"` but the
 *    inferenceProvider collapses to `custom` for OpenAI-compatible routing,
 *    so the dashboardProvider field is the authoritative signal.
 *  - All other providers (api-key-based): null.
 */
function resolveOAuthProvider(p: WebUIDeployParams): string | null {
  if (p.inferenceProvider === "xai-oauth") return "xai-oauth";
  const dash = (p.dashboardProvider ?? "").trim().toLowerCase();
  if (dash === "nous") return "nous";
  if (dash === "xai-oauth" || dash === "grok-oauth") return "xai-oauth";
  return null;
}

// Maps a hermes-side inference provider name to the env var the agent reads
// for that provider's API key. Mirrors the inverse of buildProviderEnv() in
// hetzner-instance-builders.ts. `openai-codex` returns null because that
// provider authenticates via OAuth/auth.json, not an env var key.
function providerApiKeyEnvVarName(inferenceProvider: string): string | null {
  switch (inferenceProvider) {
    case "openai": return "OPENAI_API_KEY";
    case "openrouter": return "OPENROUTER_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "deepseek": return "DEEPSEEK_API_KEY";
    case "minimax": return "MINIMAX_API_KEY";
    case "kimi-coding": return "KIMI_API_KEY";
    case "zai": return "GLM_API_KEY";
    case "alibaba": return "DASHSCOPE_API_KEY";
    case "xiaomi": return "XIAOMI_API_KEY";
    case "custom": return "OPENAI_API_KEY";
    case "openai-codex": return null;
    case "xai-oauth": return null;
    default: return null;
  }
}

function providerAliasKeyEnvLines(p: WebUIDeployParams): string[] {
  if (!p.llmApiKey) return [];
  if (p.dashboardProvider === "gemini") {
    return [`GEMINI_API_KEY=${p.llmApiKey}`];
  }
  return [];
}

export function buildWebUIComposeEnv(p: WebUIDeployParams): string {
  // Intentionally NOT setting HERMES_WEBUI_PASSWORD: auth is enforced at
  // Caddy now (see buildWebUICaddyfile). WebUI itself runs without auth so
  // requests skip its Python auth pipeline (~1.3s/req under GIL contention).
  // Caddy validates the same per-instance bearer token before requests
  // ever reach WebUI, so the security posture is preserved.
  // HERMES_DASHBOARD_URL + API_SERVER_KEY are required by the `ru` shell
  // function in buildInstanceUpdateReporterShell: without them in this
  // outer .env, the in-VM "update succeeded/failed" callback silently
  // no-ops and the dashboard never learns the redeploy completed —
  // leaving rows stuck at status="redeploying" until someone visits
  // the dashboard. Mirrors what hetzner-instance-builders.ts writes.
  const dashboardUrl =
    env("NEXT_PUBLIC_APP_URL", "https://hivra.cloud").replace(/\/+$/, "");
  const lines: string[] = [
    "# Generated by Hermes Deploy — do not edit by hand",
    // Clean-slate BYOK (deploy-card Managed=OFF): omit HERMES_INFERENCE_PROVIDER
    // and the default-model line so the compose env seeds no provider — the
    // agent boots unconfigured and its native onboarding overlay fires.
    ...(p.unconfigured
      ? []
      : [
          `HERMES_INFERENCE_PROVIDER=${p.inferenceProvider}`,
          `HERMES_WEBUI_DEFAULT_MODEL=${resolveWebUIRuntimeDefaultModel(p)}`,
        ]),
    `HERMES_DASHBOARD_URL=${dashboardUrl}`,
    `API_SERVER_KEY=${p.webuiPassword}`,
    // Consumed by the hivra_approval_relay agent plugin, which POSTs blocked
    // approvals to HERMES_DASHBOARD_URL/api/internal/agent-notify with the
    // API_SERVER_KEY above as its bearer. The plugin runs inside
    // official-dashboard — the container that serves the workspace iframe's
    // /api/ws and therefore owns the blocking approval wait. That service reads
    // this file via `env_file: .env` but does NOT get the `environment:` block
    // where the gateway service declares HERMES_INSTANCE_ID, so the id has to
    // live here to reach both.
    `HERMES_INSTANCE_ID=${p.instanceId}`,
    // Bundled "basic" password provider for the official dashboard. The
    // June-2026 auth hardening gates every non-loopback dashboard bind
    // (--insecure is now a no-op) and FAILS CLOSED with no provider registered,
    // so the dashboard must configure one or official-dashboard crash-loops. The
    // dashboard-sidecar logs in headlessly (POST /auth/password-login) with
    // these creds and forwards the resulting gated session upstream, so the
    // token-only webfree SPA keeps working without an unauthenticated public
    // dashboard. Password = the per-instance webuiPassword (already the shared
    // per-box secret); SECRET is derived from it so sessions survive restarts.
    // Also lives in .env (read via env_file), kept correct across redeploys by
    // the update-path re-seed (canary #542 / prod #602). The AUTHORITATIVE copy
    // is inline in the compose `environment:` of both the gateway and
    // official-dashboard services, which overrides env_file and survives any
    // rewrite of .env. See dashboardBasicAuthEnvLines.
    ...dashboardBasicAuthEnvLines(p.webuiPassword),
    // Bearer the agent's browser_sidecar tool client sends with every
    // /goto, /click_text, /fill, etc. The sidecar gates tool routes on
    // SIDECAR_AUTH_TOKEN (see services/browser-sidecar/src/auth/bearer.ts).
    // Both sides use the same per-instance webuiPassword so a redeploy
    // rotates them in lockstep. Sidecar runs in warn-only mode when its
    // own SIDECAR_AUTH_TOKEN is unset, so an out-of-sync fleet still
    // works during rollout.
    `HERMES_BROWSER_SIDECAR_AUTH_TOKEN=${p.webuiPassword}`,
    // Agent↔sidecar CDP bridge: point the agent's generic `browser` toolset at
    // the sidecar's persistent CDP Chromium so it drives the same browser the
    // live noVNC view shows. On by default for every sidecar-enabled instance.
    // Kept in both env files (like the token above) so the secrets-sync overlay
    // can't drop it on restart.
    ...(agentBrowserCdpEnabled() && p.browserSidecarEnabled
      ? [
          `BROWSER_CDP_URL=http://${p.containerName}-browser-sidecar:${AGENT_CDP_PROXY_PORT}`,
          // CDP mode drives the agent's NATIVE `browser` toolset over CDP. Disable
          // the agent's Vex browser_sidecar probe so it doesn't auto-register the
          // deterministic HTTP tools (browser_screenshot/_click_selector/…), which
          // 401 against the sidecar's :8789 API and duplicate the native browser.
          // tools/browser_sidecar.py::_is_sidecar_available() GETs <URL>/health and
          // fails fast on this sentinel (no schema) → toolset stays unregistered.
          `HERMES_BROWSER_SIDECAR_URL=disabled`,
        ]
      : []),
    // Forward-compat with the planned api/helpers.py fork patch; Caddy
    // already strips X-Frame-Options today. Defense in depth.
    "HERMES_WEBUI_FRAME_POLICY=ALLOWALL",
  ];
  // First-launch OAuth gate signal. WebUI's onboarding.py reads this to
  // decide whether to auto-open its terminal and run `hermes auth add
  // <provider> --type oauth` when no auth.json exists yet. Only emit the
  // line when that terminal-driven flow is safe for the provider. Codex is
  // handled by the dashboard device-code flow instead.
  const oauthProvider = resolveOAuthProvider(p);
  if (oauthProvider) {
    lines.push(`HERMES_OAUTH_PROVIDER=${oauthProvider}`);
  }
  const trimmedAgentName = (p.agentName ?? "").trim();
  if (trimmedAgentName) {
    // Reuses WebUI's existing default-override hook so the "Assistant Name"
    // preference starts pre-filled with the name the user gave the agent.
    lines.push(`HERMES_WEBUI_BOT_NAME=${trimmedAgentName}`);
  }
  // Include the provider's API-key env var so a `docker compose up
  // --force-recreate` (eg. fleet migrations, image upgrades) doesn't silently
  // drop the key. Without this, the post-recreate container had only the
  // provider name + model name in env, so hermes-agent's first chat returned
  // "No LLM provider configured" — the exact symptom we just spent the day
  // chasing. `openai-codex` is exempt because that provider authenticates
  // via OAuth bundle stored in auth.json, not an env var.
  // Clean-slate BYOK (deploy-card Managed=OFF): never seed a provider key,
  // base_url, or venice-native env in the compose env. (p.llmApiKey is also
  // empty on this path, but guard explicitly so the intent is unambiguous and
  // a future caller passing a stray key can't accidentally re-seed it.)
  const apiKeyVarName = p.unconfigured
    ? null
    : providerApiKeyEnvVarName(p.inferenceProvider);
  if (apiKeyVarName && p.llmApiKey) {
    lines.push(`${apiKeyVarName}=${p.llmApiKey}`);
  }
  if (!p.unconfigured) {
    lines.push(...providerAliasKeyEnvLines(p));
    if (p.baseUrl && p.inferenceProvider === "custom") {
      // Custom OpenAI-compatible endpoints need OPENAI_BASE_URL alongside the key.
      // Pin managed-Venice to the live proxy domain so redeploys don't re-bake a
      // stale (pre-rebrand) host that 301s; BYO/custom URLs pass through.
      lines.push(`OPENAI_BASE_URL=${pinManagedVeniceBaseUrl(p.baseUrl, p.llmApiKey)}`);
    }
    lines.push(...buildWebUIVeniceNativeEnvLines(p));
  }
  if (!p.unconfigured && isHermesManagedVeniceEndpoint(p)) {
    lines.push(`HERMES_MANAGED_VENICE_ENABLE_URL=${managedVeniceDashboardUrl()}`);
  }
  if (p.tavilyApiKey) lines.push(`TAVILY_API_KEY=${p.tavilyApiKey}`);
  if (p.firecrawlApiKey) lines.push(`FIRECRAWL_API_KEY=${p.firecrawlApiKey}`);
  if (p.daytonaApiKey) lines.push(`DAYTONA_API_KEY=${p.daytonaApiKey}`);
  return lines.join("\n") + "\n";
}

// ── hermes-agent .env (lives inside the volume, scoped to the agent run) ─
//
// Deliberately does NOT write HERMES_MODEL. The agent CLI's `main()` loads this
// file (seeded to /state/.env = $HERMES_HOME/.env) into os.environ with
// override=True, and the official-dashboard surface resolves the chat model via
// tui_gateway/server.py `_resolve_model()`, which reads HERMES_MODEL/
// HERMES_INFERENCE_MODEL from os.environ BEFORE falling back to config.yaml.
// A model pin in this file therefore wins over config.yaml — but it is a
// provisioning-time snapshot that NEVER updates (live model switches persist to
// config.yaml via _persist_model_switch -> save_config, never to .env). So a
// stale pin (e.g. gpt-5.5) survives a provider change and forces every NEW chat
// session through _resolve_startup_runtime's static model→provider detection,
// which can resolve to a keyless provider (openai-api) → "Provider 'openai-api'
// … no API key" and the model-switch wedge. config.yaml (buildWebUIConfigYaml:
// model.default + model.provider) is the single source of truth for the model;
// with HERMES_MODEL absent, _resolve_model() reads config.yaml and
// _resolve_startup_runtime() returns the config provider (no static re-detect).
// The agent-side gateway supervisor already strips HERMES_MODEL via unset_keys;
// this keeps the official-dashboard service consistent. Existing instances whose
// persisted /state/.env still carries the pin are healed by the update-path
// scrub in buildWebUIBootstrapScript. See reference_model-picker-keyless-provider-brick.
export function buildHermesEnvFile(p: WebUIDeployParams): string {
  const bankrEnvLines = buildBankrEnvLines(p.bankr);
  const effectiveTerminalBackend = resolveWebUITerminalBackend(p);
  const gatewayApiLines = [
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
    "API_SERVER_PORT=8642",
    `API_SERVER_KEY=${p.webuiPassword}`,
    // Bearer for the agent's browser_sidecar tool client. See the same
    // line in buildWebUIComposeEnv — repeated here because the agent
    // reads its persistent runtime env from /state/.env (seeded from
    // hermes.env) and Ash's secrets-sync overlay can rewrite parts of
    // the compose-side .env between restarts. Keeping the token in
    // both files keeps it intact regardless of which one wins.
    `HERMES_BROWSER_SIDECAR_AUTH_TOKEN=${p.webuiPassword}`,
    // The dashboard used to persist terminalBackend without ever applying it
    // to WebUI/webfree agents. That left TERMINAL_ENV=local in the gateway even
    // after users selected Docker, so commands ran in the Debian gateway and
    // their configured sandbox image was never created. Keep this as a managed
    // runtime value so both fresh provisions and update-mode redeploys converge.
    `TERMINAL_ENV=${effectiveTerminalBackend}`,
    // A selected sandbox must never silently degrade to the local gateway: that
    // reports the wrong OS/filesystem and defeats the isolation the user chose.
    // Local mode explicitly disables strictness so the value is deterministic
    // when users switch back in Advanced settings.
    `TERMINAL_STRICT_BACKEND=${effectiveTerminalBackend === "local" ? "false" : "true"}`,
    // Point the agent's generic `browser` toolset at the sidecar's persistent
    // CDP Chromium (the one the live noVNC view shows) — emitted whenever the
    // instance has the Pro-tier sidecar enabled. tools/browser_tool.py reads
    // BROWSER_CDP_URL and connects over CDP; the Vex HTTP tools yield via the
    // HERMES_BROWSER_SIDECAR_URL=disabled sentinel below. Kept in both env files
    // so the secrets-sync overlay can't drop it on restart.
    ...(agentBrowserCdpEnabled() && p.browserSidecarEnabled
      ? [
          `BROWSER_CDP_URL=http://${p.containerName}-browser-sidecar:${AGENT_CDP_PROXY_PORT}`,
          // CDP mode drives the agent's NATIVE `browser` toolset over CDP. Disable
          // the agent's Vex browser_sidecar probe so it doesn't auto-register the
          // deterministic HTTP tools (browser_screenshot/_click_selector/…), which
          // 401 against the sidecar's :8789 API and duplicate the native browser.
          // tools/browser_sidecar.py::_is_sidecar_available() GETs <URL>/health and
          // fails fast on this sentinel (no schema) → toolset stays unregistered.
          `HERMES_BROWSER_SIDECAR_URL=disabled`,
        ]
      : []),
  ];

  if (p.unconfigured) {
    // Clean-slate BYOK deploy (deploy-card Managed=OFF). Ship NO inference
    // provider, NO provider key, and NO venice-native env so the agent boots
    // unconfigured and its NATIVE onboarding overlay fires
    // (_has_any_provider_configured() → false). The user picks a provider and
    // pastes a key AFTER the box is up; that write lands in config.yaml. This
    // is what kills the keyless-provider init brick — there is no half-seeded
    // provider-without-key here. Keep HERMES_SKIP_SETUP=1 (skips the agent's
    // own interactive CLI setup; the WebUI/dashboard onboarding overlay is the
    // setup surface), timezone/exec-ask, the gateway api lines, persistent
    // install env, bankr, and tavily/firecrawl.
    return [
      // HERMES_INFERENCE_PROVIDER intentionally omitted — no provider seeded.
      `HERMES_SKIP_SETUP=1`,
      `HERMES_TIMEZONE=UTC`,
      `HERMES_EXEC_ASK=false`,
      ...gatewayApiLines,
      ...WEBUI_PERSISTENT_INSTALL_ENV_LINES,
      ...bankrEnvLines,
      ...(p.tavilyApiKey ? [`TAVILY_API_KEY=${p.tavilyApiKey}`] : []),
      ...(p.firecrawlApiKey ? [`FIRECRAWL_API_KEY=${p.firecrawlApiKey}`] : []),
      ...(p.daytonaApiKey ? [`DAYTONA_API_KEY=${p.daytonaApiKey}`] : []),
    ].join("\n") + "\n";
  }

  if (p.inferenceProvider === "openai-codex" || p.inferenceProvider === "xai-oauth") {
    // OAuth-authenticated providers (Codex/ChatGPT Plus and xAI SuperGrok)
    // don't have an API key at deploy time — the user signs in via WebUI
    // after the VM comes up, which writes the token to auth.json.
    return [
      // HERMES_MODEL intentionally omitted — config.yaml owns the model (see
      // the buildHermesEnvFile header comment for the keyless-provider brick).
      `HERMES_INFERENCE_PROVIDER=${p.inferenceProvider}`,
      `HERMES_SKIP_SETUP=1`,
      `HERMES_TIMEZONE=UTC`,
      `HERMES_EXEC_ASK=false`,
      ...gatewayApiLines,
      ...WEBUI_PERSISTENT_INSTALL_ENV_LINES,
      ...bankrEnvLines,
      ...(p.tavilyApiKey ? [`TAVILY_API_KEY=${p.tavilyApiKey}`] : []),
      ...(p.firecrawlApiKey ? [`FIRECRAWL_API_KEY=${p.firecrawlApiKey}`] : []),
      ...(p.daytonaApiKey ? [`DAYTONA_API_KEY=${p.daytonaApiKey}`] : []),
    ].join("\n") + "\n";
  }

  // Determine the right env-var name for the API key based on provider.
  // hermes-agent reads keys via provider-specific env vars; OpenRouter is the
  // default for OpenAI-compatible aggregators.
  const keyVar = resolveWebUIProviderEnvVar(p.inferenceProvider);
  const lines = [
    `HERMES_INFERENCE_PROVIDER=${p.inferenceProvider}`,
    `${keyVar}=${p.llmApiKey}`,
    ...providerAliasKeyEnvLines(p),
    ...(p.baseUrl && p.inferenceProvider === "custom"
      ? [`OPENAI_BASE_URL=${pinManagedVeniceBaseUrl(p.baseUrl, p.llmApiKey)}`]
      : []),
    ...buildWebUIVeniceNativeEnvLines(p),
    // HERMES_MODEL intentionally omitted — config.yaml owns the model (see the
    // buildHermesEnvFile header comment for the keyless-provider brick).
    `HERMES_SKIP_SETUP=1`,
    `HERMES_TIMEZONE=UTC`,
    `HERMES_EXEC_ASK=false`,
    ...gatewayApiLines,
    ...WEBUI_PERSISTENT_INSTALL_ENV_LINES,
    ...bankrEnvLines,
    ...(p.tavilyApiKey ? [`TAVILY_API_KEY=${p.tavilyApiKey}`] : []),
    ...(p.firecrawlApiKey ? [`FIRECRAWL_API_KEY=${p.firecrawlApiKey}`] : []),
    ...(p.daytonaApiKey ? [`DAYTONA_API_KEY=${p.daytonaApiKey}`] : []),
  ];
  return lines.join("\n") + "\n";
}

function buildBankrEnvLines(bankr?: InstanceBankrAgentConfig | null): string[] {
  if (!bankr) return [];
  return [
    `BANKR_AGENT_WALLET_ADDRESS=${bankr.walletAddress}`,
    `BANKR_WALLET_ADDRESS=${bankr.walletAddress}`,
    `BANKR_AGENT_API_KEY=${bankr.apiKey}`,
    `BANKR_API_KEY=${bankr.apiKey}`,
    `BANKR_AGENT_WALLET_ID=${bankr.walletId}`,
    ...(bankr.withdrawalDestination
      ? [`BANKR_AGENT_WITHDRAWAL_DESTINATION=${bankr.withdrawalDestination}`]
      : []),
  ];
}

export function buildWebUIAuthStoreFile(p: WebUIDeployParams): string | undefined {
  if (p.inferenceProvider !== "openai-codex") {
    return undefined;
  }

  return p.codexAuthBundle
    ? buildCodexHermesAuthStore(p.codexAuthBundle)
    : `${JSON.stringify({ version: 1, providers: {} }, null, 2)}\n`;
}

export function resolveWebUIProviderEnvVar(provider: string): string {
  const m: Record<string, string> = {
    openrouter: "OPENROUTER_API_KEY",
    openai: "OPENAI_API_KEY",
    "openai-compat": "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    custom: "OPENAI_API_KEY",
    bankr: "OPENAI_API_KEY",
    cometapi: "OPENAI_API_KEY",
    crof: "OPENAI_API_KEY",
    venice: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    gemini: "GEMINI_API_KEY",
    groq: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    xai: "XAI_API_KEY",
    "x-ai": "XAI_API_KEY",
    alibaba: "DASHSCOPE_API_KEY",
    xiaomi: "XIAOMI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    together: "TOGETHER_API_KEY",
  };
  return m[provider.toLowerCase()] ?? "OPENROUTER_API_KEY";
}

// ── hermes-agent config.yaml (model + provider + base URL) ─────────────
export function buildWebUIConfigYaml(
  p: WebUIDeployParams,
  mode: WebUIAgentImageMode = "provision"
): string {
  // Operator OS autonomy preset. An operatoros-flavored box must boot with the
  // full mission-mode config from profiles/operatoros/config.yaml (mission
  // ceilings, the organs+evo plugins, the outbox RED gate, the per-run token
  // budget, approvals full-YOLO, delegation auto-approve, the completion-guard
  // agent flags, the lean compression / tool-output / web / context-file caps,
  // and the sliding context engine). That preset ships INSIDE the operatoros-agent
  // image at profiles/operatoros/config.yaml, but a webfree box never loads it:
  // the compose runs the gateway with `entrypoint: []` (bypassing s6, so the
  // image's 02-reconcile-profiles cont-init never fires) and no HERMES_PROFILE is
  // set, so the box runs the base config.yaml this function generates. Without the
  // blocks below a fresh Operator OS box boots with mission OFF → the organs never
  // arm, no budget, no outbox gate, no sliding engine (the config was previously
  // hand-merged during an earlier verification run). Keyed on the RESOLVED agent image, exactly like the
  // autonomy-SOUL seeder (PR #552): every caller translates config.agentFlavor
  // into this image via the operatoros-flavor helpers, and the image is the
  // payload source, so flavor and payload can never disagree.
  const isOperatorOsDeploy = isOperatorosAgentImage(resolveWebUIAgentImage(p, mode));
  const baseUrlLine = p.baseUrl ? `\n  base_url: "${p.baseUrl}"` : "";
  // The agent's OpenAI client for a `custom` provider (managed-Venice runs as
  // `custom` + base_url) does NOT fall back to the OPENAI_API_KEY env when
  // model.api_key is absent — it puts an EMPTY credential on the wire and the
  // managed-Venice gateway 401s. That is the Jun-2026 webui chat outage: the
  // baked URL was correct and the key was valid in the box env (curl from inside
  // the container returned 200), but the agent never sent it, so every chat died
  // with HTTP 401 "Unauthorized" (models-list auth'd via a different path, which
  // masked it). Bake the key straight into config.yaml so the agent always
  // authenticates. Gated on a real key, so codex (auth-bundle, no llmApiKey) and
  // not-yet-configured BYO boxes are untouched; `unconfigured` omits the whole
  // model block below regardless.
  const apiKeyLine = p.llmApiKey
    ? `\n  api_key: ${JSON.stringify(p.llmApiKey)}`
    : "";
  const bankrSectionYaml = p.bankr
    ? `bankr:\n  walletAddress: ${JSON.stringify(p.bankr.walletAddress)}\n  apiKey: ${JSON.stringify(p.bankr.apiKey)}\n  walletId: ${JSON.stringify(p.bankr.walletId)}\n  withdrawalDestination: ${p.bankr.withdrawalDestination ? JSON.stringify(p.bankr.withdrawalDestination) : "null"}\n`
    : "";
  // CDP mode: the browser sidecar now runs a *regular Chrome* the agent drives
  // over CDP with its NATIVE browser tools (browser_navigate/snapshot/click,
  // already in the hermes-cli toolset). We deliberately do NOT surface the Vex
  // `browser_sidecar` deterministic toolset — its primitives spawn a separate
  // Playwright context (a second Chrome on the same Xvfb display), which would
  // diverge from the CDP Chrome shown in the noVNC live view. Suppressing it
  // keeps all browsing unified on the one Chrome the user watches.
  const browserSidecarToolsetLine = "";
  const nativeMediaToolsetLine = resolveWebUIVeniceBaseUrl(p) ? "\n  - video_gen" : "";
  // Clean-slate BYOK (deploy-card Managed=OFF): OMIT the entire model: block
  // (default + provider + base_url). With no model/provider in config.yaml,
  // the agent's _has_any_provider_configured() returns false → its native
  // onboarding overlay fires and the user configures a provider after the box
  // is up. (No venice base_url here either, so nativeMediaToolsetLine is empty
  // and the venice media toolset stays off.) Everything else — toolsets,
  // agent, display, bankr — is unchanged.
  const modelBlock = p.unconfigured
    ? ""
    : `model:
  default: "${p.defaultModel}"
  provider: "${p.inferenceProvider}"${baseUrlLine}${apiKeyLine}
`;
  // Auxiliary compression model — the CHEAP model the agent uses to summarize /
  // compact context (this is what keeps the sliding context engine affordable).
  // Emitted only when the dashboard set an explicit compression model; empty ==
  // "inherit main", so the agent falls back to the primary model. Provider is
  // collapsed to the runtime id (PROVIDER_ID_MAP) so it matches the model: block
  // above; an unset compression provider inherits the main provider. Skipped on
  // clean-slate (unconfigured) boxes, which carry no model config at all.
  const compressionModel = typeof p.compressionModel === "string" ? p.compressionModel.trim() : "";
  let auxiliaryBlock = "";
  if (!p.unconfigured && compressionModel) {
    const compressionProviderRaw =
      (p.compressionProvider && p.compressionProvider.trim())
        ? p.compressionProvider.trim()
        : (p.dashboardProvider || p.inferenceProvider);
    const compressionProvider = PROVIDER_ID_MAP[compressionProviderRaw] ?? compressionProviderRaw;
    auxiliaryBlock = `auxiliary:
  compression:
    provider: "${compressionProvider}"
    model: "${compressionModel}"
`;
  }
  // Context engine — "compressor" (default) or "sliding". Orthogonal to provider
  // config (like approvals/plugins below), so it is NOT gated on `unconfigured`;
  // emitted only when the dashboard set it explicitly.
  //
  // The sliding tuning rides BOTH branches. Without this, explicitly choosing
  // "sliding" in the UI produced LESS configuration than not choosing at all:
  // the explicit branch emitted only `engine:`, so the box stored
  // `sliding: {}` and inherited the agent's _SLIDING_DEFAULTS, while the
  // Operator OS fallback below pinned every knob. The values are identical to
  // those defaults today, so this changes no behavior — it stops a routine
  // upstream sync from silently retuning the context engine (fold sizes, and
  // the full-rewrite threshold governing how aggressively summary blocks are
  // deduplicated) on a live box with no config diff to show for it.
  const slidingTuning = `  sliding:
    tail_messages: 10
    fold_batch: 5
    max_blocks: 8
    hard_tail_factor: 3
    spill_bytes: 8000
    full_rewrite_tokens: 10000
`;
  const contextBlock =
    p.contextEngine === "compressor" || p.contextEngine === "sliding"
      ? `context:
  engine: "${p.contextEngine}"
${p.contextEngine === "sliding" ? slidingTuning : ""}`
      : isOperatorOsDeploy
        ? `context:
  # Operator OS default: the sliding streaming context engine keeps long
  # autonomous sessions affordable (folds the oldest raw tail into append-only
  # summary blocks computed in a background thread). A user-set context.engine
  # (the aux-model UI setting) still wins in the branch above — this is only the
  # fallback when the box carries no explicit engine choice.
  engine: "sliding"
${slidingTuning}`
        : "";
  // Default web-search backend. The agent's tools/web_tools.py supports
  // `ddgs` (DuckDuckGo), `brave-free`, `tavily`, `firecrawl`, `exa`, `searxng`,
  // `parallel`, `xai` — but when `web.backend` is unset the agent's fallback is
  // `firecrawl`, which needs an API key our default deploy doesn't ship. Result:
  // every fresh box's web search died with a "browser not cooperating"-style
  // error even though the agent has a perfectly good keyless backend (`ddgs`)
  // available. Default to `ddgs` so every box has working search out of the box
  // (Pro tier still gets the browser sidecar for richer browsing). Skipped on
  // `unconfigured` clean-slate boxes (no model block, so no web block either).
  // Operator OS trims web extraction to principles-not-pages (extract_char_limit
  // 8000 vs the agent's 15000 default) to protect the lean context budget. It
  // rides alongside the ddgs backend, and is emitted even on an unconfigured
  // operatoros box (the cap is orthogonal to provider config, like approvals).
  const webBackendLine = p.unconfigured ? "" : "\n  backend: ddgs";
  const webExtractLine = isOperatorOsDeploy ? "\n  extract_char_limit: 8000" : "";
  const webBlock =
    webBackendLine || webExtractLine ? `web:${webBackendLine}${webExtractLine}\n` : "";
  // A dangerous-command approval blocks an agent worker thread on a
  // threading.Event. The agent's only signal is an `approval.request` frame
  // pushed down the workspace iframe's /api/ws socket, so an owner who isn't
  // looking at that iframe sees an agent that appears idle — and at the agent's
  // 300s code default the request times out and unwinds as denied before they
  // ever notice. Park the wait for an hour instead, and let the
  // hivra_approval_relay plugin tell the dashboard the agent is waiting.
  //
  // Safe against the agent's inactivity watchdog: _await_gateway_decision polls
  // the event in 1s slices and fires touch_activity_if_due() between them, which
  // keeps `agent.gateway_timeout` (1800s) from killing a legitimately blocked
  // agent. Safe against the WS reapers: _ws_session_is_orphaned() returns False
  // while a turn is running, so closing the tab detaches without reaping. Safe
  // against the fleet sweeps: inactivity (4d), dormant-reclaim (7d) and
  // capacity-pressure (7d) all threshold in DAYS — an hour is far below them.
  // Operator OS runs approvals FULL YOLO (mode/cron_mode off) so an unattended run
  // never wedges on a command-approval it has no human to answer — the guardrails
  // live in the control flow (budget, outbox RED gate, verifier gates) and the
  // non-bypassable hardline floor in tools/approval.py still blocks unconditionally.
  // Merged into the one approvals block so there is no duplicate top-level key;
  // gateway_timeout still parks a legitimately-blocked RED card for an hour.
  const approvalsOperatorosLines = isOperatorOsDeploy
    ? `\n  mode: "off"\n  cron_mode: "off"`
    : "";
  const approvalsBlock = `approvals:
  gateway_timeout: ${WEBUI_APPROVAL_GATEWAY_TIMEOUT_SECONDS}${approvalsOperatorosLines}
`;
  // Plugins are opt-in: hermes_cli/plugins.py treats a missing `plugins.enabled`
  // key as "nothing enabled" and there is no env override, so the relay has to be
  // named here or it never registers its hooks. `cmd_dashboard` runs
  // discover_plugins() before start_server(), so the plugin loads in the same
  // (official-dashboard) process that owns the blocking approval wait.
  // Operator OS adds the four autonomous-loop organs + the Scout (operatoros-organs)
  // and evo — they auto-arm on mission mode and give plan-first scoping, the
  // tool-call budget, tick/done guards, and the file_goals Scout tool. Appended to
  // the enabled list (never replacing hivra_approval_relay, which the dashboard's
  // blocking approval wait needs), so there is one plugins block and no duplicate key.
  const pluginsOperatorosLines = isOperatorOsDeploy
    ? `\n    - operatoros-organs\n    - evo`
    : "";
  const pluginsBlock = `plugins:
  enabled:
    - observability/hivra_approval_relay${pluginsOperatorosLines}
`;
  // Operator OS-only top-level config with no base-config counterpart to merge
  // into. Each is "" for a vanilla box, so a non-operatoros config.yaml stays
  // byte-identical to before. Values track profiles/operatoros/config.yaml.
  const missionBlock = isOperatorOsDeploy
    ? `mission:
  enabled: true
  cost:
    token_ceiling: 2000000
    usd_ceiling: null
    board_token_ceiling: 8000000
    board_usd_ceiling: null
`
    : "";
  // Fan-out is deliberately UNCAPPED on Operator OS (Ash, 2026-07-24: "make it
  // unbounded, i'll reap the consequences but just make sure the prompts
  // themselves allow for good self control"). Both knobs have a floor of 1 and
  // no ceiling in the agent's tools/delegate_tool.py, so these values sit past
  // the point where they bind on real work — the governor is the SOUL's
  // "Delegation discipline" section, not a number.
  //
  // These MUST live here rather than being hand-patched onto a box: this
  // generator rewrites config.yaml on every settings-save, so a hand-added
  // value silently reverts to the shared defaults (3 wide / 1 deep = flat) the
  // next time the instance is saved. The agent-side safety net is the
  // hourly-llm-burn tripwire, which is observational by design.
  const delegationBlock = isOperatorOsDeploy
    ? `delegation:
  subagent_auto_approve: true
  max_concurrent_children: 64
  max_spawn_depth: 6
`
    : "";
  const budgetBlock = isOperatorOsDeploy
    ? `budget:
  max_prompt_tokens_per_run: 300000
`
    : "";
  const outboxBlock = isOperatorOsDeploy
    ? `outbox:
  red_tools:
    - "deploy_*"
    - "provision_*"
    - "cronjob"
`
    : "";
  const compressionBlock = isOperatorOsDeploy
    ? `compression:
  threshold: 0.35
  max_context_tokens: 60000
  proactive_prune_threshold: 40000
  protect_last_n: 8
  target_ratio: 0.10
`
    : "";
  const toolOutputBlock = isOperatorOsDeploy
    ? `tool_output:
  max_bytes: 20000
`
    : "";
  const contextFileBlock = isOperatorOsDeploy ? `context_file_max_chars: 12000\n` : "";
  // The completion-runtime spine of the operator identity — force the semantic
  // final-response guard, tool-use enforcement, intent-ack continuation, and
  // verify-on-stop ON for every surface so a reversible task never stalls on a
  // soft prompt-level stop. Appended into the one agent block below.
  const agentOperatorosFlags = isOperatorOsDeploy
    ? `
  completion_guard: true
  tool_use_enforcement: true
  intent_ack_continuation: true
  verify_on_stop: true`
    : "";
  // Upstream terminal_tool bridges this key over TERMINAL_ENV. Fresh configs
  // and preserved configs on settings apply must agree with the env choice.
  const terminalBlock = `terminal:\n  backend: "${resolveWebUITerminalBackend(p)}"\n`;
  // Keep a web-chat turn running after its tab closes instead of letting the
  // agent's 20 s WS-orphan reap interrupt it. Orthogonal to provider config, so
  // emitted on clean-slate boxes too. Existing boxes get it from the update-mode
  // repair (buildWebUIWsOrphanReapRepairCommand). See webui-session-retention.ts.
  const dashboardBlock = buildWebUIWsOrphanReapConfigYaml();
  return `# Generated by Hermes Deploy — model + provider injected from dashboard settings.
${modelBlock}${auxiliaryBlock}${contextBlock}${webBlock}${missionBlock}${delegationBlock}${budgetBlock}${outboxBlock}${compressionBlock}${toolOutputBlock}${contextFileBlock}${approvalsBlock}${pluginsBlock}${dashboardBlock}${terminalBlock}toolsets:
  - hermes-cli${nativeMediaToolsetLine}${browserSidecarToolsetLine}
agent:
  max_turns: 999${agentOperatorosFlags}
display:
  interim_assistant_messages: true
${bankrSectionYaml}
`;
}

// ── Provisioning bootstrap script (writes files, runs compose) ─────────
export interface WebUIBootstrapScriptOptions {
  /**
   * "provision" — first-boot path. Skips pull when the image is already
   * present locally (baked Proxmox templates). Avoids the ~90s manifest
   * resolution that was killing Vercel function runs before bootstrap
   * could finish.
   *
   * "update" — manual update / auto-update path. Always pulls fresh
   * images and force-recreates webui+sidecar so a re-seeded agent-source
   * volume actually gets re-imported by the running Python process.
   * Also prunes unused images older than 24h afterwards so stale tagged
   * update images don't accumulate between disk-cleanup timer fires.
   */
  mode?: "provision" | "update";
  /**
   * Only an explicit terminal/access settings apply may update the owner's
   * saved terminal.backend. Routine image updates preserve native config edits.
   * Fresh provision always initializes the selected backend.
   */
  applyTerminalBackend?: boolean;
  /**
   * Fresh provision can trust template-baked images for speed, or force-pull
   * the WebUI app image so first boot uses the current floating tag.
   */
  forceWebUIImagePull?: boolean;
  /**
   * Force-pull the Hermes Agent seed image before copying agent-source into the
   * WebUI volume. This keeps fresh VMs current even when templates have an
   * older :stable layer cached.
   */
  forceAgentImagePull?: boolean;
  /**
   * Existing-host/live-update scripts need to repair the host clock directly.
   * Fresh Hetzner user_data already runs this in the host bootstrap, so that
   * caller disables it to avoid duplicating the repair block.
   */
  includeHostTimeSyncRepair?: boolean;
  /**
   * Extra VM provisioning that must run before the bootstrap's health-loop
   * exits. Used for systemd timers such as the daily auto-updater.
   */
  additionalProvisioningScript?: string;
}

export function buildWebUIRuntimeWatchdogProvisioningScript(
  p: Pick<WebUIDeployParams, "instanceId" | "containerName">
): string {
  const unitToken = systemdSafeToken(p.instanceId);
  const serviceName = `hermes-webui-watchdog-${unitToken}`;
  const executablePath = `/usr/local/bin/${serviceName}`;
  const servicePath = `/etc/systemd/system/${serviceName}.service`;
  const timerPath = `/etc/systemd/system/${serviceName}.timer`;
  const logPath = `/var/log/${serviceName}.log`;
  const stateDir = `/var/lib/hermes/${serviceName}`;
  const instanceDir = `/opt/hermes/instances/${p.instanceId}`;
  const watchdogScript = `#!/bin/bash
set -euo pipefail

INSTANCE_DIR=${shellSingleQuote(instanceDir)}
STATE_DIR=${shellSingleQuote(stateDir)}
LOG_FILE=${shellSingleQuote(logPath)}
RESTART_FILE="$STATE_DIR/restart-count"

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"
exec >> "$LOG_FILE" 2>&1
cd "$INSTANCE_DIR"

log() {
  printf '[webui-watchdog] %s %s\\n' "$(date -u -Iseconds)" "$*"
}

inspect_line() {
  docker inspect --format='status={{.State.Status}} running={{.State.Running}} restarting={{.State.Restarting}} exit={{.State.ExitCode}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || printf 'status=missing running=false restarting=false exit=unknown restarts=0 health=missing\\n'
}

field() {
  key="$1"
  printf '%s\\n' "$INSPECT_LINE" | tr ' ' '\\n' | sed -n "s/^$key=//p" | head -n1
}

# Resolve the live agent-runtime compose service + its container on THIS guest.
# webfree instances run the 'gateway' service (container ${p.containerName}-gateway);
# legacy single-container instances run 'webui' (container ${p.containerName}). The
# runtime's container_name is fixed by its compose service, so derive the container
# from the resolved service rather than the drifted hermes_instances.webfree flag.
# We deliberately do NOT scan running containers (cf. agent-container.ts's
# candidate list): that list includes -official-dashboard, and a dead gateway
# behind a still-running dashboard surface would be masked as "healthy" — exactly
# the runtime the watchdog must heal. Deriving from the service also names the
# container even while it is down. Service resolver mirrors runtimeComposeServiceExpr.
SERVICE=${runtimeComposeServiceExpr()}
if [ "$SERVICE" = "gateway" ]; then
  CONTAINER=${shellSingleQuote(`${p.containerName}-gateway`)}
else
  CONTAINER=${shellSingleQuote(p.containerName)}
fi

INSPECT_LINE="$(inspect_line)"
status="$(field status)"
running="$(field running)"
restarting="$(field restarting)"
health="$(field health)"
current_restart_count="$(field restarts)"
case "$current_restart_count" in
  ''|*[!0-9]*) current_restart_count=0 ;;
esac

last_restart_count=0
if [ -f "$RESTART_FILE" ]; then
  last_restart_count="$(cat "$RESTART_FILE" 2>/dev/null || echo 0)"
  case "$last_restart_count" in
    ''|*[!0-9]*) last_restart_count=0 ;;
  esac
fi

restart_delta=$((current_restart_count - last_restart_count))
if [ "$restart_delta" -lt 0 ]; then
  restart_delta=0
fi

if [ "$running" = "true" ] && [ "$restarting" != "true" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
  printf '%s\\n' "$current_restart_count" > "$RESTART_FILE"
  exit 0
fi

if [ "$running" = "true" ] && [ "$restarting" != "true" ] && [ "$health" = "starting" ] && [ "$restart_delta" -lt 2 ]; then
  log "WebUI still starting; inspect=$INSPECT_LINE restart_delta=$restart_delta"
  printf '%s\\n' "$current_restart_count" > "$RESTART_FILE"
  exit 0
fi

log "detected unhealthy agent runtime (container=$CONTAINER service=$SERVICE); repairing persistent state"
log "inspect=$INSPECT_LINE restart_delta=$restart_delta"
docker logs --tail=120 "$CONTAINER" 2>/dev/null || true

${buildWebUIPersistentStatePermissionRepairCommand(p.containerName)}
${buildWebUIPersistentStateShimCommand(p.containerName)}

systemctl start hermes-memory-guard.service >/dev/null 2>&1 || /usr/local/bin/hermes-memory-guard || true
docker compose up -d --force-recreate --no-deps "$SERVICE"

# Confirm recovery via the container's own docker HEALTHCHECK (port-agnostic:
# the webfree gateway serves /health on :8642, legacy webui on :8787) instead of
# a hard-coded in-container probe. Mirrors webui_free_stack_healthy in the
# bootstrap loop. A container without a HEALTHCHECK reports health=none, treated
# as healthy once it is running and not restarting.
for _ in $(seq 1 90); do
  INSPECT_LINE="$(inspect_line)"
  if [ "$(field running)" = "true" ] && [ "$(field restarting)" != "true" ] \
    && { [ "$(field health)" = "healthy" ] || [ "$(field health)" = "none" ]; }
  then
    # Re-install the /usr/local/bin hermes shim on the recreated runtime so the
    # agent's terminal tool (login-shell PATH) keeps resolving 'hermes'. Guarded
    # + best-effort, so it can never fail the repair.
${buildWebUIUsrLocalHermesShimCommand("$CONTAINER")}
    latest_restart_count="$(field restarts)"
    case "$latest_restart_count" in
      ''|*[!0-9]*) latest_restart_count="$current_restart_count" ;;
    esac
    printf '%s\\n' "$latest_restart_count" > "$RESTART_FILE"
    log "repair complete; agent runtime healthy (container=$CONTAINER service=$SERVICE)"
    exit 0
  fi
  sleep 2
done

log "repair failed; agent runtime did not become healthy (container=$CONTAINER service=$SERVICE)"
log "post_repair_inspect=$(inspect_line)"
docker logs --tail=120 "$CONTAINER" 2>/dev/null || true
exit 1
`;
  const serviceFile = `[Unit]
Description=Hermes WebUI runtime watchdog for ${p.instanceId}
After=docker.service network-online.target
Wants=network-online.target
ConditionPathExists=${instanceDir}/docker-compose.yml

[Service]
Type=oneshot
ExecStart=${executablePath}
TimeoutStartSec=8min`;
  const timerFile = `[Unit]
Description=Hermes WebUI runtime watchdog timer for ${p.instanceId}

[Timer]
OnBootSec=4min
OnUnitActiveSec=2min
AccuracySec=30s
Persistent=true
Unit=${serviceName}.service

[Install]
WantedBy=timers.target`;

  return `cat > ${executablePath} <<'__HERMES_WEBUI_WATCHDOG__'
${watchdogScript}__HERMES_WEBUI_WATCHDOG__
chmod +x ${executablePath}
cat > ${servicePath} <<'__HERMES_WEBUI_WATCHDOG_SERVICE__'
${serviceFile}
__HERMES_WEBUI_WATCHDOG_SERVICE__
cat > ${timerPath} <<'__HERMES_WEBUI_WATCHDOG_TIMER__'
${timerFile}
__HERMES_WEBUI_WATCHDOG_TIMER__
systemctl daemon-reload
systemctl reset-failed ${serviceName}.service ${serviceName}.timer >/dev/null 2>&1 || true
systemctl enable --now ${serviceName}.timer >/dev/null 2>&1 || true
`;
}

/**
 * Refresh a tokenless static surface (webchat_dist -> /webchat, web_dist_dash ->
 * /dash) from the freshly-pulled agent image, ATOMICALLY and NON-DESTRUCTIVELY.
 *
 * The earlier implementation did `rm -rf <dir>` and THEN a *conditional* copy,
 * so an image that shipped without the bundle wiped a working surface to empty
 * (the CAUSE-4 blank-chat footgun: webchat dir empty -> the embed 404s / renders
 * the wrong surface). This stages the extract first and swaps it into place ONLY
 * when the image actually produced content; a bundle-less image leaves the
 * existing surface untouched and warns loudly so a bad image build is visible in
 * the deploy log instead of silently blanking chat. The rename swap also gives
 * --delete semantics, so stale files from a prior bundle never linger.
 */
function buildStaticSurfaceRefreshCommand(args: {
  label: string;
  srcDir: string;
  destName: string;
  agentImage: string;
}): string {
  const { label, srcDir, destName, agentImage } = args;
  const dest = `"$INSTANCE_DIR/${destName}"`;
  const stage = `"$INSTANCE_DIR/.${destName}.stage"`;
  const prev = `"$INSTANCE_DIR/.${destName}.prev"`;
  const srcPath = `/opt/hermes/hermes_cli/${srcDir}`;
  return `# HermesOS ${label}: refresh the tokenless ${srcDir} bundle in the instance
# dir from the freshly-pulled image so the inner caddy file_servers the latest UI.
# Atomic + non-destructive: stage the extract and swap into place ONLY if the
# image actually shipped the bundle, so a bundle-less image can never wipe a
# working surface to empty (the blank-chat footgun). The rename swap also gives
# --delete semantics (no stale files linger from a prior bundle).
rm -rf ${stage} ${prev} && mkdir -p ${stage}
docker run --rm -v ${stage}:/out --entrypoint sh ${agentImage} -lc 'set -e; if [ -d ${srcPath} ]; then cp -a ${srcPath}/. /out/; fi'
if [ -n "$(ls -A ${stage} 2>/dev/null)" ]; then
  chmod -R a+rX ${stage} 2>/dev/null || true
  [ -e ${dest} ] && mv ${dest} ${prev}
  mv ${stage} ${dest}
  rm -rf ${prev}
  echo "[webui-bootstrap] static surface ${destName} refreshed from image"
else
  rm -rf ${stage}
  if [ -n "$(ls -A ${dest} 2>/dev/null)" ]; then
    echo "[webui-bootstrap] WARN: image missing ${srcPath}; keeping existing ${destName} surface (not wiping)" >&2
  else
    echo "[webui-bootstrap] FATAL: image missing ${srcPath} and no existing ${destName} surface; /${destName} would 404. Failing the deploy so recovery redrives instead of bringing up a dashboard-less box." >&2
    exit 1
  fi
fi`;
}

function buildWebUIRuntimePasswdCommand(agentImage: string): string {
  const quotedImage = shellSingleQuote(agentImage);
  return `# Compose pins the two agent-bearing services to uid/gid 1024 so they
# can share the historical webui-state volume. The agent image's named hermes
# account is uid 10000, however, so a bare numeric user has no passwd identity:
# ssh-keygen/ssh fail with "No user exists for uid 1024" even though HOME is set.
# Preserve every image-provided account, replace any stale uid-1024 row, and
# atomically publish one stable identity with the actual runtime home. Mounting
# this file read-only keeps the fix across container recreates and image updates.
runtime_passwd_image=${quotedImage}
runtime_passwd_tmp="$INSTANCE_DIR/.runtime-passwd.tmp"
docker run --rm --network none --entrypoint cat "$runtime_passwd_image" /etc/passwd \\
  | awk -F: '$1 != "hivra" && $3 != "1024"' > "$runtime_passwd_tmp"
printf '%s\\n' 'hivra:x:1024:1024:Hivra Agent:/home/hermes:/bin/sh' >> "$runtime_passwd_tmp"
if ! awk -F: '$1 == "hivra" && $3 == "1024" && $4 == "1024" && $6 == "/home/hermes" { found=1 } END { exit(found ? 0 : 1) }' "$runtime_passwd_tmp"; then
  echo "[webui-bootstrap] FATAL: failed to generate uid-1024 runtime passwd identity" >&2
  rm -f "$runtime_passwd_tmp"
  exit 1
fi
chmod 0644 "$runtime_passwd_tmp"
mv -f "$runtime_passwd_tmp" runtime-passwd
`;
}

export function buildWebUIBootstrapScript(
  artifacts: WebUIProvisioningArtifacts,
  p: WebUIDeployParams,
  opts: WebUIBootstrapScriptOptions = {}
): string {
  const stateDir = `/opt/hermes/instances/${p.instanceId}`;
  const mode = opts.mode ?? "provision";
  const isUpdate = mode === "update";
  const image = p.image ?? env("HERMES_WEBUI_DOCKER_IMAGE", DEFAULT_WEBUI_IMAGE);
  const agentImage = resolveWebUIAgentImage(p, mode);
  const composeYaml = buildWebUICompose({ ...p, image, agentImage });
  const runtimePasswdCommand = buildWebUIRuntimePasswdCommand(agentImage);
  const gatewayDockerSocketPreparation = p.gatewayDockerAccess
    ? `# Docker control is granted without changing the gateway's uid: derive the
# guest daemon socket's numeric group, persist it for compose interpolation,
# and fail closed rather than starting a gateway with an unusable or ambiguous
# socket mapping. The caller only enables this inside a dedicated Proxmox VM.
if [ ! -S /var/run/docker.sock ]; then
  echo "[webui-bootstrap] FATAL: dedicated-VM Docker access requested but /var/run/docker.sock is unavailable" >&2
  exit 1
fi
guest_docker_gid="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
case "$guest_docker_gid" in
  ''|*[!0-9]*)
    echo "[webui-bootstrap] FATAL: could not derive a numeric guest Docker socket GID" >&2
    exit 1
    ;;
esac
sed -i '/^HERMES_GUEST_DOCKER_GID=/d' .env
printf 'HERMES_GUEST_DOCKER_GID=%s\\n' "$guest_docker_gid" >> .env
export HERMES_GUEST_DOCKER_GID="$guest_docker_gid"
`
    : "";
  // First-run onboarding: seed the BOOTSTRAP-style ritual as the agent's SOUL.md
  // so it runs the "who am I / who are you" identity-and-first-task conversation
  // the first time the user talks to it (the ritual self-terminates by telling
  // the agent to rewrite SOUL.md as its real identity when done). Runs in every
  // mode — fresh provision AND update/redrive — because the head-pattern guard
  // makes a re-seed safe (see seedOnboardingSoulFn below): the old "provision
  // only" gate silently skipped the seed on redrive-to-running and every config
  // redeploy, so slow (>6 min) or redriven boxes booted the raw factory SOUL.md.
  // Seeds when SOUL.md is empty OR still the
  // agent image's factory-default persona — the image ships a NON-empty default
  // ("You are Hermes Agent…" / "# Hermes Agent Persona"), so the original
  // empty-only guard never fired and onboarding never seeded on ANY box (the
  // Jun-2026 finding: every box booted with the generic default and no ritual). A
  // genuinely customized/onboarded SOUL (a real name/identity) is preserved and
  // never clobbered. SOUL.md
  // lives in the webui-state NAMED VOLUME at /home/hermes/.hermes, so it must be
  // written via `docker exec` after the stack is healthy (a file in the instance
  // dir never reaches the volume). Path + named-volume verified live on canary
  // a disposable pre-flight verification computer.
  // Persona deploys (Bea/Sloane/… from the welcome picker) seed the AUTHORED
  // soul verbatim instead of the ritual — otherwise the box boots into the
  // who-am-I conversation and invents an identity that contradicts the persona
  // the user just hired (the Jul-2026 finding: souls were stored in config but
  // never reached any box). Same transport, same guard; the guard's regex makes
  // precedence safe in both directions: an authored soul may overwrite an
  // un-run ritual (the ritual's header contains "just came online") but never a
  // real onboarded identity, and re-seeds under recovery redrives stay
  // idempotent. Custom/no-persona deploys keep the ritual unchanged.
  // Operator OS deploys seed neither the ritual nor a persona: the box's
  // identity is the autonomy SOUL shipped INSIDE the operatoros-agent image at
  // OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH, and this seeder is the ONLY writer
  // that can install it on a webfree box — the compose runs the gateway with
  // `entrypoint: []` (bypassing s6, so the image's cont-init SOUL enforcer
  // never fires) and soul-seed-reconcile deliberately skips operatoros boxes
  // (PR #550). Before this gate, fresh Operator OS provisions therefore booted
  // into the who-am-I onboarding ritual instead of the autonomy identity (the
  // Jul-2026 canary finding; box fixturecase22 was fixed by hand). The gate keys on
  // the RESOLVED agent image rather than a flavor param because every caller
  // translates config.agentFlavor into this image (provision + orchestrator
  // update paths, via the shared operatoros-flavor helpers), and the image is
  // also the extraction source — so flavor and payload can never disagree.
  const isOperatorOsDeploy = isOperatorosAgentImage(agentImage);
  const personaSoulPrompt =
    !isOperatorOsDeploy && typeof p.personaSoulPrompt === "string" && p.personaSoulPrompt.trim()
      ? p.personaSoulPrompt
      : null;
  const soulSeedContent = personaSoulPrompt ?? ONBOARDING_RITUAL;
  const soulSeedLogLine = personaSoulPrompt
    ? "[webui-bootstrap] seeded authored persona soul into SOUL.md"
    : "[webui-bootstrap] seeded first-run onboarding ritual into SOUL.md";
  const onboardingRitualB64 = Buffer.from(soulSeedContent, "utf8").toString("base64");
  // The seed runs in EVERY mode (provision AND update/redrive), not just fresh
  // provision. The head-pattern guard below makes a re-seed safe: it only writes
  // when SOUL.md is empty, the image's factory-default persona, or an un-run
  // ritual — it NEVER clobbers a real agent-authored identity. Gating it on
  // `!isUpdate` (the old behavior) was the reliability bug: a box that reached
  // "running" via a recovery redrive, or every config redeploy, ran in update
  // mode and therefore skipped the seed entirely, leaving slow-provisioned and
  // redriven boxes stuck on the raw factory SOUL.md ("You are Hermes Agent…")
  // with no persona soul and no onboarding ritual. Seeding unconditionally +
  // idempotently (guard-protected) closes that gap for both the who-am-I ritual
  // and authored persona souls, and organically reconciles already-broken boxes
  // on their next routine redeploy/redrive.
  // Operator OS variant: the payload can't be embedded at script-build time
  // (the dashboard never has the image), so it's extracted on the host from the
  // agent image at seed time — same docker-run pattern as the agent-source seed
  // below. Memoized in AUTONOMY_SOUL_B64 so the health-wait loop's repeated
  // calls don't re-run a container after a successful extract; a FAILED extract
  // leaves SOUL.md untouched (never falls back to the ritual — seeding the
  // ritual on an operatoros box is exactly the bug this branch fixes) and
  // retries on the next call. The guarded docker-exec write is byte-for-byte
  // the vanilla branch's: same head-pattern guard, so an un-run ritual on an
  // already-broken box is overwritten on its next redeploy while an authored
  // identity (or the autonomy SOUL itself, whose head matches neither factory
  // pattern) is never clobbered.
  const seedOnboardingSoulFn = isOperatorOsDeploy
    ? `AUTONOMY_SOUL_B64=''
seed_onboarding_soul() {
  if [ -z "$AUTONOMY_SOUL_B64" ]; then
    AUTONOMY_SOUL_B64="$(docker run --rm --entrypoint sh ${agentImage} -lc 'test -f ${OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH} && base64 ${OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH}' 2>/dev/null | tr -d '\\n')"
  fi
  if [ -z "$AUTONOMY_SOUL_B64" ]; then
    echo "[webui-bootstrap] WARN: could not extract ${OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH} from ${agentImage}; leaving SOUL.md untouched" >&2
    return 0
  fi
  for c in ${p.containerName}-gateway ${p.containerName}; do
    docker inspect "$c" >/dev/null 2>&1 || continue
    printf '%s' "$AUTONOMY_SOUL_B64" | base64 -d | docker exec -i --user 1024 "$c" sh -lc 'export HERMES_HOME="/home/hermes/.hermes"; mkdir -p "$HERMES_HOME"; if [ ! -s "$HERMES_HOME/SOUL.md" ] || head -3 "$HERMES_HOME/SOUL.md" | grep -qE "${FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN}"; then cat > "$HERMES_HOME/SOUL.md" && echo "[webui-bootstrap] seeded Operator OS autonomy SOUL into SOUL.md"; else cat >/dev/null; fi' 2>/dev/null && break
  done
  return 0
}
`
    : `ONBOARDING_RITUAL_B64='${onboardingRitualB64}'
seed_onboarding_soul() {
  for c in ${p.containerName}-gateway ${p.containerName}; do
    docker inspect "$c" >/dev/null 2>&1 || continue
    printf '%s' "$ONBOARDING_RITUAL_B64" | base64 -d | docker exec -i --user 1024 "$c" sh -lc 'export HERMES_HOME="/home/hermes/.hermes"; mkdir -p "$HERMES_HOME"; if [ ! -s "$HERMES_HOME/SOUL.md" ] || head -3 "$HERMES_HOME/SOUL.md" | grep -qE "${FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN}"; then cat > "$HERMES_HOME/SOUL.md" && echo "${soulSeedLogLine}"; else cat >/dev/null; fi' 2>/dev/null && break
  done
  return 0
}
`;
  const seedOnboardingSoulCall = "seed_onboarding_soul";
  const forceWebUIImagePull = !isUpdate && opts.forceWebUIImagePull === true;
  const forceAgentImagePull = !isUpdate && opts.forceAgentImagePull === true;
  const agentPullCmd = isUpdate
    ? `docker pull ${agentImage}`
    : forceAgentImagePull
      ? `echo "[agent-image] Force-pulling Hermes Agent seed image for fresh provision: ${agentImage}"
if ! docker pull ${agentImage}; then
  echo "[agent-image] WARN: docker pull failed for ${agentImage}" >&2
  if docker image inspect ${agentImage} >/dev/null 2>&1; then
    docker image inspect ${agentImage} --format '[agent-image] continuing with existing image id={{.Id}} repo_digests={{json .RepoDigests}}' >&2 || true
  else
    echo "[agent-image] FATAL: docker pull failed and no local image exists for ${agentImage}" >&2
    exit 1
  fi
fi
docker image inspect ${agentImage} --format '[agent-image] using image id={{.Id}} repo_digests={{json .RepoDigests}}' || true`
      : `docker image inspect ${agentImage} >/dev/null 2>&1 || docker pull ${agentImage}`;
  // Update mode passes `--ignore-pull-failures` so a single private/missing
  // image (e.g. a feature image not yet published) doesn't abort the whole
  // update. The subsequent `docker compose up -d` still surfaces the real
  // failure if a required image is genuinely unreachable, but the rest of
  // the stack updates successfully — better than silent across-the-board
  // failure on an unrelated image hiccup.
  const webuiPullCmd = isUpdate
    ? `docker compose pull --ignore-pull-failures`
    : forceWebUIImagePull
      ? `echo "[webui-image] Force-pulling WebUI image for fresh provision: ${image}"
if ! docker pull ${image}; then
  echo "[webui-image] WARN: docker pull failed for ${image}" >&2
  if docker image inspect ${image} >/dev/null 2>&1; then
    docker image inspect ${image} --format '[webui-image] continuing with existing image id={{.Id}} repo_digests={{json .RepoDigests}}' >&2 || true
  else
    echo "[webui-image] FATAL: docker pull failed and no local image exists for ${image}" >&2
    exit 1
  fi
fi
docker image inspect ${image} --format '[webui-image] using image id={{.Id}} repo_digests={{json .RepoDigests}}' || true`
      : `docker image inspect ${image} >/dev/null 2>&1 || docker compose pull`;
  // Pre-pull cleanup (update mode only). The agent image is ~8 GB; on small
  // instance disks (29 GB) a routine update can hit "no space left" mid-pull.
  // We free dangling layers and old build cache BEFORE the pull rather than
  // after, since post-pull cleanup is too late if the pull itself failed.
  const prePullCleanup = isUpdate
    ? `\n# Pre-pull disk cleanup so a tight-disk instance doesn't fail mid-pull.
hermes_volume_safe_update_cleanup pre-pull
hermes_verify_update_disk_headroom\n`
    : "";
  const dockerCleanupFunctions = buildHermesDockerImageCleanupFunctions();
  const taggedImageCleanupFunctions = buildHermesTaggedImageCleanupFunctions();
  const volumeSafeUpdateCleanupFunctions = isUpdate
    ? buildHermesVolumeSafeUpdateCleanupFunctions()
    : "";
  const composeUpFlags = isUpdate
    ? "--remove-orphans --force-recreate"
    : "--remove-orphans";
  // When `docker compose up` hits the 180s timeout (exit 124) on a slow host the
  // stack has often actually come up; we want to continue rather than report a
  // false provisioning failure. Probe ANY real runtime container rather than the
  // bare `agent-<id>`: webfree instances run `-gateway`/`-official-dashboard`
  // (no bare/`webui` service), so a hard-coded `docker inspect ${containerName}`
  // here would always fail on them and spuriously `exit 124`. Mirror the shared
  // resolver's candidate list (legacy bare → -gateway → -official-dashboard).
  const composeUpTimeoutContinueGuard = getAgentContainerCandidates(p.containerName)
    .map((name) => `docker inspect ${name} >/dev/null 2>&1`)
    .join(" || ");
  const postUpdateCleanup = isUpdate
    ? `\n# Drop unused update layers immediately after the replacement stack is healthy.
# Volumes are intentionally untouched because they hold user state and workspaces.
hermes_volume_safe_update_cleanup post-success\n`
    : "";
  const postProvisionCleanup = !isUpdate
    ? `\n# Drop stale template image layers after the first healthy WebUI boot.
# A baked template can carry an older :stable image; after force-pulling the
# current tag those old layers should not tax every new VM. Run the full
# VM-local cleanup immediately; the systemd timer remains a backstop.
echo "[webui-provision] Running immediate Hermes disk cleanup after first healthy WebUI boot"
if [ -x /usr/local/bin/hermes-disk-cleanup ]; then
  /usr/local/bin/hermes-disk-cleanup
else
  echo "[webui-provision] WARN: /usr/local/bin/hermes-disk-cleanup missing; using inline image cleanup fallback" >&2
  prune_dangling_docker_images
  prune_old_unused_hermes_agent_images
  docker builder prune -af >/dev/null 2>&1 || true
  ctr -n moby content prune references >/dev/null 2>&1 || true
  fstrim -av >/dev/null 2>&1 || true
fi
echo "[webui-provision] disk after immediate cleanup: $(df -h / | tail -1)"\n`
    : "";
  // Update mode only: PROVE every Hermes-image service is actually running the
  // freshly-pulled :stable, not the prior local digest. The initial
  // `compose up --force-recreate` is wrapped in `timeout 180s`; on a loaded
  // host (e.g. a fleet-wide rollout) it can hit the timeout (exit 124)
  // mid-recreate, leaving a container on the OLD image. The health loop below
  // only probes /health, which the healthy-but-stale old container passes — so
  // the script would print "WebUI healthy", exit 0, and the wrapper reports
  // "succeeded" without anything having converged (observed fleet-wide
  // 2026-05-23: cron launched=292 yet ~0 VMs swapped image). In webui-free
  // compose, gateway and official-dashboard are both agent-image services.
  // Compare each running container's image id to the :stable id we just pulled,
  // re-drive a targeted force-recreate until they match, then fail loudly so
  // the wrapper reports "failed" (and recover-stuck-instances retries) instead
  // of a false success. This mirrors the known-good manual fix
  // (`docker compose pull && docker compose up -d`).
  const updateConvergenceGate = isUpdate
    ? `
# ── Verify image convergence (update mode) ─────────────────────────────
agent_target_iid="$(docker image inspect ${agentImage} --format '{{.Id}}' 2>/dev/null || true)"
hermes_running_image_iid() { docker inspect --format '{{.Image}}' "$1" 2>/dev/null || true; }
hermes_gateway_healthy() {
  [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' ${p.containerName}-gateway 2>/dev/null || true)" = "healthy" ]
}
hermes_update_converged() {
  [ -n "$agent_target_iid" ] || return 1
  [ "$(hermes_running_image_iid ${p.containerName}-gateway)" = "$agent_target_iid" ] || return 1
  [ "$(hermes_running_image_iid ${p.containerName}-official-dashboard)" = "$agent_target_iid" ] || return 1
  return 0
}
hermes_log_image_state() {
  echo "  gateway            running=$(hermes_running_image_iid ${p.containerName}-gateway) target=$agent_target_iid" >&2
  echo "  official-dashboard running=$(hermes_running_image_iid ${p.containerName}-official-dashboard) target=$agent_target_iid" >&2
}
for _converge_attempt in 1 2 3; do
  if hermes_update_converged; then
    break
  fi
  echo "[webui-update] services not yet on :stable (attempt $_converge_attempt); forcing targeted recreate"
  hermes_log_image_state
  # Recreate these in sequence. They share the Hermes state volume and the
  # dashboard can bind its port yet hang forever if it races gateway startup.
  timeout 180s docker compose up -d --force-recreate --no-deps gateway || true
  gateway_recreate_healthy=0
  for _gateway_wait_attempt in $(seq 1 36); do
    if hermes_gateway_healthy; then
      gateway_recreate_healthy=1
      break
    fi
    sleep 5
  done
  if [ "$gateway_recreate_healthy" != "1" ]; then
    echo "[webui-update] gateway did not become healthy; dashboard recreate deferred" >&2
    continue
  fi
  timeout 180s docker compose up -d --force-recreate --no-deps official-dashboard || true
  sleep 3
done
if ! hermes_update_converged; then
  echo "[webui-update] FATAL: containers did not converge to :stable after recreate retries" >&2
  hermes_log_image_state
  docker compose ps || true
  exit 1
fi
echo "[webui-update] image convergence verified (gateway+official-dashboard=$agent_target_iid)"
`
    : "";
  const hostTimeSyncRepairScript =
    opts.includeHostTimeSyncRepair === false ? "" : buildHostTimeSyncRepairScript();
  const managedEnvKeys = [
    ...WEBUI_PERSISTENT_INSTALL_ENV_KEYS,
    ...WEBUI_MANAGED_RUNTIME_ENV_KEYS,
  ].join(" ");
  // BANKR_* reconcile for a wallet from the user's own Bankr account (see
  // bankrRuntimeReconcile and the clearable list's comment). Without the flag
  // every piece below is empty, so the script stays byte-for-byte what it was.
  // A set `bankr` wins over a clear: never clear keys this same run delivers.
  // A clear without one valid wallet address clears nothing: an address is what
  // proves a file's BANKR_* lines are the row's. Only validated, lower-cased
  // addresses reach the script.
  const bankrReconcile = isUpdate ? p.bankrRuntimeReconcile : undefined;
  const bankrReconcileWalletAddresses = (candidates: readonly unknown[]): string[] => {
    const addresses: string[] = [];
    for (const candidate of candidates) {
      const address = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
      if (EVM_ADDRESS_PATTERN.test(address) && !addresses.includes(address)) addresses.push(address);
    }
    return addresses;
  };
  const bankrReconcileAddressInput: unknown = bankrReconcile?.walletAddresses;
  const requestedBankrWalletAddresses: readonly unknown[] = Array.isArray(bankrReconcileAddressInput)
    ? bankrReconcileAddressInput
    : [];
  const disconnectedBankrWalletAddresses =
    bankrReconcile?.action === "clear_user_disconnected" && !p.bankr
      ? bankrReconcileWalletAddresses(requestedBankrWalletAddresses)
      : [];
  const clearBankr = disconnectedBankrWalletAddresses.length > 0;
  const replaceBankr = bankrReconcile?.action === "replace_user_connected" && !!p.bankr;
  // The delivered wallet is always in a replace run's set.
  const bankrReconcileSet = clearBankr
    ? disconnectedBankrWalletAddresses
    : replaceBankr
      ? bankrReconcileWalletAddresses([p.bankr!.walletAddress, ...requestedBankrWalletAddresses])
      : [];
  // A replace run lists BANKR_* statically: the clear pass skips every key the
  // generated env delivers, so only keys the new wallet doesn't set go. A clear
  // run appends them in the shell, and only when /state/.env holds one of the
  // row's wallets.
  const clearableEnvKeys = [
    ...WEBUI_CLEARABLE_RUNTIME_ENV_KEYS,
    ...(replaceBankr ? WEBUI_BANKR_RUNTIME_ENV_KEYS : []),
  ].join(" ");
  const clearBankrComment = replaceBankr
    ? `
# Except on this run: it delivers a wallet from the user's own Bankr account, so
# BANKR_* is listed too. The loop skips every key that wallet sets, so only a
# BANKR_* key it doesn't set (such as a replaced wallet's withdrawal destination)
# is dropped.`
    : clearBankr
      ? `
# Except on this run: the user disconnected a wallet from their own Bankr account,
# so BANKR_* is appended below, but only when /state/.env holds one of the wallets
# that agent's row delivered (bankr_clear_state, set before config.yaml is copied).`
      : "";
  const clearBankrKeysScript = clearBankr
    ? `
if [ "$bankr_clear_state" = 1 ]; then
  clearable_env_keys="$clearable_env_keys ${WEBUI_BANKR_RUNTIME_ENV_KEYS.join(" ")}"
fi`
    : "";
  const bankrOwnershipDecision = clearBankr
    ? `if bankr_wallet_address_in_set "$(bankr_env_wallet_address /state/.env)"; then
  bankr_clear_state=1
  echo "[webui-update] /state/.env holds a disconnected Bankr wallet: clearing its BANKR_* and config.yaml bankr: blocks"
else
  bankr_clear_state=0
  echo "[webui-update] /state/.env holds no disconnected Bankr wallet: leaving its BANKR_* and config.yaml bankr: blocks alone"
fi
bankr_strip_config="$bankr_clear_state"`
    : "bankr_strip_config=1";
  const bankrReconcileStateScript =
    clearBankr || replaceBankr
      ? `
# BANKR_* reconcile for a wallet from the user's own Bankr account. Hivra writes
# BANKR_AGENT_WALLET_ADDRESS with every BANKR_* delivery, so that line says which
# wallet a file's BANKR_* lines belong to. bankr_reconcile_wallet_addresses holds
# every wallet this agent's row has delivered: the current one, each earlier
# wallet a reconnect replaced and a replaced Hivra-created wallet. A connect or
# disconnect can skip the restart, so the box may still hold any of them. Only a
# file holding one of these addresses is changed; any other address may be the
# user's own configuration. A disconnect's first clear removes the address lines,
# so later runs change nothing, including BANKR_* the user sets for their own
# use. Only addresses are read into variables; key values never are, and nothing
# here logs a value.
bankr_reconcile_wallet_addresses=${shellSingleQuote(bankrReconcileSet.join(" "))}
bankr_env_wallet_address() {
  [ -f "$1" ] || return 0
  awk '/^BANKR_AGENT_WALLET_ADDRESS=/ { v = $0; sub(/^BANKR_AGENT_WALLET_ADDRESS=/, "", v); gsub(/[\\"\\047[:space:]]/, "", v); print tolower(v); exit }' "$1" || true
}
bankr_wallet_address_in_set() {
  [ -n "$1" ] || return 1
  for bankr_set_wallet_address in $bankr_reconcile_wallet_addresses; do
    if [ "$1" = "$bankr_set_wallet_address" ]; then
      return 0
    fi
  done
  return 1
}
${bankrOwnershipDecision}

# The wallet is delivered only as BANKR_* in /state/.env. Provisioning with a
# Hivra-created wallet also wrote a top-level \`bankr:\` block (holding that key)
# into config.yaml, and the agent copies the block over its BANKR_* env on every
# config load, so a stale block would keep an old or disconnected key live. Strip
# it from the base config, every profile config and the managed-Venice and
# reap-grace repair backups (which copy it) before update mode copies config.yaml
# into /seed. Logs
# paths only, never values. The temp file starts as a mode-preserving copy so the
# rewrite never widens the file's permissions (it also holds the model API key).
if [ "$bankr_strip_config" = 1 ]; then
  for bankr_cfg in /state/config.yaml /state/profiles/*/config.yaml /state/config.yaml.pre-managed-venice-repair.* /state/config.yaml${WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX}; do
    [ -f "$bankr_cfg" ] || continue
    grep -q '^bankr:' "$bankr_cfg" || continue
    bankr_cfg_tmp="$bankr_cfg.bankr-strip.$$"
    if cp -p "$bankr_cfg" "$bankr_cfg_tmp" && awk 'skip && /^[^[:space:]#]/{skip=0} /^bankr:/{skip=1;next} !skip{print}' "$bankr_cfg" > "$bankr_cfg_tmp" && mv -f "$bankr_cfg_tmp" "$bankr_cfg"; then
      echo "[webui-update] stripped bankr: block from $bankr_cfg"
    else
      rm -f "$bankr_cfg_tmp"
      echo "[webui-update] WARNING: could not strip bankr: block from $bankr_cfg" >&2
    fi
  done
fi

# A Hermes profile clone copies the base .env, BANKR_* included, and a profile's
# .env is loaded over the container env. Remove the BANKR_* lines from each
# profile .env holding one of the row's wallets, and from no other. After a
# disconnect nothing replaces them; after a connect the profile falls back to the
# container env this run delivers, which also replaces an older key for the same
# wallet. Same mode-preserving temp-file-then-mv rewrite; logs paths only.
for bankr_profile_env in /state/profiles/*/.env; do
  [ -f "$bankr_profile_env" ] || continue
  bankr_wallet_address_in_set "$(bankr_env_wallet_address "$bankr_profile_env")" || continue
  bankr_profile_env_tmp="$bankr_profile_env.bankr-clear.$$"
  if cp -p "$bankr_profile_env" "$bankr_profile_env_tmp" && awk '!/^(${WEBUI_BANKR_RUNTIME_ENV_KEYS.join("|")})=/' "$bankr_profile_env" > "$bankr_profile_env_tmp" && mv -f "$bankr_profile_env_tmp" "$bankr_profile_env"; then
    echo "[webui-update] removed BANKR_* from $bankr_profile_env"
  else
    rm -f "$bankr_profile_env_tmp"
    echo "[webui-update] WARNING: could not remove BANKR_* from $bankr_profile_env" >&2
  fi
done
`
      : "";
  const retiredEnvKeys = ["HERMES_WEBUI_PASSWORD"].join(" ");
  const canaryProbeEnvKeys = ["TELEGRAM_BOT_TOKEN"].join(" ");
  // Stale provisioning-time model pins. The official-dashboard's _resolve_model()
  // reads these from os.environ BEFORE config.yaml, so an outdated value (left
  // over from a provider/model change) forces every new chat session onto a
  // model whose static provider resolution is keyless -> "Provider 'openai-api'
  // … no API key". config.yaml owns the model now (buildHermesEnvFile no longer
  // writes HERMES_MODEL); scrub any legacy pin out of the preserved /state/.env
  // so a redeploy heals already-provisioned instances. See
  // reference_model-picker-keyless-provider-brick.
  const staleModelPinEnvKeys = ["HERMES_MODEL", "HERMES_INFERENCE_MODEL"].join(" ");
  const managedVeniceConfigRepairScript =
    isUpdate && isHermesManagedVeniceEndpoint(p)
      ? `
# Repair managed Venice provider drift in persisted config.yaml. Older fresh
# deploys seeded @venice:<model> into WebUI, which could rewrite the live config
# to provider: deepseek and make the agent ask for DEEPSEEK_API_KEY. Keep the
# user's saved config file, but repair only the model block back to the managed
# OpenAI-compatible proxy contract before update mode copies it into /seed.
managed_venice_base_url=${shellSingleQuote(p.baseUrl ?? "")}
managed_venice_default_model=${shellSingleQuote(p.defaultModel)}
if [ -f /state/config.yaml ] && [ -n "$managed_venice_base_url" ]; then
  if grep -Eq "^[[:space:]]+provider:[[:space:]]*[\\"']*(deepseek|venice)[\\"']*[[:space:]]*$|^[[:space:]]+default:[[:space:]]*[\\"']*@(venice|deepseek):" /state/config.yaml; then
    before_provider="$(sed -n 's/^[[:space:]]*provider:[[:space:]]*//p' /state/config.yaml | head -n1 || true)"
    before_default="$(sed -n 's/^[[:space:]]*default:[[:space:]]*//p' /state/config.yaml | head -n1 || true)"
    echo "[webui-update] Repair managed Venice provider drift in persisted config.yaml provider=\${before_provider:-<missing>} default=\${before_default:-<missing>} base_url=$managed_venice_base_url"
    managed_venice_config_tmp="/state/config.yaml.managed-venice.$$"
    awk -v managed_base_url="$managed_venice_base_url" -v managed_default_model="$managed_venice_default_model" '
function yaml_quote(value, out) {
  out = value
  gsub(/\\\\/, "\\\\\\\\", out)
  gsub(/"/, "\\\\\\"", out)
  return "\\"" out "\\""
}
function clean_default(line, value) {
  value = line
  sub(/^[[:space:]]*default:[[:space:]]*/, "", value)
  gsub(/^[\\"\\047]/, "", value)
  gsub(/[\\"\\047][[:space:]]*$/, "", value)
  sub(/^@venice:/, "", value)
  sub(/^@deepseek:/, "", value)
  if (value == "" || value ~ /^@/) value = managed_default_model
  return value
}
function emit_missing_model_fields() {
  if (!saw_default) print "  default: " yaml_quote(managed_default_model)
  if (!saw_provider) print "  provider: \\"custom\\""
  if (!saw_base_url) print "  base_url: " yaml_quote(managed_base_url)
}
function reset_model_flags() {
  saw_default = 0
  saw_provider = 0
  saw_base_url = 0
}
BEGIN {
  in_model = 0
  saw_model = 0
  reset_model_flags()
}
$0 ~ /^model:[[:space:]]*$/ {
  saw_model = 1
  in_model = 1
  reset_model_flags()
  print
  next
}
in_model && $0 ~ /^[^[:space:]#][^:]*:/ {
  emit_missing_model_fields()
  in_model = 0
}
in_model && $0 ~ /^[[:space:]]+default:/ {
  saw_default = 1
  print "  default: " yaml_quote(clean_default($0))
  next
}
in_model && $0 ~ /^[[:space:]]+provider:/ {
  saw_provider = 1
  print "  provider: \\"custom\\""
  next
}
in_model && $0 ~ /^[[:space:]]+base_url:/ {
  saw_base_url = 1
  print "  base_url: " yaml_quote(managed_base_url)
  next
}
{ print }
END {
  if (in_model) {
    emit_missing_model_fields()
  } else if (!saw_model) {
    print ""
    print "model:"
    print "  default: " yaml_quote(managed_default_model)
    print "  provider: \\"custom\\""
    print "  base_url: " yaml_quote(managed_base_url)
  }
}
' /state/config.yaml > "$managed_venice_config_tmp"
    if ! cmp -s "$managed_venice_config_tmp" /state/config.yaml; then
      backup_path="/state/config.yaml.pre-managed-venice-repair.$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s)"
      cp /state/config.yaml "$backup_path"
      mv -f "$managed_venice_config_tmp" /state/config.yaml
      after_provider="$(sed -n 's/^[[:space:]]*provider:[[:space:]]*//p' /state/config.yaml | head -n1 || true)"
      after_default="$(sed -n 's/^[[:space:]]*default:[[:space:]]*//p' /state/config.yaml | head -n1 || true)"
      after_base_url="$(sed -n 's/^[[:space:]]*base_url:[[:space:]]*//p' /state/config.yaml | head -n1 || true)"
      echo "[webui-update] managed Venice config repaired backup=$backup_path provider=\${after_provider:-<missing>} default=\${after_default:-<missing>} base_url=\${after_base_url:-<missing>}"
    else
      rm -f "$managed_venice_config_tmp"
      echo "[webui-update] managed Venice config already matches managed proxy contract"
    fi
  fi
fi
`
      : "";
  const stateSeedCommand = isUpdate
    ? `# Preserve existing WebUI state during update. The update button refreshes
# images and the mounted agent source, but model/provider config may have
# been changed live in WebUI and must not be overwritten by stale dashboard
# row values.
docker run --rm -i \\
  -v ${p.containerName}_webui-state:/state \\
  -v "$INSTANCE_DIR":/seed \\
  busybox sh <<'SH'
set -e
mkdir -p /state
${managedVeniceConfigRepairScript}${bankrReconcileStateScript}
if [ -f /state/config.yaml ]; then
  cp /state/config.yaml /seed/config.yaml
fi
cp /seed/hermes.env /tmp/hermes-generated.env
# Snapshot the freshly generated COMPOSE env (written by the .env heredoc a few
# steps up) before the copies below overwrite /seed/.env with the agent runtime
# env. This is the only in-container source for the compose-only keys, which are
# re-seeded from it further down.
if [ -f /seed/.env ]; then
  cp /seed/.env /tmp/hermes-compose-generated.env
fi
# Build the updated env in a temp file on the SAME volume, then publish with an
# atomic rename. The agent gateway reloads /state/.env every turn; editing it in
# place (sed -i) exposes a window where OPENAI_API_KEY is briefly absent -> the
# agent sends "Bearer no-key-required" and the managed proxy 401s.
webui_env_tmp="/state/.env.managed.$$"
if [ -f /state/.env ]; then
  cp /state/.env "$webui_env_tmp"
else
  cp /seed/hermes.env "$webui_env_tmp"
fi
managed_env_keys='${managedEnvKeys}'
sanitize_runtime_env_file() {
  env_file="$1"
  env_label="$2"
  [ -f "$env_file" ] || return 0
  sanitized_env_tmp="\${env_file}.sanitized.$$"
  if ! awk -v label="$env_label" '
    /^[[:space:]]*($|#)/ { print; next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ { print; next }
    {
      printf "[webui-update] invalid env key at line %d dropped from %s\\n", NR, label > "/dev/stderr"
    }
  ' "$env_file" > "$sanitized_env_tmp"; then
    rm -f "$sanitized_env_tmp"
    return 1
  fi
  mv -f "$sanitized_env_tmp" "$env_file"
}
echo "[webui-update] Repair dashboard-managed toolchain env keys in persisted WebUI state"
for managed_env_key in $managed_env_keys; do
  managed_env_line="$(grep -m1 "^\${managed_env_key}=" /tmp/hermes-generated.env || true)"
  [ -n "$managed_env_line" ] || continue
  if grep -q "^\${managed_env_key}=" "$webui_env_tmp"; then
    sed -i "s|^\${managed_env_key}=.*|\${managed_env_line}|" "$webui_env_tmp"
  else
    printf "\\n%s\\n" "$managed_env_line" >> "$webui_env_tmp"
  fi
done

# The CLEAR half of the same contract. The upsert loop above skips keys absent
# from the generated env, so without this a key the user DELETED in the dashboard
# lives on the box forever: Save returns 200 and the agent keeps using the secret
# they just removed. Only WEBUI_CLEARABLE_RUNTIME_ENV_KEYS gets this treatment —
# absence is only safe to read as "the user cleared it" for keys whose value is a
# pure read of the instance row. See the list's comment for why BANKR_* must not
# be cleared here (absent can mean "the wallet lookup threw").${clearBankrComment}
clearable_env_keys='${clearableEnvKeys}'${clearBankrKeysScript}
echo "[webui-update] Clear dashboard-managed runtime env keys the user removed"
for clearable_env_key in $clearable_env_keys; do
  if grep -q "^\${clearable_env_key}=" /tmp/hermes-generated.env; then
    continue
  fi
  if grep -q "^\${clearable_env_key}=" "$webui_env_tmp"; then
    echo "[webui-update]   drop \${clearable_env_key} (cleared in dashboard)"
    sed -i "/^\${clearable_env_key}=/d" "$webui_env_tmp"
  fi
done

# Retired WebUI Python password auth must not survive the Caddy bearer-auth
# migration. If this stale key remains in the persisted WebUI state, update
# mode copies it back into the compose env_file and WebUI shows its own
# "invalid password" screen even though the dashboard handoff is valid.
retired_env_keys='${retiredEnvKeys}'
echo "[webui-update] Remove retired WebUI password-auth env keys from persisted state"
for retired_env_key in $retired_env_keys; do
  if grep -q "^\${retired_env_key}=" "$webui_env_tmp"; then
    sed -i "/^\${retired_env_key}=/d" "$webui_env_tmp"
  fi
done

# Canary deploys use synthetic shape-probe credentials to verify env plumbing.
# If one leaks into tenant state, the gateway treats it as a real token and
# starts Telegram with 000000:CANARY_SHAPE_PROBE. Scrub only that sentinel so
# real user-provided messaging tokens survive ordinary image updates.
canary_probe_env_keys='${canaryProbeEnvKeys}'
echo "[webui-update] Remove leaked canary messaging probe credentials from persisted state"
for canary_probe_env_key in $canary_probe_env_keys; do
  if grep -q "^\${canary_probe_env_key}=.*CANARY_SHAPE_PROBE" "$webui_env_tmp"; then
    sed -i "/^\${canary_probe_env_key}=.*CANARY_SHAPE_PROBE/d" "$webui_env_tmp"
  fi
done

# Scrub stale provisioning-time model pins. The official-dashboard surface
# resolves the chat model via _resolve_model(), which reads HERMES_MODEL /
# HERMES_INFERENCE_MODEL from os.environ (hermes main() loads this .env with
# override=True) BEFORE config.yaml. A pin left over from a provider/model change
# never updates (live switches persist to config.yaml) and forces every new chat
# session onto a model whose static provider resolution can be keyless ->
# "Provider 'openai-api' ... no API key". config.yaml owns the model; drop the pin
# so the dashboard falls back to it. Heals already-provisioned instances on
# redeploy. See reference_model-picker-keyless-provider-brick.
stale_model_pin_env_keys='${staleModelPinEnvKeys}'
echo "[webui-update] Remove stale model-pin env keys from persisted state (config.yaml owns the model)"
for stale_model_pin_env_key in $stale_model_pin_env_keys; do
  if grep -q "^\${stale_model_pin_env_key}=" "$webui_env_tmp"; then
    sed -i "/^\${stale_model_pin_env_key}=/d" "$webui_env_tmp"
  fi
done
sanitize_runtime_env_file "$webui_env_tmp" "persisted WebUI state"
chmod 600 "$webui_env_tmp"
# Publish atomically, only when changed (skip needless rewrites of the file the
# gateway reloads every turn).
if [ ! -f /state/.env ] || ! cmp -s "$webui_env_tmp" /state/.env; then
  mv -f "$webui_env_tmp" /state/.env
else
  rm -f "$webui_env_tmp"
fi
cp /state/.env /seed/.env
cp /state/.env /seed/hermes.env
# Restore the dashboard-managed COMPOSE env. The two cp lines above overwrote
# .env -- the compose \`env_file\` for BOTH gateway and official-dashboard -- with
# the agent runtime env, which carries none of the compose-only keys. Everything
# the builder emits into .env but NOT into hermes.env was therefore dropped on
# every redeploy, and the container that reads it lost the key on its next
# recreate:
#   - HERMES_INSTANCE_ID -> the hivra_approval_relay plugin (official-dashboard)
#     can't POST blocked approvals to /api/internal/agent-notify.
#   - HERMES_DASHBOARD_BASIC_AUTH_* -> the hardened dashboard's "basic" provider
#     registers nothing, so the sidecar's password-login bridge can't mint the
#     gated cookie and the whole /desktop cookie lane dies (chat, which rides the
#     SPA token, keeps working -- which is why this hid for so long).
#   - HERMES_WEBUI_DEFAULT_MODEL / _BOT_NAME / _FRAME_POLICY and the generated
#     header.
# This previously re-seeded only HERMES_DASHBOARD_URL + API_SERVER_KEY (needed by
# the \`ru\` status callback in buildInstanceUpdateReporterShell, which reads them
# from this file to report the update outcome; without them it silently no-ops
# fleet-wide). Both are in the generated compose env with identical values, so
# overlaying the whole file subsumes that special case rather than replacing it.
#
# Precedence: delete-then-append makes the GENERATED compose env authoritative
# for every key it emits, while runtime-only keys preserved from /state/.env
# (the WEBUI_PERSISTENT_INSTALL_ENV_LINES toolchain block, BANKR_*, ...) stay put
# -- the gateway supervisor re-pins PINNED_INFRA_ENV_KEYS from this container env,
# so it must keep carrying them. Overlaying the dashboard-row provider keys here
# is safe: both containers load /state/.env over the container env at startup
# (gateway via profile_env's load_env_file, official-dashboard via hermes main()'s
# override=True), so a live-edited provider value still wins at runtime.
if [ -f /tmp/hermes-compose-generated.env ]; then
  echo "[webui-update] Re-seed dashboard-managed compose env keys into .env"
  sanitize_runtime_env_file /tmp/hermes-compose-generated.env "generated compose env"
  while IFS= read -r compose_env_line; do
    case "$compose_env_line" in
      ''|\\#*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    compose_env_key="\${compose_env_line%%=*}"
    sed -i "/^\${compose_env_key}=/d" /seed/.env
  done < /tmp/hermes-compose-generated.env
  cat /tmp/hermes-compose-generated.env >> /seed/.env
fi
chmod 600 /state/.env /seed/.env /seed/hermes.env
rm -f /tmp/hermes-generated.env /tmp/hermes-compose-generated.env /state/models_dev_cache.json /state/webui/models_cache.json

# Remove the Vex browser_sidecar toolset from toolsets lists (top-level + each
# profile). CDP mode drives a regular Chrome via the native browser tools, so
# the deterministic Vex toolset is never surfaced; this also strips any stale
# entry left in /state/config.yaml by a pre-CDP deploy. Idempotent removal.
desired_browser_sidecar='false'
merge_browser_sidecar_toolset() {
  cfg="$1"
  desired="$2"
  [ -f "$cfg" ] || return 0
  if [ "$desired" = "true" ]; then
    if ! grep -qE '^( {2})?- browser_sidecar$' "$cfg"; then
      awk '/^- hermes-cli$/ && !i { print; print "- browser_sidecar"; i=1; next } /^  - hermes-cli$/ && !i { print; print "  - browser_sidecar"; i=1; next } { print }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
    fi
  else
    if grep -qE '^( {2})?- browser_sidecar$' "$cfg"; then
      grep -vE '^( {2})?- browser_sidecar$' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
    fi
  fi
}
merge_browser_sidecar_toolset /state/config.yaml "$desired_browser_sidecar"
for prof_cfg in /state/profiles/*/config.yaml; do
  merge_browser_sidecar_toolset "$prof_cfg" "$desired_browser_sidecar"
done

chown -R 1024:1024 /state 2>/dev/null || true
SH`
    : `# Seed config.yaml + .env into the named volume on first start so the agent
# inside the container picks them up at /home/hermes/.hermes/.
docker run --rm \\
  -v ${p.containerName}_webui-state:/state \\
  -v "$INSTANCE_DIR":/seed:ro \\
  busybox sh -c 'mkdir -p /state && cp /seed/config.yaml /state/config.yaml && cp /seed/hermes.env /state/.env && chmod 600 /state/.env && if [ -f /seed/auth.json.inject ]; then cp /seed/auth.json.inject /state/auth.json && touch /state/auth.lock && chmod 600 /state/auth.json /state/auth.lock; fi && chown -R 1024:1024 /state'`;
  const terminalConfigSyncCommand = !isUpdate || opts.applyTerminalBackend === true
    ? `# Match the explicitly selected env backend in saved YAML before either
# agent service starts. Native config-to-env bridging otherwise restores a
# stale local backend. Preserve the rest of the owner's configuration.
docker run --rm -i --network none --user 0:0 \\
  -v ${p.containerName}_webui-state:/state \\
  -v "$INSTANCE_DIR":/seed \\
  --entrypoint /opt/hermes/.venv/bin/python \\
  ${agentImage} - ${shellSingleQuote(resolveWebUITerminalBackend(p))} /state/config.yaml /seed/config.yaml <<'HERMES_TERMINAL_CONFIG_PY'
${WEBUI_TERMINAL_CONFIG_SYNC_PYTHON}
HERMES_TERMINAL_CONFIG_PY
`
    : "";
  // Update mode keeps the box's config.yaml, so the reap-grace pin a fresh
  // provision gets from buildWebUIConfigYaml is repaired in here. Runs after the
  // agent image pull (it uses that image's Python) and before compose recreates
  // official-dashboard, which reads the key once at start.
  const wsOrphanReapRepairCommand = isUpdate
    ? buildWebUIWsOrphanReapRepairCommand({ containerName: p.containerName, agentImage })
    : "";
  const heredoc = (name: string, body: string) => {
    // Fail-loud guard: any user-controlled string that flows into `body`
    // (instance name, API keys, URLs, etc.) must not contain the heredoc
    // terminator on its own line, or the shell would end the heredoc early
    // and execute the trailing bytes as commands on the VM.
    if (/(^|\n)__HERMES_EOF__(\r?\n|$)/.test(body)) {
      throw new Error(
        `refusing to generate webui bootstrap script: heredoc body for "${name}" contains the EOF terminator`
      );
    }
    return `cat > ${name} <<'__HERMES_EOF__'\n${body}__HERMES_EOF__\n`;
  };
  return `#!/usr/bin/env bash
set -euo pipefail

INSTANCE_DIR="${stateDir}"
mkdir -p "$INSTANCE_DIR"
cd "$INSTANCE_DIR"

${hostTimeSyncRepairScript}
${buildHermesMemoryGuardProvisioningScript()}
${buildHermesAptQuiesceScript()}

${heredoc("docker-compose.yml", composeYaml)}
${heredoc("Caddyfile", artifacts.caddyfile)}
${heredoc("sidecar_server.js", artifacts.sidecarServerFile)}
${heredoc("signal-daemon.sh", artifacts.signalDaemonFile)}
${heredoc(".env", artifacts.envFile)}
${heredoc("config.yaml", artifacts.configYaml)}
${heredoc("hermes.env", artifacts.hermesEnvFile)}
${artifacts.authStoreFile ? heredoc("auth.json.inject", artifacts.authStoreFile) : "rm -f auth.json.inject\n"}
${gatewayDockerSocketPreparation}

GHCR_TOKEN="${process.env.GHCR_TOKEN || ""}"
if [ -n "$GHCR_TOKEN" ]; then
echo "$GHCR_TOKEN" | docker login ghcr.io -u __token__ --password-stdin 2>/dev/null || true
fi

${buildSslipPlaceholderResolutionScript(p.fqdn)}

docker network create hermes_net >/dev/null 2>&1 || true
docker volume create ${p.containerName}_webui-state >/dev/null
docker volume create ${p.containerName}_webui-workspace >/dev/null
docker volume create ${p.containerName}_agent-source >/dev/null
${buildEnsureBusyboxAvailableScript()}
${stateSeedCommand}
docker run --rm \\
  -v ${p.containerName}_webui-workspace:/workspace \\
  busybox sh -c 'mkdir -p /workspace && chown -R 1024:1024 /workspace'

${buildWebUIPersistentStatePermissionRepairCommand(p.containerName)}

${dockerCleanupFunctions}${taggedImageCleanupFunctions}${volumeSafeUpdateCleanupFunctions}${prePullCleanup}${agentPullCmd}
${runtimePasswdCommand}
${terminalConfigSyncCommand}${wsOrphanReapRepairCommand}docker run --rm \\
  -v ${p.containerName}_agent-source:/target \\
  --entrypoint sh \\
  ${agentImage} -lc 'set -e; test -f /opt/hermes/pyproject.toml; find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cp -a /opt/hermes/. /target/; if [ -d /target/.venv ]; then find /target/.venv -type f \\( -path "*/bin/*" -o -name "__editable__*.py" -o -name "*.pth" -o -name "direct_url.json" \\) -print 2>/dev/null | while IFS= read -r script; do sed -i "s|/opt/hermes|${WEBUI_HERMES_AGENT_DIR}|g" "$script"; done; fi; chown -R 1024:1024 /target'

# HermesOS rich chat (webui-free surface): the baked bundle's web-shim reads
# #iframe_token natively (no injection). The Caddyfile webfreeBlock points / and
# /webchat at this dir. Refreshed on every provision AND update so a UI change
# baked into the image's webchat_dist reaches users on the next deploy/roll.
${buildStaticSurfaceRefreshCommand({
  label: "rich chat (webui-free surface) — / + /webchat",
  srcDir: "webchat_dist",
  destName: "webchat",
  agentImage,
})}

# HermesOS Admin Panel: the base=/dash dashboard bundle (web_dist_dash) is baked
# with --base=/dash/; its <head> bootstrap reads #iframe_token + pins
# __HERMES_BASE_PATH__=/dash (no server-side injection). The Caddyfile webfreeBlock
# points /dash at this dir and rewrites /dash/api/* -> /desktop/api/* to the
# dashboard backend. Refreshed on every provision AND update (same as webchat).
${buildStaticSurfaceRefreshCommand({
  label: "Admin Panel — /dash",
  srcDir: "web_dist_dash",
  destName: "dash",
  agentImage,
})}

${buildWebUIPersistentStateShimCommand(p.containerName)}

${webuiPullCmd}
${buildWebUIRuntimeWatchdogProvisioningScript({
  instanceId: p.instanceId,
  containerName: p.containerName,
})}
${opts.additionalProvisioningScript ?? ""}
systemctl start hermes-memory-guard.service >/dev/null 2>&1 || /usr/local/bin/hermes-memory-guard || true
# Memory-safe gateway->webfree migration. The legacy gateway stack runs a
# \`-web\` container that the webfree compose does NOT define. If it's still
# running, \`compose up --force-recreate\` would briefly run BOTH stacks at once
# (old 3 + new 4-5 containers), spiking RAM past the 1GB free-tier cap mid-swap
# — the resource watchdog then shuts the VM down half-migrated, and on hosts
# without operator SSH that can't be hand-recovered. Down the old stack FIRST so
# the webfree stack starts into freed RAM. Same-stack webui->webui updates have
# no \`-web\` container, so this is a no-op for the existing fleet's daily redeploy.
if docker ps --format '{{.Names}}' | grep -qx "${p.containerName}-web"; then
  echo "[webui-bootstrap] legacy gateway stack present; downing it before webfree up (memory-safe migration)"
  docker compose down --remove-orphans || true
fi
compose_up_rc=0
timeout 180s docker compose up -d ${composeUpFlags} || compose_up_rc=$?
if [ "$compose_up_rc" != "0" ]; then
  if [ "$compose_up_rc" = "124" ]; then
    echo "[webui-bootstrap] WARN: docker compose up timed out after 180s; continuing only if a runtime container exists"
    docker compose ps || true
    ${composeUpTimeoutContinueGuard} || exit "$compose_up_rc"
  else
    echo "[webui-bootstrap] ERROR: docker compose up failed with exit $compose_up_rc" >&2
    exit "$compose_up_rc"
  fi
fi

${buildHostCaddyReloadScript({ optionalCompose: true })}
${updateConvergenceGate}
${seedOnboardingSoulFn}webui_free_stack_healthy() {
  for container in ${p.containerName}-gateway ${p.containerName}-official-dashboard ${p.containerName}-dashboard-sidecar; do
    state="$(docker inspect --format='running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || return 1
    printf '%s\n' "$state" | grep -q 'running=true' || return 1
    printf '%s\n' "$state" | grep -Eq 'health=(healthy|none)' || return 1
  done
}
webui_free_surface_ready() {
  # Container health != dashboard serving. The webfree shells (/ + /webchat rich
  # chat, /dash admin panel) are file_server'd by the in-VM edge Caddy from the
  # extracted bundles; an interrupted bundle extract or a stale Caddyfile leaves
  # /health green while the dashboard 404s in the workspace iframe (the
  # 2026-06-15 incident). Gate "healthy" on the public shells actually returning
  # SPA HTML so a 404ing box FAILS the deploy (applyLiveUpdate -> applied:false ->
  # recover-stuck redrives) instead of reporting false success. curl -f makes a
  # 404 a failure; the grep also trips on a 200-but-blank shell.
  for path in /webchat /dash; do
    # Probe through the in-VM Caddy regardless of host topology: Proxmox uses a
    # :80 site (fqdn="localhost"), Hetzner-host webfree keys the site on the real
    # FQDN with auto_https. Pin the configured FQDN to loopback (--resolve both
    # :80 and :443), follow the http->https redirect (-L), and accept the
    # ACME-pending/self-signed edge cert (-k). A bare localhost:80 request would
    # match no site on the Hetzner topology and false-fail every healthy deploy.
    body="$(curl -fsS -k -L --max-time 8 --resolve "${p.fqdn}:80:127.0.0.1" --resolve "${p.fqdn}:443:127.0.0.1" "http://${p.fqdn}$path" 2>/dev/null)" || return 1
    printf '%s' "$body" | grep -qiE '<!doctype html|id="root"|__HERMES_BASE_PATH__|<html' || return 1
  done
  return 0
}
# Wait for health
for i in $(seq 1 180); do
  if webui_free_stack_healthy && webui_free_surface_ready; then
    echo "[webui-bootstrap] WebUI-free stack healthy + dashboard surface serving"
    ${seedOnboardingSoulCall}
    echo "WebUI healthy"
${postUpdateCleanup}${postProvisionCleanup}    exit 0
  fi
  if docker inspect --format='{{.State.Running}}' ${p.containerName} 2>/dev/null | grep -qx true \
    && docker exec ${p.containerName} python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:${WEBUI_INTERNAL_PORT}/health", timeout=3).read()' >/dev/null 2>&1
  then
    ${buildWebUIPersistentStateShimCommand(p.containerName)}
    ${buildWebUIContainerCliShimCommand(p.containerName)}
    ${buildWebUIUsrLocalHermesShimCommand(p.containerName)}
    ${buildWebUIUsrLocalHermesShimCommand(`${p.containerName}-gateway`)}
    ${buildWebUIDeveloperToolBootstrapCommand(p.containerName)}
    ${buildWebUIHermesPythonRuntimeCommand(p.containerName)}
    ${buildWebUIToolchainDiagnosticCommand(p.containerName)}
    docker exec --user 1024 ${p.containerName} sh -lc 'export HOME=/home/hermes; export HERMES_HOME="/home/hermes/.hermes"; test -x "$(command -v hermes)" && test -x "$(command -v hermes-cli)"'
    ${seedOnboardingSoulCall}
    if webui_free_surface_ready; then
      echo "WebUI healthy"
${postUpdateCleanup}${postProvisionCleanup}      exit 0
    fi
  fi
  sleep 2
done
echo "WebUI did not become healthy (or dashboard surface not serving) in 360s" >&2
# Best-effort last seed before we give up: a slow-but-eventually-up box (the
# stack is often actually running by now, just not passing the surface probe)
# still gets its persona soul / onboarding ritual written, so a >6 min provision
# that later reaches "running" via recovery isn't left on the factory-default
# SOUL.md. Guard-protected + idempotent, and a no-op if no container is up yet
# (the recovery redrive, which now also seeds in update mode, retries it). The
# \`|| true\` keeps the bootstrap's failure exit code as 1 regardless.
${seedOnboardingSoulCall} || true
exit 1
`;
}
