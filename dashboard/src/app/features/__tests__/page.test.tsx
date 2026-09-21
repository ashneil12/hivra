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
    expect(screen.getByText("Multi-agent coordination")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see pricing/i })).toHaveAttribute("href", "/#pricing");
  });
});
