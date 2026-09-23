/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TelegramConnect, type TelegramConnectAdapter, type TelegramConnectStatus } from "../TelegramConnect";

jest.mock("posthog-js", () => ({ __esModule: true, default: { capture: jest.fn() } }));
jest.mock("@/lib/channels/telegram-api", () => ({
  telegramGetMe: jest.fn().mockResolvedValue({ ok: true, username: "atlas_bot", botId: 7, error: null }),
  isValidBotTokenShape: () => true,
  isValidOwnerIdShape: (v: string) => /^\d{3,}$/.test(String(v).trim()),
}));
jest.mock("@/lib/channels/record-connection", () => ({ recordChannelConnection: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/client/logger", () => ({ clientLog: { warn: jest.fn(), error: jest.fn() } }));

function adapter(status: TelegramConnectStatus, overrides: Partial<TelegramConnectAdapter> = {}): TelegramConnectAdapter {
  return {
    target: { kind: "hivra", id: "box-1" },
    getStatus: jest.fn().mockResolvedValue(status),
    beginConnect: jest.fn().mockResolvedValue({ ok: true, botUsername: "atlas_bot", pairing: { kind: "code" }, error: null }),
    approveCode: jest.fn().mockResolvedValue({ ok: true, error: null }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("TelegramConnect", () => {
  it("asks before disconnecting the bot, and Cancel keeps the binding", async () => {
    const connected = adapter({ connected: true, active: true, ownerId: "42" });
    render(<TelegramConnect adapter={connected} agentName="Atlas" />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(connected.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText(/reconnecting needs a bot token from BotFather again/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Disconnect this bot" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect this bot" }));
    await waitFor(() => expect(connected.disconnect).toHaveBeenCalledTimes(1));
  });

  it("keeps the bot token and pairing code free of touch-keyboard autocorrection", async () => {
    const fresh = adapter({ connected: false, active: false, ownerId: null });
    render(<TelegramConnect adapter={fresh} />);

    const token = await screen.findByRole("textbox", { name: "Bot token" });
    expect(token).toHaveAttribute("autocapitalize", "none");
    expect(token).toHaveAttribute("autocorrect", "off");
    expect(token).toHaveAttribute("enterkeyhint", "go");

    fireEvent.change(token, { target: { value: "123456:SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    const code = await screen.findByRole("textbox", { name: "Pairing code" });
    expect(code).toHaveAttribute("autocapitalize", "characters");
    expect(code).toHaveAttribute("autocorrect", "off");
    expect(code).toHaveAttribute("enterkeyhint", "go");
  });
});
