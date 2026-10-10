/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { MemoryUsageBanner } from "../MemoryUsageBanner";

function mockPressure(level: "ok" | "warn" | "critical", percent = 86) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { level, percent, is_paid_tier: false } }),
  }) as unknown as typeof fetch;
}

describe("MemoryUsageBanner", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stays dismissed for the same instance after a remount", async () => {
    mockPressure("warn");
    const { unmount } = render(<MemoryUsageBanner instanceId="inst-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss memory warning" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();

    render(<MemoryUsageBanner instanceId="inst-1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows again when pressure escalates past the dismissed level", async () => {
    window.localStorage.setItem("hivra_memory_banner_dismissed_inst-2", "1");
    mockPressure("critical", 104);
    render(<MemoryUsageBanner instanceId="inst-2" />);
    expect(await screen.findByText("Out of RAM on the free plan")).toBeInTheDocument();
  });

  it("forgets the dismissal once pressure is back to ok, so the next episode shows", async () => {
    window.localStorage.setItem("hivra_memory_banner_dismissed_inst-5", "2");
    mockPressure("ok");
    const { unmount } = render(<MemoryUsageBanner instanceId="inst-5" />);
    await waitFor(() => expect(window.localStorage.getItem("hivra_memory_banner_dismissed_inst-5")).toBeNull());
    unmount();

    mockPressure("critical", 104);
    render(<MemoryUsageBanner instanceId="inst-5" />);
    expect(await screen.findByText("Out of RAM on the free plan")).toBeInTheDocument();
  });

  it("keeps each instance's dismissal separate", async () => {
    window.localStorage.setItem("hivra_memory_banner_dismissed_inst-3", "2");
    mockPressure("warn");
    render(<MemoryUsageBanner instanceId="inst-4" />);
    expect(await screen.findByText("Approaching your plan's RAM")).toBeInTheDocument();
  });
});
