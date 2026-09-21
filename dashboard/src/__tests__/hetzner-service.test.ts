/**
 * Tests for pure functions in src/lib/services/hetzner-instance-service.ts
 *
 * All functions tested here are pure / deterministic — no network, no env vars,
 * no SSH. Each test verifies correct output given controlled inputs.
 */

process.env.ENCRYPTION_KEY = "a".repeat(64); // required by buildHermesEnvLines → crypto indirect dep

import { execFileSync } from "node:child_process";
import { gunzipSync } from "zlib";
import {
  buildProviderEnv,
  buildProviderEnvResetMap,
  buildManagedEnvResetMap,
  buildHermesEnvLines,
  buildHonchoConfig,
  resolveGatewayConfiguration,
  buildAgentCaddyfile,
  buildAgentDeployScript,
} from "@/lib/services/hetzner-instance-service";

function extractEmbeddedFile(script: string, path: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = script.match(
    new RegExp(`printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d( \\| gunzip)? > ${escapedPath}`)
  );

  expect(match?.[1]).toBeTruthy();

  const encoded = Buffer.from(match![1], "base64");
  return match?.[2] ? gunzipSync(encoded).toString("utf8") : encoded.toString("utf8");
}

function extractPythonHeredoc(script: string, marker: string): string {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = script.match(
    new RegExp(`${escapedMarker}[\\s\\S]*?python3 - <<'PY'\\n([\\s\\S]*?)\\nPY`)
  );

  expect(match?.[1]).toBeTruthy();

  return match![1];
}

// ── buildProviderEnv ──────────────────────────────────────────────────────────

