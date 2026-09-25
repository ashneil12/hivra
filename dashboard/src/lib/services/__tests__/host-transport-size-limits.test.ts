/** @jest-environment node */

// Every host transport's size limit, tested at the limit and one byte over.
//
// PR #143 fixed a live failure: a ~150 KB attach bundle went inside one host
// argument and Linux refused it ("Argument list too long", MAX_ARG_STRLEN is
// 131,072 bytes counting the NUL). Every test used small payloads and macOS
// accepts that argument, so nothing caught it. Afterwards a mutation probe
// could still lower the script limit, count stdin in characters, or move the
// sudo loader's limit without any test failing.
//
// The limits here are the ones transport-payload-budgets.json names, so this
// file proves each number there is what the transport really does. The Linux
// section runs the largest accepted command for real; in CI it fails rather
// than skips when it is not on Linux.

type Handler = (...args: unknown[]) => void;
type FakeStream = {
  on: (event: string, handler: Handler) => FakeStream;
  stderr: { on: (event: string, handler: Handler) => void };
  write: jest.Mock;
  end: jest.Mock;
  destroy: jest.Mock;
  emit: (event: string, ...args: unknown[]) => void;
};
type Exec = { command: string; input: () => string };

// Same ssh2 stand-in as proxmox-sudo-transport.test.ts: every exec answers
// with the sudo sentinel on stderr and exit 0 once its input has been written.
const execs: Exec[] = [];
const clients: unknown[] = [];

function fakeStream(): FakeStream {
  const handlers = new Map<string, Handler[]>();
  const stream: FakeStream = {
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return stream; },
    stderr: { on: (event, handler) => { if (event === "data") handlers.set("stderr", [...(handlers.get("stderr") ?? []), handler]); } },
    write: jest.fn(),
    end: jest.fn(() => {
      setTimeout(() => {
        (handlers.get("stderr") ?? []).forEach(handler => handler(Buffer.from("HIVRA_SUDO_V1\n")));
        stream.emit("close", 0);
      }, 0);
    }),
    destroy: jest.fn(),
    emit: (event, ...args) => (handlers.get(event) ?? []).forEach(handler => handler(...args)),
  };
  return stream;
}

