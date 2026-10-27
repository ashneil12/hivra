/** @jest-environment jsdom */
/**
 * $HIVRA in the wallet UI: the agent card headline and the lock-wallet
 * withdraw show $HIVRA only once this build knows $HIVRA as live, and only for
 * the $HIVRA contract. The $HERMESOS withdraw still posts the original body.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { AgentWalletCard, AgentWalletWithdrawModal } from "../AgentWalletCards";
import { WithdrawSection } from "../WithdrawSection";
import type { AgentWalletCardData } from "@/app/dashboard/wallet/agent-wallet-data";
import { agentHivraBalance, lockWalletHivraToShow } from "@/lib/wallet/format";

const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));
jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ label }: { label: string }) => <div data-testid="qr" aria-label={label} />,
}));
jest.mock("@/components/i18n/LocaleProvider", () => ({
  useLocale: () => ({ copy: { dashboard: { wallet: {} } }, locale: "en" }),
}));
jest.mock("@/lib/client/logger", () => ({ clientLog: { error: jest.fn(), warn: jest.fn() } }));
jest.mock("@clerk/nextjs", () => ({
  useReverification: (fetcher: (...args: unknown[]) => Promise<unknown>) => fetcher,
}));
jest.mock("@clerk/nextjs/errors", () => ({ isReverificationCancelledError: () => false }));

const HIVRA_PUBLISHED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const HIVRA_ADDRESS = HIVRA_PUBLISHED.toLowerCase();
const WALLET = "0x000000000000000000000000000000000000ba5e";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

function goLive() {
  mockLaunch.contractAddress = HIVRA_PUBLISHED;
  mockLaunch.poolId = `0x${"cd".repeat(32)}`;
  mockLaunch.activatesAt = "2026-01-01T00:00:00Z";
}

function card(): AgentWalletCardData {
  return {
    instance: { id: "inst_1", name: "Scout", status: "running", provider: "proxmox", lane: "hermes" },
    wallet: {
      evmAddress: WALLET,
      bankrWalletId: "bw_1",
      status: "active",
      withdrawalDestinationEvm: RECIPIENT,
      apiKeyStatus: "active",
    },
    balance: null,
    balances: [
      { tokenSymbol: "ETH", balanceDisplay: "0.010000", chain: "Base", tokenAddress: null, tokenDecimals: 18 },
      { tokenSymbol: "HIVRA", balanceDisplay: "42.5", chain: "Base", tokenAddress: HIVRA_ADDRESS, tokenDecimals: 18 },
    ],
    withdrawalRecipients: [],
    balanceFailed: false,
    balanceError: null,
  };
}

function cardProps() {
  return {
    onDeposit: jest.fn(),
    onManage: jest.fn(),
    onSetDestination: jest.fn(),
    onWithdraw: jest.fn(),
    onConnect: jest.fn(),
    onDisconnect: jest.fn(),
    onRefresh: jest.fn(),
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  mockLaunch.contractAddress = "";
  mockLaunch.poolId = "";
  mockLaunch.activatesAt = "";
});

describe("$HIVRA display helpers", () => {
  const lockHivra = { tokenAddress: HIVRA_ADDRESS, balanceDisplay: "3.5" };

  it("show nothing while $HIVRA is dormant, whatever a response carries", () => {
    expect(lockWalletHivraToShow(lockHivra)).toBeNull();
    expect(agentHivraBalance(card())).toBeNull();
  });

  it("once live, show only the $HIVRA contract and only a non-zero lock balance", () => {
    goLive();
    expect(lockWalletHivraToShow(lockHivra)).toBe(lockHivra);
    expect(lockWalletHivraToShow({ ...lockHivra, balanceDisplay: "0" })).toBeNull();
    expect(lockWalletHivraToShow({ ...lockHivra, tokenAddress: RECIPIENT })).toBeNull();
    expect(agentHivraBalance(card())?.balanceDisplay).toBe("42.5");
  });
});

describe("agent wallet card", () => {
  it("has no $HIVRA headline while $HIVRA is dormant", () => {
    render(<AgentWalletCard card={card()} {...cardProps()} />);
    expect(screen.queryByTestId("agent-wallet-headline-HIVRA")).not.toBeInTheDocument();
  });

  it("shows the $HIVRA headline once live", () => {
    goLive();
    render(<AgentWalletCard card={card()} {...cardProps()} />);
    expect(screen.getByTestId("agent-wallet-headline-HIVRA")).toHaveTextContent("42.5");
  });

  it("withdraws $HIVRA as the $HIVRA contract with the exact amount once live", async () => {
    goLive();
    const fetchMock = jest.fn(async () =>
      jsonResponse(200, { success: true, data: { asset: "HIVRA", amountDisplay: "42.5", txHash: "0xabc", wallet: null } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AgentWalletWithdrawModal card={card()} onClose={jest.fn()} onSubmitted={jest.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Withdraw on Base." });

    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: HIVRA_ADDRESS } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Yes, withdraw" }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("/api/instances/inst_1/bankr-wallet/withdraw");
    expect(JSON.parse(init.body)).toMatchObject({
      recipientAddress: RECIPIENT,
      amount: "42.5",
      token: { symbol: "HIVRA", tokenAddress: HIVRA_ADDRESS, decimals: 18, chain: "Base" },
    });
  });
});

describe("lock-wallet withdraw", () => {
  async function confirm() {
    fireEvent.click(screen.getByRole("button", { name: /withdraw all/i }));
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Yes, withdraw everything" }));
    });
    return dialog;
  }

  it("posts the original empty body for $HERMESOS", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(200, { success: true, data: { txHash: null, amountDisplay: "5", recipientAddress: RECIPIENT } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(
      <WithdrawSection
        tokenSymbol="HERMESOS"
        balanceDisplay="5"
        withdrawAddress={RECIPIENT}
        onWithdrew={jest.fn()}
        onRequestSetAddress={jest.fn()}
      />
    );
    expect(screen.getByText("Withdraw")).toBeInTheDocument();
    await confirm();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(init.body).toBe("{}");
  });

  it("posts asset HIVRA and names $HIVRA for the $HIVRA withdraw", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(200, { success: true, data: { txHash: null, amountDisplay: "3.5", recipientAddress: RECIPIENT } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(
      <WithdrawSection
        asset="HIVRA"
        tokenSymbol="HIVRA"
        balanceDisplay="3.5"
        withdrawAddress={RECIPIENT}
        onWithdrew={jest.fn()}
        onRequestSetAddress={jest.fn()}
      />
    );
    expect(screen.getByText("Withdraw $HIVRA")).toBeInTheDocument();
    expect(screen.getByText("This wallet holds 3.5 $HIVRA. Withdraw all of it to your saved withdraw address.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /withdraw all/i }));
    expect(screen.getByRole("dialog", { name: "Withdraw all $HIVRA" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Yes, withdraw everything" }));
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("/api/billing/bankr/wallet/withdraw");
    expect(JSON.parse(init.body)).toEqual({ asset: "HIVRA" });
    expect(screen.getByText(/3\.5 \$HIVRA sent to/)).toBeInTheDocument();
  });
});
