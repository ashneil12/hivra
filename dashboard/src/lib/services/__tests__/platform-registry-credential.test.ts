import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import {
  buildAgentDeployScript,
  renderCompressedProvisioningUserData,
  renderHostUserData,
  resolveGatewayConfiguration,
} from "@/lib/services/hetzner-instance-builders";
import {
  buildWebUIBootstrapScript,
  buildWebUIProvisioningArtifacts,
  type WebUIDeployParams,
} from "@/lib/services/webui-instance-builder";
import { buildPlatformRegistryCredentialScrubScript } from "@/lib/services/registry-credential-scrub";

// Every image a Hermes-lane box pulls (ghcr.io/ashneil12/vanilla-hermes-agent,
// hermes-webui, operatoros-agent, hermes-browser-sidecar and their -canary
// twins) is public, so no box needs a registry credential. The platform
// GHCR_TOKEN must never reach a tenant box: not in cloud-init user_data, not in
// the script piped over SSH, and not in root's Docker config afterwards.
const SENTINEL_TOKEN = `ghp_${"S".repeat(36)}`;

type BuildAgentDeployScriptParams = Parameters<typeof buildAgentDeployScript>[0];

function withGhcrTokenEnv(run: () => void): void {
  const previous = process.env.GHCR_TOKEN;
  process.env.GHCR_TOKEN = SENTINEL_TOKEN;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.GHCR_TOKEN;
    } else {
      process.env.GHCR_TOKEN = previous;
    }
  }
}

const webUIParams: WebUIDeployParams = {
  instanceId: "inst-registry-1",
  containerName: "agent-inst-registry-1",
  fqdn: "agent.example.com",
  cpuLimit: 2,
  ramLimit: 4096,
  llmApiKey: "provider-key",
  inferenceProvider: "custom",
  defaultModel: "deepseek-v3.2",
  baseUrl: "https://llm.example.com/v1",
  webuiPassword: "webui-password",
};

function gatewayParams(): BuildAgentDeployScriptParams {
  const { fqdn } = resolveGatewayConfiguration({
    subdomain: "7c80cbe05e19d9bf24c5",
    ipv4: "203.0.113.4",
  });
  return {
    instanceId: "inst_registry_2",
    containerName: "agent-inst_registry_2",
    apiServerKey: "x".repeat(64),
    provider: "openrouter",
    apiKey: "sk-test",
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
  };
}

function expectNoPlatformRegistryLogin(script: string): void {
  expect(script).not.toContain(SENTINEL_TOKEN);
  expect(script).not.toMatch(/docker\s+login/);
  expect(script).not.toContain("GHCR_TOKEN");
}

describe("platform registry credential never reaches a tenant box", () => {
  it.each(["provision", "update"] as const)(
    "WebUI/webfree bootstrap (%s) carries no GHCR token and runs no docker login",
    (mode) => {
      withGhcrTokenEnv(() => {
        const artifacts = buildWebUIProvisioningArtifacts(webUIParams);
        const script = buildWebUIBootstrapScript(
          artifacts,
          { ...webUIParams, gatewayDockerAccess: true },
          { mode }
        );
        expectNoPlatformRegistryLogin(script);
      });
    }
  );

  it("WebUI bootstrap delivered as Hetzner user_data carries no GHCR token", () => {
    withGhcrTokenEnv(() => {
      const artifacts = buildWebUIProvisioningArtifacts(webUIParams);
      const script = buildWebUIBootstrapScript(artifacts, webUIParams, { mode: "provision" });
      const userData = renderCompressedProvisioningUserData(renderHostUserData(), script);
      // user_data embeds the whole script gzip+base64, so check the decoded
      // payload a Hetzner metadata read would return, not only the outer text.
      const encoded = userData.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| gunzip \| bash/)?.[1];
      expect(encoded).toBeTruthy();
      const decoded = gunzipSync(Buffer.from(encoded!, "base64")).toString("utf8");
      expect(decoded).toContain("/opt/hermes/instances/inst-registry-1");
      expectNoPlatformRegistryLogin(decoded);
    });
  });

  it("legacy gateway deploy script ignores a GHCR token from env or a stale caller", () => {
    withGhcrTokenEnv(() => {
      // A caller built against the old params shape may still hand a token in;
      // the builder must not render it.
      const staleParams = {
        ...gatewayParams(),
        ghcrToken: SENTINEL_TOKEN,
      } as BuildAgentDeployScriptParams;
      const script = buildAgentDeployScript(staleParams);
      expectNoPlatformRegistryLogin(script);
    });
  });

  it.each([
    [
      "WebUI provision",
      () =>
        buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(webUIParams), webUIParams, {
          mode: "provision",
        }),
    ],
    [
      "WebUI update",
      () =>
        buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(webUIParams), webUIParams, {
          mode: "update",
        }),
    ],
    ["legacy gateway", () => buildAgentDeployScript(gatewayParams())],
  ])("%s script logs out of ghcr.io so a credential older bootstraps left is removed", (_label, build) => {
    const script = build();
    expect(script).toContain("docker logout ghcr.io");
    expect(script).toContain(buildPlatformRegistryCredentialScrubScript());
  });
});

it("fresh-server gateway user_data skips the scrub (no earlier script ran there)", () => {
  const script = buildAgentDeployScript({
    ...gatewayParams(),
    includeHostTimeSyncRepair: false,
    includeRegistryCredentialScrub: false,
  });
  expect(script).not.toContain("docker logout");
  expectNoPlatformRegistryLogin(script);
});

