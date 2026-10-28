/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import OfflinePage, { dynamic, metadata } from "../page";

const DASH = new RegExp(`${String.fromCharCode(0x2013)}|${String.fromCharCode(0x2014)}`);

describe("offline fallback page", () => {
  it("renders a branded Hivra offline message in Ash's words", () => {
    render(<OfflinePage />);

    expect(screen.getByText("Hivra")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /you.?re offline\./i })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Hivra can’t reach your agents from this connection right now. Check your Wi-Fi or mobile data, then try again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "A network interruption on your device doesn’t necessarily stop a computer that’s still running on Hivra Cloud. However, tasks and connections may be affected by their own errors or service incidents.",
      ),
    ).toBeInTheDocument();
  });

  it("makes no promise it cannot keep from a cached shell", () => {
    const { container } = render(<OfflinePage />);
    // The shell cannot know the dashboard will reconnect by itself, so it does not say so.
    expect(container).not.toHaveTextContent(/reconnects automatically/i);
    expect(String(metadata.description)).not.toMatch(/will reconnect/i);
    expect(container.textContent).not.toMatch(DASH);
    expect(findBannedClaims(container.textContent ?? "")).toEqual([]);
  });

  it("offers a reconnect link back into the app", () => {
    render(<OfflinePage />);

    const reconnect = screen.getByRole("link", { name: /try reconnecting/i });
    expect(reconnect).toHaveAttribute("href", "/dashboard/chat");

    const home = screen.getByRole("link", { name: /back to home/i });
    expect(home).toHaveAttribute("href", "/");
  });

  it("sits in one main landmark", () => {
    render(<OfflinePage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
  });

  // An installed PWA keeps the /offline shell it cached under the old build marker; only a new marker
  // makes it fetch the rewritten words (public/sw.js, activate step).
  it("ships under a service-worker build marker newer than the shell this copy replaced", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "public", "sw.js"), "utf8");
    const marker = /self\.HERMES_SW_BUILD = "([^"]+)"/.exec(source)?.[1] ?? "";
    expect(marker).not.toBe("");
    expect(marker).not.toBe("2026-08-24T00:00Z-workspace-public-shell");
    expect(marker.slice(0, 10) >= "2026-10-20").toBe(true);
  });

  it("is a static, non-indexed route", () => {
    expect(dynamic).toBe("force-static");
    expect(metadata.title).toBe("Offline");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});
