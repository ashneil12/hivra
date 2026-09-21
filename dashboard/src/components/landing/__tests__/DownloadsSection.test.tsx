/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import DownloadsSection from "../DownloadsSection";

test("unpublished desktop apps have no download URL and the browser route remains available", () => {
  render(<DownloadsSection />);
  for (const platform of ["macOS", "Windows"]) {
    const button = screen.getByRole("button", { name: `Download for ${platform} Coming soon` });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Public download coming soon.");
    expect(screen.queryByRole("link", { name: `Download for ${platform}` })).not.toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "Open Hivra in your browser" })).toHaveAttribute("href", "/dashboard");
});

test("publishing one verified OS artifact cannot enable the other OS download", () => {
  render(<DownloadsSection downloads={{
    macos: { status: "published", href: "https://releases.example.test/Hivra-macOS.dmg", label: "1.0.0 · Apple silicon" },
    windows: { status: "pending", href: null },
  }} />);
  const mac = screen.getByRole("link", { name: "Download for macOS" });
  expect(mac).toHaveAttribute("href", "https://releases.example.test/Hivra-macOS.dmg");
  expect(mac).toHaveAttribute("target", "_blank");
  expect(mac).toHaveAttribute("rel", "noopener noreferrer");
  expect(mac).toHaveAccessibleDescription("1.0.0 · Apple silicon");
  expect(screen.getByRole("button", { name: "Download for Windows Coming soon" })).toBeDisabled();
});