describe("buildProviderEnv", () => {
  it("openrouter → OPENROUTER_API_KEY", () => {
    const env = buildProviderEnv("openrouter", "or_key");
    expect(env).toContain("OPENROUTER_API_KEY=or_key");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=openrouter");
  });

  it("codex → official Hermes openai-codex provider", () => {
    const env = buildProviderEnv("codex", "codex_key");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=openai-codex");
    expect(env).not.toContain("OPENAI_API_KEY=codex_key");
  });

  it("anthropic → ANTHROPIC_API_KEY + anthropic provider", () => {
    const env = buildProviderEnv("anthropic", "sk-ant");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-ant");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=anthropic");
  });

  it("gemini → mapped to custom with OpenAI-compatible and native Gemini key aliases", () => {
    const env = buildProviderEnv("gemini", "gk");
    expect(env).toContain("OPENAI_API_KEY=gk");
    expect(env).toContain("GEMINI_API_KEY=gk");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
  });

  it("bankr → mapped to custom with OPENAI_API_KEY", () => {
    const env = buildProviderEnv("bankr", "bk_key");
    expect(env).toContain("OPENAI_API_KEY=bk_key");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
  });

  it("venice → mapped to custom with OPENAI_API_KEY", () => {
    const env = buildProviderEnv("venice", "vk");
    expect(env).toContain("OPENAI_API_KEY=vk");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
  });

  it("deepseek → DEEPSEEK_API_KEY + deepseek provider", () => {
    const env = buildProviderEnv("deepseek", "ds");
    expect(env).toContain("DEEPSEEK_API_KEY=ds");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=deepseek");
  });

  it("groq → mapped to custom with OPENAI_API_KEY", () => {
    const env = buildProviderEnv("groq", "gq");
    expect(env).toContain("OPENAI_API_KEY=gq");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
  });

  it("xai → mapped to custom with OPENAI_API_KEY", () => {
    const env = buildProviderEnv("xai", "xk");
    expect(env).toContain("OPENAI_API_KEY=xk");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
  });

  it("alibaba → DASHSCOPE_API_KEY + coding-intl base URL", () => {
    const env = buildProviderEnv("alibaba", "ds_key");
    expect(env).toContain("DASHSCOPE_API_KEY=ds_key");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=alibaba");
    // Must include the coding-intl base URL (v0.7.0 defaults to the wrong endpoint for sk-sp- keys)
    expect(env).toContain("DASHSCOPE_BASE_URL=https://coding-intl.dashscope.aliyuncs.com/v1");
    const joined = env.join("\n");
    expect(joined).not.toContain("OPENROUTER_API_KEY");
  });

  it("unknown provider → falls back to openrouter", () => {
    const env = buildProviderEnv("mystery-provider", "key");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=openrouter");
    expect(env).toContain("OPENROUTER_API_KEY=key");
  });

  it("moonshot → KIMI_API_KEY + kimi-coding provider + official Moonshot base URL", () => {
    const env = buildProviderEnv("moonshot", "mk");
    expect(env).toContain("KIMI_API_KEY=mk");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=kimi-coding");
    expect(env).toContain("KIMI_BASE_URL=https://api.moonshot.ai/v1");
    const joined = env.join("\n");
    expect(joined).not.toContain("OPENROUTER_API_KEY");
  });

  it("moonshot Kimi Code keys route to the coding endpoint", () => {
    const env = buildProviderEnv("moonshot", "sk-kimi-test-key");
    expect(env).toContain("KIMI_API_KEY=sk-kimi-test-key");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=kimi-coding");
    expect(env).toContain("KIMI_BASE_URL=https://api.kimi.com/coding");
  });

  it("zhipu → GLM_API_KEY + zai provider (no base URL override)", () => {
    const env = buildProviderEnv("zhipu", "zk");
    expect(env).toContain("GLM_API_KEY=zk");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=zai");
    const joined = env.join("\n");
    expect(joined).not.toContain("OPENROUTER_API_KEY");
    expect(joined).not.toContain("OPENROUTER_BASE_URL");
  });

  // OpenAI-compatible providers must emit OPENAI_BASE_URL alongside the key.
  // Without this, a provider switch leaves the container with provider=custom +
  // key but no base URL → hermes-cli defaults to api.openai.com → blank response.
  it.each([
    ["crof", "https://crof.ai/v1"],
    ["venice", "https://api.venice.ai/api/v1"],
    ["cometapi", "https://api.cometapi.com/v1"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/"],
    ["groq", "https://api.groq.com/openai/v1"],
    ["xai", "https://api.x.ai/v1"],
    ["bankr", "https://llm.bankr.bot/v1"],
    ["nous", "https://inference-api.nousresearch.com/v1"],
    ["openai", "https://api.openai.com/v1"],
  ])("%s emits OPENAI_BASE_URL=%s", (provider, expected) => {
    const env = buildProviderEnv(provider, "key");
    expect(env).toContain(`OPENAI_BASE_URL=${expected}`);
  });
});

describe("buildProviderEnvResetMap", () => {
  it("clears OPENAI_BASE_URL so it doesn't leak across provider switches", () => {
    // A previous custom-provider stint can leave a stale OPENAI_BASE_URL in
    // .env (eg. switching crof → openrouter). The reset map must zero it out.
    expect(buildProviderEnvResetMap()).toMatchObject({
      OPENAI_BASE_URL: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENROUTER_API_KEY: "",
    });
  });
});

describe("buildManagedEnvResetMap", () => {
  it("covers provider, browser, search, and deploy-managed runtime keys", () => {
    expect(buildManagedEnvResetMap()).toMatchObject({
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      FIRECRAWL_API_KEY: "",
      TAVILY_API_KEY: "",
      EXA_API_KEY: "",
      BROWSERBASE_API_KEY: "",
      BROWSERBASE_PROJECT_ID: "",
      BROWSER_USE_API_KEY: "",
      SUPERMEMORY_API_KEY: "",
      SUPERMEMORY_CONTAINER_TAG: "",
      HERMES_DASHBOARD_URL: "",
      HERMES_SUBDOMAIN: "",
    });
  });
});

// ── buildHermesEnvLines ───────────────────────────────────────────────────────

