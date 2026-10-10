/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ComposioAppPicker } from "@/components/instances/ComposioAppPicker";

const APPS = [
  { slug: "gmail", name: "Gmail", logo: "", category: "email", toolCount: 10 },
  { slug: "notion", name: "Notion", logo: "", category: "productivity", toolCount: 5 },
  { slug: "stripe", name: "Stripe", logo: "", category: "finance", toolCount: 8 },
];

function mockFetch(apps = APPS) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/catalog")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { apps, categories: [...new Set(apps.map((a) => a.category))] },
          }),
      } as unknown as Response);
    }
    if (url.includes("/connected-apps")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { apps: [] } }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe("ComposioAppPicker", () => {
  beforeEach(() => mockFetch());

  it("renders nothing when closed", () => {
    render(
      <ComposioAppPicker open={false} onClose={jest.fn()} onConnect={jest.fn()} launching={null} connectedApps={new Set()} />,
    );
    expect(screen.queryByTestId("composio-app-picker")).not.toBeInTheDocument();
  });

  it("loads the catalog and connects an app on click", async () => {
    const onConnect = jest.fn();
    render(
      <ComposioAppPicker open onClose={jest.fn()} onConnect={onConnect} launching={null} connectedApps={new Set()} />,
    );
    await waitFor(() => expect(screen.getByTestId("composio-app-tile:gmail")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("composio-app-tile:notion"));
    expect(onConnect).toHaveBeenCalledWith("notion", "Notion");
  });

  it("filters the catalog by search", async () => {
    render(
      <ComposioAppPicker open onClose={jest.fn()} onConnect={jest.fn()} launching={null} connectedApps={new Set()} />,
    );
    await waitFor(() => expect(screen.getByTestId("composio-app-tile:gmail")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("composio-app-picker-search"), { target: { value: "stripe" } });
    expect(screen.getByTestId("composio-app-tile:stripe")).toBeInTheDocument();
    expect(screen.queryByTestId("composio-app-tile:gmail")).not.toBeInTheDocument();
  });

  it("badges apps passed in as connected", async () => {
    render(
      <ComposioAppPicker
        open
        onClose={jest.fn()}
        onConnect={jest.fn()}
        launching={null}
        connectedApps={new Set(["notion"])}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("composio-app-tile:notion")).toBeInTheDocument());
    expect(screen.getByTestId("composio-app-tile:notion")).toHaveAttribute("data-connected", "true");
    expect(screen.getByTestId("composio-app-tile:gmail")).toHaveAttribute("data-connected", "false");
  });

  it("gives the search a search keyboard, a 44px close and layers above the command panel sheet", async () => {
    render(
      <ComposioAppPicker open onClose={jest.fn()} onConnect={jest.fn()} launching={null} connectedApps={new Set()} />,
    );
    const search = await screen.findByTestId("composio-app-picker-search");
    expect(search).toHaveAttribute("type", "search");
    expect(search).toHaveAttribute("inputmode", "search");
    expect(search).toHaveAttribute("enterkeyhint", "search");
    expect(search).toHaveAttribute("autocapitalize", "none");
    expect(screen.getByTestId("composio-app-picker-close")).toHaveStyle({ width: "44px", height: "44px" });
    // The sheet sits at z-index 1001, so the picker it opens must clear it.
    expect(Number(screen.getByTestId("composio-app-picker").style.zIndex)).toBeGreaterThan(1001);
  });

  it("takes focus, keeps Tab inside and hands focus back to its trigger", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Connect apps";
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const view = render(
        <ComposioAppPicker open onClose={jest.fn()} onConnect={jest.fn()} launching={null} connectedApps={new Set()} />,
      );
      const search = await screen.findByTestId("composio-app-picker-search");
      await waitFor(() => expect(search).toHaveFocus());

      // Close is the first focusable, the Composio link the last: Tab wraps between them.
      const close = screen.getByTestId("composio-app-picker-close");
      const manage = screen.getByRole("link", { name: /manage or remove connections/i });
      manage.focus();
      fireEvent.keyDown(window, { key: "Tab" });
      expect(close).toHaveFocus();
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(manage).toHaveFocus();

      view.unmount();
      expect(trigger).toHaveFocus();
    } finally {
      trigger.remove();
    }
  });

  it("focuses the close button on touch so the soft keyboard stays down", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: jest.fn((query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener: jest.fn(), removeEventListener: jest.fn() })),
    });
    try {
      render(
        <ComposioAppPicker open onClose={jest.fn()} onConnect={jest.fn()} launching={null} connectedApps={new Set()} />,
      );
      const close = await screen.findByTestId("composio-app-picker-close");
      await waitFor(() => expect(close).toHaveFocus());
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia });
    }
  });

  it("closes on the X button", async () => {
    const onClose = jest.fn();
    render(
      <ComposioAppPicker open onClose={onClose} onConnect={jest.fn()} launching={null} connectedApps={new Set()} />,
    );
    await waitFor(() => expect(screen.getByTestId("composio-app-picker-close")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("composio-app-picker-close"));
    expect(onClose).toHaveBeenCalled();
  });
});
