/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { AgentUsageSummary } from "../AgentUsageSummary";

describe("AgentUsageSummary", () => {
  it("shows the whole top model name on its own row, not an ellipsis", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          days: 7,
          sessions: 12,
          apiCalls: 40,
          toolCalls: 1200,
          totalTokens: 3_400_000,
          estimatedCostUsd: 1.2,
          activeDays: 3,
          lastActiveDate: "2026-09-22",
          topModel: "anthropic/claude-sonnet-4-5-20250929",
          isEmpty: false,
        },
      }),
    });
    render(<AgentUsageSummary instanceId="inst-1" />);

    const model = await screen.findByText("claude-sonnet-4-5-20250929");
    expect(model).toHaveAttribute("title", "anthropic/claude-sonnet-4-5-20250929");
    expect(model).toHaveStyle({ overflowWrap: "anywhere" });
    expect(model).not.toHaveStyle({ whiteSpace: "nowrap" });
    // The counts keep their own row; the model stat is not inside it.
    const counts = screen.getByText("12").closest("div")?.parentElement;
    expect(counts).not.toContainElement(model);
    expect(screen.getByText("top model")).toBeInTheDocument();
  });
});
