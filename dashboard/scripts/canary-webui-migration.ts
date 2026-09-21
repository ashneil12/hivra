import { randomBytes } from "crypto";
import path from "path";
import * as dotenv from "dotenv";

// SCRIPTURE_ANCHOR: canary-scout | Numbers 13:2 | Verse: Send men, that they may spy out the land of Canaan, which I give to the children of Israel.
import { createClient } from "@supabase/supabase-js";

import { decryptApiKey, encryptApiKey } from "../src/lib/crypto";
import { sshExec } from "../src/lib/hetzner/ssh";
import { resolveInstanceIpv4 } from "../src/lib/services/instance-orchestrator";
import {
  buildHostCaddyReloadScript,
  resolveGatewayConfiguration,
  PROVIDER_ID_MAP,
} from "../src/lib/services/hetzner-instance-service";
import { resolveProviderBaseUrl } from "../src/lib/services/provider-config";
import {
  buildHermesEnvFile,
  resolveWebUIProviderEnvVar,
  buildWebUIBootstrapScript,
  buildWebUIConfigYaml,
  buildWebUIProvisioningArtifacts,
  type WebUIDeployParams,
} from "../src/lib/services/webui-instance-builder";
import {
  resolveDeploymentApiKey,
  resolveProviderDeploymentSecret,
} from "../src/lib/provider-deployment-auth";
import type { CodexVaultBundle } from "../src/lib/codex-oauth";
import { buildCodexHermesAuthStore } from "../src/lib/codex-oauth";
import { normalizeModelValue } from "../src/lib/models";
import { WebUIClient } from "../src/lib/webui/client";
import {
  buildWebUIDefaultModel,
  mapDashboardProviderToWebUI,
  normalizeWebUIProfileName,
} from "../src/lib/webui/profiles";
import { redactSensitiveCommandOutput } from "../src/lib/command-output-redaction";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

type Backend = "gateway" | "webui";

type InstanceRow = {
  id: string;
  user_id: string;
  name: string;
  status: string;
  backend?: Backend | null;
  provider: string;
  subdomain?: string | null;
  gateway_url?: string | null;
  api_key_encrypted: string;
  api_server_key_encrypted?: string | null;
  host_id?: string | null;
  ipv4_address?: string | null;
  cpu_limit?: number;
  ram_limit?: number;
  config?: Record<string, unknown>;
};

type HostRow = {
  id: string;
  ipv4_address?: string | null;
  hetzner_server_id?: number | null;
};

type ProfileRow = {
  id: string;
  name: string;
  display_name?: string | null;
  provider?: string | null;
  model?: string | null;
  system_prompt?: string | null;
  status?: string | null;
};

type Args = {
  target: string;
  apply: boolean;
  flipBackend: boolean;
  force: boolean;
  allowDisconnectedCodex: boolean;
  publicUrl?: string;
};

const WEBUI_HERMES_HOME = "/home/hermes/.hermes";
const WEBUI_TIMEOUT_MS = 10 * 60_000;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("--")) || process.env.INSTANCE_ID || process.env.INSTANCE_IP || "";

  if (!target) {
    throw new Error(
      "Usage: npm run migrate:webui:canary -- <instance-id-or-ip> --apply\n" +
      "Flags: --apply, --no-flip, --force"
    );
  }

  return {
    target,
    apply: args.includes("--apply"),
    flipBackend: !args.includes("--no-flip"),
    force: args.includes("--force"),
    allowDisconnectedCodex: args.includes("--allow-disconnected-codex"),
    publicUrl: readFlagValue(args, "--public-url"),
  };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    const value = inline.slice(flag.length + 1).trim();
    return value || undefined;
  }

  const index = args.indexOf(flag);
  if (index >= 0) {
    const value = args[index + 1]?.trim();
    return value && !value.startsWith("--") ? value : undefined;
  }

  return undefined;
}

function isIpAddress(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.trim());
}

function dashedIp(value: string): string {
  return value.replace(/\./g, "-");
}

function normalizePublicUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("--public-url must start with http:// or https://");
  }
  return trimmed;
}

function siteLabelFromPublicUrl(value: string): string {
  const parsed = new URL(normalizePublicUrl(value));
  return `${parsed.protocol}//${parsed.host}`;
}

function getAgentSettings(config?: Record<string, unknown> | null): Record<string, unknown> {
  const settings = config?.agentSettings;
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : {};
}

