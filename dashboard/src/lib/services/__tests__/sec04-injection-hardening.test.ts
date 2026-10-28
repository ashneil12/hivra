import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Script, createContext } from "node:vm";

import { load as loadYaml } from "js-yaml";

import {
  buildAgentCaddyfile,
  buildAgentDeployScript,
  buildHermesEnvLines,
  buildProviderEnv,
  buildSslipPlaceholderResolutionScript,
} from "@/lib/services/hetzner-instance-builders";
import {
  buildHermesEnvFile,
  buildWebUIComposeEnv,
  buildWebUIConfigYaml,
  type WebUIDeployParams,
} from "@/lib/services/webui-instance-builder";
import { SIDECAR_SERVER_CODE } from "@/lib/services/sidecar-script";
import { ProfileService } from "@/lib/services/profile-service";
import { supabaseAdmin } from "@/lib/supabase";
import { sshExec } from "@/lib/hetzner/ssh";

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

const ENV_KEY_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The generated sed uses GNU `sed -i` semantics; on macOS (BSD sed) translate
// it to the equivalent BSD form so the behavioral test exercises the same logic.
const SED_SHIM =
  process.platform === "darwin"
    ? 'sed() { if [ "$1" = "-i" ]; then shift; command sed -i \'\' "$@"; else command sed "$@"; fi; }\n'
    : "";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Same embedded-file extraction as hetzner-instance-builders.test.ts: pulls a
// base64 / gzip+base64 `> path` blob back out of a generated deploy script.
function extractEmbeddedFile(script: string, path: string): string {
  const escapedPath = escapeRegExp(path);
  const compressedMatch = script.match(
    new RegExp(`printf '%s' '([^']+)' \\| base64 -d \\| gunzip > ${escapedPath}`)
  );
  if (compressedMatch?.[1]) {
    return gunzipSync(Buffer.from(compressedMatch[1], "base64")).toString("utf8");
  }
  const rawMatch = script.match(
    new RegExp(`printf '%s' '([^']+)' \\| base64 -d > ${escapedPath}`)
  );
  if (rawMatch?.[1]) {
    return Buffer.from(rawMatch[1], "base64").toString("utf8");
  }
  throw new Error(`Unable to extract embedded file for ${path}`);
}

const webuiBaseParams: WebUIDeployParams = {
  instanceId: "inst-sec04",
  containerName: "agent-inst-sec04",
  fqdn: "agent.example.com",
  cpuLimit: 2,
  ramLimit: 4096,
  llmApiKey: "provider-key",
  inferenceProvider: "custom",
  defaultModel: "deepseek-v3.2",
  baseUrl: "https://crof.ai/v1",
  webuiPassword: "webui-password",
};

describe("SEC-04: createProfile validates the profile name before any DB write", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects an invalid name without inserting a profiles row", async () => {
    const mockInsert = jest.fn();
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({ insert: mockInsert });

    await expect(
      ProfileService.createProfile("inst_123", "user_123", {
        name: 'bad name"; rm -rf /',
      })
    ).rejects.toThrow("Invalid identifier format");

    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("rejects a name containing a newline without touching the DB or the box", async () => {
    const mockInsert = jest.fn();
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({ insert: mockInsert });

    await expect(
      ProfileService.createProfile("inst_123", "user_123", {
        name: "agent\nMALICIOUS=injected",
      })
    ).rejects.toThrow("Invalid identifier format");

    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
  });
});

describe("SEC-04: buildAgentCaddyfile rejects injectable profile routes", () => {
  it("emits profile routes for well-formed entries", () => {
    const cf = buildAgentCaddyfile("test.example", "agent-x", undefined, [
      { name: "my_agent-2", port: 8650 },
    ]);
    expect(cf).toContain("handle_path /profiles/my_agent-2*");
    expect(cf).toContain("reverse_proxy agent-x:8650");
  });

  it.each([
    ["space injection", "bad name"],
    ["Caddyfile directive breakout", 'agent" } respond 200'],
    ["newline injection", "agent\nreverse_proxy evil:1"],
    ["path traversal", "../etc"],
    ["wildcard smuggling", "agent*"],
    ["empty name", ""],
  ])("throws on %s", (_label, name) => {
    expect(() =>
      buildAgentCaddyfile("test.example", "agent-x", undefined, [{ name, port: 8650 }])
    ).toThrow(/Invalid profile route name/);
  });

  it.each([[0], [65536], [-1], [8650.5], [Number.NaN]])(
    "throws on invalid port %s",
    (port) => {
      expect(() =>
        buildAgentCaddyfile("test.example", "agent-x", undefined, [
          { name: "agent", port },
        ])
      ).toThrow(/Invalid profile route port/);
    }
  );
});

