/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockIssue = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockConfirm = jest.fn();
const mockReplace = jest.fn();
const mockDecline = jest.fn();
const mockCancel = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@clerk/nextjs/server", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
jest.mock("@/lib/infrastructure/server-enrollment-readiness", () => ({ isServerEnrollmentReportReachable: jest.fn() }));
jest.mock("@/lib/infrastructure/server-enrollment-store", () => ({
  ServerEnrollmentStoreError: class ServerEnrollmentStoreError extends Error {},
}));
jest.mock("@/lib/infrastructure/connection-store", () => ({
  InfrastructureConnectionStoreError: class InfrastructureConnectionStoreError extends Error {
    constructor(readonly code: string) { super(code); }
  },
}));
jest.mock("@/lib/infrastructure/server-enrollment-service", () => {
  class ServerEnrollmentError extends Error {
    constructor(readonly code: string, readonly failure: string | null = null) { super(code); this.name = "ServerEnrollmentError"; }
  }
  return {
    ServerEnrollmentError,
    issueServerEnrollment: (...args: unknown[]) => mockIssue(...args),
    listServerEnrollments: (...args: unknown[]) => mockList(...args),
    getServerEnrollment: (...args: unknown[]) => mockGet(...args),
    confirmServerEnrollment: (...args: unknown[]) => mockConfirm(...args),
    replaceServerEnrollmentAccess: (...args: unknown[]) => mockReplace(...args),
    declineServerEnrollment: (...args: unknown[]) => mockDecline(...args),
    cancelServerEnrollment: (...args: unknown[]) => mockCancel(...args),
  };
});

import { ServerEnrollmentError } from "@/lib/infrastructure/server-enrollment-service";
import { GET as LIST, POST as ISSUE } from "../route";
import { GET as STATUS } from "../[id]/route";
import { POST as CONFIRM } from "../[id]/confirm/route";
import { POST as REPLACE } from "../[id]/replace/route";
import { POST as DECLINE } from "../[id]/decline/route";
import { POST as CANCEL } from "../[id]/cancel/route";

const BASE = "https://hivra.example/api/infrastructure/server-enrollments";
const ID = "44444444-4444-4444-8444-444444444444";
const CONNECTION_ID = "55555555-5555-4555-8555-555555555555";
const context = (id = ID) => ({ params: Promise.resolve({ id }) });

