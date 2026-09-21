import {
  deriveBrowserVncPassword,
  buildBrowserVncWebSocketUrl,
} from "@/lib/browser-vnc";

describe("deriveBrowserVncPassword", () => {
  it("returns a 24-character hex string", () => {
    const password = deriveBrowserVncPassword("my-api-server-key");
    expect(typeof password).toBe("string");
    expect(password).toHaveLength(24);
    expect(/^[0-9a-f]+$/.test(password)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const key = "stable-key-abc123";
    expect(deriveBrowserVncPassword(key)).toBe(deriveBrowserVncPassword(key));
  });

  it("produces different passwords for different keys", () => {
    expect(deriveBrowserVncPassword("key-a")).not.toBe(
      deriveBrowserVncPassword("key-b")
    );
  });

  it("does not include the raw API key in the output", () => {
    const key = "supersecret-api-key-12345";
    const password = deriveBrowserVncPassword(key);
    expect(password).not.toContain(key);
  });
});

describe("buildBrowserVncWebSocketUrl", () => {
  it("converts http:// to ws://", () => {
    const url = buildBrowserVncWebSocketUrl("http://203.0.113.4:8080");
    expect(url).toBe("ws://203.0.113.4:8080/vnc/websockify");
  });

  it("converts https:// to wss://", () => {
    const url = buildBrowserVncWebSocketUrl("https://agent.example.com");
    expect(url).toBe("wss://agent.example.com/vnc/websockify");
  });

  it("strips trailing slashes from the gateway base", () => {
    const url = buildBrowserVncWebSocketUrl("http://203.0.113.4/");
    expect(url).toBe("ws://203.0.113.4/vnc/websockify");
  });
});
