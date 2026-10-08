/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { createHash, createHmac } from "node:crypto";
import { connect, type Server as NetServer, type AddressInfo } from "node:net";
import { Client as SshClient, Server as SshServer, utils as sshUtils } from "ssh2";
import { WebSocketServer } from "ws";

import {
  HostRelayError,
  hostRelayConfig,
  hostRelayStatus,
  issueConnectorConfig,
  mintRelayTicket,
  openRelaySocket,
  revokeRelayConnector,
} from "../host-relay";
import { generateVerifiedEd25519SshKeyPair } from "../ed25519-ssh-key";

const SECRET = "test-relay-secret-with-at-least-32-characters";
const HOST = "11111111-1111-4111-8111-111111111111";
const hmacHex = (key: string, message: string) => createHmac("sha256", key).update(message).digest("hex");

type FakeRelay = { url: string; online: boolean; sessions: number; adminCalls: Array<{ path: string; body: string }>; close(): Promise<void> };

/** Stand-in for services/host-relay-worker: checks tickets and pipes a session to a local TCP port. */
async function fakeRelay(target: () => number): Promise<FakeRelay> {
  const http = await import("node:http");
  const state = { online: true, sessions: 0, adminCalls: [] as Array<{ path: string; body: string }> };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const admin = request.headers.authorization === `Bearer ${hmacHex(SECRET, "admin|v1")}`;
      state.adminCalls.push({ path: request.url ?? "", body });
      if (!admin) { response.writeHead(401).end(); return; }
      if (request.url?.endsWith("/status")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ online: state.online, generation: 1, minGeneration: 1, sessions: state.sessions }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ minGeneration: JSON.parse(body).minGeneration }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "");
    const valid = match && createHmac("sha256", hmacHex(SECRET, "client-ticket|v1")).update(match[1]).digest("base64url") === match[2];
    const payload = valid ? JSON.parse(Buffer.from(match![1], "base64url").toString()) : null;
    if (!state.online || !payload || payload.aud !== HOST || request.url !== `/v1/hosts/${HOST}/client`) {
      socket.end(`HTTP/1.1 ${state.online ? 401 : 503} Refused\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const tcp = connect(target(), "127.0.0.1");
      tcp.on("data", (data: Buffer) => ws.send(data));
      tcp.on("close", () => ws.close());
      ws.on("message", (data: Buffer) => tcp.write(data));
      ws.on("close", () => tcp.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { wss.close(); server.close(() => resolve()); }),
  });
}

// ssh2's own Ed25519 generator makes a key it can't parse about 1 time in 256
// (a leading zero byte, see ed25519-ssh-key.ts); the verified generator skips those.
function ed25519Pair() {
  const pair = generateVerifiedEd25519SshKeyPair("host-relay-test");
  return { private: pair.privateKeyOpenSsh, public: pair.publicKeyOpenSsh };
}

/** A real SSH server that accepts one key and answers `echo`. */
async function sshServer(authorizedKey: { getPublicSSH(): Buffer }): Promise<{ port: number; hostKey: string; server: NetServer }> {
  const host = ed25519Pair();
  const server = new SshServer({ hostKeys: [host.private] }, (client) => {
    // A client that rejects the host key ends the handshake; that is expected here.
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "publickey" && context.key.data.equals(authorizedKey.getPublicSSH())) context.accept();
      else context.reject(["publickey"]);
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.write(`ran: ${info.command}\n`);
        stream.exit(0);
        stream.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const parsed = sshUtils.parseKey(host.public);
  const publicKey = Array.isArray(parsed) ? parsed[0] : parsed;
  if (publicKey instanceof Error) throw publicKey;
  // ssh2's hostVerifier with hostHash "sha256" receives the hex digest of the raw host key.
  const hostKey = createHash("sha256").update(publicKey.getPublicSSH()).digest("hex");
  return { port: (server.address() as AddressInfo).port, hostKey, server: server as unknown as NetServer };
}

let relay: FakeRelay;
let ssh: Awaited<ReturnType<typeof sshServer>>;
let clientKey: ReturnType<typeof ed25519Pair>;

beforeAll(async () => {
  clientKey = ed25519Pair();
  const parsed = sshUtils.parseKey(clientKey.public);
  ssh = await sshServer((Array.isArray(parsed) ? parsed[0] : parsed) as { getPublicSSH(): Buffer });
  relay = await fakeRelay(() => ssh.port);
});
afterAll(async () => {
  await relay.close();
  ssh.server.close();
});
beforeEach(() => {
  process.env.HOST_RELAY_URL = relay.url;
  process.env.HOST_RELAY_SECRET = SECRET;
  relay.online = true;
  relay.sessions = 0;
});
afterEach(() => {
  delete process.env.HOST_RELAY_URL;
  delete process.env.HOST_RELAY_SECRET;
});

describe("host relay credentials", () => {
  it("issues the connector configuration the relay derives on its side", () => {
    process.env.HOST_RELAY_URL = "https://relay.example.test";
    // Same cross-language vector as services/host-connector's tests.
    const connectorDigestVector = ["f37ab79c2822f6764f09fdf14d8ec5ca", "b0f99a329926c97cbc7db7e26acd0de1"].join("");
    const issued = issueConnectorConfig(HOST, 1);
    expect(issued).toMatchObject({ relay: "wss://relay.example.test", connectionId: HOST, generation: 1 });
    expect(issued.secret).toBe(connectorDigestVector);
  });

  it("mints short, single-use, connection-bound tickets", () => {
    const now = Date.UTC(2026, 8, 24);
    const [body, signature] = mintRelayTicket(SECRET, HOST, now).split(".");
    expect(createHmac("sha256", hmacHex(SECRET, "client-ticket|v1")).update(body).digest("base64url")).toBe(signature);
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(payload).toMatchObject({ aud: HOST, exp: now / 1000 + 60 });
    expect(payload.jti).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(mintRelayTicket(SECRET, HOST, now)).not.toBe(mintRelayTicket(SECRET, HOST, now));
  });

  it("stays off without an https relay and a strong secret", () => {
    expect(hostRelayConfig({ HOST_RELAY_URL: "https://relay.example.test", HOST_RELAY_SECRET: "short" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(hostRelayConfig({ HOST_RELAY_URL: "http://relay.example.test", HOST_RELAY_SECRET: SECRET } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(hostRelayConfig({ HOST_RELAY_URL: "http://127.0.0.1:8787", HOST_RELAY_SECRET: SECRET } as unknown as NodeJS.ProcessEnv)).not.toBeNull();
    delete process.env.HOST_RELAY_SECRET;
    expect(() => issueConnectorConfig(HOST, 1)).toThrow(HostRelayError);
  });
});

describe("relay sessions", () => {
  it("runs SSH end to end through the relay with the host key still pinned", async () => {
    const sock = await openRelaySocket(HOST);
    const output = await new Promise<string>((resolve, reject) => {
      const client = new SshClient();
      client.on("ready", () => {
        client.exec("uname -a", (error, stream) => {
          if (error) { reject(error); return; }
          let text = "";
          stream.on("data", (chunk: Buffer) => { text += chunk.toString(); });
          stream.on("close", () => { client.end(); resolve(text); });
        });
      });
      client.on("error", reject);
      client.connect({
        sock,
        username: "hivra",
        privateKey: clientKey.private,
        hostHash: "sha256",
        hostVerifier: (fingerprint: string) => fingerprint === ssh.hostKey,
      });
    });
    expect(output).toBe("ran: uname -a\n");
  });

  it("refuses a host whose key no longer matches the pin, even through the relay", async () => {
    const sock = await openRelaySocket(HOST);
    await expect(new Promise<void>((resolve, reject) => {
      const client = new SshClient();
      client.on("ready", () => resolve());
      client.on("error", reject);
      client.connect({ sock, username: "hivra", privateKey: clientKey.private, hostHash: "sha256", hostVerifier: () => false });
    })).rejects.toThrow();
  });

  it("says the machine is offline when its connector is not connected", async () => {
    relay.online = false;
    await expect(openRelaySocket(HOST, { timeoutMs: 3_000 })).rejects.toMatchObject({ code: "host_offline" });
  });

  it("reports status and revokes with the admin token", async () => {
    await expect(hostRelayStatus(HOST)).resolves.toMatchObject({ online: true, sessions: 0 });
    await revokeRelayConnector(HOST, 2);
    expect(relay.adminCalls.at(-1)).toEqual({ path: `/v1/hosts/${HOST}/revoke`, body: JSON.stringify({ minGeneration: 2 }) });
    await expect(openRelaySocket("not-a-connection")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
