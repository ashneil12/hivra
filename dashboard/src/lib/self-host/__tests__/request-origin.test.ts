import { isSameOriginRequest } from "../request-origin";

describe("self-host request origin validation", () => {
  it("accepts the external host even when Next normalizes the internal request URL", () => {
    const request = new Request("http://localhost:4010/api/self-host/auth/login", {
      headers: {
        host: "127.0.0.1:4010",
        origin: "http://127.0.0.1:4010",
      },
    });
    expect(isSameOriginRequest(request)).toBe(true);
  });

  it("honors a reverse proxy's forwarded scheme and host", () => {
    const request = new Request("http://localhost:3000/api/self-host/auth/login", {
      headers: {
        host: "localhost:3000",
        origin: "https://hivra.example.test",
        "x-forwarded-host": "hivra.example.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(true);
  });

  it("rejects a different or malformed origin", () => {
    expect(isSameOriginRequest(new Request("http://localhost:4010/login", {
      headers: { host: "localhost:4010", origin: "https://attacker.invalid" },
    }))).toBe(false);
    expect(isSameOriginRequest(new Request("http://localhost:4010/login", {
      headers: { host: "localhost:4010", origin: "not a url" },
    }))).toBe(false);
  });
});
