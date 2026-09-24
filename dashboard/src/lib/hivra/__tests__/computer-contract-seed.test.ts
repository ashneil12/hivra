/** @jest-environment node */
// Runs the real guest program (python3) against a temporary home, so the
// compare-and-swap, read-back and refusal rules are exercised on real files.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderComputerContract } from "@/lib/agent-computers/computer-contract";
import { computerContractPlanFor } from "@/lib/agent-computers/computer-contract-input";
import { buildBootstrapContent, buildGuestScript } from "../agent-bootstrap";
import {
  COMPUTER_CONTRACT_GUEST_PROGRAM,
  buildComputerContractGuestScript,
  parseComputerContractGuestOutput,
  runComputerContractSeed,
  type ComputerContractGuestRequest,
} from "../computer-contract-seed";

jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
const { runProxmoxHostScript } = jest.requireMock("@/lib/services/proxmox-instance-service") as { runProxmoxHostScript: jest.Mock };

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const BASE = "# Hivra assistant — system prompt\n\nBase persona.\n";

function block(revision: number, name = "Codex 1") {
  const plan = computerContractPlanFor({ type: "codex", name, computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", cpu: 1.5, ram: 3 });
  if (plan.status !== "deliverable") throw new Error("expected a deliverable plan");
  return renderComputerContract(plan.input, revision);
}

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "hivra-contract-")));
  mkdirSync(path.join(home, ".hivra"), { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const promptPath = () => path.join(home, "system-prompt.md");

function run(request: ComputerContractGuestRequest) {
  const program = COMPUTER_CONTRACT_GUEST_PROGRAM.replace('HOME = "/home/bux"', `HOME = ${JSON.stringify(home)}`);
  expect(program).not.toBe(COMPUTER_CONTRACT_GUEST_PROGRAM);
  const output = execFileSync("python3", ["-c", program], {
    input: Buffer.from(JSON.stringify(request)).toString("base64"), encoding: "utf8",
  });
  const parsed = parseComputerContractGuestOutput(output);
  if (!parsed) throw new Error(`unparsed guest output: ${output}`);
  // Linux reports the kernel boot id; other test hosts have none.
  const { bootId, ...rest } = parsed;
  expect(bootId === null || /^[0-9a-f-]{36}$/.test(bootId)).toBe(true);
  return rest;
}

function deliver(content: string, expected: string, mode: ComputerContractGuestRequest["mode"] = "deliver", revision = 1) {
  return run({ mode, expected, revision, block: content, contentSha256: sha(content), facts: { revision } });
}

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const guest = hasPython ? describe : describe.skip;

guest("computer contract guest program", () => {
  it("appends revision 1 after the base prompt, reads it back and writes the facts file", () => {
    writeFileSync(promptPath(), BASE);
    const first = block(1);
    const result = deliver(first, "absent");
    expect(result).toEqual({ status: "delivered", revision: 1, contentSha256: sha(first), observed: sha(first), replay: false });
    expect(readFileSync(promptPath(), "utf8")).toBe(`${BASE}\n${first}\n`);
    expect(JSON.parse(readFileSync(path.join(home, ".hivra", "computer.json"), "utf8"))).toEqual({ revision: 1 });
    expect(statSync(path.join(home, ".hivra", "computer.json")).mode & 0o777).toBe(0o644);
  });

  it("replaces exactly the block it last delivered and keeps everything around it", () => {
    const first = block(1);
    writeFileSync(promptPath(), `${BASE}\n${first}\n\n<!-- HIVRA:BOOTSTRAP:START -->\nidentity\n<!-- HIVRA:BOOTSTRAP:END -->\n`, { mode: 0o640 });
    const second = block(2, "Codex 2");
    expect(deliver(second, sha(first), "deliver", 2)).toMatchObject({ status: "delivered", revision: 2, contentSha256: sha(second) });
    expect(readFileSync(promptPath(), "utf8")).toBe(`${BASE}\n${second}\n\n<!-- HIVRA:BOOTSTRAP:START -->\nidentity\n<!-- HIVRA:BOOTSTRAP:END -->\n`);
    // Mode survives the atomic replace.
    expect(statSync(promptPath()).mode & 0o777).toBe(0o640);
  });

  it("refuses to overwrite a block someone edited, and leaves the file untouched", () => {
    const first = block(1);
    const edited = first.replace("Codex 1", "Codex 1 with sudo to everything");
    writeFileSync(promptPath(), `${BASE}\n${edited}\n`);
    const before = readFileSync(promptPath(), "utf8");
    expect(deliver(block(2), sha(first), "deliver", 2)).toEqual({ status: "state_conflict", observed: sha(edited) });
    expect(readFileSync(promptPath(), "utf8")).toBe(before);
  });

  it("calls duplicated or broken markers a conflict, and Restore keeps the owner's text", () => {
    const first = block(1);
    writeFileSync(promptPath(), `${BASE}\n${first}\nmy own note\n${first}\n<!-- HIVRA:COMPUTER:START v1 rev=9 -->\ndangling text\n`);
    expect(deliver(block(2), sha(first), "deliver", 2)).toMatchObject({ status: "state_conflict", observed: "conflict" });
    const restored = block(2);
    expect(deliver(restored, "absent", "restore", 2)).toMatchObject({ status: "delivered", revision: 2 });
    const text = readFileSync(promptPath(), "utf8");
    expect(text).toBe(`${BASE}\nmy own note\ndangling text\n\n${restored}\n`);
    expect(text.split("\n").filter((line) => line.startsWith("<!-- HIVRA:COMPUTER:START"))).toHaveLength(1);
  });

  it("treats an identical re-send as a replay without rewriting the file", () => {
    const first = block(1);
    writeFileSync(promptPath(), `${BASE}\n${first}\n`);
    const before = lstatSync(promptPath()).ino;
    expect(deliver(first, "absent")).toMatchObject({ status: "delivered", replay: true, revision: 1 });
    expect(lstatSync(promptPath()).ino).toBe(before);
  });

  it("reports the current copy without writing in check mode", () => {
    const first = block(1);
    writeFileSync(promptPath(), `${BASE}\n${first}\n`);
    expect(deliver(first, "absent", "check")).toEqual({ status: "observed", observed: sha(first) });
    writeFileSync(promptPath(), BASE);
    expect(deliver(first, "absent", "check")).toMatchObject({ status: "observed", observed: "absent" });
  });

  it("never follows a symlinked instructions file and says when there is none", () => {
    const target = path.join(home, "elsewhere.md");
    writeFileSync(target, "not yours\n");
    symlinkSync(target, promptPath());
    expect(deliver(block(1), "absent")).toMatchObject({ status: "unsafe_file" });
    expect(readFileSync(target, "utf8")).toBe("not yours\n");
    rmSync(promptPath());
    expect(deliver(block(1), "absent")).toMatchObject({ status: "no_instruction_file" });
    expect(existsSync(promptPath())).toBe(false);
  });

  it("survives the one-shot identity seed rewriting the same file", () => {
    const first = block(1);
    writeFileSync(promptPath(), `${BASE}\n${first}\n`);
    const identity = buildGuestScript(buildBootstrapContent({ id: "a", name: "Codex 1", type: "codex" }))
      .replace("BUX=/home/bux", `BUX=${home}`)
      .replace(/chown [^\n]*\n/g, "true\n");
    execFileSync("bash", ["-c", identity], { encoding: "utf8" });
    const text = readFileSync(promptPath(), "utf8");
    expect(text).toContain(first);
    expect(text).toContain("<!-- HIVRA:BOOTSTRAP:START -->");
    expect(deliver(first, "absent", "check")).toMatchObject({ status: "observed", observed: sha(first) });
  });
});

describe("computer contract seed transport", () => {
  const request = (): ComputerContractGuestRequest => {
    const content = block(1);
    return { mode: "deliver", expected: "absent", revision: 1, block: content, contentSha256: sha(content), facts: {} };
  };

  it("sends the request only as base64 data, never as program text", () => {
    const script = buildComputerContractGuestScript({ ...request(), facts: { agent: "'; rm -rf / #" } });
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("Codex 1");
    expect(script).toMatch(/^set -e\n/);
  });

  it("returns a receipt only for exactly one well-formed result line", async () => {
    const line = `HIVRA_CONTRACT_RESULT ${JSON.stringify({ status: "delivered", revision: 1, contentSha256: "a".repeat(64), observed: "a".repeat(64), replay: false, bootId: null })}`;
    runProxmoxHostScript.mockResolvedValueOnce({ ok: true, stdout: `noise\n${line}\n` });
    await expect(runComputerContractSeed("10.0.0.5", request(), {})).resolves.toEqual({ ok: true, result: expect.objectContaining({ status: "delivered" }) });
    runProxmoxHostScript.mockResolvedValueOnce({ ok: true, stdout: `${line}\n${line}\n` });
    await expect(runComputerContractSeed("10.0.0.5", request(), {})).resolves.toEqual({ ok: false, error: "unrecognized_output" });
    runProxmoxHostScript.mockResolvedValueOnce({ ok: true, stdout: "HIVRA_CONTRACT_RESULT {\"status\":\"delivered\"}\n" });
    await expect(runComputerContractSeed("10.0.0.5", request(), {})).resolves.toEqual({ ok: false, error: "unrecognized_output" });
    runProxmoxHostScript.mockResolvedValueOnce({ ok: false, stdout: line, error: "ssh failed" });
    await expect(runComputerContractSeed("10.0.0.5", request(), {})).resolves.toEqual({ ok: false, error: "unreachable" });
    runProxmoxHostScript.mockRejectedValueOnce(new Error("timeout"));
    await expect(runComputerContractSeed("10.0.0.5", request(), {})).resolves.toEqual({ ok: false, error: "unreachable" });
  });

  it("refuses a bad address or a block without its markers before any host call", async () => {
    runProxmoxHostScript.mockClear();
    await expect(runComputerContractSeed("box.example.com", request(), {})).resolves.toEqual({ ok: false, error: "invalid_request" });
    await expect(runComputerContractSeed("10.0.0.5", { ...request(), block: "no markers" }, {})).resolves.toEqual({ ok: false, error: "invalid_request" });
    await expect(runComputerContractSeed("10.0.0.5", { ...request(), expected: "nope" }, {})).resolves.toEqual({ ok: false, error: "invalid_request" });
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
  });
});
