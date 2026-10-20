/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import FeaturesPage from "../page";

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

describe("/features page", () => {
  it("frames the page with an above-the-fold feature summary and clear next step", () => {
    render(<FeaturesPage />);

    expect(screen.getByText("What you get on day one")).toBeInTheDocument();
    expect(screen.getByText("Persistent memory")).toBeInTheDocument();
    expect(screen.getByText("Browser automation")).toBeInTheDocument();
    expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    // Agents run side by side; built-in orchestration is not shipped, so the
    // summary names "multiple agents", not coordination.
    expect(screen.getByText("Multiple agents")).toBeInTheDocument();
    expect(screen.queryByText(/multi-agent coordination/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see pricing/i })).toHaveAttribute("href", "/pricing");
  });

  it("words the persistent memory summary and card as the website pack does", () => {
    render(<FeaturesPage />);

    expect(
      screen.getByText(
        "Your agent can keep its saved memory across sessions, so you can carry on from earlier work instead of setting everything up again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Keep context between sessions" })).toBeInTheDocument();
    expect(screen.queryByText(/Your agent remembers what you told it/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "Your agent remembers from one session to the next." })).not.toBeInTheDocument();
  });
});
