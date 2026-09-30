import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import {
  agentPortsForBackend,
  buildAgentCaddyfile,
  buildAgentDeployScript,
  buildAutoUpdateTimerProvisioningScript,
  buildProviderEnv,
  buildHostTimeSyncRepairScript,
  LEGACY_AGENT_PORTS,
  renderCompressedProvisioningUserData,
  renderHostUserData,
  resolveGatewayConfiguration,
  WEBUI_AGENT_PORTS,
} from "@/lib/services/hetzner-instance-builders";
import { HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE } from "@/lib/services/sidecar-script";

const HEREDOC_DELIMITER = "HIVRA_EMBEDDED_FILE_EOF";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The exact shell command the script uses to write `path` in heredoc form.
function findHeredocWrite(script: string, path: string): string | null {
  const escapedPath = escapeRegExp(path);
  const withNewline = new RegExp(
    `cat > ${escapedPath} <<'${HEREDOC_DELIMITER}'\\n[\\s\\S]*?\\n${HEREDOC_DELIMITER}\\n`
  );
  const withoutNewline = new RegExp(
    `printf '%s' "\\$\\(cat <<'${HEREDOC_DELIMITER}'\\n[\\s\\S]*?\\n${HEREDOC_DELIMITER}\\n\\)" > ${escapedPath}\\n`
  );
  return script.match(withNewline)?.[0] ?? script.match(withoutNewline)?.[0] ?? null;
}