function getInstanceModel(instance: InstanceRow): string {
  const rawModel = typeof instance.config?.model === "string"
    ? instance.config.model
    : "";
  const normalized = normalizeModelValue(rawModel, instance.provider);
  return normalized || rawModel || "hermes-agent";
}

function getInstanceSystemPrompt(instance: InstanceRow): string | null {
  const settings = getAgentSettings(instance.config);
  const prompt = settings.systemPrompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : null;
}

function getCustomBaseUrl(instance: InstanceRow): string | undefined {
  const settings = getAgentSettings(instance.config);
  const baseUrl = settings.customLlmBaseUrl;
  return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
}

function profileHome(profileName?: string | null): string {
  const normalized = normalizeWebUIProfileName(profileName);
  return normalized === "default"
    ? WEBUI_HERMES_HOME
    : `${WEBUI_HERMES_HOME}/profiles/${normalized.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function formatRemoteError(result: { stderr?: string; error?: string }): string {
  return redactSensitiveCommandOutput(
    result.stderr?.trim() || result.error?.trim() || "Remote command failed",
    1_000
  );
}

async function runRemote(hostIp: string, script: string, label: string, timeoutMs = WEBUI_TIMEOUT_MS): Promise<string> {
  const result = await sshExec(hostIp, script, { timeoutMs });
  if (!result.ok) {
    throw new Error(`${label}: ${formatRemoteError(result)}`);
  }

  return result.stdout;
}

async function resolveInstance(target: string): Promise<InstanceRow> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .select("*")
    .neq("status", "deleted");

  if (error) {
    throw new Error(`Failed to load instances: ${error.message}`);
  }

  const instances = (data || []) as InstanceRow[];
  if (!isIpAddress(target)) {
    const instance = instances.find((row) => row.id === target);
    if (!instance) {
      throw new Error(`No instance found for id ${target}`);
    }
    return instance;
  }

  const direct = instances.filter((row) =>
    row.ipv4_address === target ||
    row.gateway_url?.includes(target) ||
    row.gateway_url?.includes(dashedIp(target))
  );
  if (direct.length === 1) {
    return direct[0];
  }

  const { data: hosts, error: hostError } = await supabase
    .from("hermes_hosts")
    .select("id, ipv4_address, hetzner_server_id")
    .eq("ipv4_address", target);

  if (hostError) {
    throw new Error(`Failed to look up host for ${target}: ${hostError.message}`);
  }

  const hostIds = new Set((hosts || []).map((host: HostRow) => host.id));
  const hostMatches = instances.filter((row) => row.host_id && hostIds.has(row.host_id));
  const matches = direct.length > 0 ? direct : hostMatches;

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one instance for ${target}, found ${matches.length}`);
  }

  return matches[0];
}

