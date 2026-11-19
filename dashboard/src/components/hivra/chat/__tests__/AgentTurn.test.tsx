/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { AgentTurn } from "../AgentTurn";
import type { ChatMessage } from "../types";

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("react-syntax-highlighter/dist/esm/prism-async-light", () => ({ __esModule: true, default: ({ children }: { children: string }) => <pre>{children}</pre> }));
jest.mock("@/components/markdown/prism-languages", () => ({ prismLanguage: (name: string) => name }));
jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: jest.fn().mockResolvedValue(true) }));

const turn = (m: ChatMessage, extra: Partial<React.ComponentProps<typeof AgentTurn>> = {}) =>
  render(<AgentTurn m={m} index={1} agentName="Atlas" emoji="🧭" historySessionId={null} onRate={jest.fn()} onOpenHistory={jest.fn()} {...extra} />);

describe("AgentTurn", () => {
  it("shows the owner's message as a bubble, with no avatar and no YOU", () => {
    const { container } = turn({ role: "user", text: "Plan my week", tools: [] });
    expect(screen.getByText("Plan my week")).toBeInTheDocument();
    expect(screen.queryByText(/^you$/i)).not.toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
  });

  it("opens the agent's turn with a chip of its emoji and name, above the reply", () => {
    turn({ role: "assistant", text: "Here is the plan.", tools: [] });
    const chip = screen.getByText("Atlas");
    expect(chip).toBeInTheDocument();
    expect(screen.getByText("🧭")).toBeInTheDocument();
    expect(chip.compareDocumentPosition(screen.getByText("Here is the plan.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("falls back to the agent's initial when it has no emoji", () => {
    turn({ role: "assistant", text: "Hi", tools: [] }, { emoji: null });
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("gives a finished reply icon-only copy and feedback buttons that report the rating", () => {
    const onRate = jest.fn();
    turn({ role: "assistant", text: "Done.", tools: [] }, { onRate });
    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(copy).not.toHaveTextContent(/\S/);
    fireEvent.click(screen.getByRole("button", { name: "Good response" }));
    expect(onRate).toHaveBeenCalledWith(1, "up");
    expect(screen.getByRole("button", { name: "Bad response" })).toHaveAttribute("aria-pressed", "false");
  });

  it("offers no actions while a reply is still streaming, and shows the live step", () => {
    turn({ role: "assistant", text: "Working on", tools: [], streaming: true });
    expect(screen.queryByRole("button", { name: "Copy message" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Writing");
  });

  it.each([
    ["stopped", "Response stopped", "Stopped"],
    ["error", "Response failed", "Could not complete response"],
    ["disconnected", "Reconnecting to the agent", /Connection lost/],
  ] as const)("keeps a calm status line for a %s reply", (outcome, label, text) => {
    turn({ role: "assistant", text: "Partial", tools: [], outcome });
    expect(within(screen.getByRole("status", { name: label })).getByText(text)).toBeInTheDocument();
  });
});
