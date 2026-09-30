/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ConnectDesktopModal } from "../ConnectDesktopModal";

jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: jest.fn().mockResolvedValue(true) }));

function mockPointer(coarse: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe("ConnectDesktopModal", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { gatewayUrl: "https://inst-1.example.com/desktop", token: "tok_secret", instanceName: "Atlas", ready: true },
      }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("on a phone, explains Desktop runs on a computer, leads with the copyable values and hides the file download", async () => {
    mockPointer(true);
    render(<ConnectDesktopModal instanceId="inst-1" onClose={jest.fn()} />);

    expect(await screen.findByText(/hermes desktop runs on your computer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /or download as a/i })).not.toBeInTheDocument();

    // Option B leads in the DOM, so screen readers meet it first too.
    const manual = screen.getByText(/option b · set it up yourself/i);
    const quick = screen.getByText(/option a · quick connect/i);
    expect(manual.compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Remote URL" })).toHaveStyle({ minHeight: "44px" });
  });

  it("on a computer, keeps the quick-connect download and no phone note", async () => {
    mockPointer(false);
    render(<ConnectDesktopModal instanceId="inst-1" onClose={jest.fn()} />);

    expect(await screen.findByRole("button", { name: /or download as a/i })).toBeInTheDocument();
    expect(screen.queryByText(/hermes desktop runs on your computer/i)).not.toBeInTheDocument();
    const quick = screen.getByText(/option a · quick connect/i);
    const manual = screen.getByText(/option b · set it up yourself/i);
    expect(quick.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes on a backdrop press, but not when a selection is dragged out of the card", async () => {
    mockPointer(false);
    const onClose = jest.fn();
    render(<ConnectDesktopModal instanceId="inst-1" onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Connect Hermes Desktop" });

    fireEvent.pointerDown(await screen.findByText("https://inst-1.example.com/desktop"));
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
