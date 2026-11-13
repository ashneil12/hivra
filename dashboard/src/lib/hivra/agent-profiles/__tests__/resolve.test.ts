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
    expect(endpoints).toEqual([{ p: "telegram", ports: [443, 80, 88, 8443], a: ["0000000000000000FFFF00000A0200C0", "0A0200C0", "B80D0120000000000000000001000000"] }]);
    const calls = lookupImpl.mock.calls.length;
    expect(await resolveChatEndpoints({ lookupImpl, now: () => 2_000 })).toBe(endpoints);
    expect(lookupImpl.mock.calls.length).toBe(calls);
  });
});