describe("SEC-04: buildSslipPlaceholderResolutionScript validates the resolved IP", () => {
  it("returns nothing for non-placeholder FQDNs", () => {
    expect(buildSslipPlaceholderResolutionScript("agent.example.com")).toBe("");
  });

  it("uses https for the fallback IP lookup and gates sed on an IPv4-only check", () => {
    const script = buildSslipPlaceholderResolutionScript("0-0-0-0.sslip.io");
    expect(script).toContain("https://ifconfig.me");
    expect(script).not.toContain("curl -s ifconfig.me");
    // Fail-closed guard: any byte outside [0-9.] (or an empty reply) blanks
    // PUBLIC_IP so the sed below never runs on a poisoned value.
    expect(script).toContain(`case "$PUBLIC_IP" in *[!0-9.]*|'') PUBLIC_IP="" ;; esac`);
    // The validation must come after the lookup and before the sed block.
    expect(script.indexOf("PUBLIC_IP=$(")).toBeLessThan(script.indexOf('case "$PUBLIC_IP"'));
    expect(script.indexOf('case "$PUBLIC_IP"')).toBeLessThan(
      script.indexOf('if [ -n "$PUBLIC_IP" ]')
    );
  });

  it("leaves the placeholder in place when the IP lookup returns a hostile payload", () => {
    const script = buildSslipPlaceholderResolutionScript("0-0-0-0.sslip.io");
    const dir = mkdtempSync(join(tmpdir(), "sec04-sslip-"));
    try {
      writeFileSync(join(dir, ".env"), "FQDN=0-0-0-0.sslip.io\n");
      writeFileSync(join(dir, "Caddyfile"), "0-0-0-0.sslip.io {\n}\n");
      writeFileSync(join(dir, "docker-compose.yml"), "# 0-0-0-0.sslip.io\n");
      // A stubbed `curl` (a shell function, visible inside $(...)) answers with
      // a payload that would inject a sed expression / FQDN if unvalidated.
      const stubbed =
        "curl() { printf '%s' 'x; touch hacked; s/.*//'; }\n" + SED_SHIM + script;
      execFileSync("bash", ["-c", stubbed], { cwd: dir });
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("0-0-0-0.sslip.io");
      expect(readFileSync(join(dir, "Caddyfile"), "utf8")).toContain("0-0-0-0.sslip.io");
      expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("0-0-0-0.sslip.io");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites the placeholder when the IP lookup returns a real IPv4", () => {
    const script = buildSslipPlaceholderResolutionScript("0-0-0-0.sslip.io");
    const dir = mkdtempSync(join(tmpdir(), "sec04-sslip-"));
    try {
      writeFileSync(join(dir, ".env"), "FQDN=0-0-0-0.sslip.io\n");
      writeFileSync(join(dir, "Caddyfile"), "0-0-0-0.sslip.io {\n}\n");
      writeFileSync(join(dir, "docker-compose.yml"), "# 0-0-0-0.sslip.io\n");
      const stubbed = "curl() { printf '%s' '203.0.113.9'; }\n" + SED_SHIM + script;
      execFileSync("bash", ["-c", stubbed], { cwd: dir });
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("203-0-113-9.sslip.io");
      expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("0-0-0-0.sslip.io");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SEC-04: provider + hermes env lines cannot inject extra assignments", () => {
  it("strips line breaks from buildProviderEnv apiKey and custom base URL", () => {
    const lines = buildProviderEnv("openrouter", "sk-real\nMALICIOUS=injected");
    expect(lines).toContain("OPENROUTER_API_KEY=sk-realMALICIOUS=injected");
    expect(lines.every((line) => !/[\r\n\0]/.test(line))).toBe(true);

    const venice = buildProviderEnv("venice", "k", "https://crof.ai/v1\nMALICIOUS=injected");
    expect(venice.every((line) => !/[\r\n\0]/.test(line))).toBe(true);
    expect(venice.filter((line) => line.startsWith("MALICIOUS="))).toHaveLength(0);
  });

  it("strips injection attempts from every buildHermesEnvLines value", () => {
    const lines = buildHermesEnvLines({
      containerName: "agent-x",
      apiServerKey: `${"k".repeat(64)}\nMALICIOUS=injected`,
      provider: "openai",
      apiKey: "sk-real\nMALICIOUS=injected",
      model: "gpt-5.4\r\nMALICIOUS=injected",
      agentSettings: {
        maxIterations: 60,
        toolProgressMode: "all",
        compressionThreshold: 0.85,
        sessionResetMode: "both",
        tavilyApiKey: "tv\nMALICIOUS=injected",
        browserbaseProjectId: "proj\0MALICIOUS=injected",
      },
      honchoSettings: {
        enabled: true,
        heartbeatModel: "m\nMALICIOUS=injected",
      },
      memorySystem: {
        provider: "honcho",
        honchoApiKey: "h\nMALICIOUS=injected",
        honchoBaseUrl: "https://honcho.example\nMALICIOUS=injected",
      },
    });

    expect(lines.every((line) => !/[\r\n\0]/.test(line))).toBe(true);
    const envText = lines.join("\n");
    expect(envText.split("\n").every((line) => ENV_KEY_LINE.test(line))).toBe(true);
    // No line may begin with the injected key name.
    expect(lines.filter((line) => line.startsWith("MALICIOUS="))).toHaveLength(0);
    // Legitimate values still emit.
    expect(lines).toContain("OPENAI_API_KEY=sk-realMALICIOUS=injected");
    expect(lines).toContain("HERMES_MODEL=gpt-5.4MALICIOUS=injected");
    expect(lines).toContain("TAVILY_API_KEY=tvMALICIOUS=injected");
    expect(lines).toContain("HONCHO_API_KEY=hMALICIOUS=injected");
  });
});

describe("SEC-04: WebUI env builders cannot inject extra assignments", () => {
  it("strips line breaks in buildHermesEnvFile values", () => {
    const envFile = buildHermesEnvFile({
      ...webuiBaseParams,
      llmApiKey: "sk-real\nMALICIOUS=injected",
      baseUrl: "https://crof.ai/v1\r\nMALICIOUS=injected",
      tavilyApiKey: "tv\0MALICIOUS=injected",
    });

    const lines = envFile.split("\n").filter(Boolean);
    expect(lines.every((line) => ENV_KEY_LINE.test(line))).toBe(true);
    expect(lines.filter((line) => line.startsWith("MALICIOUS="))).toHaveLength(0);
    expect(envFile).toContain("OPENAI_API_KEY=sk-realMALICIOUS=injected");
    expect(envFile).toContain(
      "OPENAI_BASE_URL=https://crof.ai/v1MALICIOUS=injected"
    );
  });

  it("strips a newline injection in the WebUI bot name and provider in the compose env", () => {
    const composeEnv = buildWebUIComposeEnv({
      ...webuiBaseParams,
      agentName: "helper\nMALICIOUS=injected",
      inferenceProvider: "custom\nMALICIOUS=injected",
    });

    const lines = composeEnv.split("\n").filter(Boolean);
    expect(lines.filter((line) => line.startsWith("MALICIOUS="))).toHaveLength(0);
    expect(composeEnv).toContain("HERMES_WEBUI_BOT_NAME=helperMALICIOUS=injected");
    expect(composeEnv).toContain("HERMES_INFERENCE_PROVIDER=customMALICIOUS=injected");
  });
});

describe("SEC-04: buildWebUIConfigYaml quotes scalars safely", () => {
  it("keeps byte-identical output for ordinary values", () => {
    const yamlText = buildWebUIConfigYaml(webuiBaseParams);
    expect(yamlText).toContain('default: "deepseek-v3.2"');
    expect(yamlText).toContain('provider: "custom"');
    expect(yamlText).toContain('base_url: "https://crof.ai/v1"');
    expect(yamlText).toContain('api_key: "provider-key"');
  });

  it("keeps a quote/newline injection inside the model scalar", () => {
    const yamlText = buildWebUIConfigYaml({
      ...webuiBaseParams,
      defaultModel: 'evil"\ninjected: true',
      baseUrl: 'https://crof.ai/v1"\ninjected: true',
      compressionModel: 'aux"\ninjected: true',
      compressionProvider: "anthropic",
    });

    // The hostile payloads stay inside JSON-escaped double-quoted scalars.
    expect(yamlText).toContain(`default: ${JSON.stringify('evil"injected: true')}`);
    expect(yamlText).toContain(`base_url: ${JSON.stringify('https://crof.ai/v1"injected: true')}`);
    expect(yamlText).toContain(`model: ${JSON.stringify('aux"injected: true')}`);
    // No unescaped injected key appears at any indentation.
    expect(yamlText).not.toMatch(/^injected:/m);
    expect(yamlText).not.toMatch(/^ {2}injected:/m);

    // And the emitted file still parses as YAML with the expected values.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped YAML fixture
    const parsed = loadYaml(yamlText) as Record<string, any>;
    expect(parsed.model.default).toBe('evil"injected: true');
    expect(parsed.model.base_url).toBe('https://crof.ai/v1"injected: true');
    expect(parsed.auxiliary.compression.model).toBe('aux"injected: true');
    expect(parsed.model.provider).toBe("custom");
    expect(parsed.injected).toBeUndefined();
  });
});

describe("SEC-04: legacy lane config.yaml quotes scalars safely", () => {
  it("quotes a hostile subagent key and custom base URL inside scalars", () => {
    const script = buildAgentDeployScript({
      instanceId: "inst_sec04_123",
      containerName: "agent-inst_sec04_123",
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
        subagentModel: "openrouter:deepseek-v3.2",
        subagentApiKey: 'key"\ninjected: true',
        customLlmBaseUrl: 'https://crof.ai/v1"\ninjected: true',
      },
      includeHostTimeSyncRepair: false,
      includeRegistryCredentialScrub: false,
    });

    const configYaml = extractEmbeddedFile(script, "config.yaml");
    expect(configYaml).not.toMatch(/^injected:/m);
    expect(configYaml).not.toMatch(/^ {2}injected:/m);
    expect(configYaml).toContain(JSON.stringify('key"injected: true'));
    expect(configYaml).toContain(JSON.stringify('https://crof.ai/v1"injected: true'));
  });
});

// Behavioral coverage for the sidecar's generated JS: the functions are
// extracted from SIDECAR_SERVER_CODE and executed in a vm sandbox so the test
// exercises the real emitted code, not a transcription of it.
function extractSidecarFunction(name: string): string {
  const match = SIDECAR_SERVER_CODE.match(
    new RegExp(`function ${name}\\([\\s\\S]+?\\n\\}`)
  );
  expect(match).not.toBeNull();
  return match![0];
}

describe("SEC-04: sidecar readRawBody caps request bodies at 10 MB", () => {
  function makeReq() {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      handlers,
      destroyed: false,
      on(event: string, cb: (...args: unknown[]) => void) {
        handlers[event] = cb;
        return this;
      },
      destroy() {
        this.destroyed = true;
        handlers.error?.(new Error("request aborted"));
      },
    };
  }

  function loadReadRawBody() {
    const ctx = createContext({
      Buffer,
      MAX_SIDECAR_BODY_BYTES: 10 * 1024 * 1024,
      createHttpError: (statusCode: number, message: string) =>
        Object.assign(new Error(message), { statusCode }),
    });
    return new Script(`(${extractSidecarFunction("readRawBody")})`).runInContext(ctx) as (
      req: ReturnType<typeof makeReq>
    ) => Promise<string>;
  }

  it("rejects and destroys the request when the body exceeds the cap", async () => {
    const readRawBody = loadReadRawBody();
    const req = makeReq();
    const bodyPromise = readRawBody(req as never);
    const sixMb = Buffer.alloc(6 * 1024 * 1024, "a");
    req.handlers.data?.(sixMb);
    req.handlers.data?.(sixMb); // 12 MB total > 10 MB cap
    await expect(bodyPromise).rejects.toMatchObject({
      statusCode: 413,
      message: "Payload too large",
    });
    expect(req.destroyed).toBe(true);
  });

  it("still resolves bodies under the cap", async () => {
    const readRawBody = loadReadRawBody();
    const req = makeReq();
    const bodyPromise = readRawBody(req as never);
    req.handlers.data?.(Buffer.from('{"envUpdates":["A=1"]}'));
    req.handlers.end?.();
    await expect(bodyPromise).resolves.toBe('{"envUpdates":["A=1"]}');
  });
});

describe("SEC-04: sidecar writeEnvFile only writes well-formed KEY=value lines", () => {
  function loadWriteEnvFile() {
    const ctx = createContext({
      fs: { existsSync, readFileSync, mkdirSync, writeFileSync },
      path: { dirname },
      makeWebUIWritable: () => {},
    });
    return new Script(`(${extractSidecarFunction("writeEnvFile")})`).runInContext(ctx) as (
      targetEnvFile: string,
      envUpdates: unknown,
      prefixToRemove?: string,
      keysToRemove?: string[]
    ) => void;
  }

  it("drops malformed updates and strips line breaks from values", () => {
    const writeEnvFile = loadWriteEnvFile();
    const dir = mkdtempSync(join(tmpdir(), "sec04-env-"));
    try {
      const target = join(dir, ".env");
      writeEnvFile(target, [
        "VALID_KEY=value",
        "TAVILY_API_KEY=abc\nMALICIOUS=injected",
        "not an env line",
        "=no-key",
        "9LEADING_DIGIT=1",
        "ALSO_VALID=",
        "CR_KEY=with\rcarriage",
      ]);

      const content = readFileSync(target, "utf8");
      const written = content.split("\n").filter(Boolean);
      expect(written).toContain("VALID_KEY=value");
      expect(written).toContain("ALSO_VALID=");
      expect(written).toContain("TAVILY_API_KEY=abcMALICIOUS=injected");
      expect(written).toContain("CR_KEY=withcarriage");
      expect(written).not.toContain("not an env line");
      expect(written).not.toContain("=no-key");
      expect(written).not.toContain("9LEADING_DIGIT=1");
      expect(written.every((line) => ENV_KEY_LINE.test(line))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the existing prefix/key removal contract", () => {
    const writeEnvFile = loadWriteEnvFile();
    const dir = mkdtempSync(join(tmpdir(), "sec04-env-"));
    try {
      const target = join(dir, ".env");
      writeFileSync(target, "OLD_PREFIX_A=1\nOLD_KEY=1\nKEEP_ME=1\n", "utf8");
      writeEnvFile(target, ["NEW_KEY=2"], "OLD_PREFIX_", ["OLD_KEY"]);

      const content = readFileSync(target, "utf8");
      expect(content).toContain("KEEP_ME=1");
      expect(content).toContain("NEW_KEY=2");
      expect(content).not.toContain("OLD_PREFIX_A");
      expect(content).not.toContain("OLD_KEY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SEC-04: emitted sidecar source contains the hardening", () => {
  it("caps readRawBody at MAX_SIDECAR_BODY_BYTES and rejects with 413", () => {
    expect(SIDECAR_SERVER_CODE).toContain("MAX_SIDECAR_BODY_BYTES = 10 * 1024 * 1024");
    expect(SIDECAR_SERVER_CODE).toContain("receivedBytes > MAX_SIDECAR_BODY_BYTES");
    expect(SIDECAR_SERVER_CODE).toContain("createHttpError(413, 'Payload too large')");
    expect(SIDECAR_SERVER_CODE).toContain("req.destroy()");
  });

  it("validates env update lines against the KEY= format before writing", () => {
    expect(SIDECAR_SERVER_CODE).toContain("/^[A-Za-z_][A-Za-z0-9_]*=/.test(update)");
    expect(SIDECAR_SERVER_CODE).toContain("replace(/[\\r\\n\\0]/g, '')");
  });
});
