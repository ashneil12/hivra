/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import Footer from "../Footer";

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

describe("Footer", () => {
  it("does not depend on runtime date generation for footer copy", () => {
    const footerSource = fs.readFileSync(path.join(__dirname, "..", "Footer.tsx"), "utf8");

    expect(footerSource).not.toContain("new Date()");
  });

  it("links the product, token, status, and stats entries and credits HermesOS", () => {
    render(<Footer />);

    expect(screen.getByRole("link", { name: "Ecosystem" })).toHaveAttribute("href", "/ecosystem");
    expect(screen.getByRole("link", { name: "Token" })).toHaveAttribute("href", "/token");
    // Operational status page lives at /status; the live deploy counter is /stats.
    expect(screen.getByRole("link", { name: "Status" })).toHaveAttribute("href", "/status");
    expect(screen.getByRole("link", { name: "Stats" })).toHaveAttribute("href", "/stats");
    expect(screen.getByText(/Powered by Hivra/i)).toBeInTheDocument();
  });

  it("links the status page next to the changelog entry", () => {
    render(<Footer />);

    expect(screen.getByRole("link", { name: "Status" })).toHaveAttribute("href", "/status");
    expect(screen.getByRole("link", { name: "Changelog" })).toHaveAttribute("href", "/changelog");
  });

  it("includes a roadmap link in the footer", () => {
    render(<Footer />);

    expect(screen.getByRole("link", { name: "Roadmap" })).toHaveAttribute("href", "/roadmap");
  });

  it("exposes computer, hosting and download routes without a dead GitHub link", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: "Computers" })).toHaveAttribute("href", "/#computers");
    expect(screen.getByRole("link", { name: "Hosting & self-hosting" })).toHaveAttribute("href", "/#hosting");
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  });

  it("links the official X account in a new tab", () => {
    render(<Footer />);
    const x = screen.getByRole("link", { name: "X (@HivraOS)" });
    expect(x).toHaveAttribute("href", "https://x.com/HivraOS");
    expect(x).toHaveAttribute("target", "_blank");
    expect(x).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("links the changelog next to the roadmap entry", () => {
    render(<Footer />);

    expect(screen.getByRole("link", { name: "Changelog" })).toHaveAttribute("href", "/changelog");
  });

  it("renders English structural footer labels regardless of locale", () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <Footer />
      </LocaleProvider>
    );

    expect(screen.getByRole("link", { name: "Roadmap" })).toHaveAttribute("href", "/roadmap");
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/#agents");
  });
  it("makes the litepaper discoverable and opens only external sites in a new tab", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: "Litepaper" })).toHaveAttribute("href", "/docs/litepaper/");
    expect(screen.queryByText("A place of its own.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Read the litepaper" })).not.toBeInTheDocument();
    // Nibbii is no longer part of Hivra or a token use.
    expect(screen.queryByRole("link", { name: "Nibbii" })).not.toBeInTheDocument();
    const github = screen.getByRole("link", { name: "GitHub" });
    expect(github).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
    expect(github).toHaveAttribute("target", "_blank");
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
    screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/")).forEach((link) => {
      expect(link).not.toHaveAttribute("target", "_blank");
    });
  });

});
