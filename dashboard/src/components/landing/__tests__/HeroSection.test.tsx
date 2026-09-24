/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import HeroSection from "../HeroSection";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";

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
  ChevronDown: () => <svg data-testid="icon-chevron-down" />,
  Download: () => <svg data-testid="icon-download" />,
  Lock: () => <svg data-testid="icon-lock" />,
  Shield: () => <svg data-testid="icon-shield" />,
  Zap: () => <svg data-testid="icon-zap" />,
}));

jest.mock("@/components/ui/animate-in", () => ({
  AnimateIn: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="animate-in">{children}</div>
  ),
}));

describe("HeroSection", () => {
  it("offers agent launch and app downloads with explicit availability", () => {
    render(<HeroSection />);

    // The English display follows the final litepaper; localized headings remain intact.
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /your agent needs a computer\. it doesn.t need yours/i,
      })
    ).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /launch an agent/i })).toHaveAttribute(
      "href",
      "/dashboard/launch?kind=agent&start=1"
    );
    expect(
      screen.getByRole("link", {
        name: /why i.m building Hivra/i,
      })
    ).toHaveAttribute("href", "#founder");
    expect(screen.getByRole("link", { name: /Download the app/i })).toHaveAttribute("href", "/download");
    expect(screen.getByText(/The Mac app is coming soon/)).toBeVisible();
    // No Windows desktop app exists, so the hero must not promise one.
    expect(screen.queryByText(/Windows apps? (is|are) coming soon/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Explore the ecosystem/i })).toHaveAttribute("href", "/ecosystem");

    expect(screen.queryByRole("link", { name: /launch a computer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Ubuntu now, with Windows and Omarchy in private preview/)).toBeInTheDocument();
    expect(screen.queryByText(/no terminals/i)).not.toBeInTheDocument();
  });

  it("gives phones a computer-first secondary action instead of pending desktop installers", () => {
    render(<HeroSection />);
    // CSS shows this link only at phone widths, where Download the app is hidden.
    expect(screen.getByRole("link", { name: /start with a computer/i })).toHaveAttribute("href", "#computers");
    expect(screen.getAllByRole("link", { name: /download the app/i })).toHaveLength(1);
  });

  it("renders complete Chinese hero copy when scoped to Chinese", () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <HeroSection />
      </LocaleProvider>
    );

    expect(screen.getByRole("heading", { level: 1, name: /你的 AI Agent，\s*始终在线/i })).toBeInTheDocument();
    // FTUE-16: "Start free" joins every other new account at sign-up, then Launch.
    expect(screen.getByRole("link", { name: /免费开始/i })).toHaveAttribute(
      "href",
      "/sign-up"
    );
    expect(screen.getAllByRole("link").some(link => link.getAttribute("href") === "#launch")).toBe(true);
    expect(screen.getByText(/免费层级始终可用/i)).toBeInTheDocument();
  });
});
