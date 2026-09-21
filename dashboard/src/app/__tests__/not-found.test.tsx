/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import NotFound from "../not-found";

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

// The page reuses the public shell; stub the heavy client components so the test
// asserts the 404 content and that the shell is mounted, not their internals.
jest.mock("@/components/InteractiveBackground", () => {
  const Mock = () => <div data-testid="interactive-bg" />;
  Mock.displayName = "InteractiveBackground";
  return { __esModule: true, default: Mock };
});
jest.mock("@/components/layout/LandingHeader", () => {
  const Mock = () => <header data-testid="landing-header" />;
  Mock.displayName = "LandingHeader";
  return { __esModule: true, default: Mock };
});
jest.mock("@/components/landing/Footer", () => {
  const Mock = () => <footer data-testid="footer" />;
  Mock.displayName = "Footer";
  return { __esModule: true, default: Mock };
});
jest.mock("@/components/i18n/LocaleProvider", () => ({
  __esModule: true,
  LocaleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("app/not-found", () => {
  it("renders a branded 404 inside the Hivra shell with a working back-home link", () => {
    render(<NotFound />);

    expect(screen.getByText(/error 404/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: /wandered off/i }),
    ).toBeInTheDocument();

    // Public shell is mounted (header + footer).
    expect(screen.getByTestId("landing-header")).toBeInTheDocument();
    expect(screen.getByTestId("footer")).toBeInTheDocument();

    const home = screen.getByRole("link", { name: /back to hivra/i });
    expect(home).toHaveAttribute("href", "/");
  });
});
