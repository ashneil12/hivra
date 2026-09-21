/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import AdminInsightsPage from "../page";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isOpsAdminUser } from "@/lib/ops-access";
import { getConversionFunnel } from "@/lib/conversion-funnel";
import { getActivationCohorts } from "@/lib/activation-cohorts";
import { getPlatformStats } from "@/lib/platform-stats";

jest.mock("@clerk/nextjs/server", () => {
  const authMock = jest.fn();
  (authMock as jest.Mock & { protect: jest.Mock }).protect = jest.fn();
  return { auth: authMock, currentUser: jest.fn() };
});

jest.mock("next/navigation", () => ({ redirect: jest.fn() }));

jest.mock("@/components/layout/DashboardPageShell", () => ({
  DashboardPageShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}));

jest.mock("@/components/admin/AdminInsightsContent.client", () => ({
  AdminInsightsContent: ({ rangeKey, funnel }: { rangeKey: string; funnel: unknown }) => (
    <div data-testid="content">
      range={rangeKey} funnel={funnel ? "yes" : "no"}
    </div>
  ),
}));

jest.mock("@/lib/ops-access", () => ({ isOpsAdminUser: jest.fn() }));
jest.mock("@/lib/conversion-funnel", () => ({ getConversionFunnel: jest.fn() }));
jest.mock("@/lib/activation-cohorts", () => ({ getActivationCohorts: jest.fn() }));
jest.mock("@/lib/platform-stats", () => ({ getPlatformStats: jest.fn() }));

describe("AdminInsightsPage", () => {
  const mockedAuth = auth as unknown as jest.Mock & { protect: jest.Mock };
  const mockedCurrentUser = currentUser as jest.Mock;
  const mockedRedirect = redirect as unknown as jest.Mock;
  const mockedIsAdmin = isOpsAdminUser as jest.Mock;
  const mockedGetStats = getPlatformStats as jest.Mock;
  const mockedGetFunnel = getConversionFunnel as jest.Mock;
  const mockedGetActivation = getActivationCohorts as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_1" });
    mockedAuth.protect.mockResolvedValue(undefined);
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "admin@hermesos.cloud" },
    });
    mockedGetStats.mockResolvedValue({
      generatedAt: "2026-05-23T00:00:00.000Z",
      rangeDays: 30,
      series: [],
      latest: null,
      liveTotals: { total_agents_deployed: 0, active_agents: 0, live_instances: 0, total_users: 0 },
    });
    mockedGetFunnel.mockResolvedValue({
      generatedAt: "2026-05-23T00:00:00.000Z",
      weeklyCohorts: [],
      daily: [],
      engagedFreePool: 0,
      currentTotals: { free: 0, paidByPlan: {} },
      upgradeSplit: { day0: 0, later: 0, unclear: 0 },
      upgradeTimestampSource: "period_start_inference",
    });
    mockedGetActivation.mockResolvedValue({
      generatedAt: "2026-05-23T00:00:00.000Z",
      cohorts: [],
      firstUsageInstrumentedFrom: "2026-05-30",
      retentionDays: 35,
    });
  });

  it("redirects non-admins and never fetches stats", async () => {
    mockedIsAdmin.mockReturnValue(false);

    const ui = await AdminInsightsPage({ searchParams: Promise.resolve({}) });

    expect(ui).toBeNull();
    expect(mockedRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockedGetStats).not.toHaveBeenCalled();
    expect(mockedGetFunnel).not.toHaveBeenCalled();
    expect(mockedGetActivation).not.toHaveBeenCalled();
  });

  it("renders insights for admins with the default 30d range", async () => {
    mockedIsAdmin.mockReturnValue(true);

    const ui = await AdminInsightsPage({ searchParams: Promise.resolve({}) });
    render(ui);

    expect(mockedGetStats).toHaveBeenCalledWith(30);
    expect(mockedGetFunnel).toHaveBeenCalledTimes(1);
    expect(mockedGetActivation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("content")).toHaveTextContent("range=30d");
    expect(screen.getByTestId("content")).toHaveTextContent("funnel=yes");
  });

  it("maps 7d / 6m / 1y range keys to day counts", async () => {
    mockedIsAdmin.mockReturnValue(true);

    await AdminInsightsPage({ searchParams: Promise.resolve({ range: "7d" }) });
    expect(mockedGetStats).toHaveBeenCalledWith(7);

    mockedGetStats.mockClear();
    await AdminInsightsPage({ searchParams: Promise.resolve({ range: "6m" }) });
    expect(mockedGetStats).toHaveBeenCalledWith(180);

    mockedGetStats.mockClear();
    await AdminInsightsPage({ searchParams: Promise.resolve({ range: "1y" }) });
    expect(mockedGetStats).toHaveBeenCalledWith(365);
  });

  it("computes YTD as days since Jan 1, clamped to 365", async () => {
    mockedIsAdmin.mockReturnValue(true);

    const ui = await AdminInsightsPage({ searchParams: Promise.resolve({ range: "ytd" }) });
    render(ui);

    const days = mockedGetStats.mock.calls[0][0] as number;
    expect(typeof days).toBe("number");
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(365);
    expect(screen.getByTestId("content")).toHaveTextContent("range=ytd");
  });

  it("falls back to 30d for an unknown range value", async () => {
    mockedIsAdmin.mockReturnValue(true);

    const ui = await AdminInsightsPage({ searchParams: Promise.resolve({ range: "zzz" }) });
    render(ui);

    expect(mockedGetStats).toHaveBeenCalledWith(30);
    expect(screen.getByTestId("content")).toHaveTextContent("range=30d");
  });
});