describe("buildHermesEnvLines", () => {
  it("always includes API_SERVER_KEY and API_SERVER_PORT", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("API_SERVER_KEY=test-key");
    expect(joined).toContain("API_SERVER_PORT=8642");
    expect(joined).toContain("API_SERVER_ENABLED=true");
  });

  it("normalizes regressed Anthropic snapshot IDs before writing HERMES_MODEL", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-test",
      apiServerKey: "k",
      provider: "anthropic",
      apiKey: "sk-ant",
      model: "claude-opus-4-1-20250805",
    });
    expect(lines.join("\n")).toContain("HERMES_MODEL=claude-opus-4-7");
  });

  it("defaults Anthropic deployments to Claude Opus 4.8 when no model is provided", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "anthropic",
      apiKey: "sk-ant",
      model: "",
      fqdn: "agent.example.com",
      cpuLimit: 1,
      ramLimit: 1024,
    });

    const decodedConfig = extractEmbeddedFile(script, "config.yaml");
    expect(decodedConfig).toContain('default: "claude-opus-4-8"');
  });

  it("omits HERMES_MODEL when not provided", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-test",
      apiServerKey: "k",
      provider: "openrouter",
      apiKey: "or",
    });
    expect(lines.join("\n")).not.toContain("HERMES_MODEL=");
  });

  it("includes openai-codex even without a raw API key", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-test",
      apiServerKey: "k",
      provider: "codex",
      apiKey: "",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("HERMES_INFERENCE_PROVIDER=openai-codex");
    expect(joined).not.toContain("OPENAI_API_KEY=");
  });

  it("includes TAVILY_API_KEY when agentSettings provides it", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-test",
      apiServerKey: "k",
      provider: "openrouter",
      apiKey: "or",
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        tavilyApiKey: "tvly_secret",
      },
    });
    expect(lines.join("\n")).toContain("TAVILY_API_KEY=tvly_secret");
  });

  it("includes EXA_API_KEY when agentSettings provides it", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-test",
      apiServerKey: "k",
      provider: "openrouter",
      apiKey: "or",
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        exaApiKey: "exa_secret",
      },
    });
    expect(lines.join("\n")).toContain("EXA_API_KEY=exa_secret");
  });

  it("includes HERMES_MAX_ITERATIONS from agentSettings", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-test",
      apiServerKey: "k",
      provider: "openrouter",
      apiKey: "or",
      agentSettings: {
        maxIterations: 90,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
      },
    });
    expect(lines.join("\n")).toContain("HERMES_MAX_ITERATIONS=90");
  });
});

// ── buildHonchoConfig ─────────────────────────────────────────────────────────

