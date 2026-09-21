/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { PendingPromptBadge } from "../PendingPromptBadge";

function chip(overrides = {}) {
  return {
    promptId: "call-a",
    kind: "approval" as const,
    summary: "rm -rf /x",
    surface: "gateway",
    createdAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("PendingPromptBadge", () => {
  it("renders nothing when there is no pending prompt", () => {
    const { container } = render(<PendingPromptBadge pendingPrompt={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders 'Needs approval' for an approval prompt", () => {
    render(<PendingPromptBadge pendingPrompt={chip()} />);
    expect(screen.getByTestId("pending-prompt-badge")).toHaveTextContent("Needs approval");
  });

  it("renders 'Needs your input' for a clarify prompt", () => {
    render(<PendingPromptBadge pendingPrompt={chip({ kind: "clarify" })} />);
    expect(screen.getByTestId("pending-prompt-badge")).toHaveTextContent("Needs your input");
  });

  it("uses the redacted summary as the tooltip", () => {
    render(<PendingPromptBadge pendingPrompt={chip({ summary: "drop table users" })} />);
    expect(screen.getByTestId("pending-prompt-badge")).toHaveAttribute("title", "drop table users");
  });

  it("falls back to a generic tooltip when summary is empty", () => {
    render(<PendingPromptBadge pendingPrompt={chip({ summary: null })} />);
    expect(screen.getByTestId("pending-prompt-badge")).toHaveAttribute(
      "title",
      "Your agent is waiting for your approval"
    );
  });
});
