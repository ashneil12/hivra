/** @jest-environment node */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildKitGuestScript, HIVRA_COMPUTERS_CLI, KIT_GUEST_PROGRAM, parseKitOutput, renderComputersNote,
  renderComputersSkill } from "../kit-program";

const computers = [{ id: "11111111-1111-4111-8111-111111111111", name: "Studio", kind: "Ubuntu desktop" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Omarchy `x`", kind: "Omarchy desktop" }];

function hasPython(): boolean {
  try { execFileSync("python3", ["-c", "pass"]); return true; } catch { return false; }
}

describe("agent link kit", () => {
  it("tells the agent which computers it has and how to use them", () => {
    const note = renderComputersNote("Claude", computers);
    expect(note).toContain("Studio (Ubuntu desktop)");
    expect(note).toContain("hivra-computers run <computer> -- <command>");
    expect(note).not.toContain("`x`");
    const skill = renderComputersSkill(computers);
    expect(skill.startsWith("---\nname: hivra-computers\ndescription: ")).toBe(true);
    expect(skill).toContain("(Studio, Omarchy x)");
  });

  it("is one script both seed lanes accept, with the request only base64 encoded", () => {
    const script = buildKitGuestScript({ mode: "install", cli: HIVRA_COMPUTERS_CLI,
      link: { endpoint: "https://canary.example.test/api/agent-link", key: `hvl_${"b".repeat(64)}`, agentId: "a" }, note: "n", skill: "s" });
    expect(script.startsWith("set -e\n")).toBe(true);
    expect(script).not.toContain("canary.example.test");
  });

  it("reads exactly one answer", () => {
    expect(parseKitOutput('HIVRA_LINK_KIT {"status":"delivered","mode":"install"}\n')).toEqual({ status: "delivered", mode: "install" });
    expect(parseKitOutput('HIVRA_LINK_KIT {"status":"refused","reason":"no_agent_user"}')).toEqual({ status: "refused", reason: "no_agent_user" });
    expect(parseKitOutput('HIVRA_LINK_KIT {"status":"delivered","mode":"other"}')).toBeNull();
    expect(parseKitOutput("")).toBeNull();
  });

  const python = hasPython() ? it : it.skip;
  python("ships a CLI that compiles and answers without a link", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-cli-"));
    const cli = path.join(dir, "hivra-computers");
    fs.writeFileSync(cli, HIVRA_COMPUTERS_CLI);
    execFileSync("python3", ["-c", `compile(open(${JSON.stringify(cli)}).read(), "cli", "exec")`]);
    const result = spawnSync("python3", [cli, "list"], { env: { ...process.env, HOME: dir } });
    expect(result.status).toBe(2);
    expect(result.stderr.toString()).toMatch(/no computers are linked/);
  });

  const root = process.getuid?.() === 0 && hasPython() && spawnSync("id", ["bux"]).status === 0 ? it : it.skip;
  root("installs and removes the kit in the agent user's home", () => {
    const home = execFileSync("sh", ["-c", "getent passwd bux | cut -d: -f6"]).toString().trim();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    execFileSync("chown", ["bux:bux", path.join(home, ".claude")]);
    const run = (request: object) => parseKitOutput(execFileSync("python3", ["-I", "-B", "-c", KIT_GUEST_PROGRAM],
      { input: Buffer.from(JSON.stringify(request)).toString("base64") }).toString());
    const link = { endpoint: "https://canary.example.test/api/agent-link", key: `hvl_${"c".repeat(64)}`, agentId: "a" };
    expect(run({ mode: "install", cli: HIVRA_COMPUTERS_CLI, link, note: "note", skill: "skill" })).toEqual({ status: "delivered", mode: "install" });
    expect(JSON.parse(fs.readFileSync(path.join(home, ".hivra/link.json"), "utf8"))).toEqual(link);
    expect(fs.statSync(path.join(home, ".hivra/link.json")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(home, ".claude/skills/hivra-computers/SKILL.md"), "utf8")).toBe("skill");
    expect(fs.statSync("/usr/local/bin/hivra-computers").mode & 0o777).toBe(0o755);
    expect(run({ mode: "remove", cli: HIVRA_COMPUTERS_CLI })).toEqual({ status: "delivered", mode: "remove" });
    expect(fs.existsSync(path.join(home, ".hivra/link.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude/skills/hivra-computers"))).toBe(false);
  });
});
