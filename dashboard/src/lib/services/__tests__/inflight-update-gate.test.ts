import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  GATEWAY_STATE_STALE_SECONDS,
  TURN_MARKER_FRESH_SECONDS,
  buildAgentActivityProbeShell,
} from "@/lib/services/agent-activity-probe";
import {
  INFLIGHT_UPDATE_GATE_BUDGET_SECONDS,
  INFLIGHT_UPDATE_GATE_MARKER,
  INFLIGHT_UPDATE_GATE_SLACK_SECONDS,
  SYSTEM_UPDATE_DEFERRAL_POLICY,
  buildClearUpdateDeferralsCommand,
  buildInFlightUpdateGateScript,
  gatedLaunchTimeoutMs,
  parseInFlightUpdateGateReport,
  updateDeferralStatePath,
  type SystemUpdateDeferralPolicy,
} from "@/lib/services/inflight-update-gate";
import type { SystemLiveUpdateTrigger } from "@/lib/services/live-update-initiator";

import {
  FIXTURE_DASHBOARD,
  FIXTURE_GATEWAY,
  FIXTURE_INSTANCE_ID,
  createActivityBox,
  nowS,
  runningSince,
  stoppedSince,
  type ActivityBox,
  type FakeDockerEnv,
} from "./agent-activity-fixture";

const HOUR = 3600;

