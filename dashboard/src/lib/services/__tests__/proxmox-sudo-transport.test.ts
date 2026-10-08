/** @jest-environment node */

// The sudo transport (section 9.2 of
// docs/superpowers/specs/2026-09-24-server-enrollment-command.md): one
// constant command in argv, script and data framed on stdin, a sentinel, and
// a fixed diagnosis when the command never reached the script. Covers T12,
// T17, T28 and T29 against a mocked ssh2 client, plus a local-mode round trip
// through the real loader under bash.

type Handler = (...args: unknown[]) => void;

type FakeStream = {
  on: (event: string, handler: Handler) => FakeStream;
  stderr: { on: (event: string, handler: Handler) => void };
  write: jest.Mock;
  end: jest.Mock;
  destroy: jest.Mock;
  emit: (event: string, ...args: unknown[]) => void;
  emitStderr: (chunk: string) => void;
};

type ExecReply = { stdout?: string; stderr?: string; code: number };

let autoReady = true;
const execReplies: Array<(command: string, stream: FakeStream) => ExecReply | null> = [];
const clients: Array<{ connect: jest.Mock; exec: jest.Mock; handlers: Map<string, Handler>; streams: FakeStream[] }> = [];

function fakeStream(): FakeStream {
  const handlers = new Map<string, Handler[]>();
  const stderrHandlers: Handler[] = [];
  const stream: FakeStream = {
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return stream; },
    stderr: { on: (event, handler) => { if (event === "data") stderrHandlers.push(handler); } },
    write: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
    emit: (event, ...args) => (handlers.get(event) ?? []).forEach(handler => handler(...args)),
    emitStderr: chunk => stderrHandlers.forEach(handler => handler(Buffer.from(chunk))),
  };
  return stream;
}

jest.mock("ssh2", () => {
  const Client = jest.fn().mockImplementation(() => {
    const handlers = new Map<string, Handler>();
    const record = {
      handlers,
      streams: [] as FakeStream[],
      connect: jest.fn(() => { if (autoReady) setTimeout(() => handlers.get("ready")?.(), 0); }),
      exec: jest.fn((command: string, callback: (error: Error | null, stream: FakeStream) => void) => {
        const stream = fakeStream();
        record.streams.push(stream);
        setTimeout(() => {
          callback(null, stream);
          const reply = execReplies.shift()?.(command, stream) ?? null;
          if (!reply) return;
          setTimeout(() => {
            if (reply.stdout) stream.emit("data", Buffer.from(reply.stdout));
            if (reply.stderr) stream.emitStderr(reply.stderr);
            stream.emit("close", reply.code);
          }, 0);
        }, 0);
      }),
    };
    const client = {
      on: (event: string, handler: Handler) => { handlers.set(event, handler); return client; },
      connect: record.connect,
      exec: record.exec,
      end: jest.fn(),
      destroy: jest.fn(),
    };
    clients.push(record);
    return client;
  });
  return { Client };
});

import {
  buildSudoTransportCommand,
  frameSudoTransportInput,
  HIVRA_SUDO_LOADER,
  HIVRA_SUDO_SENTINEL,
  MAX_SUDO_TRANSPORT_SCRIPT_BYTES,
  parseMissingTool,
  stripSudoSentinel,
  SUDO_MISSING_TOOLS_PROBE,
  SUDO_TRANSPORT_PATH,
  SUDO_TRUE_PROBE,
  sudoTransportRemoteSeconds,
} from "../proxmox-sudo-transport";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "../proxmox-instance-service";

const FINGERPRINT_HEX = "ab".repeat(32);
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n";

function userEnv(privilege: "login" | "sudo" | null, extra: Record<string, string> = {}) {
  return {
    HIVRA_USER_INFRA_CONNECTION: "true",
    HERMES_PROXMOX_TARGET_ENV_RESOLVED: "true",
    PROXMOX_EXEC_MODE: "ssh",
    PROXMOX_ALLOW_SSH_AGENT: "false",
    PROXMOX_SSH_HOST: "203.0.113.10",
    PROXMOX_SSH_PORT: "22",
    PROXMOX_SSH_USER: privilege === "sudo" ? "hivra" : "root",
    PROXMOX_SSH_PRIVATE_KEY: KEY,
    PROXMOX_SSH_HOST_FINGERPRINT: FINGERPRINT_HEX,
    ...(privilege === "sudo" ? { PROXMOX_SSH_PRIVILEGE: "sudo" } : {}),
    ...extra,
  };
}

beforeEach(() => {
  autoReady = true;
  execReplies.length = 0;
  clients.length = 0;
});

