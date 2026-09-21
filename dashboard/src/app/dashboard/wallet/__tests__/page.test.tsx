/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import WalletPage from "../page";
import { loadAgentWalletsFromApi } from "../agent-wallet-data";

const mockReplace = jest.fn();
const mockSearchParamsGet = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

jest.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ address }: { address: string }) => (
    <div data-testid="local-address-qr">{address}</div>
  ),
}));

jest.mock("../agent-wallet-data", () => ({
  loadAgentWalletsFromApi: jest.fn(),
  // Real implementation: lane-aware wallet route base (hermes vs hivra).
  agentWalletApiBase: (instance: { id: string; lane?: string }) =>
    instance.lane === "hivra"
      ? `/api/hivra/agents/${instance.id}/bankr-wallet`
      : `/api/instances/${instance.id}/bankr-wallet`,
}));

describe("WalletPage custody migration", () => {
  const fetchMock = jest.fn();
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
  const eligibility = {
    success: true,
    data: {
      tokenSymbol: "HERMESOS",
      tokenDecimals: 18,
      balance: null,
      thresholds: {
        configured: true,
        proRaw: "100",
        proDisplay: "100",
        powerRaw: "200",
        powerDisplay: "200",
      },
      tiers: {
        pro: {
          currentlyEligible: false,
          qualifyingQuantity: null,
          qualifyingQuantityDisplay: null,
          thresholdAtQualification: null,
          qualifiedAt: null,
          lastBreachAt: null,
          currentThreshold: "100",
          currentThresholdDisplay: "100",
        },
        power: {
          currentlyEligible: false,
          qualifyingQuantity: null,
          qualifyingQuantityDisplay: null,
          thresholdAtQualification: null,
          qualifiedAt: null,
          lastBreachAt: null,
          currentThreshold: "200",
          currentThresholdDisplay: "200",
        },
      },
    },
  };
  const proQuote = {
    id: "quote_pro",
    tier: "pro",
    thresholdTierCode: "PRO_LAUNCH",
    epoch: "launch",
    usdTargetCents: 9900,
    priceUsdAtQuote: "0.000001",
    tokensRequiredRaw: "100000000000000000000",
    tokensRequiredDisplay: "100",
    tokenSymbol: "HERMESOS",
    tokenDecimals: 18,
    quotedAt: "2026-05-12T12:00:00.000Z",
    expiresAt: "2026-05-12T12:20:00.000Z",
    status: "active",
    source: "dexscreener",
  };
  const powerQuote = {
    ...proQuote,
    id: "quote_power",
    tier: "power",
    thresholdTierCode: "POWER_LAUNCH",
    usdTargetCents: 19900,
    tokensRequiredRaw: "200000000000000000000",
    tokensRequiredDisplay: "200",
  };

  function json(data: unknown, status = 200) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    } as Response);
  }

  function requestUrl(input: RequestInfo | URL) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.method) return init.method;
    if (typeof input !== "string" && !(input instanceof URL) && "method" in input) {
      return input.method;
    }
    return "GET";
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSearchParamsGet.mockReturnValue(null);
    (loadAgentWalletsFromApi as jest.Mock).mockResolvedValue({ totalAgents: 0, cards: [] });
    global.fetch = fetchMock as typeof fetch;
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      if (url === "/api/billing/bankr/wallet" && method === "GET") {
        return json(selfCustodyWallet);
      }
      if (url === "/api/billing/wallet/eligibility" && method === "GET") {
        return json(eligibility);
      }
      if (url === "/api/billing/wallet/quote" && method === "GET") {
        return json({ success: true, data: { pro: null, power: null } });
      }
      if (url === "/api/billing/bankr/wallet/withdraw-address" && method === "GET") {
        return json({ success: true, data: { address: null } });
      }
      if (url === "/api/billing/wallet/challenge" && method === "POST") {
        return json({
          success: true,
          data: {
            challengeId: "challenge_123",
            message: "Sign in to Hivra",
            expiresAt: "2026-05-12T12:00:00.000Z",
          },
        });
      }
      if (url === "/api/billing/wallet/verify" && method === "POST") {
        return json({
          success: true,
          data: {
            wallet: {
              id: "wallet_123",
              address: "0x000000000000000000000000000000000000abcd",
              normalizedAddress: "0x000000000000000000000000000000000000abcd",
              chainId: 8453,
              verifiedAt: "2026-05-12T12:00:01.000Z",
            },
          },
        });
      }
      if (url === "/api/billing/wallet/refresh" && method === "POST") {
        return json({ success: true, data: { refresh: { status: "refreshed" } } });
      }
      return json({ success: true, data: {} });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows sign-to-verify for self-custody users without deposit or withdraw UI", async () => {
    render(<WalletPage />);

    expect(await screen.findByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Deposit quotes")).not.toBeInTheDocument();
    expect(screen.queryByText("Withdraw destination")).not.toBeInTheDocument();
    expect(await screen.findAllByText(/hold at least/i)).toHaveLength(2);
    expect(screen.queryByText(/deposit at least/i)).not.toBeInTheDocument();

    const bankrPosts = fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input as RequestInfo | URL) === "/api/billing/bankr/wallet" &&
        requestMethod(input as RequestInfo | URL, init as RequestInit | undefined) === "POST"
    );
    expect(bankrPosts).toHaveLength(0);
  });

  it("creates an agent wallet only after the explicit create-wallet click", async () => {
    (loadAgentWalletsFromApi as jest.Mock).mockResolvedValueOnce({
      totalAgents: 1,
      cards: [{
        instance: { id: "inst_lazy", name: "Lazy Agent", status: "running", provider: "openai" },
        wallet: null,
        balance: null,
        balances: [],
        balanceFailed: false,
      }],
    });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      if (url === "/api/billing/bankr/wallet" && method === "GET") return json(selfCustodyWallet);
      if (url === "/api/billing/wallet/eligibility" && method === "GET") return json(eligibility);
      if (url === "/api/billing/wallet/quote" && method === "GET") {
        return json({ success: true, data: { pro: null, power: null } });
      }
      if (url === "/api/instances/inst_lazy/bankr-wallet" && method === "POST") {
        return json({
          success: true,
          data: {
            wallet: {
              evmAddress: "0x000000000000000000000000000000000000ba5e",
              bankrWalletId: "wlt_instance",
              status: "active",
              withdrawalDestinationEvm: null,
              apiKeyStatus: "active",
            },
          },
        });
      }
      return json({ success: true, data: {} });
    });

    const { container } = render(<WalletPage />);

    const createButton = await screen.findByRole("button", { name: /create wallet/i });
    expect(fetchMock.mock.calls.some(([input, init]) => (
      requestUrl(input as RequestInfo | URL) === "/api/instances/inst_lazy/bankr-wallet" &&
      requestMethod(input as RequestInfo | URL, init as RequestInit | undefined) === "POST"
    ))).toBe(false);

    await act(async () => {
      fireEvent.click(createButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances/inst_lazy/bankr-wallet",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(await screen.findByText("0x000000000000000000000000000000000000ba5e")).toBeInTheDocument();
    const shortAddress = screen.getByText("0x0000…ba5e");
    expect(shortAddress).toHaveClass("agent-wallet-address-short");
    expect(shortAddress).not.toHaveStyle({ display: "none" });
    expect(container.querySelector("style[jsx]")).toBeNull();
  });

  it("shields live wallet addresses and balance grids from page translators", async () => {
    // Google Translate rewrites text nodes into <font> wrappers; on the next
    // balance refresh React's insertBefore/removeChild then throws
    // NotFoundError (seen live on /dashboard/wallet). The live-updating
    // numeric/address containers opt out via translate="no" + .notranslate.
    (loadAgentWalletsFromApi as jest.Mock).mockResolvedValueOnce({
      totalAgents: 1,
      cards: [{
        instance: { id: "inst_translate", name: "Translate Agent", status: "running", provider: "openai" },
        wallet: {
          evmAddress: "0x000000000000000000000000000000000000ba5e",
          bankrWalletId: "wlt_instance",
          status: "active",
          withdrawalDestinationEvm: null,
          apiKeyStatus: "active",
        },
        balance: { tokenSymbol: "ETH", balanceDisplay: "0.010000" },
        balances: [
          { tokenSymbol: "ETH", balanceDisplay: "0.010000", chain: "Base", tokenAddress: null, tokenDecimals: 18 },
          { tokenSymbol: "USDC", balanceDisplay: "12.5", chain: "Base", tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tokenDecimals: 6 },
        ],
        withdrawalRecipients: [],
        balanceFailed: false,
      }],
    });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      if (url === "/api/billing/bankr/wallet" && method === "GET") return json(selfCustodyWallet);
      if (url === "/api/billing/wallet/eligibility" && method === "GET") return json(eligibility);
      if (url === "/api/billing/wallet/quote" && method === "GET") {
        return json({ success: true, data: { pro: null, power: null } });
      }
      return json({ success: true, data: {} });
    });

    render(<WalletPage />);

    const fullAddress = await screen.findByText("0x000000000000000000000000000000000000ba5e");
    expect(fullAddress).toHaveAttribute("translate", "no");
    expect(fullAddress).toHaveClass("notranslate");

    const headlineGrid = screen.getByLabelText("Primary Base balances");
    expect(headlineGrid).toHaveAttribute("translate", "no");
    expect(headlineGrid).toHaveClass("notranslate");

    const tokenGrid = screen.getByLabelText("Base token balances");
    expect(tokenGrid).toHaveAttribute("translate", "no");
    expect(tokenGrid).toHaveClass("notranslate");
  });

  it("lets users withdraw a selected Base token to a recent recipient", async () => {
    const primaryDestination = "0x1111111111111111111111111111111111111111";
    const recentRecipient = "0x2222222222222222222222222222222222222222";
    const usdcAddress = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    (loadAgentWalletsFromApi as jest.Mock).mockResolvedValueOnce({
      totalAgents: 1,
      cards: [{
        instance: { id: "inst_withdraw", name: "Withdrawal Agent", status: "running", provider: "openai" },
        wallet: {
          evmAddress: "0x000000000000000000000000000000000000ba5e",
          bankrWalletId: "wlt_instance",
          status: "active",
          withdrawalDestinationEvm: primaryDestination,
          apiKeyStatus: "active",
        },
        balance: { tokenSymbol: "ETH", balanceDisplay: "0.010000" },
        balances: [
          { tokenSymbol: "ETH", balanceDisplay: "0.010000", chain: "Base", tokenAddress: null, tokenDecimals: 18 },
          { tokenSymbol: "USDC", balanceDisplay: "12.5", chain: "Base", tokenAddress: usdcAddress, tokenDecimals: 6 },
          { tokenSymbol: "HERMESOS", balanceDisplay: "10000000", chain: "Base", tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3", tokenDecimals: 18 },
        ],
        withdrawalRecipients: [
          {
            id: "recipient_1",
            address: primaryDestination,
            normalizedAddress: primaryDestination,
            label: null,
            isPrimary: true,
            useCount: 3,
            lastUsedAt: "2026-05-19T07:30:00.000Z",
          },
          {
            id: "recipient_2",
            address: recentRecipient,
            normalizedAddress: recentRecipient,
            label: null,
            isPrimary: false,
            useCount: 1,
            lastUsedAt: "2026-05-19T08:30:00.000Z",
          },
        ],
        balanceFailed: false,
      }],
    });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      if (url === "/api/billing/bankr/wallet" && method === "GET") return json(selfCustodyWallet);
      if (url === "/api/billing/wallet/eligibility" && method === "GET") return json(eligibility);
      if (url === "/api/billing/wallet/quote" && method === "GET") {
        return json({ success: true, data: { pro: null, power: null } });
      }
      if (url === "/api/instances/inst_withdraw/bankr-wallet/withdraw" && method === "POST") {
        return json({
          success: true,
          data: {
            status: "submitted",
            txHash: "0xwithdraw",
            asset: "USDC",
            amountDisplay: "2.5",
            recipientAddress: recentRecipient,
            wallet: {
              evmAddress: "0x000000000000000000000000000000000000ba5e",
              bankrWalletId: "wlt_instance",
              status: "active",
              withdrawalDestinationEvm: recentRecipient,
              apiKeyStatus: "active",
            },
          },
        });
      }
      return json({ success: true, data: {} });
    });

    render(<WalletPage />);

    fireEvent.click(await screen.findByRole("button", { name: /withdraw on base/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/base network only/i);
    expect(dialog).toHaveTextContent(/gas sponsorship covers/i);
    expect(dialog).toHaveTextContent(primaryDestination);
    expect(dialog).toHaveTextContent(recentRecipient);
    expect(within(dialog).getByLabelText(/amount to withdraw/i)).toHaveValue("0.010000");

    fireEvent.change(within(dialog).getByLabelText(/token/i), { target: { value: usdcAddress } });
    const amountInput = within(dialog).getByLabelText(/amount to withdraw/i);
    expect(amountInput).toHaveValue("12.5");
    fireEvent.change(amountInput, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(recentRecipient, "i") }));
    fireEvent.click(screen.getByLabelText(/set as primary/i));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, withdraw/i }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances/inst_withdraw/bankr-wallet/withdraw",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            amount: "2.5",
            recipientAddress: recentRecipient,
            token: {
              symbol: "USDC",
              tokenAddress: usdcAddress,
              decimals: 6,
              chain: "Base",
            },
            setPrimaryRecipient: true,
          }),
        })
      );
    });
    expect(await screen.findByText(/withdraw submitted/i)).toBeInTheDocument();
    expect(screen.getByText(/2.5 USDC withdrawal/i)).toBeInTheDocument();
  });

  it("renders self-custody wallet details in Chinese when the locale is Chinese", async () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <WalletPage />
      </LocaleProvider>
    );

    expect(await screen.findByRole("button", { name: "连接钱包" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("你的 $HermesOS 钱包。");
    expect(screen.getByText("钱包 · 签名验证")).toBeInTheDocument();
    expect(await screen.findAllByText(/至少持有/i)).toHaveLength(2);
    expect(screen.getByText("Agent 钱包。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^connect wallet$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/hold at least/i)).not.toBeInTheDocument();
  });

  it("renders self-custody wallet details in Japanese when that locale is selected", async () => {
    render(
      <LocaleProvider initialLocale="ja">
        <WalletPage />
      </LocaleProvider>
    );

    expect(await screen.findByRole("button", { name: "ウォレットを接続" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("あなたの $HermesOS ウォレット。");
    expect(screen.getByText("ウォレット · 署名確認")).toBeInTheDocument();
    expect(await screen.findAllByText(/少なくとも保持/i)).toHaveLength(2);
    expect(screen.getByText("エージェントウォレット。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^connect wallet$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/hold at least/i)).not.toBeInTheDocument();
  });

  it("connects and signs a wallet for self-custody verification", async () => {
    const ethereumRequest = jest
      .fn()
      .mockResolvedValueOnce(["0x000000000000000000000000000000000000abcd"])
      .mockResolvedValueOnce("0xsigned");
    (window as unknown as { ethereum: { request: jest.Mock } }).ethereum = {
      request: ethereumRequest,
    };

    render(<WalletPage />);

    fireEvent.click(await screen.findByRole("button", { name: /connect wallet/i }));

    await waitFor(() => {
      expect(ethereumRequest).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
      expect(ethereumRequest).toHaveBeenCalledWith({
        method: "personal_sign",
        params: ["Sign in to Hivra", "0x000000000000000000000000000000000000abcd"],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/billing/wallet/verify",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            challengeId: "challenge_123",
            signature: "0xsigned",
          }),
        })
      );
    });

    expect(await screen.findByText(/wallet connected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^connect wallet$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /lock pro price/i })).toBeInTheDocument();
  });

  it("asks the wallet for accounts even when the provider reports disconnected before permission", async () => {
    const ethereumRequest = jest
      .fn()
      .mockResolvedValueOnce(["0x000000000000000000000000000000000000abcd"])
      .mockResolvedValueOnce("0xsigned");
    (window as unknown as { ethereum: { isConnected: () => boolean; request: jest.Mock } }).ethereum = {
      isConnected: () => false,
      request: ethereumRequest,
    };

    render(<WalletPage />);

    fireEvent.click(await screen.findByRole("button", { name: /connect wallet/i }));

    await waitFor(() => {
      expect(ethereumRequest).toHaveBeenNthCalledWith(1, { method: "eth_requestAccounts" });
      expect(ethereumRequest).toHaveBeenNthCalledWith(2, {
        method: "personal_sign",
        params: ["Sign in to Hivra", "0x000000000000000000000000000000000000abcd"],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/billing/wallet/verify",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("locks the Pro price for a connected self-custody wallet before refreshing balance", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      if (url === "/api/billing/bankr/wallet" && method === "GET") {
        return json(selfCustodyWallet);
      }
      if (url === "/api/billing/wallet/eligibility" && method === "GET") {
        return json({
          ...eligibility,
          data: {
            ...eligibility.data,
            balance: {
              balanceRaw: "50000000000000000000000",
              balanceDisplay: "50,000",
              capturedAt: "2026-05-12T12:00:00.000Z",
              walletAddress: "0x000000000000000000000000000000000000abcd",
              normalizedWalletAddress: "0x000000000000000000000000000000000000abcd",
            },
          },
        });
      }
      if (url === "/api/billing/wallet/quote" && method === "GET") {
        return json({ success: true, data: { pro: null, power: null } });
      }
      if (url === "/api/billing/wallet/quote" && method === "POST") {
        return json({ success: true, data: proQuote });
      }
      if (url === "/api/billing/bankr/wallet/withdraw-address" && method === "GET") {
        return json({ success: true, data: { address: null } });
      }
      if (url === "/api/billing/wallet/refresh" && method === "POST") {
        return json({ success: true, data: { refresh: { status: "refreshed" } } });
      }
      return json({ success: true, data: {} });
    });

    render(<WalletPage />);

    expect(await screen.findByText(/wallet connected/i)).toBeInTheDocument();
    expect(screen.getByText("0x0000…abcd")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^connect wallet$/i })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /lock pro price/i }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/billing/wallet/quote",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ tier: "pro" }),
        })
      );
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/wallet/refresh", { method: "POST" });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/pro price locked/i);
  });

  it("locks the Power price next when the verified wallet already qualifies for Pro", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      if (url === "/api/billing/bankr/wallet" && method === "GET") {
        return json(selfCustodyWallet);
      }
      if (url === "/api/billing/wallet/eligibility" && method === "GET") {
        return json({
          ...eligibility,
          data: {
            ...eligibility.data,
            balance: {
              balanceRaw: "150000000000000000000",
              balanceDisplay: "150",
              capturedAt: "2026-05-12T12:00:00.000Z",
              walletAddress: "0x000000000000000000000000000000000000abcd",
              normalizedWalletAddress: "0x000000000000000000000000000000000000abcd",
            },
            tiers: {
              ...eligibility.data.tiers,
              pro: {
                ...eligibility.data.tiers.pro,
                currentlyEligible: true,
                qualifyingQuantity: "100000000000000000000",
                qualifyingQuantityDisplay: "100",
                thresholdAtQualification: "100000000000000000000",
                qualifiedAt: "2026-05-12T12:00:00.000Z",
              },
            },
          },
        });
      }
      if (url === "/api/billing/wallet/quote" && method === "GET") {
        return json({ success: true, data: { pro: null, power: null } });
      }
      if (url === "/api/billing/wallet/quote" && method === "POST") {
        return json({ success: true, data: powerQuote });
      }
      if (url === "/api/billing/bankr/wallet/withdraw-address" && method === "GET") {
        return json({ success: true, data: { address: null } });
      }
      if (url === "/api/billing/wallet/refresh" && method === "POST") {
        return json({ success: true, data: { refresh: { status: "refreshed" } } });
      }
      return json({ success: true, data: {} });
    });

    render(<WalletPage />);

    expect(await screen.findByRole("button", { name: /lock power price/i })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /lock power price/i }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/billing/wallet/quote",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ tier: "power" }),
        })
      );
    });
  });
});