const mutation = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => new NextRequest(BASE + path, {
  method: "POST",
  headers: { origin: "https://hivra.example", "sec-fetch-site": "same-origin", "content-type": "application/json", host: "hivra.example", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const read = (path = "") => new NextRequest(BASE + path);

const MUTATIONS = [
  { name: "issue", call: (r: NextRequest) => ISSUE(r), path: "", body: {}, service: mockIssue },
  { name: "confirm", call: (r: NextRequest) => CONFIRM(r, context()), path: `/${ID}/confirm`, body: {}, service: mockConfirm },
  { name: "replace", call: (r: NextRequest) => REPLACE(r, context()), path: `/${ID}/replace`,
    body: { connectionId: CONNECTION_ID, connectionRevision: 3 }, service: mockReplace },
  { name: "decline", call: (r: NextRequest) => DECLINE(r, context()), path: `/${ID}/decline`, body: {}, service: mockDecline },
  { name: "cancel", call: (r: NextRequest) => CANCEL(r, context()), path: `/${ID}/cancel`, body: {}, service: mockCancel },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_owner" });
  mockRateLimit.mockReturnValue(null);
  mockIssue.mockResolvedValue({ command: "curl …" });
  mockList.mockResolvedValue({ enrollments: [], uninstallCommand: null });
  mockGet.mockResolvedValue({ id: ID });
  mockConfirm.mockResolvedValue({ id: CONNECTION_ID });
  mockReplace.mockResolvedValue({ id: CONNECTION_ID });
  mockDecline.mockResolvedValue(undefined);
  mockCancel.mockResolvedValue(undefined);
});

describe("owner enrollment routes (T19)", () => {
  it.each(MUTATIONS)("$name requires a session", async ({ call, path, body, service }) => {
    mockAuth.mockResolvedValue({ userId: null });
    const response = await call(mutation(path, body));
    expect(response.status).toBe(401);
    expect(service).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS)("$name refuses a missing or foreign Origin, and a query string (CSRF)", async ({ call, path, body, service }) => {
    const noOrigin = mutation(path, body);
    noOrigin.headers.delete("origin");
    for (const request of [
      noOrigin,
      mutation(path, body, { origin: "https://evil.example" }),
      mutation(path, body, { "sec-fetch-site": "cross-site" }),
      new NextRequest(BASE + path + "?x=1", { method: "POST", headers: mutation(path, body).headers, body: JSON.stringify(body) }),
    ]) {
      const response = await call(request);
      expect(response.status).toBe(403);
    }
    expect(service).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS)("$name accepts only strict JSON", async ({ call, path, body, service }) => {
    expect((await call(mutation(path, body, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await call(mutation(path, "{"))).status).toBe(400);
    expect((await call(mutation(path, { padding: "x".repeat(2_000) }))).status).toBe(413);
    expect(service).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS.filter(m => m.name !== "issue"))("$name answers 404 for a malformed id", async ({ path, body, service, name }) => {
    const handler = { confirm: CONFIRM, replace: REPLACE, decline: DECLINE, cancel: CANCEL }[name as "confirm"]!;
    const response = await handler(mutation(path, body), context("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(service).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS.filter(m => m.name !== "issue"))("$name answers 404 for another user's enrollment", async ({ call, path, body, service }) => {
    service.mockRejectedValue(new ServerEnrollmentError("not_found"));
    const response = await call(mutation(path, body));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.mock.calls[0][0]).toBe("user_owner");
  });

  it("issues a command for the signed-in owner, no-store", async () => {
    const response = await ISSUE(mutation("", {}));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockIssue).toHaveBeenCalledWith("user_owner", {}, expect.objectContaining({ reachable: expect.any(Function) }));
  });

  it("refuses unknown issue fields", async () => {
    expect((await ISSUE(mutation("", { userId: "user_other" }))).status).toBe(400);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["active_limit", 409], ["daily_limit", 429], ["unavailable", 503],
  ] as const)("maps the issue refusal %s to %i", async (code, status) => {
    mockIssue.mockRejectedValue(new ServerEnrollmentError(code));
    const response = await ISSUE(mutation("", {}));
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).toContain(code);
  });

  it("refuses Yes for a server this account already has (known_identity, T30)", async () => {
    mockConfirm.mockRejectedValue(new ServerEnrollmentError("known_identity"));
    const response = await CONFIRM(mutation(`/${ID}/confirm`, {}), context());
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("known_identity");
  });

  it("passes an owner-entered address to confirm and refuses extra fields", async () => {
    await CONFIRM(mutation(`/${ID}/confirm`, { sshHost: "203.0.113.4" }), context());
    expect(mockConfirm).toHaveBeenCalledWith("user_owner", ID, { sshHost: "203.0.113.4" });
    mockConfirm.mockClear();
    expect((await CONFIRM(mutation(`/${ID}/confirm`, { sshHost: "x", sshUser: "root" }), context())).status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("returns the verification failure class when Replace changes nothing", async () => {
    mockReplace.mockRejectedValue(new ServerEnrollmentError("verification_failed", "host_key_mismatch"));
    const response = await REPLACE(mutation(`/${ID}/replace`, { connectionId: CONNECTION_ID, connectionRevision: 3 }), context());
    expect(response.status).toBe(422);
    const json = JSON.stringify(await response.json());
    expect(json).toContain("verification_failed");
    expect(json).toContain("host_key_mismatch");
  });

  it("never leaks an unexpected error's text", async () => {
    mockDecline.mockRejectedValue(new Error("secret hse1_" + "a".repeat(32)));
    const response = await DECLINE(mutation(`/${ID}/decline`, {}), context());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("hse1_");
  });

  it("lists and reads for the owner only, no-store, with no Origin needed", async () => {
    const list = await LIST(read());
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(mockList).toHaveBeenCalledWith("user_owner");
    const status = await STATUS(read(`/${ID}`), context());
    expect(status.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith("user_owner", ID);
    mockAuth.mockResolvedValue({ userId: null });
    expect((await LIST(read())).status).toBe(401);
    expect((await STATUS(read(`/${ID}`), context())).status).toBe(401);
  });

  it("rate-limits before the service", async () => {
    mockRateLimit.mockReturnValue(new Response(null, { status: 429 }));
    expect((await ISSUE(mutation("", {}))).status).toBe(429);
    expect(mockIssue).not.toHaveBeenCalled();
  });
});
