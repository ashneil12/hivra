/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import VenicePage, { metadata } from "../page";
import { ENTRY_PLAN_PRICE } from "@/lib/blog/plan-facts";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const mockAuth = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));

const CLAIM_RETURN = "/dashboard/launch?agent=hermes&inference=venice&ref=venice&code=VENICE";
const promoFlags = {
  NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED: "true",
  HIVRA_VENICE_PROMO_ENABLED: "true",
};

function setPromoEnv(domain = "canary.hermesos.cloud", flags = promoFlags) {
  jest.replaceProperty(process, "env", { ...process.env, VERCEL_PROJECT_PRODUCTION_URL: domain, ...flags });
}

beforeEach(() => mockAuth.mockReset().mockResolvedValue({ userId: null }));
afterEach(() => jest.restoreAllMocks());

describe("/venice", () => {
  it("renders the headline, three agents and the right deep links", async () => {
    render(await VenicePage());
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

  it("shows both options, the steps, the price from the plans and a careful privacy note", async () => {
    render(await VenicePage());
    expect(screen.getByText("Use Hivra credits")).toBeInTheDocument();
    expect(screen.getByText("Bring your Venice API key")).toBeInTheDocument();
    for (const step of ["Pick an agent", "Chat"]) expect(screen.getByText(step, { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Launch", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(`Plans from ${ENTRY_PLAN_PRICE}/month.`)).toBeInTheDocument();
    expect(screen.getByText(/Private Venice models do not keep your prompts/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/end-to-end/i);
  });

  it("walks through both ways step by step and offers a setup call", async () => {
    render(await VenicePage());
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
  ])("hides the promo %s", async (_scenario, domain, flags) => {
    setPromoEnv(domain, flags);
    render(await VenicePage());
    expect(document.querySelector("[data-venice-promo]")).toBeNull();
    expect(screen.queryByRole("link", { name: /Claim your \$10/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Launch with Hivra credits" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Launch with my key" })).toBeInTheDocument();
  });

  it("links signed-out claimants through sign-in on Canary", async () => {
    setPromoEnv();
    render(await VenicePage());
    expect(screen.getByRole("heading", { name: /\$10\s*of Venice inference, on us/ })).toBeInTheDocument();
    expect(screen.getByText("VENICE", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code VENICE" })).toBeInTheDocument();
  });

  it("sends signed-out claimants to sign-up with their Venice launch destination", async () => {
    process.env[FLAG] = "true";
    render(await VenicePage());

    expect(screen.getByRole("link", { name: /Claim your \$10/ })).toHaveAttribute(
      "href",
      `/sign-up?redirect_url=${encodeURIComponent(CLAIM_RETURN)}`,
    );
  });

  it("shows both brand marks and leaves film playback unmuted and user-initiated", async () => {
    setPromoEnv();
    render(await VenicePage());

    expect(screen.getByRole("img", { name: "Hivra" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Venice" })).toBeInTheDocument();
    const film = screen.getByLabelText("Hivra × Venice launch film") as HTMLVideoElement;
    expect(film).toHaveAttribute("poster", "https://ejzonwoikxinlk0x.public.blob.vercel-storage.com/venice/hivra-venice-poster.jpg");
    expect(film).toHaveAttribute("preload", "none");
    expect(film).toHaveAttribute("playsinline");
    expect(film.controls).toBe(true);
    expect(film.autoplay).toBe(false);
    expect(film.muted).toBe(false);
    expect(film.querySelector("source")).toHaveAttribute("src", "https://ejzonwoikxinlk0x.public.blob.vercel-storage.com/venice/hivra-venice-draft3b-16x9.mp4");
    const play = jest.spyOn(film, "play").mockResolvedValue();
    const playButton = screen.getByRole("button", { name: "Play Hivra × Venice launch film" });
    fireEvent.click(playButton);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.playing(film);
    expect(playButton).not.toBeInTheDocument();
    const claim = screen.getByRole("link", { name: /Claim your \$10/ });
    expect(claim.compareDocumentPosition(film) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links signed-in claimants directly to Launch on Canary", async () => {
    setPromoEnv();
    mockAuth.mockResolvedValue({ userId: "user_venice" });
    render(await VenicePage());

    expect(screen.getByRole("link", { name: /Claim your \$10/ })).toHaveAttribute("href", CLAIM_RETURN);
  });
});
