/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import TokenPageClient from "../TokenPageClient";
import { SUPPORT_DISCORD_URL } from "@/lib/support-channels";
import { formatLaunchInstantUtc, formatSnapshotDateUtc, getTokenPageEntries } from "@/lib/token-verification-content";
import { HIVRA_TOKEN_LAUNCH } from "@/lib/billing/hivra-token-launch";
import { dormantTokenPageEntries } from "@/test-utils/token-entries";

const mockCopy = jest.fn();
jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: (value: string) => mockCopy(value) }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The two blocks below cover the dormant layout (and the layout a blocked viewer reads), so they build
// dormant entries; the committed launch block is filled in and is covered in "with the committed launch".
describe("TokenPageClient contract address", () => {
  it("copies the full contract address and confirms it", async () => {
    mockCopy.mockResolvedValue(true);
    render(<TokenPageClient entries={dormantTokenPageEntries()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });

    expect(mockCopy).toHaveBeenCalledWith("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(screen.getByRole("button", { name: "Address copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Contract address copied");
  });

  it("tells the reader to select the address when the copy fails", async () => {
    mockCopy.mockResolvedValue(false);
    render(<TokenPageClient entries={dormantTokenPageEntries()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });

    expect(screen.getByRole("status")).toHaveTextContent(/select the address/i);
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
  });
});

describe("TokenPageClient impersonation and risk facts", () => {
  it("lists the official accounts with their exact handles, and says Hivra has no Telegram", () => {
    render(<TokenPageClient entries={dormantTokenPageEntries()} />);
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
    render(<TokenPageClient entries={dormantTokenPageEntries()} />);
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
    render(<TokenPageClient entries={dormantTokenPageEntries()} geoNotice="Token features aren't available here." />);
    expect(screen.getByRole("region", { name: "Official accounts" })).toBeInTheDocument();
    expect(screen.getByTestId("token-lookalike-warning")).toBeInTheDocument();
    expect(screen.getByTestId("token-risk-line")).toBeInTheDocument();
  });

  it("writes the new facts without dashes", () => {
    const { container } = render(<TokenPageClient entries={dormantTokenPageEntries()} />);
    for (const id of ["official-accounts"]) {
      expect(container.querySelector(`#${id}`)?.textContent).not.toMatch(/[–—]/);
    }
    expect(screen.getByTestId("token-lookalike-warning").textContent).not.toMatch(/[–—]/);
    expect(screen.getByTestId("token-risk-line").textContent).not.toMatch(/[–—]/);
  });
});

describe("TokenPageClient with the committed launch", () => {
  it("copies each official contract address from the launched page", async () => {
    mockCopy.mockResolvedValue(true);
    render(<TokenPageClient entries={getTokenPageEntries()} />);
    const buttons = screen.getAllByRole("button", { name: "Copy address" });
    const copied: string[] = [];
    for (const button of buttons) {
      mockCopy.mockClear();
      await act(async () => {
        fireEvent.click(button);
      });
      copied.push(mockCopy.mock.calls[0][0]);
    }
    expect(copied.sort()).toEqual([HIVRA_TOKEN_LAUNCH.contractAddress, "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3"].sort());
  });

  it("keeps the official channels, the no-Telegram line, the lookalike caution and the risk line", () => {
    render(<TokenPageClient entries={getTokenPageEntries()} />);
    expect(screen.getByRole("link", { name: "@HivraOS" })).toHaveAttribute("href", "https://x.com/HivraOS");
    expect(screen.getByRole("link", { name: "github.com/ashneil12/hivra" })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
    expect(screen.getByText("Hivra does not have an official Telegram group.")).toBeInTheDocument();
    expect(screen.getByText(/Be wary of lookalike tokens, fake claim sites and impersonators\./)).toBeInTheDocument();
    expect(screen.getByTestId("token-risk-line")).toHaveTextContent(/Cryptoassets can lose all their value\./);
  });
});

describe("TokenPageClient notes under the contracts, for a viewer the geo-policy blocks, once $HIVRA is on Base", () => {
  const HIVRA = "0x1111111111111111111111111111111111111111";
  const entry = (key: "hivra" | "hermesos", status: "live" | "legacy" | "scheduled", activatesAt: string | null) => ({
    key,
    label: key === "hivra" ? "$HIVRA" : "$HermesOS",
    status,
    contractAddress: key === "hivra" ? HIVRA : "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3",
    basescanUrl: "https://basescan.org/token/x",
    activatesAt,
  });

  it.each([
    ["active", [entry("hivra", "live", "2026-01-01T00:00:00.000Z"), entry("hermesos", "legacy", null)]],
    ["scheduled", [entry("hermesos", "live", null), entry("hivra", "scheduled", "2099-10-01T16:00:00.000Z")]],
  ] as const)("never say new accounts use $HIVRA, or when Hivra starts to (%s)", (_phase, entries) => {
    const { container } = render(<TokenPageClient entries={[...entries]} geoNotice="Token features aren't available here." />);
    const text = container.textContent ?? "";
    expect(text).toContain("The $HIVRA contract.");
    expect(text).not.toMatch(/new accounts use|New token payments and holdings use it|starts using it|switch time|\$HIVRA has not launched/i);
  });

  it("still tells a holder of the legacy token that accounts which used it can keep using it", () => {
    render(<TokenPageClient entries={[entry("hivra", "live", null), entry("hermesos", "legacy", null)]} geoNotice="Token features aren't available here." />);
    expect(screen.getByText("The legacy $HermesOS contract. Accounts that used it before $HIVRA launched can keep using it.")).toBeInTheDocument();
  });
});

describe("formatSnapshotDateUtc", () => {
  it("writes the day of a UTC instant, not the time, the same way on server and client", () => {
    expect(formatSnapshotDateUtc("2026-10-20T16:00:00.000Z")).toBe("20 October 2026");
    // A late UTC evening stays on its UTC day, whatever the viewer's time zone.
    expect(formatSnapshotDateUtc("2026-12-31T23:59:59.000Z")).toBe("31 December 2026");
    expect(formatSnapshotDateUtc("not a date")).toBe("not a date");
  });
});

describe("formatLaunchInstantUtc", () => {
  it("writes a UTC instant the same way on server and client", () => {
    expect(formatLaunchInstantUtc("2026-10-01T16:00:00.000Z")).toBe("1 October 2026, 16:00 UTC");
    expect(formatLaunchInstantUtc("2026-12-31T09:05:07.000Z")).toBe("31 December 2026, 09:05:07 UTC");
    expect(formatLaunchInstantUtc("not a date")).toBe("not a date");
  });
});

