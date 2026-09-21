/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";

import { ArchiveUpgradeWall } from "../ArchiveUpgradeWall";
import { captureClient } from "@/lib/telemetry/posthog-client";

jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

describe("ArchiveUpgradeWall", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the loss-aversion wall with the real countdown and specifics", () => {
    render(<ArchiveUpgradeWall instanceId="inst-1" instanceName="ATLAS" daysUntilArchive={3} />);

    expect(screen.getByTestId("instance-archive-upgrade-wall")).toBeInTheDocument();
    expect(screen.getByText(/archiving in 3 days/i)).toBeInTheDocument();
    expect(screen.getByText(/ATLAS and everything it remembers get packed away/i)).toBeInTheDocument();
    expect(screen.getByText(/Pro agents never do/i)).toBeInTheDocument();
    expect(screen.getByText(/\$9\.99 a month/i)).toBeInTheDocument();
  });

  it("varies the countdown label for tomorrow / today", () => {
    const { rerender } = render(<ArchiveUpgradeWall instanceId="i" daysUntilArchive={1} />);
    expect(screen.getByText(/archiving tomorrow/i)).toBeInTheDocument();

    rerender(<ArchiveUpgradeWall instanceId="i" daysUntilArchive={0} />);
    expect(screen.getByText(/archiving today/i)).toBeInTheDocument();
  });

  it("falls back to 'Your agent' when no instance name is given", () => {
    render(<ArchiveUpgradeWall instanceId="inst-1" daysUntilArchive={2} />);
    expect(screen.getByText(/Your agent and everything it remembers/i)).toBeInTheDocument();
  });

  it("deep-links the CTA to billing with always_on attribution", () => {
    render(<ArchiveUpgradeWall instanceId="inst-1" instanceName="ATLAS" daysUntilArchive={3} />);
    expect(screen.getByRole("link", { name: /keep my agent live/i })).toHaveAttribute(
      "href",
      "/dashboard/billing?from=paywall&feature=always_on"
    );
  });

  it("fires paywall_viewed on mount and upgrade_clicked with surface:'archive_wall' on click", () => {
    render(<ArchiveUpgradeWall instanceId="inst-1" instanceName="ATLAS" daysUntilArchive={3} />);

    expect(captureClient).toHaveBeenCalledWith("paywall_viewed", {
      surface: "archive_wall",
      feature: "always_on",
      plan: "free",
      instance_id: "inst-1",
      days_until_archive: 3,
    });

    fireEvent.click(screen.getByRole("link", { name: /keep my agent live/i }));

    expect(captureClient).toHaveBeenCalledWith("upgrade_clicked", {
      surface: "archive_wall",
      feature: "always_on",
      limit_type: "inactivity",
      instance_id: "inst-1",
      from_plan: "free",
      to_plan: "operator",
      days_until_archive: 3,
    });
  });
});
