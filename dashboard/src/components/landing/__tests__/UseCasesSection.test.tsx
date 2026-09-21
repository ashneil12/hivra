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
});
