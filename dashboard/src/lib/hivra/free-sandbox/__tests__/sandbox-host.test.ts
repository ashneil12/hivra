import {
  FreeSandboxHostError,
  GvisorSandboxHost,
  type HostScriptResult,
  type PoolServerAuthority,
} from "../sandbox-host";
import type { SandboxRef, SandboxSpec } from "../ports";

const SANDBOX: SandboxRef = {
  sandboxId: "5b1f7c2e-8d4a-4e6b-9f10-2a3b4c5d6e7f",
  computerId: "0c9e4a1b-2d3f-4a5b-8c6d-7e8f9a0b1c2d",
  ownerHash: "ab".repeat(32),
};
const SPEC: SandboxSpec = { cpus: 0.5, memoryMb: 1024, storageMb: 1024, cpuOvercommit: 2 };
const ADAPTER_SHA = "c".repeat(64);
const RUNTIME_SHA = "d".repeat(64);
const ARCHIVE_SHA = "e".repeat(64);
const ENROLL_CODE = "enroll-code-QWERTY_12345";
const SERVER_URL = "https://agent-app.example.com";
const AUTHORITY: PoolServerAuthority = {
  env: { EXAMPLE_ENV: "example" },
  hostMemoryReserveMb: 2048,
  adapterSha256: ADAPTER_SHA,
  runtimeSha256: RUNTIME_SHA,
};

interface Call {
  script: string;
  stdin: string;
  env: Record<string, string | undefined>;
  options: { timeoutMs: number; maxOutputBytes: number };
}

/** A runner that records every call and answers with whatever the test set next. */
class FakeRunner {
  calls: Call[] = [];
  answer: (call: Call) => HostScriptResult | Promise<HostScriptResult> = () => ok("");
  throwWith: Error | null = null;

  run = async (
    script: string,
    stdin: string,
    env: Record<string, string | undefined>,
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<HostScriptResult> => {
    const call = { script, stdin, env, options };
    this.calls.push(call);
    if (this.throwWith) throw this.throwWith;
    return this.answer(call);
  };

  get last(): Call {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error("no call recorded");
    return call;
  }

  get request(): Record<string, unknown> {
    return JSON.parse(this.last.stdin) as Record<string, unknown>;
  }
}

function ok(stdout: string): HostScriptResult {
  return { ok: true, stdout, stderr: "" };
}

function failed(stderr: string, stdout = ""): HostScriptResult {
  return { ok: false, stdout, stderr };
}

function receipt(marker: string, body: Record<string, unknown>): string {
  return `${marker} ${JSON.stringify({ version: 1, sandboxId: SANDBOX.sandboxId, computerId: SANDBOX.computerId, ...body })}\n`;
}

const STATUS = "HIVRA_GVISOR_V1";
const PACK = "HIVRA_GVISOR_PACK_V1";
const RELEASE = "HIVRA_GVISOR_RELEASE_V1";
const ENROLL = "HIVRA_GVISOR_ENROLL_V1";

function setup() {
  const runner = new FakeRunner();
  const resolved: string[] = [];
  const host = new GvisorSandboxHost(async (serverId) => {
    resolved.push(serverId);
    return AUTHORITY;
  }, runner.run);
  return { host, runner, resolved };
}

async function caught(promise: Promise<unknown>): Promise<FreeSandboxHostError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FreeSandboxHostError) return error;
    throw error;
  }
  throw new Error("expected the operation to reject");
}

