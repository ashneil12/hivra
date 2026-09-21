/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import OfflinePage, { dynamic, metadata } from "../page";

describe("offline fallback page", () => {
  it("renders a branded Hivra offline message", () => {
    render(<OfflinePage />);

    expect(screen.getByText("Hivra")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /you.?re offline/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/reconnects automatically/i)).toBeInTheDocument();
  });

  it("offers a reconnect link back into the app", () => {
    render(<OfflinePage />);

    const reconnect = screen.getByRole("link", { name: /try reconnecting/i });
    expect(reconnect).toHaveAttribute("href", "/dashboard/chat");

    const home = screen.getByRole("link", { name: /back to home/i });
    expect(home).toHaveAttribute("href", "/");
  });

  it("is a static, non-indexed route", () => {
    expect(dynamic).toBe("force-static");
    expect(metadata.title).toBe("Offline");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});
