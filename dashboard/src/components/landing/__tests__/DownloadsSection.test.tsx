/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import DownloadsSection from "../DownloadsSection";

test("the unpublished macOS app has no download URL and the browser route remains available", () => {
  render(<DownloadsSection />);
  const button = screen.getByRole("button", { name: "Download for macOS Coming soon" });
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleDescription("Public download coming soon.");
  expect(screen.queryByRole("link", { name: "Download for Mac" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Hivra in your browser" })).toHaveAttribute("href", "/dashboard");
});

test("Windows and Linux are visible as pending desktop apps", () => {
  render(<DownloadsSection />);
  expect(screen.getByRole("button", { name: "Download for Windows Coming soon" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Download for Linux Coming soon" })).toBeDisabled();
});

test("a published macOS release is linked with its label", () => {
  render(<DownloadsSection downloads={{
    macos: { status: "published", href: "https://releases.example.test/Hivra-macOS.dmg", label: "1.0.0 · Apple silicon" },
    windows: { status: "pending", href: null },
    linux: { status: "pending", href: null },
  }} />);
  const mac = screen.getByRole("link", { name: "Download for Mac" });
  expect(mac).toHaveAttribute("href", "https://releases.example.test/Hivra-macOS.dmg");
  expect(mac).toHaveAttribute("target", "_blank");
  expect(mac).toHaveAttribute("rel", "noopener noreferrer");
  expect(mac).toHaveAccessibleDescription("1.0.0 · Apple silicon");
});
