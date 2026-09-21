import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { issueProviderWorkspaceSession, revokeProviderWorkspaceSession } from "@/lib/hivra/provider-workspace-session-issuer";
import { POST, DELETE } from "../route";
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: jest.fn() }));
jest.mock("@/lib/hivra/provider-workspace-session-issuer", () => ({
  ...jest.requireActual("@/lib/hivra/provider-workspace-session-issuer"), issueProviderWorkspaceSession: jest.fn(), revokeProviderWorkspaceSession: jest.fn(),
}));
const issue = jest.mocked(issueProviderWorkspaceSession), revoke = jest.mocked(revokeProviderWorkspaceSession);
const origin = "https://canary.hermesos.cloud", id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = { computerId: id, surface: "files", pkceChallenge: "c".repeat(43) };
const request = (method = "POST", headers = {}, body: unknown = method === "POST" ? input : { sessionId: id }, query = "") =>
  new NextRequest(`${origin}/api/workspace/sessions${query}`, { method, headers: { origin, "sec-fetch-site": "same-origin",
    "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const envKey = "NEXT_PUBLIC_APP_URL", oldOrigin = process.env[envKey];
beforeEach(() => {
  jest.clearAllMocks(); process.env[envKey] = origin;
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "owner" });
  (enforceRateLimit as jest.Mock).mockReturnValue({ success: true });
  issue.mockResolvedValue({ ok: false, code: "workspace_unavailable", error: "Unavailable" });
  revoke.mockResolvedValue({ ok: true });
});
afterAll(() => { if (oldOrigin === undefined) delete process.env[envKey]; else process.env[envKey] = oldOrigin; });
it("binds the authenticated owner, reports unavailable honestly, and scopes revocation", async () => {
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(issue).toHaveBeenCalledWith({ ...input, userId: "owner" });
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect((await DELETE(request("DELETE"))).status).toBe(200);
  expect(revoke).toHaveBeenCalledWith({ sessionId: id, userId: "owner" });
});
it.each(["auth", "foreign-origin", "no-origin", "fetch-site", "query", "rate", "encoding", "content-type", "oversize", "extra-owner"])("rejects %s before issuance/revoke", async fault => {
  const headers: Record<string, string> = {};
  let status = 403;
  if (fault === "auth") { (auth as unknown as jest.Mock).mockResolvedValue({ userId: null }); status = 401; }
  if (fault === "foreign-origin") headers.origin = "https://foreign.example.test";
  if (fault === "no-origin") headers.origin = "";
  if (fault === "fetch-site") headers["sec-fetch-site"] = "same-site";
  if (fault === "rate") { (enforceRateLimit as jest.Mock).mockReturnValue({ success: false }); status = 429; }
  if (fault === "encoding") { headers["content-encoding"] = "gzip"; status = 415; }
  if (fault === "content-type") { headers["content-type"] = "text/plain"; status = 415; }
  if (fault === "oversize") { headers["content-length"] = "1025"; status = 413; }
  if (fault === "extra-owner") status = 400;
  for (const method of ["POST", "DELETE"]) {
    const body = { ...(method === "POST" ? input : { sessionId: id }), ...(fault === "extra-owner" ? { userId: "foreign" } : {}) };
    const response = await (method === "POST" ? POST : DELETE)(request(method, headers, body, fault === "query" ? "?token=x" : ""));
    expect(response.status).toBe(status);
  }
  expect(issue).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
});
