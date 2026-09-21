/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import FinalCTASection from "../FinalCTASection";

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
  AnimateIn: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("FinalCTASection", () => {
  it("offers the live free tier as the primary CTA and links a secondary path to pricing", () => {
    render(<FinalCTASection />);

    expect(screen.getByRole("heading", { level: 2, name: /ready to deploy/i })).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /start free/i })).toHaveAttribute(
      "href",
      "/get-started?plan=free"
    );

    expect(screen.getByRole("link", { name: /see pricing/i })).toHaveAttribute("href", "#pricing");

    expect(screen.getByText(/Free tier is live/i)).toBeInTheDocument();
    expect(screen.queryByText(/free compute/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/One reservation per email/i)).not.toBeInTheDocument();
    expect(screen.getByText(/higher-risk signups may need a card-on-file check/i)).toBeInTheDocument();
  });
});
