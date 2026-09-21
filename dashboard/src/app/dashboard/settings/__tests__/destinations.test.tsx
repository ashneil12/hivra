/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ApplicationsPage from "../applications/page";
import HelpPage from "../help/page";

describe("Settings access and support destinations", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn().mockImplementation((media: string) => ({ matches: false, media })),
    });
    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: false });
    jest.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it("offers browser and resource access when the browser has no install prompt", () => {
    render(<ApplicationsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Applications" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "Your computers" })).toHaveAttribute("href", "/dashboard/computers");
    expect(screen.queryByRole("button", { name: "Install Hivra" })).not.toBeInTheDocument();
    expect(screen.getByText(/Installation options depend on your browser and device/)).toBeInTheDocument();
  });

  it("uses the existing browser install prompt without claiming a dismissed install succeeded", async () => {
    render(<ApplicationsPage />);
    const prompt = jest.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt,
      userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
    });
    await act(async () => { window.dispatchEvent(event); });
    fireEvent.click(screen.getByRole("button", { name: "Install Hivra" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Install Hivra" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Open workspace" })).toBeInTheDocument();
    expect(screen.queryByText(/successfully installed|installation complete/i)).not.toBeInTheDocument();
  });

  it("keeps the Applications destination useful inside an installed web app", () => {
    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: true });
    render(<ApplicationsPage />);
    expect(screen.queryByRole("button", { name: "Install Hivra" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Your computers" })).toBeInTheDocument();
  });

  it("preserves existing support and legal destinations with named external links", () => {
    render(<HelpPage />);
    expect(screen.getByRole("link", { name: "Email support" })).toHaveAttribute("href", "mailto:info@hermesos.cloud");
    expect(screen.getByRole("link", { name: "Discord (opens in a new tab)" })).toHaveAttribute("href", "https://discord.gg/tDQZq8479F");
    const updates = screen.getByRole("link", { name: "X (Twitter) (opens in a new tab)" });
    expect(updates).toHaveAttribute("href", "https://x.com/Wayland_Six");
    expect(updates).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  });
});
