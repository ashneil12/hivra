/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { DashboardClient } from "../dashboard-client";

function mockPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({ matches: query === "(pointer: coarse)" ? coarse : false, addEventListener: jest.fn(), removeEventListener: jest.fn() })),
  });
}

describe("Workspace Cloud launch modal", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      const data = path.endsWith("/status")
        ? { subscribed: true, status: "active", instanceLimit: 1, instanceCount: 0, currentPeriodEnd: null, plan: null, offer: { key: "pro", name: "Pro", priceLabel: "$9.99/mo" } }
        : [];
      return { ok: true, status: 200, json: async () => ({ data }) } as Response;
    }) as typeof fetch;
  });

  async function openLaunchModal() {
    render(<DashboardClient />);
    fireEvent.click(await screen.findByRole("button", { name: /launch agent/i }));
    return screen.getByDisplayValue("Workspace Cloud Agent");
  }

  it("focuses the name field for mouse and keyboard users", async () => {
    mockPointer(false);
    const input = await openLaunchModal();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("enterkeyhint", "go");
    expect(input).toHaveAttribute("autocapitalize", "words");
  });

  it("does not raise the touch keyboard over the prefilled name but still moves focus into the dialog", async () => {
    mockPointer(true);
    const input = await openLaunchModal();
    expect(input).not.toHaveFocus();
    const dialog = screen.getByRole("dialog", { name: "Launch your cloud agent" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
    expect(screen.getByLabelText("Agent name")).toBe(input);
  });
});
