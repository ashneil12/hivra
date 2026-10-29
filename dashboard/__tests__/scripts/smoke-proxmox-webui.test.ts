import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { inspect } from "node:util";

import { main } from "../../scripts/smoke-proxmox-webui";
import {
  deleteProxmoxInstance,
  provisionProxmoxInstance,
  runProxmoxHostScript,
} from "../../src/lib/services/proxmox-instance-service";

// Synthetic 64-hex bearer, shaped like the per-instance API server key.
const BEARER = "5e3a9c1d7b20f48a6c91e2d07b3f58a4c6e19d2b8f0a7c35e4d1b9a26c8f7e01";

jest.mock("../../src/lib/services/proxmox-instance-service", () => ({
  provisionProxmoxInstance: jest.fn(),
  deleteProxmoxInstance: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

describe("smoke-proxmox-webui output", () => {
  const savedEnv = { ...process.env };
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.CROF_KEY = "nahcrof_synthetic_test_key";
    process.env.PROXMOX_PUBLIC_IP = "203.0.113.10";
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      vmid: 4242,
      ipv4: "10.250.0.5",
      gatewayUrl: "https://smoke.example.test",
      apiServerKey: BEARER,
      infrastructure: { vmid: 4242, ipv4: "10.250.0.5" },
    });
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });

    // Stub the gateway probes: /health ok, unauthenticated chat 401, legacy route 400.
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith("/health")) return { ok: true, status: 200, statusText: "OK" } as Response;
      if (url.endsWith("/api/chat/start")) return { ok: false, status: 401, statusText: "Unauthorized" } as Response;
      return { ok: false, status: 400, statusText: "Bad Request" } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it("runs the provisioning checks to completion without printing the bearer key", async () => {
    await main();

    const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => inspect(args, { depth: null }))
      .join("\n");

    expect(printed).toContain("ALL CHECKS PASSED");
    expect(printed).toContain("https://smoke.example.test");
    expect(printed).not.toContain(BEARER);
    expect(printed).not.toContain(BEARER.slice(0, 6));
  });

  it("masks bearer-shaped tokens in the host output a failed run prints", async () => {
    const upstreamKey = `sk-or-v1-${"0f".repeat(32)}`;
    const hostBearer = `Authorization: Bearer ${"Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu0Vw".repeat(2)}`;
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: `qm create failed for ${upstreamKey}`,
      stderr: hostBearer,
      error: `host said ${upstreamKey}`,
    });
    (provisionProxmoxInstance as jest.Mock).mockImplementation(async (_input, options) => {
      await options.runHostScript("qm create 4242");
      return { ok: false, error: "host script failed" };
    });

    await expect(main()).rejects.toThrow("provisioning returned not-ok");

    const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => inspect(args, { depth: null }))
      .join("\n");
    expect(printed).toContain("qm create failed for");
    expect(printed).not.toContain(upstreamKey);
    expect(printed).not.toContain("Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu0Vw");
  });

  it("masks a secret-shaped provisioning error in the summary it prints", async () => {
    const upstreamKey = `sk-or-v1-${"0f".repeat(32)}`;
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: `host said ${upstreamKey}`,
    });

    await expect(main()).rejects.toThrow("provisioning returned not-ok");

    const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => inspect(args, { depth: null }))
      .join("\n");
    expect(printed).toContain("host said");
    expect(printed).not.toContain(upstreamKey);
  });

  it("keeps the bearer out of stdout on a KEEP_VM run and writes it to an owner-only file", async () => {
    process.env.KEEP_VM = "1";
    try {
      await main();

      const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .map((args) => inspect(args, { depth: null }))
        .join("\n");
      expect(printed).toContain("KEEP_VM=1");
      expect(printed).not.toContain(BEARER);
      const pathLine = printed.split("\n").find((line) => line.includes(".bearer"));
      expect(pathLine).toBeDefined();
      const savedPath = /(\S+\.bearer)/.exec(pathLine as string)?.[1] as string;
      expect(existsSync(savedPath)).toBe(true);
      expect(readFileSync(savedPath, "utf8").trim()).toBe(BEARER);
      unlinkSync(savedPath);
    } finally {
      delete process.env.KEEP_VM;
    }
  });
});
