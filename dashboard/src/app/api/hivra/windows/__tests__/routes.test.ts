/** @jest-environment node */

import { NextRequest } from "next/server";

const authMock = jest.fn();
const launchMock = jest.fn();
const listMock = jest.fn();
const startDownloadMock = jest.fn();
const downloadStatusMock = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));
jest.mock("@/lib/infrastructure/windows-byo-iso", () => ({
  launchWindowsByoIso: (...args: unknown[]) => launchMock(...args),
  listWindowsIsoImages: (...args: unknown[]) => listMock(...args),
  startWindowsIsoDownload: (...args: unknown[]) => startDownloadMock(...args),
  getWindowsIsoDownloadStatus: (...args: unknown[]) => downloadStatusMock(...args),
  WindowsByoIsoError: class WindowsByoIsoError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
}));

import { POST } from "../launch/route";
import { GET } from "../iso-images/route";
import { GET as GET_DOWNLOAD, POST as POST_DOWNLOAD } from "../iso-downloads/route";

describe("Windows BYO ISO routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue({ userId: "user_123" });
  });

  it("stamps the authenticated actor and accepts only bounded same-origin JSON", async () => {
    launchMock.mockResolvedValue({ id: "agent_123", name: "WINDOWS_SETUP", status: "provisioning" });
    const body = { launchRequestId: "33333333-3333-4333-8333-333333333333" };
    const response = await POST(new NextRequest("https://canary.example.test/api/hivra/windows/launch", {
      method: "POST",
      headers: { origin: "https://canary.example.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(202);
    expect(launchMock).toHaveBeenCalledWith("user_123", "user_123", body);

    const crossOrigin = await POST(new NextRequest("https://canary.example.test/api/hivra/windows/launch", {
      method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: "{}",
    }));
    expect(crossOrigin.status).toBe(403);
  });

  it("passes one exact target selection to the read-only inventory service", async () => {
    listMock.mockResolvedValue({ targetId: "target", connectionRevision: 7, images: [], storages: [{ id: "local", label: "local" }] });
    const url = "https://canary.example.test/api/hivra/windows/iso-images?connectionId=11111111-1111-4111-8111-111111111111&targetId=22222222-2222-4222-8222-222222222222&expectedConnectionRevision=7";
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(listMock).toHaveBeenCalledWith("user_123", {
      connectionId: "11111111-1111-4111-8111-111111111111",
      targetId: "22222222-2222-4222-8222-222222222222",
      expectedConnectionRevision: 7,
    });

    const duplicate = await GET(new NextRequest(`${url}&targetId=33333333-3333-4333-8333-333333333333`));
    expect(duplicate.status).toBe(400);
  });

  it("starts a bounded same-origin download and polls one exact task", async () => {
    const body = {
      connectionId: "11111111-1111-4111-8111-111111111111",
      targetId: "22222222-2222-4222-8222-222222222222",
      expectedConnectionRevision: 7,
      directUrl: "https://software.download.prss.microsoft.com/file.iso?t=expires",
    };
    startDownloadMock.mockResolvedValue({ taskId: "33333333-3333-4333-8333-333333333333", state: "queued" });
    const started = await POST_DOWNLOAD(new NextRequest("https://canary.example.test/api/hivra/windows/iso-downloads", {
      method: "POST",
      headers: { origin: "https://canary.example.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(started.status).toBe(202);
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(startDownloadMock).toHaveBeenCalledWith("user_123", body);

    downloadStatusMock.mockResolvedValue({ taskId: "33333333-3333-4333-8333-333333333333", state: "running", bytesDownloaded: 123 });
    const query = "connectionId=11111111-1111-4111-8111-111111111111&targetId=22222222-2222-4222-8222-222222222222&expectedConnectionRevision=7&taskId=33333333-3333-4333-8333-333333333333";
    const status = await GET_DOWNLOAD(new NextRequest(`https://canary.example.test/api/hivra/windows/iso-downloads?${query}`));
    expect(status.status).toBe(200);
    expect(downloadStatusMock).toHaveBeenCalledWith("user_123", {
      connectionId: body.connectionId,
      targetId: body.targetId,
      expectedConnectionRevision: 7,
      taskId: "33333333-3333-4333-8333-333333333333",
    });

    const duplicate = await GET_DOWNLOAD(new NextRequest(`https://canary.example.test/api/hivra/windows/iso-downloads?${query}&taskId=44444444-4444-4444-8444-444444444444`));
    expect(duplicate.status).toBe(400);
  });
});
