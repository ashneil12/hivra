/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import posthog from "posthog-js";

import { UpgradePaywallModal, type PaywallFeature } from "../UpgradePaywallModal";

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

describe("UpgradePaywallModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["browser", /web browsing & automation/i],
    ["memory", /persistent memory/i],
    ["cron", /scheduled tasks/i],
    ["agents", /run a fleet of agents/i],
    ["generic", /this feature needs pro/i],
  ] as [PaywallFeature, RegExp][])(
    "renders the %s feature with a plan comparison line and an attributed billing CTA",
    (feature, title) => {
      render(
        <UpgradePaywallModal feature={feature} currentPlan="free" onClose={jest.fn()} />
      );

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(/free: not included · pro \(\$9\.99\/mo\): included/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /upgrade to pro, \$9\.99\/mo/i })).toHaveAttribute(
        "href",
        `/dashboard/billing?from=paywall&feature=${feature}`
      );
    }
  );

  it("captures paywall_viewed on mount and upgrade_clicked on the CTA", () => {
    render(
      <UpgradePaywallModal feature="browser" currentPlan="free" onClose={jest.fn()} />
    );

    expect(posthog.capture).toHaveBeenCalledWith("paywall_viewed", {
      surface: "feature_lock",
      feature: "browser",
      plan: "free",
    });
    expect(posthog.capture).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("link", { name: /upgrade to pro/i }));

    expect(posthog.capture).toHaveBeenCalledWith("upgrade_clicked", {
      surface: "feature_lock",
      feature: "browser",
      plan: "free",
      from_plan: "free",
      to_plan: "operator",
    });
    expect(posthog.capture).toHaveBeenCalledTimes(2);
  });

  it("tags a custom surface (second_agent) on both funnel events", () => {
    render(
      <UpgradePaywallModal
        feature="agents"
        surface="second_agent"
        currentPlan="free"
        onClose={jest.fn()}
      />
    );

    expect(screen.getByText(/run a fleet of agents/i)).toBeInTheDocument();
    expect(screen.getByText(/free includes one agent/i)).toBeInTheDocument();
    expect(posthog.capture).toHaveBeenCalledWith("paywall_viewed", {
      surface: "second_agent",
      feature: "agents",
      plan: "free",
    });

    fireEvent.click(screen.getByRole("link", { name: /upgrade to pro/i }));

    expect(posthog.capture).toHaveBeenCalledWith("upgrade_clicked", {
      surface: "second_agent",
      feature: "agents",
      plan: "free",
      from_plan: "free",
      to_plan: "operator",
    });
  });

  it("captures a null plan when the current plan is unknown", () => {
    render(<UpgradePaywallModal feature="cron" onClose={jest.fn()} />);

    expect(posthog.capture).toHaveBeenCalledWith("paywall_viewed", {
      surface: "feature_lock",
      feature: "cron",
      plan: null,
    });
  });

  it("dismisses quietly via Not now, the X button, and the backdrop — but not card clicks", () => {
    const onClose = jest.fn();
    const { container } = render(
      <UpgradePaywallModal feature="memory" currentPlan="free" onClose={onClose} />
    );

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking inside the dialog card must NOT dismiss.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking the backdrop does.
    fireEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
