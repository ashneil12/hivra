import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { buildClassicHolderIdleProbe } from "../classic-holder-idle-probe";
import { createActivityBox, FIXTURE_INSTANCE_ID, nowS, runningSince } from "./agent-activity-fixture";

it("requires current proof from both Classic containers, message history, sockets, channels and scheduled jobs", () => {
  const box = createActivityBox("classic-holder-activity-");
  try {
    const program = buildClassicHolderIdleProbe(FIXTURE_INSTANCE_ID);
    const containers = { gateway: runningSince(nowS() - 600), dashboard: runningSince(nowS() - 600) };
    const run = () => box.run(program, containers);
    const state = (overrides = {}) => box.writeGatewayState({ raw: JSON.stringify({
      gateway_state: "running", active_agents: 0, platforms: { api_server: {} },
      updated_at: new Date().toISOString(), ...overrides,
    }) });
    const sql = (command: string) => {
      const proc = spawnSync("python3", ["-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()",
        join(box.root, "state.db"), command]);
      expect(proc.status).toBe(0);
    };
    const ss = join(box.dir, "bin", "ss");
    writeFileSync(ss, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(box.dir, "bin", "nsenter"), '#!/bin/sh\nshift 3; exec "$@"\n', { mode: 0o755 });
    sql("create table messages(timestamp real)");
    state();
    expect(run().stdout.trim()).toBe("CLASSIC_IDLE");
    state({ active_agents: 1 });
    expect(run().status).not.toBe(0);
    state({ updated_at: "2000-01-01T00:00:00Z" });
    expect(run().status).not.toBe(0);
    state({ platforms: { telegram: { state: "connected" } } });
    expect(run().status).not.toBe(0);
    state();
    sql("insert into messages values(unixepoch())");
    expect(run().status).not.toBe(0);
    sql("update messages set timestamp=unixepoch()-241");
    const jobs = join(box.root, "cron", "jobs.json");
    mkdirSync(join(box.root, "cron"));
    writeFileSync(jobs, JSON.stringify({jobs:[{enabled:true}]}));
    expect(run().status).not.toBe(0);
    unlinkSync(jobs);
    expect(run().stdout.trim()).toBe("CLASSIC_IDLE");
    writeFileSync(ss, "#!/bin/sh\necho established\n");
    expect(run().status).not.toBe(0);
    writeFileSync(ss, "#!/bin/sh\nexit 0\n");
    box.writeTurnMarker("", nowS());
    expect(run().status).not.toBe(0);
    expect(box.run(program, {...containers, dockerDown:true}).status).not.toBe(0);
  } finally { box.cleanup(); }
});
