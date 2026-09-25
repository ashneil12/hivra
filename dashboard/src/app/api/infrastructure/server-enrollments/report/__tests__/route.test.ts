/** @jest-environment node */

import { NextRequest } from "next/server";

const mockReceive = jest.fn();
const mockLimit = jest.fn();
const mockInfo = jest.fn();
const mockWarn = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/infrastructure/server-enrollment-receiver", () => ({
  ...jest.requireActual("@/lib/infrastructure/server-enrollment-receiver"),
  receiveServerEnrollmentReport: (...args: unknown[]) => mockReceive(...args),
}));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockLimit(...args),
  getIP: () => "203.0.113.1",
}));
jest.mock("@/lib/logger", () => ({
  log: { info: (...args: unknown[]) => mockInfo(...args), warn: (...args: unknown[]) => mockWarn(...args) },
}));

import { POST } from "../route";
import { reportResponseBody } from "@/lib/infrastructure/server-enrollment-receiver";

const URL = "https://hivra.example/api/infrastructure/server-enrollments/report";
const CODE = "hse1_" + "t".repeat(32);
const BODY = JSON.stringify({ version: 1, kind: "enrolled" });

const request = (overrides: { headers?: Record<string, string>; body?: BodyInit; url?: string } = {}) =>
  new NextRequest(overrides.url ?? URL, {
    method: "POST",
    headers: {
      authorization: "Bearer " + CODE, "content-type": "application/json",
      "x-vercel-forwarded-for": "198.51.100.44", ...overrides.headers,
    },
    body: overrides.body ?? BODY,
  });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.VERCEL = "1";
  mockLimit.mockReturnValue({ success: true });
  mockReceive.mockResolvedValue({
    httpStatus: 200, body: reportResponseBody("accepted"), log: { failureClass: null, scriptVersion: "2026.09.24.1", addressClass: "public" },
  });
});
afterEach(() => jest.useRealTimers());
afterAll(() => { delete process.env.VERCEL; });

function expectPlain(response: Response) {
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  for (const [, value] of response.headers) expect(value).not.toContain(CODE);
}

describe("POST /api/infrastructure/server-enrollments/report", () => {
  it("hands the code, the raw body and only the platform's observed address to the receiver", async () => {
    const response = await POST(request({ headers: {
      "cf-connecting-ip": "192.0.2.1", "x-real-ip": "192.0.2.2", "x-forwarded-for": "192.0.2.3",
    } }));
    expectPlain(response);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(reportResponseBody("accepted"));
    expect(mockReceive).toHaveBeenCalledWith({
      code: CODE, rawBody: BODY, observed: { address: "198.51.100.44", family: 4 },
    });
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it("refuses query strings and browser requests before anything else", async () => {
    for (const r of [
      request({ url: URL + "?code=" + CODE }),
      request({ headers: { origin: "https://hivra.example" } }),
      request({ headers: { "sec-fetch-site": "same-origin" } }),
    ]) {
      const response = await POST(r);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(reportResponseBody("forbidden"));
    }
    expect(mockLimit).not.toHaveBeenCalled();
    expect(mockReceive).not.toHaveBeenCalled();
  });

  it.each(["", CODE, "Basic " + CODE, "Bearer hse1_short", "bearer " + CODE, "Bearer " + CODE + ", Bearer " + CODE])(
    "refuses the authorization %p with the one 401 body before any lookup", async header => {
      const response = await POST(request({ headers: { authorization: header } }));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(reportResponseBody("not_usable"));
      expect(mockReceive).not.toHaveBeenCalled();
    },
  );

  it("limits floods with Retry-After before reading the body", async () => {
    mockLimit.mockReturnValue({ success: false, retryAfterMs: 12_000 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(mockReceive).not.toHaveBeenCalled();
  });

  it("requires uncompressed strict JSON and a small body (T21)", async () => {
    for (const type of ["text/plain", "application/json; charset=utf-8", ""]) {
      expect((await POST(request({ headers: { "content-type": type } }))).status).toBe(415);
    }
    expect((await POST(request({ headers: { "content-encoding": "gzip" } }))).status).toBe(415);
    expect((await POST(request({ headers: { "content-length": "2049" } }))).status).toBe(413);
    expect((await POST(request({ body: "x".repeat(2049) }))).status).toBe(413);
    expect(mockReceive).not.toHaveBeenCalled();
  });

  it("gives a slow body 408 after five seconds", async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([123])); }, cancel });
    const r = new NextRequest(URL, {
      method: "POST", headers: request().headers, body, duplex: "half",
    } as RequestInit & { duplex: "half" } as never);
    const pending = POST(r);
    await jest.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(408);
    expect(mockReceive).not.toHaveBeenCalled();
  });

  it("passes the receiver's status through, with Retry-After on its 429", async () => {
    mockReceive.mockResolvedValue({
      httpStatus: 422, body: reportResponseBody("ipv4_required"), log: { failureClass: "ipv4_required", scriptVersion: "2026.09.24.1", addressClass: "ipv6" },
    });
    let response = await POST(request());
    expect(response.status).toBe(422);
    expect(await response.text()).toBe(reportResponseBody("ipv4_required"));
    mockReceive.mockResolvedValue({
      httpStatus: 429, body: reportResponseBody("retry"), log: { failureClass: "code_rate_limited", scriptVersion: null, addressClass: "public" },
    });
    response = await POST(request());
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("logs refusals with allowlisted fields only (T4, T25)", async () => {
    mockReceive.mockResolvedValue({
      httpStatus: 401, body: reportResponseBody("not_usable"), log: { failureClass: "unknown_code", scriptVersion: null, addressClass: "public" },
    });
    await POST(request());
    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [, fields] = mockInfo.mock.calls[0];
    expect(Object.keys(fields).sort()).toEqual(["addressClass", "failureClass", "scriptVersion", "source"]);
    expect(JSON.stringify(mockInfo.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(mockInfo.mock.calls)).not.toContain("198.51.100.44");
  });

  it("never logs or returns an unexpected error's text", async () => {
    mockReceive.mockRejectedValue(new Error("database said " + CODE));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(reportResponseBody("unavailable"));
    expect(mockWarn).toHaveBeenCalledWith("Server enrollment report temporarily unavailable", {
      source: "server-enrollment-report", failureClass: "unavailable",
    });
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(CODE);
  });
});
