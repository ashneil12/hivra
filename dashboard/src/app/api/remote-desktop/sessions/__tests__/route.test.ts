import { NextRequest } from "next/server";

import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { issueRemoteDesktopSession } from "@/lib/remote-computers/session-broker";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));
jest.mock("@/lib/remote-computers/session-broker", () => ({
  issueRemoteDesktopSession: jest.fn(),
}));

const body = {
  computerKind: "hermes-instance",
  computerId: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
  purpose: "daily-driver",
  inputRole: "controller",
  streamingMode: "hq",
  requestedTransport: "selkies-webrtc",
  client: { kind: "browser", moonlight: false, webCodecs: true, udp: "direct" },
  pkceChallenge: "a".repeat(43),
};
const nativeProfile = {
  clientId: "018f6d3c-1d91-7c65-9d86-37fc915b8380",
  clientCertificatePem: `-----BEGIN CERTIFICATE-----\n${"a".repeat(96)}\n-----END CERTIFICATE-----\n`,
  clientCertificateSha256: "a".repeat(64),
};

function request(value: unknown = body, headers: Record<string, string> = {}) {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/sessions", {
    method: "POST",
    headers: {
      origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(value),
  });
}

describe("POST /api/remote-desktop/sessions", () => {
  it.each([{ inputRole: "viewer" }, { purpose: "recovery" }, { computerKind: "hermes-instance" },
    { client: { kind: "native", moonlight: true, webCodecs: true, udp: "direct" } },
    { requestedTransport: "sunshine-moonlight" }])("rejects owner handoff outside its narrow scope %j", async overrides => {
    expect((await POST(request({ ...body, computerKind: "hivra-agent", requestedTransport: "selkies-websocket",
      ownerHandoff: true, ...overrides }))).status).toBe(400);
    expect(issueRemoteDesktopSession).not.toHaveBeenCalled();
  });
  it("passes explicit owner handoff with the authenticated owner only", async () => {
    expect((await POST(request({ ...body, computerKind: "hivra-agent", requestedTransport: "selkies-websocket", ownerHandoff: true }))).status).toBe(201);
    expect(issueRemoteDesktopSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", ownerHandoff: true }));
  });
  describe("unanswered earlier requests", () => {
    const browserController = { ...body, computerKind: "hivra-agent", requestedTransport: "selkies-websocket" };
    const lost = "L".repeat(43);
    it("passes a browser controller's own unanswered requests to the broker", async () => {
      expect((await POST(request({ ...browserController, unansweredPkceChallenges: [lost] }))).status).toBe(201);
      expect(issueRemoteDesktopSession).toHaveBeenCalledWith(expect.objectContaining({
        userId: "user-1", unansweredPkceChallenges: [lost],
      }));
    });
    it.each([
      ["a Hermes instance", { computerKind: "hermes-instance" }],
      ["a viewer", { inputRole: "viewer" }],
      ["a native client", { client: { kind: "native", moonlight: true, webCodecs: true, udp: "direct" } }],
      ["another transport", { requestedTransport: "selkies-webrtc" }],
      ["an empty list", { unansweredPkceChallenges: [] }],
      ["this request's own challenge", { unansweredPkceChallenges: [body.pkceChallenge] }],
      ["a repeated challenge", { unansweredPkceChallenges: [lost, lost] }],
      ["a malformed challenge", { unansweredPkceChallenges: ["short"] }],
      ["more than eight", { unansweredPkceChallenges: Array.from({ length: 9 }, (_, index) => String(index).repeat(43)) }],
    ])("rejects unanswered requests named by %s", async (_label, overrides) => {
      expect((await POST(request({ ...browserController, unansweredPkceChallenges: [lost], ...overrides }))).status).toBe(400);
      expect(issueRemoteDesktopSession).not.toHaveBeenCalled();
    });
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-1" });
    (issueRemoteDesktopSession as jest.Mock).mockResolvedValue({
      ok: true,
      session: {
        id: "session-1",
        exchangeCode: "e".repeat(43),
        handoff: "message",
        transport: "selkies-webrtc",
        inputRole: "controller",
        brokerOrigin: "https://desktop.example.com",
        audience: "audience",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  });

  it("issues a message-body handoff for the authenticated owner", async () => {
    const response = await POST(request());
    const payload = await response.json();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(payload.data.exchangeCode).toBe("e".repeat(43));
    expect(payload.data.handoff).toBe("message");
    expect(issueRemoteDesktopSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      computerId: body.computerId,
      requestedTransport: "selkies-webrtc",
      streamingMode: "hq",
    }));
  });

  it("defaults an already-open pre-selector client to HQ during rollout", async () => {
    const legacyBody = { ...body } as Partial<typeof body>;
    delete legacyBody.streamingMode;
    const response = await POST(request(legacyBody));

    expect(response.status).toBe(201);
    expect(issueRemoteDesktopSession).toHaveBeenCalledWith(expect.objectContaining({
      streamingMode: "hq",
    }));
  });

  it.each(["qhd", "uhd"] as const)("admits the explicit %s profile", async (streamingMode) => {
    expect((await POST(request({ ...body, streamingMode }))).status).toBe(201);
    expect(issueRemoteDesktopSession).toHaveBeenCalledWith(expect.objectContaining({ streamingMode }));
  });

  it("rejects unauthenticated, cross-origin, and malformed mutations", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request(body, { origin: "https://attacker.example" }))).status).toBe(403);
    expect((await POST(request({ ...body, pkceChallenge: "short" }))).status).toBe(400);
    expect((await POST(request({ ...body, streamingMode: "ultra" }))).status).toBe(400);
    expect(issueRemoteDesktopSession).not.toHaveBeenCalled();
  });

  it("preserves a serialized controller conflict as a 409", async () => {
    (issueRemoteDesktopSession as jest.Mock).mockResolvedValue({
      ok: false,
      status: 409,
      code: "controller_conflict",
      error: "Another controller owns the lease.",
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: "controller_conflict" });
  });

  it("accepts a prepared profile UUID only for a native Sunshine controller", async () => {
    const sessionId = "018f6d3c-1d91-7c65-9d86-37fc915b8379";
    const native = {
      ...body,
      sessionId,
      requestedTransport: "sunshine-moonlight",
      client: { kind: "native", moonlight: true, webCodecs: false, udp: "direct" },
      nativeProfile,
    };
    expect((await POST(request(native))).status).toBe(201);
    expect(issueRemoteDesktopSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));

    expect((await POST(request({ ...body, sessionId }))).status).toBe(400);
    expect((await POST(request({ ...native, inputRole: "viewer" }))).status).toBe(400);
    expect((await POST(request({ ...native, nativeProfile: undefined }))).status).toBe(400);
    expect((await POST(request({ ...body, nativeProfile }))).status).toBe(400);
  });

  it("keeps the unverified Guacamole/RDP catalog candidate unavailable", async () => {
    const response = await POST(request({ ...body, requestedTransport: "guacamole-rdp" }));

    expect(response.status).toBe(400);
    expect(issueRemoteDesktopSession).not.toHaveBeenCalled();
  });
});
