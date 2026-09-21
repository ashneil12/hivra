import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DESKTOP_PREPARE_GUEST_PROGRAM, parseDesktopPrepareReceipt } from "../desktop-prepare-guest";

const identity = { operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
  vmid: 1123, guestIp: "10.241.0.23", bindingTag: "hivra-bind-" + "a".repeat(32) };
const boot = "33333333-3333-4333-8333-333333333333";

describe("durable desktop preparation guest receipt", () => {
  let directory: string;
  let program: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "hivra-prepare-test-"));
    // Exercise the production Python program with only filesystem/UID/boot
    // fixtures substituted. No service, QGA, network, or real guest access.
    program = DESKTOP_PREPARE_GUEST_PROGRAM
      .replace("pathlib.Path('/var/lib/hivra/desktop-preparations')", `pathlib.Path(${JSON.stringify(path.join(directory, "journal"))})`)
      .replaceAll("info.st_uid!=0", "info.st_uid!=os.geteuid()")
      .replace("pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()", JSON.stringify(boot));
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
  function execute(mode: "run" | "observe", command: string) {
    return spawnSync("python3", ["-I", "-B", "-c", program, JSON.stringify(identity), mode,
      "python3", "-c", command], { encoding: "utf8", timeout: 5_000 });
  }
  const readJournal = (directory: string) => JSON.parse(readFileSync(path.join(directory, "journal", `${identity.operationId}.json`), "utf8"));

  it.each([0, 7])("records explicit exit %s and observes it without redispatch", code => {
    const marker = path.join(directory, "executions");
    const command = `import pathlib,sys; pathlib.Path(${JSON.stringify(marker)}).open('a').write('once\\n'); sys.exit(${code})`;
    const first = execute("run", command);
    expect(first.status).toBe(0);
    expect(parseDesktopPrepareReceipt(first.stdout, identity)).toEqual({ ...identity, version: 1, bootId: boot, exitCode: code });
    expect(execute("observe", command).status).toBe(0);
    expect(execute("run", command).status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("once\n");
  });

  it("keeps a killed installer nonterminal and refuses redispatch or completion", () => {
    const killed = execute("run", "import os,signal; os.kill(os.getpid(),signal.SIGTERM)");
    expect(killed.status).toBe(1);
    expect(parseDesktopPrepareReceipt(killed.stdout, identity)).toBeNull();
    expect(readJournal(directory)).toEqual({ ...identity, version: 1, bootId: boot, phase: "started" });
    const forbidden = "raise RuntimeError('must not redispatch')";
    expect(execute("observe", forbidden).status).toBe(1);
    expect(execute("run", forbidden).status).toBe(1);
    expect(readJournal(directory).phase).toBe("started");
  });

  it("does not turn ambiguous subprocess errors into terminal evidence", () => {
    program = program.replace("result=subprocess.run(", "result=ambiguous_wait(")
      .replace("identity=json.loads", "def ambiguous_wait(*args,**kwargs): raise OSError('unknown wait outcome')\nidentity=json.loads");
    const result = execute("run", "pass");
    expect(result.status).toBe(1);
    expect(parseDesktopPrepareReceipt(result.stdout, identity)).toBeNull();
    expect(readJournal(directory).phase).toBe("started");
  });

  it("fails closed for missing, mismatched, duplicate, and malformed terminal receipts", () => {
    expect(execute("observe", "pass").status).toBe(1);
    const output = execute("run", "pass").stdout;
    expect(parseDesktopPrepareReceipt(output + output, identity)).toBeNull();
    expect(parseDesktopPrepareReceipt(output, { ...identity, vmid: 1124 })).toBeNull();
    expect(parseDesktopPrepareReceipt(output.replace('"exitCode":0', '"exitCode":null'), identity)).toBeNull();
    expect(parseDesktopPrepareReceipt(output.replace('"exitCode":0', '"exitCode":0,"extra":true'), identity)).toBeNull();
  });
});
