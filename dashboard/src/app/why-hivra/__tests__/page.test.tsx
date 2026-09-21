/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import WhyHivraPage from "../page";

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
  it("explains the HermesOS to Hivra transition without making the token the page focus", () => {
    render(<WhyHivraPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Why Hivra?" })).toBeInTheDocument();
    expect(screen.getByText("HermesOS started as a platform for deploying Hermes Agent.")).toBeInTheDocument();
    expect(screen.getByText("Existing deployments continue working.")).toBeInTheDocument();
    expect(screen.getByText("Existing accounts continue working.")).toBeInTheDocument();
    expect(screen.getByText("No action is required from current users.")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "What happens to $HermesOS?" })).toBeInTheDocument();
    expect(screen.getByText("Same token.")).toBeInTheDocument();
    expect(screen.getByText("Same contract.")).toBeInTheDocument();
    expect(screen.getByText("Same ecosystem.")).toBeInTheDocument();

    expect(screen.getAllByText("Hermes Agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("OpenClaw").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("AEON").length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText("Make launching and operating AI agents as easy as launching a website.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /launch your first agent/i })).toHaveAttribute(
      "href",
      "/get-started?plan=free"
    );
  });
});
