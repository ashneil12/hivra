/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("../home-connector-store", () => ({
  insertHomeConnector: jest.fn(),
  consumeEnrolmentToken: jest.fn(),
  getHomeConnector: jest.fn(),
  markHomeConnectorRevoked: jest.fn(),
}));
jest.mock("../host-relay", () => {
  const actual = jest.requireActual("../host-relay");
  return { ...actual, revokeRelayConnector: jest.fn() };
});

import { createHash } from "node:crypto";

import {
  HomeConnectorError,
  connectorHostAllowedForUser,
  homeConnectorEnabled,
  redeemHomeConnectorEnrolment,
  revokeConnectorForRemovedConnection,
  revokeHomeConnector,
  startHomeConnectorEnrolment,
} from "../home-connector";
import { connectorHostname, isConnectorNamespace, parseConnectorHostname } from "../home-connector-host";
import { ProxmoxSshHostSchema } from "../contracts";
import * as store from "../home-connector-store";
import { connectorSecret, revokeRelayConnector } from "../host-relay";

const SECRET = "test-relay-secret-with-at-least-32-characters";
const ID = "11111111-1111-4111-8111-111111111111";
const ON = {
  HIVRA_HOME_CONNECTOR_ENABLED: "true",
  HOST_RELAY_URL: "https://relay.example.test",
  HOST_RELAY_SECRET: SECRET,
  NEXT_PUBLIC_APP_URL: "https://canary.example.test",
};
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, user_id: "user_1", generation: 1, enrolment_expires_at: "2030-01-01T00:00:00Z",
  enrolment_consumed_at: "2029-01-01T00:00:00Z", revoked_at: null, ...over,
});
const mocked = <T,>(fn: T) => fn as unknown as jest.Mock;

beforeEach(() => jest.clearAllMocks());
// issueConnectorConfig reads the relay settings from the process environment.
const savedEnv = { url: process.env.HOST_RELAY_URL, secret: process.env.HOST_RELAY_SECRET };
beforeAll(() => { process.env.HOST_RELAY_URL = ON.HOST_RELAY_URL; process.env.HOST_RELAY_SECRET = SECRET; });
afterAll(() => {
  if (savedEnv.url === undefined) delete process.env.HOST_RELAY_URL; else process.env.HOST_RELAY_URL = savedEnv.url;
  if (savedEnv.secret === undefined) delete process.env.HOST_RELAY_SECRET; else process.env.HOST_RELAY_SECRET = savedEnv.secret;
});

describe("the home connector flag", () => {
  it("is off unless it is exactly true and the relay is configured", () => {
    expect(homeConnectorEnabled({})).toBe(false);
    expect(homeConnectorEnabled({ ...ON, HIVRA_HOME_CONNECTOR_ENABLED: "1" })).toBe(false);
    expect(homeConnectorEnabled({ ...ON, HOST_RELAY_SECRET: undefined })).toBe(false);
    expect(homeConnectorEnabled(ON)).toBe(true);
  });
});

describe("reserved connector names", () => {
  it("round-trips an id and refuses anything else", () => {
    expect(parseConnectorHostname(connectorHostname(ID))).toBe(ID);
    expect(parseConnectorHostname("192.168.1.5")).toBeNull();
    expect(parseConnectorHostname("not-a-uuid.connector.hivra.invalid")).toBeNull();
    expect(isConnectorNamespace("not-a-uuid.connector.hivra.invalid")).toBe(true);
    // The connection form accepts the reserved name as an SSH host.
    expect(ProxmoxSshHostSchema.safeParse(connectorHostname(ID)).success).toBe(true);
  });
});

