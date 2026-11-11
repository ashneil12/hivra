/** @jest-environment node */
// A machine reached through the home connector is dialled through a relay
// session, with the pinned host key check left exactly as it is for any host.

jest.mock("server-only", () => ({}));

const connectCalls: Array<Record<string, unknown>> = [];
jest.mock("ssh2", () => {
  const Client = jest.fn().mockImplementation(() => {
    const client: { on: jest.Mock; connect: jest.Mock; end: jest.Mock; exec: jest.Mock } = {
      on: jest.fn(() => client),
      connect: jest.fn((config: Record<string, unknown>) => { connectCalls.push(config); return client; }),
      end: jest.fn(),
      exec: jest.fn(),
    };
    return client;
  });
  return { Client };
});

const openRelaySocket = jest.fn();
jest.mock("@/lib/infrastructure/host-relay", () => ({ openRelaySocket: (...args: unknown[]) => openRelaySocket(...args) }));

import { Duplex } from "node:stream";

import { runProxmoxHostScript } from "../proxmox-instance-service";

const ID = "11111111-1111-4111-8111-111111111111";
const NAME = `${ID}.connector.hivra.invalid`;
const baseEnv = () => ({
  HIVRA_USER_INFRA_CONNECTION: "true",
  PROXMOX_EXEC_MODE: "ssh",
  PROXMOX_SSH_HOST: NAME,
  PROXMOX_SSH_PORT: "22",
  PROXMOX_SSH_USER: "root",
  PROXMOX_SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1rZXktZm9yLXRoZS1tb2NrZWQtY2xpZW50\n-----END OPENSSH PRIVATE KEY-----\n",
  PROXMOX_SSH_HOST_FINGERPRINT: "SHA256:" + "A".repeat(43),
  PROXMOX_SSH_TRANSPORT: "connector",
  PROXMOX_SSH_CONNECTOR_ID: ID,
});

beforeEach(() => { connectCalls.length = 0; openRelaySocket.mockReset(); });

describe("running a host script over the home connector", () => {
  it("connects over the relay socket and keeps the pinned fingerprint check", async () => {
    const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    openRelaySocket.mockResolvedValue(socket);
    const pending = runProxmoxHostScript("true", baseEnv(), 50);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openRelaySocket).toHaveBeenCalledWith(ID);
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].sock).toBe(socket);
    expect(connectCalls[0].hostHash).toBe("sha256");
    const verify = connectCalls[0].hostVerifier as (fingerprint: string) => boolean;
    expect(verify("SHA256:" + "B".repeat(43))).toBe(false);
    await pending;
    socket.destroy();
  });

  it("says why when the machine is offline, and never dials directly", async () => {
    openRelaySocket.mockRejectedValue(new Error("This machine isn't connected to Hivra right now."));
    const result = await runProxmoxHostScript("true", baseEnv(), 50);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("isn't connected to Hivra right now");
    expect(connectCalls).toHaveLength(0);
  });

  it("refuses a connector id that does not match the host name", async () => {
    const result = await runProxmoxHostScript("true", { ...baseEnv(), PROXMOX_SSH_CONNECTOR_ID: "22222222-2222-4222-8222-222222222222" }, 50);
    expect(result.ok).toBe(false);
    expect(openRelaySocket).not.toHaveBeenCalled();
    expect(connectCalls).toHaveLength(0);
  });
});
