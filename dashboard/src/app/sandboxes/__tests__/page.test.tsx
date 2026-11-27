/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import SandboxesPage from "../page";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

it("distinguishes connected sandboxes, managed Light, and the managed sleep pilot", () => {
  render(<SandboxesPage />);
  const access = screen.getByRole("region", { name: "Two ways to run a sandbox" });
  expect(access).toHaveTextContent("Connect a compatible Linux server and choose Linux Sandbox in Launch.");
  expect(access).toHaveTextContent("Managed Light computers use the Linux Sandbox option in Launch.");
  expect(access).toHaveTextContent("limited to eligible test accounts on Canary");
  expect(access).toHaveTextContent("automatic idle sleep is a separate pilot.");
  expect(screen.getByRole("link", { name: "Open Launch" })).toHaveAttribute("href", "/dashboard/launch?kind=computer");
});

it("explains both sleep models without offering a sandbox price or promising resumed processes", () => {
  render(<SandboxesPage />);
  const comparison = screen.getByRole("region", { name: "Choose the computer your work needs." });
  expect(comparison).toHaveTextContent(/a sandbox has no graphical desktop\./i);
  expect(comparison).toHaveTextContent("running processes and unsaved work don’t resume");
  expect(comparison).toHaveTextContent("their own storage limits");
  expect(comparison).toHaveTextContent("nap and then hibernation");
  expect(within(comparison).getByRole("heading", { name: "An isolated place to run code" })).toBeInTheDocument();
  expect(screen.getByRole("main")).not.toHaveTextContent(/[$€£]\s*\d/);
});
