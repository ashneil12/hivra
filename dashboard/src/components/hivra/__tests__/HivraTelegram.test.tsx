/** @jest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import posthog from "posthog-js";

import { HivraTelegram } from "../HivraTelegram";
import { telegramConnect, telegramDisconnect, telegramStatus } from "@/lib/hivra/agent-api";
import { telegramGetMe } from "@/lib/channels/telegram-api";
import { recordChannelConnection } from "@/lib/channels/record-connection";

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { capture: jest.fn() },
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  telegramStatus: jest.fn(),
  telegramConnect: jest.fn(),
  telegramDisconnect: jest.fn(),
}));

jest.mock("@/lib/channels/telegram-api", () => ({
  telegramGetMe: jest.fn(),
  telegramStartLink: (u: string, payload: string) => `https://t.me/${u}?start=${encodeURIComponent(payload)}`,
  isValidBotTokenShape: () => true,
  isValidOwnerIdShape: (v: string) => /^\d{3,}$/.test(String(v).trim()),
}));

jest.mock("@/lib/channels/record-connection", () => ({
  recordChannelConnection: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: { warn: jest.fn() },
}));

describe("HivraTelegram (deeplink pairing)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (telegramStatus as jest.Mock).mockResolvedValue({ connected: false, active: false, ownerId: null });
    (telegramDisconnect as jest.Mock).mockResolvedValue(undefined);
    (telegramGetMe as jest.Mock).mockResolvedValue({ ok: true, username: "atlas_bot", botId: 7, error: null });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function pasteTokenAndContinue() {
    fireEvent.change(await screen.findByPlaceholderText("123456789:ABCdef…"), {
      target: { value: "123456:SECRET" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  }

  it("renders the deeplink step with the setup-token URL once the box provisions pairing", async () => {
    (telegramConnect as jest.Mock).mockResolvedValue({
      ok: true,
      botUsername: "atlas_bot",
      setupToken: "TOKEN-abc_123",
      error: null,
    });

    render(<HivraTelegram boxUrl="https://box.example.com" boxId="agent-7" token="box-token" agentName="Atlas" />);

    await pasteTokenAndContinue();

    // beginConnect → telegramConnect with NO ownerId (modern setup-token mode).
    await waitFor(() => {
      expect(telegramConnect).toHaveBeenCalledWith("https://box.example.com", "123456:SECRET", null, "box-token");
    });

    // Deeplink button uses the bot username + the URL-encoded setup token.
    const link = await screen.findByRole("link", { name: /open @atlas_bot/i });
    expect(link).toHaveAttribute("href", "https://t.me/atlas_bot?start=TOKEN-abc_123");
    expect(screen.getByText(/Waiting for you to tap Start/i)).toBeInTheDocument();
  });

  it("flips to connected when getStatus reports bound after polling", async () => {
    (telegramConnect as jest.Mock).mockResolvedValue({
      ok: true,
      botUsername: "atlas_bot",
      setupToken: "TOK",
      error: null,
    });
    // 1st poll (refresh on mount) → not bound; 2nd poll (post-connect refresh)
    // → still not bound; 3rd poll (polling loop) → bound.
    (telegramStatus as jest.Mock)
      .mockResolvedValueOnce({ connected: false, active: false, ownerId: null })
      .mockResolvedValueOnce({ connected: false, active: false, ownerId: null })
      .mockResolvedValue({ connected: true, active: true, ownerId: "555111" });

    render(<HivraTelegram boxUrl="https://box.example.com" boxId="agent-7" token="box-token" agentName="Atlas" />);
    await pasteTokenAndContinue();
    await screen.findByRole("link", { name: /open @atlas_bot/i });

    // Advance the polling loop (component polls every 2s; we drain a few ticks).
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(posthog.capture).toHaveBeenCalledWith(
        "channel_paired",
        expect.objectContaining({ channel: "telegram", box_id: "agent-7", target_kind: "hivra", method: "deeplink" }),
      );
    });
    expect(posthog.capture).toHaveBeenCalledWith("channel_connected", {
      channel: "telegram",
      box_id: "agent-7",
      target_kind: "hivra",
    });
    expect(recordChannelConnection).toHaveBeenCalledWith({
      channel: "telegram",
      targetKind: "hivra",
      targetId: "agent-7",
    });
  });

  it("surfaces a clear error when the box doesn't return a setup token (old image)", async () => {
    (telegramConnect as jest.Mock).mockResolvedValue({
      ok: true,
      botUsername: "atlas_bot",
      setupToken: null,
      error: null,
    });

    render(<HivraTelegram boxUrl="https://box.example.com" boxId="agent-8" token="box-token" agentName="Atlas" />);
    await pasteTokenAndContinue();

    expect(await screen.findByText(/doesn't support the pairing deeplink/i)).toBeInTheDocument();
    expect(posthog.capture).toHaveBeenCalledWith(
      "channel_connect_failed",
      expect.objectContaining({ channel: "telegram", box_id: "agent-8", target_kind: "hivra" }),
    );
  });

  it("manual fallback writes ownerId directly (pre-pairing-runtime path)", async () => {
    // First call (beginConnect) reports "no setup token" — common on an old
    // image; the user opens the advanced disclosure and pastes their id.
    (telegramConnect as jest.Mock)
      .mockResolvedValueOnce({ ok: true, botUsername: "atlas_bot", setupToken: null, error: null })
      .mockResolvedValueOnce({ ok: true, botUsername: "atlas_bot", setupToken: null, error: null });

    render(<HivraTelegram boxUrl="https://box.example.com" boxId="agent-9" token="box-token" agentName="Atlas" />);
    await pasteTokenAndContinue();

    // Disclose advanced manual entry.
    fireEvent.click(await screen.findByRole("button", { name: /advanced.*paste your telegram id/i }));
    const idInput = await screen.findByPlaceholderText("123456789");
    fireEvent.change(idInput, { target: { value: "555111" } });
    fireEvent.click(screen.getByRole("button", { name: /connect telegram/i }));

    await waitFor(() => {
      expect(telegramConnect).toHaveBeenLastCalledWith("https://box.example.com", "123456:SECRET", "555111", "box-token");
    });
    expect(posthog.capture).toHaveBeenCalledWith("channel_owner_captured", {
      channel: "telegram",
      box_id: "agent-9",
      target_kind: "hivra",
      method: "manual",
    });
  });
});
