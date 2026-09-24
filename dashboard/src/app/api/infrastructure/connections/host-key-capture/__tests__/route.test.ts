/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@clerk/nextjs/server", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));

import { handleHostKeyCapture } from "../handler";
import { POST } from "../route";

const URL = "https://hivra.example/api/infrastructure/connections/host-key-capture";
let ip = 0;
const request = (body: unknown = { sshHost: "203.0.113.50", sshPort: 22 }, headers: Record<string, string> = {}, forwarded?: string) =>
  new NextRequest(URL, {
    method: "POST",
    headers: {
      origin: "https://hivra.example", "sec-fetch-site": "same-origin", host: "hivra.example",
      "content-type": "application/json", "x-forwarded-for": forwarded ?? `198.51.100.${ip}`, ...headers,
    },
    body: JSON.stringify(body),
  });

const KEY = { publicKey: "ssh-ed25519 " + "A".repeat(68), fingerprintSha256: "SHA256:" + "b".repeat(43) };

beforeEach(() => {
  jest.clearAllMocks();
  ip += 1;
  mockAuth.mockResolvedValue({ userId: "user_capture_" + ip });
});

describe("POST /api/infrastructure/connections/host-key-capture (T44, T45)", () => {
  it("returns the presented key and pins nothing", async () => {
    const capture = jest.fn().mockResolvedValue(KEY);
    const response = await handleHostKeyCapture(request(), { capture });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toContain(KEY.fingerprintSha256);
    expect(capture).toHaveBeenCalledWith({ sshHost: "203.0.113.50", sshPort: 22 });
  });

  it("answers every failure with one body, no sooner than 10 seconds after the request", async () => {
    let clock = 1_000;
    const bodies: string[] = [];
    for (const elapsed of [0, 3_000, 9_999, 12_000]) {
      ip += 1;
      mockAuth.mockResolvedValue({ userId: "user_capture_" + ip });
      const sleep = jest.fn(async (ms: number) => { clock += ms; });
      const start = clock;
      const capture = jest.fn(async () => { clock += elapsed; return null; });
      const response = await handleHostKeyCapture(request(), { capture, now: () => clock, sleep });
      expect(response.status).toBe(422);
      bodies.push(await response.text());
      expect(clock - start).toBeGreaterThanOrEqual(10_000);
      if (elapsed >= 10_000) expect(sleep).not.toHaveBeenCalled();
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("host_key_unavailable");
  });

  it("refuses a reserved or metadata address through the real resolver, with the same failure", async () => {
    const sleep = jest.fn(async () => undefined);
    const response = await handleHostKeyCapture(request({ sshHost: "169.254.169.254", sshPort: 22 }), { sleep });
    expect(response.status).toBe(422);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("allows 5 captures a minute and answers the 6th with 429 and Retry-After", async () => {
    const capture = jest.fn().mockResolvedValue(KEY);
    mockAuth.mockResolvedValue({ userId: "user_capture_limit" });
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let index = 0; index < 6; index += 1) {
      last = await handleHostKeyCapture(request(undefined, {}, "198.51.100.250"), { capture });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(capture).toHaveBeenCalledTimes(5);
  });

  it("requires a session, a same-origin request and strict JSON before any network work", async () => {
    const capture = jest.fn();
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await handleHostKeyCapture(request(), { capture })).status).toBe(401);
    expect((await handleHostKeyCapture(request(undefined, { origin: "https://evil.example" }), { capture })).status).toBe(403);
    expect((await handleHostKeyCapture(request(undefined, { "content-type": "text/plain" }), { capture })).status).toBe(415);
    expect((await handleHostKeyCapture(request({ sshHost: "x", sshPort: 22, extra: 1 }), { capture })).status).toBe(400);
    expect((await handleHostKeyCapture(request({ sshHost: "https://x.example/", sshPort: 22 }), { capture })).status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });

  it("is what the route serves", () => {
    expect(typeof POST).toBe("function");
  });
});
