import { decryptApiKey } from "@/lib/crypto";
import { sshExec } from "@/lib/hetzner/ssh";
import {
  buildCodexHermesAuthStore,
  parseCodexVaultBundle,
  type CodexVaultBundle,
} from "@/lib/codex-oauth";
import { isCodexAuthProvider } from "@/lib/provider-auth";
import { log } from "@/lib/logger";
import { buildHostTimeSyncRepairScript } from "@/lib/services/hetzner-instance-builders";
import { supabaseAdmin } from "@/lib/supabase";

const CODEX_RUNTIME_POST_RESTART_SYNC_DELAY_MS = process.env.NODE_ENV === "test" ? 0 : 2_500;
const CODEX_RUNTIME_POST_RESTART_SYNC_RETRY_COUNT = process.env.NODE_ENV === "test" ? 1 : 3;

function getCodexRuntimeContainerNames(instanceId: string): string[] {
  // agent-<id>-gateway is the webfree runtime container; it shares the
  // webui-state volume with agent-<id>-official-dashboard, so syncing
  // through the gateway covers both.
  return [
    `agent-${instanceId}`,
    `agent-${instanceId}-web`,
    `agent-${instanceId}-acp`,
    `agent-${instanceId}-mcp`,
    `agent-${instanceId}-gateway`,
  ];
}

function buildCodexRuntimeAuthSyncInnerScript(): string {
  return [
    `set -e`,
    `sync_auth_store() {`,
    `  target_home="$1"`,
    `  target_owner="$2"`,
    `  auth_path="$target_home/auth.json"`,
    `  lock_path="$target_home/auth.lock"`,
    `  mkdir -p "$target_home"`,
    `  if [ ! -f "$auth_path" ] || ! cmp -s "$TMP_FILE" "$auth_path"; then next_path="$auth_path.next.$$"; cp "$TMP_FILE" "$next_path"; mv "$next_path" "$auth_path"; changed=1; fi`,
    `  if [ ! -e "$lock_path" ]; then touch "$lock_path"; changed=1; fi`,
    `  auth_owner="$(stat -c "%U:%G" "$auth_path" 2>/dev/null || true)"`,
    `  lock_owner="$(stat -c "%U:%G" "$lock_path" 2>/dev/null || true)"`,
    `  if [ "$auth_owner" != "$target_owner" ] || [ "$lock_owner" != "$target_owner" ]; then chown "$target_owner" "$auth_path" "$lock_path"; changed=1; fi`,
    `  auth_mode="$(stat -c "%a" "$auth_path" 2>/dev/null || true)"`,
    `  lock_mode="$(stat -c "%a" "$lock_path" 2>/dev/null || true)"`,
    `  if [ "$auth_mode" != "600" ] || [ "$lock_mode" != "600" ]; then chmod 600 "$auth_path" "$lock_path"; changed=1; fi`,
    `}`,
    `resolve_target_owner() {`,
    `  target_home="$1"`,
    `  existing_owner="$(stat -c "%U:%G" "$target_home" 2>/dev/null || true)"`,
    `  if [ -n "$existing_owner" ] && [ "$existing_owner" != "UNKNOWN:UNKNOWN" ]; then`,
    `    printf "%s" "$existing_owner"`,
    `    return`,
    `  fi`,
    `  if [ "$target_home" = "/opt/data" ] && id hermes >/dev/null 2>&1; then`,
    `    printf "%s" "hermes:hermes"`,
    `    return`,
    `  fi`,
    `  printf "%s" "root:root"`,
    `}`,
    `TMP_FILE="$(mktemp)"`,
    `trap 'rm -f "$TMP_FILE"' EXIT`,
    `printf "%s" "$AUTH_B64" | base64 -d > "$TMP_FILE"`,
    `changed=0`,
    `sync_auth_store "$BASE_HOME" "$(resolve_target_owner "$BASE_HOME")"`,
    `if [ -n "$LEGACY_BASE_HOME" ] && [ "$LEGACY_BASE_HOME" != "$BASE_HOME" ]; then`,
    `  sync_auth_store "$LEGACY_BASE_HOME" "$(resolve_target_owner "$LEGACY_BASE_HOME")"`,
    `fi`,
    `printf "%s" "$changed"`,
  ].join("\n");
}

function isTransientCodexRuntimeSyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("received 409") ||
    message.includes("container is restarting") ||
    message.includes("is not running") ||
    message.includes("no such container") ||
    message.includes("unable to upgrade to tcp")
  );
}

