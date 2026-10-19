/** @jest-environment node */
import { execFileSync, spawnSync } from "node:child_process";
import { buildLinkExecHostScript, buildLinkExecPayload, LINK_EXEC_GUEST_PROGRAM, LINK_EXEC_STDOUT_MAX, parseLinkExecOutput,
  validExecRequest } from "../exec-program";

const TAG = `hivra-bind-${"a".repeat(32)}`;

function hasPython(): boolean {
  try { execFileSync("python3", ["-c", "pass"]); return true; } catch { return false; }
}
function hasUser(): boolean {
  return spawnSync("id", ["bux"]).status === 0;
}

describe("agent link exec program", () => {
  it("puts only the checked VMID, tag and limit in the host script", () => {
    const script = buildLinkExecHostScript({ vmid: 123, bindingTag: TAG }, 60);
    expect(script).toContain("VMID=123");
    expect(script).toContain(`EXPECTED_BINDING_TAG='${TAG}'`);
    expect(script).toContain("refuse binding_mismatch");
    expect(script).toContain("refuse computer_not_running");
    expect(script).toContain("--pass-stdin 1");
    // The command never rides in the script; it comes on stdin.
    expect(script).not.toContain("rm -rf");
    expect(() => buildLinkExecHostScript({ vmid: 1, bindingTag: TAG }, 60)).toThrow();
    expect(() => buildLinkExecHostScript({ vmid: 123, bindingTag: "hivra-bind-x; reboot" }, 60)).toThrow();
    expect(() => buildLinkExecHostScript({ vmid: 123, bindingTag: TAG }, 121)).toThrow();
  });

  it("checks requests", () => {
    expect(validExecRequest({ command: "uname -a", timeoutSeconds: 60 })).toBe(true);
    expect(validExecRequest({ command: "  ", timeoutSeconds: 60 })).toBe(false);
    expect(validExecRequest({ command: "a\0b", timeoutSeconds: 60 })).toBe(false);
    expect(validExecRequest({ command: "ls", timeoutSeconds: 0 })).toBe(false);
    expect(validExecRequest({ command: "ls", timeoutSeconds: 60, stdin: Buffer.alloc(600 * 1024) })).toBe(false);
  });

  it("reads exactly one answer line", () => {
    const line = (fields: Record<string, unknown>) => `HIVRA_LINK_EXEC ${JSON.stringify(fields)}`;
    const ran = { status: "ran", exitCode: 3, stdout: Buffer.from("hi").toString("base64"), stderr: "", stdoutTruncated: false,
      stderrTruncated: false, timedOut: false, durationMs: 5, user: "bux" };
    const parsed = parseLinkExecOutput(`noise\n${line(ran)}\n`);
    expect(parsed?.status).toBe("ran");
    expect(parsed?.status === "ran" && parsed.stdout.toString()).toBe("hi");
    expect(parseLinkExecOutput("HIVRA_LINK_REFUSED computer_not_running\n")).toEqual({ status: "refused", reason: "computer_not_running" });
    expect(parseLinkExecOutput(line({ status: "refused", reason: "no_user" }))).toEqual({ status: "refused", reason: "no_user" });
    expect(parseLinkExecOutput(`${line(ran)}\n${line(ran)}`)).toBeNull();
    expect(parseLinkExecOutput(line({ ...ran, exitCode: 300 }))).toBeNull();
    expect(parseLinkExecOutput(line({ ...ran, stdout: Buffer.alloc(LINK_EXEC_STDOUT_MAX + 1).toString("base64") }))).toBeNull();
    expect(parseLinkExecOutput("HIVRA_LINK_REFUSED $(reboot)")).toBeNull();
    expect(parseLinkExecOutput("")).toBeNull();
  });

  // The guest program itself, as root with a bux user, the way the guest agent runs it.
  const guest = process.getuid?.() === 0 && hasPython() && hasUser() ? it : it.skip;
  guest("runs the command as the computer's user with stdin, a time limit and capped output", () => {
    const run = (command: string, stdin = "", timeoutSeconds = 5) => {
      const out = execFileSync("python3", ["-I", "-B", "-c", LINK_EXEC_GUEST_PROGRAM],
        { input: buildLinkExecPayload({ command, stdin: Buffer.from(stdin), timeoutSeconds }) }).toString();
      return parseLinkExecOutput(out);
    };
    const first = run("whoami; cat; echo oops >&2; exit 4", "piped");
    expect(first).toMatchObject({ status: "ran", exitCode: 4, timedOut: false });
    expect(first?.status === "ran" && first.stdout.toString()).toBe("bux\npiped");
    expect(first?.status === "ran" && first.stderr.toString()).toBe("oops\n");
    expect(run("sleep 5", "", 1)).toMatchObject({ status: "ran", timedOut: true });
    const big = run(`head -c ${LINK_EXEC_STDOUT_MAX + 1000} /dev/zero`);
    expect(big).toMatchObject({ status: "ran", stdoutTruncated: true });
    expect(big?.status === "ran" && big.stdout.length).toBe(LINK_EXEC_STDOUT_MAX);
  });
});
