/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "fs";
import { join } from "path";
import { render, screen, waitFor } from "@testing-library/react";

import BillingActivityPage from "../page";

jest.mock("framer-motion", () => {
  // Forward motion.div to a plain div without the animation-only props.
  const MOTION_ONLY_PROPS = new Set(["initial", "animate", "exit", "transition", "variants"]);
  function MotionDiv(props: Record<string, unknown>) {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (!MOTION_ONLY_PROPS.has(key)) rest[key] = props[key];
    }
    return <div {...rest} />;
  }
  return {
    motion: { div: MotionDiv },
    useReducedMotion: () => true,
  };
});

jest.mock("@/components/billing/BillingActivityPanel", () => ({
  BillingActivityPanel: ({ activity, error }: { activity: unknown; error: string | null }) => (
    <div data-testid="activity-panel">{error ?? (activity ? "activity loaded" : "no activity")}</div>
  ),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: { error: jest.fn(), warn: jest.fn() },
}));

describe("BillingActivityPage", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { items: [] } }),
    }) as unknown as typeof fetch;
  });

  it("links back to billing with a real, labelled breadcrumb", async () => {
    render(<BillingActivityPage />);
    const back = screen.getByRole("link", { name: "Back to billing" });
    expect(back).toHaveAttribute("href", "/dashboard/billing");
    expect(await screen.findByTestId("activity-panel")).toHaveTextContent("activity loaded");
    expect(global.fetch).toHaveBeenCalledWith("/api/billing/activity");
  });

  it("pads the top with the shell's safe-area variable, falling back to the raw inset", () => {
    // jsdom cannot evaluate env()/var(), so pin the stylesheet contract itself:
    // never add the raw inset on top of the shell header's own inset.
    const css = readFileSync(join(__dirname, "..", "activity.module.css"), "utf8");
    expect(css).toContain(
      "padding-top: calc(var(--dashboard-page-safe-top, env(safe-area-inset-top, 0px)) + clamp(1.5rem, 5vw, 3rem));"
    );
    expect(css).toMatch(/\.backLink\s*{[^}]*min-height: 44px;/);
  });

  it("shows the API error in the panel", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ success: false, error: "Billing activity is unavailable right now." }),
    }) as unknown as typeof fetch;
    render(<BillingActivityPage />);
    await waitFor(() =>
      expect(screen.getByTestId("activity-panel")).toHaveTextContent("Billing activity is unavailable right now.")
    );
  });
});
