/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";

import { UsageUpgradeFooter } from "../UsageUpgradeFooter";
import { captureClient } from "@/lib/telemetry/posthog-client";

jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

describe("UsageUpgradeFooter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the show-value-then-ask pitch with concrete specs and price", () => {
    render(<UsageUpgradeFooter />);
    expect(screen.getByTestId("usage-upgrade-footer")).toBeInTheDocument();
    expect(screen.getByText(/real work from a free agent/i)).toBeInTheDocument();
    expect(screen.getByText(/\$9\.99 a month/i)).toBeInTheDocument();
    expect(screen.getByText(/4x the memory/i)).toBeInTheDocument();
  });

  it("deep-links the CTA to billing with always_on attribution", () => {
    render(<UsageUpgradeFooter />);
    expect(screen.getByRole("link", { name: /go pro/i })).toHaveAttribute(
      "href",
      "/dashboard/billing?from=paywall&feature=always_on"
    );
  });

  it("fires paywall_viewed on mount and upgrade_clicked with surface:'usage_summary' on click", () => {
    render(<UsageUpgradeFooter />);

    expect(captureClient).toHaveBeenCalledWith("paywall_viewed", {
      surface: "usage_summary",
      feature: "always_on",
      plan: "free",
    });

    fireEvent.click(screen.getByRole("link", { name: /go pro/i }));

    expect(captureClient).toHaveBeenCalledWith("upgrade_clicked", {
      surface: "usage_summary",
      feature: "always_on",
      from_plan: "free",
      to_plan: "operator",
    });
  });
});
