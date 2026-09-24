/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import UseCasesSection from "../UseCasesSection";

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

jest.mock("lucide-react", () => ({
  ArrowRight: () => <svg data-testid="icon-arrow-right" />,
  Terminal: () => <svg data-testid="icon-terminal" />,
  Brain: () => <svg data-testid="icon-brain" />,
  Clock: () => <svg data-testid="icon-clock" />,
  Server: () => <svg data-testid="icon-server" />,
}));

jest.mock("@/components/ui/animate-in", () => ({
  AnimateStaggerGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AnimateStaggerItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("UseCasesSection", () => {
  it("includes an independent computer use case and routes to the computer choices", () => {
    render(<UseCasesSection />);
    expect(screen.getByRole("heading", { name: "Use the app you need" })).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /choose a computer/i })).toHaveAttribute(
      "href",
      "#computers"
    );
  });

  // ATT-02 regression: the footer used to say "You don't have to attach an
  // agent at all", implying an agent can be attached to a computer later.
  it("says a computer runs without an agent and an agent gets its own computer", () => {
    render(<UseCasesSection />);
    expect(
      screen.getByText("A computer runs fine without an agent. Launch an agent and it gets a computer of its own.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/attach/i)).not.toBeInTheDocument();
  });
});
