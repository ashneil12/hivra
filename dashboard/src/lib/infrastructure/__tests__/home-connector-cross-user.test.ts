/** @jest-environment node */
// User B holding user A's connector id must get nothing from it: no host key,
// no session, and no enrolment confirmation that dials it.
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("../home-connector-store", () => ({
  getHomeConnector: jest.fn(),
  insertHomeConnector: jest.fn(),
  consumeEnrolmentToken: jest.fn(),
  countPendingEnrolments: jest.fn(),
  markHomeConnectorRevoked: jest.fn(),
}));
const openRelaySocket = jest.fn();
jest.mock("../host-relay", () => ({
  ...jest.requireActual("../host-relay"),
  openRelaySocket: (...args: unknown[]) => openRelaySocket(...args),
}));

import { resolveValidatedSshDestination } from "../connection-runtime";
import { connectorHostname } from "../home-connector-host";
import * as store from "../home-connector-store";
import { captureServerHostKey } from "../host-key-capture";
import { verifyEnrollmentKeyOnServer } from "../server-enrollment-service";

const ID = "11111111-1111-4111-8111-111111111111";
const NAME = connectorHostname(ID);
const saved = { ...process.env };

beforeAll(() => {
  process.env.HIVRA_HOME_CONNECTOR_ENABLED = "true";
  process.env.HOST_RELAY_URL = "https://relay.example.test";
  process.env.HOST_RELAY_SECRET = "test-relay-secret-with-at-least-32-characters";
});
afterAll(() => { process.env = saved; });
beforeEach(() => {
  jest.clearAllMocks();
  // Only user_a owns this connector.
  (store.getHomeConnector as jest.Mock).mockImplementation(async (userId: string) =>
    userId === "user_a" ? { id: ID, user_id: "user_a", generation: 1, enrolment_expires_at: "x", enrolment_consumed_at: "x", revoked_at: null } : null);
});

describe("another user's connector id", () => {
  it("is refused by the resolver for user B and accepted for its owner", async () => {
    await expect(resolveValidatedSshDestination(NAME, { userId: "user_b" })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    await expect(resolveValidatedSshDestination(NAME, { userId: "user_a" })).resolves.toMatchObject({ connectorId: ID });
  });

  it("gives user B no host key and opens no relay session", async () => {
    expect(await captureServerHostKey({ sshHost: NAME, sshPort: 22, userId: "user_b" })).toBeNull();
    expect(openRelaySocket).not.toHaveBeenCalled();
  });

  it("stops an enrolment confirmation by user B before any relay session or command", async () => {
    const run = jest.fn();
    const failure = await verifyEnrollmentKeyOnServer({
      userId: "user_b", connectionId: "c1", sshHost: NAME, sshPort: 22,
      pinnedFingerprint: "SHA256:" + "A".repeat(43), privateKey: "key", refuseProxmox: false,
    }, { run, resolve: resolveValidatedSshDestination });
    expect(failure).toBe("connection_failed");
    expect(run).not.toHaveBeenCalled();
    expect(openRelaySocket).not.toHaveBeenCalled();
  });
});