describe("buildHonchoConfig", () => {
  it("returns null when no settings provided", () => {
    expect(buildHonchoConfig()).toBeNull();
    expect(buildHonchoConfig(undefined)).toBeNull();
  });

  it("returns null when neither apiKey nor baseUrl is set", () => {
    expect(
      buildHonchoConfig({ enabled: true, memoryMode: "hybrid", recallMode: "hybrid" })
    ).toBeNull();
  });

  it("returns JSON config when apiKey is provided", () => {
    const result = buildHonchoConfig({
      enabled: true,
      apiKey: "hk_test",
      memoryMode: "hybrid",
      recallMode: "hybrid",
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.apiKey).toBe("hk_test");
    expect(parsed.hosts.hermes.enabled).toBe(true);
  });

  it("returns JSON config when baseUrl is provided (self-hosted)", () => {
    const result = buildHonchoConfig({
      enabled: true,
      baseUrl: "http://localhost:8080",
      memoryMode: "honcho",
      recallMode: "context",
    });
    const parsed = JSON.parse(result!);
    expect(parsed.baseUrl).toBe("http://localhost:8080");
    expect(parsed.hosts.hermes.memoryMode).toBe("honcho");
    expect(parsed.hosts.hermes.recallMode).toBe("context");
  });

  it("includes peerName in the hosts.hermes block when set", () => {
    const result = buildHonchoConfig({
      enabled: true,
      apiKey: "hk",
      peerName: "alice",
      aiPeer: "hermes-bot",
    });
    const parsed = JSON.parse(result!);
    expect(parsed.hosts.hermes.peerName).toBe("alice");
    expect(parsed.hosts.hermes.aiPeer).toBe("hermes-bot");
  });

  it("uses 'hermes' as default aiPeer when not specified", () => {
    const result = buildHonchoConfig({ enabled: true, apiKey: "hk" });
    const parsed = JSON.parse(result!);
    expect(parsed.hosts.hermes.aiPeer).toBe("hermes");
  });
});

// ── resolveGatewayConfiguration ──────────────────────────────────────────────

describe("resolveGatewayConfiguration", () => {
  it("defaults to sslip.io when no dnsDomain is passed", () => {
    const result = resolveGatewayConfiguration({ subdomain: "abc", ipv4: "203.0.113.4" });
    expect(result.gatewayUrl).toBe("https://203-0-113-4.sslip.io");
    expect(result.fqdn).toBe("203-0-113-4.sslip.io");
  });

  it("ignores subdomain on the sslip path so legacy callers get a stable URL", () => {
    const a = resolveGatewayConfiguration({ subdomain: "abc123", ipv4: "203.0.113.4" });
    const b = resolveGatewayConfiguration({ subdomain: null, ipv4: "203.0.113.4" });
    expect(a.gatewayUrl).toBe("https://203-0-113-4.sslip.io");
    expect(b.gatewayUrl).toBe("https://203-0-113-4.sslip.io");
    expect(a).toEqual(b);
  });

  it("returns <subdomain>.<dnsDomain> when dnsDomain + subdomain are both set", () => {
    const result = resolveGatewayConfiguration({
      subdomain: "inst-abc",
      ipv4: "203.0.113.4",
      dnsDomain: "agents.hermesos.cloud",
    });
    expect(result.fqdn).toBe("inst-abc.agents.hermesos.cloud");
    expect(result.gatewayUrl).toBe("https://inst-abc.agents.hermesos.cloud");
  });

  it("strips wrapping dots from dnsDomain so config edges don't break the FQDN", () => {
    const result = resolveGatewayConfiguration({
      subdomain: "inst-abc",
      ipv4: "203.0.113.4",
      dnsDomain: ".agents.hermesos.cloud.",
    });
    expect(result.fqdn).toBe("inst-abc.agents.hermesos.cloud");
  });

  it("falls back to sslip.io when dnsDomain is set but subdomain is null", () => {
    // Defensive: we never want to mint `.hermesos.cloud` (zone apex) or
    // a dotless record by accident if subdomain wasn't generated.
    const result = resolveGatewayConfiguration({
      subdomain: null,
      ipv4: "198.51.100.8",
      dnsDomain: "agents.hermesos.cloud",
    });
    expect(result.fqdn).toBe("198-51-100-8.sslip.io");
  });

  it("falls back to sslip.io when subdomain is null even without dnsDomain", () => {
    const result = resolveGatewayConfiguration({
      subdomain: null,
      ipv4: "198.51.100.8",
    });
    expect(result.fqdn).toBe("198-51-100-8.sslip.io");
    expect(result.gatewayUrl).toBe("https://198-51-100-8.sslip.io");
  });
});

// ── buildAgentCaddyfile ───────────────────────────────────────────────────────

describe("buildAgentCaddyfile", () => {
  it("generates a ':80' binding when fqdn is localhost (no SSL)", () => {
    const caddyfile = buildAgentCaddyfile("localhost", "agent-abc");
    expect(caddyfile).toContain(":80");
    expect(caddyfile).not.toContain("https://");
  });

  it("does not force sslip.io gateways onto Caddy's internal CA", () => {
    const caddyfile = buildAgentCaddyfile("203-0-113-4.sslip.io", "agent-sslip");
    expect(caddyfile).not.toContain("tls internal");
  });

  it("uses only the FQDN when a real domain is used", () => {
    const caddyfile = buildAgentCaddyfile("abc.hermesdeploy.com", "agent-abc");
    expect(caddyfile).toContain("abc.hermesdeploy.com");
    expect(caddyfile).not.toContain("abc.hermesdeploy.com, :80");
  });

  it("routes the web API through the authenticated sidecar instead of exposing the dashboard directly", () => {
    const caddyfile = buildAgentCaddyfile("abc.hermesdeploy.com", "agent-abc");
    expect(caddyfile).toContain("handle_path /web-api/*");
    expect(caddyfile).toContain("reverse_proxy agent-abc-sidecar:9090");
    expect(caddyfile).not.toContain("reverse_proxy agent-abc-web:9119");
  });

  it("reverse_proxies to the correct container name", () => {
    const caddyfile = buildAgentCaddyfile("xyz.example.com", "agent-xyz-container");
    expect(caddyfile).toContain("reverse_proxy agent-xyz-container:8642");
  });

  it("includes CORS preflight handler", () => {
    const caddyfile = buildAgentCaddyfile("localhost", "agent-test");
    expect(caddyfile).toContain("Access-Control-Allow-Origin");
    expect(caddyfile).toContain("OPTIONS");
  });

  it("includes gzip/zstd compression", () => {
    const caddyfile = buildAgentCaddyfile("localhost", "agent-test");
    expect(caddyfile).toContain("encode zstd gzip");
  });

  it("gates dashboard browser access behind the session cookie and sidecar", () => {
    const caddyfile = buildAgentCaddyfile("localhost", "agent-test");
    expect(caddyfile).toContain("@dashboard_browser");
    expect(caddyfile).toContain("hermes_dashboard_session");
    expect(caddyfile).toContain("reverse_proxy agent-test-sidecar:9090");
  });

  it("preserves profile routes in the generated Caddyfile and restores running profile gateways after redeploy", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      profileRoutes: [
        { name: "skodari", port: 8650 },
        { name: "research", port: 8651 },
      ],
      profilesToRestore: [
        { name: "skodari", port: 8650 },
      ],
    });

    const caddyDecoded = extractEmbeddedFile(script, "Caddyfile");

    expect(caddyDecoded).toContain("handle_path /profiles/skodari*");
    expect(caddyDecoded).toContain("reverse_proxy agent-test:8650");
    expect(caddyDecoded).toContain("handle_path /profiles/research*");
    expect(caddyDecoded).toContain("reverse_proxy agent-test:8651");
    expect(caddyDecoded).toMatch(/handle_path \/profiles\/skodari\* \{\s+reverse_proxy agent-test:8650\s+\}/s);
    expect(caddyDecoded).not.toMatch(/handle_path \/profiles\/skodari\* \{\s+reverse_proxy agent-test:8650 \{\s+lb_try_duration 30s/s);
    expect(caddyDecoded).toContain("reverse_proxy agent-test:8642 {");
    expect(caddyDecoded).toContain("lb_try_duration 30s");

    expect(script).toContain("Restart profile gateways that were active before redeploy");
    expect(script).toContain('profiles = json.loads');
    expect(script).toContain('\\"skodari\\"');
    expect(script).toContain('"HERMES_HOME": str(profile_dir)');
  });
});