export function readCachedCodexVaultBundle(
  encryptedInstanceSecret: string | null | undefined
): CodexVaultBundle | null {
  if (!encryptedInstanceSecret) {
    return null;
  }

  try {
    const rawSecret = decryptApiKey(encryptedInstanceSecret);
    const bundle = parseCodexVaultBundle(rawSecret);
    if (!bundle?.accessToken || !bundle.refreshToken) {
      return null;
    }

    return bundle;
  } catch {
    return null;
  }
}

export async function loadUserCodexVaultBundle(userId: string): Promise<{
  bundle: CodexVaultBundle | null;
  encryptedKey: string | null;
  vaultKeyId: string | null;
}> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  type CodexVaultRow = { id?: unknown; encrypted_key?: unknown } | null;
  let query = supabaseAdmin
    .from("user_api_keys")
    .select("id, encrypted_key")
    .eq("user_id", userId)
    .eq("provider", "codex")
    .eq("is_active", true) as unknown as {
      order?: (...args: unknown[]) => unknown;
      limit?: (...args: unknown[]) => unknown;
      maybeSingle: () => Promise<{ data: CodexVaultRow; error: { message?: string } | null }>;
    };

  if (typeof query.order === "function") {
    query = query.order("updated_at", { ascending: false }) as typeof query;
  }

  if (typeof query.limit === "function") {
    query = query.limit(1) as typeof query;
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`Failed to load Codex Vault session: ${error.message}`);
  }

  const encryptedKey = typeof data?.encrypted_key === "string" ? data.encrypted_key : null;
  return {
    bundle: readCachedCodexVaultBundle(encryptedKey),
    encryptedKey,
    vaultKeyId: typeof data?.id === "string" ? data.id : null,
  };
}

export function hasCodexBundleChanged(
  encryptedInstanceSecret: string | null | undefined,
  nextBundle: CodexVaultBundle
): boolean {
  if (!encryptedInstanceSecret) {
    return true;
  }

  try {
    const existingRaw = decryptApiKey(encryptedInstanceSecret);
    const existingBundle = parseCodexVaultBundle(existingRaw);
    if (!existingBundle) {
      return true;
    }

    return (
      existingBundle.accessToken !== nextBundle.accessToken ||
      existingBundle.refreshToken !== nextBundle.refreshToken ||
      existingBundle.lastRefresh !== nextBundle.lastRefresh ||
      (existingBundle.baseUrl || "") !== (nextBundle.baseUrl || "")
    );
  } catch {
    return true;
  }
}

export async function restartCodexGateway(
  instanceId: string,
  hostIp: string
): Promise<boolean> {
  const containerNames = getCodexRuntimeContainerNames(instanceId);
  const restartResult = await sshExec(
    hostIp,
    [
      `set -e`,
      buildHostTimeSyncRepairScript(),
      `containers_to_restart=""`,
      `for container_name in ${containerNames.join(" ")}; do`,
      `  if docker inspect --format='{{.State.Running}}' "$container_name" 2>/dev/null | grep -q true; then`,
      `    containers_to_restart="$containers_to_restart $container_name"`,
      `  fi`,
      `done`,
      `RESTART_CONTAINERS="\${containers_to_restart# }"`,
      `if [ -n "$RESTART_CONTAINERS" ]; then`,
      `  nohup env RESTART_CONTAINERS="$RESTART_CONTAINERS" sh -c 'sleep 2 && docker restart $RESTART_CONTAINERS >/dev/null 2>&1' >/dev/null 2>&1 &`,
      `  printf "{\\"restarted\\":true}\\n"`,
      `else`,
      `  printf "{\\"restarted\\":false}\\n"`,
      `fi`,
    ].join("\n")
  );

  if (!restartResult.ok) {
    return false;
  }

  const output = (restartResult.stdout || "").trim();
  if (!output) {
    return true;
  }

  try {
    const parsed = JSON.parse(output) as { restarted?: unknown };
    return parsed.restarted === true || parsed.restarted === 1 || parsed.restarted === "1";
  } catch {
    return true;
  }
}

async function repairCodexHostTimeSync(hostIp: string): Promise<void> {
  const repairResult = await sshExec(
    hostIp,
    [
      `set -e`,
      buildHostTimeSyncRepairScript(),
    ].join("\n")
  );

  if (!repairResult.ok) {
    throw new Error(
      repairResult.stderr?.trim() || repairResult.error || "Failed to repair host time synchronization."
    );
  }
}

