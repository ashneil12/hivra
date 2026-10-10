/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockPrepare = jest.fn();
const mockPreflight = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/app/api/infrastructure/connections/request-security", () => ({
  isSameOriginMutationRequest: () => true,
}));
jest.mock("@/lib/hivra/gvisor-computer-service", () => {
  class GvisorComputerError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  class GvisorPreparationError extends GvisorComputerError {
    constructor(message: string, readonly stage: string | null) { super("remote_failed", message); }
  }
  return {
    prepareGvisorHost: (...args: unknown[]) => mockPrepare(...args),
    GvisorComputerError,
    GvisorPreparationError,
  };
});
jest.mock("@/lib/infrastructure/gvisor-target", () => {
  class GvisorTargetError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return { preflightGvisorTarget: (...args: unknown[]) => mockPreflight(...args), GvisorTargetError };
});

import { GvisorPreparationError } from "@/lib/hivra/gvisor-computer-service";
import { GvisorTargetError } from "@/lib/infrastructure/gvisor-target";
import { POST } from "../route";

const TARGET_ID = "00000000-0000-4000-8000-000000002041";
let connectionSeq = 0;
function connectionId(): string {
  connectionSeq += 1;
  return `00000000-0000-4000-8000-${String(connectionSeq).padStart(12, "0")}`;
}
const request = (id: string) => new NextRequest(
  `http://localhost/api/infrastructure/connections/${id}/gvisor/prepare`,
  { method: "POST", headers: { "x-forwarded-for": "198.51.100.61" } },
);
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/infrastructure/connections/[id]/gvisor/prepare", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user_gvisor" });
    mockPrepare.mockResolvedValue({ adapterVersion: "2026.09.15.1", runId: "run", connectionRevision: 2 });
    mockPreflight.mockResolvedValue({ id: TARGET_ID, status: "ready" });
  });

  it("returns the ready target and keeps a successful run's slot for the window", async () => {
    const id = connectionId();
    const response = await POST(request(id), context(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { target: { id: TARGET_ID, status: "ready" } } });

    const again = await POST(request(id), context(id));
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(14 * 60);
    expect(await again.json()).toMatchObject({
      code: "PREPARATION_RATE_LIMITED",
      error: "Linux Sandbox was set up on this server in the last 15 minutes. You can try again in 15 minutes.",
    });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
  });

  it("reports the stage a failed setup stopped in and lets the owner retry at once", async () => {
    const id = connectionId();
    mockPrepare.mockRejectedValueOnce(new GvisorPreparationError("The downloaded gVisor bundle did not match its pinned checksum.", "bundle-checksum"));

    const failed = await POST(request(id), context(id));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      success: false,
      error: "The downloaded gVisor bundle did not match its pinned checksum.",
      code: "remote_failed",
      stage: "bundle-checksum",
    });

    const retried = await POST(request(id), context(id));
    expect(retried.status).toBe(200);
    expect(mockPrepare).toHaveBeenCalledTimes(2);
  });

  // Review of slice 5: a failure gives its slot back, which left failed runs
  // with no limit at all; each one opens an SSH connection to the server.
  it("makes the host wait after 5 failed setups in 15 minutes", async () => {
    const id = connectionId();
    mockPrepare.mockRejectedValue(new GvisorPreparationError("The pinned gVisor bundle could not be downloaded.", "bundle-download"));
    for (let run = 0; run < 5; run += 1) {
      expect((await POST(request(id), context(id))).status).toBe(502);
    }
    const limited = await POST(request(id), context(id));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(14 * 60);
    expect(await limited.json()).toMatchObject({
      code: "PREPARATION_FAILURES_LIMITED",
      error: "Linux Sandbox setup failed on this server 5 times in the last 15 minutes. You can try again in 15 minutes.",
    });
    expect(mockPrepare).toHaveBeenCalledTimes(5);
  });

  it("attributes a failed final check to the readiness step", async () => {
    const id = connectionId();
    mockPreflight.mockRejectedValueOnce(new GvisorTargetError("remote_failed", "The gVisor adapter did not pass its strict readiness check."));

    const failed = await POST(request(id), context(id));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "remote_failed", stage: "readiness-check" });
    expect((await POST(request(id), context(id))).status).toBe(200);
  });
});
