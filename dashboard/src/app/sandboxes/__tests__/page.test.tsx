/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import SandboxesPage from "../page";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const managedSettings = {
  HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true",
  HIVRA_MANAGED_GVISOR_DISK_ADMISSION_ENABLED: "true",
  HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID: "user_fixture",
  HIVRA_MANAGED_GVISOR_CONNECTION_ID: "11111111-1111-4111-8111-111111111111",
  HIVRA_MANAGED_GVISOR_TARGET_ID: "22222222-2222-4222-8222-222222222222",
  HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "1",
};

afterEach(() => jest.restoreAllMocks());

it.each([
  {},
  { ...managedSettings, HIVRA_MANAGED_GVISOR_CONNECTION_ID: "" },
  { ...managedSettings, HIVRA_MANAGED_GVISOR_DISK_ADMISSION_ENABLED: "false" },
  { ...managedSettings, HIVRA_MANAGED_GVISOR_QA_ENROLLMENT_ENABLED: "true" },
])("keeps the connected sandbox and hides managed copy when public admission is incomplete (%j)", (env) => {
  jest.replaceProperty(process, "env", { NODE_ENV: "test", ...env });
  render(<SandboxesPage />);
  expect(screen.getByRole("region", { name: "Run a sandbox on your server" })).toHaveTextContent("Connect a compatible Linux server and choose Linux Sandbox in Launch.");
  expect(screen.getByRole("main")).not.toHaveTextContent(/Light computer|storage limit|nap and then hibernate/i);
});

it("advertises managed Light only with configured public launch and storage admission", () => {
  jest.replaceProperty(process, "env", { NODE_ENV: "test", ...managedSettings });
  render(<SandboxesPage />);
  const access = screen.getByRole("region", { name: "Two ways to run a sandbox" });
  expect(access).toHaveTextContent("Connect a compatible Linux server and choose Linux Sandbox in Launch.");
  expect(access).toHaveTextContent("On a paid plan, pick Linux Sandbox in Launch for a Light computer that Hivra manages for you.");
  expect(screen.getByRole("link", { name: "Open Launch" })).toHaveAttribute("href", "/dashboard/launch?kind=computer");
});

it("explains both sleep models without offering a sandbox price or promising resumed processes", () => {
  jest.replaceProperty(process, "env", { NODE_ENV: "test", ...managedSettings, HIVRA_SLEEP_MODE: "on", NEXT_PUBLIC_HIVRA_AGENT_SLEEP: "1" });
  render(<SandboxesPage />);
  const comparison = screen.getByRole("region", { name: "Choose the computer your work needs." });
  expect(comparison).toHaveTextContent(/a sandbox has no graphical desktop\./i);
  expect(comparison).toHaveTextContent("running processes and unsaved work don’t resume");
  expect(comparison).toHaveTextContent("Each managed sandbox has its own storage limit.");
  expect(comparison).toHaveTextContent("nap and then hibernate");
  expect(comparison).not.toHaveTextContent(/canary|pilot|preview/i);
  expect(within(comparison).getByRole("heading", { name: "An isolated place to run code" })).toBeInTheDocument();
  expect(screen.getByRole("main")).not.toHaveTextContent(/[$€£]\s*\d/);
});
