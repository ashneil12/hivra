/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import VenicePage, { metadata } from "../page";
import VenicePromo from "@/components/venice/VenicePromo";
import { ENTRY_PLAN_PRICE } from "@/lib/blog/plan-facts";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const mockAuth = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));

const CLAIM_RETURN = "/dashboard/launch?agent=hermes&inference=venice&ref=venice&code=VENICE";
const FLAG = "NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED";
const original = process.env[FLAG];
beforeEach(() => mockAuth.mockReset().mockResolvedValue({ userId: null }));

afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

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

  it("hides the promo when the flag is off and shows it when on", async () => {
    delete process.env[FLAG];
    const { unmount } = render(await VenicePage());
    expect(screen.queryByText(/VENICE/, { selector: "strong" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-venice-promo]")).toBeNull();
    unmount();
    process.env[FLAG] = "false";
    const off = render(<VenicePromo signedIn={false} />);
    expect(off.container).toBeEmptyDOMElement();
    off.unmount();
    process.env[FLAG] = "true";
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
    process.env[FLAG] = "true";
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

  it("links signed-in claimants directly to Launch", async () => {
    process.env[FLAG] = "true";
    mockAuth.mockResolvedValue({ userId: "user_venice" });
    render(await VenicePage());

    expect(screen.getByRole("link", { name: /Claim your \$10/ })).toHaveAttribute("href", CLAIM_RETURN);
  });
});
