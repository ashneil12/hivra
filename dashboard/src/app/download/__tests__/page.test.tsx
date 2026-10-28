/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { PUBLIC_PROJECT_LINKS, type DesktopDownloads } from "@/lib/public-project-links";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import DownloadRoute, { metadata } from "../page";
import DownloadPage from "../DownloadPage";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="public-site">{children}</div>,
}));

const DASH = new RegExp(`${String.fromCharCode(0x2013)}|${String.fromCharCode(0x2014)}`);

const PUBLISHED: DesktopDownloads = {
  macos: { status: "published", href: "https://releases.example.test/Hivra-macOS.dmg", label: "1.0.0 · Apple silicon" },
};

describe("/download", () => {
  it("states honestly that no installer exists while the macOS record is pending", () => {
    expect(PUBLIC_PROJECT_LINKS.desktop.macos.status).toBe("pending");
    render(<DownloadPage />);

    const macos = screen.getByRole("region", { name: "macOS" });
    expect(within(macos).getByText("Public download coming soon.")).toBeInTheDocument();
    const button = within(macos).getByRole("button", { name: "Download for macOS" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Public download coming soon.");
    // The state is said once, in the line above the button, not again inside it.
    expect(macos.textContent?.match(/coming soon/gi)).toHaveLength(1);
    expect(within(macos).queryByRole("link", { name: /download for macos/i })).not.toBeInTheDocument();
    // The install caution is about a release, and none exists.
    expect(macos).not.toHaveTextContent("Before installing");
    expect(macos).toHaveTextContent(
      "If the desktop app is not available for your Mac yet, you can still use Hivra in your browser.",
    );
    expect(within(macos).getByRole("link", { name: "Open Hivra" })).toHaveAttribute("href", "/dashboard");
  });

  it("links a real release, with its label and the install caution, only when one is published", () => {
    render(<DownloadPage downloads={PUBLISHED} />);

    const macos = screen.getByRole("region", { name: "macOS" });
    const link = within(macos).getByRole("link", { name: "Download for macOS" });
    expect(link).toHaveAttribute("href", "https://releases.example.test/Hivra-macOS.dmg");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleDescription("1.0.0 · Apple silicon");
    expect(within(macos).queryByRole("button")).not.toBeInTheDocument();
    expect(macos).not.toHaveTextContent("Public download coming soon.");
    expect(macos).toHaveTextContent(
      "Before installing, check that your Mac meets the supported system requirements and that the release comes from an official Hivra distribution channel.",
    );
  });

  it("carries the md heading, introduction and the keep-the-work-where-it-belongs section", () => {
    render(<DownloadPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Hivra on your computer." })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Some work is easier when you can reach your agents without keeping another browser tab open. This page is where you’ll find supported desktop downloads and installation guidance.",
      ),
    ).toBeInTheDocument();

    const where = screen.getByRole("region", { name: "Keep the work where it belongs" });
    expect(where).toHaveTextContent("Your Hivra-hosted computers run remotely.");
    // The shared wording for a computer that stays on, not an unqualified "always on".
    expect(where).toHaveTextContent("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
    expect(where).toHaveTextContent(
      "although individual agent workflows can still stop, fail or reach their own usage limits.",
    );
    expect(where).not.toHaveTextContent(/always-on|always on/i);
    expect(within(where).getByRole("link", { name: "info@hivra.cloud" })).toHaveAttribute("href", "mailto:info@hivra.cloud");
  });

  it("invents no installer, version, platform or waitlist, and writes no dash", () => {
    const { container } = render(<DownloadPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/windows|linux|waitlist|join the list|notify me|version \d|\bv\d+\.\d/i);
    expect(text).not.toMatch(DASH);
    expect(container.querySelector('a[href^="http"]')).toBeNull();
    expect(container.querySelector("a[download]")).toBeNull();
  });

  it("names a desktop app only to say it is not out, the one banned phrase this page needs", () => {
    const { container } = render(<DownloadPage />);
    const hits = findBannedClaims(container.textContent ?? "");
    // copy-rules bans "desktop app" because desktop apps are not available. This page says exactly that
    // (and what to do instead), so that single rule is exempted here and nothing else is.
    expect(hits.map((hit) => hit.match.toLowerCase())).toEqual(["desktop app"]);
    expect(container.textContent).not.toMatch(/\b(?:is|are) (?:now )?(?:available|live|out)\b(?! for)/i);
  });

  it("uses the glossary words", () => {
    const { container } = render(<DownloadPage />);
    expect(container.textContent).not.toMatch(/\b(?:instances?|runtimes?|the box)\b/i);
  });

  it("publishes the finished title from the copy as an absolute title, with the pinned description", () => {
    expect(metadata.title).toEqual({ absolute: "Download Hivra | Desktop Availability" });
    expect(metadata.description).toBe("The Hivra desktop app for macOS is coming soon. Open Hivra in your browser today.");
    expect(String(metadata.description)).not.toMatch(/Windows/);
  });

  it("renders inside the public frame", () => {
    render(<DownloadRoute />);
    expect(screen.getByTestId("public-site")).toContainElement(screen.getByRole("main"));
  });
});
