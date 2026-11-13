/** @jest-environment node */
import { resolveChatEndpoints } from "../resolve";

describe("resolveChatEndpoints", () => {
  it("resolves each chat service, leaves out what fails or times out, and caches", async () => {
    const lookupImpl = jest.fn(async (host: string) => {
      if (host === "api.telegram.org") return ["192.0.2.10", "2001:db8::1"];
      if (host === "gateway.discord.gg") throw new Error("nxdomain");
      if (host === "chat.signal.org") return new Promise<string[]>(() => {});
      return [];
    });
    const endpoints = await resolveChatEndpoints({ lookupImpl, timeoutMs: 50, fresh: true, now: () => 1_000 });
    expect(endpoints[0]).toEqual({ p: "telegram", ports: [443, 80, 88, 8443], h: ["api.telegram.org"], a: ["0000000000000000FFFF00000A0200C0", "0A0200C0", "B80D0120000000000000000001000000"] });
    expect(endpoints.slice(1).every((e) => e.a.length === 0)).toBe(true);
    // A partial answer is not cached: the next sweep asks again.
    const calls = lookupImpl.mock.calls.length;
    await resolveChatEndpoints({ lookupImpl, timeoutMs: 50, now: () => 2_000 });
    expect(lookupImpl.mock.calls.length).toBe(calls * 2);
  });

  it("caches an answer in which every service resolved", async () => {
    const lookupImpl = jest.fn(async () => ["192.0.2.10"]);
    const endpoints = await resolveChatEndpoints({ lookupImpl, timeoutMs: 50, fresh: true, now: () => 10_000 });
    expect(endpoints.every((e) => e.a.length > 0)).toBe(true);
    const calls = lookupImpl.mock.calls.length;
    expect(await resolveChatEndpoints({ lookupImpl, now: () => 20_000 })).toBe(endpoints);
    expect(lookupImpl.mock.calls.length).toBe(calls);
  });
});