jest.mock("ssh2", () => {
  const Client = jest.fn().mockImplementation(() => {
    const handlers = new Map<string, Handler>();
    const client = {
      on: (event: string, handler: Handler) => { handlers.set(event, handler); return client; },
      connect: jest.fn(() => { setTimeout(() => handlers.get("ready")?.(), 0); }),
      exec: jest.fn((command: string, callback: (error: Error | null, stream: FakeStream) => void) => {
        const stream = fakeStream();
        execs.push({ command, input: () => stream.write.mock.calls.map(call => String(call[0])).join("") });
        setTimeout(() => callback(null, stream), 0);
      }),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    clients.push(client);
    return client;
  });
  return { Client };
});

import { spawnSync } from "node:child_process";

import { buildAttachmentHostStepScript, HOST_ARGUMENT_MAX_BYTES } from "@/lib/agent-computers/attachment-host-observation";
import { buildSudoTransportCommand, frameSudoTransportInput, HIVRA_SUDO_LOADER,
  MAX_SUDO_TRANSPORT_SCRIPT_BYTES } from "../proxmox-sudo-transport";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "../proxmox-instance-service";
import { byteLength, hostStepArgument, readTransportBudgets } from "./host-transport.fixtures";

const LIMITS = readTransportBudgets().limits;
const ARGUMENT_MAX = LIMITS["linux-argument"].bytes;
const SCRIPT_MAX = LIMITS["host-script-with-stdin.script"].bytes;
const STDIN_MAX = LIMITS["host-script-with-stdin.stdin"].bytes;
const SUDO_SCRIPT_MAX = LIMITS["sudo-transport-script"].bytes;
const REFUSED = { ok: false, stdout: "", stderr: "", error: "Invalid Proxmox host script or stdin" };

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n";
const managedLogin = {
  HERMES_PROXMOX_TARGET_ENV_RESOLVED: "true", PROXMOX_EXEC_MODE: "ssh", PROXMOX_SSH_HOST: "203.0.113.10",
  PROXMOX_SSH_PRIVATE_KEY: KEY,
};
const userSudo = {
  ...managedLogin, HIVRA_USER_INFRA_CONNECTION: "true", PROXMOX_SSH_USER: "hivra", PROXMOX_SSH_PRIVILEGE: "sudo",
  PROXMOX_SSH_HOST_FINGERPRINT: "ab".repeat(32), PROXMOX_ALLOW_SSH_AGENT: "false",
};
const TRANSPORTS = { login: managedLogin, sudo: userSudo } as const;
const options = { timeoutMs: 20_000 };
const CHILD_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" };

/** A bash script of exactly `bytes` UTF-8 bytes that prints a marker and the
 * byte length bash itself received (LC_ALL=C: ${#…} counts bytes). */
function scriptOfBytes(bytes: number, filler = "x"): string {
  const tail = "printf 'HIVRA_SIZE_OK %s\\n' \"${#BASH_EXECUTION_STRING}\"\n";
  const room = bytes - byteLength(tail) - 2;
  const unit = byteLength(filler);
  const head = filler.repeat(Math.floor(room / unit)) + "x".repeat(room % unit);
  const script = `#${head}\n${tail}`;
  if (byteLength(script) !== bytes) throw new Error("scriptOfBytes miscounted");
  return script;
}

/** The exact login command a script travels in (runProxmoxHostScriptWithStdin). */
const loginCommandFor = (script: string) =>
  `/bin/bash -c "$(printf '%s' '${Buffer.from(script, "utf8").toString("base64")}' | /usr/bin/base64 --decode)"`;

beforeEach(() => {
  execs.length = 0;
  clients.length = 0;
});

describe("runProxmoxHostScriptWithStdin: the script travels inside one login argument", () => {
  it("names the limits the transport really has", () => {
    expect(ARGUMENT_MAX).toBe(128 * 1024 - 1);
    expect(HOST_ARGUMENT_MAX_BYTES).toBe(ARGUMENT_MAX);
    expect(STDIN_MAX).toBe(1024 * 1024);
    expect(SUDO_SCRIPT_MAX).toBe(MAX_SUDO_TRANSPORT_SCRIPT_BYTES);
    // The largest script whose base64 login command still fits one argument.
    expect(byteLength(loginCommandFor(scriptOfBytes(SCRIPT_MAX)))).toBe(ARGUMENT_MAX);
    expect(byteLength(loginCommandFor(scriptOfBytes(SCRIPT_MAX + 1)))).toBeGreaterThan(ARGUMENT_MAX);
  });

  it("sends the largest script it takes as a login command of exactly one Linux argument", async () => {
    const script = scriptOfBytes(SCRIPT_MAX);
    const result = await runProxmoxHostScriptWithStdin(script, "data\n", managedLogin, options);
    expect(result.ok).toBe(true);
    expect(execs).toHaveLength(1);
    expect(execs[0].command).toBe(loginCommandFor(script));
    expect(byteLength(execs[0].command)).toBe(ARGUMENT_MAX);
    expect(execs[0].input()).toBe("data\n");
  });

  it.each(Object.keys(TRANSPORTS) as Array<keyof typeof TRANSPORTS>)(
    "takes a %s script of exactly the limit and refuses one byte more before connecting", async (transport) => {
      const env = TRANSPORTS[transport];
      const script = scriptOfBytes(SCRIPT_MAX);
      expect(await runProxmoxHostScriptWithStdin(script, "data\n", env, options)).toMatchObject({ ok: true });
      expect(execs.map(exec => exec.command)).toEqual([transport === "sudo" ? buildSudoTransportCommand(options.timeoutMs) : loginCommandFor(script)]);
      expect(execs[0].input()).toBe(transport === "sudo" ? frameSudoTransportInput(script, "data\n") : "data\n");

      execs.length = 0;
      clients.length = 0;
      expect(await runProxmoxHostScriptWithStdin(scriptOfBytes(SCRIPT_MAX + 1), "data\n", env, options)).toEqual(REFUSED);
      expect(clients).toHaveLength(0);
    });

  it("counts the script in UTF-8 bytes, not characters", async () => {
    const script = scriptOfBytes(SCRIPT_MAX, "é");
    expect(script.length).toBeLessThan(SCRIPT_MAX);
    expect(await runProxmoxHostScriptWithStdin(script, "", managedLogin, options)).toMatchObject({ ok: true });
    const over = scriptOfBytes(SCRIPT_MAX + 1, "é");
    expect(over.length).toBeLessThan(SCRIPT_MAX);
    expect(await runProxmoxHostScriptWithStdin(over, "", managedLogin, options)).toEqual(REFUSED);
  });

  it("refuses a 96 KiB script: the one-argument limit binds below the 96 KiB script cap", async () => {
    // The 96 KiB check in runProxmoxHostScriptWithStdin never decides alone: a
    // script that size already makes a login command over the argument limit.
    expect(SCRIPT_MAX).toBeLessThan(96 * 1024);
    expect(await runProxmoxHostScriptWithStdin(scriptOfBytes(96 * 1024), "", managedLogin, options)).toEqual(REFUSED);
    expect(clients).toHaveLength(0);
  });
});

describe("runProxmoxHostScriptWithStdin: stdin", () => {
  it.each(Object.keys(TRANSPORTS) as Array<keyof typeof TRANSPORTS>)(
    "carries exactly 1 MiB of %s stdin byte for byte and refuses one byte more", async (transport) => {
      const env = TRANSPORTS[transport];
      const stdin = "0123456789abcdef".repeat(STDIN_MAX / 16);
      expect(await runProxmoxHostScriptWithStdin("cat >/dev/null\n", stdin, env, options)).toMatchObject({ ok: true });
      expect(execs[0].input()).toBe(transport === "sudo" ? frameSudoTransportInput("cat >/dev/null\n", stdin) : stdin);

      clients.length = 0;
      expect(await runProxmoxHostScriptWithStdin("cat >/dev/null\n", stdin + "x", env, options)).toEqual(REFUSED);
      expect(clients).toHaveLength(0);
    });

  it("counts stdin in UTF-8 bytes, not characters", async () => {
    const stdin = "é".repeat(STDIN_MAX / 2);
    expect(await runProxmoxHostScriptWithStdin("cat >/dev/null\n", stdin, managedLogin, options)).toMatchObject({ ok: true });
    expect(await runProxmoxHostScriptWithStdin("cat >/dev/null\n", stdin + "x", managedLogin, options)).toEqual(REFUSED);
  });
});

describe("runProxmoxHostScript over the sudo transport", () => {
  it("frames a script of exactly the loader's limit and refuses one byte more before connecting", async () => {
    const script = scriptOfBytes(SUDO_SCRIPT_MAX);
    expect(await runProxmoxHostScript(script, userSudo, options)).toMatchObject({ ok: true });
    expect(execs.map(exec => exec.command)).toEqual([buildSudoTransportCommand(options.timeoutMs)]);
    expect(execs[0].input()).toBe(`${SUDO_SCRIPT_MAX}\n${script}`);

    clients.length = 0;
    expect(await runProxmoxHostScript(scriptOfBytes(SUDO_SCRIPT_MAX + 1), userSudo, options))
      .toEqual({ ok: false, stdout: "", stderr: "", error: "Invalid host script for the sudo transport" });
    expect(clients).toHaveLength(0);
  });

  it("is the real loader's own limit: it runs a script of exactly that size and refuses a longer length", async () => {
    const tail = "echo HIVRA_LOADED\n";
    const script = `#${"x".repeat(SUDO_SCRIPT_MAX - tail.length - 2)}\n${tail}`;
    expect(byteLength(script)).toBe(SUDO_SCRIPT_MAX);
    const local = { PROXMOX_EXEC_MODE: "local", HIVRA_USER_INFRA_CONNECTION: "true", PROXMOX_SSH_PRIVILEGE: "sudo" };
    expect(await runProxmoxHostScript(script, local, options)).toMatchObject({ ok: true, stdout: "HIVRA_LOADED\n" });
    // The runner never frames a longer script; the loader refuses one anyway.
    const longer = spawnSync("bash", ["--noprofile", "--norc", "-c", HIVRA_SUDO_LOADER], {
      input: `${SUDO_SCRIPT_MAX + 1}\n#${script}`, encoding: "utf8", env: CHILD_ENV,
    });
    expect({ status: longer.status, stdout: longer.stdout }).toEqual({ status: 1, stdout: "" });
  });

  it("sends a login connection's script of any size on stdin to bash -s, never in argv", async () => {
    const script = scriptOfBytes(SUDO_SCRIPT_MAX + 1);
    expect(await runProxmoxHostScript(script, managedLogin, options)).toMatchObject({ ok: true });
    expect(execs.map(exec => exec.command)).toEqual(["bash -s"]);
    expect(execs[0].input()).toBe(script);
  });
});

describe("attach host step: the step body is one argument to python3", () => {
  const target = {
    operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
    sourceId: "33333333-3333-4333-8333-333333333333", vmid: 1234, guestIp: "10.241.0.44",
    bindingTag: "hivra-bind-" + "a".repeat(32), architecture: "x86_64" as const,
  };
  const bodyFor = (programBytes: number) => hostStepArgument(buildAttachmentHostStepScript(target, "#".repeat(programBytes), 60));

  it("builds a step whose body is exactly the argument limit and refuses one byte more", () => {
    const fixed = byteLength(bodyFor(1)) - 1;
    const largest = bodyFor(ARGUMENT_MAX - fixed);
    expect(byteLength(largest)).toBe(ARGUMENT_MAX);
    expect(() => buildAttachmentHostStepScript(target, "#".repeat(ARGUMENT_MAX - fixed + 1), 60)).toThrow("host argument limit");
  });
});

// Linux only: macOS execs one 200 KiB argument, so only Linux shows the limit.
// In CI (ubuntu-latest) these must run; anywhere else in CI they fail.
const ci = Boolean(process.env.CI) && !/^(0|false)$/i.test(process.env.CI ?? "");
function onLinux(name: string, test: () => Promise<void>) {
  if (process.platform === "linux") return it(name, test);
  if (ci) {
    return it(name, () => {
      throw new Error(`Must execute on Linux in CI (platform is ${process.platform}): other systems accept arguments Linux refuses.`);
    });
  }
  return it.skip(`${name} [skipped on ${process.platform}: only Linux enforces MAX_ARG_STRLEN; CI runs it]`, test);
}

describe("on Linux", () => {
  const run = (file: string, args: string[]) => spawnSync(file, args, {
    encoding: "utf8", timeout: 20_000, env: CHILD_ENV,
  });

  onLinux("execs one argument of exactly the limit and refuses one byte more (E2BIG)", async () => {
    expect(run("/bin/sh", ["-c", "exit 0", "x".repeat(ARGUMENT_MAX)])).toMatchObject({ status: 0 });
    const over = run("/bin/sh", ["-c", "exit 0", "x".repeat(ARGUMENT_MAX + 1)]);
    expect((over.error as NodeJS.ErrnoException | undefined)?.code).toBe("E2BIG");
  });

  onLinux("runs the largest accepted login command as one argument to /bin/bash -c", async () => {
    const script = scriptOfBytes(SCRIPT_MAX);
    await runProxmoxHostScriptWithStdin(script, "", managedLogin, options);
    const command = execs[0].command;
    expect(byteLength(command)).toBe(ARGUMENT_MAX);
    // What sshd does with a login command: the user's shell with -c and the
    // command as one argument. The decoded script arrives whole (less its
    // final newline, which the command substitution drops).
    const result = run("/bin/bash", ["-c", command]);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 0, stdout: `HIVRA_SIZE_OK ${SCRIPT_MAX - 1}\n` });
    // One byte more is what the transport refuses, and what Linux refuses too.
    expect((run("/bin/bash", ["-c", command + " "]).error as NodeJS.ErrnoException | undefined)?.code).toBe("E2BIG");
  });

  onLinux("runs the largest attach step body as one argument to python3", async () => {
    const fixed = byteLength(hostStepArgument(buildAttachmentHostStepScript({
      operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333", vmid: 1234, guestIp: "10.241.0.44",
      bindingTag: "hivra-bind-" + "a".repeat(32), architecture: "x86_64",
    }, "#", 60))) - 1;
    const body = hostStepArgument(buildAttachmentHostStepScript({
      operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333", vmid: 1234, guestIp: "10.241.0.44",
      bindingTag: "hivra-bind-" + "a".repeat(32), architecture: "x86_64",
    }, "#".repeat(ARGUMENT_MAX - fixed), 60));
    expect(byteLength(body)).toBe(ARGUMENT_MAX);
    const result = run("python3", ["-I", "-B", "-c", "import sys;print(len(sys.argv[1].encode()))", body]);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 0, stdout: `${ARGUMENT_MAX}\n` });
  });
});
