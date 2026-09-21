// Regression tests for runProxmoxHostScript's earlyFinishMarker option.
//
// Provisioning a Proxmox VM emits HERMES_PROXMOX_RESULT after Phase 1
// completes; Phase 2 then forks detached. In some Vercel runtime
// environments the SSH channel-close event was delayed (sshd waiting on
// inherited grandchild FDs), so the orchestrator's lambda would block on
// `await runner(script)` until Vercel killed it at the 300s function
// timeout — leaving the DB row orphaned at status='provisioning' with
// null vmid/gateway_url. earlyFinishMarker resolves the moment the
// kickoff line lands in stdout, so the DB persist runs regardless of
// whether (or when) the channel actually closes.

type MockHandler = (...args: unknown[]) => void;
type MockHandlerMap = Map<string, MockHandler>;

type MockStream = {
  on: jest.Mock<MockStream, [string, MockHandler]>;
  stderr: { on: jest.Mock<unknown, [string, MockHandler]> };
  write: jest.Mock<void, [string]>;
  end: jest.Mock<void, []>;
  destroy: jest.Mock<void, []>;
  __dataHandlers: MockHandler[];
  __stderrDataHandlers: MockHandler[];
  __closeHandlers: MockHandler[];
};

type MockClient = {
  on: jest.Mock<MockClient, [string, MockHandler]>;
  connect: jest.Mock<MockClient, [unknown]>;
  exec: jest.Mock<unknown, [string, (err: Error | null, stream: MockStream) => void]>;
  end: jest.Mock<void, []>;
  __handlers: MockHandlerMap;
  __stream: MockStream;
};

const connectBehaviors: Array<(client: MockClient) => void> = [];
const createdClients: MockClient[] = [];

jest.mock("ssh2", () => {
  const Client = jest.fn().mockImplementation(() => {
    const handlers: MockHandlerMap = new Map();
    const stream: MockStream = {
      on: jest.fn<MockStream, [string, MockHandler]>((event, handler) => {
        if (event === "data") stream.__dataHandlers.push(handler);
        if (event === "close") stream.__closeHandlers.push(handler);
        return stream;
      }),
      stderr: {
        on: jest.fn<unknown, [string, MockHandler]>((event, handler) => {
          if (event === "data") stream.__stderrDataHandlers.push(handler);
          return undefined;
        }),
      },
      write: jest.fn<void, [string]>(),
      end: jest.fn<void, []>(),
      destroy: jest.fn<void, []>(),
      __dataHandlers: [],
      __stderrDataHandlers: [],
      __closeHandlers: [],
    };
    const client: MockClient = {
      on: jest.fn<MockClient, [string, MockHandler]>((event, handler) => {
        handlers.set(event, handler);
        return client;
      }),
      connect: jest.fn<MockClient, [unknown]>(() => {
        const behavior = connectBehaviors.shift();
        if (!behavior) throw new Error("No mock connect behavior configured");
        setTimeout(() => behavior(client), 0);
        return client;
      }),
      exec: jest.fn<unknown, [string, (err: Error | null, s: MockStream) => void]>(
        (_cmd, cb) => {
          setTimeout(() => cb(null, stream), 0);
          return undefined;
        }
      ),
      end: jest.fn<void, []>(),
      __handlers: handlers,
      __stream: stream,
    };
    createdClients.push(client);
    return client;
  });
  return { Client };
});

import {
  normalizeProxmoxSshHostFingerprint,
  runProxmoxHostScript,
} from "../proxmox-instance-service";

describe("normalizeProxmoxSshHostFingerprint", () => {
  const digest = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

  it("normalizes the OpenSSH SHA256:BASE64 display form", () => {
    const displayed = `SHA256:${digest.toString("base64").replace(/=+$/g, "")}`;
    expect(normalizeProxmoxSshHostFingerprint(displayed)).toBe(digest.toString("hex"));
  });

  it("normalizes colon-delimited hexadecimal fingerprints", () => {
    const displayed = digest.toString("hex").match(/.{2}/g)?.join(":") ?? "";
    expect(normalizeProxmoxSshHostFingerprint(displayed)).toBe(digest.toString("hex"));
  });

  it("rejects fingerprints that are not SHA-256 digests", () => {
    expect(() => normalizeProxmoxSshHostFingerprint("SHA256:dG9vLXNob3J0")).toThrow(
      "32-byte SHA-256 digest",
    );
  });
});

