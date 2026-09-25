/**
 * Test fixture for scripts that embed the agent activity probe (the idle sampler
 * and the in-flight update gate). The real bash and the real embedded Python run
 * against a fixture HERMES_HOME, with stand-ins on PATH for:
 *
 *   docker inspect --type container -f <fmt> <name>
 *       -> the container's state from FAKE_GW_STATE / FAKE_DASH_STATE
 *          ("true <iso>", "false <iso>", or "absent": inspect fails and the
 *          container is not listed); FAKE_INSPECT_FAIL=1 fails every inspect
 *          while the containers are still listed
 *   docker ps -a --format '{{.Names}}'
 *       -> the names of the containers that are not absent
 *   docker exec -i <container> <python> - <HERMES_HOME> <args...>
 *       -> the local python with HERMES_HOME mapped onto the fixture; each call
 *          is logged ("<container> <python>") to FAKE_EXEC_LOG;
 *          FAKE_GW_EXEC_FAIL=1 / FAKE_DASH_EXEC_FAIL=1 fail one container's exec
 *   FAKE_DOCKER_DOWN=1 fails every docker call; FAKE_DOCKER_HANG=exec|all makes
 *   those calls hang until killed
 *   timeout <s> <cmd...>
 *       -> coreutils-compatible stand-in (macOS runners have none): runs the
 *          command with its stdin, kills it after <s> seconds and exits 124 then
 *
 * Not a test file itself (jest only collects *.test.ts).
 */

import { spawnSync, type SpawnSyncReturns } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export const FIXTURE_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
export const FIXTURE_GATEWAY = `agent-${FIXTURE_INSTANCE_ID}-gateway`;
export const FIXTURE_DASHBOARD = `agent-${FIXTURE_INSTANCE_ID}-official-dashboard`;

const python = process.env.HERMES_CONFIG_TEST_PYTHON || "python3";

const FAKE_DOCKER = `#!/bin/sh
[ "\${FAKE_DOCKER_DOWN:-}" = 1 ] && exit 1
state_for() {
  case "$1" in
    *-official-dashboard) printf '%s' "\${FAKE_DASH_STATE:-absent}" ;;
    *-gateway) printf '%s' "\${FAKE_GW_STATE:-absent}" ;;
    *) printf absent ;;
  esac
}
case "$1" in
  inspect)
    [ "\${FAKE_DOCKER_HANG:-}" = all ] && exec sleep 600
    for name in "$@"; do :; done
    [ "\${FAKE_INSPECT_FAIL:-}" = 1 ] && exit 1
    s="$(state_for "$name")"
    [ "$s" = absent ] && exit 1
    printf '%s\\n' "$s"
    ;;
  ps)
    [ "\${FAKE_DOCKER_HANG:-}" = all ] && exec sleep 600
    [ "\${FAKE_GW_STATE:-absent}" = absent ] || printf '%s\\n' "agent-\${FAKE_INST}-gateway"
    [ "\${FAKE_DASH_STATE:-absent}" = absent ] || printf '%s\\n' "agent-\${FAKE_INST}-official-dashboard"
    printf '%s\\n' "unrelated-sidecar"
    ;;
  exec)
    case "\${FAKE_DOCKER_HANG:-}" in exec|all) exec sleep 600 ;; esac
    shift 2
    target="$1"
    shift
    case "$target" in
      *-gateway) [ "\${FAKE_GW_EXEC_FAIL:-}" = 1 ] && exit 126 ;;
      *) [ "\${FAKE_DASH_EXEC_FAIL:-}" = 1 ] && exit 126 ;;
    esac
    [ -n "\${FAKE_EXEC_LOG:-}" ] && printf '%s %s\\n' "$target" "$1" >> "$FAKE_EXEC_LOG"
    shift 3
    exec "$FAKE_PYTHON" - "$FAKE_ROOT" "$@"
    ;;
  *) exit 1 ;;
esac
`;

