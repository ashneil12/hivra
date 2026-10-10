/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InstanceChannelsPanel } from "../InstanceChannelsPanel";

jest.mock("@/components/ui/SafePortal", () => ({ SafePortal: ({ children }: { children: ReactNode }) => <>{children}</> }));
jest.mock("@/components/instances/InstanceChannelConnect", () => ({
  InstanceChannelConnect: ({ platform }: { platform: string }) => <div>connect flow: {platform}</div>,
}));
jest.mock("@/components/instances/InstanceTelegramConnect", () => ({
  InstanceTelegramConnect: () => <div>connect flow: Telegram</div>,
}));

const originalMatchMedia = window.matchMedia;
function setNarrow(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({
      matches: narrow && query === "(max-width: 639px)",
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
  });
}

beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: { statuses: {} } }) })) as unknown as typeof fetch;
});
afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia });
});

it("swaps the tile grid for the connect flow in place on phones instead of stacking a dialog", async () => {
  setNarrow(true);
  render(<InstanceChannelsPanel instanceId="inst-1" agentName="Atlas" />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());

  fireEvent.click(screen.getByTestId("channel-tile-Discord"));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByTestId("channel-connect-inline")).toHaveTextContent("connect flow: Discord");
  expect(screen.queryByTestId("channel-tile-Slack")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /all channels/i }));
  expect(screen.getByTestId("channel-tile-Slack")).toBeInTheDocument();
  await waitFor(() => expect((fetch as jest.Mock).mock.calls.length).toBeGreaterThan(1));
});

it("keeps focus on the inline flow's back control and returns it to the tile, never to <body>", async () => {
  setNarrow(true);
  render(<InstanceChannelsPanel instanceId="inst-1" agentName="Atlas" />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());

  const tile = screen.getByTestId("channel-tile-Discord");
  tile.focus();
  fireEvent.click(tile);

  const back = screen.getByRole("button", { name: /all channels/i });
  expect(back).toHaveFocus();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("channel-connect-inline")).not.toBeInTheDocument();
  expect(screen.getByTestId("channel-tile-Discord")).toHaveFocus();
});

it("keeps the connect dialog with a pinned 44px close on wider screens", async () => {
  setNarrow(false);
  render(<InstanceChannelsPanel instanceId="inst-1" agentName="Atlas" />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());

  fireEvent.click(screen.getByTestId("channel-tile-Discord"));

  const dialog = screen.getByRole("dialog", { name: "Connect Discord" });
  const close = screen.getByRole("button", { name: "Close" });
  expect(dialog).toContainElement(close);
  expect(close).toHaveStyle({ width: "44px", height: "44px" });
  fireEvent.click(close);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByTestId("channel-tile-Discord")).toHaveFocus();
  await waitFor(() => expect((fetch as jest.Mock).mock.calls.length).toBeGreaterThan(1));
});
