/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import YourCloudPage, { metadata } from "../page";
import { SUPPORT_EMAIL } from "@/lib/support-channels";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children, tokenSurfaces }: { children: ReactNode; tokenSurfaces?: boolean }) => (
    <div data-testid="public-frame" data-token-surfaces={String(tokenSurfaces)}>{children}</div>
  ),
}));

it("offers a real email draft with useful qualification fields and a fallback address", () => {
  render(<YourCloudPage />);
  const links = screen.getAllByRole("link", { name: "Discuss a pilot" });
  expect(links).toHaveLength(2);
  for (const link of links) {
    const url = new URL(link.getAttribute("href") ?? "");
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe(SUPPORT_EMAIL);
    expect(url.searchParams.get("subject")).toBe("[Hivra pilot] Customer cloud");
    expect(url.searchParams.get("body")).toContain("One workflow or hosting problem:");
    expect(url.searchParams.get("body")).toContain("Please do not include passwords, API keys or client data.");
  }
  expect(screen.getByRole("link", { name: SUPPORT_EMAIL })).toHaveAttribute("href", `mailto:${SUPPORT_EMAIL}`);
});

it("presents a compatibility-gated pilot with separate bills and owner-controlled access", () => {
  render(<YourCloudPage />);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByText("Pilot availability is subject to a compatibility review.")).toBeInTheDocument();
  expect(screen.getByText(/You pay your infrastructure provider and AI provider directly/)).toBeInTheDocument();
  expect(screen.getByText(/You do not share your account passwords with us/)).toBeInTheDocument();
  expect(screen.getByText(/Model providers and connected services still receive/)).toBeInTheDocument();
  expect(screen.getByTestId("public-frame")).toHaveAttribute("data-token-surfaces", "false");
  expect(metadata.robots).toEqual({ index: false, follow: false });
});
