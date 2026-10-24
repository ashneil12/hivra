/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import NewUpdatePage, { metadata } from "../page";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const DASH = new RegExp(`${String.fromCharCode(0x2013)}|${String.fromCharCode(0x2014)}`);

describe("NewUpdatePage", () => {
  it("announces Venice multimodal agents in Ash's words, without the old live claim or free-tier copy", () => {
    render(<NewUpdatePage />);
    const container = screen.getByRole("main");

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Venice multimodal agents on Hivra.");
    expect(
      screen.getByText(/^Give a persistent Hermes agent access to supported multimodal models using your Venice credentials\./),
    ).toHaveTextContent(
      "Give a persistent Hermes agent access to supported multimodal models using your Venice credentials. Your agent runs on a Hivra computer, so its working environment stays available beyond a single browser session.",
    );
    expect(screen.getByText("One Venice key. A persistent agent computer.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Model availability and supported modalities depend on the current Venice integration and your account configuration.",
      ),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/agents live/i);
    expect(screen.queryByText(/free tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open now/i)).not.toBeInTheDocument();
    expect(screen.getByText("Venice · Multimodal")).toBeInTheDocument();
  });

  it("uses the shared stays-on wording and says the plan does not include AI usage", () => {
    render(<NewUpdatePage />);
    const text = screen.getByRole("main").textContent ?? "";

    expect(text).toContain("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
    expect(text).toContain(
      "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
    );
    expect(text).not.toMatch(/never sleeps|always on|always-on/i);
  });

  it("links the two actions to the real routes", () => {
    render(<NewUpdatePage />);

    expect(screen.getByRole("link", { name: "Deploy your agent" })).toHaveAttribute("href", "/sign-up");
    expect(screen.getByRole("link", { name: "Explore Hermes" })).toHaveAttribute("href", "/agents/hermes");
  });

  it("stays out of search and writes no dash, no banned claim and no tokens", () => {
    render(<NewUpdatePage />);
    const text = screen.getByRole("main").textContent ?? "";

    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(text).not.toMatch(DASH);
    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/\$HIVRA|\$HermesOS|airdrop|snapshot|litepaper/i);
  });
});
