/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import OpsReleasesPage from "../page";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isOpsAdminUser } from "@/lib/ops-access";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("@clerk/nextjs/server", () => {
  const authMock = jest.fn();
  (authMock as jest.Mock & { protect: jest.Mock }).protect = jest.fn();
  return { auth: authMock, currentUser: jest.fn() };
});

jest.mock("next/navigation", () => ({ redirect: jest.fn() }));

jest.mock("@/components/ops/ReleasesConsole", () => ({
  ReleasesConsole: () => <div>Releases console</div>,
}));

jest.mock("@/lib/ops-access", () => ({
  ...jest.requireActual("@/lib/ops-access"),
  isOpsAdminUser: jest.fn(),
}));

describe("OpsReleasesPage", () => {
  const mockedAuth = auth as unknown as jest.Mock & { protect: jest.Mock };
  const mockedCurrentUser = currentUser as jest.Mock;
  const mockedRedirect = redirect as unknown as jest.Mock;
  const mockedIsOpsAdminUser = isOpsAdminUser as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" });
    mockedAuth.protect.mockResolvedValue(undefined);
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "admin@example.com", verification: { status: "verified" } },
    });
    mockedRedirect.mockImplementation(() => undefined);
  });

  it("redirects non-admin users to the dashboard", async () => {
    mockedIsOpsAdminUser.mockReturnValue(false);

    const ui = await OpsReleasesPage();

    expect(ui).toBeNull();
    expect(mockedRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("gives the admin check only the verified primary email", async () => {
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "admin@example.com", verification: { status: "unverified" } },
    });
    mockedIsOpsAdminUser.mockReturnValue(false);

    await OpsReleasesPage();

    expect(mockedIsOpsAdminUser).toHaveBeenCalledWith({ userId: "user_123", email: null });
  });

  it("renders the releases console for ops admins", async () => {
    mockedIsOpsAdminUser.mockReturnValue(true);

    const ui = await OpsReleasesPage();
    render(ui as React.ReactElement);

    expect(mockedRedirect).not.toHaveBeenCalled();
    expect(screen.getByText("Releases console")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Incident feed" })).toHaveAttribute("href", "/dashboard/ops");
  });
});