describe("GvisorSandboxHost: create and restore", () => {
  it("creates a free-class sandbox with the spec, the reserve and the owner identity", async () => {
    const { host, runner, resolved } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "running" }));

    await host.create("pool-1", SANDBOX, SPEC);

    expect(resolved).toEqual(["pool-1"]);
    expect(runner.request).toEqual({
      operation: "create",
      sandboxId: SANDBOX.sandboxId,
      computerId: SANDBOX.computerId,
      ownerHash: SANDBOX.ownerHash,
      sandboxClass: "free",
      cpu: 0.5,
      memoryMb: 1024,
      storageMb: 1024,
      cpuOvercommit: 2,
      hostMemoryReserveMb: 2048,
    });
    expect(runner.last.options).toEqual({ timeoutMs: 360_000, maxOutputBytes: 96 * 1024 });
    expect(runner.last.env).toEqual(AUTHORITY.env);
  });

  it("guards the adapter and runtime with the server's pinned identities before it runs", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "running" }));

    await host.create("pool-1", SANDBOX, SPEC);

    const script = runner.last.script;
    expect(script).toContain(`= '${ADAPTER_SHA}' ]`);
    expect(script).toContain(`= '${RUNTIME_SHA}' ]`);
    expect(script).toContain("exec '/opt/hivra/gvisor-adapter/hivra-gvisor-adapter'");
    // The request travels on stdin only: the script never carries the sandbox's identifiers.
    expect(script).not.toContain(SANDBOX.sandboxId);
    expect(script).not.toContain(SANDBOX.ownerHash);
  });

  it("refuses the create when the receipt names another sandbox", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "running", sandboxId: "11111111-2222-4333-8444-555555555555" }));

    const error = await caught(host.create("pool-1", SANDBOX, SPEC));
    expect(error.code).toBe("remote_failed");
  });

  it("fails a create whose receipt says stopped, because the adapter's create starts the container", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "stopped" }));
    expect((await caught(host.create("pool-1", SANDBOX, SPEC))).code).toBe("remote_failed");
  });

  it("restores from a checked archive with the same limits and the reserve, on the long timeout", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "stopped" }));

    await host.restore("pool-1", SANDBOX, SPEC, ARCHIVE_SHA);

    expect(runner.request).toMatchObject({
      operation: "restore",
      sandboxClass: "free",
      cpu: 0.5,
      memoryMb: 1024,
      storageMb: 1024,
      cpuOvercommit: 2,
      hostMemoryReserveMb: 2048,
      archiveSha256: ARCHIVE_SHA,
    });
    expect(runner.last.options.timeoutMs).toBe(360_000);
  });

  it("fails a restore whose receipt says running, because a restored sandbox comes back stopped", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "running" }));
    expect((await caught(host.restore("pool-1", SANDBOX, SPEC, ARCHIVE_SHA))).code).toBe("remote_failed");
  });

  it("rejects an archive digest that is not 64 lowercase hex before any run", async () => {
    const { host, runner } = setup();
    const error = await caught(host.restore("pool-1", SANDBOX, SPEC, "E".repeat(64)));
    expect(error.code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });
});

describe("GvisorSandboxHost: start, stop, remove", () => {
  it("starts with the reserve and overcommit only, and needs the sandbox to report running", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "running" }));

    await host.start("pool-1", SANDBOX, SPEC);

    expect(runner.request).toEqual({
      operation: "start",
      sandboxId: SANDBOX.sandboxId,
      computerId: SANDBOX.computerId,
      ownerHash: SANDBOX.ownerHash,
      hostMemoryReserveMb: 2048,
      cpuOvercommit: 2,
    });
    expect(runner.last.options.timeoutMs).toBe(90_000);
  });

  it("fails a start whose receipt still says stopped", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "stopped" }));
    expect((await caught(host.start("pool-1", SANDBOX, SPEC))).code).toBe("remote_failed");
  });

  it("stops and expects a stopped receipt", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "stopped" }));

    await host.stop("pool-1", SANDBOX);

    expect(runner.request).toMatchObject({ operation: "stop" });
    expect(runner.last.options.timeoutMs).toBe(90_000);
  });

  it("maps remove to the adapter's delete and requires an absent receipt", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "absent" }));

    await host.remove("pool-1", SANDBOX);

    expect(runner.request).toMatchObject({ operation: "delete" });
    expect(runner.request).not.toHaveProperty("archiveSha256");
  });

  it("fails a remove that still reports the sandbox present", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "stopped" }));
    expect((await caught(host.remove("pool-1", SANDBOX))).code).toBe("remote_failed");
  });
});

