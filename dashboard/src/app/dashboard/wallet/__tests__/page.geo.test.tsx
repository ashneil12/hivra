/** @jest-environment jsdom */
/**
 * The wallet page under the token geo-policy (UKG-05). A blocked user with no
 * token holding sees the notice and their agent wallets, not the screens that
 * invite a new token action: the "Your $HermesOS wallet" headline, verify a wallet
 * to qualify, lock a price, the tier thresholds, the hold-to-unlock prompt and the
 * deposit row. A blocked user who already holds token access keeps every panel
 * (verifying, unlocking and withdrawing never stop). A viewer the server allows
 * sees the page as before.
 *
 * It runs against the COMMITTED country list and the real hook, and only the
 * server's answer (GET /api/token-geo) is faked: the route itself is tested
 * against the same list in api/token-geo/__tests__/route.test.ts.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import { _resetTokenGeoAccessForTests } from "@/hooks/useTokenGeoAccess";
import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import WalletPage from "../page";
import { loadAgentWalletsFromApi } from "../agent-wallet-data";

jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => ({ get: () => null }),
}));
jest.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));
jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ address }: { address: string }) => <div data-testid="local-address-qr">{address}</div>,
}));
jest.mock("../agent-wallet-data", () => ({
  loadAgentWalletsFromApi: jest.fn(),
  agentWalletApiBase: (instance: { id: string; lane?: string }) =>
    instance.lane === "hivra"
      ? `/api/hivra/agents/${instance.id}/bankr-wallet`
      : `/api/instances/${instance.id}/bankr-wallet`,
}));

const GB_NOTICE = "Token features aren't available to people in the United Kingdom.";

const selfCustodyWallet = {
  success: true,
  data: {
    status: "self_custody_required",
    custodyMode: "self_custody",
    wallet: null,
    depositWallet: null,
    creditDepositWallet: null,
    tokenLockWallet: null,
  },
};
// Legacy custody with no token lock wallet: a user who only has a credit deposit address.
const legacyWithoutLockWallet = {
  success: true,
  data: {
    status: "ready",
    custodyMode: "legacy_custody",
    wallet: null,
    depositWallet: null,
    creditDepositWallet: {
      address: "0x000000000000000000000000000000000000c0de",
      normalizedAddress: "0x000000000000000000000000000000000000c0de",
      bankrWalletId: null,
    },
    tokenLockWallet: null,
  },
};
const tierState = (threshold: string) => ({
  currentlyEligible: false,
  qualifyingQuantity: null,
  qualifyingQuantityDisplay: null,
  thresholdAtQualification: null,
  qualifiedAt: null,
  lastBreachAt: null,
  currentThreshold: threshold,
  currentThresholdDisplay: threshold,
});
const eligibility = {
  success: true,
  data: {
    tokenSymbol: "HERMESOS",
    tokenDecimals: 18,
    balance: null,
    thresholds: { configured: true, proRaw: "100", proDisplay: "100", powerRaw: "200", powerDisplay: "200" },
    tiers: { pro: tierState("100"), power: tierState("200") },
  },
};

const fetchMock = jest.fn();
let wallet: unknown = selfCustodyWallet;
let geoAnswer: () => Promise<Response>;

function json(data: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => data } as Response);
}
function geo(body: unknown) {
  geoAnswer = () => json(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetTokenGeoAccessForTests();
  wallet = selfCustodyWallet;
  (loadAgentWalletsFromApi as jest.Mock).mockResolvedValue({ totalAgents: 0, cards: [] });
  global.fetch = fetchMock as typeof fetch;
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (url === "/api/token-geo") return geoAnswer();
    if (url === "/api/billing/bankr/wallet" && method === "GET") return json(wallet);
    if (url === "/api/billing/wallet/eligibility" && method === "GET") return json(eligibility);
    if (url === "/api/billing/wallet/quote" && method === "GET") {
      return json({ success: true, data: { pro: null, power: null } });
    }
    if (url === "/api/billing/bankr/wallet/withdraw-address" && method === "GET") {
      return json({ success: true, data: { address: null } });
    }
    return json({ success: true, data: {} });
  });
});

async function renderLoaded() {
  render(<WalletPage />);
  // The wallet and eligibility reads have landed once the agent wallets section shows.
  await screen.findByLabelText("Agent wallets");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/billing/wallet/eligibility", { method: "GET" }));
  await screen.findByRole("heading", { level: 1 });
}

function expectNoTokenInvitation() {
  expect(screen.queryByText(/\$HermesOS/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /connect wallet/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Wallet verification")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Tier eligibility")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Deposit quotes")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Unlock a token tier")).not.toBeInTheDocument();
  expect(screen.queryByText(/hold at least/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/lock .* price/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/buy on uniswap/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /re-check holdings and unlock compute now/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/mint a deposit quote/i)).not.toBeInTheDocument();
}

describe("the committed country list (GB)", () => {
  it("is what the page reads: GB is listed and the policy is active", () => {
    expect(TOKEN_GEO_POLICY.blockedCountries).toContain("GB");
  });

  it("shows a blocked user with no holding the notice and their agent wallets, with no token invitation (self-custody)", async () => {
    geo({ blocked: true, notice: GB_NOTICE, existingAccess: false });
    await renderLoaded();

    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your wallets.");
    expect(screen.getByLabelText("Agent wallets")).toBeInTheDocument();
    expectNoTokenInvitation();
  });

  it("does the same for legacy custody with no lock wallet, and keeps the withdraw destination", async () => {
    wallet = legacyWithoutLockWallet;
    geo({ blocked: true, notice: GB_NOTICE, existingAccess: false });
    await renderLoaded();

    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.getByLabelText("Wallet actions")).toBeInTheDocument();
    expect(screen.getByText("Withdraw destination")).toBeInTheDocument();
    expect(screen.queryByText("Deposit")).not.toBeInTheDocument();
    expectNoTokenInvitation();
    expect(screen.queryByText(/you don.t need to connect an external wallet/i)).not.toBeInTheDocument();
  });

  it("hides the token panels while the server has not answered, and when it cannot", async () => {
    geoAnswer = () => json(null, 500);
    await renderLoaded();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/token-geo", { cache: "no-store" }));
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
    expectNoTokenInvitation();
  });

  it("keeps every panel for a blocked user who already holds token access, with the notice and no buy card", async () => {
    geo({ blocked: true, notice: GB_NOTICE, existingAccess: true });
    await renderLoaded();

    expect(await screen.findByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your $HermesOS wallet.");
    expect(screen.getByLabelText("Tier eligibility")).toBeInTheDocument();
    expect(screen.getByLabelText("Unlock a token tier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-check holdings and unlock compute now/i })).toBeInTheDocument();
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    // Buying the token is a new action, so the card stays away from a blocked holder too.
    expect(screen.queryByText(/buy on uniswap/i)).not.toBeInTheDocument();
  });

  it("keeps the legacy deposit and withdraw screens for a blocked user who has a token lock wallet", async () => {
    wallet = {
      success: true,
      data: {
        ...legacyWithoutLockWallet.data,
        tokenLockWallet: {
          address: "0x000000000000000000000000000000000000beef",
          normalizedAddress: "0x000000000000000000000000000000000000beef",
        },
      },
    };
    geo({ blocked: true, notice: GB_NOTICE, existingAccess: true });
    await renderLoaded();

    expect(await screen.findByLabelText("Deposit quotes")).toBeInTheDocument();
    expect(screen.getByText("Deposit")).toBeInTheDocument();
    expect(screen.getByText("Withdraw destination")).toBeInTheDocument();
    expect(screen.getByText(/you don.t need to connect an external wallet/i)).toBeInTheDocument();
  });

  it("shows the whole page, with the buy card and no notice, to a viewer the server allows", async () => {
    geo({ blocked: false, notice: null });
    await renderLoaded();

    expect(await screen.findByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your $HermesOS wallet.");
    expect(screen.getByLabelText("Tier eligibility")).toBeInTheDocument();
    expect(screen.getByLabelText("Buy $HermesOS")).toBeInTheDocument();
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
  });
});

describe("the dormant policy (no country listed)", () => {
  it("shows the whole page and asks the server nothing", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []);
    await renderLoaded();

    expect(await screen.findByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your $HermesOS wallet.");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/token-geo", expect.anything());
    jest.restoreAllMocks();
  });
});