const FAKE_TIMEOUT = `#!/usr/bin/env bash
secs="$1"
shift
"$@" <&0 &
pid=$!
( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
watcher=$!
wait "$pid"
rc=$?
if kill -0 "$watcher" 2>/dev/null; then
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  exit "$rc"
fi
exit 124
`;

export type ContainerFixture = "absent" | { running: boolean; startedAt: number };

export interface FakeDockerEnv {
  gateway?: ContainerFixture;
  dashboard?: ContainerFixture;
  inspectFails?: boolean;
  dockerDown?: boolean;
  hang?: "exec" | "all";
  gatewayExecFails?: boolean;
  dashboardExecFails?: boolean;
}

export const nowS = () => Math.floor(Date.now() / 1000);

function containerState(fixture: ContainerFixture | undefined): string {
  if (!fixture || fixture === "absent") return "absent";
  return `${fixture.running} ${new Date(fixture.startedAt * 1000).toISOString()}`;
}

export function runningSince(startedAt: number): ContainerFixture {
  return { running: true, startedAt };
}

export function stoppedSince(startedAt: number): ContainerFixture {
  return { running: false, startedAt };
}

export interface ActivityBox {
  dir: string;
  root: string;
  execLog: string;
  /** Run a bash script against the fixture; returns the process result and wall time. */
  run(script: string, env?: FakeDockerEnv): SpawnSyncReturns<string> & { elapsedMs: number };
  /** Containers the probe ran in, in order. */
  execTargets(): string[];
  writeGatewayState(state: { activeAgents?: number; updatedAt?: number; raw?: string }): void;
  writeTurnMarker(relativeDir: string, startedAt: number, body?: string): string;
  cleanup(): void;
}

export function createActivityBox(prefix: string, instanceId: string = FIXTURE_INSTANCE_ID): ActivityBox {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const root = join(dir, "hermes-home");
  const fakeBin = join(dir, "bin");
  const execLog = join(dir, "exec.log");
  mkdirSync(root, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER);
  chmodSync(join(fakeBin, "docker"), 0o755);
  writeFileSync(join(fakeBin, "timeout"), FAKE_TIMEOUT);
  chmodSync(join(fakeBin, "timeout"), 0o755);

  return {
    dir,
    root,
    execLog,
    run(script, env = {}) {
      writeFileSync(execLog, "");
      const started = Date.now();
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_ROOT: root,
          FAKE_PYTHON: python,
          FAKE_INST: instanceId,
          FAKE_EXEC_LOG: execLog,
          FAKE_GW_STATE: containerState(env.gateway),
          FAKE_DASH_STATE: containerState(env.dashboard),
          ...(env.inspectFails ? { FAKE_INSPECT_FAIL: "1" } : {}),
          ...(env.dockerDown ? { FAKE_DOCKER_DOWN: "1" } : {}),
          ...(env.hang ? { FAKE_DOCKER_HANG: env.hang } : {}),
          ...(env.gatewayExecFails ? { FAKE_GW_EXEC_FAIL: "1" } : {}),
          ...(env.dashboardExecFails ? { FAKE_DASH_EXEC_FAIL: "1" } : {}),
        },
      });
      return Object.assign(result, { elapsedMs: Date.now() - started });
    },
    execTargets() {
      const log = spawnSync("cat", [execLog], { encoding: "utf8" }).stdout;
      return log
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")[0]);
    },
    writeGatewayState({ activeAgents = 0, updatedAt, raw }) {
      const path = join(root, "gateway_state.json");
      if (raw !== undefined) {
        writeFileSync(path, raw);
        return;
      }
      const stamp = new Date((updatedAt ?? nowS()) * 1000).toISOString().replace("Z", "+00:00");
      writeFileSync(path, JSON.stringify({ gateway_state: "running", updated_at: stamp, active_agents: activeAgents }));
    },
    writeTurnMarker(relativeDir, startedAt, body) {
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
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
