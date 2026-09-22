/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import BillingPage from "../page";

const mockGet = jest.fn();
const mockReplace = jest.fn();
const mockRouter = {
  replace: mockReplace,
};
const mockSearchParams = {
  get: mockGet,
};
// Next's router hands out a NEW searchParams object whenever the URL changes
// (including window.history.replaceState); tests can swap it here.
const mockSearchParamsHolder: { current: { get: (key: string) => string | null } } = {
  current: mockSearchParams,
};

jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParamsHolder.current,
}));

jest.mock("framer-motion", () => {
  // The motion.* components animate via DOM events that JSDOM doesn't
  // implement. For test purposes we strip the motion-only props (whileHover,
  // whileTap, layout, layoutId, etc.) and forward whatever's left to the
  // matching plain HTML element.
  const MOTION_ONLY_PROPS = new Set([
    "whileHover",
    "whileTap",
    "whileFocus",
    "whileDrag",
    "whileInView",
    "initial",
    "animate",
    "exit",
    "variants",
    "transition",
    "layout",
    "layoutId",
    "drag",
  ]);
  function stripMotionProps<T extends Record<string, unknown>>(props: T): T {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (!MOTION_ONLY_PROPS.has(key)) out[key] = props[key];
    }
    return out as T;
  }

  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...rest }, ref) => (
      <div ref={ref} {...stripMotionProps(rest)}>
        {children}
      </div>
    )
  );
  MotionDiv.displayName = "MotionDiv";

  const MotionHeader = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    ({ children, ...rest }, ref) => (
      <header ref={ref} {...stripMotionProps(rest)}>
        {children}
      </header>
    )
  );
  MotionHeader.displayName = "MotionHeader";

  const MotionButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    ({ children, ...rest }, ref) => (
      <button ref={ref} {...stripMotionProps(rest)}>
        {children}
      </button>
    )
  );
  MotionButton.displayName = "MotionButton";

  return {
    motion: {
      div: MotionDiv,
      header: MotionHeader,
      button: MotionButton,
    },
    useReducedMotion: () => false,
  };
});

