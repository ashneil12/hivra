import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockForget = jest.fn();
const mockList = jest.fn();
const mockDownload = jest.fn();
const mockGetSession = jest.fn();
const mockLoadExpiries = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: () => null }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/infrastructure/credential-expiry-store", () => ({
  loadCredentialExpiries: (...args: unknown[]) => mockLoadExpiries(...args),
}));
jest.mock("@/lib/hivra/do-managed-sessions", () => {
  class ManagedSessionError extends Error {
    constructor(public readonly code: string, message: string, public readonly agentId?: string) { super(message); }
  }
  return {
    ManagedSessionError,
    forgetManagedSession: (...args: unknown[]) => mockForget(...args),
    listManagedSessionWorkspace: (...args: unknown[]) => mockList(...args),
    downloadManagedSessionWorkspace: (...args: unknown[]) => mockDownload(...args),
    getManagedSession: (...args: unknown[]) => mockGetSession(...args),
  };
});

import { POST as forget } from "../[id]/forget/route";
import { GET as workspace } from "../[id]/workspace/route";
import { GET as download } from "../[id]/workspace/download/route";
import { GET as session } from "../[id]/route";
import { ManagedSessionError } from "@/lib/hivra/do-managed-sessions";

const AGENT = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://localhost";
const params = { params: Promise.resolve({ id: AGENT }) };

function mutation(url: string, body: unknown) {
  return new NextRequest(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", host: "localhost" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockAuth.mockResolvedValue({ userId: "user_1" });
  process.env.NEXT_PUBLIC_HIVRA_AGENTS = "1";
  for (const mock of [mockForget, mockList, mockDownload, mockGetSession, mockLoadExpiries]) mock.mockReset();
});
afterEach(() => { delete process.env.NEXT_PUBLIC_HIVRA_AGENTS; });

describe("POST /api/hivra/managed-sessions/[id]/forget", () => {
  it("requires the owner to acknowledge that the session may remain at DigitalOcean", async () => {
    const response = await forget(mutation(`/api/hivra/managed-sessions/${AGENT}/forget`, {}), params);
    expect(response.status).toBe(400);
    expect(mockForget).not.toHaveBeenCalled();
  });

  it("forgets for the signed-in owner and maps a reachable session to 409", async () => {
    mockForget.mockResolvedValueOnce({ agentId: AGENT, status: "deleted" });
    const ok = await forget(mutation(`/api/hivra/managed-sessions/${AGENT}/forget`, { acknowledge: "session-may-remain-at-digitalocean" }), params);
    expect(ok.status).toBe(200);
    expect(mockForget).toHaveBeenCalledWith("user_1", AGENT);
    mockForget.mockRejectedValueOnce(new ManagedSessionError("conflict", "Delete it instead."));
    const refused = await forget(mutation(`/api/hivra/managed-sessions/${AGENT}/forget`, { acknowledge: "session-may-remain-at-digitalocean" }), params);
    expect(refused.status).toBe(409);
  });

  it("stays unavailable off the Hivra hosts", async () => {
    delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
    const response = await forget(mutation(`/api/hivra/managed-sessions/${AGENT}/forget`, { acknowledge: "session-may-remain-at-digitalocean" }), params);
    expect(response.status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
  });
});

describe("GET /api/hivra/managed-sessions/[id]/workspace", () => {
  it("lists the requested folder for the owner and reports a paused session as 409", async () => {
    mockList.mockResolvedValueOnce({ path: "src", entries: [], truncated: false });
    const ok = await workspace(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}/workspace?path=src`), params);
    expect(ok.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("user_1", AGENT, "src");
    mockList.mockRejectedValueOnce(new ManagedSessionError("session_paused", "Resume it."));
    const paused = await workspace(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}/workspace`), params);
    expect(paused.status).toBe(409);
    await expect(paused.json()).resolves.toMatchObject({ code: "session_paused" });
  });

  it("requires sign-in", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    const response = await workspace(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}/workspace`), params);
    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("GET /api/hivra/managed-sessions/[id]/workspace/download", () => {
  it("always serves an attachment that cannot render on Hivra's origin", async () => {
    mockDownload.mockResolvedValueOnce({
      body: new Response("<script>alert(1)</script>").body,
      fileName: "évil \"page\".html", isArchive: false, sizeBytes: 25,
    });
    const response = await download(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}/workspace/download?path=%C3%A9vil.html`), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="_vil _page_.html"; filename*=UTF-8''${encodeURIComponent("évil \"page\".html")}`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(mockDownload).toHaveBeenCalledWith("user_1", AGENT, "évil.html", expect.objectContaining({ archive: false }));
  });

  it("asks for an archive only with archive=1 and maps refusals to JSON errors", async () => {
    mockDownload.mockRejectedValueOnce(new ManagedSessionError("invalid_request", "Too large."));
    const response = await download(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}/workspace/download?path=&archive=1`), params);
    expect(response.status).toBe(400);
    expect(mockDownload).toHaveBeenCalledWith("user_1", AGENT, "", expect.objectContaining({ archive: true }));
  });
});

describe("GET /api/hivra/managed-sessions/[id]", () => {
  it("includes the owner-declared expiry of the agent's connection", async () => {
    mockGetSession.mockResolvedValueOnce({ agentId: AGENT, connectionId: CONNECTION, status: "ready" });
    const expiry = { source: "owner-declared", noExpiry: false, expiresOn: "2026-10-01", declaredAt: "2026-09-24T00:00:00.000Z" };
    mockLoadExpiries.mockResolvedValueOnce(new Map([[CONNECTION, expiry]]));
    const response = await session(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}`), params);
    await expect(response.json()).resolves.toMatchObject({ data: { credentialExpiry: expiry } });
    expect(mockLoadExpiries).toHaveBeenCalledWith("user_1", [CONNECTION]);
  });
});
