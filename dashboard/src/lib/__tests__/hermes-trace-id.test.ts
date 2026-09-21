import {
  HERMES_TRACE_ID_HEADER,
  ensureHermesTraceId,
  generateHermesTraceId,
  readHermesTraceId,
} from "../hermes-trace-id";

function headers(map: Record<string, string>): { get(name: string): string | null } {
  return {
    get(name: string) {
      const lc = name.toLowerCase();
      for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === lc) return v;
      }
      return null;
    },
  };
}

describe("hermes-trace-id", () => {
  it("the header constant matches the wire format other layers grep for", () => {
    // The header name is part of the public contract — Vercel function
    // logs, Caddy access logs, and the SW all reference it by string.
    // Pin it so a rename here doesn't silently desync the chain.
    expect(HERMES_TRACE_ID_HEADER).toBe("x-hermes-trace-id");
  });

  it("generates a fresh id on every call", () => {
    const a = generateHermesTraceId();
    const b = generateHermesTraceId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });

  it("reads a valid id off a request and returns null when malformed", () => {
    expect(readHermesTraceId(headers({ "x-hermes-trace-id": "abc-123_xyz" }))).toBe("abc-123_xyz");
    expect(readHermesTraceId(headers({}))).toBeNull();
    expect(readHermesTraceId(headers({ "x-hermes-trace-id": "  " }))).toBeNull();
    // Reject anything with shell-active chars so trace ids can flow
    // safely into log line interpolation without escaping at every site.
    expect(readHermesTraceId(headers({ "x-hermes-trace-id": "abc; rm -rf /" }))).toBeNull();
    expect(readHermesTraceId(headers({ "x-hermes-trace-id": "abc'\"`$()" }))).toBeNull();
  });

  it("rejects pathologically long ids so a malicious client cannot blow up log lines", () => {
    const huge = "a".repeat(1024);
    expect(readHermesTraceId(headers({ "x-hermes-trace-id": huge }))).toBeNull();
  });

  it("ensureHermesTraceId returns the client-supplied id when valid, else mints one", () => {
    expect(ensureHermesTraceId(headers({ "x-hermes-trace-id": "client-supplied" }))).toBe(
      "client-supplied",
    );
    const minted = ensureHermesTraceId(headers({}));
    expect(typeof minted).toBe("string");
    expect(minted.length).toBeGreaterThan(8);
  });
});