describe("enrolment", () => {
  it("issues a one-time command and stores only a hash of the token", async () => {
    mocked(store.insertHomeConnector).mockImplementation(async () => row());
    const enrolment = await startHomeConnectorEnrolment("user_1", { env: ON, now: () => Date.parse("2029-01-01T00:00:00Z") });
    const token = /-- (hvc_[A-Za-z0-9_-]{32})$/.exec(enrolment.command)?.[1] as string;
    expect(token).toBeTruthy();
    expect(enrolment.command).toBe(`curl -fsSL https://canary.example.test/api/infrastructure/home-connector/install | sudo bash -s -- ${token}`);
    expect(enrolment.command).not.toContain(SECRET);
    const stored = mocked(store.insertHomeConnector).mock.calls[0][0];
    expect(stored.tokenHash).toBe(createHash("sha256").update(`home-connector-enrol|v1|${token}`).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.expiresAt).toBe("2029-01-01T00:15:00.000Z");
    expect(enrolment.hostname).toBe(connectorHostname(ID));
  });

  it("refuses to issue anything while the flag is off", async () => {
    await expect(startHomeConnectorEnrolment("user_1", { env: {} })).rejects.toMatchObject({ code: "disabled" });
    expect(store.insertHomeConnector).not.toHaveBeenCalled();
  });

  it("exchanges a token for the connector's derived secret, never the master one", async () => {
    mocked(store.consumeEnrolmentToken).mockResolvedValue(row({ generation: 3 }));
    const config = await redeemHomeConnectorEnrolment(`hvc_${"a".repeat(32)}`, { env: ON });
    expect(config).toEqual({ relay: "wss://relay.example.test", connectionId: ID, generation: 3, secret: connectorSecret(SECRET, ID, 3) });
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  it("refuses a used, expired or malformed token", async () => {
    mocked(store.consumeEnrolmentToken).mockResolvedValue(null);
    await expect(redeemHomeConnectorEnrolment(`hvc_${"a".repeat(32)}`, { env: ON })).rejects.toBeInstanceOf(HomeConnectorError);
    await expect(redeemHomeConnectorEnrolment("nope", { env: ON })).rejects.toMatchObject({ code: "not_usable" });
    expect(store.consumeEnrolmentToken).toHaveBeenCalledTimes(1);
    await expect(redeemHomeConnectorEnrolment(`hvc_${"a".repeat(32)}`, { env: {} })).rejects.toMatchObject({ code: "disabled" });
  });
});

describe("who may use a connector name", () => {
  it("passes ordinary hosts through and keeps the reserved namespace for its owner", async () => {
    expect(await connectorHostAllowedForUser("user_1", "server.example.test", ON)).toBe(true);
    expect(await connectorHostAllowedForUser("user_1", "x.connector.hivra.invalid", ON)).toBe(false);
    mocked(store.getHomeConnector).mockResolvedValue(row());
    expect(await connectorHostAllowedForUser("user_1", connectorHostname(ID), ON)).toBe(true);
    mocked(store.getHomeConnector).mockResolvedValue(null);
    expect(await connectorHostAllowedForUser("user_2", connectorHostname(ID), ON)).toBe(false);
    mocked(store.getHomeConnector).mockResolvedValue(row({ revoked_at: "2029-06-01T00:00:00Z" }));
    expect(await connectorHostAllowedForUser("user_1", connectorHostname(ID), ON)).toBe(false);
    expect(await connectorHostAllowedForUser("user_1", connectorHostname(ID), {})).toBe(false);
  });
});

describe("revoke", () => {
  it("raises the generation here, then tells the relay the new minimum", async () => {
    mocked(store.getHomeConnector).mockResolvedValue(row({ generation: 2 }));
    mocked(store.markHomeConnectorRevoked).mockResolvedValue(row({ generation: 3, revoked_at: "2029-06-01T00:00:00Z" }));
    mocked(revokeRelayConnector).mockResolvedValue(undefined);
    await revokeHomeConnector("user_1", ID);
    expect(revokeRelayConnector).toHaveBeenCalledWith(ID, 3);
  });

  it("says so when the relay does not confirm, and can be repeated", async () => {
    mocked(store.getHomeConnector).mockResolvedValue(row({ generation: 3, revoked_at: "2029-06-01T00:00:00Z" }));
    mocked(store.markHomeConnectorRevoked).mockResolvedValue(row({ generation: 3, revoked_at: "2029-06-01T00:00:00Z" }));
    mocked(revokeRelayConnector).mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(undefined);
    await expect(revokeHomeConnector("user_1", ID)).rejects.toMatchObject({ code: "unavailable" });
    await expect(revokeHomeConnector("user_1", ID)).resolves.toBeUndefined();
    expect(revokeRelayConnector).toHaveBeenLastCalledWith(ID, 3);
  });

  it("is called when a connection to a connector machine is removed, and ignores other hosts", async () => {
    mocked(store.getHomeConnector).mockResolvedValue(row());
    mocked(store.markHomeConnectorRevoked).mockResolvedValue(row({ generation: 2, revoked_at: "2029-06-01T00:00:00Z" }));
    await revokeConnectorForRemovedConnection("user_1", "203.0.113.9");
    await revokeConnectorForRemovedConnection("user_1", null);
    expect(revokeRelayConnector).not.toHaveBeenCalled();
    await revokeConnectorForRemovedConnection("user_1", connectorHostname(ID));
    expect(revokeRelayConnector).toHaveBeenCalledWith(ID, 2);
  });
});