describe("BillingPage", () => {
  const fetchMock = jest.fn();
  const originalBillingV2Flag = process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
  const originalCryptoBillingFlag = process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
  const originalCreditTopUpsFlag = process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED;
  let usageData: Record<string, unknown>;
  let activityData: Record<string, unknown>;
  let tokenHoldingData: Record<string, unknown>;
  let tokenRefreshData: Record<string, unknown>;
  let managedVeniceSummaryData: Record<string, unknown>;

  function jsonResponse(data: Record<string, unknown>) {
    return {
      json: async () => ({
        success: true,
        data,
      }),
    } as Response;
  }

  function apiResponse(
    payload: Record<string, unknown>,
    init: { ok?: boolean; status?: number } = {}
  ) {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => payload,
    } as Response;
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
    mockGet.mockReset();
    mockGet.mockReturnValue(null);
    mockSearchParamsHolder.current = mockSearchParams;
    process.env.NEXT_PUBLIC_BILLING_V2_ENABLED = "true";
    process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED = "true";
    global.fetch = fetchMock as typeof fetch;
    delete (window as unknown as { ethereum?: unknown }).ethereum;

    usageData = {
      subscribed: true,
      plan: {
        key: "fleet",
        name: "Fleet",
        price: 29,
        maxAgents: 3,
        totalCpu: 8,
        totalRam: 16384,
        status: "active",
        currentPeriodEnd: null,
      },
      usage: {
        agentCount: 1,
        maxAgents: 3,
        usedCpu: 2,
        totalCpu: 8,
        usedRam: 4096,
        totalRam: 16384,
        instances: [
          {
            id: "inst-123",
            name: "Agent One",
            status: "running",
            cpu: 2,
            ram: 4096,
            backups_enabled: false,
          },
        ],
      },
      credits: {
        balance: 2450,
        monthlyGrant: 3480,
        unit: "100 credits = $1",
      },
    };

    activityData = {
      creditLedgerEntries: [
        {
          id: "ledger_1",
          amountCredits: 1000,
          source: "stripe",
          actor: "stripe_webhook",
          reason: "stripe_topup",
          referenceId: "cs_1",
          createdAt: "2026-04-24T13:00:00.000Z",
        },
        {
          id: "ledger_2",
          amountCredits: -75,
          source: "system",
          actor: "llm_gateway",
          reason: "llm_debit",
          referenceId: "llm:chat_1:turn_1",
          createdAt: "2026-04-24T13:30:00.000Z",
        },
      ],
      paymentTransactions: [
        {
          id: "payment_1",
          provider: "stripe",
          providerReferenceId: "cs_1",
          status: "succeeded",
          asset: "USD",
          amountMinor: 1000,
          packageCredits: 1000,
          createdAt: "2026-04-24T13:00:01.000Z",
        },
      ],
      computeUsageEvents: [
        {
          id: "compute_1",
          instanceId: "00000000-0000-4000-8000-000000000001",
          creditsDelta: -100,
          usageKind: "compute",
          referenceId: "inst_1:2026-04-24T13",
          status: "recorded",
          createdAt: "2026-04-24T14:00:00.000Z",
        },
      ],
      llmUsageEvents: [
        {
          id: "llm_1",
          provider: "bankr",
          model: "claude-opus-4.7",
          billingSource: "hermes_credits",
          creditsDelta: -75,
          totalTokens: 1500,
          referenceId: "llm:chat_1:turn_1",
          status: "recorded",
          createdAt: "2026-04-24T13:30:00.000Z",
        },
      ],
      managedVeniceUsageEvents: [
        {
          id: "managed_venice_usage_1",
          walletType: "hermesos",
          endpoint: "/api/v1/chat/completions",
          model: "llama-3.1-405b",
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          actualCostMicroUsd: 1_000_000,
          chargedMicroUsd: 800_000,
          discountMicroUsd: 200_000,
          status: "recorded",
          referenceId: "mv_usage_1",
          createdAt: "2026-04-24T13:45:00.000Z",
        },
      ],
      managedVeniceFinancialEvents: [
        {
          id: "managed_venice_financial_1",
          walletType: "hermesos",
          eventType: "subsidy_applied",
          referenceId: "mv_usage_1",
          amountMicroUsd: 0,
          veniceCostMicroUsd: 1_000_000,
          discountMicroUsd: 200_000,
          createdAt: "2026-04-24T13:45:01.000Z",
        },
      ],
    };

    managedVeniceSummaryData = {
      wallets: {
        hermesos: {
          tokenDisplay: "1,000 Hivra",
          lockedValueMicroUsd: 50_000_000,
          availableMicroUsd: 40_000_000,
          reservedMicroUsd: 10_000_000,
          lots: [],
        },
        card: {
          balanceMicroUsd: 25_000_000,
          availableMicroUsd: 25_000_000,
          reservedMicroUsd: 0,
        },
      },
      discount: {
        rate: "launch_20",
        discountBps: 2000,
        launchSubsidyUsedMicroUsd: 187_000_000,
        launchSubsidyCapMicroUsd: 250_000_000,
      },
      killSwitch: {
        active: false,
        weeklySubsidyUsedMicroUsd: 500_000_000,
        thresholdMicroUsd: 1_000_000_000,
      },
      keys: [
        {
          id: "key_1",
          name: "Dashboard key",
          keyPrefix: "hven_live_abcd",
          status: "active",
          createdAt: "2026-04-24T13:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    };

    tokenHoldingData = {
      token: {
        chainId: 8453,
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenSymbol: "Hivra",
        minimumBalanceDisplay: "1",
      },
      wallet: {
        id: "wallet_1",
        address: "0x000000000000000000000000000000000000dEaD",
        normalizedAddress: "0x000000000000000000000000000000000000dead",
        chainId: 8453,
        verifiedAt: "2026-04-24T12:00:00.000Z",
      },
      snapshot: {
        id: "snapshot_1",
        balanceDisplay: "1.25",
        qualifiesBaseTier: true,
        checkedAt: "2026-04-24T12:01:00.000Z",
      },
      entitlement: {
        verified: true,
        qualifiesBaseTier: true,
      },
    };

    tokenRefreshData = {
      token: {
        chainId: 8453,
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenSymbol: "Hivra",
        minimumBalanceDisplay: "1",
      },
      refresh: {
        status: "refreshed",
        snapshot: {
          id: "snapshot_2",
          balanceDisplay: "2",
          qualifiesBaseTier: true,
          checkedAt: "2026-04-24T12:05:00.000Z",
        },
      },
      entitlement: {
        verified: true,
        qualifiesBaseTier: true,
      },
    };

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/api/billing/wallet/challenge")) {
        return Promise.resolve(jsonResponse({
          challengeId: "challenge_123",
          address: "0x000000000000000000000000000000000000dead",
          chainId: 8453,
          message: "Hivra wallet verification\n\nSign this message.",
          expiresAt: "2026-04-24T12:10:00.000Z",
        }));
      }
      if (url.includes("/api/billing/wallet/verify")) {
        return Promise.resolve(jsonResponse({
          status: "verified",
          wallet: {
            id: "wallet_1",
            address: "0x000000000000000000000000000000000000dead",
            normalizedAddress: "0x000000000000000000000000000000000000dead",
            chainId: 8453,
            verifiedAt: "2026-04-24T12:05:00.000Z",
          },
          challenge: {
            id: "challenge_123",
            status: "verified",
            verifiedAt: "2026-04-24T12:05:00.000Z",
          },
        }));
      }
      if (url.includes("/api/billing/token-holding")) {
        return Promise.resolve(jsonResponse(
          requestMethod(input, init) === "POST" ? tokenRefreshData : tokenHoldingData
        ));
      }
      if (url.includes("/api/billing/crypto/top-up")) {
        return Promise.resolve(jsonResponse({
          intent: {
            referenceId: "bankr_crypto_topup:test",
            status: "pending",
            provider: "bankr",
            packageCredits: 1000,
            creditUnit: "100 credits = $1",
            asset: {
              key: "usdc_base",
              label: "USDC on Base",
              symbol: "USDC",
              chainId: 8453,
              network: "Base",
              tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              tokenDecimals: 6,
              topUpEnabled: true,
              pricingMode: "usd_pegged",
            },
            amountMinor: 10_000_000,
            amountDisplay: "10",
            depositAddress: "0x000000000000000000000000000000000000dead",
            bankrWalletId: "wlt_A1b2C3d4",
          },
          instructions: {
            network: "Base",
            asset: "USDC",
            amount: "10",
            depositAddress: "0x000000000000000000000000000000000000dead",
          },
        }));
      }
      if (url.includes("/api/billing/managed-venice/hermesos/quote")) {
        return Promise.resolve(jsonResponse({
          id: "mvq_1",
          tokenAmountRaw: "1000000000000000000000",
          tokenSymbol: "Hivra",
          tokenDecimals: 18,
          snapshotPriceUsd: "0.05",
          lockedValueMicroUsd: 50_000_000,
          paidValueMicroUsd: 50_000_000,
          creditValueMicroUsd: 60_000_000,
          bonusValueMicroUsd: 10_000_000,
          depositAddress: "0x000000000000000000000000000000000000feed",
          expiresAt: "2099-05-13T09:01:00.000Z",
          status: "active",
        }));
      }
      if (url.includes("/api/billing/managed-venice/hermesos/check")) {
        return Promise.resolve(apiResponse({
          success: true,
          data: {
            status: "no_match",
            quote: {
              id: "mvq_1",
              tokenAmountRaw: "1000000000000000000000",
              tokenSymbol: "Hivra",
              tokenDecimals: 18,
              snapshotPriceUsd: "0.05",
              paidValueMicroUsd: 50_000_000,
              creditValueMicroUsd: 60_000_000,
              bonusValueMicroUsd: 10_000_000,
              depositAddress: "0x000000000000000000000000000000000000feed",
              expiresAt: "2099-05-13T09:01:00.000Z",
              status: "active",
            },
          },
        }));
      }
      if (url.includes("/api/billing/managed-venice/card/top-up")) {
        return Promise.resolve(jsonResponse({
          url: "https://checkout.stripe.test/managed-venice-card",
        }));
      }
      if (url.includes("/api/billing/usage")) {
        return Promise.resolve(jsonResponse(usageData));
      }
      if (url.includes("/api/billing/managed-venice/summary")) {
        return Promise.resolve(jsonResponse(managedVeniceSummaryData));
      }
      if (url.includes("/api/billing/activity")) {
        return Promise.resolve(jsonResponse(activityData));
      }
      return Promise.resolve(jsonResponse({}));
    });
  });

  afterEach(() => {
    if (originalBillingV2Flag === undefined) {
      delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_BILLING_V2_ENABLED = originalBillingV2Flag;
    }

    if (originalCryptoBillingFlag === undefined) {
      delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED = originalCryptoBillingFlag;
    }

    if (originalCreditTopUpsFlag === undefined) {
      delete process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED = originalCreditTopUpsFlag;
    }
  });

  describe("yearly $HermesOS payment banner", () => {
    const yearlyQuote = (overrides: Record<string, unknown> = {}) => ({
      id: "yq_renewal",
      tier: "pro",
      usdTargetCents: 4900,
      priceUsdAtQuote: "0.0000025",
      tokensRequiredDisplay: "19600000",
      tokenSymbol: "Hivra",
      depositAddress: "0x000000000000000000000000000000000000ba5e",
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "active",
      ...overrides,
    });
    const currentYear = {
      id: "ys_1",
      tier: "pro",
      yearlyQuoteId: "yq_first_year",
      paidAt: "2025-10-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      status: "active",
      sweepStatus: "swept",
      sweepTxHash: null,
      amountReceivedRaw: "1",
    };

    function withYearlyResponse(data: Record<string, unknown>) {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("/api/billing/yearly-token-quote") && requestMethod(input, init) === "GET") {
          return Promise.resolve(apiResponse({ success: true, data }));
        }
        return base(input, init);
      });
    }

    it("shows a subscriber the progress of a renewal they are paying", async () => {
      withYearlyResponse({ pro: yearlyQuote(), power: null, proSubscription: currentYear, powerSubscription: null });

      render(<BillingPage />);

      expect(await screen.findByText(/Yearly \$HermesOS · Pro/)).toBeInTheDocument();
      expect(screen.getByText("Waiting…")).toBeInTheDocument();
    });

    it("shows a payable quote of one tier ahead of another tier's quote under review", async () => {
      withYearlyResponse({
        pro: null,
        power: yearlyQuote({ id: "yq_power", tier: "power" }),
        proPending: yearlyQuote({ status: "manual_review", expiresAt: "2026-01-01T00:00:00.000Z" }),
        powerPending: null,
        proSubscription: null,
        powerSubscription: null,
      });

      render(<BillingPage />);

      expect(await screen.findByText(/Yearly \$HermesOS · Power/)).toBeInTheDocument();
      expect(screen.queryByText("Payment under review")).not.toBeInTheDocument();
    });

    it("opens the payment from the renewal email link even though stripping the link re-renders the page", async () => {
      mockGet.mockImplementation((key: string) => (key === "plan" ? "pro" : key === "yearly_token" ? "1" : null));
      withYearlyResponse({ quote: null, pendingQuote: null, subscription: currentYear, tier: "pro" });
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("/api/billing/yearly-token-quote") && requestMethod(input, init) === "POST") {
          return Promise.resolve(apiResponse({ success: true, data: yearlyQuote() }));
        }
        return base(input, init);
      });

      const { rerender } = render(<BillingPage />);
      // What Next does after the page strips the params with replaceState:
      // a new, empty searchParams and a re-render, before the modal opens.
      mockSearchParamsHolder.current = { get: () => null };
      rerender(<BillingPage />);

      expect(await screen.findByText(/Step 1 · Send exactly/)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/yearly-token-quote?tier=pro", { method: "GET" });
    });

    it("does not mint a new quote from the email link while a payment for that tier is under review", async () => {
      mockGet.mockImplementation((key: string) => (key === "plan" ? "pro" : key === "yearly_token" ? "1" : null));
      withYearlyResponse({
        quote: null,
        pendingQuote: yearlyQuote({ status: "manual_review", expiresAt: "2026-01-01T00:00:00.000Z" }),
        pro: null,
        power: null,
        proPending: yearlyQuote({ status: "manual_review", expiresAt: "2026-01-01T00:00:00.000Z" }),
        powerPending: null,
        proSubscription: null,
        powerSubscription: null,
      });

      render(<BillingPage />);

      expect(await screen.findByText("Payment under review")).toBeInTheDocument();
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/billing/yearly-token-quote?tier=pro", { method: "GET" })
      );
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            requestUrl(input as RequestInfo).includes("/api/billing/yearly-token-quote") &&
            requestMethod(input as RequestInfo, init as RequestInit) === "POST"
        )
      ).toBe(false);
    });

    it("tells the user a payment is under review instead of hiding the quote", async () => {
      withYearlyResponse({
        pro: null,
        power: null,
        proPending: yearlyQuote({ status: "manual_review", expiresAt: "2026-01-01T00:00:00.000Z" }),
        powerPending: null,
        proSubscription: null,
        powerSubscription: null,
      });

      render(<BillingPage />);

      expect(await screen.findByText("Payment under review")).toBeInTheDocument();
    });
  });

  it("shows credits, plan grant, and top-up packages for subscribed users", async () => {
    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByText("2,450")).toBeInTheDocument();
    });

    expect(screen.getByText(/compute access comes from an active subscription/i)).toBeInTheDocument();
    // The "100 credits = $1" unit label and "X monthly plan credits" line were
    // removed from CreditsPanel — they confused users about the credit/USD
    // relationship under managed Venice. Keep their absence asserted so they
    // don't sneak back in via copy changes.
    expect(screen.queryByText("100 credits = $1")).not.toBeInTheDocument();
    expect(screen.queryByText(/monthly plan credits/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\$5\s*500/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\$10\s*1,000/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\$25\s*2,500/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\$50\s*5,000/i })).toBeInTheDocument();
    expect(screen.getByText(/billing activity/i)).toBeInTheDocument();
    expect(screen.getByText(/stripe topup/i)).toBeInTheDocument();
    expect(screen.getAllByText(/-75 credits/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/bankr · claude-opus-4.7/i)).toBeInTheDocument();
    expect(screen.getByText(/venice · llama-3.1-405b/i)).toBeInTheDocument();
    // The "$X saved" suffix was removed from managed-Venice activity row
    // secondary text — it always read "$0.0000 saved" for users on the
    // current subsidy schedule and confused more than it explained.
    expect(screen.queryByText(/\$0.2000 saved/i)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/activity");
  });

  it("confirms a successful checkout before routing to welcome", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "subscription") return "success";
      if (key === "session_id") return "cs_checkout_success";
      return null;
    });

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/api/billing/confirm-checkout")) {
        return Promise.resolve(apiResponse({
          success: true,
          data: { activated: true, plan: "operator" },
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<BillingPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/confirm-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_checkout_success" }),
      });
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/dashboard/welcome?subscription=success&step=agent-type");
    });
  });

  it("keeps the user on billing when checkout confirmation fails", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "subscription") return "success";
      if (key === "session_id") return "cs_checkout_unpaid";
      return null;
    });

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/api/billing/confirm-checkout")) {
        return Promise.resolve(apiResponse(
          { success: false, error: "Session payment not completed" },
          { ok: false, status: 402 }
        ));
      }
      if (url.includes("/api/billing/usage")) {
        return Promise.resolve(jsonResponse(usageData));
      }
      if (url.includes("/api/billing/managed-venice/summary")) {
        return Promise.resolve(jsonResponse(managedVeniceSummaryData));
      }
      if (url.includes("/api/billing/activity")) {
        return Promise.resolve(jsonResponse(activityData));
      }
      if (url.includes("/api/billing/token-holding")) {
        return Promise.resolve(jsonResponse(tokenHoldingData));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<BillingPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/confirm-checkout", expect.any(Object));
    });
    await waitFor(() => {
      expect(screen.getByText(/could not confirm your checkout/i)).toBeInTheDocument();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("renders plan management details in Chinese when the locale is Chinese", async () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <BillingPage />
      </LocaleProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("2,450")).toBeInTheDocument();
    });

    expect(screen.getByText("账单与订阅")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("计划管理。");
    expect(screen.getAllByText("当前计划").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "管理订阅" })).toBeInTheDocument();
    expect(screen.getByText("切换计划")).toBeInTheDocument();
    expect(screen.getByText("积分余额")).toBeInTheDocument();
    expect(screen.getByText("代币访问")).toBeInTheDocument();
    expect(screen.getByText("加密货币积分")).toBeInTheDocument();
    expect(screen.queryByText(/Plan Management/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage subscription/i })).not.toBeInTheDocument();
  });

  it("renders plan management details in German when that locale is selected", async () => {
    render(
      <LocaleProvider initialLocale="de">
        <BillingPage />
      </LocaleProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("2,450")).toBeInTheDocument();
    });

    expect(screen.getByText("Abrechnung und Abo")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Plan-Verwaltung.");
    expect(screen.getAllByText("Aktueller Plan").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Abo verwalten" })).toBeInTheDocument();
    expect(screen.getByText("Plan wechseln")).toBeInTheDocument();
    expect(screen.getByText("Guthaben")).toBeInTheDocument();
    expect(screen.getByText("Token-Zugang")).toBeInTheDocument();
    expect(screen.getByText("Krypto-Guthaben")).toBeInTheDocument();
    expect(screen.queryByText(/Plan Management/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage subscription/i })).not.toBeInTheDocument();
  });

  it("hides credit billing panels when billing v2 is disabled", async () => {
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /manage subscription/i })).toBeInTheDocument();
    });

    expect(screen.queryByText("2,450")).not.toBeInTheDocument();
    expect(screen.queryByText(/compute access comes from an active subscription/i)).not.toBeInTheDocument();
    expect(screen.queryByText("100 credits = $1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\$10\s*1,000/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/billing activity/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/billing/activity");
  });

  it("ignores malformed managed Venice summary data without breaking billing", async () => {
    managedVeniceSummaryData = { unexpected: true };
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      render(<BillingPage />);

      await waitFor(() => {
        expect(screen.getByText("2,450")).toBeInTheDocument();
      });

      expect(screen.queryByText(/managed venice inference/i)).not.toBeInTheDocument();
      expect(screen.getByText(/billing activity/i)).toBeInTheDocument();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Managed Venice summary response failed validation"),
        expect.objectContaining({
          failureType: "managed_venice_summary_contract_mismatch",
          hasWallets: false,
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps credit balances visible while hiding card top-up packages when credit top-ups are disabled", async () => {
    delete process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED;

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByText("2,450")).toBeInTheDocument();
    });

    expect(screen.getByText(/compute access comes from an active subscription/i)).toBeInTheDocument();
    expect(screen.queryByText("100 credits = $1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\$5\s*500/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\$10\s*1,000/i })).not.toBeInTheDocument();
    expect(screen.getByText(/billing activity/i)).toBeInTheDocument();
  });

  it("hides crypto billing panels when the crypto flag is disabled", async () => {
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByText("2,450")).toBeInTheDocument();
    });

    expect(screen.queryByText("Optional token access and payments")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "About optional token access" })).toHaveAttribute("href", "/token");
    expect(screen.queryByText(/crypto credits/i)).not.toBeInTheDocument();

    expect(fetchMock).not.toHaveBeenCalledWith("/api/billing/token-holding");
  });

  it("keeps card billing first and optional holder controls collapsed", async () => {
    render(<BillingPage />);
    const disclosure = await screen.findByText("Optional token access and payments");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: /top up by card/i })).toBeVisible();
    expect(screen.getByText("Optional token top-ups").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/Verified wallet:/)).toBeVisible();
    expect(screen.getByText(/Verified wallet:/)).toHaveTextContent(/Balance:.*Access:/);
    const plan = screen.getByText("Current Plan");
    expect(plan.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows token holding status and refreshes the snapshot", async () => {
    render(<BillingPage />);
    fireEvent.click(await screen.findByText("Optional token access and payments"));

    await waitFor(() => {
      expect(screen.getByText(/base tier ready/i)).toBeInTheDocument();
    });

    expect(screen.getByText("0x0000...dead")).toBeInTheDocument();
    expect(screen.getByText("1.25 Hivra")).toBeInTheDocument();
    expect(screen.getByText("1 Hivra")).toBeInTheDocument();
    expect(screen.getByText(/unlock token base compute/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /refresh token status/i }));

    await waitFor(() => {
      expect(screen.getByText("2 Hivra")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/token-holding", { method: "POST" });
  });

  it("creates a pending USDC crypto top-up intent from billing", async () => {
    render(<BillingPage />);
    fireEvent.click(await screen.findByText("Optional token access and payments"));

    await waitFor(() => {
      expect(screen.getByText(/crypto credits/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/bonus path prepared/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create usdc top-up for 1000 credits/i }));

    await waitFor(() => {
      expect(screen.getByText(/pending deposit/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/send 10 usdc on base/i)).toBeInTheDocument();
    expect(screen.getByText("0x000000000000000000000000000000000000dead")).toBeInTheDocument();
    expect(screen.getByText(/reference bankr_crypto_topup:test/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/crypto/top-up", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        asset: "usdc_base",
        packageCredits: 1000,
      }),
    }));
  });

  it("opens a managed Venice deposit modal from the welcome deep link and creates a Hivra quote", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "managedVenice") return "deposit";
      if (key === "wallet") return "hermesos";
      if (key === "amountUsd") return "50";
      return null;
    });

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /top up managed venice credits/i })).toBeInTheDocument();
    });

    expect(screen.getByText("+$10.00")).toBeInTheDocument();
    expect(screen.getByText("$60.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /start \$hermesos top-up/i }));

    await waitFor(() => {
      expect(screen.getByText(/rate locked/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/send exactly/i)).toBeInTheDocument();
    expect(screen.getByText(/send the exact base transfer/i)).toBeInTheDocument();
    expect(screen.getByText("0x000000000000000000000000000000000000feed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verify payment/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /top-up active/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/managed-venice/hermesos/quote", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ targetPaidMicroUsd: 50_000_000 }),
    }));
  });

  it("shows check failures instead of looping on managed Venice Hivra verification", async () => {
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/api/billing/managed-venice/hermesos/check")) {
        return Promise.resolve(apiResponse(
          { success: false, error: "Base scanner temporarily unavailable" },
          { ok: false, status: 503 }
        ));
      }
      return defaultFetch?.(input, init) ?? Promise.resolve(jsonResponse({}));
    });

    mockGet.mockImplementation((key: string) => {
      if (key === "managedVenice") return "deposit";
      if (key === "wallet") return "hermesos";
      if (key === "amountUsd") return "50";
      return null;
    });

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /top up managed venice credits/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /start \$hermesos top-up/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /verify payment/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /verify payment/i }));

    await waitFor(() => {
      expect(screen.getByText("Base scanner temporarily unavailable")).toBeInTheDocument();
    });
    expect(screen.queryByText(/still checking/i)).not.toBeInTheDocument();
  });

  it("starts managed Venice card checkout from the deposit modal", async () => {
    const originalLocation = window.location;
    const assignMock = jest.fn();
    mockGet.mockImplementation((key: string) => {
      if (key === "managedVenice") return "deposit";
      if (key === "wallet") return "card";
      if (key === "amountUsd") return "50";
      return null;
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost/dashboard/billing?managedVenice=deposit&wallet=card&amountUsd=50",
        origin: "http://localhost",
        assign: assignMock,
      },
    });

    try {
      render(<BillingPage />);

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: /top up managed venice credits/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /start card checkout/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/billing/managed-venice/card/top-up", expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ amountMicroUsd: 50_000_000 }),
        }));
      });
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/managed-venice-card");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("connects a browser wallet, verifies the signature, and refreshes token status", async () => {
    tokenHoldingData = {
      token: {
        chainId: 8453,
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenSymbol: "Hivra",
        minimumBalanceDisplay: "1",
      },
      wallet: null,
      snapshot: null,
      entitlement: {
        verified: false,
        qualifiesBaseTier: false,
      },
    };
    tokenRefreshData = {
      token: {
        chainId: 8453,
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenSymbol: "Hivra",
        minimumBalanceDisplay: "1",
      },
      refresh: {
        status: "refreshed",
        snapshot: {
          id: "snapshot_2",
          balanceDisplay: "2",
          qualifiesBaseTier: true,
          checkedAt: "2026-04-24T12:05:00.000Z",
        },
      },
      entitlement: {
        verified: true,
        qualifiesBaseTier: true,
      },
    };
    const walletRequest = jest.fn()
      .mockResolvedValueOnce(["0x000000000000000000000000000000000000dEaD"])
      .mockResolvedValueOnce("0xsigned");
    (window as unknown as { ethereum?: { request: jest.Mock } }).ethereum = {
      request: walletRequest,
    };

    render(<BillingPage />);
    fireEvent.click(await screen.findByText("Optional token access and payments"));

    await waitFor(() => {
      expect(screen.getByText(/no verified wallet/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

    await waitFor(() => {
      expect(screen.getByText("0x0000...dead")).toBeInTheDocument();
      expect(screen.getByText("2 Hivra")).toBeInTheDocument();
    });

    expect(walletRequest).toHaveBeenNthCalledWith(1, { method: "eth_requestAccounts" });
    expect(walletRequest).toHaveBeenNthCalledWith(2, {
      method: "personal_sign",
      params: [
        "Hivra wallet verification\n\nSign this message.",
        "0x000000000000000000000000000000000000dEaD",
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/wallet/challenge", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        address: "0x000000000000000000000000000000000000dEaD",
        chainId: 8453,
      }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/wallet/verify", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        challengeId: "challenge_123",
        signature: "0xsigned",
      }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/token-holding", { method: "POST" });
  });

  it("asks the wallet for accounts on billing even when the provider reports disconnected before permission", async () => {
    tokenHoldingData = {
      token: {
        chainId: 8453,
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenSymbol: "Hivra",
        minimumBalanceDisplay: "1",
      },
      wallet: null,
      snapshot: null,
      entitlement: {
        verified: false,
        qualifiesBaseTier: false,
      },
    };
    tokenRefreshData = {
      token: {
        chainId: 8453,
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenSymbol: "Hivra",
        minimumBalanceDisplay: "1",
      },
      refresh: {
        status: "refreshed",
        snapshot: {
          id: "snapshot_2",
          balanceDisplay: "2",
          qualifiesBaseTier: true,
          checkedAt: "2026-04-24T12:05:00.000Z",
        },
      },
      entitlement: {
        verified: true,
        qualifiesBaseTier: true,
      },
    };
    const walletRequest = jest.fn()
      .mockResolvedValueOnce(["0x000000000000000000000000000000000000dEaD"])
      .mockResolvedValueOnce("0xsigned");
    (window as unknown as { ethereum?: { isConnected: () => boolean; request: jest.Mock } }).ethereum = {
      isConnected: () => false,
      request: walletRequest,
    };

    render(<BillingPage />);
    fireEvent.click(await screen.findByText("Optional token access and payments"));

    await waitFor(() => {
      expect(screen.getByText(/no verified wallet/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

    await waitFor(() => {
      expect(walletRequest).toHaveBeenNthCalledWith(1, { method: "eth_requestAccounts" });
      expect(walletRequest).toHaveBeenNthCalledWith(2, {
        method: "personal_sign",
        params: [
          "Hivra wallet verification\n\nSign this message.",
          "0x000000000000000000000000000000000000dEaD",
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/wallet/verify", expect.objectContaining({ method: "POST" }));
    });
  });

  it("shows top-up packages for users without an active subscription", async () => {
    usageData = {
      subscribed: false,
      plan: null,
      usage: null,
      credits: {
        balance: 0,
        monthlyGrant: 0,
        unit: "100 credits = $1",
      },
    };

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByText(/no active subscription/i)).toBeInTheDocument();
    });

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("100 credits = $1")).not.toBeInTheDocument();
    expect(screen.queryByText(/monthly plan credits/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\$5\s*500/i })).toBeInTheDocument();
  });

  it("keeps subscription checkout available when billing v2 and crypto are disabled", async () => {
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    usageData = {
      subscribed: false,
      plan: null,
      usage: null,
      credits: {
        balance: 0,
        monthlyGrant: 0,
        unit: "100 credits = $1",
      },
    };

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByText(/no active subscription/i)).toBeInTheDocument();
    });

    // Card-path CTA was "Get Started" pre-2026-05-01 redesign; the
    // Card/Crypto tab split changed it to "Subscribe · $X/mo|/yr".
    expect(screen.getAllByRole("button", { name: /subscribe ·/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/compute access comes from an active subscription/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Optional token access and payments")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "About optional token access" })).toHaveAttribute("href", "/token");
    expect(screen.queryByText(/crypto credits/i)).not.toBeInTheDocument();

  });

  it("opens Stripe checkout when a Free plan user upgrades from the plan switcher", async () => {
    const originalLocation = window.location;
    const assignMock = jest.fn();
    const defaultFetch = fetchMock.getMockImplementation();

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost/dashboard/billing",
        origin: "http://localhost",
        assign: assignMock,
      },
    });

    usageData = {
      subscribed: true,
      plan: {
        key: "free",
        name: "Free",
        price: 0,
        maxAgents: 1,
        totalCpu: 0.5,
        totalRam: 1024,
        status: "active",
        currentPeriodEnd: null,
      },
      usage: {
        agentCount: 1,
        maxAgents: 1,
        usedCpu: 0.5,
        totalCpu: 0.5,
        usedRam: 1024,
        totalRam: 1024,
        instances: [
          {
            id: "inst-free",
            name: "Free Agent",
            status: "running",
            cpu: 0.5,
            ram: 1024,
            backups_enabled: false,
          },
        ],
      },
      credits: {
        balance: 0,
        monthlyGrant: 0,
        unit: "100 credits = $1",
      },
    };

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/api/billing/subscribe")) {
        return Promise.resolve(jsonResponse({ url: "https://checkout.stripe.test/session" }));
      }
      return defaultFetch?.(input, init) ?? Promise.resolve(jsonResponse({}));
    });

    try {
      render(<BillingPage />);

      await waitFor(() => {
        expect(screen.getByText(/switch plan/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getAllByRole("button", { name: /^upgrade$/i })[0]);
      expect(screen.getByRole("heading", { name: /open secure checkout/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /open checkout/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: "operator", cadence: "monthly" }),
        });
      });

      expect(fetchMock.mock.calls.some(([url]) => url === "/api/billing/change-plan")).toBe(false);
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("opens secure checkout for paid plans that cannot change in place", async () => {
    const originalLocation = window.location;
    const assignMock = jest.fn();
    const defaultFetch = fetchMock.getMockImplementation();

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost/dashboard/billing",
        origin: "http://localhost",
        assign: assignMock,
      },
    });

    usageData = {
      subscribed: true,
      plan: {
        key: "operator",
        name: "Pro",
        price: 999,
        maxAgents: 3,
        totalCpu: 2,
        totalRam: 4096,
        status: "active",
        currentPeriodEnd: null,
        source: "stripe",
        canChangePlanInPlace: false,
      },
      usage: {
        agentCount: 1,
        maxAgents: 3,
        usedCpu: 1,
        totalCpu: 2,
        usedRam: 2048,
        totalRam: 4096,
        instances: [
          {
            id: "inst-pro",
            name: "Pro Agent",
            status: "running",
            cpu: 1,
            ram: 2048,
            backups_enabled: false,
          },
        ],
      },
      credits: {
        balance: 0,
        monthlyGrant: 2090,
        unit: "100 credits = $1",
      },
    };

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/api/billing/subscribe")) {
        return Promise.resolve(jsonResponse({ url: "https://checkout.stripe.test/paid-switch" }));
      }
      return defaultFetch?.(input, init) ?? Promise.resolve(jsonResponse({}));
    });

    try {
      render(<BillingPage />);

      await waitFor(() => {
        expect(screen.getByText(/switch plan/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /^upgrade$/i }));

      expect(screen.getByRole("heading", { name: /open secure checkout/i })).toBeInTheDocument();
      expect(screen.getByText(/changed through stripe checkout/i)).toBeInTheDocument();
      expect(screen.queryByText(/prorated amount/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /open checkout/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: "fleet", cadence: "monthly" }),
        });
      });

      expect(fetchMock.mock.calls.some(([url]) => url === "/api/billing/change-plan")).toBe(false);
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/paid-switch");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("shows the no-wallet token state without blocking billing", async () => {
    tokenHoldingData = {
      token: {
        chainId: 8453,
        tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
        tokenSymbol: "Hivra",
        minimumBalanceDisplay: "1",
      },
      wallet: null,
      snapshot: null,
      entitlement: {
        verified: false,
        qualifiesBaseTier: false,
      },
    };

    render(<BillingPage />);
    fireEvent.click(await screen.findByText("Optional token access and payments"));

    await waitFor(() => {
      expect(screen.getByText(/no verified wallet/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.getByText("No snapshot")).toBeInTheDocument();
    expect(screen.getByText("2,450")).toBeInTheDocument();
  });

  it("surfaces backup upsell context when arriving from the console", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "intent") return "backups";
      if (key === "instanceId") return "inst-123";
      return null;
    });

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByText(/finish enabling daily backups/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/agent one/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^enable daily backups$/i })).toBeInTheDocument();
  });
});
