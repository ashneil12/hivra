/**
 * @jest-environment jsdom
 */
import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getFeaturedProvider, PROVIDERS, type Provider } from "@/lib/models";
import { DeployForm } from "../DeployForm";

const DEFAULT_PROVIDER: Provider = getFeaturedProvider(PROVIDERS) ?? PROVIDERS[0];

jest.mock("@/components/ui/StyledDropdown", () => ({
  StyledDropdown: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ label: string; value: string }>;
  }) => (
    <select aria-label="Styled Dropdown" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

jest.mock("@/components/ui/animate-in", () => ({
  AnimateIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const VENICE_VAULT_KEY = {
  id: "vault_venice_1",
  provider: "venice",
  key_preview: "sk-ven...1234",
  name: "Venice",
};

function DeployFormHarness({
  deploying = false,
  handleDeploy = jest.fn(),
  onManagedVeniceDeposit = jest.fn(),
  onChangeAgentType,
  // Deploy-card redesign: the top-level "Managed (Venice)?" toggle. Defaults
  // ON (matching the real default). In managed mode the provider/model/key
  // fields are still rendered, so the legacy provider tests (which switch to
  // OpenRouter/Nous/Codex — non-Venice → key/OAuth shown) keep working. Pass
  // `managed={false}` to render the clean-slate (unconfigured) variant.
  managed: managedInitial = true,
  // Track W: simulate a saved Venice Vault key that overrides the managed
  // path (BYOK-vault) — the Advanced disclosure must auto-open for it.
  withVeniceVaultKey = false,
  // Retry-cooldown deadline (epoch ms). Drives the countdown effect under test.
  retryBlockedUntilMs = null,
}: {
  deploying?: boolean;
  handleDeploy?: () => void;
  onManagedVeniceDeposit?: (params: { walletType: "hermesos" | "card"; amountUsd: number }) => void;
  onChangeAgentType?: () => void;
  managed?: boolean;
  withVeniceVaultKey?: boolean;
  retryBlockedUntilMs?: number | null;
}) {
  const [agentName, setAgentName] = useState("MY_FIRST_AGENT");
  const [selectedProvider, setSelectedProvider] = useState<Provider>(DEFAULT_PROVIDER);
  const [model, setModel] = useState(String(DEFAULT_PROVIDER.models?.[0]?.value ?? ""));
  const [apiKey, setApiKey] = useState("sk-test");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [useVaultKey, setUseVaultKey] = useState(withVeniceVaultKey);
  const [honchoApiKey, setHonchoApiKey] = useState("");
  const [useHonchoVaultKey, setUseHonchoVaultKey] = useState(false);
  const [managed, setManaged] = useState(managedInitial);
  const [cpu, setCpu] = useState(2);
  const [ramGb, setRamGb] = useState(4);
  const [managedVeniceWalletType, setManagedVeniceWalletType] = useState<"hermesos" | "card">("hermesos");

  return (
    <DeployForm
      agentName={agentName}
      setAgentName={setAgentName}
      managed={managed}
      setManaged={setManaged}
      cpuOptions={[0.5, 1, 2, 4, 8]}
      ramOptions={[1, 2, 4, 8, 16]}
      cpu={cpu}
      setCpu={setCpu}
      ramGb={ramGb}
      setRamGb={setRamGb}
      selectedProvider={selectedProvider}
      handleProviderSelect={(provider) => {
        setSelectedProvider(provider);
        setModel(String(provider.models?.[0]?.value ?? ""));
      }}
      PROVIDERS={PROVIDERS}
      model={model}
      setModel={setModel}
      modelOptions={selectedProvider.models.map((entry) => ({
        label: String((entry as { label?: string; value: string }).label ?? entry.value),
        value: String(entry.value),
      }))}
      hasLiveModels={false}
      isLoadingLiveModels={false}
      liveModelsError=""
      apiKey={apiKey}
      setApiKey={setApiKey}
      customBaseUrl={customBaseUrl}
      setCustomBaseUrl={setCustomBaseUrl}
      useVaultKey={useVaultKey}
      setUseVaultKey={setUseVaultKey}
      matchedVaultKey={withVeniceVaultKey ? VENICE_VAULT_KEY : null}
      honchoApiKey={honchoApiKey}
      setHonchoApiKey={setHonchoApiKey}
      useHonchoVaultKey={useHonchoVaultKey}
      setUseHonchoVaultKey={setUseHonchoVaultKey}
      matchedHonchoVaultKey={null}
      deploying={deploying}
      handleDeploy={handleDeploy}
      managedVeniceWalletType={managedVeniceWalletType}
      setManagedVeniceWalletType={setManagedVeniceWalletType}
      onManagedVeniceDeposit={onManagedVeniceDeposit}
      agentSpecialization={{
        name: "Hermes Agent",
        eyebrow: "General-purpose deploy card",
        title: "Launch a blank Hermes Agent.",
        summary: "Pick the model provider, name the agent, and launch a clean HermesOS workspace.",
        included: ["Persistent HermesOS workspace", "Browser, terminal, files", "Editable provider settings"],
        starterTasks: ["Research a topic", "Automate a recurring workflow", "Build inside the workspace"],
        guardrails: ["You control provider keys", "Destructive actions require approval", "No specialist assumptions"],
        recommendedTier: "Free",
        ctaLabel: "Deploy Hermes Agent",
      }}
      onChangeAgentType={onChangeAgentType}
      retryBlockedUntilMs={retryBlockedUntilMs}
    />
  );
}

describe("DeployForm", () => {
  beforeEach(() => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/billing/managed-venice/hermesos/quote") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id: "mvq_1",
              tokenAmountRaw: "1000000000000000000000",
              tokenSymbol: "Hivra",
              tokenDecimals: 18,
              snapshotPriceUsd: "0.05",
              paidValueMicroUsd: 50_000_000,
              creditValueMicroUsd: 60_000_000,
              bonusValueMicroUsd: 10_000_000,
              depositAddress: "0x000000000000000000000000000000000000feed",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              status: "active",
            },
          }),
        } as Response);
      }
      if (url === "/api/billing/managed-venice/hermesos/check") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
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
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                status: "active",
              },
            },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      } as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // Track W (web dejargonization): the collapsed managed card shows only the
  // name + a plain-language summary; every technical control lives behind the
  // "Advanced setup" disclosure.
  function openAdvanced() {
    fireEvent.click(screen.getByRole("button", { name: /advanced setup/i }));
  }

  it("collapses the managed happy path to name + summary — zero technical fields", () => {
    render(<DeployFormHarness />);

    expect(screen.getByText(/Hermes Agent Name/i)).toBeInTheDocument();
    expect(screen.getByTestId("deploy-simple-summary")).toHaveTextContent(
      /gets a private computer with AI included/i
    );
    expect(screen.getByRole("button", { name: /advanced setup/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    // The jargon blacklist — none of it renders before Advanced is opened.
    expect(screen.queryByText(/Box Size/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Computer size/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^CPU$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^RAM$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Model ID/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI Provider/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Managed \(Venice\)\?/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Honcho/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-...")).not.toBeInTheDocument();
    expect(screen.queryByText(/API Key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/vCPU/i)).not.toBeInTheDocument();

    // The primary CTA stays right there on the collapsed card.
    expect(screen.getByRole("button", { name: /^deploy hermes agent$/i })).toBeInTheDocument();
  });

  it("keeps the full power-user card (size, toggle, provider, model, Honcho) behind Advanced setup", () => {
    render(<DeployFormHarness />);
    openAdvanced();

    expect(screen.getByRole("button", { name: /advanced setup/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByText(/Computer size/i)).toBeInTheDocument();
    expect(screen.getByText(/^CPU$/)).toBeInTheDocument();
    expect(screen.getByText(/^RAM$/)).toBeInTheDocument();
    expect(screen.getByText(/Managed \(Venice\)\?/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /bring your own/i })).toBeInTheDocument();
    expect(screen.getByText(/AI Provider/i)).toBeInTheDocument();
    expect(screen.getByText(/Model ID/i)).toBeInTheDocument();
    expect(screen.getByText(/Honcho API Key/i)).toBeVisible();
    // "Box Size" is renamed to consumer language inside Advanced.
    expect(screen.queryByText(/Box Size/i)).not.toBeInTheDocument();
  });

  it("auto-opens Advanced setup when a saved Venice Vault key overrides the managed path", () => {
    render(<DeployFormHarness withVeniceVaultKey />);

    // BYOK-vault must never hide behind the "AI included" summary — the
    // vault-key row is visible and the summary states the saved-key reality.
    expect(screen.getByText(/vault key loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/sk-ven\.\.\.1234/i)).toBeInTheDocument();
    expect(screen.getByTestId("deploy-simple-summary")).toHaveTextContent(
      /runs on your saved .* key/i
    );
  });

  it("shows a back button on the Hermes deploy card", () => {
    const onChangeAgentType = jest.fn();
    render(<DeployFormHarness onChangeAgentType={onChangeAgentType} />);

    const backButton = screen.getByRole("button", { name: /back to agent choices/i });
    expect(backButton).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change agent/i })).not.toBeInTheDocument();

    fireEvent.click(backButton);

    expect(onChangeAgentType).toHaveBeenCalledTimes(1);
  });

  // Managed mode is Venice-only now — the other providers are BYOK and are
  // configured in the agent's webchat after boot, not on the deploy card. The
  // old "six quick-select slots" + per-provider key/OAuth tests were removed
  // with the grid; the featured Venice card + managed-Venice flow are below.

  it("renders Venice as the featured hero card with privacy as the headline reason", () => {
    render(<DeployFormHarness />);
    openAdvanced();

    const veniceButton = screen.getByRole("button", { name: /venice ai recommended/i });
    expect(veniceButton).toBeInTheDocument();

    // The other-provider grid is gone — only Venice is offered on the card.
    expect(screen.queryByRole("button", { name: /^bankr llm gateway$/i })).not.toBeInTheDocument();

    expect(screen.getByText(/privacy-focused by default/i)).toBeInTheDocument();
    expect(
      screen.getByText(/doesn't log your prompts, train on your data, or require identity/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/only mainstream provider/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/managed venice/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/why we recommend venice/i)).not.toBeInTheDocument();
  });

  it("lets welcome deploy users choose managed Venice before entering credits", async () => {
    const handleDeploy = jest.fn();
    const onManagedVeniceDeposit = jest.fn();
    render(
      <DeployFormHarness
        handleDeploy={handleDeploy}
        onManagedVeniceDeposit={onManagedVeniceDeposit}
      />
    );

    // The "Managed (Venice)?" toggle now lives inside Advanced setup. It
    // defaults ON with Venice selected, so the managed-Venice "no key needed"
    // panel is shown once the disclosure opens.
    openAdvanced();
    expect(screen.getByText(/Managed \(Venice\)\?/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /bring your own/i })).toBeInTheDocument();

    expect(screen.queryByPlaceholderText(/sk-/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/no keys to manage/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/provider rates/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no Venice key needed/i)).toBeInTheDocument();
    expect(screen.getByText(/without logging prompts/i)).toBeInTheDocument();

    // The primary CTA is ALWAYS "Deploy Agent" now; funding is a secondary
    // path reached via the "Add credit first" link.
    expect(
      screen.getByRole("button", { name: /^deploy hermes agent$/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue to managed credits/i })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add credit first/i }));

    expect(screen.getAllByText(/AI Credit/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /pay with \$HermesOS/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deposit card credits/i })).toBeInTheDocument();
    expect(screen.getAllByText(/up to 20% more managed Venice credits/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$250 lifetime launch bonus cap/i)).toBeInTheDocument();
    expect(screen.getByText(/about \$1,250 in \$HermesOS top-ups/i)).toBeInTheDocument();
    expect(screen.getAllByText(/10% standard bonus/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$50\.00/i)).toBeInTheDocument();
    expect(screen.getAllByText(/\$10\.00/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$60\.00/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /start \$HermesOS top-up/i }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/billing/managed-venice/hermesos/quote",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ targetPaidMicroUsd: 50_000_000 }),
        })
      );
    });
    expect(await screen.findByText(/rate locked/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verify payment/i })).toBeInTheDocument();
    expect(screen.getByText(/use verify payment above/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /checking payment/i })).not.toBeInTheDocument();
    expect(onManagedVeniceDeposit).not.toHaveBeenCalledWith({ walletType: "hermesos", amountUsd: 50 });
    expect(handleDeploy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /deposit card credits/i }));
    expect(screen.getAllByText(/no Venice markup/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pay exactly provider-rate credits/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /start card credit top-up/i }));
    expect(onManagedVeniceDeposit).toHaveBeenCalledWith({ walletType: "card", amountUsd: 50 });
  });

  it("does not show developer mode controls in the launch flow", () => {
    render(<DeployFormHarness />);

    expect(screen.queryByText(/Developer Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enable Developer Mode/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Persistent Source Mount/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Root Access/i)).not.toBeInTheDocument();
  });

  it("keeps Honcho memory inside Advanced setup and drops the gateway section", () => {
    render(<DeployFormHarness />);
    openAdvanced();

    expect(screen.getByText(/Honcho API Key/i)).toBeVisible();
    expect(screen.queryByText(/Nous Tool Gateway/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Optional after launch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Select one or more tools/i)).not.toBeInTheDocument();
  });

  it("does not render a skip action on the deploy card", () => {
    render(<DeployFormHarness />);

    expect(screen.queryByRole("button", { name: /skip/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/set this up later/i)).not.toBeInTheDocument();
  });

  it("disables the deploy CTA while a deploy is pending", () => {
    render(<DeployFormHarness deploying />);

    expect(screen.getByRole("button", { name: /deploying hermes agent/i })).toBeDisabled();
  });

  it("hides provider/model/key UI in the clean-slate (Managed OFF) variant", () => {
    render(<DeployFormHarness managed={false} />);

    // Clean-slate arrivals start with Advanced OPEN (the toggle that explains
    // the state must be visible) and the summary states the blank-slate deal.
    expect(screen.getByTestId("deploy-simple-summary")).toHaveTextContent(/clean slate/i);
    expect(screen.getByText(/Computer size/i)).toBeInTheDocument();
    expect(screen.getByText(/Managed \(Venice\)\?/i)).toBeInTheDocument();
    // Nothing about the inference provider is collected here (it's configured
    // on the box after boot via the native onboarding overlay).
    expect(screen.queryByText(/AI Provider/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Model ID/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-...")).not.toBeInTheDocument();
    // The CTA still deploys (no key gate on the clean-slate path).
    expect(screen.getByRole("button", { name: /deploy hermes agent/i })).toBeInTheDocument();
  });

  // Retry-cooldown countdown leak: the effect starts a 1000ms interval to keep
  // the "Try again in Ns" label live while a block is active. `retryBlockedUntilMs`
  // (from `deployRetryBlockedUntilMs`) is set ONCE and never reset to null, so the
  // interval callback MUST stop itself at the deadline — otherwise it keeps firing
  // setNowMs(Date.now()) forever, re-rendering the form at 1 Hz for the rest of its
  // mounted life. This test proves the interval self-terminates at expiry while the
  // component is still mounted (no unmount cleanup involved).
  it("clears the retry-cooldown countdown interval when the deadline passes (no 1 Hz re-render leak)", () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    const clearIntervalSpy = jest.spyOn(global, "clearInterval");

    const blockedUntil = Date.now() + 3000;
    render(<DeployFormHarness retryBlockedUntilMs={blockedUntil} />);

    // Capture the id(s) of the 1000ms countdown interval created while blocked.
    const countdownIntervalIds = setIntervalSpy.mock.calls
      .map((call, index) => ({
        delay: call[1],
        id: setIntervalSpy.mock.results[index]?.value,
      }))
      .filter((entry) => entry.delay === 1000)
      .map((entry) => entry.id);
    expect(countdownIntervalIds.length).toBeGreaterThan(0);

    // Advance PAST the 3s deadline WITHOUT unmounting.
    act(() => {
      jest.advanceTimersByTime(3500);
    });

    // The countdown interval must have cleared ITSELF at expiry (while mounted).
    const clearedIntervalIds = clearIntervalSpy.mock.calls.map((call) => call[0]);
    expect(
      countdownIntervalIds.some((id) => clearedIntervalIds.includes(id))
    ).toBe(true);
  });
});
