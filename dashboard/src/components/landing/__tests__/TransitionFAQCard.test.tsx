/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import TransitionFAQCard from "../TransitionFAQCard";

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

describe("TransitionFAQCard", () => {
  it("answers the Hivra transition question and links to /why-hivra", () => {
    render(<TransitionFAQCard />);

    expect(screen.getByRole("heading", { name: "What happened to HermesOS?" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "HermesOS is evolving into Hivra as the platform expands beyond a single agent ecosystem. Existing deployments, accounts, and $HermesOS continue to operate normally."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /read the transition note/i })).toHaveAttribute("href", "/why-hivra");
  });
});
