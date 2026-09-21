/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import HowItWorksSection from "../HowItWorksSection";

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
}));

jest.mock("@/components/ui/animate-in", () => ({
  AnimateStaggerGroup: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="animate-stagger-group" className={className}>
      {children}
    </div>
  ),
  AnimateStaggerItem: ({
    children,
    style,
  }: {
    children: React.ReactNode;
    style?: React.CSSProperties;
  }) => (
    <div data-testid="animate-stagger-item" style={style}>
      {children}
    </div>
  ),
}));

describe("HowItWorksSection", () => {
  it("shows the four launch decisions, including review before launch", () => {
    const { container } = render(<HowItWorksSection />);

    const section = container.querySelector("#how-it-works");
    expect(section).not.toBeNull();
    expect(screen.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual([
      "Pick an agent or an operating system", "Pick where it runs", "See the price, the resources and the access", "Open it and start working",
    ]);
    expect(screen.getByRole("link", { name: /choose your starting point/i })).toHaveAttribute("href", "/dashboard/launch?start=1");
  });
});
