/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import VenicePage, { metadata } from "../page";
import { ENTRY_PLAN_PRICE } from "@/lib/blog/plan-facts";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const promoFlags = {
  NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED: "true",
  HIVRA_VENICE_PROMO_ENABLED: "true",
};

afterEach(() => jest.restoreAllMocks());

describe("/venice", () => {
  it("renders the headline, three agents and the right deep links", () => {
    render(<VenicePage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Run your Venice agent 24/7. No server setup.");
    for (const [name, id] of [["Hermes", "hermes"], ["OpenClaw", "openclaw"], ["Agent Zero", "agent-zero"]] as const) {
      const link = screen.getByRole("link", { name: new RegExp(name) });
      expect(link).toHaveAttribute("href", `/dashboard/launch?agent=${id}&inference=venice&ref=venice`);
    }
    expect(screen.getByRole("link", { name: /Launch with my key/ })).toHaveAttribute(
      "href",
      "/dashboard/launch?agent=hermes&inference=venice-key&ref=venice",
    );
  });

  it("shows both options, the steps, the price from the plans and a careful privacy note", () => {
    render(<VenicePage />);
    expect(screen.getByText("Use Hivra credits")).toBeInTheDocument();
    expect(screen.getByText("Bring your Venice API key")).toBeInTheDocument();
    for (const step of ["Pick an agent", "Chat"]) expect(screen.getByText(step, { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Launch", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(`Plans from ${ENTRY_PLAN_PRICE}/month.`)).toBeInTheDocument();
    expect(screen.getByText(/Private Venice models do not keep your prompts/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/end-to-end/i);
  });

  it("walks through both ways step by step and offers a setup call", () => {
    render(<VenicePage />);
    expect(screen.getByRole("link", { name: /Launch with Hivra credits/ })).toHaveAttribute(
      "href",
      "/dashboard/launch?agent=hermes&inference=venice&ref=venice",
    );
    expect(screen.getByRole("link", { name: /Get a Venice API key/ })).toHaveAttribute("href", "https://venice.ai/settings/api");
    expect(screen.getByText(/No Venice account needed/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Want a hand getting set up?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Book a setup call/ }).getAttribute("href")).toMatch(/^mailto:/);
    expect(screen.getByRole("link", { name: /Ask in Discord/ })).toBeInTheDocument();
  });

  it("has metadata for the canonical path", () => {
    expect(String(metadata.description)).toContain(ENTRY_PLAN_PRICE);
    expect(metadata.openGraph).toBeDefined();
  });

  it.each([
    ["on production with both flags on", "hivra.cloud", promoFlags],
    ["on Canary with the server flag off", "canary.hermesos.cloud", { ...promoFlags, HIVRA_VENICE_PROMO_ENABLED: "false" }],
    ["on Canary with the banner flag off", "canary.hermesos.cloud", { ...promoFlags, NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED: "false" }],
  ])("hides the promo %s", (_scenario, domain, flags) => {
    jest.replaceProperty(process, "env", { ...process.env, VERCEL_PROJECT_PRODUCTION_URL: domain, ...flags });
    render(<VenicePage />);
    expect(document.querySelector("[data-venice-promo]")).toBeNull();
    expect(screen.getByRole("link", { name: "Launch with Hivra credits" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Launch with my key" })).toBeInTheDocument();
  });

  it("shows the claim link on Canary when both flags are on", () => {
    jest.replaceProperty(process, "env", {
      ...process.env,
      VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
      ...promoFlags,
    });
    render(<VenicePage />);
    expect(screen.getByRole("heading", { name: /\$10\s*of Venice inference, on us/ })).toBeInTheDocument();
    expect(screen.getByText("VENICE", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code VENICE" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Claim your \$10/ })).toHaveAttribute(
      "href",
      "/dashboard/launch?agent=hermes&inference=venice&ref=venice&code=VENICE",
    );
  });
});
