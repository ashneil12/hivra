/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
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

    expect(screen.getByText("What's happening")).toBeInTheDocument();
    expect(screen.getByText("Secure by default")).toBeInTheDocument();
    expect(screen.getByText("Computer")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("Elapsed")).toBeInTheDocument();
    expect(screen.getAllByText("2-4 min")).toHaveLength(2);
    expect(screen.getAllByTestId("deploying-step")).toHaveLength(4);
    expect(screen.queryByText(/live setup feed/i)).not.toBeInTheDocument();
  });

  // Track W (web dejargonization): every user-facing string is consumer
  // language — the infra vocabulary that used to brag here is banned.
  it("speaks consumer language — no infra jargon anywhere on the wait screen", () => {
    render(<DeployingState agentName="Bea" />);

    // Name-personalized copy.
    expect(screen.getByText(/Getting Bea ready/i)).toBeInTheDocument();
    expect(screen.getByText(/Setting up Bea's computer/i)).toBeInTheDocument();
    expect(screen.getByText(/Installing Bea's skills/i)).toBeInTheDocument();
    expect(screen.getByText(/Waking Bea up/i)).toBeInTheDocument();
    expect(screen.getByText(/A private computer just for Bea/i)).toBeInTheDocument();
    expect(screen.getByText(/Encrypted end to end/i)).toBeInTheDocument();
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
    expect(screen.getByText(/Setting up your agent's computer/i)).toBeInTheDocument();
    expect(screen.getByText(/Installing your agent's skills/i)).toBeInTheDocument();
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
});