describe("GvisorSandboxHost: pack and release", () => {
  it("packs and returns the digest and size the receipt reports", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(PACK, { sha256: ARCHIVE_SHA, bytes: 4096, archive: "archive.tar.zst" }));

    await expect(host.pack("pool-1", SANDBOX)).resolves.toEqual({ sha256: ARCHIVE_SHA, bytes: 4096 });
    expect(runner.request).toEqual({
      operation: "pack",
      sandboxId: SANDBOX.sandboxId,
      computerId: SANDBOX.computerId,
      ownerHash: SANDBOX.ownerHash,
    });
    // The adapter's zstd alone may run for 3600s, then tar, a read-back and two hashes follow it.
    expect(runner.last.options.timeoutMs).toBe(4_200_000);
    expect(runner.last.options.timeoutMs).toBeGreaterThanOrEqual(3600_000 + 60_000);
  });

  it("finds the pack receipt among other output lines", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(`some progress\r\n${receipt(PACK, { sha256: ARCHIVE_SHA, bytes: 1 })}`);
    await expect(host.pack("pool-1", SANDBOX)).resolves.toEqual({ sha256: ARCHIVE_SHA, bytes: 1 });
  });

  it("refuses a pack receipt with a malformed digest", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(PACK, { sha256: "not-a-digest", bytes: 1 }));
    expect((await caught(host.pack("pool-1", SANDBOX))).code).toBe("remote_failed");
  });

  it("refuses a pack receipt with a negative or fractional size", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(PACK, { sha256: ARCHIVE_SHA, bytes: -1 }));
    expect((await caught(host.pack("pool-1", SANDBOX))).code).toBe("remote_failed");
    runner.answer = () => ok(receipt(PACK, { sha256: ARCHIVE_SHA, bytes: 1.5 }));
    expect((await caught(host.pack("pool-1", SANDBOX))).code).toBe("remote_failed");
  });

  it("refuses a pack with no receipt at all", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok("nothing printed\n");
    expect((await caught(host.pack("pool-1", SANDBOX))).code).toBe("remote_failed");
  });

  it("refuses a pack whose receipt line is not JSON", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(`${PACK} {not json\n`);
    expect((await caught(host.pack("pool-1", SANDBOX))).code).toBe("remote_failed");
  });

  it("releases with the archive digest and expects a released receipt with the same digest", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(RELEASE, { state: "released", sha256: ARCHIVE_SHA }));

    await host.release("pool-1", SANDBOX, ARCHIVE_SHA);

    expect(runner.request).toMatchObject({ operation: "release", archiveSha256: ARCHIVE_SHA });
    // The release re-hashes the archive, which can be as large as the storage quota, so it gets its own long budget.
    expect(runner.last.options.timeoutMs).toBe(900_000);
  });

  it("refuses a release whose receipt names a different digest", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(RELEASE, { state: "released", sha256: "f".repeat(64) }));
    expect((await caught(host.release("pool-1", SANDBOX, ARCHIVE_SHA))).code).toBe("remote_failed");
  });

  it("refuses a release with a bad digest before any run", async () => {
    const { host, runner } = setup();
    expect((await caught(host.release("pool-1", SANDBOX, "short"))).code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });
});

describe("GvisorSandboxHost: enroll", () => {
  it("sends the enroll code and server address on stdin only, and reads the enroll receipt", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(ENROLL, { enrolled: true }));

    await host.enroll("pool-1", SANDBOX, ENROLL_CODE, SERVER_URL);

    expect(runner.request).toMatchObject({
      operation: "enroll",
      enrollCode: ENROLL_CODE,
      serverUrl: SERVER_URL,
    });
    expect(runner.last.script).not.toContain(ENROLL_CODE);
    expect(runner.last.script).not.toContain(SERVER_URL);
    // The adapter's docker exec alone is bounded at 120s, so the budget must sit above that.
    expect(runner.last.options.timeoutMs).toBe(150_000);
    expect(runner.last.options.timeoutMs).toBeGreaterThan(120_000);
  });

  it("refuses a server address that is not https", async () => {
    const { host, runner } = setup();
    const error = await caught(host.enroll("pool-1", SANDBOX, ENROLL_CODE, "http://agent-app.example.com"));
    expect(error.code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses a server address with a path", async () => {
    const { host, runner } = setup();
    const error = await caught(host.enroll("pool-1", SANDBOX, ENROLL_CODE, "https://agent-app.example.com/x"));
    expect(error.code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses an enroll code outside the allowed shape, without echoing it", async () => {
    const { host, runner } = setup();
    const bad = "short code!";
    const error = await caught(host.enroll("pool-1", SANDBOX, bad, SERVER_URL));
    expect(error.code).toBe("invalid_request");
    expect(error.message).not.toContain(bad);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses an enrolled receipt that is not true", async () => {
    const { host, runner } = setup();
    runner.answer = () => ok(receipt(ENROLL, { enrolled: false }));
    expect((await caught(host.enroll("pool-1", SANDBOX, ENROLL_CODE, SERVER_URL))).code).toBe("remote_failed");
  });

  it("never puts the enroll code into a thrown error, even when the script's output contains it", async () => {
    const { host, runner } = setup();
    runner.answer = () => failed(`adapter said ${ENROLL_CODE}`, `stdout ${ENROLL_CODE}`);
    const error = await caught(host.enroll("pool-1", SANDBOX, ENROLL_CODE, SERVER_URL));
    expect(error.code).toBe("remote_failed");
    expect(error.message).not.toContain(ENROLL_CODE);
  });

  it("never puts the enroll code into a thrown error when the runner itself throws", async () => {
    const { host, runner } = setup();
    runner.throwWith = new Error(`ssh failed while sending ${ENROLL_CODE}`);
    const error = await caught(host.enroll("pool-1", SANDBOX, ENROLL_CODE, SERVER_URL));
    expect(error.code).toBe("remote_failed");
    expect(error.message).not.toContain(ENROLL_CODE);
  });
});

