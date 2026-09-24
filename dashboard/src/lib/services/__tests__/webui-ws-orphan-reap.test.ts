import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX,
  WEBUI_WS_ORPHAN_REAP_CONFIG_SYNC_PYTHON,
  WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS,
  WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS,
  buildWebUIWsOrphanReapRepairCommand,
} from "../webui-ws-orphan-reap";
import { TURN_MARKER_FRESH_SECONDS } from "../turn-marker-probe";
import { buildWebUIBootstrapScript, buildWebUIConfigYaml, buildWebUIProvisioningArtifacts } from "../webui-instance-builder";

const python = process.env.HERMES_CONFIG_TEST_PYTHON || "python3";

const baseParams = {
  instanceId: "inst-reap",
  containerName: "agent-inst-reap",
  fqdn: "localhost",
  cpuLimit: 1,
  ramLimit: 2048,
  llmApiKey: "fixture-llm-key",
  webuiPassword: "fixture-password",
  inferenceProvider: "custom",
  defaultModel: "fixture-model",
  agentImage: "ghcr.io/example/agent:stable",
};

describe("WS-orphan reap grace policy", () => {
  it("keeps a closed tab's turn alive past the one-hour approval wait and frees idle sessions before the 6 h TTL", () => {
    expect(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS).toBe(14400);
    expect(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS).toBeGreaterThan(3600);
    expect(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS).toBeLessThan(6 * 3600);
    // A marker must stay fresh for at least as long as the agent keeps a
    // detached turn running, or the update gate would stop protecting it early.
    expect(TURN_MARKER_FRESH_SECONDS).toBeGreaterThanOrEqual(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS);
    // Only the agent's stock default is replaceable today; never the pin itself.
    expect(WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS).toEqual([20]);
  });

  it("emits the pin in a freshly generated config.yaml (clean-slate boxes too)", () => {
    for (const unconfigured of [false, true]) {
      const yaml = buildWebUIConfigYaml({ ...baseParams, unconfigured });
      const parsed = spawnSync(
        python,
        ["-c", "import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())['dashboard']))"],
        { input: yaml, encoding: "utf8", timeout: 10_000 },
      );
      expect(parsed.stderr).toBe("");
      expect(JSON.parse(parsed.stdout)).toEqual({ ws_orphan_reap_grace_s: 14400 });
      expect(yaml.match(/^dashboard:/gm)).toHaveLength(1);
    }
  });
});

