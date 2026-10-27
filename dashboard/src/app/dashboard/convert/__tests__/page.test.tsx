/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { DASHBOARD_SECONDARY_NAVIGATION, isDashboardNavigationItemActive } from "@/lib/dashboard-navigation";

import ConvertPage from "../page";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_1" })) }));
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn(async () => null) }));

type LaunchBlock = typeof import("@/lib/billing/hivra-token-launch").HIVRA_TOKEN_LAUNCH;
const DORMANT_LAUNCH: LaunchBlock = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
const COMMITTED_LAUNCH: LaunchBlock = jest.requireActual("@/lib/billing/hivra-token-launch").HIVRA_TOKEN_LAUNCH;
const mockLaunch: { current: LaunchBlock } = { current: DORMANT_LAUNCH };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch.current;
  },
}));

describe("/dashboard/convert", () => {
  afterEach(() => {
    mockLaunch.current = DORMANT_LAUNCH;
  });

  it("renders the dormant state while the launch block is empty", async () => {
    mockLaunch.current = DORMANT_LAUNCH;
    render(await ConvertPage());

    expect(screen.getByTestId("convert-closed")).toHaveTextContent(
      "Conversion opens after $HIVRA launches; terms are published first.",
    );
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
  });

  it("renders the committed launch: both contracts and the published snapshot, but no Sablier link before a campaign exists", async () => {
    mockLaunch.current = COMMITTED_LAUNCH;
    const { container } = render(await ConvertPage());

    expect(screen.queryByTestId("convert-closed")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("0xe3a1F26440A9FDf5d17b6B3F12F5ebB290080871");
    expect(container).toHaveTextContent("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(screen.getByTestId("convert-snapshot-block")).toHaveTextContent("Snapshot block: 53005062");
    expect(screen.getByRole("link", { name: "View the published snapshot" })).toHaveAttribute(
      "href",
      "https://github.com/ashneil12/hivra/blob/main/dashboard/src/data/token/hivra-airdrop.json",
    );
    // No campaign link is configured, so nothing on this page may point at Sablier.
    for (const link of screen.getAllByRole("link")) expect(link.getAttribute("href") ?? "").not.toMatch(/sablier/i);
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
  });
});

describe("/dashboard/convert navigation", () => {
  it("highlights Billing, which owns the wallet", () => {
    const billing = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "billing")!;

    expect(isDashboardNavigationItemActive(billing, "/dashboard/convert")).toBe(true);
    expect(isDashboardNavigationItemActive(billing, "/dashboard/convertible")).toBe(false);
  });
});
