/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import VenicePage, { metadata } from "../page";
import VenicePromo from "@/components/venice/VenicePromo";
import { ENTRY_PLAN_PRICE } from "@/lib/blog/plan-facts";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const FLAG = "NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

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

  it("has metadata for the canonical path", () => {
    expect(String(metadata.description)).toContain(ENTRY_PLAN_PRICE);
    expect(metadata.openGraph).toBeDefined();
  });

  it("hides the promo when the flag is off and shows it when on", () => {
    delete process.env[FLAG];
    const { unmount } = render(<VenicePage />);
    expect(screen.queryByText(/VENICE/, { selector: "strong" })).not.toBeInTheDocument();
    unmount();
    process.env[FLAG] = "false";
    const off = render(<VenicePromo />);
    expect(off.container).toBeEmptyDOMElement();
    off.unmount();
    process.env[FLAG] = "true";
    render(<VenicePromo />);
    expect(screen.getByText(/Get \$10 of Venice inference with code/)).toBeInTheDocument();
    expect(screen.getByText("VENICE")).toBeInTheDocument();
  });
});
