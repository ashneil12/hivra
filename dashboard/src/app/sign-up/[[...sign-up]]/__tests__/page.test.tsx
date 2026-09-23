/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import { redirect } from "next/navigation";

import SignUpPage from "../page";

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
}));

describe("SignUpPage", () => {
  const originalAuthMode = process.env.HIVRA_AUTH_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HIVRA_AUTH_MODE;
  });

  afterAll(() => {
    if (originalAuthMode == null) delete process.env.HIVRA_AUTH_MODE;
    else process.env.HIVRA_AUTH_MODE = originalAuthMode;
  });

  it("does not offer hosted account creation for an installation-owned operator", async () => {
    process.env.HIVRA_AUTH_MODE = "local";

    const ui = await SignUpPage({
      searchParams: Promise.resolve({}),
    });

    expect(ui).toBeNull();
    expect(redirect).toHaveBeenCalledWith("/sign-in");
  });

  it("redirects plan-specific signup traffic into the richer get-started flow", async () => {
    await SignUpPage({
      searchParams: Promise.resolve({ plan: "fleet" }),
    });

    expect(redirect).toHaveBeenCalledWith("/get-started?plan=fleet");
  });

  it("redirects legacy reservation signup traffic into the live free plan flow", async () => {
    await SignUpPage({
      searchParams: Promise.resolve({ from: "reserve" }),
    });

    expect(redirect).toHaveBeenCalledWith("/get-started?plan=free");
  });

  it("keeps the plain signup page available when no plan intent is provided", async () => {
    const ui = await SignUpPage({
      searchParams: Promise.resolve({}),
    });

    render(ui);

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /back/i })).not.toBeInTheDocument();
  });

  it("shows the same three-step count as get-started and a Hivra home bar", async () => {
    const ui = await SignUpPage({
      searchParams: Promise.resolve({}),
    });

    render(ui);

    expect(screen.getByText("Step 1 of 3 — Create Account")).toBeInTheDocument();
    expect(screen.queryByText(/of 2/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Hivra home" })).toHaveAttribute("href", "/");
  });
});
