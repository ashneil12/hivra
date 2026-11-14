/** @jest-environment jsdom */
/**
 * A lock wallet that holds only $HIVRA (the airdrop landed on a Hivra-held
 * wallet whose $HermesOS is gone) shows its $HIVRA withdraw and nothing from
 * the $HermesOS flow: no legacy intro, no deposit row, no dead $HermesOS
 * withdraw. A lock wallet holding $HermesOS keeps the legacy panels.
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

function mockFetch(holdsHermes: boolean) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/billing/bankr/wallet") return json({ success: true, data: walletPayload(holdsHermes) });
    if (url === "/api/billing/bankr/wallet/withdraw-address") return json({ success: true, data: { address: RECIPIENT } });
    if (url === "/api/billing/wallet/quote") return json({ success: true, data: { pro: null, power: null } });
    if (url === "/api/billing/wallet/eligibility") return json({ success: false }, 404);
    return json({ success: true, data: {} });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  goLive();
  (loadAgentWalletsFromApi as jest.Mock).mockResolvedValue({ totalAgents: 0, cards: [] });
});

it("a lock wallet holding only $HIVRA shows only the $HIVRA withdraw", async () => {
  mockFetch(false);
  render(<WalletPage />);

  expect(await screen.findByText("Withdraw $HIVRA")).toBeInTheDocument();
  expect(await screen.findByText(/This wallet holds 3\.5 \$HIVRA/)).toBeInTheDocument();
  expect(screen.queryByText("Withdraw")).not.toBeInTheDocument();
  expect(screen.queryByText("Deposit")).not.toBeInTheDocument();
  expect(screen.queryByText(/you don.t need to connect an external wallet/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Deposit quotes")).not.toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith("/api/billing/bankr/wallet/withdraw-address", expect.anything());
});

it("a lock wallet holding both tokens keeps the $HermesOS withdraw and adds the $HIVRA one", async () => {
  mockFetch(true);
  render(<WalletPage />);

  expect(await screen.findByText("Withdraw $HIVRA")).toBeInTheDocument();
  expect(screen.getByText("Withdraw")).toBeInTheDocument();
  expect(screen.getByText(/you don.t need to connect an external wallet/i)).toBeInTheDocument();
});
