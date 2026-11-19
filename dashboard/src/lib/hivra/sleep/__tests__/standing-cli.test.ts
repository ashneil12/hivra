/** @jest-environment node */
// A coding CLI left open in the computer's own tmux must not keep the computer
// awake by being there: it is busy only while it prints. Both idle probes are
// run for real against real tmux sessions.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { idleProbeProgramFor } from "../../agent-sleep-scripts";
import { probeProfileFor, type ProbeProfile } from "../../agent-profiles";
import { IDLE_PROBE_PREFIX, IDLE_PROBE_PROGRAM } from "../idle-probe-program";

const has = (cmd: string, arg: string) => spawnSync(cmd, [arg]).status === 0;
const run = has("python3", "--version") && has("tmux", "-V") && has("bash", "--version") ? describe : describe.skip;

run("a standing coding CLI in tmux", () => {
  const SOCK = `hivra-test-${process.pid}`;
  const NAME = `hivrastand${process.pid}`;
  const tmux = (...args: string[]) => spawnSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });
  /** A pane whose process's command line starts with the given name, the way a CLI's does. */
  const pane = (session: string, name: string, script: string) =>
    expect(tmux("new-session", "-d", "-s", session, `exec bash -c 'exec -a ${name} bash -c "${script}"'`).status).toBe(0);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let outside: ChildProcess | null = null;
  afterEach(() => {
    tmux("kill-server");
    outside?.kill("SIGKILL");
    outside = null;
  });

  /** Points the probe's tmux call at the test's own server instead of the computer's. */
  const here = (program: string) => {
    const call = '["/usr/sbin/runuser", "-u", "bux", "--", "tmux", "-L", sock,';
    expect(program).toContain(call);
    return program.replace(call, '["tmux", "-L", sock,').replace('("hivra-agent", "hivra-box")', `(${JSON.stringify(SOCK)},)`);
  };
  const exec = (program: string) => {
    const r = spawnSync("python3", ["-I", "-B", "-c", here(program)], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout.slice(IDLE_PROBE_PREFIX.length)) as { cliProcesses: number; lastUsedAt: string | null; terminalAttached: boolean };
  };
  const base = probeProfileFor("claude-code", { cpu: null });
  const profile: ProbeProfile = { ...base, profile: { ...base.profile, busy: [{ cmd: `(^|/)${NAME}( |$)` }] } };
  const programs: [string, string][] = [
    ["plain", IDLE_PROBE_PROGRAM.replace("(claude|codex)", `(${NAME})`)],
    ["profile", idleProbeProgramFor({ profile })],
  ];

  it.each(programs)("%s probe: open and quiet in tmux is not busy; the same CLI run anywhere else is", async (_label, program) => {
    const before = exec(program).cliProcesses;
    pane("quiet", NAME, "sleep 60; exit 0");
    await wait(300);
    const pid = tmux("list-panes", "-a", "-F", "#{pane_pid}").stdout.trim();
    expect(spawnSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8" }).stdout).toContain(NAME);
    const standing = exec(program);
    expect(standing.cliProcesses).toBe(before);
    expect(standing.terminalAttached).toBe(false);

    outside = spawn("bash", ["-c", `exec -a ${NAME} sleep 60`], { stdio: "ignore" });
    await wait(300);
    expect(exec(program).cliProcesses).toBe(before + 1);
  });

  it.each(programs)("%s probe: a CLI that is printing counts as in use now, a quiet one does not", async (_label, program) => {
    pane("quiet", NAME, "sleep 60; exit 0");
    await wait(2_600);
    const quiet = Date.parse(exec(program).lastUsedAt ?? "");
    expect(Date.now() - quiet).toBeGreaterThan(2_000);

    pane("working", NAME, "while :; do echo working; sleep 0.2; done");
    await wait(2_600);
    const result = exec(program);
    expect(result.cliProcesses).toBe(exec(program).cliProcesses);
    expect(Date.now() - Date.parse(result.lastUsedAt ?? "")).toBeLessThan(2_000);
  }, 20_000);
});
