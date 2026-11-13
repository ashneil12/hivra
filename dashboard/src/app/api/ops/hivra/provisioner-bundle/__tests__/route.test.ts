import { NextRequest } from "next/server";

const mockInspect = jest.fn();
const mockSync = jest.fn();

jest.mock("@/lib/hivra/managed-provisioner-bundle-sync", () => ({
  inspectManagedProvisionerBundle: (...args: unknown[]) => mockInspect(...args),
  isSafeManagedProvisionerTargetId: (value: string) =>
    /^[a-z][a-z0-9_]{0,62}$/.test(value) && !["all", "default", "global"].includes(value),
  syncManagedProvisionerBundle: (...args: unknown[]) => mockSync(...args),
}));

const mockWakeProxy = jest.fn();

jest.mock("@/lib/hivra/ingress/host-wake-proxy", () => ({
  isHostWakeProxyAction: (value: unknown) =>
    ["install-wake-proxy", "wake-proxy-status", "remove-wake-proxy"].includes(value as string),
  runHostWakeProxyAction: (...args: unknown[]) => mockWakeProxy(...args),
}));

import { POST } from "../route";

const ORIGINAL_ENV = process.env;

function request(body: unknown, token = "expected-secret") {
  return new NextRequest("http://localhost/api/ops/hivra/provisioner-bundle", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ops/hivra/provisioner-bundle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      CRON_SECRET: "expected-secret",
      VERCEL_TARGET_ENV: "production",
    };
    mockInspect.mockResolvedValue({
      ok: true,
      targetId: "fixturenode12",
      requestedVersion: "2026.08.30.1",
      changed: false,
      observedVersion: "2026.08.30.1",
    });
    mockSync.mockResolvedValue({
      ok: true,
      targetId: "fixturenode12",
      requestedVersion: "2026.08.30.1",
      changed: true,
      observedVersion: "2026.08.30.1",
    });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("fails closed without the operator secret", async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(request({ target: "fixturenode12" }));
    expect(response.status).toBe(500);
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it("rejects unauthorized callers and non-explicit targets", async () => {
    expect((await POST(request({ target: "fixturenode12" }, "wrong"))).status).toBe(401);
    expect((await POST(request({ target: "all" }))).status).toBe(400);
    expect(mockInspect).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("defaults to a read-only inspection", async () => {
    const response = await POST(request({ target: "FIXTURENODE12" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockInspect).toHaveBeenCalledWith("default", "fixturenode12");
    expect(mockSync).not.toHaveBeenCalled();
    expect(payload.data.apply).toBe(false);
  });

  it("mutates only when apply is the literal boolean true", async () => {
    expect((await POST(request({ target: "fixturenode12", apply: "true" }))).status).toBe(200);
    expect(mockInspect).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();

    expect((await POST(request({ target: "fixturenode12", apply: true }))).status).toBe(200);
    expect(mockSync).toHaveBeenCalledWith("default", "fixturenode12");
  });

  it("derives Canary from the server environment and ignores a body channel", async () => {
    process.env.VERCEL_TARGET_ENV = "canary";

    const response = await POST(request({
      target: "fixturenode12",
      apply: true,
      channel: "default",
    }));

    expect(response.status).toBe(200);
    expect(mockSync).toHaveBeenCalledWith("canary", "fixturenode12");
  });

  it("runs a wake proxy action only when one is named, and never the bundle sync with it", async () => {
    mockWakeProxy.mockResolvedValue({
      ok: true,
      action: "install-wake-proxy",
      targetId: "fixturenode12",
      channel: "default",
      result: { status: "installed", step: "health", changed: true, ms: 900 },
    });
    const response = await POST(request({ target: "fixturenode12", action: "install-wake-proxy", apply: true }));
    expect(response.status).toBe(200);
    expect(mockWakeProxy).toHaveBeenCalledWith({
      action: "install-wake-proxy",
      channel: "default",
      targetId: "fixturenode12",
      forceHealthFailure: false,
    });
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockInspect).not.toHaveBeenCalled();

    await POST(request({ target: "fixturenode12", action: "install-wake-proxy", force_health_failure: true }));
    expect(mockWakeProxy).toHaveBeenLastCalledWith(expect.objectContaining({ forceHealthFailure: true }));
  });

  it("rejects an unknown action and passes a refusal through with its status", async () => {
    expect((await POST(request({ target: "fixturenode12", action: "reboot" }))).status).toBe(400);
    expect(mockWakeProxy).not.toHaveBeenCalled();

    mockWakeProxy.mockResolvedValue({ ok: false, httpStatus: 409, error: "HIVRA_HOST_WAKE_PROXY_ENABLED is off." });
    const response = await POST(request({ target: "fixturenode12", action: "install-wake-proxy" }));
    expect(response.status).toBe(409);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("does not call the wake proxy without an action", async () => {
    await POST(request({ target: "fixturenode12", apply: true }));
    expect(mockWakeProxy).not.toHaveBeenCalled();
  });

  it("fails closed for an unknown server deployment channel", async () => {
    process.env.VERCEL_TARGET_ENV = "staging";

    const response = await POST(request({ target: "fixturenode12", apply: true }));

    expect(response.status).toBe(500);
    expect(mockInspect).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });
});
