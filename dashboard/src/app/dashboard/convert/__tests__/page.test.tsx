/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { DASHBOARD_SECONDARY_NAVIGATION, isDashboardNavigationItemActive } from "@/lib/dashboard-navigation";

import ConvertPage from "../page";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_1" })) }));
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn(async () => null) }));

describe("/dashboard/convert", () => {
  it("renders the dormant state from the committed registry and links", async () => {
    render(await ConvertPage());

    expect(screen.getByTestId("convert-closed")).toHaveTextContent(
      "Conversion opens after $HIVRA launches; terms are published first.",
    );
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
