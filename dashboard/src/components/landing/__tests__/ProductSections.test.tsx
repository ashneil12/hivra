/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import ComputersSection from "../ComputersSection";
import HostingSection from "../HostingSection";
import OpenSourceSection from "../OpenSourceSection";

test("each OS has a launch link before interaction, while the selector changes its explanation", () => {
  render(<ComputersSection />);
  expect(screen.getByRole("link", { name: "Launch Ubuntu" })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop");
  expect(screen.getByRole("link", { name: "Launch Windows" })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=windows");
  expect(screen.getByRole("link", { name: "Launch Omarchy" })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=omarchy");
  expect(screen.getByRole("img", { name: "Ubuntu workspace illustration" })).toHaveAttribute("src", "/images/computers/ubuntu-workspace.webp");
  fireEvent.click(screen.getByRole("button", { name: /^Windows/ }));
  expect(screen.getByRole("img", { name: "Windows workspace illustration" })).toHaveAttribute("src", "/images/computers/windows-workspace.webp");
  expect(screen.getByRole("button", { name: /^Windows/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /^Ubuntu/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText(/Need Windows for one application/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^Omarchy/ }));
  expect(screen.getByText(/Make a workspace around your editor/)).toBeVisible();
  expect(screen.getByRole("img", { name: "Omarchy workspace illustration" })).toHaveAttribute("src", "/images/computers/omarchy-workspace.webp");
  expect(screen.getByText("macOS")).toBeVisible();
  expect(screen.getByText("Custom images")).toBeVisible();
  expect(screen.getAllByText("Coming soon")).toHaveLength(2);
});

test("hosting choices explain independent computers, own capacity and model keys", () => {
  render(<HostingSection />);
  ["Hivra Cloud", "Your infrastructure", "Self-host Hivra"].forEach(name => expect(screen.getByRole("heading", { name })).toBeVisible());
  expect(screen.getByText(/Your hardware, your sign-in, no Hivra account/)).toBeVisible();
  expect(screen.getByText("Bring your own model connection.")).toBeVisible();
  expect(screen.getByRole("link", { name: "Read about self-hosting" })).toHaveAttribute("href", "/docs/litepaper/index.html#platform");
});

test("open source links to the published source repository", () => {
  render(<OpenSourceSection />);
  expect(screen.getByText(/complete Hivra platform uses Apache 2.0/)).toBeVisible();
  expect(screen.getByText("The source is on GitHub.")).toBeVisible();
  expect(screen.getByRole("link", { name: "Hivra on GitHub" })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  expect(screen.getByRole("link", { name: "Read the open-source commitment" })).toHaveAttribute("href", "/docs/litepaper/index.html#platform");
  expect(screen.getByRole("link", { name: "Hivra on GitHub" })).toHaveAttribute("target", "_blank");

});
