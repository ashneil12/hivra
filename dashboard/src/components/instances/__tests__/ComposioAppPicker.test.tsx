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
