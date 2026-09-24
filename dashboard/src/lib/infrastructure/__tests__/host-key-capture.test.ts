/** @jest-environment node */

jest.mock("server-only", () => ({}));

import net from "node:net";
import type { AddressInfo } from "node:net";

import { Server as Ssh2Server, utils as ssh2Utils } from "ssh2";

import { InfrastructureNetworkError } from "../connection-runtime";
import { captureServerHostKey } from "../host-key-capture";
import { canonicalEd25519HostKey } from "../ssh-host-key";

type Seen = { authentications: number; sessions: number; clients: number };

async function sshServer(type: "ed25519" | "rsa"): Promise<{ port: number; publicKey: string; seen: Seen; close: () => Promise<void> }> {
  const key = type === "rsa" ? ssh2Utils.generateKeyPairSync("rsa", { bits: 2048 }) : ssh2Utils.generateKeyPairSync("ed25519");
  const seen: Seen = { authentications: 0, sessions: 0, clients: 0 };
  const server = new Ssh2Server({ hostKeys: [key.private] }, client => {
    seen.clients += 1;
    client.on("authentication", ctx => { seen.authentications += 1; ctx.accept(); });
    client.on("session", () => { seen.sessions += 1; });
    client.on("error", () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    publicKey: key.public.trim(),
    seen,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

const loopback = async () => ({ hostname: "server.test", address: "127.0.0.1", family: 4 as const });

describe("captureServerHostKey (T44, T45)", () => {
  it("reads the Ed25519 key a real SSH server presents, sending no authentication and no command", async () => {
    const server = await sshServer("ed25519");
    try {
      const captured = await captureServerHostKey({ sshHost: "server.test", sshPort: server.port }, { resolve: loopback });
      expect(captured).toEqual(canonicalEd25519HostKey(server.publicKey));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(server.seen.authentications).toBe(0);
      expect(server.seen.sessions).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("returns nothing for an RSA-only server", async () => {
    const server = await sshServer("rsa");
    try {
      expect(await captureServerHostKey({ sshHost: "server.test", sshPort: server.port }, { resolve: loopback })).toBeNull();
      expect(server.seen.authentications).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("returns nothing for a service that isn't SSH, or a closed port, and closes its socket", async () => {
    const closed: Promise<void>[] = [];
    const plain = net.createServer(socket => {
      closed.push(new Promise(resolve => socket.on("close", () => resolve())));
      socket.on("error", () => undefined);
      socket.resume();
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    await new Promise<void>(resolve => plain.listen(0, "127.0.0.1", resolve));
    const port = (plain.address() as AddressInfo).port;
    try {
      expect(await captureServerHostKey({ sshHost: "server.test", sshPort: port }, { resolve: loopback })).toBeNull();
      // The capture closed its side too; nothing is left half-open.
      expect(closed).toHaveLength(1);
      await closed[0];
    } finally {
      await new Promise(resolve => plain.close(resolve));
    }
    expect(await captureServerHostKey({ sshHost: "server.test", sshPort: port }, { resolve: loopback })).toBeNull();
  });

  it("never dials a destination the SSRF rules refuse", async () => {
    const client = jest.fn();
    const refuse = jest.fn().mockRejectedValue(new InfrastructureNetworkError("ssh_host_forbidden", "no"));
    expect(await captureServerHostKey({ sshHost: "169.254.169.254", sshPort: 22 }, { resolve: refuse, client })).toBeNull();
    expect(refuse).toHaveBeenCalledWith("169.254.169.254");
    expect(client).not.toHaveBeenCalled();
  });

  it("uses the real resolver by default, which refuses reserved addresses", async () => {
    const client = jest.fn();
    for (const host of ["127.0.0.1", "10.240.0.1", "169.254.169.254", "localhost"]) {
      expect(await captureServerHostKey({ sshHost: host, sshPort: 22 }, { client })).toBeNull();
    }
    expect(client).not.toHaveBeenCalled();
  });
});