describe("runProxmoxHostScript earlyFinishMarker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    connectBehaviors.length = 0;
    createdClients.length = 0;
    process.env.PROXMOX_SSH_HOST = "203.0.113.10";
    process.env.PROXMOX_SSH_PRIVATE_KEY_B64 = Buffer.from("fake-key").toString("base64");
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.PROXMOX_SSH_HOST;
    delete process.env.PROXMOX_SSH_PRIVATE_KEY_B64;
    delete process.env.PROXMOX_SSH_HOST_FINGERPRINT;
    delete process.env.HIVRA_USER_INFRA_CONNECTION;
  });

  async function waitForStreamHandlers(): Promise<MockClient> {
    // The Client mock pushes to createdClients, then the async exec callback
    // registers stream.on('data'/'close'). Spin until those handlers settle.
    for (let i = 0; i < 60; i++) {
      const client = createdClients[0];
      if (client && client.__stream.__dataHandlers.length > 0) return client;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("ssh2 stream handlers never attached");
  }

  it("never dispatches bash when ready arrives after the operation timed out",async()=>{
    jest.useFakeTimers();connectBehaviors.push(()=>{});
    const pending=runProxmoxHostScript("must-not-run",process.env,{timeoutMs:50});
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ok:false,error:expect.stringContaining("timed out")});
    const client=createdClients[0];client.__handlers.get("ready")?.();
    expect(client.exec).not.toHaveBeenCalled();expect(client.__stream.write).not.toHaveBeenCalled();
  });
  it.each([0,-1,NaN,Infinity,2_147_483_648])("rejects invalid timer budget %s before making a client",async timeoutMs=>{
    await expect(runProxmoxHostScript("must-not-run",process.env,{timeoutMs}))
      .resolves.toMatchObject({ok:false,error:"Invalid Proxmox host script timeout"});
    expect(createdClients).toHaveLength(0);
  });

  it("never sends script input when an exec acknowledgement arrives after timeout",async()=>{
    jest.useFakeTimers();let acknowledge!:(error:Error|null,stream:MockStream)=>void;
    connectBehaviors.push(client=>{
      client.exec.mockImplementation((_command,callback)=>{acknowledge=callback;});
      client.__handlers.get("ready")?.();
    });
    const pending=runProxmoxHostScript("must-not-run",process.env,{timeoutMs:50});
    await jest.advanceTimersByTimeAsync(50);await expect(pending).resolves.toMatchObject({ok:false});
    const client=createdClients[0];acknowledge(null,client.__stream);
    expect(client.__stream.write).not.toHaveBeenCalled();expect(client.__stream.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not execute after an earlier connection failure, even before the timer expires",async()=>{
    jest.useFakeTimers();connectBehaviors.push(()=>{});
    const pending=runProxmoxHostScript("must-not-run",process.env,{timeoutMs:50});
    await jest.advanceTimersByTimeAsync(0);
    const client=createdClients[0];client.__handlers.get("error")?.(new Error("connection failed"));
    await expect(pending).resolves.toMatchObject({ok:false});client.__handlers.get("ready")?.();
    expect(client.exec).not.toHaveBeenCalled();
  });

  it.each(["ready","exec","close","marker"])("enforces the monotonic deadline at %s even when its timer has not run",async boundary=>{
    jest.useFakeTimers();let elapsed=0;
    jest.spyOn(performance,"now").mockImplementation(()=>elapsed);
    let acknowledge!:(error:Error|null,stream:MockStream)=>void;
    connectBehaviors.push(client=>{
      client.exec.mockImplementation((_command,callback)=>{acknowledge=callback;});
    });
    const pending=runProxmoxHostScript("fixed-script",process.env,{timeoutMs:50,earlyFinishMarker:"DONE"});
    await jest.advanceTimersByTimeAsync(0);
    const client=createdClients[0];
    if(boundary!=="ready")client.__handlers.get("ready")?.();
    if(boundary==="close" || boundary==="marker")acknowledge(null,client.__stream);
    elapsed=51;
    if(boundary==="ready")client.__handlers.get("ready")?.();
    if(boundary==="exec")acknowledge(null,client.__stream);
    if(boundary==="close")client.__stream.__closeHandlers.forEach(handler=>handler(0));
    if(boundary==="marker")client.__stream.__dataHandlers.forEach(handler=>handler(Buffer.from("DONE")));
    // Settle the old implementation too; the assertions below distinguish
    // timer-only cancellation from a fence at the actual dispatch/result.
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ok:false,error:expect.stringContaining("timed out")});
    if(boundary==="ready")expect(client.exec).not.toHaveBeenCalled();
    if(boundary==="exec")expect(client.__stream.write).not.toHaveBeenCalled();
  });

  it("checks again immediately before stdin dispatch after stream setup",async()=>{
    jest.useFakeTimers();let elapsed=0;
    jest.spyOn(performance,"now").mockImplementation(()=>elapsed);
    connectBehaviors.push(client=>{
      client.__stream.stderr.on.mockImplementation(()=>{elapsed=51;});
      client.__handlers.get("ready")?.();
    });
    const pending=runProxmoxHostScript("must-not-run",process.env,{timeoutMs:50});
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ok:false,error:expect.stringContaining("timed out")});
    expect(createdClients[0].__stream.write).not.toHaveBeenCalled();
    expect(createdClients[0].__stream.destroy).toHaveBeenCalledTimes(1);
  });

  it("resolves the moment the marker lands in stdout, even if the SSH stream never emits 'close'", async () => {
    connectBehaviors.push((client) => {
      client.__handlers.get("ready")?.();
    });

    const start = Date.now();
    const promise = runProxmoxHostScript("dummy-script", process.env, {
      timeoutMs: 5_000,
      earlyFinishMarker: "HERMES_PROXMOX_RESULT",
    });

    const client = await waitForStreamHandlers();

    // Phase 1 emits the marker line on stdout.
    client.__stream.__dataHandlers.forEach((h) =>
      h(Buffer.from('ok\nHERMES_PROXMOX_RESULT {"vmid":201}\n'))
    );

    const result = await promise;
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("HERMES_PROXMOX_RESULT");
    // The runner returned WITHOUT the stream's 'close' event ever firing.
    // Pre-fix this Promise would block until 5s timeoutMs hit.
    expect(elapsed).toBeLessThan(1_000);
    expect(client.__stream.__closeHandlers).toHaveLength(1);
    expect(client.end).toHaveBeenCalled();
  }, 10_000);

  it("still waits for stream 'close' when no marker option is provided (back-compat for non-provision callers)", async () => {
    connectBehaviors.push((client) => {
      client.__handlers.get("ready")?.();
    });

    const start = Date.now();
    const promise = runProxmoxHostScript("dummy-script", process.env, {
      timeoutMs: 5_000,
    });

    const client = await waitForStreamHandlers();

    // Push the same marker-shaped data — must NOT cause early finish, since
    // the option wasn't passed.
    client.__stream.__dataHandlers.forEach((h) =>
      h(Buffer.from("HERMES_PROXMOX_RESULT looking line but no marker option\n"))
    );

    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolved).toBe(false);

    // Fire 'close' with code 0 — back-compat path resolves here.
    client.__stream.__closeHandlers.forEach((h) => h(0));
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_000);
  }, 10_000);

  it("terminates and rejects when combined stdout and stderr exceed the capture budget", async () => {
    connectBehaviors.push((client) => {
      client.__handlers.get("ready")?.();
    });

    const promise = runProxmoxHostScript("dummy-script", process.env, {
      timeoutMs: 5_000,
      maxOutputBytes: 32,
    });
    const client = await waitForStreamHandlers();

    client.__stream.__dataHandlers.forEach((handler) => handler(Buffer.from("a".repeat(20))));
    client.__stream.__stderrDataHandlers.forEach((handler) => handler(Buffer.from("b".repeat(20))));

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      stdout: "a".repeat(20),
      stderr: "b".repeat(12),
      error: "Proxmox host script output exceeded 32 bytes",
    });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(32);
    expect(client.end).toHaveBeenCalled();
  }, 10_000);

  it("fails closed before connecting when a user-owned target has no pinned host key", async () => {
    process.env.HIVRA_USER_INFRA_CONNECTION = "true";

    const result = await runProxmoxHostScript("dummy-script", process.env, {
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "User-owned Proxmox connections require a pinned SSH host fingerprint.",
    });
    expect(createdClients).toHaveLength(0);
  });

  it("pins user-owned SSH connections to the configured SHA-256 host key", async () => {
    const digest = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
    const expectedHex = digest.toString("hex");
    process.env.HIVRA_USER_INFRA_CONNECTION = "true";
    process.env.PROXMOX_SSH_HOST_FINGERPRINT = `SHA256:${digest
      .toString("base64")
      .replace(/=+$/g, "")}`;
    connectBehaviors.push((client) => {
      client.__handlers.get("ready")?.();
    });

    const promise = runProxmoxHostScript("dummy-script", process.env, {
      timeoutMs: 5_000,
    });
    const client = await waitForStreamHandlers();
    const connectOptions = client.connect.mock.calls[0][0] as {
      hostHash?: string;
      hostVerifier?: (fingerprint: string) => boolean;
    };

    expect(connectOptions.hostHash).toBe("sha256");
    expect(connectOptions.hostVerifier?.(expectedHex)).toBe(true);
    expect(connectOptions.hostVerifier?.("0".repeat(64))).toBe(false);

    client.__stream.__closeHandlers.forEach((handler) => handler(0));
    await expect(promise).resolves.toMatchObject({ ok: true });
  }, 10_000);
});
