/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InboxAnswer } from "../InboxAnswer";
import type { InboxPrompt } from "@/lib/agent-inbox/types";

const prompt = (overrides: Partial<InboxPrompt> = {}): InboxPrompt => ({
  promptId: "req-1", kind: "approval", summary: "Delete the old build files", command: "rm -rf dist",
  commandComplete: true, choices: ["once", "session", "always", "deny"], createdAt: "2026-11-12T12:00:00Z",
  expiresAt: "2026-11-12T12:05:00Z", answerable: true, answeredChoice: null, ...overrides,
});
const NOW = Date.parse("2026-11-12T12:01:00Z");

function renderCard(p = prompt(), onAnswered = jest.fn()) {
  render(<InboxAnswer agentId="agent-1" agentName="Hermes 1" chatHref="/dashboard/agent/agent-1" prompt={p} onAnswered={onAnswered} now={NOW} />);
  return onAnswered;
}

describe("InboxAnswer", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("shows the command and allows it once", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    const onAnswered = renderCard();
    expect(screen.getByText("rm -rf dist")).toBeInTheDocument();
    expect(screen.getByText("4 min left")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(screen.getByTestId("inbox-answer-sent")).toHaveTextContent("Allowed once."));
    expect(fetchMock).toHaveBeenCalledWith("/api/hivra/agents/agent-1/prompts/req-1/answer",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ choice: "once" }) }));
    expect(onAnswered).toHaveBeenCalled();
  });

  it("sends a no with the reason", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Don't allow" }));
    fireEvent.change(screen.getByLabelText(/Tell it why/), { target: { value: "Keep the cache" } });
    fireEvent.click(screen.getByRole("button", { name: "Send no" }));
    await waitFor(() => expect(screen.getByTestId("inbox-answer-sent")).toHaveTextContent("Not allowed."));
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ choice: "deny", text: "Keep the cache" }));
  });

  it("asks before always allowing", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Always allow commands like this/ }));
    expect(screen.getByText(/stop asking for commands like this/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(screen.getByTestId("inbox-answer-sent")).toHaveTextContent("Always allowed."));
  });

  it("only offers no and the chat when the command is cut short", () => {
    renderCard(prompt({ commandComplete: false }));
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open chat to review" })).toHaveAttribute("href", "/dashboard/agent/agent-1");
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeInTheDocument();
  });

  it("hides choices Hermes did not offer", () => {
    renderCard(prompt({ choices: ["once", "deny"] }));
    expect(screen.queryByRole("button", { name: "Allow for this chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Always allow/ })).toBeNull();
  });

  it("opens the chat for a question", () => {
    renderCard(prompt({ kind: "clarify", summary: "Last month or last 90 days?", command: null, choices: [], answerable: false }));
    expect(screen.getByText("Last month or last 90 days?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open chat to answer" })).toBeInTheDocument();
  });

  it("shows Hivra's message when the answer is refused", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ success: false, error: "Your agent stopped waiting for this one." }) });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your agent stopped waiting for this one.");
  });
});
