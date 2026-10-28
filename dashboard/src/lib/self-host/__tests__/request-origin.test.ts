import { isSameOriginRequest } from "../request-origin";

const ENV_KEYS = ["HIVRA_TRUST_FORWARDED_HEADERS", "VERCEL"] as const;

describe("self-host request origin validation", () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

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
    // A deployment behind a proxy that rewrites the forwarded headers opts in.
    process.env.HIVRA_TRUST_FORWARDED_HEADERS = "true";
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

  it("honors a conflicting x-forwarded-host on Vercel, which overwrites it", () => {
    process.env.VERCEL = "1";
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

  // On a direct request, or behind a proxy that passes headers through, the
  // client picks x-forwarded-host. When it disagrees with Host it must not
  // widen the allowed origins — otherwise "X-Forwarded-Host: evil.example"
  // would make evil.example a same-origin site for CSRF purposes.
  it("ignores a spoofed x-forwarded-host that disagrees with Host", () => {
    const request = new Request("http://real.example/api/self-host/auth/login", {
      headers: {
        host: "real.example",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(false);
  });

  it("still accepts real traffic when a spoofed x-forwarded-host is present", () => {
    // Internal URL differs from the public host, so only the Host header —
    // not the attacker-chosen forwarded one — can admit this origin.
    const request = new Request("http://internal:3000/api/self-host/auth/login", {
      headers: {
        host: "real.example",
        origin: "https://real.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(true);
  });

  it("accepts a forwarded host that agrees with Host without any opt-in", () => {
    const request = new Request("http://internal:3000/api/self-host/auth/login", {
      headers: {
        host: "hivra.example.test",
        origin: "https://hivra.example.test",
        "x-forwarded-host": "HIVRA.example.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginRequest(request)).toBe(true);
  });
});