describe("GvisorSandboxHost: failure mapping", () => {
  it("maps the identity guard's mismatch to not_ready", async () => {
    const { host, runner } = setup();
    runner.answer = () => failed("HIVRA_GVISOR_IDENTITY_MISMATCH\n");
    expect((await caught(host.stop("pool-1", SANDBOX))).code).toBe("not_ready");
  });

  // Every capacity phrase the adapter (or this host) maps to `capacity`.
  it.each([
    ["the admission refusal", "The connected host does not have enough uncommitted capacity"],
    ["the host capacity refusal", "Host capacity is unavailable"],
  ])("maps %s to capacity without copying the output", async (_name, phrase) => {
    const { host, runner } = setup();
    runner.answer = () => failed(`${phrase}\n`, "leaked stdout detail");
    const error = await caught(host.start("pool-1", SANDBOX, SPEC));
    expect(error.code).toBe("capacity");
    expect(error.message).not.toContain(phrase);
    expect(error.message).not.toContain("leaked");
  });

  // Every not_ready phrase the adapter prints for a host or sandbox that is not in the right state yet.
  it.each([
    [
      "missing CPU and memory limits",
      "Every existing Docker workload needs explicit CPU and memory limits before gVisor admission",
    ],
    ["a stop-first refusal before pack", "Stop this gVisor computer before packing it"],
    ["a start-first refusal before enroll", "Start this gVisor computer before enrolling it"],
    ["a running sandbox that cannot be released", "A running gVisor computer cannot be released"],
    ["a sandbox that does not run the free image", "This gVisor computer does not run the free sandbox image"],
    ["no free image pinned on the adapter", "No free sandbox image is pinned on this adapter"],
  ])("maps %s to not_ready", async (_name, phrase) => {
    const { host, runner } = setup();
    runner.answer = () => failed(`${phrase}\n`);
    const error = await caught(host.create("pool-1", SANDBOX, SPEC));
    expect(error.code).toBe("not_ready");
    expect(error.message).not.toContain(phrase);
  });

  it("reads the not_ready phrase from stdout as well as stderr", async () => {
    const { host, runner } = setup();
    runner.answer = () => failed("", "Stop this gVisor computer before packing it");
    expect((await caught(host.pack("pool-1", SANDBOX))).code).toBe("not_ready");
  });

  it("maps any other failure to remote_failed with fixed text", async () => {
    const { host, runner } = setup();
    runner.answer = () => failed("gVisor computer operation failed", "leaked stdout detail");
    const error = await caught(host.remove("pool-1", SANDBOX));
    expect(error.code).toBe("remote_failed");
    expect(error.message).not.toContain("leaked");
    expect(error.message).not.toContain("gVisor computer operation failed");
  });

  it("does not leak the runner's own error text", async () => {
    const { host, runner } = setup();
    runner.throwWith = new Error(`secret-token-${ARCHIVE_SHA}`);
    const error = await caught(host.stop("pool-1", SANDBOX));
    expect(error.code).toBe("remote_failed");
    expect(error.message).not.toContain("secret-token");
  });

  it("does not leak the resolver's own error text and marks the server not_ready", async () => {
    const runner = new FakeRunner();
    const host = new GvisorSandboxHost(async () => {
      throw new Error("vault path /secrets/pool-1 missing");
    }, runner.run);
    const error = await caught(host.stop("pool-1", SANDBOX));
    expect(error.code).toBe("not_ready");
    expect(error.message).not.toContain("vault");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses a result that is not ok but names no adapter marker as remote_failed", async () => {
    const { host, runner } = setup();
    runner.answer = () => failed("");
    expect((await caught(host.stop("pool-1", SANDBOX))).code).toBe("remote_failed");
  });

  it("is a FreeSandboxHostError with its name and a public readonly code callers can branch on", async () => {
    const { host, runner } = setup();
    runner.answer = () => failed("");
    const error = await caught(host.stop("pool-1", SANDBOX));
    expect(error).toBeInstanceOf(FreeSandboxHostError);
    expect(error.name).toBe("FreeSandboxHostError");
    expect(Object.prototype.hasOwnProperty.call(error, "code")).toBe(true);
    expect(error.code).toBe("remote_failed");
  });
});

