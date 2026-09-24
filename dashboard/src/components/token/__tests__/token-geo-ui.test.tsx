/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
/**
 * Token geo-policy in the UI: for a viewer the server blocks, token promotions
 * (the token-year saving chip, bonus and launch-bonus copy, "use $HermesOS for
 * bonus credits", the conversion link) are hidden, card paths stay, and the
 * token pages keep their factual contract information with the notice.
 * The same components for an allowed viewer (the dormant policy) are unchanged.
 */
import "@testing-library/jest-dom";
import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { TokenGeoAccess } from "@/hooks/useTokenGeoAccess";

const GB_NOTICE = "Token features aren't available to people in the United Kingdom.";
const ALLOWED: TokenGeoAccess = { status: "allowed", notice: null };
const BLOCKED: TokenGeoAccess = { status: "blocked", notice: GB_NOTICE };
let mockAccess: TokenGeoAccess = ALLOWED;

jest.mock("@/hooks/useTokenGeoAccess", () => ({
  useTokenGeoAccess: () => mockAccess,
  tokenFeaturesShown: (access: { status: string }) => access.status === "allowed",
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});
jest.mock("next/image", () => {
  const MockImage = ({ src, alt, ...rest }: { src: string; alt: string; [key: string]: unknown }) => (
    <img src={src} alt={alt} {...rest} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});
jest.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => <button type="button">Theme</button> }));
jest.mock("@/components/landing/Footer", () => function MockFooter() {
  return <footer>Footer</footer>;
});
jest.mock("@/components/ui/animate-in", () => ({
  AnimateIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/ui/StyledDropdown", () => ({ StyledDropdown: () => null }));
jest.mock("@/lib/client/logger", () => ({ clientLog: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { PlansTab } from "@/app/dashboard/billing/_components/PlansTab";
import { PaymentMethodsTab } from "@/app/dashboard/billing/_components/PaymentMethodsTab";
import type { BillingController } from "@/app/dashboard/billing/useBillingController";
import { ManagedVeniceDepositModal } from "@/components/billing/ManagedVeniceDepositModal";
import { ConvertPanel } from "@/components/claim/ConvertPanel";
import { ManagedVeniceCreditsPocket } from "@/components/dashboard/command-center/ManagedVeniceCreditsPocket";
import { DeployForm } from "@/components/dashboard/welcome/DeployForm";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import FullTokenomicsSection from "@/components/landing/FullTokenomicsSection";
import TokenPageClient from "@/components/token/TokenPageClient";
import { validateHivraLaunchConfig } from "@/lib/billing/token-registry";
import { resolveConversionState } from "@/lib/claim/conversion-state";
import { getFeaturedProvider, PROVIDERS, type Provider } from "@/lib/models";
import { getTokenPageEntries } from "@/lib/token-verification-content";

const HERMESOS_PUBLISHED = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";

function controller(tokenGeo: TokenGeoAccess): BillingController {
  return {
    data: null,
    flags: { billingV2Enabled: true, cryptoBillingEnabled: true, creditTopUpsEnabled: true, selfServeDowngradeEnabled: false },
    tokenGeo,
    changePlanRequiresCheckout: true,
    paidPath: "crypto",
    cryptoMode: "yearly",
    cadence: "monthly",
    setPaidPath: jest.fn(),
    setCadence: jest.fn(),
    setCryptoMode: jest.fn(),
    subscribing: null,
    handleSubscribe: jest.fn(),
    yearly: { loading: false },
    handleYearlyTokenPay: jest.fn(),
    changingPlan: null,
    status: { loading: false, confirming: false },
    setConfirmingPlan: jest.fn(),
    subscriptionManagement: { showStripePortalButton: false, showAppleManageLink: false, appleManageUrl: "" },
    portalLoading: false,
    handlePortal: jest.fn(),
    managedVeniceSummary: {},
    tokenHolding: null,
    tokenLoading: false,
    tokenRefreshing: false,
    walletConnecting: false,
    tokenError: null,
    handleRefreshTokenHolding: jest.fn(),
    handleConnectWallet: jest.fn(),
  } as unknown as BillingController;
}

function withLocale(node: React.ReactNode) {
  return <LocaleProvider initialLocale="en">{node}</LocaleProvider>;
}

afterEach(() => {
  mockAccess = ALLOWED;
});

describe("billing Plans tab", () => {
  it("shows the token-year saving chip and the $HermesOS path to an allowed viewer", () => {
    render(<PlansTab c={controller(ALLOWED)} heading="Plans" />);
    expect(screen.getByText(/less than a card year/)).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Payment method" })).toBeInTheDocument();
  });

  it("hides the chip and the whole token path from a blocked viewer, leaving card plans", () => {
    render(<PlansTab c={controller(BLOCKED)} heading="Plans" />);
    expect(screen.queryByText(/less than a card year/)).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Payment method" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /\$HermesOS/ })).not.toBeInTheDocument();
    expect(screen.getByText(/7-day money-back guarantee/)).toBeInTheDocument();
  });

  it("keeps promotions hidden while the server hasn't answered", () => {
    render(<PlansTab c={controller({ status: "checking", notice: null })} heading="Plans" />);
    expect(screen.queryByText(/less than a card year/)).not.toBeInTheDocument();
  });
});

describe("billing Payment methods tab", () => {
  it("replaces the token payment paths with the notice for a blocked viewer", () => {
    render(withLocale(<PaymentMethodsTab c={controller(BLOCKED)} onGoTo={jest.fn()} />));
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.queryByText(/Pay a year with \$HermesOS/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Top up credits with USDC/)).not.toBeInTheDocument();
    expect(screen.queryByText(/top up model credits with \$HermesOS/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Manage an existing token holding/ })).toHaveAttribute(
      "href",
      "/dashboard/wallet?from=billing",
    );
  });

  it("is unchanged for an allowed viewer", () => {
    render(withLocale(<PaymentMethodsTab c={controller(ALLOWED)} onGoTo={jest.fn()} />));
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
    expect(screen.getByText(/Pay a year with \$HermesOS/)).toBeInTheDocument();
  });
});

describe("welcome managed-Venice top-up dialog", () => {
  function renderDialog() {
    render(<ManagedVeniceDepositModal isOpen initialWalletType="hermesos" onClose={jest.fn()} />);
  }

  it("offers $HermesOS and its launch bonus to an allowed viewer", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /pay with \$HermesOS/i })).toBeInTheDocument();
    expect(screen.getByText(/launch bonus credits/)).toBeInTheDocument();
  });

  it("is card-only for a blocked viewer, even when opened on $HermesOS", () => {
    mockAccess = BLOCKED;
    renderDialog();
    expect(screen.queryByRole("button", { name: /pay with \$HermesOS/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pay by card/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/launch bonus/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start card checkout/i })).toBeInTheDocument();
  });
});

