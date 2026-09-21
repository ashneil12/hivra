import { createHash } from "crypto";

type MockHandler = (...args: unknown[]) => void;
type MockHandlers = Map<string, MockHandler>;
type MockConnectConfig = {
  hostVerifier?: (key: Buffer | string) => boolean;
};
type MockClient = {
  on: jest.Mock<MockClient, [string, MockHandler]>;
  connect: jest.Mock<MockClient, [MockConnectConfig]>;
  destroy: jest.Mock<void, []>;
  end: jest.Mock<void, []>;
};

const mockConnectBehaviors: Array<
  (handlers: MockHandlers, config: MockConnectConfig) => void
> = [];

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: null,
}));

jest.mock("ssh2", () => {
  const Client = jest.fn().mockImplementation(() => {
    const handlers: MockHandlers = new Map();

    const client: MockClient = {
      on: jest.fn<MockClient, [string, MockHandler]>((event, handler) => {
        handlers.set(event, handler);
        return client;
      }),
      connect: jest.fn<MockClient, [MockConnectConfig]>((config) => {
        const behavior = mockConnectBehaviors.shift();
        if (!behavior) {
          throw new Error("No mock SSH connect behavior configured");
        }
        behavior(handlers, config);
        return client;
      }),
      destroy: jest.fn<void, []>(),
      end: jest.fn<void, []>(),
    };

    return client;
  });

  return { Client };
});

import { captureHostFingerprint } from "../ssh";

describe("captureHostFingerprint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectBehaviors.length = 0;
    process.env.HETZNER_SSH_PRIVATE_KEY_B64 = Buffer.from("test-private-key").toString("base64");
  });

  afterEach(() => {
    delete process.env.HETZNER_SSH_PRIVATE_KEY_B64;
  });

  it("retries transient SSH connection timeouts before giving up", async () => {
    const hostKey = Buffer.from("mock-host-key");
    const expectedFingerprint = createHash("sha256").update(hostKey).digest("hex");

    mockConnectBehaviors.push((handlers) => {
      setTimeout(() => {
        handlers.get("error")?.(new Error("connect ETIMEDOUT 203.0.113.4:22"));
      }, 0);
    });

    mockConnectBehaviors.push((handlers, config) => {
      setTimeout(() => {
        config.hostVerifier?.(hostKey);
        handlers.get("error")?.(new Error("Host denied"));
      }, 0);
    });

    await expect(captureHostFingerprint("203.0.113.4", 5_000)).resolves.toBe(expectedFingerprint);

    const { Client } = jest.requireMock("ssh2") as { Client: jest.Mock };
    expect(Client).toHaveBeenCalledTimes(2);
  }, 10_000);
});
