/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React, { useInsertionEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { MARKETING_COPY } from "@/lib/i18n";
import BillingPage from "../page";

const HERMESOS_CONTRACT = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";
const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const EN_BILLING = MARKETING_COPY.en.dashboard.billing;

const mockGet = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockRouter = {
  replace: mockReplace,
  push: mockPush,
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

  const MotionSection = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    ({ children, ...rest }, ref) => (
      <section ref={ref} {...stripMotionProps(rest)}>
        {children}
      </section>
    )
  );
  MotionSection.displayName = "MotionSection";

  return {
    motion: {
      div: MotionDiv,
      header: MotionHeader,
      button: MotionButton,
      section: MotionSection,
    },
    useReducedMotion: () => false,
  };
});

describe("BillingPage", () => {
  const fetchMock = jest.fn();
  const originalBillingV2Flag = process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
  const originalCryptoBillingFlag = process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
  const originalCreditTopUpsFlag = process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED;
  const originalSelfServeDowngradeFlag = process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED;
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
    delete process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED;
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
        backupAddon: { purchasable: true, instanceIds: ["inst-123"], includedWithPlan: false },
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
        tokenAddress: HERMESOS_CONTRACT,
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
        tokenAddress: HERMESOS_CONTRACT,
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
      if (url.includes("/api/billing/wallet/eligibility")) {
        return Promise.resolve(jsonResponse({
          balance: { balanceDisplay: "1.25" },
          thresholds: {
            configured: true,
            proDisplay: "134,476,535",
            powerDisplay: "269,855,596",
            priceUsd: "0.000001108",
            priceFetchedAt: "2026-09-24T12:59:43.827Z",
          },
          tiers: {
            pro: { currentlyEligible: false, currentThresholdDisplay: "134,476,535" },
            power: { currentlyEligible: false, currentThresholdDisplay: "269,855,596" },
          },
          veniceBoost: {
            thresholdUsd: 199,
            cpuBonus: 1,
            ramBonusMb: 2048,
            currentlyEligible: false,
            requiredVvvDisplay: "7",
            countsStakedVvv: true,
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
              tokenAddress: USDC_CONTRACT,
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

    if (originalSelfServeDowngradeFlag === undefined) {
      delete process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED = originalSelfServeDowngradeFlag;
    }

    // Tabs mirror to ?tab= and some tests set a hash; start each test clean.
    window.history.replaceState(null, "", "/");
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

    it("shows the banner for a quote minted from the email link once the payment modal is closed", async () => {
      mockGet.mockImplementation((key: string) => (key === "plan" ? "pro" : key === "yearly_token" ? "1" : null));
      let minted = false;
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("/api/billing/yearly-token-quote")) {
          if (requestMethod(input, init) === "POST") {
            minted = true;
            return Promise.resolve(apiResponse({ success: true, data: yearlyQuote() }));
          }
          const data = url.includes("?tier=")
            ? { quote: null, pendingQuote: null, subscription: currentYear, tier: "pro" }
            : { pro: minted ? yearlyQuote() : null, power: null, proSubscription: currentYear, powerSubscription: null };
          return Promise.resolve(apiResponse({ success: true, data }));
        }
        return base(input, init);
      });

      render(<BillingPage />);
      const dialog = await screen.findByRole("dialog", { name: /Pay Pro yearly with \$HermesOS/ });
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

      expect(await screen.findByText(/Yearly \$HermesOS · Pro/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Check now/ })).toBeInTheDocument();
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

  async function openTab(name: string) {
    fireEvent.click(await screen.findByRole("tab", { name }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    });
  }

  function subscribedAs(plan: Record<string, unknown>) {
    usageData = {
      ...usageData,
      plan: { ...(usageData.plan as Record<string, unknown>), ...plan },
    };
  }

  function notSubscribed() {
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
  }

  function stubLocation(href: string) {
    const originalLocation = window.location;
    const assignMock = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href, origin: "http://localhost", hash: "", search: "", assign: assignMock },
    });
    return {
      assignMock,
      restore: () =>
        Object.defineProperty(window, "location", {
          configurable: true,
          value: originalLocation,
        }),
    };
  }

  describe("tabs", () => {
    it("opens Overview for someone with a plan and Plans for someone without one", async () => {
      const { unmount } = render(<BillingPage />);
      expect(await screen.findByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "billing-tab-overview");
      unmount();

      notSubscribed();
      render(<BillingPage />);
      expect(await screen.findByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("heading", { name: "Choose a plan" })).toBeInTheDocument();
    });

    // Live review on Canary: "vCPU 0.5 −7.5" beside the figure read as a range.
    it("says how each plan differs from yours in words, not as a bare signed number", async () => {
      render(<BillingPage />);
      fireEvent.click(await screen.findByRole("tab", { name: "Plans" }));
      const free = (await screen.findByRole("heading", { name: "Free" })).closest("article") as HTMLElement;
      expect(within(free).getByText("(−3.5 vs yours)")).toBeInTheDocument();
      expect(within(free).getByText("(−7 GB vs yours)")).toBeInTheDocument();
      const pro = screen.getByRole("heading", { name: "Pro" }).closest("article") as HTMLElement;
      expect(within(pro).getByText("(−4 GB vs yours)")).toBeInTheDocument();
    });

    it("opens Overview on a paid plan on hold, with the way to settle it", async () => {
      notSubscribed();
      usageData = {
        ...usageData,
        planOnHold: { key: "operator", name: "Pro", status: "past_due", reason: "payment_overdue", billingPortal: true },
      };
      render(<BillingPage />);

      expect(await screen.findByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("heading", { name: "Pro plan on hold" })).toBeInTheDocument();
      expect(screen.getByText(
        "A payment didn't go through, so this plan isn't active right now. Pay the open invoice or update your card in the billing portal.",
      )).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open billing portal" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Choose a plan" })).not.toBeInTheDocument();
      // A live card subscription still bills the plan, so a new plan would be
      // refused (ACTIVE_SUBSCRIPTION) until it is settled in the portal.
      expect(screen.queryByRole("button", { name: "See plans" })).not.toBeInTheDocument();
    });

    it("offers no billing portal for a plan on hold that no live card subscription bills", async () => {
      notSubscribed();
      usageData = {
        ...usageData,
        planOnHold: { key: "fleet", name: "Power", status: "active", reason: "no_slots", billingPortal: false },
      };
      render(<BillingPage />);

      expect(await screen.findByRole("heading", { name: "Power plan on hold" })).toBeInTheDocument();
      expect(screen.getByText("This plan has no agent slots right now. Contact support to check it.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open billing portal" })).not.toBeInTheDocument();
      // Nothing bills this plan by card, so Checkout for a plan still works.
      fireEvent.click(screen.getByRole("button", { name: "See plans" }));
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
      });
    });

    it("renders only the active panel and wires tabs to their panels", async () => {
      render(<BillingPage />);
      const tablist = await screen.findByRole("tablist", { name: "Billing sections" });
      const tabs = within(tablist).getAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        "Overview",
        "Plans",
        "Payment methods",
        "Credits",
        "History",
      ]);
      for (const tab of tabs) {
        const panelId = tab.getAttribute("aria-controls");
        expect(panelId).toBeTruthy();
        expect(document.getElementById(panelId as string)).toHaveAttribute("role", "tabpanel");
      }
      // Roving tabindex: only the selected tab is in the Tab order.
      expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
      expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    });

    it("moves between tabs with the arrow, Home and End keys", async () => {
      render(<BillingPage />);
      const overview = await screen.findByRole("tab", { name: "Overview" });
      overview.focus();

      fireEvent.keyDown(overview, { key: "ArrowRight" });
      const plans = screen.getByRole("tab", { name: "Plans" });
      expect(plans).toHaveAttribute("aria-selected", "true");
      expect(plans).toHaveFocus();

      fireEvent.keyDown(plans, { key: "End" });
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");

      fireEvent.keyDown(screen.getByRole("tab", { name: "History" }), { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

      fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowLeft" });
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");

      fireEvent.keyDown(screen.getByRole("tab", { name: "History" }), { key: "Home" });
      expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    });

    it.each([
      [{ tab: "history" }, "History"],
      [{ tab: "not-a-tab" }, "Overview"],
      [{ intent: "backups", instanceId: "inst-123" }, "Overview"],
      [{ plan: "fleet", cadence: "yearly" }, "Plans"],
      [{ from: "paywall", feature: "always_on" }, "Plans"],
      [{ credits: "success" }, "Credits"],
      [{ managedVenice: "card_success" }, "Credits"],
    ])("opens the tab a deep link asks for (%p → %s)", async (params, expected) => {
      const values = params as Record<string, string>;
      mockGet.mockImplementation((key: string) => values[key] ?? null);

      render(<BillingPage />);

      expect(await screen.findByRole("tab", { name: expected })).toHaveAttribute("aria-selected", "true");
    });

    it("lands #managed-venice links on the model credits section", async () => {
      window.history.replaceState(null, "", "/dashboard/billing#managed-venice");

      render(<BillingPage />);

      expect(await screen.findByRole("tab", { name: "Credits" })).toHaveAttribute("aria-selected", "true");
      await waitFor(() => {
        expect(document.getElementById("managed-venice")).toBeInTheDocument();
      });
      expect(document.getElementById("managed-venice")).toContainElement(
        await screen.findByRole("button", { name: "Top up by card" })
      );
    });

    it("mirrors the selected tab to ?tab= without the router, keeping other params and the hash", async () => {
      window.history.replaceState(null, "", "/dashboard/billing?from=welcome#top");
      notSubscribed();

      render(<BillingPage />);
      await openTab("Payment methods");

      const url = new URL(window.location.href);
      expect(url.searchParams.get("tab")).toBe("payments");
      expect(url.searchParams.get("from")).toBe("welcome");
      expect(url.hash).toBe("#top");
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it("follows a ?tab= change without re-running the mount effect", async () => {
      mockGet.mockImplementation((key: string) => (key === "credits" ? "success" : null));
      const { rerender } = render(<BillingPage />);
      expect(await screen.findByRole("tab", { name: "Credits" })).toHaveAttribute("aria-selected", "true");
      const usageCalls = () =>
        fetchMock.mock.calls.filter(([input]) => requestUrl(input as RequestInfo).includes("/api/billing/usage")).length;
      const before = usageCalls();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      // What Next hands the page after a tab is mirrored into the URL: a new
      // searchParams object that differs only in ?tab=.
      mockSearchParamsHolder.current = {
        get: (key: string) => (key === "credits" ? "success" : key === "tab" ? "plans" : null),
      };
      rerender(<BillingPage />);

      expect(await screen.findByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
      expect(usageCalls()).toBe(before);
      // The dismissed banner does not come back.
      expect(screen.queryByText(/Credits top-up complete/)).not.toBeInTheDocument();
    });

    it("keeps the page and the chosen tab mounted while usage refreshes", async () => {
      const pendingRefresh: { resolve?: (value: Response) => void } = {};
      let usageCalls = 0;
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("/api/billing/usage")) {
          usageCalls += 1;
          if (usageCalls > 1) {
            return new Promise<Response>((resolve) => {
              pendingRefresh.resolve = resolve;
            });
          }
        }
        return base(input, init);
      });

      render(<BillingPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Refresh usage" }));

      expect(await screen.findByText("Refreshing…")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("heading", { level: 2, name: /Fleet/ })).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/activity");

      pendingRefresh.resolve?.(jsonResponse(usageData));
      await waitFor(() => {
        expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();
      });
    });
  });

  it("shows credits, plan grant, and top-up packages for subscribed users", async () => {
    render(<BillingPage />);

    // The overview tile summarises the balance…
    await waitFor(() => {
      expect(screen.getByText("2,450")).toBeInTheDocument();
    });

    // …and the Credits tab holds the balance and the top-up packages.
    await openTab("Credits");
    expect(screen.getByText("2,450")).toBeInTheDocument();
    expect(screen.getByText(EN_BILLING.credits.description)).toBeInTheDocument();
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

    // Activity lives in History.
    await openTab("History");
    expect(screen.getByText(/billing activity/i)).toBeInTheDocument();
    expect(screen.getByText(/stripe topup/i)).toBeInTheDocument();
    expect(screen.getAllByText(/-75 credits/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/bankr · claude-opus-4.7/i)).toBeInTheDocument();
    expect(screen.getByText(/venice · llama-3.1-405b/i)).toBeInTheDocument();
    // The "$X saved" suffix was removed from managed-Venice activity row
    // secondary text — it always read "$0.0000 saved" for users on the
    // current subsidy schedule and confused more than it explained.
    expect(screen.queryByText(/\$0.2000 saved/i)).not.toBeInTheDocument();
    // Touch-friendly wording at a readable size.
    expect(screen.getByText("Select any row for the full breakdown")).toBeInTheDocument();
    expect(screen.queryByText(/click any row/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view all activity/i })).toHaveAttribute(
      "href",
      "/dashboard/billing/activity"
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/activity");
  });

  it("confirms a successful checkout before opening Launch", async () => {
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
      // With nothing to return to, Launch opens and says whether the plan shows.
      expect(mockReplace).toHaveBeenCalledWith("/dashboard/launch?upgraded=operator");
    });
  });

  it("returns to the launch a checkout started from once the checkout is confirmed", async () => {
    const launchReturn = "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333";
    mockGet.mockImplementation((key: string) => ({
      subscription: "success",
      session_id: "cs_checkout_success",
      returnTo: launchReturn,
    } as Record<string, string>)[key] ?? null);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (requestUrl(input).includes("/api/billing/confirm-checkout")) {
        return Promise.resolve(apiResponse({ success: true, data: { activated: true, plan: "operator" } }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<BillingPage />);

    await waitFor(() => {
      // Named with the plan it moved to, so Launch can tell whether it shows yet.
      expect(mockReplace).toHaveBeenCalledWith(`${launchReturn}&upgraded=operator`);
    });
    expect(mockReplace).not.toHaveBeenCalledWith(expect.stringContaining("/dashboard/welcome"));
  });

  it.each([
    ["an absolute URL", "https://evil.example/dashboard/launch"],
    ["a protocol-relative URL", "//evil.example/dashboard/launch"],
    ["a path outside the dashboard", "/api/billing/subscribe"],
  ])("ignores %s as a checkout return path", async (_label, returnTo) => {
    mockGet.mockImplementation((key: string) => ({
      subscription: "success",
      session_id: "cs_checkout_success",
      returnTo,
    } as Record<string, string>)[key] ?? null);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (requestUrl(input).includes("/api/billing/confirm-checkout")) {
        return Promise.resolve(apiResponse({ success: true, data: { activated: true, plan: "operator" } }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<BillingPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/dashboard/launch?upgraded=operator");
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
    expect(screen.getByText("Checkout not confirmed")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
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
    expect(screen.getByText("积分余额")).toBeInTheDocument();
    expect(screen.queryByText(/Plan Management/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage (subscription|payment method)/i })).not.toBeInTheDocument();

    await openTab("Plans");
    expect(screen.getByText("切换计划")).toBeInTheDocument();
    await openTab("Payment methods");
    // The wallet summary is localized (the duplicate "Token access" eyebrow is gone).
    expect(await screen.findByText("钱包")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新代币状态" })).toBeInTheDocument();
    expect(screen.queryByText("代币访问")).not.toBeInTheDocument();
    await openTab("Credits");
    expect(screen.getByText("加密货币积分")).toBeInTheDocument();
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
    expect(screen.getByText("Guthaben")).toBeInTheDocument();
    expect(screen.queryByText(/Plan Management/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage (subscription|payment method)/i })).not.toBeInTheDocument();

    await openTab("Plans");
    expect(screen.getByText("Plan wechseln")).toBeInTheDocument();
    await openTab("Payment methods");
    expect(await screen.findByRole("button", { name: "Token-Status aktualisieren" })).toBeInTheDocument();
    expect(screen.queryByText("Token-Zugang")).not.toBeInTheDocument();
    await openTab("Credits");
    expect(screen.getByText("Krypto-Guthaben")).toBeInTheDocument();
  });

  it("hides credit billing panels when billing v2 is disabled", async () => {
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /manage payment method/i })).toBeInTheDocument();
    });

    // No credit tiles on Overview and no History tab without billing v2.
    expect(screen.queryByText("2,450")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "History" })).not.toBeInTheDocument();

    // Credits still exists for USDC top-ups (crypto is on), without card credits.
    await openTab("Credits");
    expect(screen.queryByText("2,450")).not.toBeInTheDocument();
    expect(screen.queryByText(EN_BILLING.credits.description)).not.toBeInTheDocument();
    expect(screen.queryByText("100 credits = $1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\$10\s*1,000/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/billing activity/i)).not.toBeInTheDocument();
    expect(document.getElementById("managed-venice")).not.toBeInTheDocument();
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

      await openTab("Credits");
      expect(screen.queryByText(/managed venice inference/i)).not.toBeInTheDocument();
      // The anchor still exists so #managed-venice links land somewhere.
      expect(document.getElementById("managed-venice")).toBeInTheDocument();

      await openTab("History");
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

    await openTab("Credits");
    expect(screen.getByText("2,450")).toBeInTheDocument();
    expect(screen.getByText(EN_BILLING.credits.description)).toBeInTheDocument();
    expect(screen.queryByText("100 credits = $1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\$5\s*500/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\$10\s*1,000/i })).not.toBeInTheDocument();
    await openTab("History");
    expect(screen.getByText(/billing activity/i)).toBeInTheDocument();
  });

  it("shows one calm line and no crypto prices or buttons when the crypto flag is disabled", async () => {
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;

    render(<BillingPage />);

    await waitFor(() => {
      expect(screen.getByText("2,450")).toBeInTheDocument();
    });

    await openTab("Payment methods");
    // Billing v2 still sells model credits for $HermesOS in Credits, so the
    // tab must not claim crypto is unavailable across the board.
    expect(
      screen.getByText(
        "Paying for your plan with $HermesOS or USDC isn't available right now. You can still top up model credits with $HermesOS in Credits."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Crypto payments aren't available right now/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "About $HermesOS access" })).toHaveAttribute("href", "/token");
    expect(screen.queryByText("Optional token access and payments")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refresh token status/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /a year$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/\$49|\$99/)).not.toBeInTheDocument();

    await openTab("Plans");
    expect(screen.queryByRole("radiogroup", { name: "Payment method" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/59%/);
    expect(document.body).not.toHaveTextContent(/with \$HermesOS/);

    await openTab("Credits");
    expect(screen.queryByText(/crypto credits/i)).not.toBeInTheDocument();
    // …and the $HermesOS model-credit top-up the line points to is really there.
    const tokenTopUps = screen.getByText("Optional token top-ups").closest("details") as HTMLElement;
    expect(within(tokenTopUps).getByRole("button", { name: "Top up with $HermesOS" })).toBeInTheDocument();

    expect(fetchMock).not.toHaveBeenCalledWith("/api/billing/token-holding");
  });

  it("sends people to Credits from Payment methods when crypto plan payments are off but $HermesOS credits are on", async () => {
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;

    render(<BillingPage />);
    await openTab("Payment methods");
    fireEvent.click(await screen.findByRole("button", { name: /go to credits/i }));

    expect(screen.getByRole("tab", { name: "Credits" })).toHaveAttribute("aria-selected", "true");
  });

  it("puts card first and the $HermesOS holder controls in Payment methods", async () => {
    render(<BillingPage />);

    await openTab("Payment methods");
    const card = screen.getByRole("heading", { name: "Card" });
    const crypto = screen.getByRole("heading", { name: "$HermesOS and USDC on Base" });
    expect(card.compareDocumentPosition(crypto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/Stripe keeps your card on file/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open billing portal" })).toBeInTheDocument();

    // The hold block shows ONE wallet summary: the full address (with a copy
    // button) and the balance, then the actions. The 1-token base-tier
    // minimum and its "qualified" verdict are not plan requirements, so none
    // of it appears under the plan-hold heading.
    const holdBlock = screen.getByRole("heading", { name: "Hold $HermesOS for ongoing access" })
      .parentElement as HTMLElement;
    expect(await within(holdBlock).findByText("0x000000000000000000000000000000000000dEaD")).toBeVisible();
    expect(within(holdBlock).getAllByText("0x000000000000000000000000000000000000dEaD")).toHaveLength(1);
    expect(within(holdBlock).getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    expect(within(holdBlock).getAllByText("1.25 $HermesOS")).toHaveLength(1);
    expect(within(holdBlock).getByText("Wallet verified")).toBeInTheDocument();
    expect(holdBlock).not.toHaveTextContent(/minimum|qualified|base tier|token access|verified wallet:/i);
    expect(holdBlock).not.toHaveTextContent(/(^|[^\d.])1 \$HermesOS/);
    expect(within(holdBlock).getByRole("link", { name: /verify a wallet and track your holding/i })).toHaveAttribute(
      "href",
      "/dashboard/wallet?from=billing"
    );
    // The account's own hold amounts, straight from the eligibility API.
    const holdTable = await within(holdBlock).findByRole("table", { name: /\$HermesOS to hold for each plan/i });
    const proRow = within(holdTable).getByRole("row", { name: /^Pro/ });
    expect(proRow).toHaveTextContent("134,476,535 $HermesOS");
    expect(proRow).toHaveTextContent("$149");
    expect(proRow).toHaveTextContent("Not yet");
    expect(within(holdTable).getByRole("row", { name: /^Power/ })).toHaveTextContent("269,855,596 $HermesOS");
    expect(holdBlock).toHaveTextContent("7 VVV (staked counts), about $199, adds +1 vCPU and +2 GB per agent");
    for (const rule of [
      "Base network only.",
      "Send the exact amount in one transfer.",
      "Prices lock for 20 minutes.",
      "Token payments are final, except where the law gives you a right to cancel.",
      "Yearly access doesn't renew automatically.",
    ]) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
    // The old collapsed disclosure and dangling paragraph are gone; their
    // content lives in this tab now.
    expect(screen.queryByText("Optional token access and payments")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "About optional token access" })).not.toBeInTheDocument();
    // A card subscriber is not offered a $HermesOS year on top.
    expect(screen.queryByRole("button", { name: /a year$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/for accounts without a card or App Store subscription/i)).toBeInTheDocument();

    // Model credits keep card first and token top-ups behind a disclosure.
    await openTab("Credits");
    expect(screen.getByRole("button", { name: /top up by card/i })).toBeVisible();
    expect(screen.getByText("Optional token top-ups").closest("details")).not.toHaveAttribute("open");
  });

  it("shows the verified wallet and refreshes its balance", async () => {
    render(<BillingPage />);
    await openTab("Payment methods");

    await waitFor(() => {
      expect(screen.getByText("Wallet verified")).toBeInTheDocument();
    });

    // Wallet state only: the full address and the last checked balance.
    expect(screen.getByText("0x000000000000000000000000000000000000dEaD")).toBeInTheDocument();
    expect(screen.getByText("1.25 $HermesOS")).toBeInTheDocument();
    expect(screen.queryByText(/base tier ready|minimum met|below minimum/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token base compute|basic machine/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /refresh token status/i }));

    await waitFor(() => {
      expect(screen.getByText("2 $HermesOS")).toBeInTheDocument();
    });
    expect(screen.queryByText("1.25 $HermesOS")).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/token-holding", { method: "POST" });
  });

  it("never shows base-tier minimums or a qualified verdict in the plan-hold block, whatever the balance", async () => {
    for (const plan of [
      { key: "free", name: "Free", source: "free" },
      { key: "fleet", name: "Power", source: "stripe" },
    ]) {
      subscribedAs(plan);
      tokenHoldingData = {
        ...tokenHoldingData,
        snapshot: { id: "snap", balanceDisplay: "0.75", qualifiesBaseTier: false, checkedAt: "2026-04-24T12:01:00.000Z" },
        entitlement: { verified: true, qualifiesBaseTier: false },
      };
      const { unmount } = render(<BillingPage />);
      await openTab("Payment methods");
      const holdBlock = screen.getByRole("heading", { name: "Hold $HermesOS for ongoing access" })
        .parentElement as HTMLElement;
      expect(await within(holdBlock).findByText("0.75 $HermesOS")).toBeInTheDocument();
      expect(holdBlock).not.toHaveTextContent(/minimum|qualified|base tier|(^|[^\d.])1 \$HermesOS/i);
      unmount();
    }
  });

  it("creates a pending USDC crypto top-up intent from billing", async () => {
    render(<BillingPage />);
    await openTab("Credits");

    await waitFor(() => {
      expect(screen.getByText(/crypto credits/i)).toBeInTheDocument();
    });

    // The "$HermesOS · Bonus path prepared" placeholder promised a bonus the
    // USDC path does not have; it is gone.
    expect(screen.queryByText(/bonus path prepared/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create usdc top-up for 1000 credits/i }));

    await waitFor(() => {
      expect(screen.getByText(/pending deposit/i)).toBeInTheDocument();
    });

    // Plain English, no provider jargon.
    const panel = screen.getByRole("region", { name: "USDC on Base" });
    const description = within(panel).getByText(EN_BILLING.cryptoCredits.description);
    expect(description).not.toHaveTextContent(/bankr|reconciliation/i);
    // The exact amount and the address, each with a copy button.
    const amountField = within(panel).getByRole("button", { name: "Copy amount" }).closest("div")
      ?.parentElement as HTMLElement;
    expect(amountField).toHaveTextContent(/Send\s*10\s*USDC on Base/);
    const addressField = within(panel).getByRole("button", { name: "Copy address" }).closest("div")
      ?.parentElement as HTMLElement;
    expect(within(addressField).getByText("0x000000000000000000000000000000000000dead")).toBeInTheDocument();
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
    // The modal opens over the Credits tab.
    expect(screen.getByRole("tab", { name: "Credits" })).toHaveAttribute("aria-selected", "true");

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
    mockGet.mockImplementation((key: string) => {
      if (key === "managedVenice") return "deposit";
      if (key === "wallet") return "card";
      if (key === "amountUsd") return "50";
      return null;
    });
    const location = stubLocation("http://localhost/dashboard/billing?managedVenice=deposit&wallet=card&amountUsd=50");

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
      expect(location.assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/managed-venice-card");
    } finally {
      location.restore();
    }
  });

  it("connects a browser wallet, verifies the signature, and refreshes token status", async () => {
    tokenHoldingData = {
      token: {
        chainId: 8453,
        tokenAddress: HERMESOS_CONTRACT,
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
        tokenAddress: HERMESOS_CONTRACT,
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
    await openTab("Payment methods");

    await waitFor(() => {
      expect(screen.getByText(/no verified wallet/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

    await waitFor(() => {
      expect(screen.getByText("0x000000000000000000000000000000000000dead")).toBeInTheDocument();
      expect(screen.getByText("2 $HermesOS")).toBeInTheDocument();
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

  it("asks the owner to confirm it's them when verifying a wallet needs it, then retries the same signed request", async () => {
    type Fetcher = (...args: unknown[]) => Promise<unknown>;
    const clerk = jest.requireMock("@clerk/nextjs") as { useReverification: (fetcher: Fetcher) => Fetcher };
    const passthrough = clerk.useReverification;
    let prompts = 0;
    // Clerk's useReverification, faithfully enough: a reverification answer
    // opens the "confirm it's you" dialog, then the request is retried.
    clerk.useReverification = (fetcher) => async (...args) => {
      const first = (await fetcher(...args)) as { clerk_error?: { reason?: string } } | undefined;
      if (first?.clerk_error?.reason !== "reverification-error") return first;
      prompts += 1;
      return fetcher(...args);
    };
    try {
      tokenHoldingData = {
        token: { chainId: 8453, tokenAddress: HERMESOS_CONTRACT, tokenSymbol: "Hivra", minimumBalanceDisplay: "1" },
        wallet: null,
        snapshot: null,
        entitlement: { verified: false, qualifiesBaseTier: false },
      };
      tokenRefreshData = {
        token: { chainId: 8453, tokenAddress: HERMESOS_CONTRACT, tokenSymbol: "Hivra", minimumBalanceDisplay: "1" },
        refresh: {
          status: "refreshed",
          snapshot: { id: "snapshot_2", balanceDisplay: "2", qualifiesBaseTier: true, checkedAt: "2026-04-24T12:05:00.000Z" },
        },
        entitlement: { verified: true, qualifiesBaseTier: true },
      };
      const baseFetch = fetchMock.getMockImplementation()!;
      let verifyCalls = 0;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("/api/billing/wallet/verify")) {
          verifyCalls += 1;
          if (verifyCalls === 1) {
            return Promise.resolve(apiResponse(
              { clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: "strict" } } },
              { ok: false, status: 403 },
            ));
          }
        }
        return baseFetch(input, init);
      });
      (window as unknown as { ethereum?: { request: jest.Mock } }).ethereum = {
        request: jest.fn()
          .mockResolvedValueOnce(["0x000000000000000000000000000000000000dEaD"])
          .mockResolvedValueOnce("0xsigned"),
      };

      render(<BillingPage />);
      await openTab("Payment methods");
      await waitFor(() => {
        expect(screen.getByText(/no verified wallet/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

      await waitFor(() => {
        expect(screen.getByText("0x000000000000000000000000000000000000dead")).toBeInTheDocument();
      });
      expect(prompts).toBe(1);
      expect(verifyCalls).toBe(2);
    } finally {
      clerk.useReverification = passthrough;
    }
  });

  it("asks the wallet for accounts on billing even when the provider reports disconnected before permission", async () => {
    tokenHoldingData = {
      token: {
        chainId: 8453,
        tokenAddress: HERMESOS_CONTRACT,
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
        tokenAddress: HERMESOS_CONTRACT,
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
    await openTab("Payment methods");

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
    notSubscribed();

    render(<BillingPage />);

    expect(await screen.findByRole("heading", { name: "Choose a plan" })).toBeInTheDocument();

    await openTab("Overview");
    expect(screen.getByRole("heading", { name: "No plan yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a plan" })).toBeInTheDocument();

    await openTab("Credits");
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("100 credits = $1")).not.toBeInTheDocument();
    expect(screen.queryByText(/monthly plan credits/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\$5\s*500/i })).toBeInTheDocument();
  });

  it("keeps subscription checkout available when billing v2 and crypto are disabled", async () => {
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    notSubscribed();

    render(<BillingPage />);

    expect(await screen.findByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");

    // Card-path CTA was "Get Started" pre-2026-05-01 redesign; the
    // Card/Crypto tab split changed it to "Subscribe · $X/mo|/yr".
    expect(screen.getAllByRole("button", { name: /subscribe ·/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab", { name: "Credits" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "History" })).not.toBeInTheDocument();
    expect(screen.queryByText(EN_BILLING.credits.description)).not.toBeInTheDocument();
    expect(screen.queryByText(/crypto credits/i)).not.toBeInTheDocument();

    await openTab("Payment methods");
    expect(screen.getByRole("link", { name: "About $HermesOS access" })).toHaveAttribute("href", "/token");
    // With billing v2 off there is no $HermesOS path anywhere, so the plain line is true.
    expect(
      screen.getByText("Crypto payments aren't available right now. Card payments work as usual.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /go to credits/i })).not.toBeInTheDocument();
    // The usage API knows how the plan is paid, not whether a card is saved.
    expect(
      screen.getByText("Your plan isn't billed to a card. You'll enter card details at checkout.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/no card on file/i)).not.toBeInTheDocument();
  });

  it("carries a launch return path into checkout and offers the way back", async () => {
    const location = stubLocation("http://localhost/dashboard/billing?from=launch");
    const launchReturn = "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333";
    mockGet.mockImplementation((key: string) => ({ from: "launch", returnTo: launchReturn } as Record<string, string>)[key] ?? null);
    const defaultFetch = fetchMock.getMockImplementation();
    usageData = {
      ...usageData,
      plan: { key: "free", name: "Free", price: 0, maxAgents: 1, totalCpu: 0.5, totalRam: 1024, status: "active", currentPeriodEnd: null, source: "free" },
    };
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes("/api/billing/subscribe")) {
        return Promise.resolve(jsonResponse({ url: "https://checkout.stripe.test/session" }));
      }
      return defaultFetch?.(input, init) ?? Promise.resolve(jsonResponse({}));
    });

    try {
      render(<BillingPage />);
      expect(await screen.findByRole("link", { name: /back to your launch/i })).toHaveAttribute("href", launchReturn);
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
      });
      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
      fireEvent.click(await screen.findByRole("button", { name: /open checkout/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: "operator", cadence: "monthly", returnTo: launchReturn }),
        });
      });
      expect(location.assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session");
    } finally {
      location.restore();
    }
  });

  it("opens Stripe checkout when a Free plan user upgrades from the plans ladder", async () => {
    const location = stubLocation("http://localhost/dashboard/billing");
    const defaultFetch = fetchMock.getMockImplementation();

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
        source: "free",
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

      // Overview: the free plate, with no card controls to manage.
      expect(await screen.findByText("Free · no charge")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /manage payment method/i })).not.toBeInTheDocument();
      expect(screen.getByText("Sleeps after 4 idle days")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Change plan" }));
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
      });
      expect(screen.getByRole("heading", { name: /change plan/i, level: 2 })).toBeInTheDocument();
      // A free account checks out, so it picks a cadence (and can pay with $HermesOS).
      expect(screen.getByRole("radiogroup", { name: "Billing cadence" })).toBeInTheDocument();
      expect(screen.getByRole("radiogroup", { name: "Payment method" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
      expect(await screen.findByRole("heading", { name: /open secure checkout/i })).toBeInTheDocument();
      // Monthly checkout confirms the monthly price.
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent(/\$9\.99\s*\/mo/);
      expect(dialog).not.toHaveTextContent("/yr");
      fireEvent.click(screen.getByRole("button", { name: /open checkout/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: "operator", cadence: "monthly" }),
        });
      });

      expect(fetchMock.mock.calls.some(([url]) => url === "/api/billing/change-plan")).toBe(false);
      expect(location.assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session");
    } finally {
      location.restore();
    }
  });

  it("opens secure checkout for paid plans that cannot change in place", async () => {
    const location = stubLocation("http://localhost/dashboard/billing");
    const defaultFetch = fetchMock.getMockImplementation();

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
      await openTab("Plans");

      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Power" }));

      expect(await screen.findByRole("heading", { name: /open secure checkout/i })).toBeInTheDocument();
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
      expect(location.assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/paid-switch");
    } finally {
      location.restore();
    }
  });

  it("confirms a self-serve downgrade in the change-plan dialog before changing anything", async () => {
    process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED = "true";
    subscribedAs({ source: "stripe", canChangePlanInPlace: true, name: "Power" });
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes("/api/billing/change-plan")) {
        return Promise.resolve(jsonResponse({ message: "Plan changed to Pro." }));
      }
      return defaultFetch?.(input, init) ?? Promise.resolve(jsonResponse({}));
    });

    render(<BillingPage />);
    await openTab("Plans");

    // In-place changes bill monthly, so no cadence choice is offered.
    expect(screen.queryByRole("radiogroup", { name: "Billing cadence" })).not.toBeInTheDocument();
    expect(screen.getByText(/move your subscription to monthly billing/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Pro" }));

    const dialog = await screen.findByRole("dialog");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/billing/change-plan")).toBe(false);
    expect(within(dialog).getByText(/fewer vCPU/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Switch to Pro" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPlan: "operator" }),
      });
    });
    expect(await screen.findByText("Plan changed to Pro.")).toBeInTheDocument();
  });

  it("offers no self-serve downgrade and says so when the flag is off", async () => {
    delete process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED;
    subscribedAs({ source: "stripe", canChangePlanInPlace: true });

    render(<BillingPage />);
    await openTab("Plans");

    expect(screen.queryByRole("button", { name: /^switch to/i })).not.toBeInTheDocument();
    expect(screen.getByText("Moving to a smaller plan isn't self-serve yet")).toBeInTheDocument();
    expect(screen.getByText("To move to Free, cancel your subscription")).toBeInTheDocument();
  });

  it("keeps Apple subscribers in the App Store and away from Stripe controls", async () => {
    subscribedAs({ key: "operator", name: "Pro", source: "apple_iap", canChangePlanInPlace: false, currentPeriodEnd: "2026-11-01T00:00:00.000Z" });

    render(<BillingPage />);

    // No auto-renew signal reaches the page, so it never promises a renewal.
    expect(await screen.findByText(/^Billed through the App Store · current billing period ends /)).toBeInTheDocument();
    expect(screen.queryByText(/renews/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage payment method/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel subscription/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage in the App Store" })).toHaveAttribute(
      "href",
      "https://apps.apple.com/account/subscriptions"
    );

    await openTab("Plans");
    expect(screen.queryByRole("button", { name: /^upgrade to/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /subscribe/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Billing cadence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Payment method" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Change plans in the App Store").length).toBeGreaterThan(0);

    await openTab("Payment methods");
    expect(screen.queryByRole("button", { name: "Open billing portal" })).not.toBeInTheDocument();
    expect(screen.getByText(/You pay through the App Store/)).toBeInTheDocument();
  });

  it("says how a yearly $HermesOS plan is paid and never offers card controls for it", async () => {
    subscribedAs({
      key: "operator",
      name: "Pro",
      source: "token_yearly",
      tokenTier: "pro",
      canChangePlanInPlace: false,
      currentPeriodEnd: "2027-05-01T00:00:00.000Z",
    });

    render(<BillingPage />);

    const line = await screen.findByText(/^Paid with \$HermesOS · active until .+ · doesn't renew automatically$/);
    expect(line).toBeInTheDocument();
    expect(screen.queryByText(/\/month/)).not.toBeInTheDocument();
    expect(screen.queryByText(/renews/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage payment method/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel subscription/i })).not.toBeInTheDocument();

    await openTab("Payment methods");
    expect(screen.getByText("Your plan is paid with $HermesOS, not a card.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open billing portal" })).not.toBeInTheDocument();
  });

  it("never claims a monthly price for a card plan whose cadence it cannot see", async () => {
    subscribedAs({ source: "stripe", currentPeriodEnd: "2026-10-12T00:00:00.000Z" });

    render(<BillingPage />);

    expect(await screen.findByText(/^Billed by card · current billing period ends /)).toBeInTheDocument();
    expect(screen.queryByText(/renews/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/month/)).not.toBeInTheDocument();
    // Segmented slot meter: one cell per slot, filled for slots in use.
    const slots = screen.getByRole("meter", { name: "Agents & computers" });
    expect(slots).toHaveAttribute("aria-valuetext", "1 of 3 slots in use");
    expect(slots.querySelectorAll('li[data-used="true"]')).toHaveLength(1);
    expect(slots.querySelectorAll("li")).toHaveLength(3);
    // The row is sized for exactly one cell per slot.
    expect((slots.querySelector("ul") as HTMLElement).style.getPropertyValue("--slot-count")).toBe("3");
    expect(screen.getByRole("meter", { name: "vCPU" })).toHaveAttribute("aria-valuetext", "2 of 8 vCPU allocated");
    expect(screen.getByRole("meter", { name: "Memory" })).toHaveAttribute("aria-valuetext", "4 of 16 GB allocated");
  });

  it("shows a Command subscriber their plan as the current card and hides the planned sizes", async () => {
    subscribedAs({ key: "command", name: "Command", source: "stripe", canChangePlanInPlace: true });

    render(<BillingPage />);
    await openTab("Plans");

    const command = screen.getByRole("article", { name: "Command" });
    expect(within(command).getAllByText("Current plan").length).toBeGreaterThan(0);
    expect(within(command).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Bigger machines are planned")).not.toBeInTheDocument();
  });

  it("shows planned sizes as not for sale, with no way to buy them", async () => {
    notSubscribed();

    render(<BillingPage />);

    const planned = (await screen.findByText("Bigger machines are planned")).closest("section") as HTMLElement;
    expect(planned).toHaveTextContent("Planned — not available to buy yet");
    expect(planned).toHaveTextContent("Studio");
    expect(planned).toHaveTextContent("8 vCPU · 16 GB · $49/mo");
    expect(planned).toHaveTextContent("Max");
    expect(planned).toHaveTextContent("12 vCPU · 32 GB · $99/mo");
    expect(within(planned).queryByRole("button")).not.toBeInTheDocument();
    expect(within(planned).queryByRole("link")).not.toBeInTheDocument();
    // Only today's plans are sold: no public-ladder Starter card, one "Pro".
    expect(screen.queryByRole("article", { name: "Starter" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: "Pro" })).toHaveLength(1);
  });

  it("labels each plan card with its own tagline, never another plan's", async () => {
    notSubscribed();

    render(<BillingPage />);

    const free = await screen.findByRole("article", { name: "Free" });
    expect(free).toHaveTextContent("start without a bill");
    expect(free).not.toHaveTextContent(/Power/);
    expect(within(free).getByRole("button", { name: "Start free" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Power" })).toHaveTextContent("Most popular");
  });

  it("switches card prices to yearly with computed savings and checks out yearly", async () => {
    const location = stubLocation("http://localhost/dashboard/billing");
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes("/api/billing/subscribe")) {
        return Promise.resolve(jsonResponse({ url: "https://checkout.stripe.test/yearly" }));
      }
      return defaultFetch?.(input, init) ?? Promise.resolve(jsonResponse({}));
    });
    notSubscribed();

    try {
      render(<BillingPage />);

      // 34% (Pro) and 37% (Power), rounded down; never the old literals.
      expect(await screen.findByText("Save up to 37% yearly")).toBeInTheDocument();
      const pro = screen.getByRole("article", { name: "Pro" });
      expect(within(pro).getByRole("button", { name: "Subscribe · $9.99/mo" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: "Yearly" }));
      expect(screen.getByRole("radio", { name: "Yearly" })).toHaveAttribute("aria-checked", "true");
      expect(pro).toHaveTextContent("$79");
      // Rounded up: $6.59 x 12 never comes to less than $79.
      expect(pro).toHaveTextContent("$6.59/mo billed yearly");

      fireEvent.click(within(pro).getByRole("button", { name: "Subscribe · $79/yr" }));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: "operator", cadence: "yearly" }),
        });
      });
      expect(location.assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/yearly");
    } finally {
      location.restore();
    }
  });

  it("offers a $HermesOS year or holding without hardcoded hold prices", async () => {
    notSubscribed();
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes("/api/billing/yearly-token-quote") && requestMethod(input, init) === "POST") {
        return Promise.resolve(apiResponse({
          success: true,
          data: {
            id: "yq_new",
            tier: "pro",
            usdTargetCents: 4900,
            priceUsdAtQuote: "0.0000025",
            tokensRequiredDisplay: "19600000",
            tokenSymbol: "Hivra",
            depositAddress: "0x000000000000000000000000000000000000ba5e",
            expiresAt: "2099-01-01T00:00:00.000Z",
            status: "active",
          },
        }));
      }
      if (requestUrl(input).includes("/api/billing/wallet/eligibility")) {
        // Deliberately unlike any old hardcoded price, so the cards can only
        // be showing what the server resolved for this account.
        return Promise.resolve(jsonResponse({
          balance: null,
          thresholds: { configured: true, proDisplay: "10,000,000", powerDisplay: "25,000,000", priceUsd: "0.00001" },
          tiers: {
            pro: { currentlyEligible: false, currentThresholdDisplay: "10,000,000" },
            power: { currentlyEligible: false, currentThresholdDisplay: "25,000,000" },
          },
        }));
      }
      return defaultFetch?.(input, init) ?? Promise.resolve(jsonResponse({}));
    });

    render(<BillingPage />);

    fireEvent.click(await screen.findByRole("radio", { name: "$HermesOS" }));
    expect(screen.queryByRole("radiogroup", { name: "Billing cadence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Free" })).not.toBeInTheDocument();
    expect(screen.getByText("Token payments are final, except where the law gives you a right to cancel.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Hold to qualify" }));
    const holdLinks = screen.getAllByRole("link", { name: /verify a wallet to hold/i });
    expect(holdLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard/wallet?from=billing&plan=pro",
      "/dashboard/wallet?from=billing&plan=power",
    ]);
    // Hold amounts depend on the user's pricing epoch: the cards show what the
    // eligibility API resolved, never a hardcoded price.
    const proCard = screen.getByRole("article", { name: "Pro" });
    expect(await within(proCard).findByText("Hold 10,000,000 $HermesOS in a verified wallet · move it any time")).toBeInTheDocument();
    expect(proCard).toHaveTextContent("≈$100");
    expect(screen.getByRole("article", { name: "Power" })).toHaveTextContent("≈$250");
    for (const name of ["Pro", "Power"]) {
      expect(screen.getByRole("article", { name })).not.toHaveTextContent(/\$(99|149|199|299)\b/);
    }

    fireEvent.click(screen.getByRole("radio", { name: "Pay for a year" }));
    const pro = screen.getByRole("article", { name: "Pro" });
    fireEvent.click(within(pro).getByRole("button", { name: "Pay a year · $49 in $HermesOS" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/yearly-token-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "pro" }),
      });
    });
    expect(await screen.findByRole("dialog", { name: /Pay Pro yearly with \$HermesOS/ })).toBeInTheDocument();
  });

  it("shows the no-wallet token state without blocking billing", async () => {
    tokenHoldingData = {
      token: {
        chainId: 8453,
        tokenAddress: HERMESOS_CONTRACT,
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
    await openTab("Payment methods");

    await waitFor(() => {
      expect(screen.getByText(/no verified wallet/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Not verified")).toBeInTheDocument();
    // No wallet, so no balance row and nothing to copy.
    expect(screen.queryByText("No snapshot")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();

    await openTab("Overview");
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
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });

  describe("regressions from the redesign review", () => {
    function withSubscribeResponse(url: string) {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("/api/billing/subscribe")) {
          return Promise.resolve(jsonResponse({ url }));
        }
        return base(input, init);
      });
    }

    it("confirms a yearly checkout at the yearly price checkout will charge", async () => {
      const location = stubLocation("http://localhost/dashboard/billing");
      withSubscribeResponse("https://checkout.stripe.test/yearly-upgrade");
      subscribedAs({ key: "free", name: "Free", price: 0, source: "free", canChangePlanInPlace: false });

      try {
        render(<BillingPage />);
        await openTab("Plans");
        fireEvent.click(screen.getByRole("radio", { name: "Yearly" }));
        const pro = screen.getByRole("article", { name: "Pro" });
        expect(pro).toHaveTextContent("$79");

        fireEvent.click(within(pro).getByRole("button", { name: "Upgrade to Pro" }));
        const dialog = await screen.findByRole("dialog");
        // The same figure and period as the card, never the monthly price.
        expect(dialog).toHaveTextContent(/\$79\.00\s*\/yr/);
        expect(dialog).not.toHaveTextContent("$9.99");
        expect(dialog).not.toHaveTextContent("/mo");

        fireEvent.click(within(dialog).getByRole("button", { name: /open checkout/i }));
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ plan: "operator", cadence: "yearly" }),
          });
        });
      } finally {
        location.restore();
      }
    });

    it("shows in-place subscribers monthly prices even when a link asks for yearly", async () => {
      // The cancel save-offer links here with ?cadence=yearly; in-place
      // changes can only bill monthly, so cards must not claim yearly prices.
      mockGet.mockImplementation((key: string) =>
        key === "cadence" ? "yearly" : key === "from" ? "cancel_save" : null
      );
      subscribedAs({ key: "operator", name: "Pro", source: "stripe", canChangePlanInPlace: true });

      render(<BillingPage />);
      expect(await screen.findByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");

      expect(screen.queryByRole("radiogroup", { name: "Billing cadence" })).not.toBeInTheDocument();
      const pro = screen.getByRole("article", { name: "Pro" });
      expect(pro).toHaveTextContent("$9.99");
      expect(pro).not.toHaveTextContent("$79");
      expect(pro).not.toHaveTextContent("/yr");
      expect(screen.getByRole("article", { name: "Power" })).toHaveTextContent("$19.99");
      expect(
        screen.getByText(
          "Plan changes apply right away and move your subscription to monthly billing. On a monthly plan, the price difference for the rest of this billing period is added to your next invoice. A yearly plan is invoiced today instead, with credit for its unused time."
        )
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Power" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent(/\$19\.99\s*\/mo/);
    });

    it("offers no Monthly/Yearly choice when no card on the ladder can be bought", async () => {
      // A manual Command subscription goes through checkout, but every other
      // card is a note, so a cadence choice (and its savings chip) means nothing.
      subscribedAs({ key: "command", name: "Command", source: "stripe", canChangePlanInPlace: false });

      render(<BillingPage />);
      await openTab("Plans");

      expect(screen.getByRole("article", { name: "Command" })).toBeInTheDocument();
      expect(screen.queryByRole("radiogroup", { name: "Billing cadence" })).not.toBeInTheDocument();
      expect(screen.queryByText(/save up to/i)).not.toBeInTheDocument();
    });

    it("never sells a Power $HermesOS user a smaller Pro year, in either tab", async () => {
      for (const source of ["token_yearly", "token_holding"] as const) {
        subscribedAs({
          key: "fleet",
          name: "Power",
          source,
          tokenTier: "power",
          canChangePlanInPlace: false,
          currentPeriodEnd: source === "token_yearly" ? "2027-05-01T00:00:00.000Z" : null,
        });
        const { unmount } = render(<BillingPage />);

        await openTab("Payment methods");
        expect(screen.queryByRole("button", { name: /Pro · \$49/ })).not.toBeInTheDocument();
        expect(screen.getByText("Your current plan already covers Pro.")).toBeInTheDocument();
        expect(
          screen.getByRole("button", {
            name: source === "token_yearly" ? "Add a year · Power · $99" : "Power · $99 a year",
          })
        ).toBeInTheDocument();

        await openTab("Plans");
        fireEvent.click(screen.getByRole("radio", { name: "$HermesOS" }));
        expect(within(screen.getByRole("article", { name: "Pro" })).queryByRole("button")).not.toBeInTheDocument();
        expect(screen.getByRole("article", { name: "Pro" })).toHaveTextContent("Your current plan already covers this");
        unmount();
      }
    });

    it("labels a same-tier $HermesOS payment as adding a year and still offers the bigger tier", async () => {
      subscribedAs({
        key: "operator",
        name: "Pro",
        source: "token_yearly",
        tokenTier: "pro",
        canChangePlanInPlace: false,
        currentPeriodEnd: "2027-05-01T00:00:00.000Z",
      });

      render(<BillingPage />);
      await openTab("Payment methods");

      expect(screen.getByRole("button", { name: "Add a year · Pro · $49" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Power · $99 a year" })).toBeInTheDocument();
      expect(screen.queryByText(/already covers/)).not.toBeInTheDocument();

      await openTab("Plans");
      fireEvent.click(screen.getByRole("radio", { name: "$HermesOS" }));
      const pro = screen.getByRole("article", { name: "Pro" });
      expect(within(pro).getByRole("button", { name: "Add a year · $49 in $HermesOS" })).toBeInTheDocument();
    });

    it("lands a client-side #managed-venice navigation on Credits even though Next writes the URL after render", async () => {
      // What Next's HistoryUpdater does on router.push("/dashboard/billing#managed-venice"):
      // it writes the URL in an insertion effect, after the page has rendered.
      function CommitHash() {
        useInsertionEffect(() => {
          window.history.replaceState(null, "", "/dashboard/billing#managed-venice");
        }, []);
        return null;
      }
      expect(window.location.hash).toBe("");

      render(
        <>
          <CommitHash />
          <BillingPage />
        </>
      );

      expect(await screen.findByRole("tab", { name: "Credits" })).toHaveAttribute("aria-selected", "true");
      await waitFor(() => {
        expect(document.getElementById("managed-venice")).toBeInTheDocument();
      });
    });

    it("counts every model-credit wallet in the Overview tile", async () => {
      render(<BillingPage />);
      // $25 on card + $40 available in the $HermesOS wallet.
      const tile = (await screen.findByText("Model credits")).closest("button") as HTMLElement;
      expect(tile).toHaveTextContent("$65.00");
    });

    it("offers the backup add-on only where the backup route can sell it", async () => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("/api/billing/backup-addon")) {
          return Promise.resolve(jsonResponse({ message: "ok" }));
        }
        return base(input, init);
      });
      const alertSpy = jest.spyOn(window, "alert").mockImplementation(() => undefined);

      try {
        // Sellable: a live card plan and a machine the route accepts.
        subscribedAs({ source: "stripe", canChangePlanInPlace: true });
        const sellable = render(<BillingPage />);
        fireEvent.click(await screen.findByRole("button", { name: "Enable Daily Backups — $10/mo" }));
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledWith("/api/billing/backup-addon", expect.objectContaining({
            body: JSON.stringify({ instanceId: "inst-123" }),
          }));
        });
        sellable.unmount();

        // Not sellable (a $HermesOS plan): no offer, no price.
        subscribedAs({ key: "operator", name: "Pro", source: "token_yearly", tokenTier: "pro", canChangePlanInPlace: false });
        usageData = {
          ...usageData,
          usage: {
            ...(usageData.usage as Record<string, unknown>),
            backupAddon: { purchasable: false, instanceIds: [], includedWithPlan: false },
          },
        };
        const tokenPlan = render(<BillingPage />);
        expect(await screen.findByRole("heading", { level: 2, name: /Pro/ })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /enable daily backups/i })).not.toBeInTheDocument();
        expect(screen.queryByText("+$10/mo")).not.toBeInTheDocument();
        tokenPlan.unmount();

        // An older API without the field: never offer it.
        usageData = {
          ...usageData,
          usage: { ...(usageData.usage as Record<string, unknown>), backupAddon: undefined },
        };
        const legacy = render(<BillingPage />);
        expect(await screen.findByRole("heading", { level: 2, name: /Pro/ })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /enable daily backups/i })).not.toBeInTheDocument();
        legacy.unmount();

        // Included with the plan (Proxmox paid tier): protected, no charge.
        subscribedAs({ key: "fleet", name: "Power", source: "stripe", canChangePlanInPlace: true });
        usageData = {
          ...usageData,
          usage: {
            ...(usageData.usage as Record<string, unknown>),
            backupAddon: { purchasable: false, instanceIds: [], includedWithPlan: true },
          },
        };
        render(<BillingPage />);
        const panel = (await screen.findByText("Daily backups")).closest("section") as HTMLElement;
        expect(panel).toHaveTextContent("Included with your plan");
        expect(panel).toHaveTextContent("Protected");
        expect(panel).not.toHaveTextContent("$10");
        expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("says the backup add-on isn't available when the console link lands on a plan that can't buy it", async () => {
      mockGet.mockImplementation((key: string) => {
        if (key === "intent") return "backups";
        if (key === "instanceId") return "inst-123";
        return null;
      });
      subscribedAs({ key: "operator", name: "Pro", source: "token_holding", tokenTier: "pro", canChangePlanInPlace: false });
      usageData = {
        ...usageData,
        usage: {
          ...(usageData.usage as Record<string, unknown>),
          backupAddon: { purchasable: false, instanceIds: [], includedWithPlan: false },
        },
      };

      render(<BillingPage />);

      expect(await screen.findByText(/backup add-on isn't available for this plan or machine yet/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /enable daily backups/i })).not.toBeInTheDocument();
    });

    it("keeps the change-plan dialog busy until the new plan has loaded", async () => {
      subscribedAs({ key: "operator", name: "Pro", source: "stripe", canChangePlanInPlace: true });
      const pendingRefresh: { resolve?: (value: Response) => void } = {};
      let usageCalls = 0;
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("/api/billing/change-plan")) {
          return Promise.resolve(jsonResponse({ message: "Plan changed to Power." }));
        }
        if (url.includes("/api/billing/usage")) {
          usageCalls += 1;
          if (usageCalls > 1) {
            return new Promise<Response>((resolve) => {
              pendingRefresh.resolve = resolve;
            });
          }
        }
        return base(input, init);
      });

      render(<BillingPage />);
      await openTab("Plans");
      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Power" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Upgrade" }));

      // The change went through and usage is reloading: the dialog stays busy
      // and the ladder's plan-change buttons are off, so nothing can be sent
      // twice against the old plan.
      expect(await screen.findByText("Plan changed to Power.")).toBeInTheDocument();
      await waitFor(() => expect(usageCalls).toBe(2));
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: /processing/i })).toBeDisabled();

      await act(async () => {
        pendingRefresh.resolve?.(
          jsonResponse({
            ...usageData,
            plan: { ...(usageData.plan as Record<string, unknown>), key: "fleet", name: "Power" },
          })
        );
      });

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(within(screen.getByRole("article", { name: "Power" })).getAllByText("Current plan").length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Upgrade to Power" })).not.toBeInTheDocument();
    });

    it("goes back to the launch an in-place upgrade started from once the new plan has loaded", async () => {
      const launchReturn = "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333";
      mockGet.mockImplementation((key: string) => ({ from: "launch", returnTo: launchReturn } as Record<string, string>)[key] ?? null);
      subscribedAs({ key: "operator", name: "Pro", source: "stripe", canChangePlanInPlace: true });
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("/api/billing/change-plan")) {
          return Promise.resolve(jsonResponse({ message: "Plan changed to Power." }));
        }
        return base(input, init);
      });

      render(<BillingPage />);
      await openTab("Plans");
      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Power" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Upgrade" }));

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`${launchReturn}&upgraded=fleet`));
    });

    it("brings a plan-change result into view when it lands above the screen", async () => {
      process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED = "true";
      subscribedAs({ source: "stripe", canChangePlanInPlace: true, name: "Power" });
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes("/api/billing/change-plan")) {
          return Promise.resolve(apiResponse({ success: false, error: "Too many agents for Pro." }, { ok: false, status: 409 }));
        }
        return base(input, init);
      });
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      const originalScroll = HTMLElement.prototype.scrollIntoView;
      const scrollSpy = jest.fn();
      HTMLElement.prototype.scrollIntoView = scrollSpy;
      // On a phone the alerts sit far above the Plans ladder.
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this.dataset.testid === "billing-alerts") {
          return { top: -900, bottom: -800, left: 0, right: 360, width: 360, height: 100, x: 0, y: -900, toJSON: () => ({}) } as DOMRect;
        }
        return originalRect.call(this);
      };

      try {
        render(<BillingPage />);
        await openTab("Plans");
        fireEvent.click(screen.getByRole("button", { name: "Switch to Pro" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Switch to Pro" }));

        expect(await screen.findByText("Too many agents for Pro.")).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        const alerts = screen.getByTestId("billing-alerts");
        await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
        expect(scrollSpy.mock.contexts[0]).toBe(alerts);
        expect(alerts).toHaveFocus();
      } finally {
        HTMLElement.prototype.getBoundingClientRect = originalRect;
        HTMLElement.prototype.scrollIntoView = originalScroll;
      }
    });
  });

  it("dismisses the success banner with a labelled close control", async () => {
    mockGet.mockImplementation((key: string) => (key === "credits" ? "success" : null));

    render(<BillingPage />);

    expect(await screen.findByText(/Credits top-up complete/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Credits top-up complete/)).not.toBeInTheDocument();
  });
});
