jest.mock("node:dns", () => ({
  lookup: jest.fn(),
}));

import { lookup } from "node:dns";
import { directSslipSafeLookup, ssrfSafeLookup } from "@/lib/ssrf-safe-fetch";
import { reservedAddressReason } from "@/lib/url-safety";

const mockLookup = lookup as unknown as jest.Mock;

type LookupResult = {
  err: NodeJS.ErrnoException | null;
  address?: string | Array<{ address: string; family: number }>;
  family?: number;
};

function resolveTo(addresses: Array<{ address: string; family: number }>) {
  mockLookup.mockImplementation((_host: string, _opts: unknown, cb: (...a: unknown[]) => void) => {
    cb(null, addresses);
  });
}

function run(host: string, options: Record<string, unknown> = {}): Promise<LookupResult> {
  return new Promise((resolve) => {
    ssrfSafeLookup(host, options, (err, address, family) => resolve({ err, address, family }));
  });
}
function runDirect(host: string, options: Record<string, unknown> = {}): Promise<LookupResult> {
  return new Promise((resolve) => directSslipSafeLookup(host, options,
    (err, address, family) => resolve({ err, address, family })));
}

describe("directSslipSafeLookup", () => {
  it("pins the exact public IPv4 encoded by the immutable hostname without DNS", async () => {
    const result = await runDirect("93-184-216-34.sslip.io");
    expect(result).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    expect(mockLookup).not.toHaveBeenCalled();
  });
  it.each(["127-0-0-1.sslip.io", "169-254-169-254.sslip.io", "999-1-1-1.sslip.io",
    "93-0184-216-34.sslip.io", "93-184-216-34.other.example"])("rejects unsafe or noncanonical direct host %s", async host => {
    expect((await runDirect(host)).err).toBeTruthy();
  });
  it("returns the same pinned address in all-results mode", async () => {
    expect(await runDirect("93-184-216-34.sslip.io", { all: true })).toEqual({ err: null, address: [{ address: "93.184.216.34", family: 4 }], family: undefined });
  });
});

describe("reservedAddressReason", () => {
  it.each([
    "10.240.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::1",
    "::ffff:10.240.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "0:0:0:0:0:ffff:a00:1",
  ])("flags %s as reserved", (ip) => {
    expect(reservedAddressReason(ip)).not.toBeNull();
  });

  it.each([
    "93.184.216.34",
    "11.0.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "2001:db8::1",
  ])("treats %s as public", (ip) => {
    expect(reservedAddressReason(ip)).toBeNull();
  });
});

describe("ssrfSafeLookup", () => {
  beforeEach(() => mockLookup.mockReset());

  it("passes through a public address (single result)", async () => {
    resolveTo([{ address: "93.184.216.34", family: 4 }]);
    const result = await run("example.com", {});
    expect(result.err).toBeNull();
    expect(result.address).toBe("93.184.216.34");
    expect(result.family).toBe(4);
  });

  it("returns the full list when options.all is set", async () => {
    resolveTo([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
    const result = await run("example.com", { all: true });
    expect(result.err).toBeNull();
    expect(Array.isArray(result.address)).toBe(true);
  });

  it("blocks when the host resolves to a private IPv4 (DNS rebinding)", async () => {
    resolveTo([{ address: "10.240.0.5", family: 4 }]);
    const result = await run("rebind.attacker.example", {});
    expect(result.err).toBeTruthy();
    expect(result.err?.message).toContain("ssrf_blocked");
  });

  it("fails closed when ANY resolved address is private", async () => {
    resolveTo([
      { address: "203.0.113.4", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]);
    const result = await run("mixed.attacker.example", { all: true });
    expect(result.err).toBeTruthy();
    expect(result.err?.message).toContain("ssrf_blocked");
  });

  it("blocks IPv6 ULA resolutions", async () => {
    resolveTo([{ address: "fd00::1", family: 6 }]);
    const result = await run("v6.attacker.example", {});
    expect(result.err).toBeTruthy();
  });

  it("blocks a fully expanded IPv4-mapped loopback DNS answer", async () => {
    resolveTo([{ address: "0:0:0:0:0:ffff:7f00:1", family: 6 }]);
    const result = await run("mapped.attacker.example", {});
    expect(result.err).toBeTruthy();
    expect(result.err?.message).toContain("ssrf_blocked");
  });

  it("propagates a genuine DNS error", async () => {
    mockLookup.mockImplementation((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => {
      cb(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    });
    const result = await run("nonexistent.invalid", {});
    expect(result.err).toBeTruthy();
    expect(result.err?.code).toBe("ENOTFOUND");
  });

  it("fails when resolution returns no addresses", async () => {
    resolveTo([]);
    const result = await run("empty.example", {});
    expect(result.err).toBeTruthy();
  });
});
