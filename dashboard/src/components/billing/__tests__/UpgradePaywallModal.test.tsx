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

      expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      // Free vs Pro comparison, one row each.
      expect(screen.getByText("Free").nextElementSibling).toHaveTextContent("Not included");
      expect(screen.getByText("Pro · $9.99/mo").nextElementSibling).toHaveTextContent(
        /included · 2 vCPU total · 3 agents/i
      );
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
    render(<UpgradePaywallModal feature="memory" currentPlan="free" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking inside the dialog card must NOT dismiss.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking the backdrop does.
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(3);

    // So does Escape.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("renders through a body portal so the dashboard header and bottom bar cannot cover it", () => {
    const { container } = render(
      <UpgradePaywallModal feature="browser" currentPlan="free" onClose={jest.fn()} />
    );
    const dialog = screen.getByRole("dialog");
    expect(container).not.toContainElement(dialog);
    expect(dialog.closest("[data-hermes-portal-root]")).not.toBeNull();
  });

  it("names the X button exactly 'Close' and keeps 'Not now' a real button", () => {
    render(<UpgradePaywallModal feature="cron" currentPlan="free" onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toHaveAttribute("type", "button");
  });
});