describe("GvisorSandboxHost: input validation", () => {
  it("rejects a sandbox id that is not a UUID before anything reaches a script", async () => {
    const { host, runner } = setup();
    const bad = { ...SANDBOX, sandboxId: "not-a-uuid; rm -rf /" };
    const error = await caught(host.stop("pool-1", bad));
    expect(error.code).toBe("invalid_request");
    expect(error.message).not.toContain("rm -rf");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a computer id that is not a UUID", async () => {
    const { host, runner } = setup();
    expect((await caught(host.pack("pool-1", { ...SANDBOX, computerId: "x" }))).code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects an owner hash that is not 64 lowercase hex", async () => {
    const { host, runner } = setup();
    expect((await caught(host.remove("pool-1", { ...SANDBOX, ownerHash: "AB".repeat(32) }))).code).toBe(
      "invalid_request",
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a pool server id outside the slug shape before resolving it", async () => {
    const { host, runner, resolved } = setup();
    expect((await caught(host.stop("pool 1; echo x", SANDBOX))).code).toBe("invalid_request");
    expect(resolved).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    ["a single character", "p"],
    ["a digit first", "1pool"],
    ["hyphens inside", "pool-a-1"],
    ["the longest allowed id (63 characters)", "p".repeat(63)],
  ])("accepts the database's server id shape: %s", async (_name, serverId) => {
    const { host, runner, resolved } = setup();
    runner.answer = () => ok(receipt(STATUS, { state: "stopped" }));
    await host.stop(serverId, SANDBOX);
    expect(resolved).toEqual([serverId]);
  });

  it.each([
    ["uppercase letters", "Pool-1"],
    ["an underscore", "pool_1"],
    ["a dot", "pool.1"],
    ["a leading hyphen", "-pool"],
    ["a 64-character id", "p".repeat(64)],
    ["an empty id", ""],
  ])("rejects a pool server id with %s before resolving it", async (_name, serverId) => {
    const { host, runner, resolved } = setup();
    expect((await caught(host.stop(serverId, SANDBOX))).code).toBe("invalid_request");
    expect(resolved).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    ["CPU below the minimum", { ...SPEC, cpus: 0.4 }],
    ["CPU above the maximum", { ...SPEC, cpus: 33 }],
    ["CPU not finite", { ...SPEC, cpus: Number.NaN }],
    ["memory below the minimum", { ...SPEC, memoryMb: 511 }],
    ["memory not an integer", { ...SPEC, memoryMb: 1024.5 }],
    ["storage below the minimum", { ...SPEC, storageMb: 255 }],
    ["storage above the maximum", { ...SPEC, storageMb: 65537 }],
    ["overcommit below one", { ...SPEC, cpuOvercommit: 0.5 }],
    ["overcommit above eight", { ...SPEC, cpuOvercommit: 9 }],
  ])("rejects a spec with %s before any run", async (_name, spec) => {
    const { host, runner } = setup();
    expect((await caught(host.create("pool-1", SANDBOX, spec))).code).toBe("invalid_request");
    expect((await caught(host.restore("pool-1", SANDBOX, spec, ARCHIVE_SHA))).code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects an overcommit outside 1 to 8 on start", async () => {
    const { host, runner } = setup();
    expect((await caught(host.start("pool-1", SANDBOX, { ...SPEC, cpuOvercommit: 8.5 }))).code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a resolver authority whose adapter identity is not a digest, before the guard is built", async () => {
    const runner = new FakeRunner();
    const host = new GvisorSandboxHost(async () => ({ ...AUTHORITY, adapterSha256: "x'; reboot; '" }), runner.run);
    const error = await caught(host.stop("pool-1", SANDBOX));
    expect(error.code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a resolver authority whose runtime identity is not a digest", async () => {
    const runner = new FakeRunner();
    const host = new GvisorSandboxHost(async () => ({ ...AUTHORITY, runtimeSha256: "short" }), runner.run);
    expect((await caught(host.stop("pool-1", SANDBOX))).code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a host memory reserve outside the adapter's bounds", async () => {
    const runner = new FakeRunner();
    const host = new GvisorSandboxHost(async () => ({ ...AUTHORITY, hostMemoryReserveMb: 100 }), runner.run);
    expect((await caught(host.start("pool-1", SANDBOX, SPEC))).code).toBe("invalid_request");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a resolver authority without an environment object", async () => {
    const runner = new FakeRunner();
    const host = new GvisorSandboxHost(
      async () => ({ ...AUTHORITY, env: null as unknown as Record<string, string> }),
      runner.run,
    );
    expect((await caught(host.stop("pool-1", SANDBOX))).code).toBe("not_ready");
    expect(runner.calls).toHaveLength(0);
  });
});