describe("sudo transport pieces", () => {
  it("builds one constant command; only the whole-second limit changes", () => {
    const prefix = "/usr/bin/sudo -n -- /usr/bin/env -i "
      + "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin LC_ALL=C HOME=/root ";
    const expected = (seconds: number) => prefix
      + `/usr/bin/timeout --signal=TERM --kill-after=1s ${seconds}s /bin/bash --noprofile --norc -c '${HIVRA_SUDO_LOADER}'`;
    expect(buildSudoTransportCommand(20_000)).toBe(expected(18));
    expect(buildSudoTransportCommand(600_000)).toBe(expected(598));
    expect(buildSudoTransportCommand(1_500)).toBe(expected(1));
    // A script that changes packages runs without the remote TERM/KILL
    // (review finding 6): the same command with the limit left out.
    expect(buildSudoTransportCommand(360_000, "none")).toBe(prefix + `/bin/bash --noprofile --norc -c '${HIVRA_SUDO_LOADER}'`);
    // Root's PATH under sudo, so tools Prepare puts in /usr/local/bin (runsc)
    // are found by name as over a root login.
    expect(SUDO_TRANSPORT_PATH.split(":").slice(0, 2)).toEqual(["/usr/local/sbin", "/usr/local/bin"]);
    expect(sudoTransportRemoteSeconds(2_999)).toBe(1);
    expect(HIVRA_SUDO_LOADER).not.toContain("'");
    expect(HIVRA_SUDO_LOADER.startsWith(`printf "${HIVRA_SUDO_SENTINEL}\\n" >&2;`)).toBe(true);
  });

  it("frames the script by its UTF-8 byte length and refuses what the loader can't carry", () => {
    expect(frameSudoTransportInput("echo hi\n", "data")).toBe("8\necho hi\ndata");
    expect(frameSudoTransportInput("echo é\n", "")).toBe("8\necho é\n");
    expect(frameSudoTransportInput("", "x")).toBeNull();
    expect(frameSudoTransportInput("a\0b", "")).toBeNull();
    expect(frameSudoTransportInput("x".repeat(MAX_SUDO_TRANSPORT_SCRIPT_BYTES + 1), "")).toBeNull();
    expect(frameSudoTransportInput("x".repeat(MAX_SUDO_TRANSPORT_SCRIPT_BYTES), "")).not.toBeNull();
  });

  it("strips the sentinel line and says whether it was there", () => {
    expect(stripSudoSentinel("HIVRA_SUDO_V1\nwarning\n")).toEqual({ stderr: "warning\n", sentinel: true });
    expect(stripSudoSentinel("sudo: a password is required\n")).toEqual({ stderr: "sudo: a password is required\n", sentinel: false });
  });

  it("reads only the fixed tool paths from the missing-tools probe", () => {
    expect(parseMissingTool("missing /usr/bin/timeout\n")).toBe("/usr/bin/timeout");
    expect(parseMissingTool("missing /tmp/evil\nmissing /bin/bash\n")).toBe("/bin/bash");
    expect(parseMissingTool("")).toBeNull();
  });
});

