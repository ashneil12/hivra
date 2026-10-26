/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import TokenPageClient from "../TokenPageClient";
import { SUPPORT_DISCORD_URL } from "@/lib/support-channels";
import { formatLaunchInstantUtc, getTokenPageEntries } from "@/lib/token-verification-content";

const mockCopy = jest.fn();
jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: (value: string) => mockCopy(value) }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("TokenPageClient contract address", () => {
  it("copies the full contract address and confirms it", async () => {
    mockCopy.mockResolvedValue(true);
    render(<TokenPageClient entries={getTokenPageEntries()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });

    expect(mockCopy).toHaveBeenCalledWith("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(screen.getByRole("button", { name: "Address copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Contract address copied");
  });

  it("tells the reader to select the address when the copy fails", async () => {
    mockCopy.mockResolvedValue(false);
    render(<TokenPageClient entries={getTokenPageEntries()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });

    expect(screen.getByRole("status")).toHaveTextContent(/select the address/i);
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
  });
});

describe("TokenPageClient impersonation and risk facts", () => {
  it("lists the official accounts with their exact handles, and says Hivra has no Telegram", () => {
    render(<TokenPageClient entries={getTokenPageEntries()} />);
    const accounts = within(screen.getByRole("region", { name: "Official accounts" }));
    expect(accounts.getByRole("link", { name: "@HivraOS" })).toHaveAttribute("href", "https://x.com/HivraOS");
    expect(accounts.getByRole("link", { name: SUPPORT_DISCORD_URL.replace("https://", "") })).toHaveAttribute("href", SUPPORT_DISCORD_URL);
    expect(accounts.getByRole("link", { name: "github.com/ashneil12/hivra" })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
    for (const link of accounts.getAllByRole("link")) expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      accounts.getByText("Hivra has no Telegram. Anyone offering a Hivra Telegram, airdrop, presale or claim in DMs is not Hivra.")
    ).toBeInTheDocument();
  });

  it("warns about lookalike tokens next to the contracts and states the risk line", () => {
    render(<TokenPageClient entries={getTokenPageEntries()} />);
    const verify = within(screen.getByRole("region", { name: "Verify the token contracts" }));
    expect(
      verify.getByText(
        "Tokens named Hivra, HivraOS or HIVRA at other addresses on Base have nothing to do with Hivra. Compare the full address with this page."
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId("token-risk-line")).toHaveTextContent(
      /^This page is information, not an offer or an invitation to buy\. Cryptoassets can lose all of their value\.$/
    );
  });

  it("keeps the official accounts, lookalike warning and risk line for a viewer the geo-policy blocks", () => {
    render(<TokenPageClient entries={getTokenPageEntries()} geoNotice="Token features aren't available here." />);
    expect(screen.getByRole("region", { name: "Official accounts" })).toBeInTheDocument();
    expect(screen.getByTestId("token-lookalike-warning")).toBeInTheDocument();
    expect(screen.getByTestId("token-risk-line")).toBeInTheDocument();
  });

  it("writes the new facts without dashes", () => {
    const { container } = render(<TokenPageClient entries={getTokenPageEntries()} />);
    for (const id of ["official-accounts"]) {
      expect(container.querySelector(`#${id}`)?.textContent).not.toMatch(/[–—]/);
    }
    expect(screen.getByTestId("token-lookalike-warning").textContent).not.toMatch(/[–—]/);
    expect(screen.getByTestId("token-risk-line").textContent).not.toMatch(/[–—]/);
  });
});

describe("formatLaunchInstantUtc", () => {
  it("writes a UTC instant the same way on server and client", () => {
    expect(formatLaunchInstantUtc("2026-10-01T16:00:00.000Z")).toBe("1 October 2026, 16:00 UTC");
    expect(formatLaunchInstantUtc("2026-12-31T09:05:07.000Z")).toBe("31 December 2026, 09:05:07 UTC");
    expect(formatLaunchInstantUtc("not a date")).toBe("not a date");
  });
});


describe("TokenPageClient current access before launch", () => {
  it("puts existing holder access before contracts and the proposed successor", () => {
    const { container } = render(<TokenPageClient entries={getTokenPageEntries()} />);
    const sections = [...container.querySelectorAll("main > section")].map(section => section.id);
    expect(sections[0]).toBe("live-now");
    expect(screen.getByRole("link", { name: "Open Billing" })).toHaveAttribute("href", "/dashboard/billing");
    const hero = container.querySelector("header");
    expect(hero).toHaveTextContent("Existing $HermesOS holdings can qualify for compute access");
    expect(hero).toHaveTextContent("$HIVRA is the planned successor. It has not launched and is not trading.");
    expect(container.textContent).not.toMatch(/nothing is trading yet|two platform tokens on Base/);
    expect(container.textContent?.match(/optional/gi)).toHaveLength(1);
    expect(container).toHaveTextContent("Card billing and self-hosting do not require tokens.");
    expect(screen.getByRole("heading", { name: "Token launch in preparation" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the official claim" })).not.toBeInTheDocument();
  });

  it("keeps utility and launch proposals hidden for a restricted viewer", () => {
    const { container } = render(<TokenPageClient entries={getTokenPageEntries()} geoNotice="Token features aren't available here." />);
    expect(container.textContent).not.toMatch(/holdings can qualify|one way to qualify|planned successor/);
    expect(screen.queryByRole("heading", { name: "What $HIVRA is" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Existing holder access" })).toBeInTheDocument();
  });
});
