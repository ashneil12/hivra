import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildNoForkMigrationLauncher,
  buildNoForkMigrationScript,
  NOFORK_COMPOSE_PY,
  NOFORK_MANIFEST_PY,
  NOFORK_UPSTREAM_ALIAS,
} from "@/lib/services/no-fork-migration-builder";

const INST = "11111111-1111-4111-8111-111111111111";
const OVERLAY = `ghcr.io/ashneil12/hivra-hermes@sha256:${"a".repeat(64)}`;
const UPSTREAM = `nousresearch/hermes-agent@sha256:${"b".repeat(64)}`;

describe("no-fork migration script", () => {
  const script = buildNoForkMigrationScript({ instanceId: INST, overlayImage: OVERLAY });

  it("is valid bash with no placeholder left in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nofork-"));
    const file = join(dir, "migrate.sh");
    writeFileSync(file, script);
    const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(script).not.toMatch(/@[A-Z_]+@/);
  });

  it("refuses unsafe input before writing anything", () => {
    expect(() => buildNoForkMigrationScript({ instanceId: "x; rm -rf /", overlayImage: OVERLAY })).toThrow();
    expect(() => buildNoForkMigrationScript({ instanceId: INST, overlayImage: "img; reboot" })).toThrow();
    expect(() => buildNoForkMigrationScript({ instanceId: INST, overlayImage: OVERLAY, expectUpstreamImage: "nousresearch/hermes-agent:stable" })).toThrow(/digest/);
    expect(() => buildNoForkMigrationScript({ instanceId: INST, overlayImage: OVERLAY, expectUpstreamImage: `evil.example/x@sha256:${"c".repeat(64)}` })).toThrow(/nousresearch/);
  });

  it("only ever moves onto the official upstream repository, pinned by digest", () => {
    expect(script).toContain('case "$UPSTREAM_IMAGE" in nousresearch/hermes-agent@sha256:*)');
    expect(script).toContain("the downloaded version does not match its pinned digest");
    const pinned = buildNoForkMigrationScript({ instanceId: INST, overlayImage: OVERLAY, expectUpstreamImage: UPSTREAM });
    expect(pinned).toContain(`EXPECT_UPSTREAM="${UPSTREAM}"`);
  });

  it("checks health, idle, disk and the box's data before it changes anything, and refuses safely", () => {
    const preflight = script.slice(script.indexOf("phase 1: preflight"), script.indexOf("phase 2: snapshot"));
    for (const needle of ["not healthy", "compose file does not validate", "not enough free disk", "idle minutes", "already on upstream"]) {
      expect(preflight).toContain(needle);
    }
    // nothing in preflight stops, tags, or edits anything of the box
    expect(preflight).not.toMatch(/docker compose (stop|up)|docker tag|docker volume create|systemctl stop/);
  });

  it("takes the backup before it switches, and every switching failure rolls back", () => {
    const snapshotAt = script.indexOf("tar -C \"$STATE_DIR\"");
    const composeEditAt = script.indexOf("compose_edit.py\" \"$DIR/docker-compose.yml\"");
    expect(snapshotAt).toBeGreaterThan(0);
    expect(composeEditAt).toBeGreaterThan(snapshotAt);
    const switching = script.slice(script.indexOf("phase 3: switching"), script.indexOf("phase 5: finishing"));
    const unguarded = switching.split("\n").filter((l) => /docker (cp|create|compose up)|compose_edit|reseed_agent_source|assemble_local_image/.test(l) && !/rollback|^\s*#|\(\)|^assemble|^reseed/.test(l));
    expect(unguarded).toEqual([]);
  });

  it("verifies image, API, overlay and the user's data, and rolls back on any miss", () => {
    const verifying = script.slice(script.indexOf("phase 4: verifying"), script.indexOf("phase 5: finishing"));
    for (const needle of [
      "did not become healthy",
      "not running the new image",
      "API did not answer",
      "add-on files did not load",
      "something in your data changed",
      "chats were lost",
    ]) {
      expect(verifying).toContain(`rollback "${needle}`.replace(`rollback "`, "") || needle);
    }
    expect((verifying.match(/rollback "/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("restores everything on rollback: compose, env, config, the state volume, the agent files, the web bundles and the update units", () => {
    const rb = script.slice(script.indexOf("rollback() {"), script.indexOf("revert (operator"));
    for (const needle of ["docker-compose.yml", "state.tgz", "SOURCE_BACKUP_VOL", "webchat", "units", "state-at-revert", "manifest.py\" compare"]) {
      expect(rb).toContain(needle);
    }
    // a rollback that cannot prove the data identical says so instead of claiming success
    expect(rb).toContain("Rollback needs attention");
  });

  it("never touches the workspace volume and never deletes the old image on success", () => {
    expect(script).not.toMatch(/rm -rf[^\n]*\$WORK_DIR/);
    expect(script).not.toMatch(/tar [^\n]*\$WORK_DIR/);
    const finishing = script.slice(script.indexOf("phase 5: finishing"));
    expect(finishing).not.toContain("docker rmi");
  });

  it("installs the self-update stack that follows upstream directly, pointed at the local image", () => {
    const decoded = (() => {
      const m = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| gunzip \| bash/.exec(script);
      expect(m).not.toBeNull();
      return gunzipSync(Buffer.from(m![1], "base64")).toString("utf8");
    })();
    expect(script).toContain(': > "$DIRECT"');
    expect(NOFORK_UPSTREAM_ALIAS).toBe("hivra-local/hermes:stable");
    // the roll script inside names the local repository, not the Hivra fork
    const roll = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| gunzip > \/usr\/local\/bin\/hermes-roll/.exec(decoded);
    expect(roll).not.toBeNull();
    const rollText = gunzipSync(Buffer.from(roll![1], "base64")).toString("utf8");
    expect(rollText).toContain('REPO="hivra-local/hermes"');
    expect(rollText).toContain("hermes-upstream-direct-");
    expect(rollText).not.toContain("vanilla-hermes-agent");
  });

  it("launches detached so the move survives the SSH session", () => {
    const launcher = buildNoForkMigrationLauncher(script, INST, { skipIdleGate: true });
    expect(launcher).toContain("systemd-run --unit=hermes-nofork-migrate-");
    expect(launcher).toContain("--setenv=HERMES_MIGRATE_FORCE=1");
    expect(buildNoForkMigrationLauncher(script, INST)).not.toContain("HERMES_MIGRATE_FORCE");
  });
});

// ---- the embedded python tools, run for real -------------------------------------------------------

function py(file: string, source: string, args: string[]) {
  writeFileSync(file, source);
  return spawnSync("python3", [file, ...args], { encoding: "utf8" });
}

describe("data manifest (what proves the user's data survived)", () => {
  let dir: string;
  let tool: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nofork-manifest-"));
    tool = join(dir, "manifest.py");
    const state = join(dir, "state");
    for (const sub of ["skills/custom/atlas", "skills/github/pr-workflow", "memories", "cron"]) mkdirSync(join(state, sub), { recursive: true });
    mkdirSync(join(dir, "work/atlas"), { recursive: true });
    writeFileSync(join(state, "skills/custom/atlas/SKILL.md"), "user skill\n");
    writeFileSync(join(state, "skills/github/pr-workflow/SKILL.md"), "bundled v1\n");
    writeFileSync(join(state, "skills/.bundled_manifest"), "pr-workflow:abc\n");
    writeFileSync(join(state, "memories/MEMORY.md"), "remember Atlas\n");
    writeFileSync(join(state, "config.yaml"), "model:\n  default: m1\nterminal:\n  cwd: /workspace\n");
    writeFileSync(join(state, ".env"), "API_SERVER_KEY=x\nHERMES_HOME=/old\nTELEGRAM_BOT_TOKEN=t\n");
    writeFileSync(join(dir, "work/atlas/README.md"), "workspace\n");
    spawnSync("python3", ["-c", `import sqlite3;c=sqlite3.connect("${join(state, "state.db")}");c.execute("create table sessions(id integer primary key, title text)");c.executemany("insert into sessions(title) values (?)",[("a",),("b",),("c",)]);c.commit()`]);
    writeFileSync(tool, NOFORK_MANIFEST_PY);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const manifest = (out: string, modified: string[] = []) => {
    const mod = join(dir, "modified.json");
    writeFileSync(mod, JSON.stringify(modified));
    const r = spawnSync("python3", [tool, "manifest", join(dir, "state"), join(dir, "work"), join(dir, out), mod], { encoding: "utf8" });
    expect(r.status).toBe(0);
  };
  const compare = (extra: string[] = []) => spawnSync("python3", [tool, "compare", join(dir, "before.json"), join(dir, "after.json"), ...extra], { encoding: "utf8" });

  it("passes when nothing changed", () => {
    manifest("before.json");
    manifest("after.json");
    expect(compare().status).toBe(0);
  });

  it("fails when a chat, a user skill, a memory or a workspace file is lost or changed", () => {
    manifest("before.json");
    const state = join(dir, "state");
    rmSync(join(state, "skills/custom/atlas/SKILL.md"));
    writeFileSync(join(state, "memories/MEMORY.md"), "changed\n");
    rmSync(join(dir, "work/atlas/README.md"));
    spawnSync("python3", ["-c", `import sqlite3;c=sqlite3.connect("${join(state, "state.db")}");c.execute("delete from sessions where id=2");c.commit()`]);
    manifest("after.json");
    const r = compare();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("missing file: skills/custom/atlas/SKILL.md");
    expect(r.stdout).toContain("changed file: memories/MEMORY.md");
    expect(r.stdout).toContain("missing workspace file: atlas/README.md");
    expect(r.stdout).toContain("rows lost: state.db.sessions 3 -> 2");
  });

  it("lets Hermes refresh a bundled skill but never a bundled skill the user edited", () => {
    const skill = join(dir, "state/skills/github/pr-workflow/SKILL.md");
    manifest("before.json", []);
    writeFileSync(skill, "bundled v2\n");
    manifest("after.json");
    expect(compare().status).toBe(0);

    writeFileSync(skill, "bundled v1\n");
    manifest("before.json", ["pr-workflow"]);
    writeFileSync(skill, "bundled v2\n");
    manifest("after.json");
    const r = compare();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("changed file: skills/github/pr-workflow/SKILL.md");
  });

  it("allows added settings and the one dropped env line, nothing else", () => {
    manifest("before.json");
    writeFileSync(join(dir, "state/config.yaml"), "model:\n  default: m1\nterminal:\n  cwd: /workspace\nimage_gen:\n  provider: venice\n");
    writeFileSync(join(dir, "state/.env"), "API_SERVER_KEY=x\nTELEGRAM_BOT_TOKEN=t\n");
    manifest("after.json");
    expect(compare(["HERMES_HOME"]).status).toBe(0);
    expect(compare().stdout).toContain("env key gone: HERMES_HOME");

    writeFileSync(join(dir, "state/config.yaml"), "model:\n  default: m2\nterminal:\n  cwd: /workspace\n");
    writeFileSync(join(dir, "state/.env"), "API_SERVER_KEY=x\nHERMES_HOME=/old\n");
    manifest("after.json");
    const r = compare();
    expect(r.stdout).toContain("config setting changed: /model/default");
    expect(r.stdout).toContain("env key gone: TELEGRAM_BOT_TOKEN");
  });
});

describe("compose edit", () => {
  const compose = (a: string, b: string) =>
    `services:\n  gateway:\n    image: ${a}\n  official-dashboard:\n    image: ${b}\n  autoheal:\n    image: willfarrell/autoheal:latest\n`;
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "nofork-compose-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("points exactly the two agent services at the local image and leaves the rest alone", () => {
    const file = join(dir, "docker-compose.yml");
    writeFileSync(file, compose("ghcr.io/ashneil12/vanilla-hermes-agent:stable", "ghcr.io/ashneil12/vanilla-hermes-agent:stable"));
    const r = py(join(dir, "edit.py"), NOFORK_COMPOSE_PY, [file, NOFORK_UPSTREAM_ALIAS]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ghcr.io/ashneil12/vanilla-hermes-agent");
    const out = readFileSync(file, "utf8");
    expect(out.match(/image: hivra-local\/hermes:stable/g)).toHaveLength(2);
    expect(out).toContain("willfarrell/autoheal:latest");
  });

  it("refuses an unexpected shape without writing", () => {
    const file = join(dir, "docker-compose.yml");
    const odd = compose("ghcr.io/ashneil12/vanilla-hermes-agent:stable", "ghcr.io/ashneil12/vanilla-hermes-agent-canary:stable");
    writeFileSync(file, odd);
    expect(py(join(dir, "edit.py"), NOFORK_COMPOSE_PY, [file, NOFORK_UPSTREAM_ALIAS]).status).toBe(3);
    writeFileSync(file, "services:\n  gateway:\n    image: node:22\n");
    expect(py(join(dir, "edit.py"), NOFORK_COMPOSE_PY, [file, NOFORK_UPSTREAM_ALIAS]).status).toBe(2);
    expect(readFileSync(file, "utf8")).toContain("node:22");
  });
});