// What older bootstraps left behind: `docker login ghcr.io -u __token__` as
// root writes the token base64-encoded into root's Docker config.
const PLATFORM_AUTH = Buffer.from(`__token__:${SENTINEL_TOKEN}`).toString("base64");
const OWNER_AUTH = Buffer.from("owner:owner-docker-hub-password").toString("base64");

function dockerConfigJson(auths: Record<string, string>): string {
  const entries = Object.entries(auths)
    .map(([host, auth]) => `\t\t"${host}": {\n\t\t\t"auth": "${auth}"\n\t\t}`)
    .join(",\n");
  return `{\n\t"auths": {\n${entries}\n\t}\n}`;
}

interface ScrubRun {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerCalls: string;
}

function runScrub(
  sandbox: string,
  opts: { docker: "failing" | "real"; env?: Record<string, string | undefined> }
): ScrubRun {
  const binDir = join(sandbox, "bin");
  mkdirSync(binDir, { recursive: true });
  const callLog = join(sandbox, "docker-calls.log");
  const pathParts = [binDir, "/usr/bin", "/bin"];
  if (opts.docker === "failing") {
    // Shadows any real docker on PATH: every call fails, as it would if the
    // CLI were missing or broken on the box.
    writeFileSync(join(binDir, "docker"), `#!/bin/sh\necho "$*" >> "${callLog}"\nexit 1\n`);
    chmodSync(join(binDir, "docker"), 0o755);
  } else {
    const real = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    pathParts.unshift(join(real, ".."));
  }
  const scriptPath = join(sandbox, "scrub.sh");
  // Same shell options as the real bootstraps; the scrub must never abort them.
  writeFileSync(
    scriptPath,
    `set -euo pipefail\n${buildPlatformRegistryCredentialScrubScript()}\necho SCRIPT_CONTINUED\n`
  );
  const env: Record<string, string> = { PATH: pathParts.join(":") };
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  const res = spawnSync("bash", [scriptPath], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    dockerCalls: existsSync(callLog) ? readFileSync(callLog, "utf8") : "",
  };
}

const hasRealDocker =
  spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).status === 0;

describe("registry credential scrub on an existing box", () => {
  let sandbox: string;
  let home: string;
  let configPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "hivra-registry-scrub-"));
    home = join(sandbox, "home");
    mkdirSync(join(home, ".docker"), { recursive: true });
    configPath = join(home, ".docker", "config.json");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("deletes the Docker config when the stored ghcr.io login cannot be logged out", () => {
    writeFileSync(
      configPath,
      dockerConfigJson({ "ghcr.io": PLATFORM_AUTH, "https://index.docker.io/v1/": OWNER_AUTH })
    );

    const res = runScrub(sandbox, { docker: "failing", env: { HOME: home } });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("SCRIPT_CONTINUED");
    expect(res.dockerCalls).toContain("logout ghcr.io");
    expect(existsSync(configPath)).toBe(false);
  });

  it("finds a login stored under DOCKER_CONFIG", () => {
    const dockerConfigDir = join(sandbox, "custom-docker");
    mkdirSync(dockerConfigDir);
    const customConfig = join(dockerConfigDir, "config.json");
    writeFileSync(customConfig, dockerConfigJson({ "ghcr.io": PLATFORM_AUTH }));

    const res = runScrub(sandbox, {
      docker: "failing",
      env: { HOME: home, DOCKER_CONFIG: dockerConfigDir },
    });

    expect(res.status).toBe(0);
    expect(existsSync(customConfig)).toBe(false);
  });

  it("leaves a config without a ghcr.io login alone and does not call docker", () => {
    const ownerOnly = dockerConfigJson({ "https://index.docker.io/v1/": OWNER_AUTH });
    writeFileSync(configPath, ownerOnly);

    const res = runScrub(sandbox, { docker: "failing", env: { HOME: home } });

    expect(res.status).toBe(0);
    expect(res.dockerCalls).toBe("");
    expect(readFileSync(configPath, "utf8")).toBe(ownerOnly);
  });

  it("is a no-op that keeps the script running when there is no Docker config or no HOME", () => {
    rmSync(join(home, ".docker"), { recursive: true, force: true });

    const withHome = runScrub(sandbox, { docker: "failing", env: { HOME: home } });
    const withoutHome = runScrub(sandbox, { docker: "failing", env: { HOME: undefined } });

    for (const res of [withHome, withoutHome]) {
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SCRIPT_CONTINUED");
      expect(res.stderr).toBe("");
      expect(res.dockerCalls).toBe("");
    }
  });

  (hasRealDocker ? describe : describe.skip)("with the real Docker CLI", () => {
    it("logs out of ghcr.io and keeps the owner's other registry login", () => {
      writeFileSync(
        configPath,
        dockerConfigJson({ "ghcr.io": PLATFORM_AUTH, "https://index.docker.io/v1/": OWNER_AUTH })
      );

      const res = runScrub(sandbox, { docker: "real", env: { HOME: home } });

      expect(res.status).toBe(0);
      const remaining = readFileSync(configPath, "utf8");
      expect(remaining).not.toContain(PLATFORM_AUTH);
      expect(remaining).not.toContain("ghcr.io");
      expect(remaining).toContain(OWNER_AUTH);
    });

    it("removes the config file when the ghcr.io login was the only one", () => {
      writeFileSync(configPath, dockerConfigJson({ "ghcr.io": PLATFORM_AUTH }));

      const res = runScrub(sandbox, { docker: "real", env: { HOME: home } });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("removed the stored ghcr.io login");
      expect(existsSync(configPath)).toBe(false);
    });
  });
});
