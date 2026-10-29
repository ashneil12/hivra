import { createHash } from "node:crypto";

import { log } from "../logger";
import { buildOpsEventFingerprint, reportOpsEvent } from "../ops-events";

jest.mock("../ops-events", () => {
  const actual = jest.requireActual("../ops-events");
  return {
    ...actual,
    reportOpsEvent: jest.fn().mockResolvedValue(null),
  };
});

describe("structured logger", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("can write an error log without creating a second ops event", async () => {
    log.error("client ops event received", new Error("client_reported_error"), {
      source: "client-runtime",
      route: "/dashboard/chat",
      requestId: "req_123",
      userId: "user_123",
      failureType: "client_ops_event",
      reportOpsEvent: false,
    });

    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).toContain("client ops event received");
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  // The console line withholds err.message and err.stack unless verboseErrors is
  // set. The ops_events mirror must follow the same rule: upstream text that the
  // console would withhold must not be stored (ops_events is read by admins, and
  // by an instance owner through failureAlert).
  describe("ops_events mirror of error logs", () => {
    const upstreamText = "upstream said https://api.example.test/v1?token=ZZZ123 body";

    it("stores the class name and code, not the raw error message or stack", async () => {
      const err = new Error(upstreamText) as Error & { code?: string };
      err.code = "ECONNREFUSED";

      log.error("hetzner provision failed", err, { source: "hetzner", instanceId: "inst_1" });

      expect(reportOpsEvent).toHaveBeenCalledTimes(1);
      const payload = (reportOpsEvent as jest.Mock).mock.calls[0][0];
      expect(payload.title).toBe("hetzner provision failed");
      expect(payload.message).toBe("Error (ECONNREFUSED)");
      expect(JSON.stringify(payload)).not.toContain("ZZZ123");
      expect(payload.sampleStack).toBeUndefined();
    });

    it("stores the same message the console line carries", async () => {
      const savedFormat = process.env.HERMES_LOG_FORMAT;
      process.env.HERMES_LOG_FORMAT = "json";
      try {
        log.error("probe failed", new TypeError(upstreamText), { source: "probe" });
      } finally {
        if (savedFormat === undefined) delete process.env.HERMES_LOG_FORMAT;
        else process.env.HERMES_LOG_FORMAT = savedFormat;
      }

      const consoleLine = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(consoleLine.err).toEqual({ name: "TypeError" });
      expect(JSON.stringify(consoleLine)).not.toContain("ZZZ123");
      const payload = (reportOpsEvent as jest.Mock).mock.calls[0][0];
      expect(payload.message).toBe("TypeError");
    });

    it("keeps the raw message and stack when the caller opts in with verboseErrors", async () => {
      const err = new Error(upstreamText);

      log.error("probe failed", err, { source: "probe", verboseErrors: true });

      const payload = (reportOpsEvent as jest.Mock).mock.calls[0][0];
      expect(payload.message).toBe(upstreamText);
      expect(payload.sampleStack).toEqual(expect.stringContaining("Error"));
    });

    it("stores the curated failureMessage when a caller supplies one, never the raw message", async () => {
      const err = new Error(upstreamText);

      log.error("proxmox delete failed", err, {
        source: "instances",
        failureOwner: "hypervisor",
        failureMessage: "Proxmox delete failed. Please retry - the instance has not been removed.",
      });

      const payload = (reportOpsEvent as jest.Mock).mock.calls[0][0];
      expect(payload.message).toBe("Proxmox delete failed. Please retry - the instance has not been removed.");
      expect(JSON.stringify(payload)).not.toContain("ZZZ123");
      expect(payload.sampleStack).toBeUndefined();
    });

    // A code-less error is grouped by where it was thrown (its top stack frame), never by its
    // text. A digest of the raw message was a guessable oracle: an internal IP or VMID can be
    // tested against it, so the fingerprint must not depend on the message.
    it("groups code-less errors from one call site whatever their raw text", async () => {
      const make = (message: string) => new TypeError(message);
      log.error("fetch failed", make("connect to host-a refused"), { source: "probe" });
      log.error("fetch failed", make("connect to host-b refused"), { source: "probe" });

      const [first, second] = (reportOpsEvent as jest.Mock).mock.calls.map(([input]) => input);
      expect(first.message).toBe("TypeError");
      expect(second.message).toBe("TypeError");
      expect(buildOpsEventFingerprint(first)).toBe(buildOpsEventFingerprint(second));
      expect(JSON.stringify([first, second])).not.toContain("host-");
    });

    it("keeps code-less errors from different call sites apart in the fingerprint", async () => {
      const siteA = (message: string) => new TypeError(message);
      const siteB = (message: string) => new TypeError(message);
      log.error("fetch failed", siteA("connection refused"), { source: "probe" });
      log.error("fetch failed", siteB("connection refused"), { source: "probe" });

      const [first, second] = (reportOpsEvent as jest.Mock).mock.calls.map(([input]) => input);
      expect(buildOpsEventFingerprint(first)).not.toBe(buildOpsEventFingerprint(second));
    });

    it("never puts a digest of the raw message into the event", async () => {
      const raw = "connect to 10.250.20.1 port 22: Connection refused";
      log.error("fetch failed", new TypeError(raw), { source: "probe" });

      const payload = (reportOpsEvent as jest.Mock).mock.calls[0][0];
      expect(JSON.stringify(payload)).not.toContain(createHash("sha256").update(raw).digest("hex"));
      expect(JSON.stringify(payload)).not.toContain("10.250.20.1");
    });

    it("groups a curated failureMessage by call site, not by the shared sentence or raw text", async () => {
      const curated = { source: "instances", failureMessage: "Proxmox delete failed. Please retry." };
      const destroy = (vmid: number) => new Error(`qm destroy ${vmid} failed`);
      log.error("proxmox delete failed", destroy(201), curated);
      log.error("proxmox delete failed", destroy(202), curated);

      const [first, second] = (reportOpsEvent as jest.Mock).mock.calls.map(([input]) => input);
      expect(first.message).toBe(second.message);
      expect(buildOpsEventFingerprint(first)).toBe(buildOpsEventFingerprint(second));
    });

    it("stores the log title, not the thrown value, when the error is not an Error", async () => {
      log.error("provider call failed", "raw provider body ZZZ123", { source: "probe" });

      const payload = (reportOpsEvent as jest.Mock).mock.calls[0][0];
      expect(payload.message).toBe("provider call failed");
      expect(JSON.stringify(payload)).not.toContain("ZZZ123");
    });
  });
});