// Runs the script's own write command for `path` in bash, so the assertion
// covers shell quoting and newline handling rather than a regex decode.
function writeEmbeddedFileWithBash(script: string, path: string): string {
  const command = findHeredocWrite(script, path);
  if (!command) throw new Error(`No heredoc write for ${path}`);
  const dir = mkdtempSync(join(tmpdir(), "hivra-embedded-"));
  try {
    writeFileSync(join(dir, "write.sh"), command);
    execFileSync("bash", ["write.sh"], { cwd: dir });
    return readFileSync(join(dir, path), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function extractEmbeddedFile(script: string, path: string): string {
  const escapedPath = escapeRegExp(path);
  const compressedPattern = new RegExp(
    `printf '%s' '([^']+)' \\| base64 -d \\| gunzip > ${escapedPath}`
  );
  const compressedMatch = script.match(compressedPattern);
  if (compressedMatch?.[1]) {
    return gunzipSync(Buffer.from(compressedMatch[1], "base64")).toString("utf8");
  }

  const rawPattern = new RegExp(`printf '%s' '([^']+)' \\| base64 -d > ${escapedPath}`);
  const rawMatch = script.match(rawPattern);
  if (rawMatch?.[1]) {
    return Buffer.from(rawMatch[1], "base64").toString("utf8");
  }

  throw new Error(`Unable to extract embedded file for ${path}`);
}

function realisticGatewayDeployParams(systemPrompt?: string): Parameters<typeof buildAgentDeployScript>[0] {
  const { fqdn } = resolveGatewayConfiguration({
    subdomain: "7c80cbe05e19d9bf24c5",
    ipv4: "203.0.113.4",
  });

  return {
    instanceId: "inst_test_123",
    containerName: "agent-inst_test_123",
    apiServerKey: "x".repeat(64),
    provider: "openrouter",
    apiKey: `sk-${"a".repeat(96)}`,
    model: "anthropic/claude-opus-4.1",
    fqdn,
    cpuLimit: 2,
    ramLimit: 4096,
    honchoSettings: {
      enabled: true,
      apiKey: `honcho_${"b".repeat(96)}`,
    },
    agentSettings: {
      maxIterations: 60,
      toolProgressMode: "all",
      compressionThreshold: 0.85,
      sessionResetMode: "both",
      browserProvider: "local",
      webUseGateway: true,
      imageGenUseGateway: true,
      ttsUseGateway: true,
      browserUseGateway: true,
      enableRootAccess: true,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      fallbackModels: JSON.stringify([
        {
          provider: "openrouter",
          model: "anthropic/claude-opus-4.1",
          apiKey: "",
        },
      ]),
    },
    globalSettings: {
      memoryContextLimit: 2200,
      userContextLimit: 1375,
      sessionExpiryHours: 24,
    },
    includeHostTimeSyncRepair: false,
    includeRegistryCredentialScrub: false,
  };
}

describe("hetzner-instance-builders", () => {
  it("keeps a realistic gateway-enabled bootstrap under Hetzner's user_data limit", () => {
    // Fresh servers get the script inside renderCompressedProvisioningUserData,
    // so hetzner-instance-service renders embedded files as heredocs.
    const agentScript = buildAgentDeployScript({
      ...realisticGatewayDeployParams(),
      embeddedFileEncoding: "heredoc",
    });

    const totalUserDataLength = Buffer.byteLength(
      renderCompressedProvisioningUserData(renderHostUserData(), agentScript),
      "utf8"
    );

    expect(agentScript).not.toContain("| base64 -d | gunzip > sidecar_server.js");
    expect(writeEmbeddedFileWithBash(agentScript, "sidecar_server.js")).toBe(
      HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE
    );
    expect(writeEmbeddedFileWithBash(agentScript, "docker-compose.yml")).toBe(
      extractEmbeddedFile(buildAgentDeployScript(realisticGatewayDeployParams()), "docker-compose.yml")
    );
    // Hetzner rejects user_data above 32 KiB. Keep real headroom: gzip output
    // differs by a few bytes between zlib builds (macOS arm64 vs Linux x64).
    expect(totalUserDataLength).toBeLessThanOrEqual(32768 - 1024);
  });

  it.each([
    ["without a trailing newline", "Be terse.\n\n\n\nKeep $HOME, `ticks`, \\n, 'single' and \"double\" quotes."],
    ["with a trailing newline", "Line one\n\n\n\nLine two\n\n"],
    ["with a delimiter-like line", `${HEREDOC_DELIMITER}x\n ${HEREDOC_DELIMITER}\nend`],
  ])("writes heredoc-embedded files byte-exact %s", (_label, systemPrompt) => {
    const agentScript = buildAgentDeployScript({
      ...realisticGatewayDeployParams(systemPrompt),
      embeddedFileEncoding: "heredoc",
    });

    expect(writeEmbeddedFileWithBash(agentScript, "SOUL.md")).toBe(systemPrompt);
  });

  it("keeps the blob form for a file containing the heredoc delimiter line", () => {
    const systemPrompt = `before\n${HEREDOC_DELIMITER}\nafter`;
    const agentScript = buildAgentDeployScript({
      ...realisticGatewayDeployParams(systemPrompt),
      embeddedFileEncoding: "heredoc",
    });

    expect(findHeredocWrite(agentScript, "SOUL.md")).toBeNull();
    expect(extractEmbeddedFile(agentScript, "SOUL.md")).toBe(systemPrompt);
  });

  it("keeps gzip+base64 embedding by default for uncompressed delivery", () => {
    const agentScript = buildAgentDeployScript(realisticGatewayDeployParams());

    expect(agentScript).toContain("| base64 -d | gunzip > sidecar_server.js");
    expect(agentScript).toContain("| base64 -d | gunzip > docker-compose.yml");
    expect(agentScript).not.toContain(HEREDOC_DELIMITER);
  });

  it("does not embed env-var-derived strings in the agent script (would break the user_data size budget non-deterministically)", () => {
    // Regression for a CI flake: the script previously embedded
    // `process.env.VERCEL_GIT_COMMIT_SHA` (a 40-char SHA) into the
    // docker-compose.yml comment. Locally the env var was unset so the script
    // measured small; on Vercel/CI it was set and the user_data crept past
    // Hetzner's 32 KB cloud-init limit. Same flake bit us again with
    // GHCR_TOKEN (read directly inside the bootstrap template). Lock both
    // down: any env-derived value we want to embed must come in via
    // params, not via process.env reads inside the builder. (The registry
    // token is gone entirely now: see platform-registry-credential.test.ts.)
    const previousShaEnv = process.env.VERCEL_GIT_COMMIT_SHA;
    const previousGhcrEnv = process.env.GHCR_TOKEN;
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    process.env.GHCR_TOKEN = `ghp_${"z".repeat(72)}`;
    try {
      const { fqdn } = resolveGatewayConfiguration({
        subdomain: "7c80cbe05e19d9bf24c5",
        ipv4: "203.0.113.4",
      });
      const agentScript = buildAgentDeployScript({
        instanceId: "inst_test_123",
        containerName: "agent-inst_test_123",
        apiServerKey: "x".repeat(64),
        provider: "openrouter",
        apiKey: `sk-${"a".repeat(96)}`,
        model: "anthropic/claude-opus-4.1",
        fqdn,
        cpuLimit: 2,
        ramLimit: 4096,
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          enableRootAccess: true,
        },
        includeHostTimeSyncRepair: false,
        // Fresh-server user_data, as hetzner-instance-service renders it.
        includeRegistryCredentialScrub: false,
      });

      const totalUserDataLength = Buffer.byteLength(
        renderCompressedProvisioningUserData(renderHostUserData(), agentScript),
        "utf8"
      );
      expect(totalUserDataLength).toBeLessThanOrEqual(32768);
      expect(agentScript).not.toContain("a".repeat(40));
      expect(agentScript).not.toContain(`ghp_${"z".repeat(72)}`);
      expect(agentScript).not.toContain("docker login ghcr.io");
    } finally {
      if (previousShaEnv === undefined) {
        delete process.env.VERCEL_GIT_COMMIT_SHA;
      } else {
        process.env.VERCEL_GIT_COMMIT_SHA = previousShaEnv;
      }
      if (previousGhcrEnv === undefined) {
        delete process.env.GHCR_TOKEN;
      } else {
        process.env.GHCR_TOKEN = previousGhcrEnv;
      }
    }
  });

  it("keeps host disk cleanup volume-safe and uses explicit dangling-image cleanup", () => {
    const hostUserData = renderHostUserData();

    expect(hostUserData).toContain("docker images -f dangling=true -q");
    expect(hostUserData).not.toContain("docker system prune -f --volumes");
    expect(hostUserData).not.toContain("--volumes");
  });

  it("initializes Hermes-owned writable volumes before first boot", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_perm_456",
      containerName: "agent-inst_perm_456",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        mountPersistentSource: true,
      },
    });

    expect(agentScript).toContain(
      'for volume_name in "inst_perm_456_agent-memories" "inst_perm_456_agent-sessions" "inst_perm_456_agent-logs" "inst_perm_456_agent-audio" "inst_perm_456_agent-image" "inst_perm_456_agent-profiles" "inst_perm_456_agent-source"; do'
    );
    expect(agentScript).toContain('docker volume create "$volume_name" >/dev/null');
    expect(agentScript).toContain('volume_mountpoint="$(docker volume inspect -f \'{{ .Mountpoint }}\' "$volume_name" 2>/dev/null || true)"');
    expect(agentScript).toContain('if [ -n "$volume_mountpoint" ] && [ -f "$volume_mountpoint/.hermes-perms-v1" ]; then');
    expect(agentScript).toContain(
      "docker run --rm --user root -v \"$volume_name:/target\" --entrypoint sh ghcr.io/ashneil12/vanilla-hermes-agent:latest -lc 'mkdir -p /target && chown -R 10000:10000 /target && touch /target/.hermes-perms-v1 && chown 10000:10000 /target/.hermes-perms-v1'"
    );
    expect(agentScript).toContain("chown 10000:10000 .env config.yaml SOUL.md honcho.json");
  });

  it("starts the compose stack only once during deploy", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_fast_123",
      containerName: "agent-inst_fast_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    expect(
      agentScript.match(/docker compose up -d --remove-orphans/g) ?? []
    ).toHaveLength(1);
  });

  it("wires Surplus Intelligence as an OpenAI-compatible marketplace endpoint", () => {
    expect(buildProviderEnv("surplus", "inf_test")).toEqual([
      "HERMES_INFERENCE_PROVIDER=custom",
      "OPENAI_API_KEY=inf_test",
      "OPENAI_BASE_URL=https://www.surplusintelligence.ai/api/inference/v1",
    ]);
  });

  it("wires Venice native media credentials and video toolset for legacy agents", () => {
    const envLines = buildProviderEnv("venice", "venice-key");
    expect(envLines).toEqual(
      expect.arrayContaining([
        "HERMES_INFERENCE_PROVIDER=custom",
        "OPENAI_API_KEY=venice-key",
        "VENICE_API_KEY=venice-key",
        "OPENAI_BASE_URL=https://api.venice.ai/api/v1",
        "VENICE_BASE_URL=https://api.venice.ai/api/v1",
      ])
    );

    const agentScript = buildAgentDeployScript({
      instanceId: "inst_venice_tools_123",
      containerName: "agent-inst_venice_tools_123",
      apiServerKey: "x".repeat(64),
      provider: "venice",
      apiKey: "venice-key",
      model: "deepseek-v4-pro",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    const envContent = extractEmbeddedFile(agentScript, ".env.new");
    const configContent = extractEmbeddedFile(agentScript, "config.yaml");

    expect(envContent).toContain("VENICE_API_KEY=venice-key");
    expect(envContent).toContain("VENICE_BASE_URL=https://api.venice.ai/api/v1");
    expect(configContent).toContain("toolsets:\n  - hermes-cli\n  - video_gen");
  });

  it("emits terminal.backend=docker only when terminalBackend=docker AND root mode is on", () => {
    const build = (
      agentSettings: Record<string, unknown>
    ): string => {
      const agentScript = buildAgentDeployScript({
        instanceId: "inst_termbackend_123",
        containerName: "agent-inst_termbackend_123",
        apiServerKey: "x".repeat(64),
        provider: "openrouter",
        apiKey: `sk-${"a".repeat(96)}`,
        model: "anthropic/claude-opus-4.1",
        fqdn: "agent.example.com",
        cpuLimit: 2,
        ramLimit: 4096,
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          ...agentSettings,
        },
      });
      return extractEmbeddedFile(agentScript, "config.yaml");
    };

    // docker backend requires root mode (socket mount + root user).
    const dockerRoot = build({ enableRootAccess: true, terminalBackend: "docker" });
    expect(dockerRoot).toContain("terminal:\n  backend: docker");

    // docker selected but NOT root → must fall back to local, never point the
    // box at an unreachable socket.
    const dockerNoRoot = build({ enableRootAccess: false, terminalBackend: "docker" });
    expect(dockerNoRoot).not.toContain("backend: docker");

    // root mode without a docker selection keeps the existing local backend.
    const rootLocal = build({ enableRootAccess: true, terminalBackend: "local" });
    expect(rootLocal).toContain("terminal:\n  backend: local");
    expect(rootLocal).not.toContain("backend: docker");
  });

  it("emits terminal.backend=modal (managed cloud sandbox) in any mode, no root or cwd required", () => {
    const build = (agentSettings: Record<string, unknown>): string => {
      const agentScript = buildAgentDeployScript({
        instanceId: "inst_modal_123",
        containerName: "agent-inst_modal_123",
        apiServerKey: "x".repeat(64),
        provider: "openrouter",
        apiKey: `sk-${"a".repeat(96)}`,
        model: "anthropic/claude-opus-4.1",
        fqdn: "agent.example.com",
        cpuLimit: 2,
        ramLimit: 4096,
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          ...agentSettings,
        },
      });
      return extractEmbeddedFile(agentScript, "config.yaml");
    };

    // modal is cloud → selectable WITHOUT root, and carries modal_mode: managed.
    const modalNoRoot = build({ enableRootAccess: false, terminalBackend: "modal" });
    expect(modalNoRoot).toContain("terminal:\n  backend: modal\n  modal_mode: managed");
    // No local cwd pin when not in root mode.
    expect(modalNoRoot).not.toContain("cwd:");

    // modal in root mode still emits modal + the cwd pin.
    const modalRoot = build({ enableRootAccess: true, terminalBackend: "modal" });
    expect(modalRoot).toContain("terminal:\n  backend: modal\n  modal_mode: managed");
    expect(modalRoot).toContain("cwd:");
  });

  it("emits terminal.backend=daytona only when a Daytona key is present, in any mode", () => {
    const build = (agentSettings: Record<string, unknown>): string => {
      const agentScript = buildAgentDeployScript({
        instanceId: "inst_daytona_123",
        containerName: "agent-inst_daytona_123",
        apiServerKey: "x".repeat(64),
        provider: "openrouter",
        apiKey: `sk-${"a".repeat(96)}`,
        model: "anthropic/claude-opus-4.1",
        fqdn: "agent.example.com",
        cpuLimit: 2,
        ramLimit: 4096,
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          ...agentSettings,
        },
      });
      return extractEmbeddedFile(agentScript, "config.yaml");
    };

    // daytona is cloud -> selectable without root, but ONLY with a key.
    const withKey = build({ terminalBackend: "daytona", daytonaApiKey: "dtn_abc" });
    expect(withKey).toContain("terminal:\n  backend: daytona");

    // Selected but no key -> fall back to local rather than hand the box a dead
    // backend it can only fail on.
    const noKey = build({ terminalBackend: "daytona" });
    expect(noKey).not.toContain("backend: daytona");
  });

  it("clean-slate (unconfigured) gateway deploy bakes no model or provider so the agent's onboarding overlay fires", () => {
    // Reproduces the clean-slate "Managed=OFF" deploy: the server reconciles the
    // empty model to the openrouter catalog default but attaches no key. Before the
    // fix, the gateway builder dropped `unconfigured` and baked HERMES_MODEL with no
    // credential → runtime "No LLM provider configured".
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_unconfigured_123",
      containerName: "agent-inst_unconfigured_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: "",
      model: "openai/gpt-5.4-pro",
      unconfigured: true,
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    const envContent = extractEmbeddedFile(agentScript, ".env.new");
    const configContent = extractEmbeddedFile(agentScript, "config.yaml");

    // No model name is baked into the env or config, and no provider block in
    // config.yaml → _has_any_provider_configured() is false → onboarding overlay.
    expect(envContent).not.toContain("HERMES_MODEL=");
    expect(configContent).not.toContain("model:\n  default:");
    expect(configContent).not.toContain("openai/gpt-5.4-pro");
    // The API server still comes up so the dashboard/sidecar can reach the box.
    expect(envContent).toContain("API_SERVER_KEY=");
  });

  it("configured gateway deploy bakes the selected model (control for the unconfigured path)", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_configured_123",
      containerName: "agent-inst_configured_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-or-${"a".repeat(48)}`,
      model: "openai/gpt-5.4-pro",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    const envContent = extractEmbeddedFile(agentScript, ".env.new");
    const configContent = extractEmbeddedFile(agentScript, "config.yaml");

    expect(envContent).toContain("HERMES_MODEL=");
    expect(configContent).toContain("model:\n  default:");
    expect(configContent).toContain("openai/gpt-5.4-pro");
  });

  it("host bootstrap no longer provisions the warden sidecar — decommissioned fleet-wide (2026-07)", () => {
    // hermes-warden (the per-box daily-compute-cap sidecar) was removed from all
    // hosts. The docker-compose warden service, its Supabase service-role
    // credentials, caddy's `depends_on: warden`, and the `docker compose pull
    // warden` step must all be gone from the generated host bootstrap.
    const userdata = renderHostUserData();
    expect(userdata).not.toContain("hermes-warden");
    expect(userdata).not.toContain("HERMES_WARDEN");
    expect(userdata).not.toContain("WARDEN_PORT");
    expect(userdata).not.toContain("pull warden");
    expect(userdata).not.toContain("- warden");
    // Caddy still mounts its log volume read-write to write its own access log.
    expect(userdata).toContain("caddy_logs:/var/log/caddy");
    expect(userdata).not.toContain("caddy_logs:/var/log/caddy:ro");
  });

  it("repairs host clock sync before starting shared Hetzner infrastructure", () => {
    const userdata = renderHostUserData();

    expect(userdata).toContain("hermes_ensure_time_sync()");
    expect(userdata).toContain("/var/log/hermes-time-sync.log");
    expect(userdata).toContain("timedatectl set-timezone UTC");
    expect(userdata).toContain("timedatectl set-ntp true");
    expect(userdata).toContain("systemd-timesyncd");
    expect(userdata).toContain("hwclock --systohc --utc");

    const timeSyncIdx = userdata.indexOf("hermes_ensure_time_sync");
    const dockerInstallIdx = userdata.indexOf("curl -fsSL https://get.docker.com | sh");
    expect(timeSyncIdx).toBeGreaterThan(-1);
    expect(dockerInstallIdx).toBeGreaterThan(-1);
    expect(timeSyncIdx).toBeLessThan(dockerInstallIdx);
  });

  it("repairs host clock sync during legacy agent redeploy before containers restart", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_clock_123",
      containerName: "agent-inst_clock_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
    });

    expect(agentScript).toContain("hermes_ensure_time_sync()");
    expect(agentScript).toContain("/var/log/hermes-time-sync.log");
    expect(agentScript).toContain("timedatectl set-ntp true");

    const timeSyncIdx = agentScript.indexOf("hermes_ensure_time_sync");
    const composeUpIdx = agentScript.indexOf("docker compose up -d --remove-orphans");
    expect(timeSyncIdx).toBeGreaterThan(-1);
    expect(composeUpIdx).toBeGreaterThan(-1);
    expect(timeSyncIdx).toBeLessThan(composeUpIdx);
  });

  it("installs a daily auto-update timer that only refreshes the compose stack", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_auto_123",
      containerName: "agent-inst_auto_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });
    const timerContent = extractEmbeddedFile(
      agentScript,
      "/etc/systemd/system/hermes-auto-update-inst_auto_123.timer"
    );
    const updaterContent = extractEmbeddedFile(
      agentScript,
      "/usr/local/bin/hermes-auto-update-inst_auto_123"
    );

    expect(agentScript).toContain("/usr/local/bin/hermes-auto-update-inst_auto_123");
    expect(timerContent).toContain("OnCalendar=*-*-* 06:30:00 UTC");
    expect(updaterContent).toContain("docker compose pull agent");
    expect(updaterContent).toContain("docker compose up -d --remove-orphans");
    expect(updaterContent).toContain("hermes_ensure_time_sync()");
    expect(updaterContent.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      updaterContent.indexOf("docker compose pull agent")
    );
    expect(updaterContent).toContain("ERROR: $c failed readiness after auto update");
    expect(updaterContent).toContain("/api/u/inst_auto_123");
    expect(updaterContent).toContain('--data-urlencode "r=$2"');
    expect(updaterContent).toContain("?s=$1&t=scheduled");
    expect(updaterContent).toContain('ru "failed" "exit_status_${status}" "$LOG"');
    expect(updaterContent).toContain("echo W >&2");
  });

  it("rebuilds WebUI Hermes CLI shims during auto-update", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_auto_123",
      containerName: "agent-inst_webui_auto_123",
      backend: "webui",
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_auto_123"
    );

    expect(updaterContent).toContain("-v agent-inst_webui_auto_123_webui-state:/state");
    expect(updaterContent).toContain("-v agent-inst_webui_auto_123_agent-source:/agent-source:ro");
    expect(updaterContent).toContain("hermes_ensure_time_sync()");
    expect(updaterContent.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      updaterContent.indexOf("docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable")
    );
    expect(updaterContent).toContain("ln -sfn \"$target\" /state/bin/hermes");
    expect(updaterContent).toContain("ln -sfn \"$target\" /state/bin/hermes-cli");
    expect(updaterContent).toContain("docker exec --user 1024 agent-inst_webui_auto_123 sh -lc");
    expect(updaterContent).toContain('target="/home/hermes/.hermes/hermes-agent/.venv/bin/hermes"');
    expect(updaterContent).toContain('target="/home/hermes/.hermes/hermes-agent/hermes"');
    expect(updaterContent).toContain('ln -sfn "$target" "$HOME/.local/bin/hermes"');
    expect(updaterContent).toContain('test -x "$(command -v hermes)" && test -x "$(command -v hermes-cli)"');
  });

  it("cleans disk before and after WebUI auto-update pulls without deleting user volumes", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_auto_123",
      containerName: "agent-inst_webui_auto_123",
      backend: "webui",
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_auto_123"
    );

    const preCleanupIdx = updaterContent.indexOf("hermes_volume_safe_update_cleanup pre-pull");
    const headroomIdx = updaterContent.indexOf("\nhermes_verify_update_disk_headroom\n");
    const agentPullIdx = updaterContent.indexOf("docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable");
    const composePullIdx = updaterContent.indexOf("docker compose pull --ignore-pull-failures");
    const healthyIdx = updaterContent.indexOf('test -x "$(command -v hermes)" && test -x "$(command -v hermes-cli)"');
    const postCleanupIdx = updaterContent.indexOf("hermes_volume_safe_update_cleanup post-success");

    expect(preCleanupIdx).toBeGreaterThan(0);
    expect(headroomIdx).toBeGreaterThan(preCleanupIdx);
    expect(agentPullIdx).toBeGreaterThan(headroomIdx);
    expect(composePullIdx).toBeGreaterThan(agentPullIdx);
    expect(postCleanupIdx).toBeGreaterThan(healthyIdx);
    expect(updaterContent).toContain("/usr/local/bin/hermes-disk-cleanup");
    // `-f` (not `-af`) so tagged-but-unused images like the LKG rollback tag
    // are not pruned out from under the rollback path.
    expect(updaterContent).toContain("docker image prune -f ");
    expect(updaterContent).not.toContain("docker image prune -af");
    expect(updaterContent).toContain("HERMES_UPDATE_MIN_FREE_MB");
    expect(updaterContent).not.toContain("docker volume prune");
    expect(updaterContent).not.toContain("docker system prune --volumes");
  });

  it("honours /etc/hermes/auto-update-disabled as a kill switch before any docker work", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_killswitch_123",
      containerName: "agent-inst_webui_killswitch_123",
      backend: "webui",
      autoUpdate: { enabled: true, time: "06:30" },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:slim",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_killswitch_123"
    );

    const killSwitchIdx = updaterContent.indexOf("/etc/hermes/auto-update-disabled");
    const timeSyncIdx = updaterContent.indexOf("hermes_ensure_time_sync");
    const cdIdx = updaterContent.indexOf(
      "cd /opt/hermes/instances/inst_webui_killswitch_123"
    );
    const pullIdx = updaterContent.indexOf(
      "docker pull ghcr.io/ashneil12/vanilla-hermes-agent:slim"
    );

    expect(killSwitchIdx).toBeGreaterThan(0);
    expect(killSwitchIdx).toBeLessThan(timeSyncIdx);
    expect(killSwitchIdx).toBeLessThan(cdIdx);
    expect(killSwitchIdx).toBeLessThan(pullIdx);
    expect(updaterContent).toContain(
      "[hermes-auto-update] skipped: /etc/hermes/auto-update-disabled present"
    );
    // Must return 0 (not 1) on skip so the timer doesn't report a failed run.
    const skipBranch = updaterContent.slice(
      killSwitchIdx,
      updaterContent.indexOf("\n}", killSwitchIdx)
    );
    expect(skipBranch).toContain("return 0");
  });

  it("saves a last-known-good tag before WebUI auto-update pulls", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_lkg_123",
      containerName: "agent-inst_webui_lkg_123",
      backend: "webui",
      autoUpdate: { enabled: true, time: "06:30" },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:slim",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_lkg_123"
    );

    const saveDefIdx = updaterContent.indexOf("hermes_save_last_known_good()");
    const saveCallIdx = updaterContent.indexOf("\nhermes_save_last_known_good\n");
    const preCleanupIdx = updaterContent.indexOf(
      "hermes_volume_safe_update_cleanup pre-pull"
    );
    const pullIdx = updaterContent.indexOf(
      "docker pull ghcr.io/ashneil12/vanilla-hermes-agent:slim"
    );

    expect(saveDefIdx).toBeGreaterThan(0);
    expect(saveCallIdx).toBeGreaterThan(saveDefIdx);
    // Save must run before pre-pull cleanup so the currently-running digest
    // is still tagged at the canonical ref when the snapshot is taken.
    expect(saveCallIdx).toBeLessThan(preCleanupIdx);
    expect(preCleanupIdx).toBeLessThan(pullIdx);
    expect(updaterContent).toContain(
      ":hermes-last-known-good"
    );
    expect(updaterContent).toContain(
      "docker tag \"$digest\" \"$lkg\""
    );
    expect(updaterContent).toContain(
      'printf \'%s\\n\' "ghcr.io/ashneil12/vanilla-hermes-agent:slim"'
    );
  });

  it("rolls back to last-known-good when WebUI auto-update readiness fails", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_lkg_rollback_123",
      containerName: "agent-inst_webui_lkg_rollback_123",
      backend: "webui",
      autoUpdate: { enabled: true, time: "06:30" },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:slim",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_lkg_rollback_123"
    );

    expect(updaterContent).toContain("hermes_restore_last_known_good()");
    expect(updaterContent).toContain("hermes_apply_webui_runtime()");
    expect(updaterContent).toContain(
      "[hermes-update] attempting rollback to last-known-good"
    );
    // hermes-disk-cleanup evicts busybox:latest after 24h; the bootstrap
    // re-pull from Docker Hub can hit the 100/6h unauthenticated rate limit
    // when many tenants on one Hetzner-cloud IP redeploy together. The
    // ensure-busybox snippet retags an already-cached image as a fallback,
    // and must appear before hermes_apply_webui_runtime (which fires the
    // busybox-based volume chown sidecar).
    const ensureBusyboxIdx = updaterContent.indexOf("[ensure-busybox]");
    const applyRuntimeCallIdx = updaterContent.indexOf("\nhermes_apply_webui_runtime\n");
    expect(ensureBusyboxIdx).toBeGreaterThan(0);
    expect(ensureBusyboxIdx).toBeLessThan(applyRuntimeCallIdx);

    // The first apply (forward update) must come before the readiness loop;
    // the rollback apply must come after the failure detection.
    const firstApplyIdx = updaterContent.indexOf(
      "\nhermes_apply_webui_runtime\n"
    );
    const readinessLoopIdx = updaterContent.indexOf("for c in \"agent-inst_webui_lkg_rollback_123\"");
    const failureDetectionIdx = updaterContent.indexOf(
      'if [ "$update_failed" = "1" ]; then'
    );
    const restoreCallIdx = updaterContent.indexOf(
      "if hermes_restore_last_known_good; then"
    );
    const rollbackApplyIdx = updaterContent.indexOf(
      "if hermes_apply_webui_runtime; then"
    );

    expect(firstApplyIdx).toBeGreaterThan(0);
    expect(firstApplyIdx).toBeLessThan(readinessLoopIdx);
    expect(readinessLoopIdx).toBeLessThan(failureDetectionIdx);
    expect(failureDetectionIdx).toBeLessThan(restoreCallIdx);
    expect(restoreCallIdx).toBeLessThan(rollbackApplyIdx);

    // Rollback must still return 1 so the dashboard reporter records `failed`,
    // even though the VM is now on the prior-good runtime.
    const rollbackBlock = updaterContent.slice(failureDetectionIdx);
    expect(rollbackBlock).toMatch(/return 1\n\s*fi/);
  });

  it("preserves :hermes-last-known-good tags through auto-update cleanup", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_lkg_cleanup_123",
      containerName: "agent-inst_webui_lkg_cleanup_123",
      backend: "webui",
      autoUpdate: { enabled: true, time: "06:30" },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:slim",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_lkg_cleanup_123"
    );

    // Tagged-image prune helpers must skip the LKG sentinel.
    expect(updaterContent).toContain(
      '*:"<none>"|"<none>":*|*:hermes-last-known-good'
    );
    // Both agent + webui repos get the same selective prune treatment.
    expect(updaterContent).toContain(
      "prune_old_unused_hermes_repo_images 'ghcr.io/ashneil12/vanilla-hermes-agent'"
    );
    expect(updaterContent).toContain(
      "prune_old_unused_hermes_repo_images 'ghcr.io/ashneil12/hermes-webui'"
    );
    // And the blanket `docker image prune -af` is gone in favour of `-f`,
    // so the tagged LKG image survives.
    expect(updaterContent).not.toContain("docker image prune -af");
  });

  it("waits for the supervised WebUI gateway after auto-update recreates containers", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_auto_123",
      containerName: "agent-inst_webui_auto_123",
      backend: "webui",
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_auto_123"
    );

    expect(updaterContent).toContain('for c in "agent-inst_webui_auto_123" "agent-inst_webui_auto_123-sidecar" "agent-inst_webui_auto_123-gateway"; do');
    expect(updaterContent).toContain('docker logs --tail 50 "$c"');
  });

  it("repairs WebUI persisted toolchain env during auto-update", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_auto_123",
      containerName: "agent-inst_webui_auto_123",
      backend: "webui",
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_auto_123"
    );

    expect(updaterContent).toContain("Repair dashboard-managed toolchain env keys");
    expect(updaterContent).toContain("managed_env_keys='PATH GH_CONFIG_DIR XDG_CONFIG_HOME");
    expect(updaterContent).toContain("cp /state/.env /seed/hermes.env");
    expect(updaterContent).toContain('printf "\\n%s\\n" "$managed_env_line" >> "$managed_env_tmp"');
    // Atomic publish: the gateway reloads /state/.env every turn, so the repair
    // builds a temp on the same volume and renames it over — never edits in place —
    // and skips the write entirely when nothing changed.
    expect(updaterContent).toContain('mv -f "$managed_env_tmp" /state/.env');
    expect(updaterContent).toContain('cmp -s "$managed_env_tmp" /state/.env');
    expect(updaterContent).not.toContain('sed -i "s|^${managed_env_key}=.*|${managed_env_line}|" /state/.env');
    // Regression: the recursive chown must tolerate the SQLite WAL race. On idle
    // instances *.db-wal/-shm get checkpointed away mid-recurse, so an unguarded
    // `chown -R /state` errors "No such file" and (under set -e) aborts the whole
    // live-update before the image pull — silently leaving the instance stale.
    expect(updaterContent).toContain("chown -R 1024:1024 /state 2>/dev/null || true");
    expect(updaterContent).not.toMatch(/chown -R 1024:1024 \/state\nSH/);
  });

  it("repairs WebUI persistent cache ownership before auto-update recreates the container", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_auto_123",
      containerName: "agent-inst_webui_auto_123",
      backend: "webui",
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_auto_123"
    );

    expect(updaterContent).toContain("Repair WebUI persistent state cache ownership before container start");
    expect(updaterContent).toContain("/state/cache/uv/tools");
    expect(updaterContent).toContain("chmod -R u+rwX,go+rX /state/cache");

    const repairIdx = updaterContent.indexOf("Repair WebUI persistent state cache ownership");
    const recreateIdx = updaterContent.indexOf("docker compose up -d --remove-orphans --force-recreate");
    expect(repairIdx).toBeGreaterThan(0);
    expect(recreateIdx).toBeGreaterThan(0);
    expect(repairIdx).toBeLessThan(recreateIdx);
  });

  it("logs runtime PATH details when WebUI auto-update toolchain verification fails", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_auto_123",
      containerName: "agent-inst_webui_auto_123",
      backend: "webui",
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_auto_123"
    );

    expect(updaterContent).toContain("for required_bin in hermes hermes-cli git node npm");
    expect(updaterContent).toContain("[webui-toolchain-check] missing required commands:");
    expect(updaterContent).toContain("[webui-toolchain-check] PATH=$PATH");
    expect(updaterContent).toContain(
      "sed -n '/^\\(PATH\\|PYTHONUSERBASE\\|PIP_CONFIG_FILE\\|PIP_CACHE_DIR\\|NPM_CONFIG_PREFIX\\|UV_TOOL_BIN_DIR\\)=/p'"
    );
  });

  it("installs missing WebUI developer tools during auto-update", () => {
    const autoUpdateScript = buildAutoUpdateTimerProvisioningScript({
      instanceId: "inst_webui_auto_123",
      containerName: "agent-inst_webui_auto_123",
      backend: "webui",
      autoUpdate: {
        enabled: true,
        time: "06:30",
      },
      webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const updaterContent = extractEmbeddedFile(
      autoUpdateScript,
      "/usr/local/bin/hermes-auto-update-inst_webui_auto_123"
    );

    expect(updaterContent).toContain("Install WebUI developer tools inside recreated container");
    expect(updaterContent).toContain("apt-get install -y --no-install-recommends git nodejs npm ca-certificates");
    expect(updaterContent).toContain("apk add --no-cache git nodejs npm ca-certificates");
    expect(updaterContent).toContain("[webui-toolchain-bootstrap] missing after install:");
  });

  it("defaults new deploys to a 06:00 UTC daily auto-update when no override is stored", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_auto_default_123",
      containerName: "agent-inst_auto_default_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    const timerContent = extractEmbeddedFile(
      agentScript,
      "/etc/systemd/system/hermes-auto-update-inst_auto_default_123.timer"
    );

    expect(timerContent).toContain("OnCalendar=*-*-* 06:00:00 UTC");
    expect(agentScript).not.toContain(
      "systemctl disable --now hermes-auto-update-inst_auto_default_123.timer"
    );
  });

  it("removes stale auto-update timers when the feature is disabled", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_auto_123",
      containerName: "agent-inst_auto_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      autoUpdate: {
        enabled: false,
        time: "06:00",
      },
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    expect(agentScript).toContain("systemctl disable --now hermes-auto-update-inst_auto_123.timer");
    expect(agentScript).toContain(
      "rm -f /usr/local/bin/hermes-auto-update-inst_auto_123 /etc/systemd/system/hermes-auto-update-inst_auto_123.service /etc/systemd/system/hermes-auto-update-inst_auto_123.timer"
    );
  });

  it("injects Nous auth.json and skips OPENAI_API_KEY when a vault session is available", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_nous_123",
      containerName: "agent-inst_nous_123",
      apiServerKey: "x".repeat(64),
      provider: "nous",
      apiKey: "",
      model: "nousresearch/hermes-4-70b",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      nousAuthBundle: {
        portalBaseUrl: "https://portal.nousresearch.com",
        inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
        clientId: "hermes-cli",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        agentKey: "agent-key",
      },
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    const envContent = extractEmbeddedFile(agentScript, ".env.new");
    const authStore = JSON.parse(extractEmbeddedFile(agentScript, "auth.json.inject"));

    expect(envContent).toContain("HERMES_INFERENCE_PROVIDER=custom");
    expect(envContent).not.toContain("OPENAI_API_KEY=");
    expect(authStore.active_provider).toBe("nous");
    expect(authStore.providers.nous.access_token).toBe("access-token");
    expect(authStore.providers.nous.agent_key).toBe("agent-key");
  });

  it("pre-creates root-enabled volumes and invalidates the non-root ownership marker", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_root_fast_123",
      containerName: "agent-inst_root_fast_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        enableRootAccess: true,
      },
    });

    expect(agentScript).toContain(
      'for volume_name in "inst_root_fast_123_agent-memories" "inst_root_fast_123_agent-sessions" "inst_root_fast_123_agent-logs" "inst_root_fast_123_agent-audio" "inst_root_fast_123_agent-image" "inst_root_fast_123_agent-profiles"; do'
    );
    expect(agentScript).toContain('docker volume create "$volume_name" >/dev/null');
    expect(agentScript).toContain("p=$(docker volume inspect -f '{{.Mountpoint}}' \"$volume_name\")");
    expect(agentScript).toContain('rm -f "$p/.hermes-perms-v1"');
    expect(agentScript).not.toContain("docker run --rm --user root -v \"$volume_name:/target\"");
  });

  it("mirrors the profile volume into /opt/data for root-enabled deploys", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_root_fast_123",
      containerName: "agent-inst_root_fast_123",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        enableRootAccess: true,
      },
    });

    const composeContent = extractEmbeddedFile(agentScript, "docker-compose.yml");

    expect(composeContent).toContain("      - agent-profiles:/root/.hermes/profiles");
    expect(composeContent).toContain("      - agent-profiles:/opt/data/profiles");
  });

  it("declares pre-created Hermes data volumes as external named volumes in compose", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_perm_456",
      containerName: "agent-inst_perm_456",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        mountPersistentSource: true,
      },
    });

    const composeContent = extractEmbeddedFile(agentScript, "docker-compose.yml");

    expect(composeContent).toContain("  agent-memories:");
    expect(composeContent).toContain('    name: "inst_perm_456_agent-memories"');
    expect(composeContent).toContain("    external: true");
    expect(composeContent).toContain('    name: "inst_perm_456_agent-sessions"');
    expect(composeContent).toContain('    name: "inst_perm_456_agent-logs"');
    expect(composeContent).toContain('    name: "inst_perm_456_agent-audio"');
    expect(composeContent).toContain('    name: "inst_perm_456_agent-image"');
    expect(composeContent).toContain('    name: "inst_perm_456_agent-profiles"');
    expect(composeContent).toContain('    name: "inst_perm_456_agent-source"');
    // Non-root deploys keep the image's privilege-dropping entrypoint, so the
    // gateway runs as the unprivileged 'hermes' user and the root-guard never
    // fires — we must NOT leak the root opt-in into these instances.
    expect(composeContent).toContain("# hermes-deploy-root-access: disabled");
    expect(composeContent).not.toContain("HERMES_ALLOW_ROOT_GATEWAY");
  });

  it("installs python in the sidecar image so terminal sessions do not depend on first-run package recovery", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_sidecar_456",
      containerName: "agent-inst_sidecar_456",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });

    const composeContent = extractEmbeddedFile(agentScript, "docker-compose.yml");

    expect(composeContent).toContain("image: node:22-alpine");
    expect(composeContent).toContain("apk add --no-cache docker-cli ca-certificates util-linux python3 2>/dev/null;");
  });

  it("stamps and guards root mode deploys end to end", () => {
    const agentScript = buildAgentDeployScript({
      instanceId: "inst_root_789",
      containerName: "agent-inst_root_789",
      apiServerKey: "x".repeat(64),
      provider: "openrouter",
      apiKey: `sk-${"a".repeat(96)}`,
      model: "anthropic/claude-opus-4.1",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        enableRootAccess: true,
      },
    });

    const composeContent = extractEmbeddedFile(agentScript, "docker-compose.yml");

    expect(composeContent).toContain("# hermes-deploy-root-access: enabled");
    expect(composeContent).toContain('entrypoint: ["/bin/bash", "/opt/hermes/docker/root-mode-entrypoint.sh"]');
    expect(composeContent).toContain('- ./root-mode-entrypoint.sh:/opt/hermes/docker/root-mode-entrypoint.sh:ro');
    // Regression (2026-06-13 gateway crash-loop): root-mode runs the gateway as
    // root via the override entrypoint (no privilege drop), so the agent image's
    // root-guard aborts startup unless we explicitly opt in. The gateway service
    // (command: ["gateway","run"]) MUST carry HERMES_ALLOW_ROOT_GATEWAY=1.
    expect(composeContent).toContain("- HERMES_ALLOW_ROOT_GATEWAY=1");
    expect(agentScript).toContain(
      'test -x root-mode-entrypoint.sh || { echo "FATAL: root-mode-entrypoint.sh missing for root access deployment" >&2; exit 1; }'
    );
    expect(agentScript).toContain(
      `grep -Fq 'entrypoint: ["/bin/bash", "/opt/hermes/docker/root-mode-entrypoint.sh"]' docker-compose.yml || { echo "FATAL: docker-compose.yml missing root-mode entrypoint for root access deployment" >&2; exit 1; }`
    );
    expect(agentScript).toContain(
      `grep -Fq './root-mode-entrypoint.sh:/opt/hermes/docker/root-mode-entrypoint.sh:ro' docker-compose.yml || { echo "FATAL: docker-compose.yml missing root-mode entrypoint mount for root access deployment" >&2; exit 1; }`
    );
  });

  it("keeps the canonical public gateway resolver independent from private access metadata", () => {
    // Hetzner is sslip.io-only — see resolveGatewayConfiguration's
    // header comment for why. This test guards that the resolver only
    // ever produces a public sslip.io URL and never leaks anything
    // tailscale/private-network shaped into the public gateway URL.
    const result = resolveGatewayConfiguration({
      subdomain: "atlas-agent",
      ipv4: "203.0.113.10",
    });

    expect(result.gatewayUrl).toBe("https://203-0-113-10.sslip.io");
    expect(result.fqdn).toBe("203-0-113-10.sslip.io");
    expect(result.gatewayUrl).not.toContain("tail");
    expect(result.gatewayUrl).not.toContain("tailscale");
  });

  describe("buildHostTimeSyncRepairScript seedLocalNtp flag (2026-05-14 clock-drift incident)", () => {
    it("omits the local-NTP seed by default — keeps Hetzner user_data lean", () => {
      const script = buildHostTimeSyncRepairScript();
      expect(script).not.toContain("_hsnt");
      expect(script).not.toContain("timesyncd.conf.d/hermes-ntp.conf");
    });

    it("seeds a default-gateway NTP drop-in when seedLocalNtp=true (Proxmox path)", () => {
      const script = buildHostTimeSyncRepairScript({ seedLocalNtp: true });
      // _hsnt() helper definition + invocation guarded by the r() wrapper
      expect(script).toContain("_hsnt()");
      expect(script).toContain("r _hsnt;");
      // Resolves default gateway from `ip r` and writes the drop-in file
      expect(script).toContain("ip r");
      expect(script).toContain("/etc/systemd/timesyncd.conf.d/hermes-ntp.conf");
      // systemd-timesyncd does not advance to FallbackNTP while an explicit
      // NTP= server remains configured, even when that server never answers.
      // Keep the local gateway first, but make the public Hetzner servers
      // primary candidates too so an unreachable gateway cannot freeze time.
      expect(script).toContain(
        "NTP=%s ntp1.hetzner.de ntp2.hetzner.de ntp3.hetzner.de"
      );
      expect(script).toContain(
        "FallbackNTP=ntp1.hetzner.de ntp2.hetzner.de ntp3.hetzner.de"
      );
    });

    it("also seeds when seedLocalNtp=true with includeInstallFallback=false", () => {
      const script = buildHostTimeSyncRepairScript({
        seedLocalNtp: true,
        includeInstallFallback: false,
      });
      expect(script).toContain("_hsnt()");
      // No guarded `r _hsnt;` in the no-fallback branch — bare `_hsnt;` call
      expect(script).toContain("_hsnt;");
      expect(script).toContain("/etc/systemd/timesyncd.conf.d/hermes-ntp.conf");
    });
  });

  describe("Caddyfile agent port presets", () => {
    // Regression guard for the 2026-04-30 outage: a new WebUI agent
    // image (`vanilla-hermes-agent:v0.11.x-ash-003`) bound 8787 (main)
    // + 8788 (sidecar), but buildAgentCaddyfile hardcoded 8642 + 9090
    // — every reverse_proxy directive pointed at "connection refused"
    // and every endpoint timed out. Picking the wrong preset is the
    // single ingredient that broke the WebUI fleet, so pin both
    // presets explicitly here.
    it("emits agent:8642 + sidecar:9090 by default (legacy gateway image)", () => {
      const cf = buildAgentCaddyfile("test.example", "agent-x");
      expect(cf).toContain("reverse_proxy agent-x:8642");
      expect(cf).toContain("reverse_proxy agent-x-sidecar:9090");
      expect(cf).not.toContain(":8787");
      expect(cf).not.toContain(":8788");
    });

    it("emits agent:8787 + sidecar:8788 when given the WebUI port preset", () => {
      const cf = buildAgentCaddyfile(
        "test.example",
        "agent-x",
        undefined,
        undefined,
        WEBUI_AGENT_PORTS,
      );
      expect(cf).toContain("reverse_proxy agent-x:8787");
      expect(cf).toContain("reverse_proxy agent-x-sidecar:8788");
      expect(cf).not.toContain(":8642");
      expect(cf).not.toContain(":9090");
    });

    it("agentPortsForBackend('webui') → WebUI preset; anything else → legacy preset", () => {
      expect(agentPortsForBackend("webui")).toEqual(WEBUI_AGENT_PORTS);
      expect(agentPortsForBackend("gateway")).toEqual(LEGACY_AGENT_PORTS);
      expect(agentPortsForBackend(null)).toEqual(LEGACY_AGENT_PORTS);
      expect(agentPortsForBackend(undefined)).toEqual(LEGACY_AGENT_PORTS);
      expect(agentPortsForBackend("")).toEqual(LEGACY_AGENT_PORTS);
    });
  });

  describe("CORS preflight Access-Control-Allow-Headers", () => {
    // Regression guard for the 2026-04-30 chat outage: the dashboard
    // adds an `x-hermes-trace-id` request header on every cross-origin
    // chat fetch (added with the trace-id propagation work). Browsers
    // send a CORS preflight on requests with custom headers; if the
    // preflight response's Access-Control-Allow-Headers list doesn't
    // include x-hermes-trace-id, the browser rejects the actual request
    // with "Request header field x-hermes-trace-id is not allowed by
    // Access-Control-Allow-Headers in preflight response" and chat
    // breaks 100% on every freshly-provisioned agent. Pin the trace-id
    // token in BOTH the gateway and webui preset Caddyfiles.
    it("includes x-hermes-trace-id in the OPTIONS preflight response (legacy gateway preset)", () => {
      const cf = buildAgentCaddyfile("test.example", "agent-x");
      expect(cf).toContain(
        'header Access-Control-Allow-Headers "Content-Type, Authorization, x-hermes-trace-id"',
      );
    });

    it("includes x-hermes-trace-id in the OPTIONS preflight response (WebUI preset)", () => {
      const cf = buildAgentCaddyfile(
        "test.example",
        "agent-x",
        undefined,
        undefined,
        WEBUI_AGENT_PORTS,
      );
      expect(cf).toContain(
        'header Access-Control-Allow-Headers "Content-Type, Authorization, x-hermes-trace-id"',
      );
    });
  });
});
