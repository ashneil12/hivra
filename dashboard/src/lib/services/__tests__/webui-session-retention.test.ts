import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WEBUI_MAX_LIVE_SESSIONS_LARGE,
  WEBUI_MAX_LIVE_SESSIONS_SMALL,
  WEBUI_MAX_LIVE_SESSIONS_STOCK,
  WEBUI_SESSION_RETENTION_BACKUP_SUFFIX,
  WEBUI_SESSION_RETENTION_CONFIG_SYNC_PYTHON,
  WEBUI_SESSION_RETENTION_RECORD_ENV,
  WEBUI_SESSION_RETENTION_RECORD_SUFFIX,
  WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS,
  WEBUI_WS_ORPHAN_REAP_STOCK_SECONDS,
  buildWebUISessionRetentionConfigYaml,
  buildWebUISessionRetentionRecordJson,
  buildWebUISessionRetentionRepairCommand,
  webuiMaxLiveSessionsForRamMb,
  webuiSessionRetentionPins,
} from "../webui-session-retention";
import { TURN_MARKER_FRESH_SECONDS } from "../agent-activity-probe";
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

function parseYaml(source: string) {
  const parsed = spawnSync(python, ["-c", "import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"], {
    input: source,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(parsed.stderr).toBe("");
  return JSON.parse(parsed.stdout);
}

describe("web-chat session retention policy", () => {
  it("keeps a closed tab's turn alive past the one-hour approval wait and frees idle sessions before the 6 h TTL", () => {
    expect(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS).toBe(14400);
    expect(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS).toBeGreaterThan(3600);
    expect(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS).toBeLessThan(6 * 3600);
    // A marker must stay fresh for at least as long as the agent keeps a
    // detached turn running, or the update gate would stop protecting it early.
    expect(TURN_MARKER_FRESH_SECONDS).toBeGreaterThanOrEqual(WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS);
    // Only the agent's stock default (what an unset key means) counts as unset;
    // never the pin itself.
    expect(WEBUI_WS_ORPHAN_REAP_STOCK_SECONDS).toEqual([20]);
  });

  it("sizes the live-session cap to the computer's memory tier", () => {
    expect(webuiMaxLiveSessionsForRamMb(1024)).toBe(4);
    expect(webuiMaxLiveSessionsForRamMb(2048)).toBe(4);
    expect(webuiMaxLiveSessionsForRamMb(4096)).toBe(8);
    expect(webuiMaxLiveSessionsForRamMb(16384)).toBe(8);
    // Unknown tier: the small cap (an eviction only costs a reload).
    expect(webuiMaxLiveSessionsForRamMb(undefined)).toBe(4);
    expect(webuiMaxLiveSessionsForRamMb(0)).toBe(4);
    // Only the agent's DEFAULT_CONFIG value (which old default dumps wrote) is
    // replaceable without a record. Hivra's tier values follow a resize through
    // the record, so an owner's identical 4 or 8 is never taken; "off" (0) is
    // always the owner's.
    expect(WEBUI_MAX_LIVE_SESSIONS_STOCK).toEqual([16]);
    expect(WEBUI_MAX_LIVE_SESSIONS_STOCK).not.toContain(WEBUI_MAX_LIVE_SESSIONS_SMALL);
    expect(WEBUI_MAX_LIVE_SESSIONS_STOCK).not.toContain(WEBUI_MAX_LIVE_SESSIONS_LARGE);
    expect(WEBUI_MAX_LIVE_SESSIONS_STOCK).not.toContain(0);
  });

  it("words the owner-visible config comments without 'runtime' or 'box'", () => {
    for (const ramMb of [2048, 8192]) {
      expect(buildWebUISessionRetentionConfigYaml(ramMb)).not.toMatch(/\bruntime\b|\bbox\b/i);
    }
  });

  it.each([
    [2048, 4],
    [4096, 8],
    [undefined, 4],
  ])("emits both settings in a freshly generated config.yaml (%s MB -> cap %i), clean-slate boxes too", (ramLimit, cap) => {
    for (const unconfigured of [false, true]) {
      const yaml = buildWebUIConfigYaml({ ...baseParams, ramLimit, unconfigured });
      const config = parseYaml(yaml);
      expect(config.dashboard).toEqual({ ws_orphan_reap_grace_s: 14400 });
      // Top level: the key the fork's _max_live_sessions() reads.
      expect(config.max_live_sessions).toBe(cap);
      expect(yaml.match(/^dashboard:/gm)).toHaveLength(1);
      expect(yaml.match(/^max_live_sessions:/gm)).toHaveLength(1);
    }
  });
});

describe("web-chat session retention repair on update", () => {
  let directory: string;
  let state: string;
  let seed: string;
  let backup: string;
  let record: string;

  beforeAll(() => {
    const result = spawnSync(python, ["-c", "import yaml"], { encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0) {
      throw new Error(
        "Session-retention config tests require Python 3 with PyYAML. " +
          "Install the CI-pinned PyYAML==6.0.3 in a test venv and set HERMES_CONFIG_TEST_PYTHON to its Python. " +
          (result.error?.message || result.stderr),
      );
    }
  });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hermes-session-retention-test-"));
    state = join(directory, "state-config.yaml");
    seed = join(directory, "seed-config.yaml");
    backup = `${state}${WEBUI_SESSION_RETENTION_BACKUP_SUFFIX}`;
    record = `${state}${WEBUI_SESSION_RETENTION_RECORD_SUFFIX}`;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function repair(options: { withSeed?: boolean; ramMb?: number } = {}) {
    return spawnSync(
      python,
      [
        "-c",
        WEBUI_SESSION_RETENTION_CONFIG_SYNC_PYTHON,
        JSON.stringify(webuiSessionRetentionPins(options.ramMb ?? 2048)),
        WEBUI_SESSION_RETENTION_BACKUP_SUFFIX,
        WEBUI_SESSION_RETENTION_RECORD_SUFFIX,
        state,
        options.withSeed === false ? join(directory, "missing-seed.yaml") : seed,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  }

  function load(path: string) {
    return parseYaml(readFileSync(path, "utf8"));
  }

  function both(source: string) {
    writeFileSync(state, source);
    writeFileSync(seed, source);
  }

  /** What a fresh provision (or an earlier repair) records Hivra wrote. */
  function hivraWrote(written: Record<string, number[]>) {
    writeFileSync(record, `${JSON.stringify({ version: 1, written })}\n`);
  }

  function recorded() {
    return JSON.parse(readFileSync(record, "utf8")).written;
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

  it("adds both settings to a config without them, keeping everything else byte-for-byte", () => {
    writeFileSync(state, ownerConfig, { mode: 0o640 });
    writeFileSync(seed, ownerConfig, { mode: 0o600 });

    const result = repair();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dashboard.ws_orphan_reap_grace_s set_from_missing (pin 14400)");
    expect(result.stdout).toContain("max_live_sessions set_from_missing (pin 4)");
    const repaired = readFileSync(state, "utf8");
    expect(repaired.startsWith(ownerConfig)).toBe(true);
    expect(repaired.slice(ownerConfig.length)).toBe(
      "dashboard:\n  ws_orphan_reap_grace_s: 14400\nmax_live_sessions: 4\n",
    );
    expect(load(state)).toMatchObject({ dashboard: { ws_orphan_reap_grace_s: 14400 }, max_live_sessions: 4 });
    expect(load(seed)).toMatchObject({ dashboard: { ws_orphan_reap_grace_s: 14400 }, max_live_sessions: 4 });
    // Mode preserved: the file holds the model API key.
    expect(statSync(state).mode & 0o777).toBe(0o640);
    // One backup of the pre-repair state file, holding the original bytes.
    expect(readFileSync(backup, "utf8")).toBe(ownerConfig);
    expect(statSync(backup).mode & 0o777).toBe(0o640);
    // Recorded as Hivra's, so a later update may move them (a resize, a new pin).
    expect(recorded()).toEqual({ "dashboard.ws_orphan_reap_grace_s": [14400], max_live_sessions: [4] });
  });

  it("is idempotent: a second update changes nothing and keeps the first backup", () => {
    both(ownerConfig);
    expect(repair().status).toBe(0);
    const once = readFileSync(state, "utf8");
    const firstBackup = readFileSync(backup, "utf8");

    const again = repair();

    expect(again.status).toBe(0);
    expect(again.stdout).toContain("dashboard.ws_orphan_reap_grace_s pinned");
    expect(again.stdout).toContain("max_live_sessions pinned");
    expect(readFileSync(state, "utf8")).toBe(once);
    expect(readFileSync(backup, "utf8")).toBe(firstBackup);
    expect(recorded()).toEqual({ "dashboard.ws_orphan_reap_grace_s": [14400], max_live_sessions: [4] });
  });

  it("inserts the grace into an existing dashboard section without touching its other keys", () => {
    both("dashboard:\n  ws_ping_interval: 20.0\n  trusted_proxies: []\nmodel:\n  default: x\n");

    expect(repair().status).toBe(0);

    expect(load(state)).toEqual({
      dashboard: { ws_orphan_reap_grace_s: 14400, ws_ping_interval: 20.0, trusted_proxies: [] },
      model: { default: "x" },
      max_live_sessions: 4,
    });
  });

  it.each([
    ["the stock default as an int", "dashboard:\n  ws_orphan_reap_grace_s: 20\n"],
    ["the stock default as a float", "dashboard:\n  ws_orphan_reap_grace_s: 20.0\n"],
    ["an empty (null) value", "dashboard:\n  ws_orphan_reap_grace_s:\n  other: 1\n"],
    ["a null section", "dashboard:\nmodel: {default: x}\n"],
    ["a flow-style section", "dashboard: {other: 1}\n"],
  ])("moves %s to the grace pin", (_label, source) => {
    both(source);

    const result = repair();

    expect(result.status).toBe(0);
    expect(load(state).dashboard.ws_orphan_reap_grace_s).toBe(14400);
    expect(load(seed).dashboard.ws_orphan_reap_grace_s).toBe(14400);
  });

  it.each([
    ["a shorter owner value", "600"],
    ["park forever (0)", "0"],
    ["a longer owner value", "86400"],
  ])("keeps %s for the grace: an explicit key the agent saved is the owner's choice", (_label, value) => {
    const source = `dashboard:\n  ws_orphan_reap_grace_s: ${value}\nmax_live_sessions: 4\n`;
    both(source);

    const result = repair();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dashboard.ws_orphan_reap_grace_s owner");
    expect(readFileSync(state, "utf8")).toBe(source);
    expect(existsSync(backup)).toBe(false);
  });

  it.each([
    ["the agent's default (16), with no record", "max_live_sessions: 16\n", 2048, 4, undefined],
    ["the larger tier's cap Hivra wrote, after a resize down", "max_live_sessions: 8\n", 2048, 4, [8]],
    ["the smaller tier's cap Hivra wrote, after a resize up", "max_live_sessions: 4\n", 8192, 8, [4]],
  ])("moves %s to the tier's live-session cap", (_label, source, ramMb, cap, written) => {
    both(`dashboard:\n  ws_orphan_reap_grace_s: 14400\n${source}`);
    if (written) hivraWrote({ "dashboard.ws_orphan_reap_grace_s": [14400], max_live_sessions: written });

    const result = repair({ ramMb });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`max_live_sessions set_from_replaceable (pin ${cap})`);
    expect(load(state).max_live_sessions).toBe(cap);
    expect(load(seed).max_live_sessions).toBe(cap);
    expect(recorded().max_live_sessions).toEqual([cap]);
  });

  it.each([
    ["cap off (0)", "max_live_sessions: 0\n"],
    ["cap off (explicit null, the fork's documented 'disable')", "max_live_sessions: null\n"],
    ["cap off (empty value)", "max_live_sessions:\nmodel: {default: x}\n"],
    ["a larger owner cap", "max_live_sessions: 12\n"],
    ["a smaller owner cap", "max_live_sessions: 2\n"],
    ["an owner cap equal to the other tier's value", "max_live_sessions: 8\n"],
    ["an owner cap equal to this tier's value", "max_live_sessions: 4\n"],
  ])("keeps %s for the live-session cap when the record does not say Hivra wrote it", (_label, cap) => {
    const source = `dashboard:\n  ws_orphan_reap_grace_s: 14400\n${cap}`;
    both(source);
    hivraWrote({ "dashboard.ws_orphan_reap_grace_s": [14400] });

    const result = repair({ ramMb: 2048 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("max_live_sessions owner");
    expect(readFileSync(state, "utf8")).toBe(source);
    expect(readFileSync(seed, "utf8")).toBe(source);
    expect(recorded()).toEqual({ "dashboard.ws_orphan_reap_grace_s": [14400] });
  });

  it("follows the tier while Hivra's value stands, and hands the key to the owner once they change it", () => {
    both(ownerConfig);

    // Provisioned small: Hivra writes 4. Resized up: Hivra's 4 becomes 8.
    expect(repair({ ramMb: 2048 }).status).toBe(0);
    expect(load(state).max_live_sessions).toBe(4);
    expect(repair({ ramMb: 8192 }).status).toBe(0);
    expect(load(state).max_live_sessions).toBe(8);
    expect(recorded().max_live_sessions).toEqual([8]);

    // The owner sets 4 themselves (exactly the small tier's value)...
    both(readFileSync(state, "utf8").replace("max_live_sessions: 8", "max_live_sessions: 4"));
    const ownerEdit = repair({ ramMb: 8192 });
    expect(ownerEdit.stdout).toContain("max_live_sessions owner");
    expect(load(state).max_live_sessions).toBe(4);
    // ...so the key leaves the record, and no later update or resize moves it.
    expect(recorded()).toEqual({ "dashboard.ws_orphan_reap_grace_s": [14400] });
    for (const ramMb of [2048, 8192]) {
      expect(repair({ ramMb }).stdout).toContain("max_live_sessions owner");
      expect(load(state).max_live_sessions).toBe(4);
    }
  });

  it.each([
    ["a larger owner grace", "86400"],
    ["the pin itself, set by the owner", "14400"],
  ])("keeps %s once the owner holds the grace, even if it matches Hivra's value", (_label, grace) => {
    const source = `dashboard:\n  ws_orphan_reap_grace_s: ${grace}\nmax_live_sessions: 4\n`;
    both(source);
    hivraWrote({ max_live_sessions: [4] });

    const result = repair();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dashboard.ws_orphan_reap_grace_s owner");
    expect(readFileSync(state, "utf8")).toBe(source);
    expect(recorded()).toEqual({ max_live_sessions: [4] });
  });

  it("moves a grace Hivra recorded writing when the pin changes", () => {
    both("dashboard:\n  ws_orphan_reap_grace_s: 7200\nmax_live_sessions: 4\n");
    hivraWrote({ "dashboard.ws_orphan_reap_grace_s": [7200], max_live_sessions: [4] });

    const result = repair();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dashboard.ws_orphan_reap_grace_s set_from_replaceable (pin 14400)");
    expect(load(state).dashboard.ws_orphan_reap_grace_s).toBe(14400);
    expect(recorded()).toEqual({ "dashboard.ws_orphan_reap_grace_s": [14400], max_live_sessions: [4] });
  });

  // _max_live_sessions() falls back to gateway.max_live_sessions when the
  // top-level key is unset or null. Hivra never writes that key, so whatever it
  // holds is the owner's, and a top-level cap would shadow it.
  it.each([
    ["an owner cap", "3"],
    ["the agent's default", "16"],
    ["cap off (explicit null)", "null"],
    ["cap off (0)", "0"],
  ])("never shadows gateway.max_live_sessions holding %s", (_label, value) => {
    for (const topLevel of ["", "max_live_sessions: null\n"]) {
      const owner = `dashboard:\n  ws_orphan_reap_grace_s: 14400\n${topLevel}gateway:\n  max_live_sessions: ${value}\n  other: 1\n`;
      both(owner);

      const result = repair();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("max_live_sessions owner");
      expect(readFileSync(state, "utf8")).toBe(owner);
    }
  });

  it("sets the top-level cap when a gateway section has no cap of its own", () => {
    both("dashboard:\n  ws_orphan_reap_grace_s: 14400\ngateway:\n  other: 1\n");

    expect(repair().status).toBe(0);

    expect(load(state)).toEqual({
      dashboard: { ws_orphan_reap_grace_s: 14400 },
      gateway: { other: 1 },
      max_live_sessions: 4,
    });
  });

  it("treats an unusable record as no record: values Hivra wrote read as the owner's", () => {
    const source = "dashboard:\n  ws_orphan_reap_grace_s: 14400\nmax_live_sessions: 8\n";
    both(source);
    writeFileSync(record, "{not json");

    const result = repair({ ramMb: 2048 });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ignoring an unusable record");
    expect(readFileSync(state, "utf8")).toBe(source);
  });

  it("never follows a symlinked record: it is ignored and replaced, its target untouched", () => {
    both("dashboard:\n  ws_orphan_reap_grace_s: 14400\nmax_live_sessions: 8\nmodel: {default: x}\n");
    const target = join(directory, "elsewhere.json");
    const planted = `${JSON.stringify({ version: 1, written: { max_live_sessions: [8] } })}\n`;
    writeFileSync(target, planted);
    symlinkSync(target, record);

    const result = repair({ ramMb: 2048 });

    expect(result.status).toBe(0);
    // The planted record did not make the 8 look like Hivra's.
    expect(load(state).max_live_sessions).toBe(8);
    expect(readFileSync(target, "utf8")).toBe(planted);
  });

  it("writes the record only after config.yaml: a record it cannot write leaves Hivra's value kept, never an owner's taken", () => {
    both(ownerConfig);
    mkdirSync(record);

    const first = repair({ ramMb: 2048 });

    // config.yaml was pinned; the record write failed loudly.
    expect(first.status).toBe(1);
    expect(load(state).max_live_sessions).toBe(4);
    rmSync(record, { recursive: true });

    // Without a record, Hivra's 4 now reads as the owner's: kept on a resize.
    const resized = repair({ ramMb: 8192 });
    expect(resized.status).toBe(0);
    expect(resized.stdout).toContain("max_live_sessions owner");
    expect(load(state).max_live_sessions).toBe(4);
  });

  it("sets the cap in a flow-style document and in an empty file", () => {
    both("{model: {default: x}}\n");
    expect(repair().status).toBe(0);
    expect(load(state)).toEqual({
      model: { default: "x" },
      dashboard: { ws_orphan_reap_grace_s: 14400 },
      max_live_sessions: 4,
    });

    both("");
    expect(repair().status).toBe(0);
    expect(load(state)).toEqual({ dashboard: { ws_orphan_reap_grace_s: 14400 }, max_live_sessions: 4 });
  });

  it("repairs the state file even when the instance-dir copy is absent", () => {
    writeFileSync(state, ownerConfig);

    const result = repair({ withSeed: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("absent");
    expect(load(state).dashboard.ws_orphan_reap_grace_s).toBe(14400);
    expect(load(state).max_live_sessions).toBe(4);
  });

  it.each([
    ["unparseable YAML", "model: [unclosed\napi_key: sk-fixture-secret\n"],
    ["an aliased dashboard section", "x: &a\n  k: 1\ndashboard: *a\n"],
    ["duplicate dashboard sections", "dashboard: {a: 1}\ndashboard: {b: 2}\n"],
    ["a non-mapping dashboard", "dashboard: 5\n"],
    ["duplicate live-session caps", "max_live_sessions: 16\nmax_live_sessions: 16\n"],
    ["an aliased live-session cap", "x: &n 16\nmax_live_sessions: *n\n"],
  ])("leaves %s untouched (all or nothing), fails without echoing the file", (_label, source) => {
    both(source);

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

  it.each([2048, 8192])("leaves a fresh provision's generated config (%s MB) as it is", (ramLimit) => {
    const generated = buildWebUIConfigYaml({ ...baseParams, ramLimit });
    both(generated);

    const result = repair({ ramMb: ramLimit });

    expect(result.status).toBe(0);
    expect(readFileSync(state, "utf8")).toBe(generated);
    expect(existsSync(backup)).toBe(false);
  });

  it("builds a shell step that never fails the update and parses in bash", () => {
    const command = buildWebUISessionRetentionRepairCommand({
      containerName: "agent-inst-reap",
      agentImage: "ghcr.io/example/agent:stable",
      ramLimitMb: 4096,
    });
    expect(command).toContain("-v agent-inst-reap_webui-state:/state");
    expect(command).toContain(
      `ghcr.io/example/agent:stable - '${JSON.stringify(webuiSessionRetentionPins(4096))}' '${WEBUI_SESSION_RETENTION_BACKUP_SUFFIX}' '${WEBUI_SESSION_RETENTION_RECORD_SUFFIX}' /state/config.yaml /seed/config.yaml <<'HERMES_SESSION_RETENTION_PY' || echo`,
    );
    expect(JSON.stringify(webuiSessionRetentionPins(4096))).toContain('"desired":8');
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
    expect(run.stderr).toContain("could not pin the web-chat session retention settings");
  });

  it("runs the shell step's own Python exactly as the box would (stdin heredoc, quoted pins)", () => {
    both(ownerConfig);
    const command = buildWebUISessionRetentionRepairCommand({
      containerName: "agent-inst-reap",
      agentImage: "ghcr.io/example/agent:stable",
      ramLimitMb: 8192,
    });
    // Stand-in docker: run the image's python (argv after the image) on the
    // fixture files instead of /state and /seed.
    const fakeBin = join(directory, "bin");
    spawnSync("mkdir", ["-p", fakeBin]);
    writeFileSync(
      join(fakeBin, "docker"),
      [
        "#!/bin/sh",
        'while [ "$1" != "ghcr.io/example/agent:stable" ]; do shift; done',
        "shift",
        'exec "$FAKE_PYTHON" "$1" "$2" "$3" "$4" "$FAKE_STATE" "$FAKE_SEED"',
        "",
      ].join("\n"),
    );
    chmodSync(join(fakeBin, "docker"), 0o755);
    const run = spawnSync("bash", ["-c", `set -euo pipefail\nINSTANCE_DIR=/tmp\n${command}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_PYTHON: python,
        FAKE_STATE: state,
        FAKE_SEED: seed,
      },
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(load(state)).toMatchObject({ dashboard: { ws_orphan_reap_grace_s: 14400 }, max_live_sessions: 8 });
    expect(load(seed)).toMatchObject({ max_live_sessions: 8 });
    expect(recorded()).toEqual({ "dashboard.ws_orphan_reap_grace_s": [14400], max_live_sessions: [8] });
  });
});

describe("web-chat session retention in the bootstrap script", () => {
  const params = { ...baseParams, containerName: "agent-inst-reap" };

  it("repairs persisted config on update, after the agent image pull and before compose recreates the dashboard", () => {
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(params), params, { mode: "update" });
    const pullIdx = script.indexOf(`docker pull ${params.agentImage}`);
    const repairIdx = script.indexOf("<<'HERMES_SESSION_RETENTION_PY'");
    const composeUpIdx = script.indexOf("docker compose up -d");
    expect(pullIdx).toBeGreaterThan(-1);
    expect(repairIdx).toBeGreaterThan(pullIdx);
    expect(composeUpIdx).toBeGreaterThan(repairIdx);
  });

  it("sizes the update repair's cap from the row's RAM tier", () => {
    const large = { ...params, ramLimit: 8192 };
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(large), large, { mode: "update" });
    expect(script).toContain(`'${JSON.stringify(webuiSessionRetentionPins(8192))}'`);
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
      `for bankr_cfg in /state/config.yaml /state/profiles/*/config.yaml /state/config.yaml.pre-managed-venice-repair.* /state/config.yaml${WEBUI_SESSION_RETENTION_BACKUP_SUFFIX}; do`,
    );
  });

  it("does not run the repair on a fresh provision (the generated config already carries the pins)", () => {
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(params), params, { mode: "provision" });
    expect(script).not.toContain("HERMES_SESSION_RETENTION_PY");
    expect(script).toContain("ws_orphan_reap_grace_s: 14400");
    expect(script).toContain("max_live_sessions: 4");
  });

  describe("fresh-provision state seed", () => {
    let directory: string;
    let stateDir: string;
    let seedDir: string;
    let fakeBin: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "hermes-session-retention-seed-"));
      stateDir = join(directory, "state");
      seedDir = join(directory, "seed");
      fakeBin = join(directory, "bin");
      for (const path of [seedDir, fakeBin]) mkdirSync(path);
      // Stand-in docker: run the busybox `sh -c` payload with the real sh, the
      // step's -e env, and /state and /seed mapped onto the fixture dirs.
      writeFileSync(
        join(fakeBin, "docker"),
        [
          "#!/bin/bash",
          "env_args=()",
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          '    -v) shift 2 ;;',
          '    -e) env_args+=("$2"); shift 2 ;;',
          "    busybox) shift; break ;;",
          "    *) shift ;;",
          "  esac",
          "done",
          'payload="$3"',
          'payload="${payload//\/state/$FAKE_STATE_DIR}"',
          'payload="${payload//\/seed/$FAKE_SEED_DIR}"',
          'exec env "${env_args[@]}" sh -c "$payload"',
          "",
        ].join("\n"),
      );
      // The seed ends with chown -R 1024:1024, which needs root.
      writeFileSync(join(fakeBin, "chown"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(fakeBin, "docker"), 0o755);
      chmodSync(join(fakeBin, "chown"), 0o755);
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    function runSeed(ramLimit: number) {
      const provision = { ...params, ramLimit };
      const artifacts = buildWebUIProvisioningArtifacts(provision);
      const script = buildWebUIBootstrapScript(artifacts, provision, { mode: "provision" });
      const step = script.match(/^docker run --rm \\\n  -v agent-inst-reap_webui-state:\/state \\\n  -v "\$INSTANCE_DIR":\/seed:ro \\\n[^\n]*\n  busybox sh -c '[^\n]*'\n/m)?.[0];
      expect(step).toBeDefined();
      expect(step).toContain(`-e ${WEBUI_SESSION_RETENTION_RECORD_ENV}=`);
      writeFileSync(join(seedDir, "config.yaml"), artifacts.configYaml);
      writeFileSync(join(seedDir, "hermes.env"), "FIXTURE=1\n");
      const run = spawnSync("bash", ["-c", `set -euo pipefail\nINSTANCE_DIR=${seedDir}\n${step}`], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_STATE_DIR: stateDir,
          FAKE_SEED_DIR: seedDir,
        },
      });
      return { run, artifacts };
    }

    function update(ramMb: number) {
      return spawnSync(
        python,
        [
          "-c",
          WEBUI_SESSION_RETENTION_CONFIG_SYNC_PYTHON,
          JSON.stringify(webuiSessionRetentionPins(ramMb)),
          WEBUI_SESSION_RETENTION_BACKUP_SUFFIX,
          WEBUI_SESSION_RETENTION_RECORD_SUFFIX,
          join(stateDir, "config.yaml"),
          join(seedDir, "config.yaml"),
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
    }

    it("records the pins it wrote, so a resized computer's cap follows its tier on the next update", () => {
      const { run, artifacts } = runSeed(2048);

      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(readFileSync(join(stateDir, "config.yaml"), "utf8")).toBe(artifacts.configYaml);
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("FIXTURE=1\n");
      const recordPath = join(stateDir, `config.yaml${WEBUI_SESSION_RETENTION_RECORD_SUFFIX}`);
      expect(readFileSync(recordPath, "utf8")).toBe(`${buildWebUISessionRetentionRecordJson(2048)}\n`);
      expect(JSON.parse(readFileSync(recordPath, "utf8")).written).toEqual({
        "dashboard.ws_orphan_reap_grace_s": [14400],
        max_live_sessions: [4],
      });

      // Resized to 8 GB: the next update moves Hivra's 4 to 8 in both copies.
      const resized = update(8192);
      expect(resized.status).toBe(0);
      expect(resized.stdout).toContain("max_live_sessions set_from_replaceable (pin 8)");
      expect(parseYaml(readFileSync(join(stateDir, "config.yaml"), "utf8")).max_live_sessions).toBe(8);
      expect(parseYaml(readFileSync(join(seedDir, "config.yaml"), "utf8")).max_live_sessions).toBe(8);
    });

    it("never fails the seed when the record cannot be written; the pins then read as the owner's", () => {
      mkdirSync(join(stateDir, `config.yaml${WEBUI_SESSION_RETENTION_RECORD_SUFFIX}`), { recursive: true });

      const { run, artifacts } = runSeed(2048);

      expect(run.status).toBe(0);
      expect(run.stderr).toContain("could not record the session retention settings");
      expect(readFileSync(join(stateDir, "config.yaml"), "utf8")).toBe(artifacts.configYaml);
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("FIXTURE=1\n");
    });
  });
});
