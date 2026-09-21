import {
  buildCodexHermesAuthStore,
  buildCodexStartCommand,
  buildCodexStatusCommand,
  formatStoredProviderSecretPreview,
  parseCodexVaultBundle,
  readCodexAuthenticatedFlag,
  serializeCodexVaultBundle,
} from "@/lib/codex-oauth";
import { serializeNousVaultBundle } from "@/lib/nous-oauth";

describe("codex-oauth helpers", () => {
  it("reads authenticated from the wrapped apiSuccess payload", () => {
    expect(readCodexAuthenticatedFlag({ success: true, data: { authenticated: true } })).toBe(true);
    expect(readCodexAuthenticatedFlag({ success: true, data: { authenticated: false } })).toBe(false);
  });

  it("accepts the legacy flat authenticated shape", () => {
    expect(readCodexAuthenticatedFlag({ authenticated: true })).toBe(true);
  });

  it("builds the start command around Hermes-managed auth state", () => {
    const command = buildCodexStartCommand("inst_123", "hermes");
    expect(command).toContain('docker exec -u "hermes" -i "$AGENT_CONTAINER"');
    expect(command).toContain('os.environ.get("HERMES_HOME")');
    expect(command).toContain("deviceauth/usercode");
    expect(command).toContain('"User-Agent": "Codex/0.122.0-alpha.1 (Hermes OAuth helper)"');
    expect(command).not.toContain("codex login --device-auth");
    expect(command).not.toContain("/root/.codex/auth.json");
    expect(command).not.toContain("import httpx");
    expect(command).not.toContain("from hermes_cli.auth import CODEX_OAUTH_CLIENT_ID");
    expect(command).toContain('getattr(auth_module, "CODEX_OAUTH_CLIENT_ID"');
    expect(command).toContain("urlopen");
  });

  it("resolves the running container across the webui and webfree topologies", () => {
    for (const command of [
      buildCodexStartCommand("inst_123", "hermes"),
      buildCodexStatusCommand("inst_123", "hermes"),
    ]) {
      expect(command).toContain(
        "for candidate_container in agent-inst_123 agent-inst_123-gateway; do"
      );
      expect(command).toContain(
        'docker inspect --format=\'{{.State.Running}}\' "$candidate_container"'
      );
      // classifyCodexStartFailure keys on this docker stderr to map the
      // failure to container_unavailable; the sentinel must stay intact.
      expect(command).toContain(
        'echo "Error response from daemon: No such container: agent-inst_123" >&2'
      );
      expect(command.indexOf('if [ -z "$AGENT_CONTAINER" ]; then')).toBeLessThan(
        command.indexOf("docker exec -u")
      );
    }
  });

  it("targets an explicit Hermes home when a profile runtime is selected", () => {
    const command = buildCodexStartCommand("inst_123", "hermes", "/opt/data/profiles/marcus");
    expect(command).toContain('export HERMES_HOME="/opt/data/profiles/marcus"');
  });

  it("adds the WebUI agent source to PYTHONPATH before importing hermes_cli", () => {
    const command = buildCodexStartCommand("inst_123", "1024:1024", "/home/hermes/.hermes");
    expect(command).toContain('export PYTHONPATH="${HERMES_WEBUI_AGENT_DIR:-${HERMES_HOME:-}/hermes-agent}:${PYTHONPATH:-}"');
    expect(command.indexOf("export PYTHONPATH=")).toBeLessThan(
      command.indexOf('"$PYTHON_BIN" -')
    );
  });

  it("prefers the WebUI Python virtualenv before falling back to system Python", () => {
    const command = buildCodexStartCommand("inst_123", "1024:1024", "/home/hermes/.hermes");
    expect(command).toContain('PYTHON_BIN=/app/venv/bin/python');
    expect(command.indexOf('PYTHON_BIN=/app/venv/bin/python')).toBeLessThan(
      command.indexOf('PYTHON_BIN=$(command -v python3 || command -v python)')
    );
  });

  it("builds the status command without mutating provider config", () => {
    const command = buildCodexStatusCommand("inst_123", "hermes", "/opt/data/profiles/marcus");
    expect(command).toContain('docker exec -u "hermes" -i "$AGENT_CONTAINER"');
    expect(command).toContain("_save_codex_tokens");
    expect(command).toContain('export HERMES_HOME="/opt/data/profiles/marcus"');
    expect(command).toContain('os.environ.get("HERMES_HOME")');
    expect(command).toContain('"User-Agent": "Codex/0.122.0-alpha.1 (Hermes OAuth helper)"');
    expect(command).not.toContain("/root/.codex/auth.json");
    expect(command).not.toContain("import httpx");
    expect(command).not.toContain("from hermes_cli.auth import (");
    expect(command).not.toContain("_update_config_for_provider");
    expect(command).not.toContain("_write_runtime_env");
    expect(command).toContain('getattr(auth_module, "CODEX_OAUTH_CLIENT_ID"');
    expect(command).toContain('getattr(auth_module, "CODEX_OAUTH_TOKEN_URL"');
    expect(command).toContain("urlopen");
  });

  it("does not hard-require private Hermes auth helpers before checking status", () => {
    const command = buildCodexStatusCommand("inst_123", "hermes", "/opt/data");

    expect(command).toContain('getattr(auth_module, "_read_codex_tokens", None)');
    expect(command).toContain('getattr(auth_module, "_save_codex_tokens", None)');
    expect(command).toContain('getattr(auth_module, "resolve_codex_runtime_credentials", None)');
    expect(command).toContain("def _read_auth_store_provider()");
    expect(command).toContain("def _write_auth_store_tokens(tokens: dict, last_refresh: str) -> None:");
  });

  it("polls a pending device flow before accepting an existing runtime session", () => {
    const command = buildCodexStatusCommand("inst_123", "hermes", "/opt/data");

    expect(command.indexOf("if not FLOW_PATH.exists():")).toBeLessThan(
      command.indexOf("with contextlib.redirect_stdout")
    );
  });

  it("marks a device flow as pending while authorization has not completed", () => {
    const command = buildCodexStatusCommand("inst_123", "hermes", "/opt/data");

    expect(command).toContain('{"authenticated": False, "pendingDeviceFlow": True}');
  });

  it("serializes and parses a reusable Codex Vault bundle", () => {
    const serialized = serializeCodexVaultBundle({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      source: "device-code",
    });

    expect(parseCodexVaultBundle(serialized)).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      source: "device-code",
    });
    expect(formatStoredProviderSecretPreview("codex", serialized)).toBe("OAuth session (reusable)");
  });

  it("formats WebUI openai-codex Vault bundles as reusable Codex sessions", () => {
    const serialized = serializeCodexVaultBundle({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
    });

    expect(formatStoredProviderSecretPreview("openai-codex", serialized)).toBe("OAuth session (reusable)");
    expect(formatStoredProviderSecretPreview("openai-codex", "")).toBe("Not connected");
  });

  it("builds a Hermes auth store payload for reusable Codex sessions", () => {
    const authStore = JSON.parse(
      buildCodexHermesAuthStore({
        accessToken: "access-123",
        refreshToken: "refresh-456",
        lastRefresh: "2026-04-11T12:00:00Z",
      })
    );

    expect(authStore.active_provider).toBe("openai-codex");
    expect(authStore.providers["openai-codex"].tokens.access_token).toBe("access-123");
    expect(authStore.providers["openai-codex"].tokens.refresh_token).toBe("refresh-456");
    expect(authStore.providers["openai-codex"].auth_mode).toBe("chatgpt");
  });

  it("shows a disconnected preview for Codex agents without a stored session", () => {
    expect(formatStoredProviderSecretPreview("codex", "")).toBe("Not connected");
  });

  it("shows the reusable session preview for Nous OAuth bundles", () => {
    const serialized = serializeNousVaultBundle({
      portalBaseUrl: "https://portal.nousresearch.com",
      inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
      clientId: "hermes-cli",
      accessToken: "access-123",
      refreshToken: "refresh-456",
    });

    expect(formatStoredProviderSecretPreview("nous", serialized)).toBe(
      "OAuth session + agent key (reusable)"
    );
    expect(formatStoredProviderSecretPreview("nous", "")).toBe("Not connected");
  });
});
