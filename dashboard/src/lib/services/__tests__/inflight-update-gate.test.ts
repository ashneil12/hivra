import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  INFLIGHT_UPDATE_GATE_MARKER,
  SYSTEM_UPDATE_MAX_DEFERRALS,
  SYSTEM_UPDATE_MAX_DEFER_SECONDS,
  buildInFlightUpdateGateScript,
  parseInFlightUpdateGateReport,
  updateDeferralStatePath,
} from "@/lib/services/inflight-update-gate";
import { TURN_MARKER_FRESH_SECONDS } from "@/lib/services/turn-marker-probe";

const python = process.env.HERMES_CONFIG_TEST_PYTHON || "python3";

// These run the real gate (bash + the embedded marker probe) against fixture
// state, with a stand-in `docker` on PATH:
//   docker inspect <dashboard>          -> $FAKE_DASH_STATE, or fails when unset
//   docker exec -i <dash> <py> - <root> <state> <fresh>
//                                       -> local python, root mapped to the fixture
describe("in-flight update gate (on-box script)", () => {
  let dir: string;
  let root: string;
  let statePath: string;
  let fakeBin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hermes-inflight-gate-"));
    root = join(dir, "hermes-home");
    statePath = join(dir, "var-lib", "hermes-update-deferrals-inst_gate");
    fakeBin = join(dir, "bin");
    mkdirSync(root, { recursive: true });
    mkdirSync(dirname(statePath), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "docker"),
      [
        "#!/bin/sh",
        'case "$1" in',
        '  inspect) [ -n "${FAKE_DASH_STATE:-}" ] || exit 1; printf "%s\\n" "$FAKE_DASH_STATE" ;;',
        '  exec)',
        '    [ "${FAKE_EXEC_FAIL:-}" = 1 ] && exit 1',
        '    shift 4',
        '    exec "$FAKE_PYTHON" "$1" "$FAKE_ROOT" "$3" "$4" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(fakeBin, "docker"), 0o755);
    // Stand-in coreutils `timeout` (absent on macOS runners): runs the command,
    // or reports a timeout (124) for docker inspect when asked to.
    writeFileSync(
      join(fakeBin, "timeout"),
      [
        "#!/bin/sh",
        "shift",
        'if [ -n "${FAKE_INSPECT_TIMEOUT:-}" ] && [ "$1" = docker ] && [ "$2" = inspect ]; then exit 124; fi',
        'exec "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(join(fakeBin, "timeout"), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const nowS = () => Math.floor(Date.now() / 1000);
  const dashboardUpSince = (epochSeconds: number) =>
    `true ${new Date(epochSeconds * 1000).toISOString()}`;

  function marker(relativeDir: string, startedAt: number, body?: string) {
    const path = join(root, relativeDir, "desktop", "interrupted_turns.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      body ??
        JSON.stringify({
          "agent:web:session-1": { attempts: 0, prompt: "secret task text", started_at: startedAt },
        }),
    );
    return path;
  }

  function runGate(
    env: { dashState?: string | null; execFail?: boolean; inspectTimeout?: boolean } = {},
    options: { maxDeferrals?: number; maxDeferSeconds?: number } = {},
  ) {
    const script = buildInFlightUpdateGateScript({
      instanceId: "inst_gate",
      deferralStatePath: statePath,
      ...options,
    });
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_ROOT: root,
        FAKE_PYTHON: python,
        ...(env.dashState === null || env.dashState === undefined
          ? {}
          : { FAKE_DASH_STATE: env.dashState }),
        ...(env.execFail ? { FAKE_EXEC_FAIL: "1" } : {}),
        ...(env.inspectTimeout ? { FAKE_INSPECT_TIMEOUT: "1" } : {}),
      },
    });
    expect(result.status).toBe(0);
    const report = parseInFlightUpdateGateReport(result.stdout);
    expect(report).not.toBeNull();
    return { report: report!, stdout: result.stdout, stderr: result.stderr };
  }

  it("proceeds when no turn is running and ends any deferral streak", () => {
    writeFileSync(statePath, `${nowS() - 600} 3\n`);
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(report).toMatchObject({
      action: "proceed",
      verdict: "idle",
      reason: "no_turn_in_flight",
      liveTurns: 0,
      unreadableMarkers: 0,
      deferrals: 0,
    });
    expect(existsSync(statePath)).toBe(false);
  });

  it("defers while a web-chat turn is running and counts the streak", () => {
    marker("", nowS() - 300);
    const first = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(first.report).toMatchObject({
      action: "defer",
      verdict: "busy",
      reason: "in_flight_turn",
      liveTurns: 1,
      unreadableMarkers: 0,
      deferrals: 1,
    });
    const [firstStamp] = readFileSync(statePath, "utf8").trim().split(" ");

    const second = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(second.report).toMatchObject({ action: "defer", deferrals: 2 });
    // The streak is measured from its FIRST deferral, never restarted.
    expect(readFileSync(statePath, "utf8").trim()).toBe(`${firstStamp} 2`);
  });

  it("sees a profile's web-chat turn too", () => {
    marker(join("profiles", "research"), nowS() - 60);
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(report).toMatchObject({ action: "defer", liveTurns: 1 });
  });

  it("proceeds once the streak reaches the deferral count cap", () => {
    marker("", nowS() - 60);
    const up = dashboardUpSince(nowS() - 3600);
    expect(runGate({ dashState: up }, { maxDeferrals: 2 }).report.action).toBe("defer");
    expect(runGate({ dashState: up }, { maxDeferrals: 2 }).report.action).toBe("defer");
    const capped = runGate({ dashState: up }, { maxDeferrals: 2 });
    expect(capped.report).toMatchObject({
      action: "proceed",
      verdict: "busy",
      reason: "deferral_cap",
      deferrals: 2,
    });
    expect(existsSync(statePath)).toBe(false);
  });

  it("proceeds once the streak's first deferral is older than the time cap (a daily caller defers at most once)", () => {
    marker("", nowS() - 60);
    // The fleet sync deferred this box yesterday; today it is busy again.
    writeFileSync(statePath, `${nowS() - SYSTEM_UPDATE_MAX_DEFER_SECONDS - 60} 1\n`);
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(report).toMatchObject({ action: "proceed", reason: "deferral_cap", deferrals: 1 });
    expect(report.streakSeconds).toBeGreaterThanOrEqual(SYSTEM_UPDATE_MAX_DEFER_SECONDS);
    expect(existsSync(statePath)).toBe(false);
  });

  it("restarts a corrupt or future-dated streak instead of trusting it", () => {
    marker("", nowS() - 60);
    writeFileSync(statePath, "garbage\n");
    expect(runGate({ dashState: dashboardUpSince(nowS() - 3600) }).report).toMatchObject({
      action: "defer",
      deferrals: 1,
    });
    writeFileSync(statePath, `${nowS() + 86_400} 5\n`);
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(report).toMatchObject({ action: "defer", deferrals: 6 });
    expect(report.streakSeconds).toBe(0);
  });

  it("proceeds when the dashboard is stopped or missing: no web-chat turn can be running", () => {
    marker("", nowS() - 60);
    expect(runGate({ dashState: "false 0001-01-01T00:00:00Z" }).report).toMatchObject({
      action: "proceed",
      verdict: "idle",
      reason: "dashboard_not_running",
    });
    expect(runGate({ dashState: null }).report).toMatchObject({
      action: "proceed",
      reason: "dashboard_not_running",
    });
  });

  it("does not count a marker left by a dashboard process that has since restarted", () => {
    marker("", nowS() - 1800);
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 60) });
    expect(report).toMatchObject({ action: "proceed", verdict: "idle", liveTurns: 0 });
  });

  it("does not count a crash-left marker past the freshness bound", () => {
    const old = nowS() - TURN_MARKER_FRESH_SECONDS - 600;
    utimesSync(marker("", old), old, old);
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 30 * 3600) });
    expect(report).toMatchObject({ action: "proceed", verdict: "idle" });
  });

  it("defers on a fresh unreadable marker file (fail safe), bounded by the same cap", () => {
    marker("", 0, "{not json");
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(report).toMatchObject({
      action: "defer",
      verdict: "busy",
      liveTurns: 0,
      unreadableMarkers: 1,
    });
  });

  it("defers as unknown when the running dashboard cannot be probed", () => {
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600), execFail: true });
    expect(report).toMatchObject({
      action: "defer",
      verdict: "unknown",
      reason: "turn_state_unknown",
      liveTurns: null,
      unreadableMarkers: null,
    });
  });

  it("defers as unknown when Docker does not answer in time, rather than assume no turn", () => {
    marker("", nowS() - 60);
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600), inspectTimeout: true });
    expect(report).toMatchObject({ action: "defer", verdict: "unknown", reason: "turn_state_unknown" });
  });

  it("proceeds rather than defer without a counter when the streak cannot be recorded", () => {
    marker("", nowS() - 60);
    rmSync(dirname(statePath), { recursive: true, force: true });
    const { report } = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(report).toMatchObject({
      action: "proceed",
      verdict: "busy",
      reason: "deferral_state_unwritable",
    });
  });

  it("never prints the turn's prompt", () => {
    marker("", nowS() - 60);
    const { stdout, stderr } = runGate({ dashState: dashboardUpSince(nowS() - 3600) });
    expect(`${stdout}${stderr}`).not.toContain("secret task text");
  });

  it("passes bash syntax validation", () => {
    const result = spawnSync("bash", ["-n"], {
      input: buildInFlightUpdateGateScript({ instanceId: "inst_gate" }),
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("in-flight update gate policy", () => {
  it("caps deferrals at six hours and 24 deferrals by default, on a per-instance state file", () => {
    const script = buildInFlightUpdateGateScript({ instanceId: "inst_gate" });
    expect(SYSTEM_UPDATE_MAX_DEFER_SECONDS).toBe(6 * 60 * 60);
    expect(SYSTEM_UPDATE_MAX_DEFERRALS).toBe(24);
    expect(script).toContain("MAX_DEFERRALS=24");
    expect(script).toContain("MAX_DEFER_S=21600");
    expect(script).toContain(`FRESH_S=${TURN_MARKER_FRESH_SECONDS}`);
    expect(script).toContain(`STATE='${updateDeferralStatePath("inst_gate")}'`);
    expect(updateDeferralStatePath("inst_gate")).toBe("/var/lib/hermes-update-deferrals-inst_gate");
  });
});

describe("parseInFlightUpdateGateReport", () => {
  it("reads the report line out of mixed launch output", () => {
    expect(
      parseInFlightUpdateGateReport(
        `${INFLIGHT_UPDATE_GATE_MARKER} action=defer verdict=busy reason=in_flight_turn live=2 unreadable=0 deferrals=3 streak_s=900\n`,
      ),
    ).toEqual({
      action: "defer",
      verdict: "busy",
      reason: "in_flight_turn",
      liveTurns: 2,
      unreadableMarkers: 0,
      deferrals: 3,
      streakSeconds: 900,
    });
    expect(
      parseInFlightUpdateGateReport(
        `noise\n${INFLIGHT_UPDATE_GATE_MARKER} action=proceed verdict=unknown reason=deferral_cap live=- unreadable=- deferrals=24 streak_s=21700\n4242\n`,
      ),
    ).toMatchObject({ action: "proceed", liveTurns: null, unreadableMarkers: null, deferrals: 24 });
  });

  it("returns null for output without a well-formed report", () => {
    expect(parseInFlightUpdateGateReport("4242\n")).toBeNull();
    expect(parseInFlightUpdateGateReport(`${INFLIGHT_UPDATE_GATE_MARKER}\n`)).toBeNull();
    expect(
      parseInFlightUpdateGateReport(`${INFLIGHT_UPDATE_GATE_MARKER} action=maybe verdict=busy reason=in_flight_turn\n`),
    ).toBeNull();
    expect(
      parseInFlightUpdateGateReport(`${INFLIGHT_UPDATE_GATE_MARKER} action=defer verdict=busy reason=whatever\n`),
    ).toBeNull();
  });
});