describe("runner with the sudo transport (mocked SSH)", () => {
  it("sends the same constant command for every script and puts no script or data byte in it (T29)", async () => {
    const commands: string[] = [];
    const inputs: string[] = [];
    const scripts = [
      "set -euo pipefail\nprintf 'guard %s\\n' \"$(id -u)\"\n",
      "cat /etc/os-release\n# gVisor computer operation\n",
      "#!/usr/bin/env bash\nIFS= read -r secret\nprintf '%s' \"${#secret}\"\n",
    ];
    for (const script of scripts) {
      execReplies.push((command, stream) => {
        commands.push(command);
        inputs.push(stream.write.mock.calls.map(call => String(call[0])).join(""));
        return { stdout: "ok\n", stderr: HIVRA_SUDO_SENTINEL + "\n", code: 0 };
      });
      const result = script.includes("secret")
        ? await runProxmoxHostScriptWithStdin(script, "hunter2-sensitive\n", userEnv("sudo"), { timeoutMs: 20_000 })
        : await runProxmoxHostScript(script, userEnv("sudo"), { timeoutMs: 20_000 });
      expect(result).toMatchObject({ ok: true, stdout: "ok\n", stderr: "" });
    }
    expect(new Set(commands)).toEqual(new Set([buildSudoTransportCommand(20_000)]));
    for (const [index, script] of scripts.entries()) {
      for (const line of script.split("\n").filter(Boolean)) expect(commands[index]).not.toContain(line);
      expect(inputs[index]).toBe(frameSudoTransportInput(script, index === 2 ? "hunter2-sensitive\n" : ""));
    }
    expect(commands.join("")).not.toContain("hunter2");
  });

  it("leaves out the remote limit only when the caller says the script changes packages (finding 6)", async () => {
    const commands: string[] = [];
    execReplies.push(command => { commands.push(command); return { stderr: HIVRA_SUDO_SENTINEL + "\n", code: 0 }; });
    execReplies.push(command => { commands.push(command); return { stderr: HIVRA_SUDO_SENTINEL + "\n", code: 0 }; });
    await runProxmoxHostScript("apt-get install -y x\n", userEnv("sudo"), { timeoutMs: 360_000, remoteLimit: "none" });
    await runProxmoxHostScript("true\n", userEnv("sudo"), { timeoutMs: 360_000 });
    expect(commands).toEqual([buildSudoTransportCommand(360_000, "none"), buildSudoTransportCommand(360_000)]);
    expect(commands[0]).not.toContain("/usr/bin/timeout");
    expect(commands[1]).toContain("/usr/bin/timeout --signal=TERM --kill-after=1s 358s");
    // A login connection ignores it: today's exact command.
    execReplies.push(command => { commands.push(command); return { code: 0 }; });
    await runProxmoxHostScript("true\n", userEnv("login"), { timeoutMs: 360_000, remoteLimit: "none" });
    expect(commands[2]).toBe("bash -s");
  });

  it("is the same command the disposable-server check sends (scripts/test-server-enroll-host.py)", () => {
    const python = readFileSync(join(__dirname, "../../../../scripts/test-server-enroll-host.py"), "utf8");
    const prefix = /SUDO_PREFIX = \("([^"]+) "\n\s+"([^"]+)"\)/.exec(python);
    expect(prefix && prefix[1] + " " + prefix[2]).toBe(`/usr/bin/sudo -n -- /usr/bin/env -i PATH=${SUDO_TRANSPORT_PATH} LC_ALL=C HOME=/root `);
    const loader = /SUDO_LOADER = \('([^']+)'\n\s+'([^']+)'\)/.exec(python);
    expect(loader && (loader[1] + loader[2]).replaceAll("\\\\", "\\")).toBe(HIVRA_SUDO_LOADER);
    expect(python).toContain(`SUDO_TRUE_PROBE = "${SUDO_TRUE_PROBE}"`);
  });

  it("keeps today's exact commands for login connections and the managed fleet (T12)", async () => {
    execReplies.push(command => { expect(command).toBe("bash -s"); return { code: 0 }; });
    await runProxmoxHostScript("echo login\n", userEnv("login"), { timeoutMs: 5_000 });
    execReplies.push(command => { expect(command).toBe("bash -s"); return { code: 0 }; });
    // A managed-fleet environment never uses the transport, even if the
    // variable were present.
    await runProxmoxHostScript("echo fleet\n", {
      HERMES_PROXMOX_TARGET_ENV_RESOLVED: "true", PROXMOX_EXEC_MODE: "ssh", PROXMOX_SSH_HOST: "203.0.113.11",
      PROXMOX_SSH_PRIVATE_KEY: KEY, PROXMOX_SSH_PRIVILEGE: "sudo",
    }, { timeoutMs: 5_000 });
    expect(clients).toHaveLength(2);
    expect(clients[0].streams[0].write.mock.calls.map(call => call[0]).join("")).toBe("echo login\n");
  });

  it("reports a script failure after the sentinel as the script's own failure, with no diagnosis (T28)", async () => {
    execReplies.push(() => ({ stderr: HIVRA_SUDO_SENTINEL + "\nboom\n", code: 3 }));
    const result = await runProxmoxHostScript("exit 3\n", userEnv("sudo"), { timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false, stderr: "boom\n", error: "Remote bash exited with code 3" });
    expect(result.sudoFailure).toBeUndefined();
    expect(clients[0].exec).toHaveBeenCalledTimes(1);
  });

  it("never runs the diagnosis after a success", async () => {
    execReplies.push(() => ({ stderr: HIVRA_SUDO_SENTINEL + "\n", code: 0 }));
    await runProxmoxHostScript("true\n", userEnv("sudo"), { timeoutMs: 5_000 });
    expect(clients[0].exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a missing tool", { stdout: "missing /usr/bin/timeout\n", code: 0 }, null, { kind: "missing_tool", path: "/usr/bin/timeout" },
      "Sudo transport failed: missing /usr/bin/timeout"],
    ["a password", { code: 0 }, { code: 1 }, { kind: "password_required" }, "Sudo transport failed: password_required"],
    ["a rule that allows other commands", { code: 0 }, { code: 0 }, { kind: "command_not_allowed" },
      "Sudo transport failed: command_not_allowed"],
  ])("tells %s apart when no sentinel arrived (T28)", async (_label, toolsReply, trueReply, failure, error) => {
    const probes: string[] = [];
    execReplies.push(() => ({ stderr: "sudo: something localised\n", code: 1 }));
    execReplies.push(command => { probes.push(command); return toolsReply as ExecReply; });
    if (trueReply) execReplies.push(command => { probes.push(command); return trueReply as ExecReply; });
    const result = await runProxmoxHostScript("true\n", userEnv("sudo"), { timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false, error, sudoFailure: failure });
    expect(probes).toEqual(trueReply ? [SUDO_MISSING_TOOLS_PROBE, SUDO_TRUE_PROBE] : [SUDO_MISSING_TOOLS_PROBE]);
  });

  it("refuses another key type before authentication and reports the key it met (T17)", async () => {
    autoReady = false;
    const pending = runProxmoxHostScript("true\n", userEnv("sudo", { PROXMOX_SSH_HOST_KEY_TYPE: "ssh-ed25519" }), { timeoutMs: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const record = clients[0];
    const options = record.connect.mock.calls[0][0] as { algorithms?: { serverHostKey?: string[] }; hostVerifier: (fp: string) => boolean };
    expect(options.algorithms?.serverHostKey).toEqual(["ssh-ed25519"]);
    expect(options.hostVerifier("cd".repeat(32))).toBe(false);
    record.handlers.get("error")?.(new Error("Handshake failed: host key verification failed"));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, presentedHostFingerprintSha256: "cd".repeat(32) });
    expect(record.exec).not.toHaveBeenCalled();
  });

  it("refuses an unknown pinned key type before connecting", async () => {
    const result = await runProxmoxHostScript("true\n", userEnv("sudo", { PROXMOX_SSH_HOST_KEY_TYPE: "ssh-rsa" }), { timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false, error: "Unsupported pinned SSH host key type." });
    expect(clients).toHaveLength(0);
  });
});

