import { NextRequest } from "next/server";

const grant = jest.fn().mockResolvedValue({ attempted: true });
const line = jest.fn().mockResolvedValue({ label: "$2.00 Starter credit", remainingMicroUsd: 2000000 });
const launch = jest.fn().mockResolvedValue({ attempted: false });

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "u1" })) }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
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

import { GET } from "../route";

describe("GET /api/billing/venice-promo starter credit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("grants on prepareLaunch even with the promo flag off, and lists the line", async () => {
    delete process.env.HIVRA_VENICE_PROMO_ENABLED;
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
