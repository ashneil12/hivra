/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import MemoryPage, { metadata } from "../page";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const FLAG = "NEXT_PUBLIC_HIVRA_MEMORY";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe("/memory", () => {
  it("is not found while the switch is off", () => {
    delete process.env[FLAG];
    expect(() => render(<MemoryPage />)).toThrow("NEXT_NOT_FOUND");
  });

  it("says what it is, that it is free, and sends people to sign up for a key", () => {
    process.env[FLAG] = "1";
    render(<MemoryPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Free cloud memory for any AI agent.");
    for (const link of screen.getAllByRole("link", { name: /Get your free memory/ })) {
      expect(link).toHaveAttribute("href", "/sign-up?next=memory");
    }
    for (const name of ["Claude Code", "Codex", "Hermes", "OpenClaw"]) expect(screen.getByText(name, { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("10,000 memories")).toBeInTheDocument();
    for (const tool of ["wake", "remember", "recall", "zoom", "summarize", "profile", "forget", "export"]) {
      expect(screen.getByText(tool, { selector: "td" })).toBeInTheDocument();
    }
  });

  it("is honest about privacy and labels its own measurements", () => {
    process.env[FLAG] = "true";
    render(<MemoryPage />);
    expect(screen.getByText(/Hivra runs the service, so Hivra could reach it/)).toBeInTheDocument();
    expect(screen.getByText(/Hivra's own measurements/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/end-to-end|zero[- ]knowledge|we can(?:'|no)t see/i);
    expect(screen.getByRole("heading", { name: "Questions people ask" })).toBeInTheDocument();
    expect(document.querySelector('script[type="application/ld+json"]')?.textContent).toContain("FAQPage");
  });

  it("has metadata for the canonical path", () => {
    expect(String(metadata.description)).toContain("free");
    expect(metadata.openGraph).toBeDefined();
  });
});
