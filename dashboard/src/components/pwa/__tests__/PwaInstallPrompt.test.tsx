/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { renderToString } = jest.requireActual("react-dom/server.node") as typeof import("react-dom/server");

import { PwaInstallPrompt } from "../PwaInstallPrompt";

type BeforeInstallPromptEventLike = Event & {
  prompt: jest.Mock<Promise<void>, []>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

describe("PwaInstallPrompt", () => {
  let userAgentSpy: jest.SpyInstance<string, []>;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });

    Object.defineProperty(window.navigator, "standalone", {
      configurable: true,
      value: false,
    });
    userAgentSpy = jest.spyOn(window.navigator, "userAgent", "get");
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows an install CTA when the browser exposes the install prompt", async () => {
    render(<PwaInstallPrompt />);

    expect(screen.queryByText(/install hivra/i)).not.toBeInTheDocument();

    const prompt = jest.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt") as BeforeInstallPromptEventLike;
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
    event.preventDefault = jest.fn();

    await act(async () => {
      window.dispatchEvent(event);
    });

    expect(
      await screen.findByRole("heading", { name: "Install Hivra" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Install app")).toHaveStyle({ fontSize: "12px" });
    expect(screen.getByRole("button", { name: "Dismiss install prompt" }).className).toContain(
      "min-h-[44px]",
    );

    fireEvent.click(screen.getByRole("button", { name: "Install Hivra" }));

    await waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });
  });

  it("shows Mac Add to Dock guidance when no native prompt is exposed", async () => {
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    );

    render(<PwaInstallPrompt />);

    expect(await screen.findByRole("heading", { name: "Install Hivra" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "On Mac in Chrome or Edge, open the browser menu and choose Install Hivra or Add to Dock.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Chrome or Edge: Install Hivra or Add to Dock"),
    ).toBeInTheDocument();
  });

  it("shows Safari Add to Dock guidance on Mac Safari", async () => {
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    );

    render(<PwaInstallPrompt />);

    expect(
      await screen.findByText(
        "On Mac in Safari, open File, choose Add to Dock, then confirm Add.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Safari: File, then Add to Dock")).toBeInTheDocument();
    expect(screen.queryByText(/Chrome or Edge:/)).not.toBeInTheDocument();
  });

  it("does not show Chromium install steps on Mac Firefox", () => {
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:141.0) Gecko/20100101 Firefox/141.0",
    );

    render(<PwaInstallPrompt />);

    expect(screen.queryByText(/Chrome or Edge/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Install Hivra" })).not.toBeInTheDocument();
  });

  it("treats iPad desktop-mode Safari as iOS Safari", async () => {
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    );

    render(<PwaInstallPrompt />);

    expect(await screen.findByText(/add hivra to your home screen/i)).toBeInTheDocument();
    expect(screen.queryByText(/Add to Dock/)).not.toBeInTheDocument();
  });

  it("recovers when the native prompt rejects", async () => {
    render(<PwaInstallPrompt />);
    const event = new Event("beforeinstallprompt") as BeforeInstallPromptEventLike;
    event.prompt = jest.fn().mockRejectedValue(new Error("expired prompt"));
    event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
    event.preventDefault = jest.fn();

    await act(async () => {
      window.dispatchEvent(event);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Install Hivra" }));

    expect(
      await screen.findByRole("status"),
    ).toHaveTextContent("The install prompt is unavailable");
    expect(screen.queryByRole("button", { name: "Install Hivra" })).not.toBeInTheDocument();
    expect(screen.getByText("Browser menu: Install app or Create shortcut")).toBeInTheDocument();
  });

  it("recovers when native userChoice rejects", async () => {
    let rejectChoice!: (error: Error) => void;
    const userChoice = new Promise<{
      outcome: "accepted" | "dismissed";
      platform: string;
    }>((_resolve, reject) => {
      rejectChoice = reject;
    });
    render(<PwaInstallPrompt />);
    const event = new Event("beforeinstallprompt") as BeforeInstallPromptEventLike;
    event.prompt = jest.fn().mockResolvedValue(undefined);
    event.userChoice = userChoice;
    event.preventDefault = jest.fn();

    await act(async () => {
      window.dispatchEvent(event);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Install Hivra" }));
    await act(async () => rejectChoice(new Error("choice unavailable")));

    expect(
      await screen.findByRole("status"),
    ).toHaveTextContent("The install prompt is unavailable");
    expect(screen.queryByRole("button", { name: "Install Hivra" })).not.toBeInTheDocument();
    expect(screen.getByText("Browser menu: Install app or Create shortcut")).toBeInTheDocument();
  });

  it("shows a polite visible failure state when a collapsed prompt is consumed", async () => {
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    );
    render(<PwaInstallPrompt expanded={false} />);
    const event = new Event("beforeinstallprompt") as BeforeInstallPromptEventLike;
    const prompt = jest.fn().mockRejectedValue(new Error("expired prompt"));
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
    event.preventDefault = jest.fn();

    await act(async () => {
      window.dispatchEvent(event);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Install Hivra" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The install prompt is unavailable",
    );
    expect(screen.getByTestId("install-prompt-error-icon")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Install Hivra unavailable" }),
    ).toBeDisabled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("stays hidden when already running standalone", () => {
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)",
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    );

    render(<PwaInstallPrompt />);

    expect(screen.queryByText("Install Hivra")).not.toBeInTheDocument();
    expect(screen.queryByText(/add to dock/i)).not.toBeInTheDocument();
  });

  it("gives the collapsed native action an accessible Install Hivra name", async () => {
    render(<PwaInstallPrompt expanded={false} />);
    const event = new Event("beforeinstallprompt") as BeforeInstallPromptEventLike;
    event.prompt = jest.fn().mockResolvedValue(undefined);
    event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
    event.preventDefault = jest.fn();

    await act(async () => {
      window.dispatchEvent(event);
    });

    const install = await screen.findByRole("button", { name: "Install Hivra" });
    expect(install).toHaveClass("min-h-[44px]", "min-w-[44px]");
  });

  it("renders iPhone install guidance when beforeinstallprompt is unavailable", async () => {
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    );

    render(<PwaInstallPrompt />);

    expect(await screen.findByText(/add hivra to your home screen/i)).toBeInTheDocument();
    expect(screen.getAllByText(/share, then add to home screen/i)).toHaveLength(2);
  });

  it("renders the same first HTML on every platform so hydration cannot mismatch", () => {
    const desktopHtml = renderToString(<PwaInstallPrompt />);
    userAgentSpy.mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    );
    // The server has no navigator; the first client render must not read it either.
    expect(renderToString(<PwaInstallPrompt />)).toBe(desktopHtml);
    expect(desktopHtml).not.toMatch(/home screen/i);
  });

  it.each([
    ["Chrome", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1"],
    ["Firefox", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15"],
    ["Edge", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/140.0 Mobile/15E148 Safari/605.1.15"],
  ])("gives iOS %s the Share, then Add to Home Screen steps", async (_browser, ua) => {
    userAgentSpy.mockReturnValue(ua);
    render(<PwaInstallPrompt />);
    expect(await screen.findByText(/add hivra to your home screen/i)).toBeInTheDocument();
    expect(screen.queryByText(/in Safari/)).not.toBeInTheDocument();
  });

  it("falls back to manual steps on a touch device that never offers the native prompt", () => {
    jest.useFakeTimers();
    try {
      window.matchMedia = jest.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }));
      userAgentSpy.mockReturnValue(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36",
      );
      render(<PwaInstallPrompt />);
      expect(screen.queryByRole("heading", { name: "Install Hivra" })).not.toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(3000); });
      expect(screen.getByRole("heading", { name: "Install Hivra" })).toBeInTheDocument();
      expect(screen.getByText("Browser menu: Install app or Create shortcut")).toBeInTheDocument();
      // Chromium never fires beforeinstallprompt for an installed app either,
      // so the fallback must not tell an installed user the app is missing.
      expect(screen.getByText(/If Hivra isn't installed on this device yet/)).toBeInTheDocument();
      expect(screen.queryByText(/prompt is unavailable/i)).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not fall back to manual steps with a mouse", () => {
    jest.useFakeTimers();
    try {
      render(<PwaInstallPrompt />);
      act(() => { jest.advanceTimersByTime(5000); });
      expect(screen.queryByRole("heading", { name: "Install Hivra" })).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
