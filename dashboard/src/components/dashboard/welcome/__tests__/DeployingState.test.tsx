/** @jest-environment jsdom */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { DeployingState } from "../DeployingState";

jest.mock("@/components/ui/animate-in", () => ({
  AnimateIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("DeployingState", () => {
  it("uses a dense provisioning shell instead of a tiny centered loader", () => {
    render(<DeployingState />);

    const status = screen.getByRole("status", { name: /setting up your agent/i });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveStyle({
      display: "grid",
      borderRadius: "0",
    });

    const shellMarkup = status.outerHTML;
    expect(shellMarkup).not.toContain("45, 212, 191");
    expect(shellMarkup).not.toContain("22, 20, 31");
    expect(shellMarkup).not.toContain("border-radius: 8px");
    expect(shellMarkup).not.toContain("linear-gradient");
    expect(shellMarkup).not.toContain("backdrop-filter");

    expect(screen.getByText("What's included")).toBeInTheDocument();
    expect(screen.getByText("Secure by default")).toBeInTheDocument();
    expect(screen.getByText("Computer")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("Elapsed")).toBeInTheDocument();
    expect(screen.getAllByText("2-4 min")).toHaveLength(2);
    expect(screen.getAllByTestId("deploying-included-item")).toHaveLength(4);
    expect(screen.queryByText(/live setup feed/i)).not.toBeInTheDocument();
  });

  // Track W (web dejargonization): every user-facing string is consumer
  // language — the infra vocabulary that used to brag here is banned.
  it("speaks consumer language — no infra jargon anywhere on the wait screen", () => {
    render(<DeployingState agentName="Bea" />);

    // Name-personalized copy.
    expect(screen.getByText(/Getting Bea ready/i)).toBeInTheDocument();
    expect(screen.getByText(/A private computer for Bea/i)).toBeInTheDocument();
    expect(screen.getByText(/Bea's skills/i)).toBeInTheDocument();
    expect(screen.getByText(/A first hello from Bea/i)).toBeInTheDocument();
    expect(screen.getByText(/A private computer just for Bea/i)).toBeInTheDocument();
    expect(screen.getByText(/typically takes 2-4 minutes/i)).toBeInTheDocument();

    // The old jargon must be gone.
    const markup = screen.getByRole("status", { name: /setting up your agent/i }).outerHTML;
    for (const banned of [
      "Allocating compute",
      "host capacity",
      "persistent storage",
      "Caddy",
      "bearer",
      "credentials",
      "gateway",
      "runtime",
      "WebUI",
      "Provisioning",
      "VM",
      "TLS",
      "health checks",
      "API key",
    ]) {
      expect(markup).not.toContain(banned);
    }
  });

  it("falls back to a generic subject when no agent name is provided", () => {
    render(<DeployingState />);

    expect(screen.getByText(/Getting your agent ready/i)).toBeInTheDocument();
    expect(screen.getByText(/A private computer for your agent/i)).toBeInTheDocument();
    expect(screen.getByText(/your agent's skills/i)).toBeInTheDocument();
  });

  // F7 regression: the provision POST is one opaque call, so this screen used
  // to advance its steps on 13s/31s/49s timers and caption them "Each step
  // happens live while you wait." It must show an honest pending state instead.
  describe("honest pending state", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("says the request is pending, not installation progress", () => {
      render(<DeployingState agentName="Bea" />);

      const status = screen.getByRole("status", { name: /setting up your agent/i });
      expect(status).toHaveTextContent(/Hivra is creating Bea's computer/i);
      expect(status).toHaveTextContent(/pending request, not installation progress/i);
      expect(status).toHaveTextContent(/Nothing is shown as done until Hivra confirms it/i);
      expect(status).not.toHaveTextContent(/happens live/i);
    });

    it("never marks a part active or done, however long the request takes", () => {
      jest.useFakeTimers();
      const { container } = render(<DeployingState agentName="Bea" />);
      const itemsMarkup = () =>
        screen.getAllByTestId("deploying-included-item").map((item) => item.outerHTML);
      const before = itemsMarkup();

      // Past every old step deadline (13s, 31s, 49s) and then some.
      act(() => {
        jest.advanceTimersByTime(90_000);
      });

      expect(itemsMarkup()).toEqual(before);
      expect(container.querySelector("[data-step-status]")).toBeNull();
      // The elapsed clock is real observed time and still ticks.
      expect(screen.getByText("01:30")).toBeInTheDocument();
    });

    it("drops the unsubstantiated end-to-end encryption claim", () => {
      render(<DeployingState agentName="Bea" />);

      const markup = screen.getByRole("status", { name: /setting up your agent/i }).textContent ?? "";
      expect(markup).not.toMatch(/encrypt/i);
      expect(markup).not.toMatch(/end to end/i);
    });
  });

  it("no longer shows the deploy-card personalization form (onboarding is conversational now)", () => {
    // Direction: the agent runs a conversational 'who am I / who are you' ritual
    // on first contact (seeded into SOUL.md at provision), so the deploy card no
    // longer collects goal/context/first-task. See onboarding-ritual.ts.
    render(<DeployingState />);

    expect(screen.queryByText("While you wait")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Focus")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Context")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("First task")).not.toBeInTheDocument();
  });

  it("opens at the top of the page instead of the deploy form's scroll offset", () => {
    const main = document.body.appendChild(document.createElement("main"));
    let assignedScrollTop: number | null = null;
    Object.defineProperty(main, "scrollTop", {
      configurable: true,
      get: () => 900,
      set: (value: number) => { assignedScrollTop = value; },
    });
    const rect = jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const top = this.tagName === "MAIN" ? 56 : this.getAttribute("aria-label") === "Setting up your agent" ? -600 : 0;
      return { top } as DOMRect;
    });

    render(<DeployingState agentName="MY_FIRST_AGENT" />, { container: main.appendChild(document.createElement("div")) });

    expect(assignedScrollTop).toBe(0);
    rect.mockRestore();
    main.remove();
  });
});
