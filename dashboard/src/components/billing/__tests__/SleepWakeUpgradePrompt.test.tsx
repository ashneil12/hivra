/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";

import { SleepWakeUpgradePrompt } from "../SleepWakeUpgradePrompt";
import { captureClient } from "@/lib/telemetry/posthog-client";

jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

describe("SleepWakeUpgradePrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the paid-plan pitch alongside the wake progress, with no free hosted tier in it", () => {
    render(<SleepWakeUpgradePrompt instanceId="inst-1" instanceName="ATLAS" />);

    expect(screen.getByTestId("instance-sleep-wake-upgrade-banner")).toBeInTheDocument();
    expect(screen.getByText(/warming up your agent/i)).toBeInTheDocument();
    expect(screen.getByText(/ATLAS slept after 4 idle days/i)).toBeInTheDocument();
    expect(screen.getByText(/about a minute\. A paid plan keeps the computer running/i)).toBeInTheDocument();
    expect(screen.queryByText(/Free agents sleep|Pro agents|24\/7/i)).not.toBeInTheDocument();
  });

  it("falls back to 'Your agent' when no instance name is given", () => {
    render(<SleepWakeUpgradePrompt instanceId="inst-1" />);
    expect(screen.getByText(/Your agent slept after 4 idle days/i)).toBeInTheDocument();
  });

  it("deep-links the CTA to billing with always_on attribution", () => {
    render(<SleepWakeUpgradePrompt instanceId="inst-1" instanceName="ATLAS" />);
    expect(screen.getByRole("link", { name: /keep it running/i })).toHaveAttribute(
      "href",
      "/dashboard/billing?from=paywall&feature=always_on"
    );
  });

  it("fires paywall_viewed on mount and upgrade_clicked with surface:'sleep_wake_banner' on click", () => {
    render(<SleepWakeUpgradePrompt instanceId="inst-1" instanceName="ATLAS" />);

    expect(captureClient).toHaveBeenCalledWith("paywall_viewed", {
      surface: "sleep_wake_banner",
      feature: "always_on",
      plan: "free",
      instance_id: "inst-1",
    });

    fireEvent.click(screen.getByRole("link", { name: /keep it running/i }));

    expect(captureClient).toHaveBeenCalledWith("upgrade_clicked", {
      surface: "sleep_wake_banner",
      feature: "always_on",
      limit_type: "inactivity",
      instance_id: "inst-1",
      from_plan: "free",
      to_plan: "operator",
    });
  });
});