describe("command-center credits pocket", () => {
  const summary = {
    wallets: {
      hermesos: { tokenDisplay: "0", lockedValueMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
      card: { balanceMicroUsd: 5_000_000, availableMicroUsd: 5_000_000, reservedMicroUsd: 0 },
    },
    discount: { rate: "launch_20", discountBps: 2000, launchSubsidyUsedMicroUsd: 1, launchSubsidyCapMicroUsd: 250_000_000 },
    killSwitch: { active: false, weeklySubsidyUsedMicroUsd: 1, thresholdMicroUsd: 1_000_000_000 },
    keys: [],
  } as unknown as Parameters<typeof ManagedVeniceCreditsPocket>[0]["summary"];

  it("drops the launch-bonus rows for a blocked viewer and keeps the balance", () => {
    mockAccess = BLOCKED;
    render(<ManagedVeniceCreditsPocket summary={summary} />);
    expect(screen.queryByText("Launch bonus")).not.toBeInTheDocument();
    expect(screen.queryByText("Launch allocation")).not.toBeInTheDocument();
    expect(screen.getByTestId("managed-venice-credits-pocket")).toHaveTextContent("$5.00");
  });

  it("shows them to an allowed viewer", () => {
    render(<ManagedVeniceCreditsPocket summary={summary} />);
    expect(screen.getByText("Launch bonus")).toBeInTheDocument();
  });
});

describe("welcome deploy form", () => {
  const provider: Provider = getFeaturedProvider(PROVIDERS) ?? PROVIDERS[0];

  function Harness() {
    const [walletType, setWalletType] = useState<"hermesos" | "card">("hermesos");
    const [managed, setManaged] = useState(true);
    const noop = () => undefined;
    return (
      <DeployForm
        agentName="AGENT"
        setAgentName={noop}
        managed={managed}
        setManaged={setManaged}
        cpuOptions={[1, 2]}
        ramOptions={[2, 4]}
        cpu={2}
        setCpu={noop}
        ramGb={4}
        setRamGb={noop}
        selectedProvider={provider}
        handleProviderSelect={noop}
        PROVIDERS={PROVIDERS}
        model={String(provider.models?.[0]?.value ?? "")}
        setModel={noop}
        modelOptions={[]}
        hasLiveModels={false}
        isLoadingLiveModels={false}
        liveModelsError=""
        apiKey=""
        setApiKey={noop}
        customBaseUrl=""
        setCustomBaseUrl={noop}
        useVaultKey={false}
        setUseVaultKey={noop}
        matchedVaultKey={null}
        honchoApiKey=""
        setHonchoApiKey={noop}
        useHonchoVaultKey={false}
        setUseHonchoVaultKey={noop}
        matchedHonchoVaultKey={null}
        deploying={false}
        handleDeploy={noop}
        managedVeniceWalletType={walletType}
        setManagedVeniceWalletType={setWalletType}
        onManagedVeniceDeposit={noop}
      />
    );
  }

  it("drops 'use $HermesOS for bonus credits' and the token top-up for a blocked viewer", () => {
    mockAccess = BLOCKED;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /advanced setup/i }));
    expect(screen.queryByText(/for bonus credits/)).not.toBeInTheDocument();
    expect(screen.getByText("No keys to manage. Pay Venice provider rates with card credits.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add credit first/i }));
    expect(screen.queryByText(/Optional token top-up/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pay with \$HermesOS/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/launch bonus cap/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start card credit top-up/i })).toBeInTheDocument();
  });

  it("keeps the token top-up and its bonus copy for an allowed viewer", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /advanced setup/i }));
    expect(screen.getByText(/use \$HermesOS for bonus credits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add credit first/i }));
    expect(screen.getByRole("button", { name: /pay with \$HermesOS/i })).toBeInTheDocument();
  });
});

