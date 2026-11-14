/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const mockLoadHost = jest.fn();
const mockClaim = jest.fn();
jest.mock("@/lib/hivra/ingress/host-credential-store", () => ({
  loadHostCredentialRow: (...a: unknown[]) => mockLoadHost(...a),
  claimHostRequestNonce: (...a: unknown[]) => mockClaim(...a),
}));
const mockReport = jest.fn();
const mockRequest = jest.fn();
jest.mock("@/lib/hivra/ingress/host-calls", () => ({
  handleWakeReport: (...a: unknown[]) => mockReport(...a),
  handleWakeRequest: (...a: unknown[]) => mockRequest(...a),
}));
const mockAfter = jest.fn();
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: (fn: () => unknown) => mockAfter(fn) }));

import { POST as report } from "../wake-report/route";
import { POST as request } from "../wake-request/route";
import { deriveHostCredential, signHostRequest, WAKE_REPORT_PATH, WAKE_REQUEST_PATH } from "@/lib/hivra/ingress/host-credential";

const MASTER = "m".repeat(40);
const HOST = "fixturehost";
const SAVED = { ...process.env };

function signed(path: string, body: string, overrides: Record<string, string> = {}): NextRequest {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${Math.random().toString(36).slice(2).padEnd(16, "x")}`;
  const material = deriveHostCredential({ secret: MASTER, hostId: HOST, generation: 1 });
  const headers = {
    "content-type": "application/json",
    "x-hivra-host": HOST,
    "x-hivra-generation": "1",
    "x-hivra-timestamp": String(timestamp),
    "x-hivra-nonce": nonce,
    "x-hivra-signature": signHostRequest(material, { path, hostId: HOST, generation: 1, timestamp, nonce, body }),
    ...overrides,
  };
  return new NextRequest(`https://app.example.test${path}`, { method: "POST", headers, body });
}

beforeEach(() => {
  process.env = { ...SAVED, HIVRA_INGRESS_HOST_CREDENTIAL: "true", HIVRA_INGRESS_SECRET: MASTER };
  mockLoadHost.mockReset().mockResolvedValue({ id: HOST, ingress_credential_generation: 1 });
  mockClaim.mockReset().mockResolvedValue("ok");
  mockReport.mockReset().mockResolvedValue({ status: 200, body: { ok: true, vmid: 1234, action: "reconciled" } });
  mockRequest.mockReset().mockResolvedValue({ status: 200, body: { ok: true, vmid: 1234, state: "waking" } });
  mockAfter.mockReset();
});

afterAll(() => {
  process.env = SAVED;
});

describe("POST /api/hivra/ingress/wake-report", () => {
  it("hands a verified report to the handler with the signing host", async () => {
    const body = JSON.stringify({ vmid: 1234, woke: "nap", at: 1, from: "ticket" });
    const res = await report(signed(WAKE_REPORT_PATH, body));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, vmid: 1234, action: "reconciled" });
    expect(mockReport).toHaveBeenCalledWith(HOST, { vmid: 1234, woke: "nap", at: 1, from: "ticket" });
  });

  it("answers 404 with the flag off, and reads nothing", async () => {
    process.env.HIVRA_INGRESS_HOST_CREDENTIAL = "false";
    const res = await report(signed(WAKE_REPORT_PATH, "{}"));
    expect(res.status).toBe(404);
    expect(mockLoadHost).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("refuses a request signed for the other route, or with a forged signature", async () => {
    const body = JSON.stringify({ vmid: 1234, woke: "nap" });
    expect((await report(signed(WAKE_REQUEST_PATH, body))).status).toBe(401);
    expect((await report(signed(WAKE_REPORT_PATH, body, { "x-hivra-signature": "a".repeat(64) }))).status).toBe(401);
    expect(mockReport).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("refuses a replay with 409 and a body over 4 KB with 413", async () => {
    mockClaim.mockResolvedValueOnce("replayed");
    expect((await report(signed(WAKE_REPORT_PATH, "{}"))).status).toBe(409);
    expect((await report(signed(WAKE_REPORT_PATH, JSON.stringify({ pad: "x".repeat(5000) })))).status).toBe(413);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("answers 503 with Retry-After when the handler throws", async () => {
    mockReport.mockRejectedValueOnce(new Error("boom"));
    const res = await report(signed(WAKE_REPORT_PATH, "{}"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("POST /api/hivra/ingress/wake-request", () => {
  it("starts the wake and hands its remainder to after()", async () => {
    mockRequest.mockImplementationOnce(async (_host: string, _body: unknown, options: { onBackground: (w: Promise<unknown>) => void }) => {
      options.onBackground(Promise.resolve("done"));
      return { status: 200, body: { ok: true, vmid: 1234, state: "waking" } };
    });
    const res = await request(signed(WAKE_REQUEST_PATH, JSON.stringify({ vmid: 1234, reason: "ticket" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, vmid: 1234, state: "waking" });
    expect(mockRequest).toHaveBeenCalledWith(HOST, { vmid: 1234, reason: "ticket" }, expect.anything());
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsigned request", async () => {
    const res = await request(new NextRequest(`https://app.example.test${WAKE_REQUEST_PATH}`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
