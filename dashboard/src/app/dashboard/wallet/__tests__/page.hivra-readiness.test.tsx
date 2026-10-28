/** @jest-environment jsdom */
/**
 * The wallet page while new $HIVRA tiers are off (eligibility answers
 * reason "hivra_not_ready"): it says token payments aren't available yet,
 * offers no new price lock, and keeps withdrawals. A real price outage keeps
 * its own message.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import WalletPage from "../page";
import { loadAgentWalletsFromApi } from "../agent-wallet-data";

const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
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
  agentWalletApiBase: (instance: { id: string }) => `/api/instances/${instance.id}/bankr-wallet`,
}));

const HIVRA_PUBLISHED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const LOCK = "0x000000000000000000000000000000000000beef";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

function goLive() {
  mockLaunch.contractAddress = HIVRA_PUBLISHED;
  mockLaunch.poolId = `0x${"cd".repeat(32)}`;
  mockLaunch.activatesAt = "2026-01-01T00:00:00Z";
}

function json(data: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => data } as Response);
}

function walletPayload(holdsHermes: boolean) {
  return {
    status: holdsHermes ? "existing" : "self_custody_required",
    custodyMode: holdsHermes ? "legacy_custody" : "self_custody",
    wallet: null,
    depositWallet: null,
    creditDepositWallet: null,
    tokenLockWallet: { address: LOCK, normalizedAddress: LOCK },
    tokenLockHivra: {
      tokenSymbol: "HIVRA",
      tokenAddress: HIVRA_PUBLISHED.toLowerCase(),
      tokenDecimals: 18,
      balanceRaw: "3500000000000000000",
      balanceDisplay: "3.5",
    },
    tokenLockHoldsHermes: holdsHermes,
  };
}

function mockFetch(eligibility: { status: number; body: unknown }) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/billing/bankr/wallet") return json({ success: true, data: walletPayload(true) });
    if (url === "/api/billing/bankr/wallet/withdraw-address") return json({ success: true, data: { address: RECIPIENT } });
    if (url === "/api/billing/wallet/quote") return json({ success: true, data: { pro: null, power: null } });
    if (url === "/api/billing/wallet/eligibility") return json(eligibility.body, eligibility.status);
    return json({ success: true, data: {} });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  goLive();
  (loadAgentWalletsFromApi as jest.Mock).mockResolvedValue({ totalAgents: 0, cards: [] });
});

it("says token payments aren't available yet and offers no new price lock, keeping withdrawals", async () => {
  mockFetch({
    status: 503,
    body: { success: false, error: "Token payments aren't available yet.", reason: "hivra_not_ready" },
  });
  render(<WalletPage />);

  expect(await screen.findByText("Token payments aren't available yet.")).toBeInTheDocument();
  expect(screen.queryByText(/Token price unavailable/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Deposit quotes")).not.toBeInTheDocument();
  expect(screen.getByText("Withdraw $HIVRA")).toBeInTheDocument();
});

it("keeps the price-outage message and the price lock for a real outage", async () => {
  mockFetch({ status: 503, body: { success: false, error: "Token price unavailable — please try again later." } });
  render(<WalletPage />);

  expect(await screen.findByText("Token price unavailable — please try again later.")).toBeInTheDocument();
  expect(screen.queryByText("Token payments aren't available yet.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Deposit quotes")).toBeInTheDocument();
});