async function getProfiles(instance: InstanceRow): Promise<ProfileRow[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, display_name, provider, model, system_prompt, status")
    .eq("instance_id", instance.id)
    .eq("user_id", instance.user_id)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load profiles: ${error.message}`);
  }

  return (data || []) as ProfileRow[];
}

async function getHostIp(instance: InstanceRow): Promise<string> {
  const ip = await resolveInstanceIpv4(instance, supabase);
  if (!ip) {
    throw new Error(`Could not resolve IPv4 for ${instance.id}`);
  }
  return ip;
}

function buildWebUIParams(input: {
  instance: InstanceRow;
  hostIp: string;
  webuiPassword: string;
  deployApiKey: string;
  codexAuthBundle?: CodexVaultBundle;
}): WebUIDeployParams {
  const { instance, hostIp, webuiPassword, deployApiKey, codexAuthBundle } = input;
  const model = getInstanceModel(instance);
  const inferenceProvider =
    instance.provider === "custom_llm"
      ? "custom"
      : PROVIDER_ID_MAP[instance.provider] ?? instance.provider;
  const { fqdn } = resolveGatewayConfiguration({
    subdomain: instance.subdomain ?? null,
    ipv4: hostIp,
  });

  return {
    instanceId: instance.id,
    containerName: `agent-${instance.id}`,
    fqdn,
    cpuLimit: instance.cpu_limit ?? 1,
    ramLimit: instance.ram_limit ?? 2048,
    llmApiKey: deployApiKey,
    inferenceProvider,
    defaultModel: model,
    dashboardProvider: instance.provider,
    baseUrl: resolveProviderBaseUrl(instance.provider, getCustomBaseUrl(instance)) ?? undefined,
    webuiPassword,
    tavilyApiKey: typeof getAgentSettings(instance.config).tavilyApiKey === "string"
      ? getAgentSettings(instance.config).tavilyApiKey as string
      : undefined,
    firecrawlApiKey: typeof getAgentSettings(instance.config).firecrawlApiKey === "string"
      ? getAgentSettings(instance.config).firecrawlApiKey as string
      : undefined,
    codexAuthBundle,
  };
}

function buildBackupPrefix(instanceId: string, backupDir: string): string {
  return [
    `set -euo pipefail`,
    `INSTANCE_DIR=${JSON.stringify(`/opt/hermes/instances/${instanceId}`)}`,
    `BACKUP_DIR=${JSON.stringify(backupDir)}`,
    `mkdir -p "$(dirname "$BACKUP_DIR")"`,
    `if [ -d "$INSTANCE_DIR" ] && [ ! -d "$BACKUP_DIR" ]; then`,
    `  cp -a "$INSTANCE_DIR" "$BACKUP_DIR"`,
    `  echo "backup_created=$BACKUP_DIR"`,
    `fi`,
  ].join("\n");
}

function buildRollbackScript(instanceId: string, backupDir: string): string {
  const instanceDir = `/opt/hermes/instances/${instanceId}`;
  const failedDir = `${backupDir}.webui-failed`;
  return [
    `set -euo pipefail`,
    `INSTANCE_DIR=${JSON.stringify(instanceDir)}`,
    `BACKUP_DIR=${JSON.stringify(backupDir)}`,
    `FAILED_DIR=${JSON.stringify(failedDir)}`,
    `test -d "$BACKUP_DIR"`,
    `rm -rf "$FAILED_DIR"`,
    `if [ -d "$INSTANCE_DIR" ]; then mv "$INSTANCE_DIR" "$FAILED_DIR"; fi`,
    `cp -a "$BACKUP_DIR" "$INSTANCE_DIR"`,
    `cd "$INSTANCE_DIR"`,
    `docker compose up -d --remove-orphans`,
    buildHostCaddyReloadScript(),
  ].join("\n");
}

function webUIProviderId(provider: unknown): string | null {
  if (!provider || typeof provider !== "object") {
    return null;
  }
  const record = provider as Record<string, unknown>;
  for (const key of ["id", "provider", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function getSupportedWebUIProviderIds(client: WebUIClient): Promise<Set<string>> {
  const providers = await client.providers();
  return new Set(
    providers
      .map(webUIProviderId)
      .filter((providerId): providerId is string => Boolean(providerId))
  );
}

function buildProfileSeedScript(input: {
  instanceId: string;
  profileName: string;
  configYaml: string;
  envFile: string;
  authStoreFile?: string;
  systemPrompt?: string | null;
}): string {
  const soulB64 = input.systemPrompt?.trim() ? b64(input.systemPrompt) : "";
  const authStoreB64 = input.authStoreFile ? b64(input.authStoreFile) : "";
  return [
    `set -euo pipefail`,
    `CONTAINER_NAME=${JSON.stringify(`agent-${input.instanceId}`)}`,
    `PROFILE_HOME=${JSON.stringify(profileHome(input.profileName))}`,
    `CONFIG_B64=${JSON.stringify(b64(input.configYaml))}`,
    `ENV_B64=${JSON.stringify(b64(input.envFile))}`,
    `AUTH_B64=${JSON.stringify(authStoreB64)}`,
    `SOUL_B64=${JSON.stringify(soulB64)}`,
    `docker exec -u root -i -e PROFILE_HOME="$PROFILE_HOME" -e CONFIG_B64="$CONFIG_B64" -e ENV_B64="$ENV_B64" -e AUTH_B64="$AUTH_B64" -e SOUL_B64="$SOUL_B64" "$CONTAINER_NAME" sh -s <<'SH'`,
    `set -e`,
    `mkdir -p "$PROFILE_HOME"`,
    `printf "%s" "$CONFIG_B64" | base64 -d > "$PROFILE_HOME/config.yaml"`,
    `printf "%s" "$ENV_B64" | base64 -d > "$PROFILE_HOME/.env"`,
    `chmod 600 "$PROFILE_HOME/.env"`,
    `if [ -n "$AUTH_B64" ]; then`,
    `  printf "%s" "$AUTH_B64" | base64 -d > "$PROFILE_HOME/auth.json"`,
    `  touch "$PROFILE_HOME/auth.lock"`,
    `  chmod 600 "$PROFILE_HOME/auth.json" "$PROFILE_HOME/auth.lock"`,
    `fi`,
    `if [ -n "$SOUL_B64" ]; then`,
    `  printf "%s" "$SOUL_B64" | base64 -d > "$PROFILE_HOME/SOUL.md"`,
    `fi`,
    `chown -R 1024:1024 "$PROFILE_HOME" 2>/dev/null || true`,
    `SH`,
  ].join("\n");
}

function buildProfileRuntimeValidationScript(input: {
  instanceId: string;
  profileName: string;
  inferenceProvider: string;
  baseUrl?: string;
  requiredKeyEnvVar?: string;
}): string {
  return [
    `set -euo pipefail`,
    `CONTAINER_NAME=${JSON.stringify(`agent-${input.instanceId}`)}`,
    `PROFILE_HOME=${JSON.stringify(profileHome(input.profileName))}`,
    `EXPECTED_PROVIDER=${JSON.stringify(input.inferenceProvider)}`,
    `EXPECTED_BASE_URL=${JSON.stringify(input.baseUrl ?? "")}`,
    `REQUIRED_KEY_ENV_VAR=${JSON.stringify(input.requiredKeyEnvVar ?? "")}`,
    `docker exec -u root -i -e PROFILE_HOME="$PROFILE_HOME" -e EXPECTED_PROVIDER="$EXPECTED_PROVIDER" -e EXPECTED_BASE_URL="$EXPECTED_BASE_URL" -e REQUIRED_KEY_ENV_VAR="$REQUIRED_KEY_ENV_VAR" "$CONTAINER_NAME" python3 - <<'PY'`,
    `import os`,
    `from pathlib import Path`,
    ``,
    `profile_home = Path(os.environ["PROFILE_HOME"])`,
    `expected_provider = os.environ["EXPECTED_PROVIDER"]`,
    `expected_base_url = os.environ["EXPECTED_BASE_URL"]`,
    `required_key_env_var = os.environ["REQUIRED_KEY_ENV_VAR"]`,
    `config_path = profile_home / "config.yaml"`,
    `env_path = profile_home / ".env"`,
    `errors = []`,
    ``,
    `config = config_path.read_text() if config_path.exists() else ""`,
    `env = {}`,
    `if env_path.exists():`,
    `    for line in env_path.read_text().splitlines():`,
    `        if "=" in line and not line.lstrip().startswith("#"):`,
    `            key, value = line.split("=", 1)`,
    `            env[key] = value`,
    `else:`,
    `    errors.append(f"missing {env_path}")`,
    ``,
    `provider_markers = (f'provider: "{expected_provider}"', f"provider: {expected_provider}")`,
    `if not config or not any(marker in config for marker in provider_markers):`,
    `    errors.append(f"config.yaml does not select provider {expected_provider}")`,
    `if expected_base_url:`,
    `    base_url_markers = (f'base_url: "{expected_base_url}"', f"base_url: {expected_base_url}")`,
    `    if not any(marker in config for marker in base_url_markers):`,
    `        errors.append("config.yaml does not include the expected provider base URL")`,
    `if env.get("HERMES_INFERENCE_PROVIDER") != expected_provider:`,
    `    errors.append("runtime env does not match the expected provider")`,
    `if required_key_env_var and not env.get(required_key_env_var):`,
    `    errors.append(f"runtime env is missing a non-empty {required_key_env_var}")`,
    ``,
    `if errors:`,
    `    raise SystemExit("; ".join(errors))`,
    `print("runtime_config_validated")`,
    `PY`,
  ].join("\n");
}

async function waitForWebUI(client: WebUIClient): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      // /api/status is the real agent route; /health returns the SPA HTML
      // shell on the fleet image (see WebUIClient.status()).
      const status = await client.status();
      if (status && (status.gateway_running === true || typeof status.gateway_state === "string")) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`WebUI did not pass health checks: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function ensureProfiles(input: {
  client: WebUIClient;
  hostIp: string;
  instance: InstanceRow;
  profiles: ProfileRow[];
  codexAuthStoreFile?: string;
  rawInstanceSecret: string;
}): Promise<void> {
  const { client, hostIp, instance, profiles, codexAuthStoreFile, rawInstanceSecret } = input;
  const existing = await client.profiles();
  const existingNames = new Set((existing.profiles || []).map((profile) => normalizeWebUIProfileName(profile.name)));
  const supportedProviderIds = await getSupportedWebUIProviderIds(client);

  for (const profile of profiles) {
    const name = normalizeWebUIProfileName(profile.name);
    if (name === "default") {
      continue;
    }
    if (!existingNames.has(name)) {
      await client.createProfile({
        name,
        clone_from: "default",
        clone_config: true,
      });
      existingNames.add(name);
    }
  }

  const allProfiles: Array<{
    name: string;
    provider: string;
    model: string;
    systemPrompt: string | null;
  }> = [
    {
      name: "default",
      provider: instance.provider,
      model: getInstanceModel(instance),
      systemPrompt: getInstanceSystemPrompt(instance),
    },
    ...profiles.map((profile) => ({
      name: normalizeWebUIProfileName(profile.name),
      provider: profile.provider?.trim() || instance.provider,
      model: normalizeModelValue(profile.model?.trim() || getInstanceModel(instance), profile.provider || instance.provider)
        || profile.model?.trim()
        || getInstanceModel(instance),
      systemPrompt: profile.system_prompt?.trim() || null,
    })),
  ];

  for (const profile of allProfiles) {
    const webuiProvider = mapDashboardProviderToWebUI(profile.provider) ?? profile.provider;
    const webuiModel = buildWebUIDefaultModel(profile.model, profile.provider, { supportedProviderIds });
    await client.setDefaultModel(webuiModel, { profile: profile.name });

    if (profile.provider !== "codex" && rawInstanceSecret.trim() && supportedProviderIds.has(webuiProvider)) {
      await client.setProviderKey(webuiProvider, rawInstanceSecret, { profile: profile.name });
    } else if (profile.provider !== "codex" && rawInstanceSecret.trim()) {
      console.log(`Skipping WebUI provider-key API for ${profile.name}; provider ${webuiProvider} is configured via runtime env.`);
    }

    const inferenceProvider =
      profile.provider === "custom_llm"
        ? "custom"
        : PROVIDER_ID_MAP[profile.provider] ?? profile.provider;
    const params: WebUIDeployParams = {
      instanceId: instance.id,
      containerName: `agent-${instance.id}`,
      fqdn: "localhost",
      llmApiKey: profile.provider === "codex" ? "" : rawInstanceSecret,
      inferenceProvider,
      defaultModel: profile.model,
      dashboardProvider: profile.provider,
      baseUrl: resolveProviderBaseUrl(profile.provider, getCustomBaseUrl(instance)) ?? undefined,
      webuiPassword: "unused",
    };

    await runRemote(
      hostIp,
      buildProfileSeedScript({
        instanceId: instance.id,
        profileName: profile.name,
        configYaml: buildWebUIConfigYaml(params),
        envFile: buildHermesEnvFile(params),
        authStoreFile: profile.provider === "codex" ? codexAuthStoreFile : undefined,
        systemPrompt: profile.systemPrompt,
      }),
      `Seed profile ${profile.name}`,
      90_000
    );

    await runRemote(
      hostIp,
      buildProfileRuntimeValidationScript({
        instanceId: instance.id,
        profileName: profile.name,
        inferenceProvider,
        baseUrl: params.baseUrl,
        requiredKeyEnvVar: profile.provider === "codex" || !rawInstanceSecret.trim()
          ? undefined
          : resolveWebUIProviderEnvVar(inferenceProvider),
      }),
      `Validate runtime config for ${profile.name}`,
      90_000
    );
  }

  const defaultProfile = allProfiles.find((profile) => profile.name === "default");
  if (defaultProfile) {
    await client.setDefaultModel(
      buildWebUIDefaultModel(defaultProfile.model, defaultProfile.provider, { supportedProviderIds }),
      { profile: "default" }
    );
  }
}

async function smokeProfiles(client: WebUIClient, expectedProfiles: string[]): Promise<void> {
  const payload = await client.profiles();
  const names = new Set((payload.profiles || []).map((profile) => normalizeWebUIProfileName(profile.name)));
  const missing = expectedProfiles.filter((name) => !names.has(normalizeWebUIProfileName(name)));
  if (missing.length > 0) {
    throw new Error(`WebUI is missing profiles: ${missing.join(", ")}`);
  }

  await client.models();
  await client.settings({ profile: "default" });
  for (const profile of expectedProfiles.filter((name) => normalizeWebUIProfileName(name) !== "default")) {
    await client.settings({ profile });
  }
}

async function main() {
  const args = parseArgs();
  const instance = await resolveInstance(args.target);
  const profiles = await getProfiles(instance);

  if (instance.backend === "webui" && !args.force) {
    throw new Error(`${instance.id} is already marked webui. Use --force to resync.`);
  }

  const hostIp = await getHostIp(instance);
  const rawInstanceSecret = instance.api_key_encrypted ? decryptApiKey(instance.api_key_encrypted) : "";
  const providerSecret = resolveProviderDeploymentSecret(instance.provider, rawInstanceSecret);
  const deployApiKey = resolveDeploymentApiKey(rawInstanceSecret, providerSecret);
  const codexBundle = instance.provider === "codex"
    ? providerSecret.authBundle as CodexVaultBundle | undefined
    : undefined;

  if (instance.provider === "codex" && !codexBundle && !args.allowDisconnectedCodex) {
    throw new Error("Codex canary requires a reusable OAuth bundle on the instance.");
  }
  if (instance.provider === "codex" && !codexBundle && args.allowDisconnectedCodex) {
    console.warn("Codex OAuth bundle not found; migrating WebUI runtime with Codex disconnected.");
  }

  const hadApiServerKey = Boolean(instance.api_server_key_encrypted);
  const webuiPassword = instance.api_server_key_encrypted
    ? decryptApiKey(instance.api_server_key_encrypted)
    : randomBytes(32).toString("hex");
  const params = buildWebUIParams({
    instance,
    hostIp,
    webuiPassword,
    deployApiKey,
    codexAuthBundle: codexBundle,
  });
  const gatewayUrl = resolveGatewayConfiguration({
    subdomain: instance.subdomain ?? null,
    ipv4: hostIp,
  }).gatewayUrl;
  const publicUrl = args.publicUrl ? normalizePublicUrl(args.publicUrl) : gatewayUrl;
  if (args.publicUrl) {
    params.fqdn = siteLabelFromPublicUrl(args.publicUrl);
  }
  const artifacts = buildWebUIProvisioningArtifacts(params);
  const deployScript = buildWebUIBootstrapScript(artifacts, params);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const backupDir = `/opt/hermes/instance-backups/${instance.id}-pre-webui-${timestamp}`;

  console.log(`Canary target: ${instance.name} (${instance.id})`);
  console.log(`Host: ${hostIp}`);
  console.log(`Profiles: ${["default", ...profiles.map((profile) => profile.name)].join(", ")}`);
  console.log(`Gateway URL: ${publicUrl}`);

  if (!args.apply) {
    console.log("Dry run only. Re-run with --apply to deploy WebUI and flip the canary row.");
    return;
  }

  let flipped = false;
  try {
    console.log("Deploying WebUI runtime...");
    await runRemote(
      hostIp,
      `${buildBackupPrefix(instance.id, backupDir)}\n${deployScript}`,
      "Deploy WebUI",
      WEBUI_TIMEOUT_MS
    );

    const client = new WebUIClient({ baseUrl: publicUrl, password: webuiPassword, timeoutMs: 30_000 });
    await waitForWebUI(client);

    console.log("Syncing WebUI profiles...");
    const codexAuthStoreFile = codexBundle ? buildCodexHermesAuthStore(codexBundle) : undefined;
    await ensureProfiles({
      client,
      hostIp,
      instance,
      profiles,
      codexAuthStoreFile,
      rawInstanceSecret,
    });

    await smokeProfiles(client, ["default", ...profiles.map((profile) => profile.name)]);

    if (args.flipBackend) {
      const updates: Record<string, unknown> = {
        backend: "webui",
        status: "running",
        gateway_url: publicUrl,
        updated_at: new Date().toISOString(),
      };
      if (!hadApiServerKey) {
        updates.api_server_key_encrypted = encryptApiKey(webuiPassword);
      }
      const { error } = await supabase
        .from("hermes_instances")
        .update(updates)
        .eq("id", instance.id);
      if (error) {
        throw new Error(`Failed to flip backend row: ${error.message}`);
      }
      flipped = true;
      console.log("Backend row flipped to webui.");
    } else {
      console.log("Skipped backend row flip because --no-flip was set.");
    }

    console.log("Canary migration complete.");
  } catch (error) {
    console.error(`Canary migration failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Attempting rollback to the pre-WebUI runtime backup...");
    await runRemote(hostIp, buildRollbackScript(instance.id, backupDir), "Rollback WebUI", WEBUI_TIMEOUT_MS).catch((rollbackError) => {
      console.error(`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    });

    if (flipped) {
      await supabase
        .from("hermes_instances")
        .update({
          backend: "gateway",
          status: "running",
          updated_at: new Date().toISOString(),
        })
        .eq("id", instance.id);
    }

    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
