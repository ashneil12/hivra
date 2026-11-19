/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_1" })) }));

const redeem = jest.fn();
const start = jest.fn();
jest.mock("@/lib/infrastructure/home-connector", () => {
  class HomeConnectorError extends Error { constructor(readonly code: string, message: string) { super(message); } }
  return {
    HomeConnectorError,
    homeConnectorEnabled: () => process.env.HIVRA_HOME_CONNECTOR_ENABLED === "true",
    redeemHomeConnectorEnrolment: (...args: unknown[]) => redeem(...args),
    startHomeConnectorEnrolment: (...args: unknown[]) => start(...args),
    revokeHomeConnector: jest.fn(),
  };
});
jest.mock("@/lib/infrastructure/home-connector-store", () => ({ getHomeConnector: jest.fn() }));
jest.mock("@/lib/infrastructure/host-relay", () => ({ hostRelayStatus: jest.fn() }));

import { NextRequest } from "next/server";

import { HomeConnectorError } from "@/lib/infrastructure/home-connector";

import { GET as getFlag, POST as startRoute } from "../route";
import { POST as enrolRoute } from "../enrol/route";
import { GET as installRoute } from "../install/route";

const json = { "content-type": "application/json" };
const saved = { flag: process.env.HIVRA_HOME_CONNECTOR_ENABLED, origin: process.env.NEXT_PUBLIC_APP_URL };
afterEach(() => {
  if (saved.flag === undefined) delete process.env.HIVRA_HOME_CONNECTOR_ENABLED; else process.env.HIVRA_HOME_CONNECTOR_ENABLED = saved.flag;
  if (saved.origin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = saved.origin;
  jest.clearAllMocks();
});

describe("home connector routes", () => {
  it("report the flag to a signed-in user as a plain boolean, off by default", async () => {
    delete process.env.HIVRA_HOME_CONNECTOR_ENABLED;
    expect((await (await getFlag()).json()).data).toEqual({ enabled: false });
    process.env.HIVRA_HOME_CONNECTOR_ENABLED = "true";
    expect((await (await getFlag()).json()).data).toEqual({ enabled: true });
  });

  it("start nothing while the flag is off", async () => {
    delete process.env.HIVRA_HOME_CONNECTOR_ENABLED;
    const response = await startRoute(new NextRequest("https://app.example.test/api/infrastructure/home-connector", {
      method: "POST", headers: { origin: "https://app.example.test", host: "app.example.test", "sec-fetch-site": "same-origin" },
    }));
    expect(response.status).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });

  it("serve no installer and redeem no code while the flag is off", async () => {
    delete process.env.HIVRA_HOME_CONNECTOR_ENABLED;
    expect((await installRoute(new NextRequest("https://app.example.test/api/infrastructure/home-connector/install"))).status).toBe(404);
    redeem.mockRejectedValue(new HomeConnectorError("disabled", "off"));
    const response = await enrolRoute(new NextRequest("https://app.example.test/api/infrastructure/home-connector/enrol", {
      method: "POST", headers: json, body: JSON.stringify({ token: "hvc_x" }),
    }));
    expect([400, 404]).toContain(response.status);
  });

  it("enrol refuses a browser request and returns config for a good code", async () => {
    const browser = await enrolRoute(new NextRequest("https://app.example.test/api/infrastructure/home-connector/enrol", {
      method: "POST", headers: { ...json, origin: "https://evil.example.test" }, body: JSON.stringify({ token: "hvc_x" }),
    }));
    expect(browser.status).toBe(403);
    redeem.mockResolvedValue({ relay: "wss://relay.example.test", connectionId: "c", generation: 1, secret: "derived" });
    const ok = await enrolRoute(new NextRequest("https://app.example.test/api/infrastructure/home-connector/enrol", {
      method: "POST", headers: json, body: JSON.stringify({ token: `hvc_${"a".repeat(32)}` }),
    }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(await ok.json()).toEqual({ relay: "wss://relay.example.test", connectionId: "c", generation: 1, secret: "derived" });
  });
});
