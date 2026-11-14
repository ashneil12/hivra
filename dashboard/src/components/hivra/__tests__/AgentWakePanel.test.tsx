/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentWakePanel, WokeUpNote } from "../AgentWakePanel";
import { formatWakeSeconds } from "../useAgentWake";

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));

describe("AgentWakePanel", () => {
  it("reads as a short wait, in plain words", () => {
    const { container } = render(<AgentWakePanel name="Atlas" failure={null} onRetry={jest.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Waking up your agent");
    expect(screen.getByText(/Atlas was resting while nobody used it/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[-–—]/);
  });

  it("says when the wake did not work and offers another try", () => {
    const onRetry = jest.fn();
    render(<AgentWakePanel name="Atlas" failure="Could not wake." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your agent could not wake up");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not wake.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says the agent is napping, and does not say it is waking, while the page holds it asleep", () => {
    const onRetry = jest.fn();
    const { container, rerender } = render(<AgentWakePanel name="Atlas" failure={null} onRetry={onRetry} resting="idle" />);
    expect(screen.getByRole("status")).toHaveTextContent("Your agent is napping");
    expect(screen.queryByText("Waking up your agent")).not.toBeInTheDocument();
    expect(screen.getByText(/Atlas napped while nobody was using it/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Wake it up" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<AgentWakePanel name="Atlas" failure={null} onRetry={onRetry} resting="manual" />);
    expect(screen.getByText(/You put Atlas to sleep for a test/)).toBeVisible();
    expect(container.textContent).not.toMatch(/[-–—]/);
  });

  it("tells how long the wake took", () => {
    render(<WokeUpNote ms={1400} />);
    expect(screen.getByRole("status")).toHaveTextContent("Woke up in 1.4 s");
  });
});

describe("formatWakeSeconds", () => {
  it("shows tenths under ten seconds and whole seconds after", () => {
    expect(formatWakeSeconds(1400)).toBe("1.4 s");
    expect(formatWakeSeconds(0)).toBe("0.0 s");
    expect(formatWakeSeconds(9949)).toBe("9.9 s");
    expect(formatWakeSeconds(12_400)).toBe("12 s");
    expect(formatWakeSeconds(-5)).toBe("0.0 s");
  });
});
