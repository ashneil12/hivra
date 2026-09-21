/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import posthog from "posthog-js";

import { ChannelConnectNudge } from "../ChannelConnectNudge";
import { telegramStatus } from "@/lib/hivra/agent-api";

const mockSearchGet = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockSearchGet }),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  telegramStatus: jest.fn(),
}));

const NUDGE_COPY = /your agent can reach you when work is done/i;

function renderNudge(onConnect = jest.fn()) {
  return {
    onConnect,
    ...render(
      <ChannelConnectNudge
        boxUrl="https://box.example.com"
        token="box-token"
        boxId="box-1"
        onConnect={onConnect}
      />,
    ),
  };
}

describe("ChannelConnectNudge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    (telegramStatus as jest.Mock).mockResolvedValue({ connected: false, active: false, ownerId: null });
  });

  it("shows on a fresh welcome landing when Telegram is not connected, and captures shown once", async () => {
    renderNudge();

    expect(await screen.findByText(NUDGE_COPY)).toBeInTheDocument();
    expect(telegramStatus).toHaveBeenCalledWith("https://box.example.com", "box-token");
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("channel_connect_nudge_shown", {
      channel: "telegram",
      box_id: "box-1",
    });
  });

  it("does not render (or probe) without the welcome param", async () => {
    mockSearchGet.mockReturnValue(null);

    renderNudge();

    await waitFor(() => expect(telegramStatus).not.toHaveBeenCalled());
    expect(screen.queryByText(NUDGE_COPY)).not.toBeInTheDocument();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("does not render when Telegram is already connected", async () => {
    (telegramStatus as jest.Mock).mockResolvedValue({ connected: true, active: true, ownerId: "1" });

    renderNudge();

    await waitFor(() => expect(telegramStatus).toHaveBeenCalled());
    expect(screen.queryByText(NUDGE_COPY)).not.toBeInTheDocument();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("routes the connect click to the Telegram tab and captures it", async () => {
    const { onConnect } = renderNudge();

    fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("channel_connect_nudge_clicked", {
      channel: "telegram",
      box_id: "box-1",
    });
  });

  it("dismiss hides the banner, persists per box, and survives remount", async () => {
    const { unmount } = renderNudge();

    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));

    expect(screen.queryByText(NUDGE_COPY)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hermes:channel_nudge_dismissed:box-1")).toBe("1");
    expect(posthog.capture).toHaveBeenCalledWith("channel_connect_nudge_dismissed", {
      channel: "telegram",
      box_id: "box-1",
    });

    unmount();
    (telegramStatus as jest.Mock).mockClear();
    renderNudge();

    // Dismissed boxes are never probed again and never re-show.
    await waitFor(() => expect(telegramStatus).not.toHaveBeenCalled());
    expect(screen.queryByText(NUDGE_COPY)).not.toBeInTheDocument();
  });
});