// ── buildAgentDeployScript ──────────────────────────────────────────────────

describe("buildAgentDeployScript", () => {
  it("includes dynamic IP resolution logic when fqdn is 0-0-0-0.sslip.io", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "0-0-0-0.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
    });
    expect(script).toContain('Resolving public IP dynamically for 0-0-0-0.sslip.io placeholder...');
    expect(script).toContain('PUBLIC_IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -s ifconfig.me)');
    expect(script).toContain('sed -i "s/0-0-0-0\\\\.sslip\\\\.io/$REAL_FQDN/g" .env Caddyfile docker-compose.yml');
  });

  it("does not include dynamic IP resolution logic for other fqdns", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc-123.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
    });
    expect(script).not.toContain('Resolving public IP dynamically for 0-0-0-0.sslip.io placeholder...');
  });

  it("injects the dashboard upstream URL into the sidecar environment", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "agent.example.com",
      cpuLimit: 1,
      ramLimit: 1024,
    });

    const dockerComposeDecoded = extractEmbeddedFile(script, "docker-compose.yml");
    expect(dockerComposeDecoded).toContain("DASHBOARD_UPSTREAM_URL=http://agent-test-web:9119");
  });

  it("includes the web toolset and firecrawl backend in config.yaml when firecrawlApiKey is present", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.5,
        sessionResetMode: "both",
        firecrawlApiKey: "fc_test_key",
      },
    });
    
    const configYamlDecoded = extractEmbeddedFile(script, "config.yaml");

    expect(configYamlDecoded).toContain('  - web\nagent:');
    expect(configYamlDecoded).toContain('web:\n  backend: firecrawl');
  });

  it("includes the web toolset and tavily backend in config.yaml when tavilyApiKey is present", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.5,
        sessionResetMode: "both",
        tavilyApiKey: "tvly_test_key",
      },
    });
    
    const configYamlDecoded = extractEmbeddedFile(script, "config.yaml");

    expect(configYamlDecoded).toContain('  - web\nagent:');
    expect(configYamlDecoded).toContain('web:\n  backend: tavily');
  });

  it("prioritizes firecrawl backend when both firecrawl and tavily keys are present", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.5,
        sessionResetMode: "both",
        firecrawlApiKey: "fc_test_key",
        tavilyApiKey: "tvly_test_key",
      },
    });
    
    const configYamlDecoded = extractEmbeddedFile(script, "config.yaml");

    expect(configYamlDecoded).toContain('web:\n  backend: firecrawl');
  });

  it("writes upstream Tool Gateway config sections when Nous Subscription toggles are enabled", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.5,
        sessionResetMode: "both",
        webUseGateway: true,
        imageGenUseGateway: true,
        ttsUseGateway: true,
        browserUseGateway: true,
      },
    });

    const configYamlDecoded = extractEmbeddedFile(script, "config.yaml");

    expect(configYamlDecoded).toContain("web:\n  backend: firecrawl\n  use_gateway: true");
    expect(configYamlDecoded).toContain("browser:\n  cloud_provider: browser-use\n  use_gateway: true");
    expect(configYamlDecoded).toContain("image_gen:\n  use_gateway: true");
    expect(configYamlDecoded).toContain("tts:\n  provider: openai\n  use_gateway: true");
  });

  it("writes Codex instances with the official Hermes provider", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "codex",
      apiKey: "",
      model: "gpt-5.4",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
    });

    const envDecoded = extractEmbeddedFile(script, ".env.new");

    expect(envDecoded).toContain("HERMES_INFERENCE_PROVIDER=openai-codex");
    expect(envDecoded).not.toContain("OPENAI_API_KEY=");

    const configYamlDecoded = extractEmbeddedFile(script, "config.yaml");

    expect(configYamlDecoded).toContain('provider: "openai-codex"');
    expect(configYamlDecoded).toContain('base_url: "https://chatgpt.com/backend-api/codex"');
  });

  it("writes Bankr instances as custom OpenAI-compatible deployments with the Bankr gateway defaults", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "bankr",
      apiKey: "bk_key",
      model: "",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
    });

    const envDecoded = extractEmbeddedFile(script, ".env.new");
    const configYamlDecoded = extractEmbeddedFile(script, "config.yaml");

    expect(envDecoded).toContain("HERMES_INFERENCE_PROVIDER=custom");
    expect(envDecoded).toContain("OPENAI_API_KEY=bk_key");
    expect(configYamlDecoded).toContain('provider: "custom"');
    expect(configYamlDecoded).toContain('base_url: "https://llm.bankr.bot/v1"');
    expect(configYamlDecoded).toContain('default: "claude-opus-4.7"');
  });

  it("writes honcho.json from the unified memorySystem Honcho settings", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      memorySystem: {
        provider: "honcho",
        honchoApiKey: "honcho_api_key",
        honchoBaseUrl: "https://honcho.example",
        honchoMemoryMode: "honcho",
        honchoRecallMode: "tools",
      },
    });

    const honchoJsonDecoded = extractEmbeddedFile(script, "honcho.json");

    expect(honchoJsonDecoded).toContain('"apiKey": "honcho_api_key"');
    expect(honchoJsonDecoded).toContain('"baseUrl": "https://honcho.example"');
    expect(honchoJsonDecoded).toContain('"memoryMode": "honcho"');
    expect(honchoJsonDecoded).toContain('"recallMode": "tools"');
  });

  it("writes Supermemory env vars and installs the missing runtime memory dependencies", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      memorySystem: {
        provider: "supermemory",
        supermemoryApiKey: "supermemory_api_key",
        supermemoryContainerTag: "workspace-alpha",
      },
    });

    const envDecoded = extractEmbeddedFile(script, ".env.new");
    const composeDecoded = extractEmbeddedFile(script, "docker-compose.yml");
    const dockerfileDecoded = extractEmbeddedFile(script, "Dockerfile.agent-memory");

    expect(envDecoded).toContain("SUPERMEMORY_API_KEY=supermemory_api_key");
    expect(envDecoded).toContain("SUPERMEMORY_CONTAINER_TAG=workspace-alpha");
    expect(composeDecoded).toContain("dockerfile: Dockerfile.agent-memory");
    expect(dockerfileDecoded).toContain("mem0ai");
    expect(dockerfileDecoded).toContain("hindsight-client>=0.4.22");
    expect(dockerfileDecoded).toContain("supermemory");
    expect(dockerfileDecoded).toContain("npm install -g byterover-cli");
  });

  it("writes profile-scoped Hindsight config and installs hindsight-all for local mode", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      memorySystem: {
        provider: "hindsight",
        hindsightMode: "local",
        hindsightBankId: "hermes-local",
        hindsightBudget: "high",
        hindsightLlmApiKey: "local-llm-key",
        hindsightLlmProvider: "openai_compatible",
        hindsightLlmModel: "my-local-model",
        hindsightLlmBaseUrl: "http://llm.local:8080/v1",
      },
    });

    const configDecoded = extractEmbeddedFile(script, "hindsight/config.json");
    const composeDecoded = extractEmbeddedFile(script, "docker-compose.yml");
    const dockerfileDecoded = extractEmbeddedFile(script, "Dockerfile.agent-memory");

    expect(configDecoded).toContain('"mode": "local_embedded"');
    expect(configDecoded).toContain('"bank_id": "hermes-local"');
    expect(configDecoded).toContain('"recall_budget": "high"');
    expect(configDecoded).toContain('"llm_provider": "openai_compatible"');
    expect(configDecoded).toContain('"llm_model": "my-local-model"');
    expect(configDecoded).toContain('"llm_base_url": "http://llm.local:8080/v1"');
    expect(composeDecoded).toContain("./hindsight:");
    expect(dockerfileDecoded).toContain("hindsight-all");
  });



  it("starts the main gateway via the upstream entrypoint contract and moves web-api to a dedicated service", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
    });

    const composeDecoded = extractEmbeddedFile(script, "docker-compose.yml");

    expect(composeDecoded).toContain('command: ["gateway", "run"]');
    expect(composeDecoded).not.toContain('sh -c "python3 -c');
    expect(composeDecoded).toContain('container_name: agent-test-web');
    expect(composeDecoded).toContain('command: ["dashboard", "--host", "0.0.0.0", "--no-open", "--insecure", "--tui"]');
    expect(composeDecoded).toContain("HERMES_DASHBOARD_TUI=1");
  });

  it("mounts a persistent Hermes auth store when a reusable Codex bundle is provided", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "codex",
      apiKey: "",
      model: "gpt-5.4",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      codexAuthBundle: {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        lastRefresh: "2026-04-11T12:00:00Z",
      },
    });

    const authDecoded = extractEmbeddedFile(script, "auth.json.inject");
    const composeDecoded = extractEmbeddedFile(script, "docker-compose.yml");

    expect(authDecoded).toContain('"active_provider": "openai-codex"');
    expect(authDecoded).toContain('"refresh_token": "refresh-456"');
    expect(composeDecoded).toContain("services:");
    expect(script).toContain("for container_name in agent-test-instance agent-test-instance-web; do");
    expect(script).toContain('docker cp auth.json.inject "$container_name:/opt/data/auth.json" || true');
    expect(script).toContain('docker exec -u root "$container_name" sh -lc');
    expect(script).toContain('restarted_containers="$restarted_containers $container_name"');
    expect(script).toContain("chown hermes:hermes /opt/data/auth.json /opt/data/auth.lock");
    expect(script).toContain("chmod 600 /opt/data/auth.json /opt/data/auth.lock");
    expect(script).not.toContain('docker cp auth.json.inject "$container_name:/root/.hermes/auth.json"');
  });

  it("mounts a persistent Hermes auth store for the WebUI openai-codex provider alias", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openai-codex",
      apiKey: "",
      model: "gpt-5.4",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
      codexAuthBundle: {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        lastRefresh: "2026-04-11T12:00:00Z",
      },
    });

    const authDecoded = extractEmbeddedFile(script, "auth.json.inject");

    expect(authDecoded).toContain('"active_provider": "openai-codex"');
    expect(authDecoded).toContain('"refresh_token": "refresh-456"');
  });

  it("patches the live Hermes runtime so bind-mounted config saves do not fail with EBUSY", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
    });

    expect(script).toContain("# Patch Hermes runtime so bind-mounted config writes survive EBUSY");
    expect(script).toContain("for container_name in agent-test agent-test-web; do");
    expect(script).toContain('resolve_running_container_name() {');
    expect(script).toContain(`docker ps --format '{{.Names}}' 2>/dev/null | awk -v requested="$requested_name" '$0 == requested || $0 ~ ("_" requested "$") { print; exit }'`);
    expect(script).toContain('resolved_name="$(resolve_running_container_name "$container_name")"');
    expect(script).toContain('docker exec -i -u 0 "$resolved_name" python3 - <<\'PY\'');
    expect(script).toContain("def patch(t, name):");
    expect(script).toContain('for n in ("atomic_yaml_write", "rewrite_env_file"):');
    expect(script).toContain('nl = "\\n" if t.endswith("\\n") else ""');
    expect(script).toContain('t = "\\n".join(ls) + nl');
    expect(script).toContain("if exc.errno != errno.EBUSY:");
    expect(script).toContain('with open({s}, "r", encoding="utf-8") as a, open({d}, "w", encoding="utf-8") as b:');
    expect(script).toContain('expected atomic_yaml_write or rewrite_env_file for EBUSY patch');
    expect(script).toContain('[ -n "$resolved_containers" ] && docker restart $resolved_containers >/dev/null');
  });

  it("emits a bind-mount runtime patch heredoc that compiles under python3", () => {
    const script = buildAgentDeployScript({
      instanceId: "test-instance",
      containerName: "agent-test",
      apiServerKey: "test-key",
      provider: "openrouter",
      apiKey: "or_api_key",
      model: "test-model",
      fqdn: "abc.sslip.io",
      cpuLimit: 1,
      ramLimit: 1024,
    });

    const pythonPatch = extractPythonHeredoc(
      script,
      "# Patch Hermes runtime so bind-mounted config writes survive EBUSY"
    );

    expect(() =>
      execFileSync(
        "python3",
        ["-c", "import sys; compile(sys.stdin.read(), '<stdin>', 'exec')"],
        { input: pythonPatch }
      )
    ).not.toThrow();
  });
});
