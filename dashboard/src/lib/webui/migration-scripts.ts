import { normalizeWebUIProfileName } from "@/lib/webui/profiles";

const WEBUI_HERMES_HOME = "/home/hermes/.hermes";

// Every value spliced into these host scripts is POSIX single-quoted: some come
// from customer-controlled instance config (for example customLlmBaseUrl), and
// double quotes would still let bash expand $(...) and backticks.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function profileHome(profileName?: string | null): string {
  const normalized = normalizeWebUIProfileName(profileName);
  return normalized === "default"
    ? WEBUI_HERMES_HOME
    : `${WEBUI_HERMES_HOME}/profiles/${normalized.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function buildProfileSeedScript(input: {
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
    `CONTAINER_NAME=${shQuote(`agent-${input.instanceId}`)}`,
    `PROFILE_HOME=${shQuote(profileHome(input.profileName))}`,
    `CONFIG_B64=${shQuote(b64(input.configYaml))}`,
    `ENV_B64=${shQuote(b64(input.envFile))}`,
    `AUTH_B64=${shQuote(authStoreB64)}`,
    `SOUL_B64=${shQuote(soulB64)}`,
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

export function buildProfileRuntimeValidationScript(input: {
  instanceId: string;
  profileName: string;
  inferenceProvider: string;
  baseUrl?: string;
  requiredKeyEnvVar?: string;
}): string {
  return [
    `set -euo pipefail`,
    `CONTAINER_NAME=${shQuote(`agent-${input.instanceId}`)}`,
    `PROFILE_HOME=${shQuote(profileHome(input.profileName))}`,
    `EXPECTED_PROVIDER=${shQuote(input.inferenceProvider)}`,
    `EXPECTED_BASE_URL=${shQuote(input.baseUrl ?? "")}`,
    `REQUIRED_KEY_ENV_VAR=${shQuote(input.requiredKeyEnvVar ?? "")}`,
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
