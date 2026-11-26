import { NextRequest } from "next/server";

const grant = jest.fn().mockResolvedValue({ attempted: true });
const line = jest.fn().mockResolvedValue({ label: "$2.00 Starter credit", remainingMicroUsd: 2000000 });
const launch = jest.fn().mockResolvedValue({ attempted: false });

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "u1" })) }));
jest.mock("@/lib/logger", () => jest.requireActual("@/test-utils").createLoggerMock());
jest.mock("@/lib/billing/starter-credit", () => ({
  tryGrantStarterCredit: (...a: unknown[]) => grant(...a),
  getStarterCreditLine: (...a: unknown[]) => line(...a),
}));
jest.mock("@/lib/venice/promo/service", () => ({
  getUserPromoLines: jest.fn(),
  recordVeniceAttribution: jest.fn(),
  redeemVeniceCode: jest.fn(),
  tryGrantLaunchCredit: (...a: unknown[]) => launch(...a),
}));

import { GET, POST } from "../route";
import { getUserPromoLines, recordVeniceAttribution, redeemVeniceCode } from "@/lib/venice/promo/service";

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(process, "env", { ...process.env });
  delete process.env.HIVRA_VENICE_PROMO_ENABLED;
  jest.mocked(getUserPromoLines).mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

describe("GET /api/billing/venice-promo attribution", () => {
  it("records the returned claim cookie for the signed-in account before trying to grant credit", async () => {
    process.env.HIVRA_VENICE_PROMO_ENABLED = "true";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "canary.hermesos.cloud";

    const save = jest.mocked(recordVeniceAttribution);
    launch.mockImplementationOnce(async () => {
      expect(save).toHaveBeenCalledWith({ userId: "u1", attribution: { ref: "venice", code: "VENICE" } });
      return { attempted: false };
    });

    const response = await GET(new NextRequest("http://localhost/api/billing/venice-promo?prepareLaunch=1", {
      headers: { cookie: "hivra_venice_attr=ref%3Dvenice%26code%3DVENICE" },
    }));

    expect(response.status).toBe(200);
    expect(launch).toHaveBeenCalledWith({ userId: "u1" });
  });

  it("ignores claim attribution on the production project even with the promo enabled", async () => {
    process.env.HIVRA_VENICE_PROMO_ENABLED = "true";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "hivra.cloud";

    const response = await GET(new NextRequest("https://canary.hermesos.cloud/api/billing/venice-promo?prepareLaunch=1", {
      headers: { cookie: "hivra_venice_attr=ref%3Dvenice%26code%3DVENICE" },
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ codeEntry: false, lines: [{ grantId: "starter-credit" }] });
    expect(grant).toHaveBeenCalledWith({ userId: "u1" });
    expect(recordVeniceAttribution).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(getUserPromoLines).not.toHaveBeenCalled();
  });
});

describe("GET /api/billing/venice-promo starter credit", () => {
  it("grants on prepareLaunch even with the promo flag off, and lists the line", async () => {
    const res = await GET(new NextRequest("http://localhost/api/billing/venice-promo?prepareLaunch=1"));
    const body = await res.json();
    expect(grant).toHaveBeenCalledWith({ userId: "u1" });
    expect(launch).not.toHaveBeenCalled();
    expect(body.data.lines[0].label).toBe("$2.00 Starter credit");
  });

  it("does not grant on a plain read", async () => {
    await GET(new NextRequest("http://localhost/api/billing/venice-promo"));
    expect(grant).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/venice-promo", () => {
  it.each([["hivra.cloud", 404], ["canary.hermesos.cloud", 200]])(
    "only accepts a claim on the Canary project (%s)",
    async (domain, expectedStatus) => {
      process.env.HIVRA_VENICE_PROMO_ENABLED = "true";
      process.env.VERCEL_PROJECT_PRODUCTION_URL = domain;
      const redeem = jest.mocked(redeemVeniceCode).mockResolvedValue({ status: "saved" });
      const response = await POST(new NextRequest("https://canary.hermesos.cloud/api/billing/venice-promo", {
        method: "POST",
        body: JSON.stringify({ code: "VENICE" }),
      }));

      expect(response.status).toBe(expectedStatus);
      expect(redeem).toHaveBeenCalledTimes(expectedStatus === 200 ? 1 : 0);
    },
  );
});
