import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebUITerminalBackend, WEBUI_TERMINAL_CONFIG_SYNC_PYTHON } from "../webui-terminal-config";
import { buildWebUICompose } from "../webui-instance-builder";

const python = process.env.HERMES_CONFIG_TEST_PYTHON || "python3";

describe("saved terminal backend convergence", () => {
  let directory: string;
  let state: string;
  let seed: string;

  beforeAll(() => {
    const result = spawnSync(python, ["-c", "import yaml"], { encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0) {
      throw new Error(
        "Terminal config behavioral tests require Python 3 with PyYAML. " +
        "Install the CI-pinned PyYAML==6.0.3 in a test venv and set HERMES_CONFIG_TEST_PYTHON to its Python. " +
        (result.error?.message || result.stderr),
      );
    }
  });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hermes-terminal-config-test-"));
    state = join(directory, "state-config.yaml");
    seed = join(directory, "seed-config.yaml");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function sync(source: string, backend: string, oldSeed = "model: seed-copy\n") {
    writeFileSync(state, source, { mode: 0o640 });
    writeFileSync(seed, oldSeed, { mode: 0o600 });
    return spawnSync(python, ["-c", WEBUI_TERMINAL_CONFIG_SYNC_PYTHON, backend, state, seed], {
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  it.each([false, true])("parses the complete generated Compose YAML with Docker access %s", (gatewayDockerAccess) => {
    const compose = buildWebUICompose({
      instanceId: "test-instance",
      containerName: "agent-test-instance",
      fqdn: "agent.example.com",
      cpuLimit: 2,
      ramLimit: 4096,
      llmApiKey: "fixture-key",
      webuiPassword: "fixture-password",
      inferenceProvider: "custom",
      defaultModel: "model",
      image: "webui:test",
      agentImage: "agent:test",
      gatewayDockerAccess,
    });
    // A single-escaped Python b"\\0" in a TS template becomes a literal NUL
    // and invalidates the whole deployment YAML before any service can start.
    expect(compose).not.toContain("\u0000");
    const result = spawnSync(python, ["-c", [
      "import ast, json, sys, yaml",
      "config = yaml.safe_load(sys.stdin.read())",
      "gateway_command = config['services']['gateway']['command'][-1]",
      "supervisor = gateway_command.split(\"<<'PY'\\n\", 1)[1].rsplit('\\nPY', 1)[0]",
      "ast.parse(supervisor, filename='generated-gateway-supervisor.py')",
      "service = config['services']['official-dashboard']",
      "print(json.dumps({key: service[key] for key in ('entrypoint', 'command', 'depends_on')}))",
    ].join("\n")], { input: compose, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const service = JSON.parse(result.stdout);
    expect(service.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(service.command).toHaveLength(1);
    expect(service.command[0]).toContain("dashboard_gateway_attempt=$$((dashboard_gateway_attempt + 1))");
    expect(service.command[0]).toContain("exec /opt/hermes/.venv/bin/hermes dashboard");
    expect(service.depends_on).toEqual(["gateway"]);
  });

  it("repairs the actual saved local override without changing the customer's image, credentials, comments or options", () => {
    const source = [
      "# Customer-owned configuration — retain formatting",
      "terminal:",
      "  backend: local # chosen from cloud settings",
      "  docker_image: kalilinux/kali-rolling",
      "  timeout: 180",
      "  docker_volumes: ['/data:/data:ro']",
      "model:",
      "  api_key: 'fixture-secret-must-survive'",
      "  base_url: https://custom.example/v1",
      "custom_prompt: |",
      "  Keep my own instructions.",
      "",
    ].join("\n");
    const result = sync(source, "docker");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const expected = source.replace("backend: local", 'backend: "docker"');
    expect(readFileSync(state, "utf8")).toBe(expected);
    expect(readFileSync(seed, "utf8")).toBe(expected);
    expect(statSync(state).mode & 0o777).toBe(0o640);
    expect(statSync(seed).mode & 0o777).toBe(0o600);
    expect(result.stdout).not.toContain("fixture-secret");
  });

  it("honors an explicit switch back to local without discarding the custom Docker settings", () => {
    const source = "terminal:\n  backend: docker\n  docker_image: kalilinux/kali-rolling\n";
    expect(sync(source, "local").status).toBe(0);
    expect(readFileSync(state, "utf8")).toBe(source.replace("backend: docker", 'backend: "local"'));
  });

  it.each(["local", "docker", "modal", "daytona"])("is byte-for-byte idempotent for an already selected %s backend", (backend) => {
    const source = `# Preserve quotes too\nterminal:\n  backend: '${backend}' # unchanged\n  docker_image: custom:v2\n`;
    expect(sync(source, backend, source).status).toBe(0);
    expect(readFileSync(state, "utf8")).toBe(source);
    expect(readFileSync(seed, "utf8")).toBe(source);
  });

  it.each([
    ["missing section", "model: custom\n", "model: custom\nterminal:\n  backend: docker\n"],
    ["missing backend", "terminal:\n  docker_image: custom:v2\n", 'terminal:\n  backend: "docker"\n  docker_image: custom:v2\n'],
    ["null section", "terminal:\nmodel: custom\n", 'terminal: {backend: "docker"}\nmodel: custom\n'],
    ["explicit null", "terminal: null # retain\n", 'terminal: {backend: "docker"} # retain\n'],
    ["empty inline section", "terminal: {}\n", 'terminal: {backend: "docker"}\n'],
    ["inline section", "terminal: {docker_image: custom:v2}\n", 'terminal: {docker_image: custom:v2, backend: "docker"}\n'],
    ["empty inline root", "{}\n", "{terminal: {backend: docker}}\n"],
    ["inline root", "{model: custom}\n", "{model: custom, terminal: {backend: docker}}\n"],
    ["empty file", "", "terminal:\n  backend: docker\n"],
    ["comment-only file", "# keep\n", "# keep\nterminal:\n  backend: docker\n"],
    ["explicit document end", "---\nmodel: custom\n...\n", "---\nmodel: custom\nterminal:\n  backend: docker\n...\n"],
    ["CRLF", "terminal:\r\n  backend: local\r\n  docker_image: custom:v2\r\n", 'terminal:\r\n  backend: "docker"\r\n  docker_image: custom:v2\r\n'],
  ])("adds or updates only terminal.backend for %s", (_name, source, expected) => {
    const result = sync(source, "docker");
    expect(result.status).toBe(0);
    expect(readFileSync(state, "utf8")).toBe(expected);
    expect(readFileSync(seed, "utf8")).toBe(expected);
  });

  it.each([
    ["scalar document", "not-a-config\n"],
    ["malformed YAML", "terminal: [invalid\n"],
    ["scalar terminal section", "terminal: invalid\n"],
    ["duplicate sections", "terminal: {backend: local}\nterminal: {backend: modal}\n"],
    ["duplicate backends", "terminal:\n  backend: local\n  backend: modal\n"],
    ["aliased terminal section", "defaults: &defaults {backend: local}\nterminal: *defaults\n"],
    ["aliased backend", "default_backend: &backend local\nterminal:\n  backend: *backend\n"],
    ["anchor shared elsewhere", "terminal: &terminal {backend: local}\nother: *terminal\n"],
    ["multiple documents", "terminal: {backend: local}\n---\nmodel: other\n"],
  ])("fails closed without changing either file for %s", (_name, source) => {
    const oldSeed = "model: untouched-seed\n";
    const result = sync(source, "docker", oldSeed);
    expect(result.status).not.toBe(0);
    expect(readFileSync(state, "utf8")).toBe(source);
    expect(readFileSync(seed, "utf8")).toBe(oldSeed);
  });

  it("rejects unknown backend values without executing or writing them", () => {
    const source = "terminal: {backend: local}\n";
    expect(sync(source, "docker; echo unsafe").status).not.toBe(0);
    expect(readFileSync(state, "utf8")).toBe(source);
  });

  it("does not leak customer config lines when malformed YAML fails parsing", () => {
    const source = "terminal: [fixture-secret-must-not-be-logged\n";
    const result = sync(source, "docker");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot parse saved YAML");
    expect(result.stderr).not.toContain("fixture-secret");
    expect(readFileSync(state, "utf8")).toBe(source);
  });

  it("does not replace a customer's symlinked config", () => {
    const target = join(directory, "customer-config.yaml");
    const source = "terminal: {backend: local}\n";
    writeFileSync(target, source);
    writeFileSync(seed, source);
    symlinkSync(target, state);
    const result = spawnSync(python, ["-c", WEBUI_TERMINAL_CONFIG_SYNC_PYTHON, "docker", state, seed], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe(source);
    expect(readFileSync(seed, "utf8")).toBe(source);
  });

  it("retains restrictive owner file permissions", () => {
    const source = "terminal: {backend: local}\n";
    writeFileSync(state, source);
    writeFileSync(seed, source);
    chmodSync(state, 0o600);
    const before = statSync(state);
    const result = spawnSync(python, ["-c", WEBUI_TERMINAL_CONFIG_SYNC_PYTHON, "docker", state, seed], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const after = statSync(state);
    expect(after.mode & 0o777).toBe(0o600);
    expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
  });
});

describe("effective terminal backend", () => {
  it("never upgrades an explicit local choice when Docker access is enabled", () => {
    expect(resolveWebUITerminalBackend({ terminalBackend: "local", gatewayDockerAccess: true })).toBe("local");
  });

  it("uses the same access/key requirements as runtime environment generation", () => {
    expect(resolveWebUITerminalBackend({ terminalBackend: "docker" })).toBe("local");
    expect(resolveWebUITerminalBackend({ terminalBackend: "docker", gatewayDockerAccess: true })).toBe("docker");
    expect(resolveWebUITerminalBackend({ terminalBackend: "daytona", daytonaApiKey: "   " })).toBe("local");
    expect(resolveWebUITerminalBackend({ terminalBackend: "daytona", daytonaApiKey: "key" })).toBe("daytona");
    expect(resolveWebUITerminalBackend({ terminalBackend: "modal" })).toBe("modal");
  });
});