describe("local-mode round trip through the real loader (T29)", () => {
  const local = { HIVRA_USER_INFRA_CONNECTION: "true", PROXMOX_EXEC_MODE: "local", PROXMOX_SSH_PRIVILEGE: "sudo" };
  const login = { PROXMOX_EXEC_MODE: "local" };
  const options = { timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024 };

  it("hands the script exactly its data on stdin: 1 MB of JSON with every escape", async () => {
    const pieces: string[] = [];
    let size = 0;
    for (let index = 0; size < 1_000_000; index += 1) {
      const piece = JSON.stringify({ index, text: `line\r\n\t"quote" \\ é中😀 ^C^D \u0001\u001f` }) + "\n";
      pieces.push(piece);
      size += Buffer.byteLength(piece);
    }
    const data = pieces.join("").slice(0, 1_000_000);
    const result = await runProxmoxHostScriptWithStdin("cat\n", data, local, options);
    expect(result.ok).toBe(true);
    expect(Buffer.from(result.stdout).equals(Buffer.from(data))).toBe(true);
  });

  it("behaves as bash -s for heredocs, errexit, ERR traps and exit codes", async () => {
    const scripts = [
      "cat <<'EOF'\nheredoc $HOME `x`\nEOF\nprintf 'after\\n'\n",
      "set -Eeuo pipefail\ntrap 'echo trapped >&2' ERR\nf() { false; echo unreachable; }\nf\necho never\n",
      "set -e\nfalse\necho never\n",
      "echo before\nexit 3\necho never\n",
      "printf '\\303\\251 multibyte \\342\\202\\254\\n'\n# café € comment\n",
    ];
    for (const script of scripts) {
      const viaLoader = await runProxmoxHostScriptWithStdin(script, "", local, options);
      const viaBash = await runProxmoxHostScript(script, login, options);
      expect({ ok: viaLoader.ok, stdout: viaLoader.stdout, stderr: viaLoader.stderr, error: viaLoader.error })
        .toEqual({ ok: viaBash.ok, stdout: viaBash.stdout, stderr: viaBash.stderr, error: viaBash.error });
    }
  });

  it("refuses a script whose login command would be over the host's 128 KiB argument limit", async () => {
    // 98,281 bytes: under the 96 KiB script cap, but its base64 is 131,044
    // characters and the whole command is past what Linux takes as one argument.
    const script = ("# " + "x".repeat(97) + "\n").repeat(982) + "#".repeat(80) + "\n";
    expect(Buffer.byteLength(script)).toBeLessThanOrEqual(96 * 1024);
    expect(await runProxmoxHostScriptWithStdin(script, "", login, options))
      .toEqual({ ok: false, stdout: "", stderr: "", error: "Invalid Proxmox host script or stdin" });
    expect((await runProxmoxHostScriptWithStdin("echo small\n", "", login, options)).stdout).toBe("small\n");
  });

  it("runs a 96 KB script", async () => {
    const filler = ("# " + "x".repeat(97) + "\n").repeat(960);
    const script = filler + "echo done\n";
    expect(Buffer.byteLength(script)).toBeGreaterThanOrEqual(96_000);
    const result = await runProxmoxHostScript(script, local, options);
    expect(result).toMatchObject({ ok: true, stdout: "done\n", stderr: "" });
  });
});