export async function syncCodexRuntimeAuthStore(
  instanceId: string,
  hostIp: string,
  bundle: CodexVaultBundle,
  hermesHomeDir: string
): Promise<{ changed: boolean }> {
  const authStoreB64 = Buffer.from(buildCodexHermesAuthStore(bundle), "utf-8").toString("base64");
  const innerScript = buildCodexRuntimeAuthSyncInnerScript();
  const containerNames = getCodexRuntimeContainerNames(instanceId);
  const legacyMirrorHomeDir = hermesHomeDir === "/opt/data" ? "/root/.hermes" : "/opt/data";
  const syncResult = await sshExec(
    hostIp,
    [
      `set -e`,
      `BASE_HOME=${JSON.stringify(hermesHomeDir)}`,
      `LEGACY_BASE_HOME=${JSON.stringify(legacyMirrorHomeDir)}`,
      `AUTH_B64="${authStoreB64}"`,
      `changed=0`,
      `synced=0`,
      `for container_name in ${containerNames.join(" ")}; do`,
      `  if ! docker inspect --format='{{.State.Running}}' "$container_name" 2>/dev/null | grep -q true; then`,
      `    continue`,
      `  fi`,
      `  container_changed="$(docker exec -u root -i -e BASE_HOME="$BASE_HOME" -e LEGACY_BASE_HOME="$LEGACY_BASE_HOME" -e AUTH_B64="$AUTH_B64" "$container_name" sh -s <<'SH'`,
      innerScript,
      `SH`,
      `)"`,
      `  synced=1`,
      `  if [ "$container_changed" = "1" ]; then`,
      `    changed=1`,
      `  fi`,
      `done`,
      `printf "{\\"changed\\":%s,\\"synced\\":%s}\\n" "$changed" "$synced"`,
    ].join("\n")
  );

  if (!syncResult.ok) {
    throw new Error(
      syncResult.stderr?.trim() || syncResult.error || "Failed to synchronize Codex auth store to the runtime container."
    );
  }

  const output = (syncResult.stdout || "").trim();
  if (!output) {
    return { changed: false };
  }

  try {
    const parsed = JSON.parse(output) as { changed?: unknown; synced?: unknown };
    const synced = parsed.synced === true || parsed.synced === 1 || parsed.synced === "1";
    if (!synced) {
      log.warn("no running agent container matched while syncing Codex runtime auth", {
        source: "codex-runtime-auth",
        instanceId,
        failureType: "codex_runtime_sync_no_container",
        candidateContainers: containerNames.join(", "),
      });
    }
    return { changed: parsed.changed === true || parsed.changed === 1 || parsed.changed === "1" };
  } catch {
    throw new Error(`Failed to parse Codex runtime sync result: ${output}`);
  }
}

async function repairCodexRuntimeAuthFromBundle(params: {
  instanceId: string;
  hostIp: string;
  hermesHomeDir: string;
  bundle: CodexVaultBundle;
}): Promise<{ attempted: boolean; changed: boolean; restarted: boolean }> {
  const runtimeSync = await syncCodexRuntimeAuthStore(
    params.instanceId,
    params.hostIp,
    params.bundle,
    params.hermesHomeDir
  );

  const restarted = runtimeSync.changed
    ? await restartCodexGateway(params.instanceId, params.hostIp)
    : false;

  if (!runtimeSync.changed) {
    await repairCodexHostTimeSync(params.hostIp);
  }

  if (restarted) {
    for (let attempt = 0; attempt < CODEX_RUNTIME_POST_RESTART_SYNC_RETRY_COUNT; attempt += 1) {
      if (CODEX_RUNTIME_POST_RESTART_SYNC_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, CODEX_RUNTIME_POST_RESTART_SYNC_DELAY_MS));
      }

      try {
        await syncCodexRuntimeAuthStore(
          params.instanceId,
          params.hostIp,
          params.bundle,
          params.hermesHomeDir
        );
        break;
      } catch (error) {
        const isLastAttempt = attempt === CODEX_RUNTIME_POST_RESTART_SYNC_RETRY_COUNT - 1;
        if (isLastAttempt || !isTransientCodexRuntimeSyncError(error)) {
          throw error;
        }
      }
    }
  }

  return {
    attempted: true,
    changed: runtimeSync.changed,
    restarted,
  };
}

export async function repairCodexRuntimeAuthFromStoredSession(params: {
  instanceId: string;
  hostIp: string;
  hermesHomeDir: string;
  encryptedInstanceSecret: string | null | undefined;
  provider: string | null | undefined;
}): Promise<{ attempted: boolean; changed: boolean; restarted: boolean }> {
  if (!isCodexAuthProvider(params.provider)) {
    return { attempted: false, changed: false, restarted: false };
  }

  const bundle = readCachedCodexVaultBundle(params.encryptedInstanceSecret);
  if (!bundle) {
    return { attempted: false, changed: false, restarted: false };
  }

  return repairCodexRuntimeAuthFromBundle({
    instanceId: params.instanceId,
    hostIp: params.hostIp,
    hermesHomeDir: params.hermesHomeDir,
    bundle,
  });
}
