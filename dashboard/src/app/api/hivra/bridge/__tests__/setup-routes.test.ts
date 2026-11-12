/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/local-bridge/flag", () => ({ isLocalBridgeEnabled: jest.fn() }));
jest.mock("@/lib/local-bridge/service", () => ({ redeemEnrolCode: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/infrastructure/server-enrollment-http", () => {
  const actual = jest.requireActual("@/lib/infrastructure/server-enrollment-http");
  return { ...actual, enrollIpLimit: jest.fn(() => null) };
});

import { NextRequest } from "next/server";

import { enrollIpLimit } from "@/lib/infrastructure/server-enrollment-http";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { redeemEnrolCode } from "@/lib/local-bridge/service";
import { GET as install, HEAD } from "../install/route";
import { POST as enrol } from "../enrol/route";

const CODE = `hvb_${"a".repeat(32)}`;
const enrolRequest = (body: unknown, headers: Record<string, string> = {}, search = "") =>
  new NextRequest(`https://canary.example.test/api/hivra/bridge/enrol${search}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
const installRequest = () => new NextRequest("https://canary.example.test/api/hivra/bridge/install");

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://canary.example.test";
  jest.mocked(isLocalBridgeEnabled).mockReturnValue(true);
  jest.mocked(enrollIpLimit).mockReturnValue(null);
});

describe("GET /api/hivra/bridge/install", () => {
  it("is 404 with the flag off", async () => {
    jest.mocked(isLocalBridgeEnabled).mockReturnValue(false);
    expect((await install(installRequest())).status).toBe(404);
  });

  it("serves the script as plain text with the flag on, to anyone, with no secret", async () => {
    const response = await install(installRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(text).toContain("origin='https://canary.example.test'");
  });

  it("is rate limited and refuses HEAD", async () => {
    jest.mocked(enrollIpLimit).mockReturnValue(new Response("", { status: 429 }));
    expect((await install(installRequest())).status).toBe(429);
    expect(HEAD().status).toBe(405);
  });
});

describe("POST /api/hivra/bridge/enrol", () => {
  it("is 404 with the flag off, and never redeems", async () => {
    jest.mocked(isLocalBridgeEnabled).mockReturnValue(false);
    expect((await enrol(enrolRequest({ token: CODE }))).status).toBe(404);
    expect(redeemEnrolCode).not.toHaveBeenCalled();
  });

  it("returns the settings for a good code, uncached", async () => {
    jest.mocked(redeemEnrolCode).mockResolvedValue({ ok: true, value: { bridgeKey: "k" } as never });
    const response = await enrol(enrolRequest({ token: CODE }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ bridgeKey: "k" });
    expect(redeemEnrolCode).toHaveBeenCalledWith(CODE);
  });

  it("refuses a used or expired code with a plain 400 that says nothing more", async () => {
    jest.mocked(redeemEnrolCode).mockResolvedValue({ ok: false, status: 400, message: "That code has expired or was already used." });
    const response = await enrol(enrolRequest({ token: CODE }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "not_usable" });
  });

  it("refuses browsers, query strings, extra fields and rate-limited callers", async () => {
    expect((await enrol(enrolRequest({ token: CODE }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await enrol(enrolRequest({ token: CODE }, {}, "?x=1"))).status).toBe(403);
    expect((await enrol(enrolRequest({ token: CODE, extra: 1 }))).status).toBe(400);
    jest.mocked(enrollIpLimit).mockReturnValue(new Response("", { status: 429 }));
    expect((await enrol(enrolRequest({ token: CODE }))).status).toBe(429);
    expect(redeemEnrolCode).not.toHaveBeenCalled();
  });

  it("answers 503 when redeeming throws", async () => {
    jest.mocked(redeemEnrolCode).mockRejectedValue(new Error("db"));
    expect((await enrol(enrolRequest({ token: CODE }))).status).toBe(503);
  });
});
