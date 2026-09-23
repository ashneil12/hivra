/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import RootError from "../error";

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

jest.mock("@/components/InteractiveBackground", () => {
  const Mock = () => <div data-testid="interactive-bg" />;
  Mock.displayName = "InteractiveBackground";
  return { __esModule: true, default: Mock };
});
jest.mock("@/components/layout/LandingHeader", () => {
  const Mock = () => <header data-testid="landing-header" />;
  Mock.displayName = "LandingHeader";
  // The recovery link is the real signed-in-aware link; only the header is stubbed.
  const { HomeOrDashboardLink } = jest.requireActual("@/components/layout/LandingHeader");
  return { __esModule: true, default: Mock, HomeOrDashboardLink };
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

describe("app/error", () => {
  afterEach(() => {
    document.cookie = "__client_uat=; Max-Age=0; path=/";
  });

  it("renders the branded error shell with a back-home link", () => {
    render(<RootError error={new Error("boom")} reset={jest.fn()} />);

    expect(
      screen.getByRole("heading", { level: 1, name: /hit a snag/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("landing-header")).toBeInTheDocument();
    expect(screen.getByTestId("footer")).toBeInTheDocument();

    const home = screen.getByRole("link", { name: /back to hivra/i });
    expect(home).toHaveAttribute("href", "/");
  });

  it("offers signed-in visitors the dashboard instead of the homepage", () => {
    document.cookie = "__client_uat=1758000000; path=/";
    render(<RootError error={new Error("boom")} reset={jest.fn()} />);

    expect(screen.getByRole("link", { name: /open dashboard/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.queryByRole("link", { name: /back to hivra/i })).not.toBeInTheDocument();
  });

  it("calls reset() when 'Try again' is clicked", () => {
    const reset = jest.fn();
    render(<RootError error={new Error("boom")} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
