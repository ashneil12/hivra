/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import DashboardLayout from "../layout";
import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies, headers } from "next/headers";
import { isOpsAdminUser } from "@/lib/ops-access";

jest.mock("@clerk/nextjs/server", () => {
  const authMock = jest.fn();
  (authMock as jest.Mock & { protect: jest.Mock }).protect = jest.fn();

  return {
    auth: authMock,
    currentUser: jest.fn(),
  };
});

jest.mock("@/components/layout/ClientLayoutWrapper", () => ({
  ClientLayoutWrapper: ({
    children,
    showOpsLink,
    userEmail,
  }: {
    children: React.ReactNode;
    showOpsLink?: boolean;
    userEmail?: string;
  }) => (
    <div
      data-testid="layout-wrapper"
      data-show-ops-link={String(showOpsLink)}
      data-user-email={userEmail ?? ""}
    >
      {children}
    </div>
  ),
}));

jest.mock("@/components/i18n/LocaleProvider", () => ({
  LocaleProvider: ({
    children,
    initialLocale,
  }: {
    children: React.ReactNode;
    initialLocale?: string;
  }) => (
    <div data-testid="dashboard-locale-provider" data-initial-locale={initialLocale ?? ""}>
      {children}
    </div>
  ),
}));

jest.mock("@/app/providers/PostHogProvider", () => ({
  PostHogIdentify: () => null,
}));

jest.mock("@/components/auth/AuthClerkProvider", () => ({
  AuthClerkProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-clerk-provider">{children}</div>
  ),
}));

jest.mock("next/headers", () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

jest.mock("@/lib/ops-access", () => ({
  isOpsAdminUser: jest.fn(),
}));

describe("DashboardLayout", () => {
  const mockedAuth = auth as unknown as jest.Mock & { protect: jest.Mock };
  const mockedCurrentUser = currentUser as jest.Mock;
  const mockedCookies = cookies as unknown as jest.Mock;
  const mockedHeaders = headers as unknown as jest.Mock;
  const mockedIsOpsAdminUser = isOpsAdminUser as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" });
    mockedAuth.protect.mockResolvedValue(undefined);
    mockedCurrentUser.mockResolvedValue({
      firstName: "Ash",
      primaryEmailAddress: { emailAddress: "admin@example.com" },
    });
    mockedCookies.mockResolvedValue({
      get: jest.fn().mockReturnValue(undefined),
    });
    mockedHeaders.mockResolvedValue({
      get: jest.fn().mockReturnValue(null),
    });
    mockedIsOpsAdminUser.mockReturnValue(false);
  });

  it("hides the incidents link for non-admin dashboard users", async () => {
    const ui = await DashboardLayout({
      children: <div>Dashboard child</div>,
    });

    render(ui);

    expect(screen.getByTestId("auth-clerk-provider")).toBeInTheDocument();
    expect(screen.getByTestId("layout-wrapper")).toHaveAttribute("data-show-ops-link", "false");
    expect(screen.getByText("Dashboard child")).toBeInTheDocument();
    expect(mockedAuth.protect).toHaveBeenCalledTimes(1);
    expect(mockedCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("exposes the incidents link for the configured ops admin", async () => {
    mockedIsOpsAdminUser.mockReturnValue(true);

    const ui = await DashboardLayout({
      children: <div>Dashboard child</div>,
    });

    render(ui);

    expect(screen.getByTestId("auth-clerk-provider")).toBeInTheDocument();
    expect(screen.getByTestId("layout-wrapper")).toHaveAttribute("data-show-ops-link", "true");
    expect(mockedIsOpsAdminUser).toHaveBeenCalledWith({
      userId: "user_123",
      email: 'admin@example.com',
    });
  });

  it("falls back to the first email address when no primary address is present", async () => {
    mockedCurrentUser.mockResolvedValue({
      firstName: "Ash",
      emailAddresses: [{ emailAddress: "fallback@hermesos.cloud" }],
    });

    const ui = await DashboardLayout({
      children: <div>Dashboard child</div>,
    });

    render(ui);

    expect(screen.getByTestId("layout-wrapper")).toHaveAttribute(
      "data-user-email",
      "fallback@hermesos.cloud"
    );
    expect(mockedIsOpsAdminUser).toHaveBeenCalledWith({
      userId: "user_123",
      email: "fallback@hermesos.cloud",
    });
  });

  it("wraps the dashboard shell with the saved site language", async () => {
    mockedCookies.mockResolvedValue({
      get: jest.fn((name: string) => (name === "hermes_locale" ? { value: "zh-CN" } : undefined)),
    });

    const ui = await DashboardLayout({
      children: <div>Dashboard child</div>,
    });

    render(ui);

    expect(screen.getByTestId("dashboard-locale-provider")).toHaveAttribute(
      "data-initial-locale",
      "zh-CN"
    );
  });
});