describe("WS-orphan reap grace repair on update", () => {
  let directory: string;
  let state: string;
  let seed: string;
  let backup: string;

  beforeAll(() => {
    const result = spawnSync(python, ["-c", "import yaml"], { encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0) {
      throw new Error(
        "Reap-grace config tests require Python 3 with PyYAML. " +
          "Install the CI-pinned PyYAML==6.0.3 in a test venv and set HERMES_CONFIG_TEST_PYTHON to its Python. " +
          (result.error?.message || result.stderr),
      );
    }
  });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hermes-reap-grace-test-"));
    state = join(directory, "state-config.yaml");
    seed = join(directory, "seed-config.yaml");
    backup = `${state}${WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX}`;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function repair(options: { withSeed?: boolean } = {}) {
    return spawnSync(
      python,
      [
        "-c",
        WEBUI_WS_ORPHAN_REAP_CONFIG_SYNC_PYTHON,
        String(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS),
        WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS.join(","),
        WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX,
        state,
        options.withSeed === false ? join(directory, "missing-seed.yaml") : seed,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  }

  function load(path: string) {
    const result = spawnSync(
      python,
      ["-c", "import json, sys, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]).read())))", path],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }

  const ownerConfig = [
    "# Owner comment survives",
    "model:",
    '  default: "fixture-model"',
    '  api_key: "sk-fixture-secret"',
    "approvals:",
    "  gateway_timeout: 3600",
    "",
  ].join("\n");

  it("adds the pin to a config without a dashboard section, keeping everything else byte-for-byte", () => {
    writeFileSync(state, ownerConfig, { mode: 0o640 });
    writeFileSync(seed, ownerConfig, { mode: 0o600 });

    const result = repair();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("set_from_missing");
    const repaired = readFileSync(state, "utf8");
    expect(repaired.startsWith(ownerConfig)).toBe(true);
    expect(repaired.slice(ownerConfig.length)).toBe("dashboard:\n  ws_orphan_reap_grace_s: 14400\n");
    expect(load(state).dashboard).toEqual({ ws_orphan_reap_grace_s: 14400 });
    expect(load(seed).dashboard).toEqual({ ws_orphan_reap_grace_s: 14400 });
    // Mode preserved: the file holds the model API key.
    expect(statSync(state).mode & 0o777).toBe(0o640);
    // One backup of the pre-repair state file, holding the original bytes.
    expect(readFileSync(backup, "utf8")).toBe(ownerConfig);
    expect(statSync(backup).mode & 0o777).toBe(0o640);
  });

  it("is idempotent: a second update changes nothing and keeps the first backup", () => {
    writeFileSync(state, ownerConfig);
    writeFileSync(seed, ownerConfig);
    expect(repair().status).toBe(0);
    const once = readFileSync(state, "utf8");
    const firstBackup = readFileSync(backup, "utf8");

    const again = repair();

    expect(again.status).toBe(0);
    expect(again.stdout).toContain("pinned");
    expect(readFileSync(state, "utf8")).toBe(once);
    expect(readFileSync(backup, "utf8")).toBe(firstBackup);
  });

  it("inserts the key into an existing dashboard section without touching its other keys", () => {
    const source = "dashboard:\n  ws_ping_interval: 20.0\n  trusted_proxies: []\nmodel:\n  default: x\n";
    writeFileSync(state, source);
    writeFileSync(seed, source);

    expect(repair().status).toBe(0);

    expect(load(state)).toEqual({
      dashboard: { ws_orphan_reap_grace_s: 14400, ws_ping_interval: 20.0, trusted_proxies: [] },
      model: { default: "x" },
    });
  });

  it.each([
    ["the stock default as an int", "dashboard:\n  ws_orphan_reap_grace_s: 20\n"],
    ["the stock default as a float", "dashboard:\n  ws_orphan_reap_grace_s: 20.0\n"],
    ["an empty (null) value", "dashboard:\n  ws_orphan_reap_grace_s:\n  other: 1\n"],
    ["a null section", "dashboard:\nmodel: {default: x}\n"],
    ["a flow-style section", "dashboard: {other: 1}\n"],
  ])("moves %s to the pin", (_label, source) => {
    writeFileSync(state, source);
    writeFileSync(seed, source);

    const result = repair();

    expect(result.status).toBe(0);
    expect(load(state).dashboard.ws_orphan_reap_grace_s).toBe(14400);
    expect(load(seed).dashboard.ws_orphan_reap_grace_s).toBe(14400);
  });

  it.each([
    ["a shorter owner value", "600"],
    ["park forever (0)", "0"],
    ["a longer owner value", "86400"],
  ])("keeps %s: an explicit key the agent saved is the owner's choice", (_label, value) => {
    const source = `dashboard:\n  ws_orphan_reap_grace_s: ${value}\n`;
    writeFileSync(state, source);
    writeFileSync(seed, source);

    const result = repair();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("owner");
    expect(readFileSync(state, "utf8")).toBe(source);
    expect(existsSync(backup)).toBe(false);
  });

  it("repairs the state file even when the instance-dir copy is absent", () => {
    writeFileSync(state, ownerConfig);

    const result = repair({ withSeed: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("absent");
    expect(load(state).dashboard.ws_orphan_reap_grace_s).toBe(14400);
  });

  it.each([
    ["unparseable YAML", "model: [unclosed\napi_key: sk-fixture-secret\n"],
    ["an aliased dashboard section", "x: &a\n  k: 1\ndashboard: *a\n"],
    ["duplicate dashboard sections", "dashboard: {a: 1}\ndashboard: {b: 2}\n"],
    ["a non-mapping dashboard", "dashboard: 5\n"],
  ])("leaves %s untouched, fails without echoing the file", (_label, source) => {
    writeFileSync(state, source);
    writeFileSync(seed, source);

    const result = repair();

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("sk-fixture-secret");
    expect(readFileSync(state, "utf8")).toBe(source);
    expect(existsSync(backup)).toBe(false);
  });

  it("refuses to replace a symlinked config", () => {
    writeFileSync(seed, ownerConfig);
    const target = join(directory, "elsewhere.yaml");
    writeFileSync(target, ownerConfig);
    spawnSync("ln", ["-s", target, state]);

    const result = repair();

    expect(result.status).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(ownerConfig);
  });

  it("leaves a fresh provision's generated config as it is", () => {
    const generated = buildWebUIConfigYaml(baseParams);
    writeFileSync(state, generated);
    writeFileSync(seed, generated);

    const result = repair();

    expect(result.status).toBe(0);
    expect(readFileSync(state, "utf8")).toBe(generated);
    expect(existsSync(backup)).toBe(false);
  });

  it("builds a shell step that never fails the update and parses in bash", () => {
    const command = buildWebUIWsOrphanReapRepairCommand({
      containerName: "agent-inst-reap",
      agentImage: "ghcr.io/example/agent:stable",
    });
    expect(command).toContain("-v agent-inst-reap_webui-state:/state");
    expect(command).toContain(
      `ghcr.io/example/agent:stable - 14400 '20' '${WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX}' /state/config.yaml /seed/config.yaml <<'HERMES_WS_ORPHAN_REAP_PY' || echo`,
    );
    const syntax = spawnSync("bash", ["-n"], { input: `set -euo pipefail\n${command}`, encoding: "utf8" });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);

    // A failing docker run must not abort the update script (set -e).
    const fakeBin = join(directory, "bin");
    spawnSync("mkdir", ["-p", fakeBin]);
    writeFileSync(join(fakeBin, "docker"), "#!/bin/sh\ncat >/dev/null\nexit 1\n");
    chmodSync(join(fakeBin, "docker"), 0o755);
    const run = spawnSync("bash", ["-c", `set -euo pipefail\nINSTANCE_DIR=/tmp\n${command}echo UPDATE_CONTINUES`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("UPDATE_CONTINUES");
    expect(run.stderr).toContain("could not pin dashboard.ws_orphan_reap_grace_s");
  });
});

describe("WS-orphan reap grace in the bootstrap script", () => {
  const params = { ...baseParams, containerName: "agent-inst-reap" };

  it("repairs persisted config on update, after the agent image pull and before compose recreates the dashboard", () => {
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(params), params, { mode: "update" });
    const pullIdx = script.indexOf(`docker pull ${params.agentImage}`);
    const repairIdx = script.indexOf("<<'HERMES_WS_ORPHAN_REAP_PY'");
    const composeUpIdx = script.indexOf("docker compose up -d");
    expect(pullIdx).toBeGreaterThan(-1);
    expect(repairIdx).toBeGreaterThan(pullIdx);
    expect(composeUpIdx).toBeGreaterThan(repairIdx);
  });

  it("strips a disconnected wallet's bankr: block from the repair's backup too (it copies config.yaml)", () => {
    const disconnect = {
      ...params,
      bankrRuntimeReconcile: {
        action: "clear_user_disconnected" as const,
        walletAddresses: [`0x${"1".repeat(40)}`],
      },
    };
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(disconnect), disconnect, {
      mode: "update",
    });
    expect(script).toContain(
      `for bankr_cfg in /state/config.yaml /state/profiles/*/config.yaml /state/config.yaml.pre-managed-venice-repair.* /state/config.yaml${WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX}; do`,
    );
  });

  it("does not run the repair on a fresh provision (the generated config already carries the pin)", () => {
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(params), params, { mode: "provision" });
    expect(script).not.toContain("HERMES_WS_ORPHAN_REAP_PY");
    expect(script).toContain("ws_orphan_reap_grace_s: 14400");
  });
});