describe("convert page panel", () => {
  const validation = validateHivraLaunchConfig({
    contractAddress: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-10-01T16:00:00Z",
  });
  const hivra = validation.status === "configured" ? validation.token : null;
  const openState = resolveConversionState({
    hivra,
    phase: "active",
    links: { termsUrl: "https://hivra.cloud/token/conversion-terms", conversionUrl: "https://bankr.bot/convert/hivra" },
    access: { grandfathered: false, convertedAt: null, conversionGraceEndsAt: null },
  });

  it("never shows the conversion link or switch step to a blocked viewer, and keeps the contracts", () => {
    expect(openState.status).toBe("open");
    render(<ConvertPanel state={openState} geoNotice={GB_NOTICE} />);
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
    expect(screen.queryByText(/check what you will receive before you convert/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Official contracts" })).toBeInTheDocument();
    expect(screen.getByText("0x1111111111111111111111111111111111111111")).toBeInTheDocument();
  });

  it("is unchanged without a notice", () => {
    render(<ConvertPanel state={openState} />);
    expect(screen.getByRole("link", { name: /go to conversion/i })).toBeInTheDocument();
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
  });
});

describe("/token page content", () => {
  it("keeps the factual contract information, adds the notice and drops the proposals for a blocked viewer", () => {
    render(<TokenPageClient entries={getTokenPageEntries()} geoNotice={GB_NOTICE} />);
    const main = within(screen.getByRole("main"));
    expect(main.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(main.getByText(HERMESOS_PUBLISHED)).toBeInTheDocument();
    expect(main.getByRole("link", { name: "View the contract on BaseScan" })).toHaveAttribute(
      "href",
      `https://basescan.org/token/${HERMESOS_PUBLISHED}`,
    );
    expect(main.getByRole("heading", { name: "Existing holder access" })).toBeInTheDocument();
    expect(main.queryByRole("heading", { name: "The proposed $HIVRA migration" })).not.toBeInTheDocument();
    expect(main.queryByRole("link", { name: /litepaper/i })).not.toBeInTheDocument();
  });

  it("has no notice and keeps the proposals for an allowed viewer", () => {
    render(<TokenPageClient entries={getTokenPageEntries()} />);
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The proposed $HIVRA migration" })).toBeInTheDocument();
  });
});

describe("/tokenomics content", () => {
  it("shows a blocked viewer the contracts and the notice, with no discount, bonus or proposal copy", () => {
    render(
      <FullTokenomicsSection headingLevel={1} geoRestriction={{ notice: GB_NOTICE, entries: getTokenPageEntries() }} />,
    );
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.getByTestId("tokenomics-contracts")).toHaveTextContent(HERMESOS_PUBLISHED);
    expect(screen.getByRole("link", { name: /Verify the token contracts/ })).toHaveAttribute("href", "/token");
    expect(screen.queryByText(/costs less|bonus credits|\$49 in the token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Proposed migration|proposed treasury/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Read the full tokenomics/ })).not.toBeInTheDocument();
  });
});
