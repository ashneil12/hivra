jest.mock("server-only", () => ({}));
const mockAuth = jest.fn();
const mockAllowed = jest.fn();
const mockExport = jest.fn();
const mockRestore = jest.fn();
const mockLog = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: (...args: unknown[]) => mockAllowed(...args) }));
jest.mock("@/lib/hivra/folder-recovery-service", () => ({ exportComputerFolder: (...args: unknown[]) => mockExport(...args), restoreComputerFolder: (...args: unknown[]) => mockRestore(...args) }));
jest.mock("@/lib/logger", () => ({ log: {
  error: (...args: unknown[]) => mockLog(...args), warn: (...args: unknown[]) => mockLog(...args), info: (...args: unknown[]) => mockLog(...args),
} }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: () => null }));

import { NextRequest } from "next/server";
import { POST } from "../route";
const passphrase = "private recovery passphrase";
function request(body: unknown, headers: Record<string,string> = {}) {
  return new NextRequest("https://canary.hivra.io/api/hivra/folder-recovery", {
    method: "POST", body: JSON.stringify(body), headers: {
      "content-type": "application/json", origin: "https://canary.hivra.io", "sec-fetch-site": "same-origin", ...headers,
    },
  });
}
beforeEach(() => {
  mockAuth.mockResolvedValue({ userId: "owner" }); mockAllowed.mockReturnValue(true);
  mockExport.mockReset().mockResolvedValue(Buffer.from("encrypted artifact"));
  mockRestore.mockReset().mockResolvedValue({ files: 1, bytes: 5 }); mockLog.mockReset();
});

describe("folder recovery API boundaries", () => {
  it("exports only for the signed-in owner, with no-store binary download headers", async () => {
    const response = await POST(request({ action: "export", sourceId: "owned-source", passphrase }));
    expect(response.status).toBe(200);
    expect(mockExport).toHaveBeenCalledWith("owner", "owned-source", passphrase);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain(".hivra-folder");
  });
  it("rejects anonymous, cross-origin and wrong-content-type requests before service calls", async () => {
    const body = { action: "export", sourceId: "source", passphrase };
    mockAuth.mockResolvedValue({ userId: null });
    expect((await POST(request(body))).status).toBe(401);
    mockAuth.mockResolvedValue({ userId: "owner" });
    expect((await POST(request(body, { origin: "https://foreign.example" }))).status).toBe(403);
    expect((await POST(request(body, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await POST(request(body, { "content-type": "text/plain" }))).status).toBe(415);
    expect(mockExport).not.toHaveBeenCalled(); expect(mockRestore).not.toHaveBeenCalled();
  });
  it("bounds upload length and rejects noncanonical archive bytes", async () => {
    const body = { action: "restore", sourceId: "source", destinationId: "dest", passphrase, artifact: "YWJj!" };
    expect((await POST(request(body))).status).toBe(400);
    expect((await POST(request(body, { "content-length": "99999999" }))).status).toBe(413);
    expect(mockRestore).not.toHaveBeenCalled();
  });
  it("does not coerce a consent string to true", async () => {
    await POST(request({ action: "restore", sourceId: "source", destinationId: "dest", passphrase,
      artifact: Buffer.from("encrypted").toString("base64"), revokeSourceSessions: "true" }));
    expect(mockRestore).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", revokeSourceSessions: false }));
  });
  it("does not expose or log exception text that may contain secret/file data", async () => {
    mockExport.mockRejectedValue(new Error(`dangerous ${passphrase} /private-user-file`));
    const response = await POST(request({ action: "export", sourceId: "source", passphrase }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(passphrase);
    expect(JSON.stringify(mockLog.mock.calls)).not.toContain(passphrase);
    expect(JSON.stringify(mockLog.mock.calls)).not.toContain("private-user-file");
  });
});
