/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { getAgent } from "@/lib/hivra/agent-catalog";

import WhyHivraEvolutionPage from "../evolution/page";
import WhyHivraPage from "../page";

jest.mock("node:fs", () => ({
  readFileSync: jest.fn(() => [
    "# Why I'm building Hivra",
    "",
    "I run agents every day.",
    "",
    "AI is finding zero-days on its own. [Read the research](https://example.com/research).",
    "",
    "Hivra is the practical part of that.",
  ].join("\n")),
}));

// react-markdown is ESM-only. This test exercises the page's source loading,
// framing and copy contract, so keep the complete markdown string visible.
jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="founder-markdown">{children}</div>
  ),
}));

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("@/components/StructuredData", () => function MockStructuredData() {
  return null;
});

jest.mock("@/components/layout/LandingHeader", () => function MockLandingHeader() {
  return <header data-testid="landing-header">Hivra</header>;
});

jest.mock("@/components/landing/Footer", () => function MockFooter() {
  return <footer data-testid="landing-footer">Footer</footer>;
});

describe("/why-hivra page", () => {
  it("publishes the founder note with the platform access clarification", () => {
    render(<WhyHivraPage />);

    expect(screen.getByTestId("landing-header")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(
      "Why I'm building Hivra",
    );
    expect(screen.getByTestId("landing-footer")).toBeInTheDocument();

    const markdown = screen.getByTestId("founder-markdown");
    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/public\/THOUGHTS\.md$/),
      "utf8",
    );
    expect(markdown).toHaveTextContent("# Why I'm building Hivra");
    expect(markdown).toHaveTextContent("I run agents every day.");
    expect(markdown).toHaveTextContent("The platform is Apache 2.0.");
    expect(markdown).toHaveTextContent("Self-hosting needs no token and no account");
    expect(markdown).toHaveTextContent("Hivra is the practical part of that.");
    expect(markdown).not.toHaveTextContent("What happens to $HermesOS?");
  });

  it("keeps the HermesOS transition details on the evolution page", () => {
    render(<WhyHivraEvolutionPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Why Hivra?" })).toBeInTheDocument();
    expect(screen.getByText("HermesOS started as a platform for deploying Hermes Agent.")).toBeInTheDocument();
    expect(screen.getByText("Existing deployments continue working.")).toBeInTheDocument();
    expect(screen.getByText("Existing accounts continue working.")).toBeInTheDocument();
    expect(screen.getByText("No action is required from current users.")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "What happens to $HermesOS?" })).toBeInTheDocument();
    expect(screen.getByText("Existing $HermesOS holders are grandfathered.")).toBeInTheDocument();
    expect(screen.getByText("You keep your access, and you can keep using $HermesOS.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "token page" })).toHaveAttribute("href", "/token");

    expect(screen.getAllByText("Hermes Agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("OpenClaw").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Aeon").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Make launching and operating AI agents as easy as launching a website.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /launch your first agent/i })).toHaveAttribute(
      "href",
      "/get-started?plan=free",
    );
  });

  it("describes the token migration as grandfathered $HermesOS plus a proposed $HIVRA, with no same-token claim", () => {
    const { container } = render(<WhyHivraEvolutionPage />);

    // The old copy said the token would never change, which contradicts the proposed migration.
    for (const stale of [/Same token\./, /Same contract\./, /The token is not\./, /A discount mechanism/, /settlement layer/]) {
      expect(container).not.toHaveTextContent(stale);
    }

    // Every statement about $HIVRA is labelled as a proposal.
    const hivraStatements = Array.from(container.querySelectorAll("p, li")).filter((node) =>
      node.textContent?.includes("$HIVRA"),
    );
    expect(hivraStatements.length).toBeGreaterThanOrEqual(4);
    for (const statement of hivraStatements) {
      expect(statement.textContent).toMatch(/propos/i);
    }

    // No price, return, scarcity or urgency language on the token.
    expect(container).not.toHaveTextContent(/price|return|profit|scarce|limited time|before it'?s too late|don'?t miss/i);
  });

  it("lists agents by their agent catalog availability", () => {
    render(<WhyHivraEvolutionPage />);
    const availableCard = screen.getByRole("heading", { level: 3, name: "Available now" }).closest("div")!;
    const previewCard = screen.getByRole("heading", { level: 3, name: "In preview" }).closest("div")!;
    for (const [id, label] of [
      ["hermes", "Hermes Agent"],
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["agent-zero", "Agent Zero"],
      ["openclaw", "OpenClaw"],
      ["aeon", "Aeon"],
      ["deepseek-harness", "DeepSeek"],
    ] as const) {
      const card = getAgent(id)?.available ? availableCard : previewCard;
      expect(within(card as HTMLElement).getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { level: 3, name: "Coming soon" })).not.toBeInTheDocument();
  });
});
