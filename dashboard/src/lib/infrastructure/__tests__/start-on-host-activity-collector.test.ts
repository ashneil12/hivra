import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Agent-run reporter step of hivra-start-on-host.sh
// (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md). The real
// step runs as root on a Proxmox host against a guest; these tests execute the
// helper's own functions and guest script with only the host/guest boundaries
// (ssh, GNU stat, coreutils timeout, fixed root paths) replaced.

const bundleRoot = path.join(process.cwd(), "provisioner");
const SCRIPT = path.join(bundleRoot, "hivra-start-on-host.sh");
const source = readFileSync(SCRIPT, "utf8");
const GUEST_DIR = "/run/hivra-agent-trace-install.AbCd1234";
const CREDENTIAL = {
  endpoint: "https://canary.hivra.cloud/api/activity/ingest",
  resourceId: "00000000-0000-4000-8000-000a00000002",
  token: ["hvra_otlp_v1", "eyJ2IjoxLCJ1c2VySWQiOiJ1In0", "c2lnbmF0dXJlLW9ubHktZm9yLXRlc3Rz"].join("."), // synthetic, built at runtime
  expiresAt: "2026-09-29T12:00:00.000Z",
};
const CREDENTIAL_JSON = JSON.stringify(CREDENTIAL);

function shellFunction(name: string): string {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`, "m"));
  expect(match).not.toBeNull();
  return (match as RegExpMatchArray)[0];
}

function withWorkDirectory<T>(run: (work: string) => T): T {
  const work = mkdtempSync(path.join(tmpdir(), "hivra-activity-collector-"));
  try {
    return run(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const FAKE_SSH = `#!/usr/bin/env bash
count=$(( $(cat "$FAKE_SSH_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$FAKE_SSH_DIR/count"
printf '%s\\0' "$@" > "$FAKE_SSH_DIR/$count.argv"
env > "$FAKE_SSH_DIR/$count.env"
cat > "$FAKE_SSH_DIR/$count.stdin"
command="\${@: -1}"
case "$command" in
  *"install --source-dir"*) echo install >> "$FAKE_SSH_DIR/kinds"; exit "\${FAKE_INSTALL_EXIT:-0}" ;;
  *"/bin/sh -c"*)
    echo stage >> "$FAKE_SSH_DIR/kinds"
    if [ "\${FAKE_STAGE_EXIT:-0}" = 0 ]; then printf '%s\\n' "$FAKE_STAGE_DIR"; fi
    exit "\${FAKE_STAGE_EXIT:-0}" ;;
  *) echo cleanup >> "$FAKE_SSH_DIR/kinds"; exit 0 ;;
esac
`;

interface GuestCall { kind: string; argv: string[]; env: string; stdin: Buffer }

function runInstall(options: {
  stageExit?: number;
  stageDir?: string;
  installExit?: number;
  provisionerDir?: string;
} = {}) {
  return withWorkDirectory((work) => {
    const sshDir = path.join(work, "ssh");
    mkdirSync(sshDir);
    const fakeSsh = path.join(work, "fake-ssh");
    writeFileSync(fakeSsh, FAKE_SSH);
    chmodSync(fakeSsh, 0o755);
    // The credential reaches the harness through a file and an unexported
    // shell variable, exactly as the helper holds it after consuming the file.
    const credentialFile = path.join(work, "credential.json");
    writeFileSync(credentialFile, CREDENTIAL_JSON);
    const harness = `set -euo pipefail
PROVISIONER_DIR="$1"
IP=10.250.21.90
GSSH=("$2" -o BatchMode=yes -o ConnectTimeout=10)
ACTIVITY_CREDENTIAL_JSON="$(cat "$3")"
ACTIVITY_COLLECTOR_STATUS="status=failed reason=not_attempted"
timeout() { while [ "\${1#-}" != "$1" ]; do shift 2; done; shift; "$@"; }
${shellFunction("install_activity_collector")}
${installCallSite()}
printf 'STATUS=%s CREDENTIAL=%s\\n' "$ACTIVITY_COLLECTOR_STATUS" "\${#ACTIVITY_CREDENTIAL_JSON}"
echo CONTINUED`;
    const result = spawnSync("bash", ["-c", harness, "harness", options.provisionerDir ?? bundleRoot, fakeSsh, credentialFile], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_SSH_DIR: sshDir,
        FAKE_STAGE_EXIT: String(options.stageExit ?? 0),
        FAKE_STAGE_DIR: options.stageDir ?? GUEST_DIR,
        FAKE_INSTALL_EXIT: String(options.installExit ?? 0),
      },
    });
    const kinds = existsSync(path.join(sshDir, "kinds"))
      ? readFileSync(path.join(sshDir, "kinds"), "utf8").trim().split("\n")
      : [];
    const calls: GuestCall[] = kinds.map((kind, index) => ({
      kind,
      argv: readFileSync(path.join(sshDir, `${index + 1}.argv`), "utf8").split("\0").slice(0, -1),
      env: readFileSync(path.join(sshDir, `${index + 1}.env`), "utf8"),
      stdin: readFileSync(path.join(sshDir, `${index + 1}.stdin`)),
    }));
    let stagedMembers: string[] = [];
    if (calls[0]?.kind === "stage") {
      const archive = path.join(work, "staged.tar");
      writeFileSync(archive, calls[0].stdin);
      stagedMembers = spawnSync("tar", ["-tf", archive], { encoding: "utf8" }).stdout.trim().split("\n").sort();
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, stagedMembers };
  });
}

// The helper's own call site, so the harness shares its errexit semantics.
function installCallSite(): string {
  const match = source.match(/^if \[ -n "\$ACTIVITY_CREDENTIAL_JSON" \]; then\n[\s\S]*?\n^fi\n/m);
  expect(match).not.toBeNull();
  expect((match as RegExpMatchArray)[0]).toContain("install_activity_collector || true");
  return (match as RegExpMatchArray)[0];
}

function lastArgument(call: GuestCall): string {
  return call.argv[call.argv.length - 1];
}

function extractGuestStage(): string {
  const match = shellFunction("install_activity_collector").match(/local stage='([\s\S]*?)'\n/);
  expect(match).not.toBeNull();
  return (match as RegExpMatchArray)[1];
}

function reporterArchive(members = ["hivra-agent-trace.py", "hivra-agent-trace.service"]): Buffer {
  const archive = spawnSync("tar", ["-C", bundleRoot, "-cf", "-", ...members]);
  expect(archive.status).toBe(0);
  return archive.stdout;
}

describe("hivra-start-on-host.sh agent-run reporter step", () => {
  it("keeps valid syntax and orders the step between the guest-ready gate and the tunnel", () => {
    const syntax = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });

    const consumeAt = source.indexOf('rm -f -- "$ACTIVITY_TELEMETRY_FILE"');
    const firstHostCommandAt = source.indexOf('qm status "$VMID" >/dev/null 2>&1');
    const readyGateAt = source.indexOf('if [ "$GUEST_READY" != "1" ]; then');
    const installAt = source.indexOf("  install_activity_collector || true");
    const tunnelAt = source.indexOf('NAMED="$(');
    expect(consumeAt).toBeGreaterThan(source.indexOf('[[ "$VMID" =~ ^[0-9]+$ ]]'));
    expect(consumeAt).toBeLessThan(firstHostCommandAt);
    expect(installAt).toBeGreaterThan(readyGateAt);
    expect(installAt).toBeLessThan(tunnelAt);
    expect(source).toContain("[[ \"$ACTIVITY_TELEMETRY_FILE\" =~ ^/run/hivra-lifecycle/${VMID}\\.activity\\.env$ ]]");
    expect(source).toContain(`[ "$(stat -c '%a:%U:%G' "$file" 2>/dev/null)" = "600:root:root" ] || return 1`);
  });

  it("publishes exactly one collector marker with the lifecycle result", () => {
    const publish = shellFunction("publish_result");
    const operationAt = publish.indexOf("HIVRA_OPERATION_ID");
    const markerAt = publish.indexOf("printf 'HIVRA_ACTIVITY_COLLECTOR %s\\n' \"$ACTIVITY_COLLECTOR_STATUS\"");
    const resultAt = publish.indexOf("printf '%s\\n' \"$result\"");
    expect(operationAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(operationAt);
    expect(resultAt).toBeGreaterThan(markerAt);
    expect(source.match(/printf 'HIVRA_ACTIVITY_COLLECTOR/g)).toHaveLength(1);
  });

  it("passes the credential only on stdin and bounds every guest call", () => {
    const uses = source.split("\n").filter((line) => line.includes("$ACTIVITY_CREDENTIAL_JSON"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(
        /\[ -n "\$ACTIVITY_CREDENTIAL_JSON" \]/.test(line)
          || /^\s*printf '%s' "\$ACTIVITY_CREDENTIAL_JSON" \| timeout -k \d+ \d+ "\$\{GSSH\[@\]\}"/.test(line),
      ).toBe(true);
    }
    expect(source).not.toMatch(/export\s+ACTIVITY_CREDENTIAL_JSON|set -x/);
    const install = shellFunction("install_activity_collector");
    const guestCalls = install.split("\n").filter((line) => line.includes('"${GSSH[@]}"'));
    expect(guestCalls).toHaveLength(3);
    for (const line of guestCalls) expect(line).toMatch(/timeout -k \d+ \d+ "\$\{GSSH\[@\]\}"/);
  });

  it("gives the guest install more time than the reporter's own worst case, with the whole step still bounded", () => {
    // hivra-agent-trace.py install: daemon-reload 15 s + enable 15 s + show 15 s
    // + restart 30 s + settle 2 s + is-active 15 s. Plus the pinned ssh connect.
    const REPORTER_WORST_CASE_SECONDS = 92;
    const SSH_CONNECT_SECONDS = 10;
    const install = shellFunction("install_activity_collector");
    const bounds = [...install.matchAll(/timeout -k (\d+) (\d+) "\$\{GSSH\[@\]\}"/g)]
      .map((match) => ({ kill: Number(match[1]), limit: Number(match[2]), line: install.slice(match.index, install.indexOf("\n", match.index)) }));
    expect(bounds).toHaveLength(3);
    const installer = bounds.find((bound) => bound.line.includes("ACTIVITY_CREDENTIAL_JSON")
      || install.slice(install.indexOf(bound.line) - 80, install.indexOf(bound.line)).includes("ACTIVITY_CREDENTIAL_JSON"));
    expect(installer).toBeDefined();
    expect(installer!.limit).toBeGreaterThanOrEqual(REPORTER_WORST_CASE_SECONDS + SSH_CONNECT_SECONDS + 10);
    expect(bounds.reduce((total, bound) => total + bound.limit + bound.kill, 0)).toBeLessThanOrEqual(180);
    const reporter = readFileSync(path.join(bundleRoot, "hivra-agent-trace.py"), "utf8");
    expect(reporter).toContain("def _systemctl(*arguments, timeout=15, capture=False):");
    expect(reporter).toContain('_systemctl("restart", UNIT_NAME, timeout=30)');
  });

  it("installs the reviewed reporter with the credential on stdin only", () => {
    const run = runInstall();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("STATUS=status=installed CREDENTIAL=0\nCONTINUED\n");
    expect(run.calls.map((call) => call.kind)).toEqual(["stage", "install"]);
    expect(run.stagedMembers).toEqual(["hivra-agent-trace.py", "hivra-agent-trace.service"]);
    expect(lastArgument(run.calls[0])).toMatch(/^sudo -n \/bin\/sh -c 'set -eu\n/);
    expect(lastArgument(run.calls[1])).toBe(
      `sudo -n /usr/bin/python3 -I -B ${GUEST_DIR}/hivra-agent-trace.py install --source-dir ${GUEST_DIR}; rc=$?; sudo -n /bin/rm -rf -- ${GUEST_DIR}; exit $rc`,
    );
    expect(run.calls[1].stdin.toString("utf8")).toBe(CREDENTIAL_JSON);
    for (const call of run.calls) {
      expect(call.argv.join(" ")).not.toContain(CREDENTIAL.token);
      expect(call.env).not.toContain(CREDENTIAL.token);
    }
    expect(run.stderr).not.toContain(CREDENTIAL.token);
  });

  it.each([
    ["the guest cannot be reached", { stageExit: 255 }, "transfer_failed", ["stage"]],
    ["staging times out", { stageExit: 124 }, "timeout", ["stage"]],
    ["the guest returns an unexpected directory", { stageDir: "/tmp/x; rm -rf /" }, "transfer_failed", ["stage"]],
    ["the installer fails", { installExit: 1 }, "install_failed", ["stage", "install", "cleanup"]],
    ["the installer times out", { installExit: 124 }, "timeout", ["stage", "install", "cleanup"]],
  ] as const)("reports a failure without aborting the start when %s", (_case, options, reason, kinds) => {
    const run = runInstall(options);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`STATUS=status=failed reason=${reason} CREDENTIAL=0\nCONTINUED\n`);
    expect(run.calls.map((call) => call.kind)).toEqual(kinds);
    const cleanup = run.calls.find((call) => call.kind === "cleanup");
    if (cleanup) expect(lastArgument(cleanup)).toBe(`sudo -n /bin/rm -rf -- ${GUEST_DIR}`);
    for (const call of run.calls) expect(call.argv.join(" ")).not.toContain(CREDENTIAL.token);
  });

  it("makes no guest call when the host bundle lacks the reporter", () => {
    withWorkDirectory((emptyBundle) => {
      const run = runInstall({ provisionerDir: emptyBundle });
      expect(run.stdout).toBe("STATUS=status=failed reason=source_missing CREDENTIAL=0\nCONTINUED\n");
      expect(run.calls).toEqual([]);
    });
  });

  describe("guest staging script", () => {
    function stage(guest: string, input: Buffer) {
      const script = extractGuestStage()
        .replaceAll("/run/hivra-agent-trace-install", path.join(guest, "run", "hivra-agent-trace-install"));
      return spawnSync("/bin/sh", ["-c", script], { input, timeout: 10_000 });
    }

    it("unpacks the reporter into a fresh private directory", () => {
      withWorkDirectory((guest) => {
        mkdirSync(path.join(guest, "run"));
        const result = stage(guest, reporterArchive());
        expect(result.status).toBe(0);
        const directory = result.stdout.toString("utf8").trim();
        expect(path.dirname(directory)).toBe(path.join(guest, "run"));
        expect(path.basename(directory)).toMatch(/^hivra-agent-trace-install\.[A-Za-z0-9]{8}$/);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(readdirSync(directory).sort()).toEqual(["hivra-agent-trace.py", "hivra-agent-trace.service"]);
        expect(readFileSync(path.join(directory, "hivra-agent-trace.service"), "utf8"))
          .toBe(readFileSync(path.join(bundleRoot, "hivra-agent-trace.service"), "utf8"));
      });
    });

    // Regression: root used to decide eligibility from /home/bux/.hivra/agent-kind,
    // which the monitored agent owns. Writing "aeon" there skipped every
    // re-credentialing, and a FIFO swapped in could hang a root reader. The
    // control plane already stages credentials only for Claude Code / Codex.
    it("reads nothing the monitored agent can write", () => {
      const script = extractGuestStage();
      expect(script).not.toMatch(/\/home\/|agent-kind|\bhead\b/);
      expect(script).not.toMatch(/exit 3/);
    });

    it.each([
      ["claims another agent kind", (home: string) => writeFileSync(path.join(home, "agent-kind"), "aeon\n")],
      ["removed its identity file", () => undefined],
      ["replaced its identity file with a FIFO", (home: string) => {
        expect(spawnSync("mkfifo", [path.join(home, "agent-kind")]).status).toBe(0);
      }],
      ["symlinked its identity file", (home: string) => {
        writeFileSync(path.join(home, "elsewhere"), "aeon\n");
        symlinkSync(path.join(home, "elsewhere"), path.join(home, "agent-kind"));
      }],
    ])("stages the reporter even when the agent %s", (_case, prepare) => {
      withWorkDirectory((guest) => {
        mkdirSync(path.join(guest, "run"));
        const home = path.join(guest, "home-bux-hivra");
        mkdirSync(home);
        prepare(home);
        // Point any leftover reference at the agent-controlled fixture.
        const script = extractGuestStage()
          .replaceAll("/home/bux/.hivra", home)
          .replaceAll("/run/hivra-agent-trace-install", path.join(guest, "run", "hivra-agent-trace-install"));
        const result = spawnSync("/bin/sh", ["-c", script], { input: reporterArchive(), timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(readdirSync(result.stdout.toString("utf8").trim()).sort()).toEqual(["hivra-agent-trace.py", "hivra-agent-trace.service"]);
      });
    });

    it("removes its directory when the reporter archive is incomplete", () => {
      withWorkDirectory((guest) => {
        mkdirSync(path.join(guest, "run"));
        const result = stage(guest, reporterArchive(["hivra-agent-trace.py"]));
        expect(result.status).not.toBe(0);
        expect(readdirSync(path.join(guest, "run"))).toEqual([]);
      });
    });
  });

  describe("credential file reader", () => {
    function read(content: string, overrides: { owner?: string; size?: string; symlink?: boolean } = {}) {
      return withWorkDirectory((work) => {
        let file = path.join(work, "1090.activity.env");
        writeFileSync(file, content, { mode: 0o600 });
        if (overrides.symlink) {
          const link = path.join(work, "link.env");
          symlinkSync(file, link);
          file = link;
        }
        return spawnSync("bash", ["-c", `set -euo pipefail
stat() { if [ "$2" = "%s" ]; then echo "\${FAKE_SIZE:-$(wc -c < "$3" | tr -d " ")}"; else echo "\${FAKE_OWNER:-600:root:root}"; fi; }
${shellFunction("read_activity_credential")}
read_activity_credential "$1"`, "reader", file], {
          encoding: "utf8",
          env: {
            ...process.env,
            ...(overrides.owner ? { FAKE_OWNER: overrides.owner } : {}),
            ...(overrides.size ? { FAKE_SIZE: overrides.size } : {}),
          },
        });
      });
    }
    const encode = (value: unknown) =>
      `HIVRA_ACTIVITY_TELEMETRY_B64=${Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64")}\n`;

    it("returns exactly the staged credential document", () => {
      const result = read(encode(CREDENTIAL));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(CREDENTIAL);
    });

    it.each([
      ["a group-readable file", encode(CREDENTIAL), { owner: "640:root:root" }],
      ["a file not owned by root", encode(CREDENTIAL), { owner: "600:bux:bux" }],
      ["an oversized file", encode(CREDENTIAL), { size: "16385" }],
      ["a symlink", encode(CREDENTIAL), { symlink: true }],
      ["invalid base64", "HIVRA_ACTIVITY_TELEMETRY_B64=not*base64\n", {}],
      ["a missing key line", `OTHER=${Buffer.from(CREDENTIAL_JSON).toString("base64")}\n`, {}],
      ["an extra credential field", encode({ ...CREDENTIAL, userId: "user-free" }), {}],
      ["a plain-http endpoint", encode({ ...CREDENTIAL, endpoint: "http://canary.hivra.cloud/api/activity/ingest" }), {}],
      ["a foreign endpoint path", encode({ ...CREDENTIAL, endpoint: "https://canary.hivra.cloud/api/other" }), {}],
      ["a malformed token", encode({ ...CREDENTIAL, token: "Bearer abc" }), {}],
      ["an upper-case resource id", encode({ ...CREDENTIAL, resourceId: CREDENTIAL.resourceId.toUpperCase() }), {}],
      ["a non-JSON document", encode("not json"), {}],
    ])("rejects %s", (_case, content, overrides) => {
      const result = read(content, overrides);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  it("never follows or deletes a path outside this VMID's lifecycle slot", () => {
    const block = source.match(/^if \[ -n "\$ACTIVITY_TELEMETRY_FILE" \]; then[\s\S]*?\n^fi\n/m)?.[0];
    expect(block).toBeDefined();
    withWorkDirectory((work) => {
      const foreign = path.join(work, "1090.activity.env");
      writeFileSync(foreign, encode(), { mode: 0o600 });
      for (const candidate of [foreign, "/run/hivra-lifecycle/1091.activity.env", "/run/hivra-lifecycle/1090.activity.env.bak"]) {
        const result = spawnSync("bash", ["-c", `set -euo pipefail
VMID=1090
ACTIVITY_TELEMETRY_FILE="$1"
ACTIVITY_CREDENTIAL_JSON=""
ACTIVITY_COLLECTOR_STATUS=""
read_activity_credential() { echo "reader must not run" >&2; return 1; }
${block}
printf 'STATUS=%s CREDENTIAL=%s\\n' "$ACTIVITY_COLLECTOR_STATUS" "\${#ACTIVITY_CREDENTIAL_JSON}"`, "consume", candidate], { encoding: "utf8" });
        expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
          status: 0,
          stdout: "STATUS=status=failed reason=invalid_input CREDENTIAL=0\n",
          stderr: "",
        });
      }
      expect(existsSync(foreign)).toBe(true);
    });

    function encode(): string {
      return `HIVRA_ACTIVITY_TELEMETRY_B64=${Buffer.from(CREDENTIAL_JSON).toString("base64")}\n`;
    }
  });
});