// These run the real gate (bash + the shared agent activity probe) against a
// fixture HERMES_HOME with a stand-in `docker` and `timeout` on PATH
// (agent-activity-fixture.ts).
describe("in-flight update gate (on-box script)", () => {
  let box: ActivityBox;
  let stateDir: string;

  beforeEach(() => {
    box = createActivityBox("hermes-inflight-gate-");
    stateDir = join(box.dir, "var-lib");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    box.cleanup();
  });

  const statePathFor = (trigger: SystemLiveUpdateTrigger) =>
    join(stateDir, `hermes-update-deferrals-${FIXTURE_INSTANCE_ID}.${trigger}`);

  // Both containers up for an hour, gateway idle and fresh: the healthy baseline.
  const healthy = (): FakeDockerEnv => ({
    gateway: runningSince(nowS() - HOUR),
    dashboard: runningSince(nowS() - HOUR),
  });

  function runGate(
    env: FakeDockerEnv,
    options: {
      trigger?: SystemLiveUpdateTrigger;
      budgetSeconds?: number;
      policy?: Partial<SystemUpdateDeferralPolicy>;
    } = {},
  ) {
    const trigger = options.trigger ?? "fleet_sync";
    const script = buildInFlightUpdateGateScript({
      instanceId: FIXTURE_INSTANCE_ID,
      trigger,
      budgetSeconds: options.budgetSeconds ?? INFLIGHT_UPDATE_GATE_BUDGET_SECONDS,
      deferralStatePath: statePathFor(trigger),
      ...(options.policy ? { policy: options.policy } : {}),
    });
    const result = box.run(script, env);
    expect(result.status).toBe(0);
    const report = parseInFlightUpdateGateReport(result.stdout);
    expect(report).not.toBeNull();
    return { report: report!, stdout: result.stdout, stderr: result.stderr, elapsedMs: result.elapsedMs };
  }

  const streakOf = (trigger: SystemLiveUpdateTrigger) =>
    readFileSync(statePathFor(trigger), "utf8").trim().split(" ").map(Number);

  describe("what counts as a turn in flight", () => {
    it("proceeds when nothing is running and ends the caller's deferral streak", () => {
      box.writeGatewayState({ activeAgents: 0 });
      writeFileSync(statePathFor("fleet_sync"), `${nowS() - 600} ${nowS() - 600} 1\n`);
      const { report } = runGate(healthy());
      expect(report).toMatchObject({
        action: "proceed",
        verdict: "idle",
        reason: "no_turn_in_flight",
        trigger: "fleet_sync",
        liveTurns: 0,
        unreadableMarkers: 0,
        gatewayActive: 0,
        gatewayUnknown: 0,
        deferrals: 0,
      });
      expect(existsSync(statePathFor("fleet_sync"))).toBe(false);
    });

    it("defers while a web-chat turn is running and counts the streak", () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker("", nowS() - 300);
      const first = runGate(healthy());
      expect(first.report).toMatchObject({
        action: "defer",
        verdict: "busy",
        reason: "in_flight_turn",
        liveTurns: 1,
        gatewayActive: 0,
        deferrals: 1,
      });
      const [firstStamp] = streakOf("fleet_sync");

      const second = runGate(healthy());
      expect(second.report).toMatchObject({ action: "defer", deferrals: 2 });
      const [stampAfter, lastAfter, countAfter] = streakOf("fleet_sync");
      expect(stampAfter).toBe(firstStamp);
      expect(lastAfter).toBeGreaterThanOrEqual(firstStamp);
      expect(countAfter).toBe(2);
    });

    it("sees a profile's web-chat turn too", () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker(join("profiles", "research"), nowS() - 60);
      expect(runGate(healthy()).report).toMatchObject({ action: "defer", liveTurns: 1 });
    });

    // The update recreates the gateway too: a Telegram reply, a cron job or a
    // scheduled task running there is a turn in flight just like a web-chat one.
    it("defers while the gateway runs a messaging, cron or scheduled-task turn", () => {
      box.writeGatewayState({ activeAgents: 1 });
      const { report } = runGate(healthy());
      expect(report).toMatchObject({
        action: "defer",
        verdict: "busy",
        reason: "in_flight_turn",
        gatewayActive: 1,
        liveTurns: 0,
      });
    });

    it.each([
      ["stale", { updatedAt: nowS() - GATEWAY_STATE_STALE_SECONDS - 60 }],
      ["unreadable", { raw: "{not json" }],
    ])("treats a %s gateway state as unknown while the gateway runs (fail safe)", (_label, state) => {
      box.writeGatewayState(state);
      const { report } = runGate(healthy());
      expect(report).toMatchObject({
        action: "defer",
        verdict: "unknown",
        reason: "turn_state_unknown",
        gatewayActive: 0,
        gatewayUnknown: 1,
      });
    });

    it("treats a missing gateway state as unknown while the gateway runs", () => {
      const { report } = runGate(healthy());
      expect(report).toMatchObject({ action: "defer", verdict: "unknown", gatewayUnknown: 1 });
    });

    it("ignores the gateway state of a stopped gateway and reads markers through official-dashboard", () => {
      box.writeGatewayState({ activeAgents: 3, updatedAt: nowS() - 7200 });
      const { report } = runGate({
        gateway: stoppedSince(nowS() - HOUR),
        dashboard: runningSince(nowS() - HOUR),
      });
      expect(report).toMatchObject({ action: "proceed", verdict: "idle", gatewayActive: 0, gatewayUnknown: 0 });
      expect(box.execTargets()).toEqual([FIXTURE_DASHBOARD]);
    });

    it("still sees a web-chat turn while the gateway is down", () => {
      box.writeTurnMarker("", nowS() - 60);
      const { report } = runGate({
        gateway: "absent",
        dashboard: runningSince(nowS() - HOUR),
      });
      expect(report).toMatchObject({ action: "defer", verdict: "busy", liveTurns: 1 });
    });

    it("runs the probe in the gateway container, falling back to official-dashboard", () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker("", nowS() - 60);
      const { report } = runGate({ ...healthy(), gatewayExecFails: true });
      expect(report).toMatchObject({ action: "defer", verdict: "busy", liveTurns: 1 });
      expect(box.execTargets()).toEqual([FIXTURE_DASHBOARD]);

      runGate(healthy());
      expect(box.execTargets()).toEqual([FIXTURE_GATEWAY]);
    });

    it("proceeds when neither container is running or they do not exist: no turn can be in flight", () => {
      box.writeTurnMarker("", nowS() - 60);
      box.writeGatewayState({ activeAgents: 1 });
      expect(
        runGate({ gateway: stoppedSince(nowS() - HOUR), dashboard: stoppedSince(nowS() - HOUR) }).report,
      ).toMatchObject({ action: "proceed", verdict: "idle", reason: "agent_not_running" });
      expect(runGate({ gateway: "absent", dashboard: "absent" }).report).toMatchObject({
        action: "proceed",
        reason: "agent_not_running",
      });
    });

    it("does not count a marker left by a dashboard process that has since restarted", () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker("", nowS() - 1800);
      const { report } = runGate({ gateway: runningSince(nowS() - HOUR), dashboard: runningSince(nowS() - 60) });
      expect(report).toMatchObject({ action: "proceed", verdict: "idle", liveTurns: 0 });
    });

    it("does not count a crash-left marker past the freshness bound", () => {
      box.writeGatewayState({ activeAgents: 0 });
      const old = nowS() - TURN_MARKER_FRESH_SECONDS - 600;
      utimesSync(box.writeTurnMarker("", old), old, old);
      const { report } = runGate({
        gateway: runningSince(nowS() - HOUR),
        dashboard: runningSince(nowS() - 30 * HOUR),
      });
      expect(report).toMatchObject({ action: "proceed", verdict: "idle" });
    });

    it("treats a fresh unreadable marker as unknown (fail safe)", () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker("", 0, "{not json");
      const { report } = runGate(healthy());
      expect(report).toMatchObject({
        action: "defer",
        verdict: "unknown",
        liveTurns: 0,
        unreadableMarkers: 1,
      });
    });

    it.each([
      ["the probe cannot run in either container", { gatewayExecFails: true, dashboardExecFails: true }],
      ["Docker does not answer", { dockerDown: true }],
    ])("defers as unknown when %s, rather than assume no turn", (_label, extra) => {
      box.writeGatewayState({ activeAgents: 0 });
      const { report } = runGate({ ...healthy(), ...extra });
      expect(report).toMatchObject({
        action: "defer",
        verdict: "unknown",
        reason: "turn_state_unknown",
        liveTurns: null,
        unreadableMarkers: null,
        gatewayActive: null,
      });
    });

    it("reads the files fail-safe when inspect fails for containers Docker still lists", () => {
      box.writeGatewayState({ activeAgents: 0 });
      // Without the dashboard's start time every fresh marker counts, even one a
      // restarted dashboard would have ruled out.
      box.writeTurnMarker("", nowS() - 1800);
      expect(runGate({ ...healthy(), inspectFails: true }).report).toMatchObject({
        action: "defer",
        verdict: "busy",
        liveTurns: 1,
      });
      expect(box.execTargets()).toEqual([FIXTURE_GATEWAY]);
    });

    it("never prints the turn's prompt", () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker("", nowS() - 60);
      const { stdout, stderr } = runGate(healthy());
      expect(`${stdout}${stderr}`).not.toContain("secret task text");
    });
  });

  describe("per-caller deferral streaks", () => {
    const busy = () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker("", nowS() - 60);
      return healthy();
    };

    // A streak file left by an earlier episode (the turn ended, nothing cleared
    // the file) must not make today's busy box proceed on its first visit.
    it.each([
      ["fleet_sync" as const, 3 * 24 * HOUR],
      ["pending_resize_sweep" as const, 3 * 24 * HOUR],
      ["pending_resize_sweep" as const, 2 * HOUR],
      ["unhealthy_recovery" as const, 3 * 24 * HOUR],
    ])("starts a new %s streak when its last deferral is %i s old, and defers", (trigger, age) => {
      const env = busy();
      writeFileSync(statePathFor(trigger), `${nowS() - age} ${nowS() - age} 1\n`);
      const { report } = runGate(env, { trigger });
      expect(report).toMatchObject({ action: "defer", verdict: "busy", deferrals: 1 });
      expect(report.streakSeconds).toBeLessThan(5);
      const [first, last, count] = streakOf(trigger);
      expect(first).toBeGreaterThanOrEqual(nowS() - 5);
      expect(last).toBe(first);
      expect(count).toBe(1);
    });

    it("keeps counting while the caller keeps coming back inside its retry window", () => {
      const env = busy();
      writeFileSync(statePathFor("pending_resize_sweep"), `${nowS() - 2 * HOUR} ${nowS() - 900} 8\n`);
      const { report } = runGate(env, { trigger: "pending_resize_sweep" });
      expect(report).toMatchObject({ action: "defer", deferrals: 9 });
      expect(report.streakSeconds).toBeGreaterThanOrEqual(2 * HOUR);
      expect(streakOf("pending_resize_sweep")[0]).toBeLessThanOrEqual(nowS() - 2 * HOUR);
    });

    it("the daily fleet sync defers a busy box on two consecutive days and updates it on the third", () => {
      const env = busy();
      // Day 1.
      expect(runGate(env).report).toMatchObject({ action: "defer", deferrals: 1 });
      // Day 2: yesterday's deferral, one retry interval ago.
      const day1 = nowS() - 24 * HOUR;
      writeFileSync(statePathFor("fleet_sync"), `${day1} ${day1} 1\n`);
      expect(runGate(env).report).toMatchObject({ action: "defer", deferrals: 2 });
      // Day 3.
      const day2 = nowS() - 24 * HOUR;
      writeFileSync(statePathFor("fleet_sync"), `${nowS() - 48 * HOUR} ${day2} 2\n`);
      const { report } = runGate(env);
      expect(report).toMatchObject({ action: "proceed", verdict: "busy", reason: "deferral_cap", deferrals: 2 });
      expect(existsSync(statePathFor("fleet_sync"))).toBe(false);
    });

    it("the pending-resize sweep proceeds once its streak is six hours old", () => {
      const env = busy();
      writeFileSync(statePathFor("pending_resize_sweep"), `${nowS() - 6 * HOUR - 60} ${nowS() - 900} 23\n`);
      const { report } = runGate(env, { trigger: "pending_resize_sweep" });
      expect(report).toMatchObject({ action: "proceed", reason: "deferral_cap", deferrals: 23 });
      expect(report.streakSeconds).toBeGreaterThanOrEqual(6 * HOUR);
    });

    it("proceeds once a streak reaches its deferral count cap", () => {
      const env = busy();
      const policy = { maxDeferrals: 2 };
      expect(runGate(env, { trigger: "pending_resize_sweep", policy }).report.action).toBe("defer");
      expect(runGate(env, { trigger: "pending_resize_sweep", policy }).report.action).toBe("defer");
      expect(runGate(env, { trigger: "pending_resize_sweep", policy }).report).toMatchObject({
        action: "proceed",
        reason: "deferral_cap",
        deferrals: 2,
      });
    });

    it("keeps each caller's streak separate, so 15-minute callers cannot reach a cap together", () => {
      const env = busy();
      const resizeStreak = `${nowS() - 5 * HOUR} ${nowS() - 900} 23\n`;
      writeFileSync(statePathFor("pending_resize_sweep"), resizeStreak);
      const { report } = runGate(env, { trigger: "unhealthy_recovery" });
      expect(report).toMatchObject({ action: "defer", trigger: "unhealthy_recovery", deferrals: 1 });
      expect(readFileSync(statePathFor("pending_resize_sweep"), "utf8")).toBe(resizeStreak);
      expect(streakOf("unhealthy_recovery")[2]).toBe(1);
    });

    it("restarts a corrupt or old-format streak and treats future stamps as now", () => {
      const env = busy();
      writeFileSync(statePathFor("pending_resize_sweep"), "garbage\n");
      expect(runGate(env, { trigger: "pending_resize_sweep" }).report).toMatchObject({ action: "defer", deferrals: 1 });
      writeFileSync(statePathFor("pending_resize_sweep"), `${nowS() - 600} 5\n`);
      expect(runGate(env, { trigger: "pending_resize_sweep" }).report).toMatchObject({ action: "defer", deferrals: 1 });
      writeFileSync(statePathFor("pending_resize_sweep"), `${nowS() + 86_400} ${nowS() + 86_400} 5\n`);
      const { report } = runGate(env, { trigger: "pending_resize_sweep" });
      expect(report).toMatchObject({ action: "defer", deferrals: 6 });
      expect(report.streakSeconds).toBe(0);
    });

    it("proceeds rather than defer without a counter when the streak cannot be recorded", () => {
      const env = busy();
      rmSync(stateDir, { recursive: true, force: true });
      const { report } = runGate(env);
      expect(report).toMatchObject({ action: "proceed", verdict: "busy", reason: "deferral_state_unwritable" });
    });
  });

  describe("unhealthy-box recovery", () => {
    it("proceeds when the probe cannot tell: that is part of the breakage it repairs", () => {
      box.writeGatewayState({ updatedAt: nowS() - 3600 });
      const { report } = runGate(healthy(), { trigger: "unhealthy_recovery" });
      expect(report).toMatchObject({
        action: "proceed",
        verdict: "unknown",
        reason: "turn_state_unknown",
        deferrals: 0,
      });
      expect(existsSync(statePathFor("unhealthy_recovery"))).toBe(false);

      expect(
        runGate({ ...healthy(), dockerDown: true }, { trigger: "unhealthy_recovery" }).report,
      ).toMatchObject({ action: "proceed", verdict: "unknown" });
    });

    it("waits for a positively running turn at most four deferrals", () => {
      box.writeGatewayState({ activeAgents: 0 });
      box.writeTurnMarker("", nowS() - 60);
      for (let deferral = 1; deferral <= 4; deferral++) {
        expect(runGate(healthy(), { trigger: "unhealthy_recovery" }).report).toMatchObject({
          action: "defer",
          verdict: "busy",
          deferrals: deferral,
        });
      }
      expect(runGate(healthy(), { trigger: "unhealthy_recovery" }).report).toMatchObject({
        action: "proceed",
        reason: "deferral_cap",
        deferrals: 4,
      });
    });

    it("waits for a hung turn at most one hour", () => {
      box.writeGatewayState({ activeAgents: 1 });
      writeFileSync(statePathFor("unhealthy_recovery"), `${nowS() - HOUR - 30} ${nowS() - 900} 2\n`);
      const { report } = runGate(healthy(), { trigger: "unhealthy_recovery" });
      expect(report).toMatchObject({ action: "proceed", verdict: "busy", reason: "deferral_cap" });
    });
  });

  describe("time bound", () => {
    // The gate runs inside the launch's SSH session; its worst case must fit the
    // allowance the lane adds to its SSH timeout (gatedLaunchTimeoutMs).
    it(
      "finishes within its budget when official-dashboard hangs on every docker exec",
      () => {
        box.writeGatewayState({ activeAgents: 0 });
        const { report, elapsedMs } = runGate({ ...healthy(), hang: "exec" });
        expect(report).toMatchObject({ action: "defer", verdict: "unknown", reason: "turn_state_unknown" });
        expect(elapsedMs).toBeLessThan(
          (INFLIGHT_UPDATE_GATE_BUDGET_SECONDS + INFLIGHT_UPDATE_GATE_SLACK_SECONDS) * 1000,
        );
      },
      60_000,
    );

    it("finishes within a small per-lane budget when Docker hangs on everything", () => {
      const { report, elapsedMs } = runGate({ ...healthy(), hang: "all" }, { budgetSeconds: 2 });
      expect(report).toMatchObject({ action: "defer", verdict: "unknown" });
      expect(elapsedMs).toBeLessThan((2 + INFLIGHT_UPDATE_GATE_SLACK_SECONDS) * 1000);
    }, 30_000);
  });

  it("passes bash syntax validation", () => {
    const result = spawnSync("bash", ["-n"], {
      input: buildInFlightUpdateGateScript({
        instanceId: FIXTURE_INSTANCE_ID,
        trigger: "fleet_sync",
        budgetSeconds: INFLIGHT_UPDATE_GATE_BUDGET_SECONDS,
      }),
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("in-flight update gate policy", () => {
  it("gives each caller its own cap, retry window and unknown handling", () => {
    expect(SYSTEM_UPDATE_DEFERRAL_POLICY).toEqual({
      fleet_sync: {
        retryIntervalSeconds: 24 * HOUR,
        streakExpirySeconds: 36 * HOUR,
        maxDeferrals: 2,
        maxDeferSeconds: 48 * HOUR,
        onUnknown: "defer",
      },
      pending_resize_sweep: {
        retryIntervalSeconds: 900,
        streakExpirySeconds: HOUR,
        maxDeferrals: 24,
        maxDeferSeconds: 6 * HOUR,
        onUnknown: "defer",
      },
      unhealthy_recovery: {
        retryIntervalSeconds: 900,
        streakExpirySeconds: HOUR,
        maxDeferrals: 4,
        maxDeferSeconds: HOUR,
        onUnknown: "proceed",
      },
    });
    for (const policy of Object.values(SYSTEM_UPDATE_DEFERRAL_POLICY)) {
      // One missed run must not reset a streak, and the time cap must leave
      // room for maxDeferrals visits.
      expect(policy.streakExpirySeconds).toBeGreaterThan(policy.retryIntervalSeconds);
      expect(policy.maxDeferSeconds).toBeGreaterThanOrEqual(policy.retryIntervalSeconds * policy.maxDeferrals);
    }
    // A marker must stay fresh for at least as long as a resize may wait on it.
    expect(TURN_MARKER_FRESH_SECONDS).toBeGreaterThanOrEqual(SYSTEM_UPDATE_DEFERRAL_POLICY.pending_resize_sweep.maxDeferSeconds);
  });

  it("embeds the caller's policy and a per-caller streak file", () => {
    const script = buildInFlightUpdateGateScript({
      instanceId: FIXTURE_INSTANCE_ID,
      trigger: "unhealthy_recovery",
      budgetSeconds: 15,
    });
    expect(script).toContain("TRIGGER='unhealthy_recovery'");
    expect(script).toContain("MAX_DEFERRALS=4");
    expect(script).toContain("MAX_DEFER_S=3600");
    expect(script).toContain("STREAK_EXPIRY_S=3600");
    expect(script).toContain("ON_UNKNOWN=proceed");
    expect(script).toContain("HIVRA_ACTIVITY_DEADLINE=$(( $(date +%s) + 15 ))");
    expect(script).toContain(`STATE='${updateDeferralStatePath(FIXTURE_INSTANCE_ID, "unhealthy_recovery")}'`);
    expect(updateDeferralStatePath(FIXTURE_INSTANCE_ID, "unhealthy_recovery")).toBe(
      `/var/lib/hermes-update-deferrals-${FIXTURE_INSTANCE_ID}.unhealthy_recovery`,
    );
    expect(buildClearUpdateDeferralsCommand(FIXTURE_INSTANCE_ID)).toBe(
      `rm -f '/var/lib/hermes-update-deferrals-${FIXTURE_INSTANCE_ID}.'*`,
    );
  });

  it("runs the same activity probe as the idle sampler", () => {
    const script = buildInFlightUpdateGateScript({
      instanceId: FIXTURE_INSTANCE_ID,
      trigger: "fleet_sync",
      budgetSeconds: 15,
    });
    expect(script).toContain(buildAgentActivityProbeShell());
  });

  it("grows a lane's launch timeout by the gate's worst case", () => {
    expect(gatedLaunchTimeoutMs(30_000, INFLIGHT_UPDATE_GATE_BUDGET_SECONDS)).toBe(
      30_000 + (INFLIGHT_UPDATE_GATE_BUDGET_SECONDS + INFLIGHT_UPDATE_GATE_SLACK_SECONDS) * 1000,
    );
  });
});

describe("clearing deferral streaks", () => {
  it("removes every caller's streak for the box and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-clear-deferrals-"));
    try {
      const other = "00000000-0000-4000-8000-000000000002";
      for (const name of [
        `hermes-update-deferrals-${FIXTURE_INSTANCE_ID}.fleet_sync`,
        `hermes-update-deferrals-${FIXTURE_INSTANCE_ID}.unhealthy_recovery`,
        `hermes-update-deferrals-${other}.fleet_sync`,
      ]) {
        writeFileSync(join(dir, name), "1 1 1\n");
      }
      const command = buildClearUpdateDeferralsCommand(FIXTURE_INSTANCE_ID).replace(
        "/var/lib/",
        `${dir}/`,
      );
      expect(spawnSync("bash", ["-c", command]).status).toBe(0);
      expect(existsSync(join(dir, `hermes-update-deferrals-${FIXTURE_INSTANCE_ID}.fleet_sync`))).toBe(false);
      expect(existsSync(join(dir, `hermes-update-deferrals-${FIXTURE_INSTANCE_ID}.unhealthy_recovery`))).toBe(false);
      expect(existsSync(join(dir, `hermes-update-deferrals-${other}.fleet_sync`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseInFlightUpdateGateReport", () => {
  it("reads the report line out of mixed launch output", () => {
    expect(
      parseInFlightUpdateGateReport(
        `${INFLIGHT_UPDATE_GATE_MARKER} action=defer verdict=busy reason=in_flight_turn trigger=fleet_sync live=2 unreadable=0 gateway_active=1 gateway_unknown=0 deferrals=3 streak_s=900\n`,
      ),
    ).toEqual({
      action: "defer",
      verdict: "busy",
      reason: "in_flight_turn",
      trigger: "fleet_sync",
      liveTurns: 2,
      unreadableMarkers: 0,
      gatewayActive: 1,
      gatewayUnknown: 0,
      deferrals: 3,
      streakSeconds: 900,
    });
    expect(
      parseInFlightUpdateGateReport(
        `noise\n${INFLIGHT_UPDATE_GATE_MARKER} action=proceed verdict=unknown reason=deferral_cap trigger=pending_resize_sweep live=- unreadable=- gateway_active=- gateway_unknown=- deferrals=24 streak_s=21700\n4242\n`,
      ),
    ).toMatchObject({
      action: "proceed",
      trigger: "pending_resize_sweep",
      liveTurns: null,
      unreadableMarkers: null,
      gatewayActive: null,
      deferrals: 24,
    });
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
