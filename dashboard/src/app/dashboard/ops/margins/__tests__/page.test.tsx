/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import OpsMarginsPage from "../page";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { loadUsageShareReport, parseUsageShareInputs, parseUsageShareMonth } from "@/lib/billing/usage-share-report";
import { computeUsageSharePreview } from "@/lib/billing/usage-share";
import { isOpsAdminUser } from "@/lib/ops-access";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("@clerk/nextjs/server", () => {
  const authMock = jest.fn();
  (authMock as jest.Mock & { protect: jest.Mock }).protect = jest.fn();
  return { auth: authMock, currentUser: jest.fn() };
});

jest.mock("next/navigation", () => ({ redirect: jest.fn() }));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));

jest.mock("@/lib/ops-access", () => ({
  ...jest.requireActual("@/lib/ops-access"),
  isOpsAdminUser: jest.fn(),
}));

jest.mock("@/lib/billing/usage-share-report", () => ({
  ...jest.requireActual("@/lib/billing/usage-share-report"),
  loadUsageShareReport: jest.fn(),
}));

function page(params: Record<string, string> = {}) {
  return OpsMarginsPage({ searchParams: Promise.resolve(params) });
}

describe("OpsMarginsPage", () => {
  const mockedAuth = auth as unknown as jest.Mock & { protect: jest.Mock };
  const mockedCurrentUser = currentUser as jest.Mock;
  const mockedRedirect = redirect as unknown as jest.Mock;
  const mockedIsOpsAdminUser = isOpsAdminUser as jest.Mock;
  const mockedLoad = loadUsageShareReport as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" });
    mockedAuth.protect.mockResolvedValue(undefined);
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "admin@example.com", verification: { status: "verified" } },
    });
    mockedRedirect.mockImplementation(() => undefined);
  });

  it("redirects non-admin users to the dashboard without reading anything", async () => {
    mockedIsOpsAdminUser.mockReturnValue(false);

    const ui = await page();

    expect(ui).toBeNull();
    expect(mockedRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("shows what each kind of agent would receive", async () => {
    mockedIsOpsAdminUser.mockReturnValue(true);
    const month = parseUsageShareMonth("2026-11");
    const inputs = parseUsageShareInputs({ share: "10", fee: "0", fixed: "0" });
    mockedLoad.mockResolvedValue({
      month,
      inputs,
      preview: computeUsageSharePreview(
        [{ userId: "a", priceMinor: 999 }, { userId: "b", priceMinor: 4900 }, { userId: "quiet", priceMinor: 999 }],
        [
          { userId: "a", agentType: "hermes", agents: 1, activeHours: 30, inferenceRequests: 1200, inferenceChargedMicroUsd: 5_000_000, inferenceCostMicroUsd: 2_000_000, runEvents: 10 },
          { userId: "b", agentType: "openclaw", agents: 2, activeHours: 10, inferenceRequests: 0, inferenceChargedMicroUsd: 0, inferenceCostMicroUsd: 0, runEvents: 5 },
        ],
        { sharePercent: 10, feePercent: 0, feeFixedMinor: 0, serverCostMinor: 0 },
      ),
      serverCosts: { includedMinorUsd: 0, byCurrency: {}, missingRates: [], hostsPriced: 0, activeHosts: 2, unpricedHosts: ["host-a", "host-b"] },
      unbilledPaidPlans: 4,
    });

    const ui = await page({ month: "2026-11", share: "10", fee: "0", fixed: "0" });
    render(ui as React.ReactElement);

    expect(mockedRedirect).not.toHaveBeenCalled();
    expect(mockedLoad).toHaveBeenCalledWith(expect.anything(), month, inputs);
    expect(screen.getByRole("heading", { name: "Usage and margins" })).toBeInTheDocument();

    const hermes = screen.getByRole("row", { name: /Hermes/ });
    // The share is 689.8 cents. a pays 999 of 6898, so Hermes gets 99.9 cents.
    expect(within(hermes).getByText("$1.00")).toBeInTheDocument(); // would receive
    expect(within(hermes).getByText("$3.00")).toBeInTheDocument(); // model margin
    expect(within(hermes).getByText("75.0%")).toBeInTheDocument();
    const openclaw = screen.getByRole("row", { name: /OpenClaw/ });
    expect(within(openclaw).getByText("$4.90")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Not assigned/ })).getByText("$1.00")).toBeInTheDocument();
    expect(screen.getByText("Shared at 10%").previousElementSibling).toHaveTextContent("$6.90");

    expect(screen.getByText(/No server prices are entered/)).toBeInTheDocument();
    expect(screen.getByText(/4 paid-plan account\(s\) have no card or App Store subscription on record/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 paying people have no measured use/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to ops" })).toHaveAttribute("href", "/dashboard/ops");
  });

  it("says so when the report cannot be read", async () => {
    mockedIsOpsAdminUser.mockReturnValue(true);
    mockedLoad.mockRejectedValue(new Error("usage: function does not exist"));

    const ui = await page();
    render(ui as React.ReactElement);

    expect(screen.getByRole("alert")).toHaveTextContent("The report could not be read: usage: function does not exist");
  });
});
