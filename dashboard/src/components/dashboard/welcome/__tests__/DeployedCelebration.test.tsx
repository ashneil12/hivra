/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { DeployedCelebration } from "@/components/dashboard/welcome/DeployedCelebration";

// No instanceId → the readiness poll is skipped, so this renders the booting
// beat synchronously with no network.
describe("DeployedCelebration persona emoji", () => {
  it("shows the persona emoji beside the name", () => {
    render(<DeployedCelebration agentName="Pike" emoji="🛠️" onContinue={() => {}} />);
    expect(screen.getByText("🛠️ Pike")).toBeInTheDocument();
  });

  it("falls back to just the name when no emoji is set", () => {
    render(<DeployedCelebration agentName="Pike" onContinue={() => {}} />);
    expect(screen.getByText("Pike")).toBeInTheDocument();
  });
});

// F18 regression: once the workspace is live, the primary action used to be
// "Connect Telegram" with chatting demoted to "Skip for now". Starting a chat
// is the primary action; Telegram is an optional secondary one.
describe("DeployedCelebration live actions", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://box.example/login" }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("makes Start chatting the primary action and Telegram secondary", async () => {
    const onContinue = jest.fn();
    const onConnectTelegram = jest.fn();
    render(
      <DeployedCelebration
        agentName="Pike"
        instanceId="inst-1"
        onContinue={onContinue}
        onConnectTelegram={onConnectTelegram}
      />,
    );

    const startChatting = await screen.findByRole("button", { name: /start chatting/i });
    const telegram = screen.getByRole("button", { name: /also chat from telegram/i });
    const actions = screen.getAllByRole("button");
    // Primary comes first in the action stack.
    expect(actions.indexOf(startChatting)).toBeLessThan(actions.indexOf(telegram));
    expect(screen.queryByRole("button", { name: /^connect telegram$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /skip for now/i })).not.toBeInTheDocument();

    fireEvent.click(startChatting);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onConnectTelegram).not.toHaveBeenCalled();

    fireEvent.click(telegram);
    expect(onConnectTelegram).toHaveBeenCalledTimes(1);
  });

  it("offers Start chatting alone when there is no Telegram handler", async () => {
    const onContinue = jest.fn();
    render(<DeployedCelebration agentName="Pike" instanceId="inst-1" onContinue={onContinue} />);

    fireEvent.click(await screen.findByRole("button", { name: /start chatting/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /telegram/i })).not.toBeInTheDocument();
  });
});
