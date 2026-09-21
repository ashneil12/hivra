import { createServer } from "@/lib/hetzner/client";

describe("hetzner client user_data guard", () => {
  const originalToken = process.env.HETZNER_API_TOKEN;

  beforeEach(() => {
    process.env.HETZNER_API_TOKEN = "test-token";
    global.fetch = jest.fn();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.HETZNER_API_TOKEN;
    } else {
      process.env.HETZNER_API_TOKEN = originalToken;
    }
    jest.resetAllMocks();
  });

  it("rejects oversized user_data before making a Hetzner request", async () => {
    await expect(
      createServer({
        name: "host-test",
        server_type: "cx22",
        image: "ubuntu-22.04",
        location: "nbg1",
        user_data: "x".repeat(32769),
      })
    ).rejects.toThrow(/user_data length 32769 exceeds 32768 bytes before request/i);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
