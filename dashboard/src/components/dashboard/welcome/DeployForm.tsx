import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle, ChevronDown, Rocket, Key, Zap, ArrowRight, Loader2, CreditCard, Settings2, Wallet, Cpu, MemoryStick } from "lucide-react";
import {
  getFeaturedProvider,
  type Provider,
} from "@/lib/models";
import { StyledDropdown } from "@/components/ui/StyledDropdown";
import { AnimateIn } from "@/components/ui/animate-in";
import { ManagedVeniceTopUpCalculator } from "@/components/billing/ManagedVeniceTopUpCalculator";
import { ManagedVeniceTokenQuotePanel } from "@/components/billing/ManagedVeniceTokenQuotePanel";
import { formatMicroUsd } from "@/components/billing/ManagedVeniceSubsidyBanner";
import { STYLES } from "./styles";
import { clientLog } from "@/lib/client/logger";

import {
  getLiveModelDiscoveryStatusMessage,
  supportsLiveModelDiscovery,
  supportsPublicLiveModelDiscovery,
  type ProviderModelOption,
} from "@/lib/provider-models";
import {
  allowsProviderDeployWithoutApiKey,
  supportsHermesAuthProvider,
} from "@/lib/provider-auth";
import { validateProviderKeyShape } from "@/lib/provider-key-shape";
import {
  MANAGED_VENICE_DEFAULT_TOP_UP_USD,
  formatManagedVeniceUsd,
  getManagedVeniceTopUpQuote,
  type ManagedVeniceWalletType,
} from "@/lib/venice/managed-credit-topup";
import {
  requestManagedVeniceHermesQuote,
  type ManagedVeniceTokenQuotePayload,
} from "@/lib/billing/managed-venice-client";

import { usePaymentTokenUnit } from "@/hooks/usePaymentToken";


export interface DashboardVaultKey {
  id: string;
  provider: string;
  key_preview: string | null;
  name: string;
}

/**
 * Stable ref callback that focuses a field on mount only for a fine pointer.
 * autoFocus opened the phone keyboard over the destination, size and launch
 * controls the user still had to review. Module scope keeps the identity
 * stable so React calls it once per mount, not on every render.
 */
export function focusOnFinePointer(element: HTMLElement | null) {
  if (!element || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  if (window.matchMedia("(pointer: fine)").matches) element.focus();
}

// Inline text actions ("Use different key", "add credit now", ...) keep their
// look but get a 44px tall hit area.
const TEXT_ACTION_TARGET: CSSProperties = {
  minHeight: 44,
  display: "inline-flex",
  alignItems: "center",
  padding: "0 4px",
};

// Bordered mono back control shared by "Back to agent choices" and the
// funding step's "Back to setup".
const BACK_BUTTON_STYLE: CSSProperties = {
  border: "1px solid var(--etched-border)",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  fontWeight: 800,
  minHeight: 44,
  padding: "8px 11px",
  marginBottom: 18,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  alignSelf: "flex-start",
};

export interface DeploySpecializationCard {
  name: string;
  eyebrow: string;
  title: string;
  summary: string;
  included: readonly string[];
  starterTasks: readonly string[];
  guardrails: readonly string[];
  recommendedTier: string;
  ctaLabel: string;
}

export function DeployForm({
  agentName,
  setAgentName,
  managed,
  setManaged,
  cpuOptions,
  ramOptions,
  cpu,
  setCpu,
  ramGb,
  setRamGb,
  selectedProvider,
  handleProviderSelect,
  PROVIDERS,
  model,
  setModel,
  modelOptions,
  hasLiveModels,
  isLoadingLiveModels,
  liveModelsError,
  apiKey,
  setApiKey,
  apiKeyError = null,
  onApiKeyBlur,
  customBaseUrl,
  setCustomBaseUrl,
  useVaultKey,
  setUseVaultKey,
  matchedVaultKey,
  honchoApiKey,
  setHonchoApiKey,
  useHonchoVaultKey,
  setUseHonchoVaultKey,
  matchedHonchoVaultKey,
  deploying,
  handleDeploy,
  managedVeniceWalletType,
  setManagedVeniceWalletType,
  managedVeniceAvailableMicroUsd = 0,
  managedVeniceBalanceLoading = false,
  managedVeniceBalanceUnknown = false,
  retryBlockedUntilMs = null,
  onManagedVeniceSummaryRefresh,
  onManagedVeniceDeposit,
  agentSpecialization,
  onChangeAgentType,
  deployAlert = null,
}: {
  agentName: string;
  setAgentName: (v: string) => void;
  /** Top-level "Managed (Venice)?" toggle. true = managed-Venice path;
   *  false = BYOK clean-slate (no provider/model/key seeded). */
  managed: boolean;
  setManaged: (v: boolean) => void;
  /** Box-size picker options (CPU cores / RAM GB). */
  cpuOptions: readonly number[];
  ramOptions: readonly number[];
  cpu: number;
  setCpu: (v: number) => void;
  ramGb: number;
  setRamGb: (v: number) => void;
  selectedProvider: Provider;
  handleProviderSelect: (p: Provider) => void;
  PROVIDERS: Provider[];
  model: string;
  setModel: (v: string) => void;
  modelOptions: ProviderModelOption[];
  hasLiveModels: boolean;
  isLoadingLiveModels: boolean;
  liveModelsError: string;
  apiKey: string;
  setApiKey: (v: string) => void;
  /** Inline provider-key validation message (required/shape), or null when valid. */
  apiKeyError?: string | null;
  /** Marks the key field as touched so the parent can start showing apiKeyError. */
  onApiKeyBlur?: () => void;
  customBaseUrl: string;
  setCustomBaseUrl: (v: string) => void;
  useVaultKey: boolean;
  setUseVaultKey: (v: boolean) => void;
  matchedVaultKey: DashboardVaultKey | null;
  honchoApiKey: string;
  setHonchoApiKey: (v: string) => void;
  useHonchoVaultKey: boolean;
  setUseHonchoVaultKey: (v: boolean) => void;
  matchedHonchoVaultKey: DashboardVaultKey | null;
  deploying: boolean;
  handleDeploy: () => void;
  managedVeniceWalletType: ManagedVeniceWalletType;
  setManagedVeniceWalletType: (v: ManagedVeniceWalletType) => void;
  managedVeniceAvailableMicroUsd?: number;
  managedVeniceBalanceLoading?: boolean;
  managedVeniceBalanceUnknown?: boolean;
  retryBlockedUntilMs?: number | null;
  onManagedVeniceSummaryRefresh?: () => unknown | Promise<unknown>;
  onManagedVeniceDeposit: (params: { walletType: ManagedVeniceWalletType; amountUsd: number }) => void;
  agentSpecialization?: DeploySpecializationCard | null;
  onChangeAgentType?: () => void;
  /** Deploy validation/failure notice, rendered directly above the primary
   *  action so a blocked tap never looks dead. */
  deployAlert?: ReactNode;
}) {
  const paymentUnit = usePaymentTokenUnit();
  const supportsLiveModels = supportsLiveModelDiscovery(selectedProvider.id);
  const supportsPublicModels = supportsPublicLiveModelDiscovery(selectedProvider.id);
  // Deploy-card redesign: the top-level `managed` toggle is the single source
  // of truth. managed = managed-Venice path (funding/balance/deposit flow,
  // byte-for-byte unchanged); !managed = BYOK clean-slate (hide
  // provider/model/key UI; the server seeds nothing).
  const cleanSlate = !managed;
  // Managed-Venice still requires the Venice provider (the proxy mints a Venice
  // key). The toggle's "Managed Venice" button forces Venice, so this is true
  // for the happy path; a managed deploy left on a non-Venice provider falls
  // back to the unchanged BYOK-with-key path instead. A saved Venice Vault key
  // also wins — keep using it (BYOK-vault) rather than defaulting into managed
  // credits, mirroring the deploy gate in WelcomeFlow.
  const usingVaultCredentialForManaged = Boolean(useVaultKey && matchedVaultKey);
  const isManagedVenice =
    managed && selectedProvider.id === "venice" && !usingVaultCredentialForManaged;
  // Track W (web dejargonization): the managed happy path collapses to
  // "name + plain-language summary"; every technical control (size picker,
  // Managed toggle, provider/model/key/Honcho) lives behind this disclosure.
  // Starts open for clean-slate (Managed=OFF) arrivals so the toggle that
  // explains that state stays visible, and auto-opens when a saved Vault key
  // overrides the managed path — the deploy then runs BYOK-vault, which the
  // simple "AI included" summary alone would misrepresent.
  const [advancedOpen, setAdvancedOpen] = useState(() => !managed);
  useEffect(() => {
    if (usingVaultCredentialForManaged) setAdvancedOpen(true);
  }, [usingVaultCredentialForManaged]);
  // Size-button styling lifted from the Hivra-box launch form so the picker
  // matches the rest of the welcome surface.
  const sizeButtonStyle = (active: boolean): CSSProperties => ({
    border: active ? "1px solid var(--ink-black)" : "1px solid var(--etched-border)",
    background: active ? "var(--ink-black)" : "transparent",
    color: active ? "var(--bg-surface)" : "var(--text-secondary)",
    fontSize: 12,
    minHeight: 44,
    cursor: "pointer",
    fontFamily: "var(--font-mono), monospace",
  });
  // Unknown balance ≠ zero balance. When the summary fetch failed, the user
  // may well have credits — funneling them into the funding wall on a $0
  // default silently blocked real deploys. Let the deploy attempt through;
  // the server is the authority on whether credits actually cover it.
  const hasManagedVeniceCredits =
    managedVeniceAvailableMicroUsd > 0 || managedVeniceBalanceUnknown;
  const providerUsesManagedAuth = supportsHermesAuthProvider(selectedProvider.id);
  // Tracks whether the user has tried to deploy at least once, so the
  // "key required" inline error only appears after an attempt (not on first
  // paint), while format errors (e.g. OpenRouter sk-or-) surface live.
  // Reset per provider: an attempt against provider A shouldn't make the
  // "key required" error appear pre-attempt on provider B.
  const [attemptedDeploy, setAttemptedDeploy] = useState(false);
  const [attemptedProviderId, setAttemptedProviderId] = useState(selectedProvider.id);
  if (attemptedProviderId !== selectedProvider.id) {
    setAttemptedProviderId(selectedProvider.id);
    setAttemptedDeploy(false);
  }
  const [showManagedVeniceFundingStep, setShowManagedVeniceFundingStep] = useState(false);
  // Retry cooldown after repeated infra failures: tick a clock only while a
  // block is active so the countdown label stays live without a render loop.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const retryBlocked = retryBlockedUntilMs != null && nowMs < retryBlockedUntilMs;
  useEffect(() => {
    if (retryBlockedUntilMs == null || Date.now() >= retryBlockedUntilMs) return;
    setNowMs(Date.now());
    const interval = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      // The prop never resets to null; without stopping here the interval would
      // re-render the form at 1 Hz for the rest of its mounted life.
      if (now >= retryBlockedUntilMs) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [retryBlockedUntilMs]);
  const retrySecondsLeft = retryBlocked
    ? Math.max(1, Math.ceil((retryBlockedUntilMs - nowMs) / 1000))
    : 0;
  const [managedVeniceTopUpUsd, setManagedVeniceTopUpUsd] = useState(
    MANAGED_VENICE_DEFAULT_TOP_UP_USD,
  );
  const [managedVeniceTokenQuote, setManagedVeniceTokenQuote] =
    useState<ManagedVeniceTokenQuotePayload | null>(null);
  const [managedVeniceQuoteLoading, setManagedVeniceQuoteLoading] = useState(false);
  const [managedVeniceTopUpError, setManagedVeniceTopUpError] = useState<string | null>(null);
  const [managedVeniceTopUpNotice, setManagedVeniceTopUpNotice] = useState<string | null>(null);
  const managedVeniceTopUpQuote = getManagedVeniceTopUpQuote(
    managedVeniceTopUpUsd,
    managedVeniceWalletType,
  );
  const liveModelsStatusMessage = getLiveModelDiscoveryStatusMessage({
    provider: selectedProvider.id,
    isLoading: isLoadingLiveModels,
    hasLiveModels,
    error: liveModelsError,
    supportsPublicModels,
  });
  const featuredProvider = getFeaturedProvider(PROVIDERS);
  const featuredActive = featuredProvider
    ? selectedProvider.id === featuredProvider.id
    : false;
  const selectedAgentLabel = agentSpecialization?.name ?? "Agent";
  const deployCtaLabel = agentSpecialization?.ctaLabel ?? "Deploy Agent";
  // Consumer-facing name for the plain-language summary/credit copy. Falls
  // back to a generic subject while the name field is empty.
  const displayName = agentName.trim() || "Your agent";

  // Inline key-field validation. Catches the two dead-ends that previously
  // only surfaced server-side after the full deploy attempt: a missing
  // required key, and a key with the wrong shape (OpenRouter sk-or- prefix).
  const usingVaultCredential = Boolean(useVaultKey && matchedVaultKey);
  const trimmedApiKey = apiKey.trim();
  const keyShapeFailure =
    !providerUsesManagedAuth && !isManagedVenice && !usingVaultCredential && trimmedApiKey
      ? validateProviderKeyShape(selectedProvider.id, apiKey)
      : null;
  const providerRequiresKey =
    !providerUsesManagedAuth &&
    !isManagedVenice &&
    !allowsProviderDeployWithoutApiKey(selectedProvider.id);
  const missingRequiredKey = providerRequiresKey && !usingVaultCredential && !trimmedApiKey;
  const apiKeyFieldError = keyShapeFailure
    ? `${keyShapeFailure.message} Double-check the key you pasted.`
    : attemptedDeploy && missingRequiredKey
      ? `${selectedProvider.name} API key is required — paste it here or use a saved Vault key.`
      : null;
  // Parent-driven validation (WelcomeFlow's required-key truth table) wins;
  // the local computation covers shape errors live-as-you-type and the
  // post-attempt missing-key case when the parent passes nothing.
  const combinedApiKeyError = apiKeyError ?? apiKeyFieldError;
  const handleDeployAttempt = () => {
    setAttemptedDeploy(true);
    // A key problem can only be fixed inside the disclosure — surface the
    // field instead of pointing at an error the user can't see.
    if (missingRequiredKey || keyShapeFailure) setAdvancedOpen(true);
    handleDeploy();
  };

  if (isManagedVenice && showManagedVeniceFundingStep) {
    const quoteActive =
      managedVeniceWalletType === "hermesos" &&
      (managedVeniceTokenQuote?.status === "active" ||
        managedVeniceTokenQuote?.status === "expired");
    const quoteSettled =
      managedVeniceWalletType === "hermesos" && managedVeniceTokenQuote?.status === "settled";
    const startManagedVeniceTopUp = async () => {
      if (quoteSettled) {
        handleDeploy();
        return;
      }

      setManagedVeniceTopUpError(null);
      setManagedVeniceTopUpNotice(null);

      if (managedVeniceWalletType === "card") {
        onManagedVeniceDeposit({
          walletType: "card",
          amountUsd: managedVeniceTopUpQuote.paidUsd,
        });
        return;
      }

      setManagedVeniceQuoteLoading(true);
      setManagedVeniceTokenQuote(null);
      try {
        const result = await requestManagedVeniceHermesQuote(managedVeniceTopUpQuote.paidUsd);
        if (!result.ok) {
          if (result.reason === "bankr_wallet_provisioning_pending") {
            setManagedVeniceTopUpNotice(
              `Token top-ups are waiting on Bankr wallet provisioning. Once Bankr is connected, this button will show the exact ${paymentUnit} amount, QR code, and deposit address here. Card credit top-ups are available now.`
            );
            return;
          }
          setManagedVeniceTopUpError(result.message);
          return;
        }
        setManagedVeniceTokenQuote(result.quote);
      } catch (quoteError) {
        setManagedVeniceTopUpError(`Failed to create ${paymentUnit} quote. Please try again.`);
        clientLog.error("Welcome managed Venice Hivra quote failed", quoteError, {
          source: "welcome-deploy-form",
          route: "/api/billing/managed-venice/hermesos/quote",
          failureType: "managed_venice_hermesos_quote_failed",
        });
      } finally {
        setManagedVeniceQuoteLoading(false);
      }
    };

    return (
      <AnimateIn>
        <div className="heavy-glass-card" style={STYLES.deployCard}>
          <div style={STYLES.deployCardGoldBar} />
          <button
            type="button"
            onClick={() => setShowManagedVeniceFundingStep(false)}
            className="mono"
            style={BACK_BUTTON_STYLE}
          >
            <ArrowLeft size={13} /> Back to setup
          </button>

          <div style={STYLES.fieldGroup}>
            <label className="mono" style={STYLES.fieldLabel}>
              AI Credit
            </label>
            <p style={{ margin: "0 0 14px", fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              Add prepaid credit for {displayName}&apos;s AI before deploying. Hivra charges Venice provider rates with no markup.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <button
                type="button"
                onClick={() => {
                  setManagedVeniceWalletType("card");
                  setManagedVeniceTokenQuote(null);
                  setManagedVeniceTopUpError(null);
                  setManagedVeniceTopUpNotice(null);
                }}
                style={{
                  textAlign: "left",
                  padding: "14px 16px",
                  border: `1px solid ${managedVeniceWalletType === "card" ? "var(--ink-black)" : "var(--etched-border)"}`,
                  background: managedVeniceWalletType === "card" ? "var(--bg-elevated)" : "var(--bg-surface)",
                  cursor: "pointer",
                }}
              >
                <CreditCard size={15} style={{ marginBottom: 8 }} />
                <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 800, marginBottom: 5 }}>
                  Deposit card credits
                </div>
                <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.66 }}>
                  No Venice markup. Pay exactly provider-rate credits with card.
                </p>
              </button>
              <details>
                <summary style={{ cursor: 'pointer', padding: '12px 0', fontSize: 13 }}>Optional token top-up</summary>
              <button
                type="button"
                onClick={() => {
                  setManagedVeniceWalletType("hermesos");
                  setManagedVeniceTokenQuote(null);
                  setManagedVeniceTopUpError(null);
                  setManagedVeniceTopUpNotice(null);
                }}
                style={{
                  textAlign: "left",
                  padding: "14px 16px",
                  border: `1px solid ${managedVeniceWalletType === "hermesos" ? "var(--ink-black)" : "var(--etched-border)"}`,
                  background: managedVeniceWalletType === "hermesos" ? "var(--bg-elevated)" : "var(--bg-surface)",
                  cursor: "pointer",
                }}
              >
                <Wallet size={15} style={{ marginBottom: 8 }} />
                <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 800, marginBottom: 5 }}>
                  Pay with {paymentUnit}
                </div>
                <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.66 }}>
                  Up to 20% more managed Venice credits during the launch wave, then a 10% standard bonus.
                </p>
              </button>
              </details>
            </div>

            <div style={{ marginTop: 14 }}>
              <ManagedVeniceTopUpCalculator
                id="managed-venice-top-up"
                amountUsd={managedVeniceTopUpUsd}
                walletType={managedVeniceWalletType}
                onAmountChange={(amountUsd) => {
                  setManagedVeniceTopUpUsd(amountUsd);
                  setManagedVeniceTokenQuote(null);
                  setManagedVeniceTopUpError(null);
                  setManagedVeniceTopUpNotice(null);
                }}
              />
            </div>

            <div style={{ marginTop: 12, border: "1px dashed var(--etched-border)", padding: "12px 14px", background: "var(--bg-surface)", fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              {managedVeniceWalletType === "hermesos" ? (
                <>
                  <strong style={{ color: "var(--ink-black)" }}>$250 lifetime launch bonus cap.</strong>{" "}
                  {paymentUnit} top-ups can earn up to 20% more managed Venice credits; that is about $1,250 in {paymentUnit} top-ups at the full launch rate. After the cap is used, {paymentUnit} top-ups receive the 10% standard bonus.
                </>
              ) : (
                <>
                  <strong style={{ color: "var(--ink-black)" }}>Card terms: no Venice markup.</strong>{" "}
                  Card top-ups pay exactly provider-rate credits; {formatManagedVeniceUsd(managedVeniceTopUpQuote.paidUsd)} adds {formatManagedVeniceUsd(managedVeniceTopUpQuote.totalCreditsUsd)} of managed Venice spend.
                </>
              )}
            </div>

            {managedVeniceTopUpError && (
              <div
                role="alert"
                style={{
                  marginTop: 12,
                  border: "1px solid rgba(179,38,30,0.35)",
                  background: "rgba(179,38,30,0.08)",
                  color: "#b3261e",
                  padding: "10px 12px",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                {managedVeniceTopUpError}
              </div>
            )}

            {managedVeniceTopUpNotice && (
              <div
                role="status"
                style={{
                  marginTop: 12,
                  border: "1px solid rgba(255, 44, 45,0.5)",
                  background: "rgba(255, 44, 45,0.1)",
                  color: "var(--text-primary)",
                  padding: "11px 13px",
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                {managedVeniceTopUpNotice}
              </div>
            )}

            {managedVeniceTokenQuote && managedVeniceWalletType === "hermesos" && (
              <ManagedVeniceTokenQuotePanel
                quote={managedVeniceTokenQuote}
                availableBalanceMicroUsd={managedVeniceAvailableMicroUsd}
                onQuoteUpdate={setManagedVeniceTokenQuote}
                onContinue={() => handleDeploy()}
                onSettled={async () => {
                  setManagedVeniceTopUpNotice(null);
                  await onManagedVeniceSummaryRefresh?.();
                }}
              />
            )}
          </div>

          {deployAlert}

          {quoteActive ? (
            <span
              className="mono"
              style={{
                alignSelf: "flex-start",
                border: "1px solid var(--etched-border)",
                color: "var(--text-secondary)",
                padding: "10px 12px",
                fontSize: 10,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                marginTop: "0.5rem",
              }}
            >
              Use verify payment above
            </span>
          ) : (
            <button
              className="premium-btn"
              onClick={() => void startManagedVeniceTopUp()}
              disabled={deploying || managedVeniceQuoteLoading || !agentName.trim()}
              style={{
                ...STYLES.primaryButton,
                opacity: deploying || managedVeniceQuoteLoading || !agentName.trim() ? 0.5 : 1,
                cursor: deploying || managedVeniceQuoteLoading || !agentName.trim() ? "not-allowed" : "pointer",
                marginTop: "0.5rem",
              }}
            >
              {deploying || managedVeniceQuoteLoading ? (
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              ) : (
                <Wallet size={14} />
              )}
              {deploying
                ? "Opening top-up..."
                : managedVeniceQuoteLoading
                  ? "Creating quote..."
                  : quoteSettled
                    ? deployCtaLabel
                    : managedVeniceWalletType === "hermesos"
                      ? `Start ${paymentUnit} top-up`
                      : "Start card credit top-up"}
              {!deploying && <ArrowRight size={14} />}
            </button>
          )}
        </div>
      </AnimateIn>
    );
  }

  return (
    <AnimateIn>
      <div className="heavy-glass-card" style={STYLES.deployCard}>
        <div style={STYLES.deployCardGoldBar} />

        {onChangeAgentType && (
          <button
            type="button"
            onClick={onChangeAgentType}
            className="mono"
            style={BACK_BUTTON_STYLE}
          >
            <ArrowLeft size={13} /> Back to agent choices
          </button>
        )}

        {/* Step indicator */}
        <div style={STYLES.deployStepIndicator}>
          <div style={STYLES.deployStepDone}>
            <CheckCircle size={14} />
            <span>Plan Active</span>
          </div>
          <div style={STYLES.deployStepDivider} />
          <div style={STYLES.deployStepCurrent}>
            <Rocket size={14} />
            <span>Deploy {selectedAgentLabel}</span>
          </div>
        </div>

        {/* Agent Name */}
        <div style={STYLES.fieldGroup}>
          <label htmlFor="welcome-deploy-agent-name" className="mono" style={STYLES.fieldLabel}>
            {selectedAgentLabel} Name
          </label>
          <input
            id="welcome-deploy-agent-name"
            ref={focusOnFinePointer}
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="MY_FIRST_AGENT"
            autoComplete="off"
            enterKeyHint="done"
            style={STYLES.textInput}
            onFocus={(e) => (e.target.style.borderColor = "var(--ink-black)")}
            onBlur={(e) => (e.target.style.borderColor = "var(--etched-border)")}
          />
        </div>

        {/* Plain-language summary — the whole pitch of the collapsed happy
            path. Adapts when Advanced choices change what the deploy does. */}
        <div
          data-testid="deploy-simple-summary"
          style={{
            border: "1px solid var(--etched-border)",
            background: "var(--bg-surface)",
            padding: "14px 16px",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginBottom: "1.6rem",
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--text-secondary)",
          }}
        >
          <Zap size={14} style={{ color: "var(--gold-leaf)", flexShrink: 0, marginTop: 3 }} />
          <span>
            {managed ? (
              usingVaultCredentialForManaged ? (
                <>
                  <strong style={{ color: "var(--ink-black)" }}>
                    {displayName} gets a private computer
                  </strong>{" "}
                  and runs on your saved {selectedProvider.name} key. Ready in about 2-4 minutes.
                </>
              ) : (
                <>
                  <strong style={{ color: "var(--ink-black)" }}>
                    {displayName} gets a private computer with AI included
                  </strong>{" "}
                  — no keys, no setup needed. Ready in about 2-4 minutes.
                </>
              )
            ) : (
              <>
                <strong style={{ color: "var(--ink-black)" }}>
                  {displayName} gets a private computer with a clean slate
                </strong>{" "}
                — you connect the AI of your choice after launch. Ready in about 2-4 minutes.
              </>
            )}
          </span>
        </div>

        {/* Credit status — plain-words money facts for the managed path. Not
            technical config, so it stays visible outside Advanced setup. */}
        {isManagedVenice && (
          <div style={{ marginBottom: "1.6rem", display: "grid", gap: 10 }}>
            {managedVeniceBalanceUnknown && !managedVeniceBalanceLoading && (
              <div
                role="alert"
                style={{
                  border: "1px solid rgba(217,119,6,0.45)",
                  background: "rgba(217,119,6,0.08)",
                  color: "var(--ink-black)",
                  padding: "10px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                <AlertTriangle size={14} style={{ color: "#d97706", flexShrink: 0 }} />
                <span>
                  Couldn&apos;t load your credit balance — you can still deploy. If you have
                  credits they&apos;ll be used as usual.
                </span>
              </div>
            )}
            {managedVeniceAvailableMicroUsd > 0 && (
              <div
                role="status"
                style={{
                  border: "1px solid rgba(22,163,74,0.45)",
                  background: "rgba(22,163,74,0.08)",
                  color: "var(--ink-black)",
                  padding: "10px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "wrap",
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <CheckCircle size={14} style={{ color: "#16a34a" }} />
                  <strong>Credit ready.</strong>
                  {displayName}&apos;s AI usage comes out of this balance.
                </span>
                <span className="mono" style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em", color: "#16a34a" }}>
                  {formatMicroUsd(managedVeniceAvailableMicroUsd, 4)} available
                </span>
              </div>
            )}
            {!hasManagedVeniceCredits && managedVeniceBalanceLoading && (
              <p className="mono" style={{ margin: 0, fontSize: 10, opacity: 0.5 }}>
                Checking your credit balance...
              </p>
            )}
            {!hasManagedVeniceCredits && !managedVeniceBalanceLoading && (
              <div
                role="note"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  border: "1px dashed var(--etched-border)",
                  background: "var(--bg-surface)",
                  padding: "10px 12px",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--text-secondary)",
                }}
              >
                <Wallet size={13} style={{ flexShrink: 0, marginTop: 2, opacity: 0.7 }} />
                <span>
                  {displayName}&apos;s AI runs on prepaid credit. You can deploy now and add
                  credit later, or{" "}
                  <button
                    type="button"
                    onClick={() => setShowManagedVeniceFundingStep(true)}
                    style={{
                      ...TEXT_ACTION_TARGET,
                      verticalAlign: "middle",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--ink-black)",
                      fontWeight: 700,
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                      fontSize: 12,
                    }}
                  >
                    add credit now
                  </button>
                  .
                </span>
              </div>
            )}
          </div>
        )}

        {/* Advanced setup — every technical control lives behind this
            disclosure so the managed happy path stays jargon-free. */}
        <button
          type="button"
          data-testid="deploy-advanced-toggle"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            background: "none",
            border: "1px solid var(--etched-border)",
            color: "var(--text-secondary)",
            padding: "11px 14px",
            cursor: "pointer",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            fontWeight: 800,
            marginBottom: "1.6rem",
          }}
        >
          <Settings2 size={13} />
          Advanced setup
          <span style={{ flex: 1 }} />
          <ChevronDown
            size={14}
            aria-hidden="true"
            style={{ transform: advancedOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}
          />
        </button>

        {advancedOpen && (
        <>
        {agentSpecialization && (
          <SpecializedDeployCard card={agentSpecialization} />
        )}

        {/* Computer size — CPU cores / RAM GB */}
        <div style={STYLES.fieldGroup}>
          <label className="mono" style={STYLES.fieldLabel}>
            Computer size
          </label>
          <div style={{ display: "grid", gap: 9 }}>
            <div className="welcome-size-row">
              <span className="mono welcome-size-label" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.62 }}>
                <Cpu size={12} /> CPU
              </span>
              {cpuOptions.map((option) => (
                <button
                  key={`deploy-cpu-${option}`}
                  type="button"
                  className="welcome-size-option"
                  aria-pressed={cpu === option}
                  onClick={() => setCpu(option)}
                  style={sizeButtonStyle(cpu === option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="welcome-size-row">
              <span className="mono welcome-size-label" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.62 }}>
                <MemoryStick size={12} /> RAM
              </span>
              {ramOptions.map((option) => (
                <button
                  key={`deploy-ram-${option}`}
                  type="button"
                  className="welcome-size-option"
                  aria-pressed={ramGb === option}
                  onClick={() => setRamGb(option)}
                  style={sizeButtonStyle(ramGb === option)}
                >
                  {option}<span style={{ fontSize: 11, opacity: 0.6 }}>G</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Managed (Venice)? — the managed/BYOK switch, power-user territory */}
        <div style={STYLES.fieldGroup}>
          <label className="mono" style={STYLES.fieldLabel}>
            Managed (Venice)?
          </label>
          <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
            On: Hivra runs Venice for you — no keys, billed from your wallet, ready to chat on deploy. Off: deploy a clean box and connect your own provider/key from the agent once it&apos;s up.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <button
              type="button"
              onClick={() => {
                setManaged(true);
                // Managed = Venice managed. Force the Venice provider (the proxy
                // mints a Venice key) and clear any stray key/vault selection,
                // mirroring the old in-card "Venice Access → managed" control.
                const veniceProvider = PROVIDERS.find((p) => p.id === "venice");
                if (veniceProvider) handleProviderSelect(veniceProvider);
                setApiKey("");
                setUseVaultKey(false);
              }}
              aria-pressed={managed}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                border: `1px solid ${managed ? "var(--ink-black)" : "var(--etched-border)"}`,
                background: managed ? "var(--bg-elevated)" : "var(--bg-surface)",
                cursor: "pointer",
              }}
            >
              <Wallet size={15} style={{ marginBottom: 8 }} />
              <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 800, marginBottom: 5 }}>
                Managed Venice
              </div>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.66 }}>
                No keys to manage. Pay Venice provider rates with card credits, or use {paymentUnit} for bonus credits.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setManaged(false)}
              aria-pressed={!managed}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                border: `1px solid ${!managed ? "var(--ink-black)" : "var(--etched-border)"}`,
                background: !managed ? "var(--bg-elevated)" : "var(--bg-surface)",
                cursor: "pointer",
              }}
            >
              <Key size={15} style={{ marginBottom: 8 }} />
              <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 800, marginBottom: 5 }}>
                Bring your own
              </div>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.66 }}>
                Deploy a clean box with nothing configured. Connect any provider and paste your key from the agent after it&apos;s live.
              </p>
            </button>
          </div>
          {/* The managed-needs-credit hint moved OUT of this toggle group to
              the always-visible credit-status section above the disclosure. */}
        </div>

        {/* Provider — managed/managed-Venice only; clean-slate seeds nothing */}
        {!cleanSlate && (
        <div style={STYLES.fieldGroup}>
          <label className="mono" style={STYLES.fieldLabel}>
            AI Provider
          </label>
          {/* Featured Venice hero card */}
          {featuredProvider && (
            <button
              type="button"
              onClick={() => handleProviderSelect(featuredProvider)}
              style={{
                width: "100%",
                cursor: "pointer",
                textAlign: "left",
                padding: "20px 22px",
                border: featuredActive
                  ? "2px solid var(--gold-leaf)"
                  : "1.5px solid rgba(255, 44, 45,0.45)",
                background: featuredActive
                  ? "rgba(255, 44, 45,0.1)"
                  : "rgba(255, 44, 45,0.04)",
                marginBottom: 12,
                display: "block",
                position: "relative",
                transition: "border-color 0.2s ease, background 0.2s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 10,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  {featuredProvider.name}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--gold-leaf)",
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    background: "rgba(255, 44, 45,0.15)",
                    padding: "3px 8px",
                    border: "1px solid rgba(255, 44, 45,0.4)",
                    whiteSpace: "nowrap",
                  }}
                >
                  Recommended
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, opacity: 0.85 }}>
                <strong style={{ fontWeight: 700, opacity: 1 }}>Privacy-focused by default.</strong>{" "}
                Venice doesn&apos;t log your prompts, train on your data, or require identity to
                use.
              </p>
            </button>
          )}

          {/* Managed is Venice-only. Other providers are BYOK and are
              configured in the agent's webchat after boot, not on this card. */}
        </div>
        )}

        {/* Add Base URL input specifically for custom_llm BEFORE the model selector */}
        {!cleanSlate && selectedProvider.id === "custom_llm" && (
          <div style={STYLES.fieldGroup}>
            <label className="mono" style={STYLES.fieldLabel}>
              Custom Base URL
            </label>
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. http://localhost:11434/v1 or https://openrouter.ai/api/v1"
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
              style={STYLES.textInput}
              onFocus={(e) => (e.target.style.borderColor = "var(--ink-black)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--etched-border)")}
            />
          </div>
        )}

        {/* Model — managed/managed-Venice only; clean-slate seeds no model */}
        {!cleanSlate && (
        <div style={STYLES.fieldGroup}>
          <label className="mono" style={STYLES.fieldLabel}>
            Model ID
          </label>
          {selectedProvider.id === "custom_llm" ? (
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. llama3.2"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={STYLES.textInput}
              onFocus={(e) => (e.target.style.borderColor = "var(--ink-black)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--etched-border)")}
            />
          ) : (
            <StyledDropdown
              value={model}
              onChange={setModel}
              placeholder={model || "Select model..."}
              options={modelOptions}
              menuMaxHeight={360}
            />
          )}

          {supportsLiveModels && (
            <p style={{ marginTop: 8, marginBottom: 0, fontSize: 11, opacity: 0.6, lineHeight: 1.4 }}>
              {liveModelsStatusMessage}
            </p>
          )}

          {selectedProvider.id === 'openrouter' && (
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Or enter custom model ID (e.g. qwen/qwen-max)"
              value={
                modelOptions.some(m => String(m.value) === String(model)) ? '' : model
              }
              onChange={(e) => setModel(e.target.value)}
              style={{ ...STYLES.textInput, marginTop: 8, borderStyle: 'dashed', background: 'transparent' }}
              onFocus={(e) => (e.target.style.borderColor = "var(--ink-black)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--etched-border)")}
            />
          )}
        </div>
        )}

        {/* AI API Key — vault-aware */}
        {!cleanSlate && !providerUsesManagedAuth && !isManagedVenice && (
          <div style={STYLES.fieldGroup}>
            <label className="mono" style={STYLES.fieldLabel}>
              {selectedProvider.keyLabel || `${selectedProvider.name} API Key`}
              <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 8 }}>
                · {selectedProvider.hint.split(/(https?:\/\/[^\s]+)/g).map((part) =>
                  part.match(/^https?:\/\//)
                    ? <a key={part} href={part} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', color: 'inherit', position: 'relative', zIndex: 10 }}>{part}</a>
                    : part
                )}
              </span>
            </label>

            {matchedVaultKey && useVaultKey ? (
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                border: "1px solid var(--etched-border)",
                background: "var(--bg-elevated)",
                padding: "10px 14px",
                gap: 12,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Key size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
                  <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: 12, opacity: 0.7 }}>
                    Vault key loaded
                    {matchedVaultKey.key_preview && (
                      <span style={{ opacity: 0.45, marginLeft: 6 }}>({matchedVaultKey.key_preview})</span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setUseVaultKey(false)}
                  style={{
                    ...TEXT_ACTION_TARGET,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    fontWeight: 700,
                    opacity: 0.45,
                    flexShrink: 0,
                  }}
                >
                  Use different key
                </button>
              </div>
            ) : (
              <>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={Boolean(combinedApiKeyError)}
                  style={{
                    ...STYLES.textInput,
                    ...(combinedApiKeyError ? { borderColor: "#b3261e" } : {}),
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "var(--ink-black)")}
                  onBlur={(e) => {
                    e.target.style.borderColor = combinedApiKeyError ? "#b3261e" : "var(--etched-border)";
                    onApiKeyBlur?.();
                  }}
                />
                {combinedApiKeyError && (
                  <p
                    role="alert"
                    style={{
                      margin: "6px 0 0",
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: "#b3261e",
                      fontWeight: 600,
                    }}
                  >
                    {combinedApiKeyError}
                  </p>
                )}
                {matchedVaultKey && !useVaultKey && (
                  <button
                    type="button"
                    onClick={() => { setUseVaultKey(true); setApiKey(""); }}
                    style={{
                      ...TEXT_ACTION_TARGET,
                      marginTop: 2,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      fontWeight: 700,
                      opacity: 0.45,
                    }}
                  >
                    ← Use saved vault key instead
                  </button>
                )}
                <p style={{ margin: "5px 0 0", fontSize: 10, lineHeight: 1.4, opacity: 0.4, fontFamily: "var(--font-mono), monospace" }}>
                  Key will be encrypted and saved to your Vault automatically.
                </p>
              </>
            )}
          </div>
        )}

        {isManagedVenice && (
          <div style={STYLES.fieldGroup}>
            <label className="mono" style={STYLES.fieldLabel}>
              Venice API Key
            </label>
            <div
              style={{
                border: "1px solid var(--etched-border)",
                background: "var(--bg-elevated)",
                padding: "12px 14px",
                fontSize: 12,
                lineHeight: 1.5,
                opacity: 0.78,
              }}
            >
              No Venice key needed. Hivra relays requests to Venice without logging prompts, charges provider rates with no markup, and bills usage from your selected wallet.
            </div>
            {/* Balance/credit panels moved to the always-visible credit-status
                section above the Advanced disclosure. */}
          </div>
        )}

        {!cleanSlate && providerUsesManagedAuth && (
          <div style={STYLES.fieldGroup}>
            <label className="mono" style={STYLES.fieldLabel}>
              OAuth Session
              <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 8 }}>
                · starts automatically on first launch or reuses Vault
              </span>
            </label>
            {matchedVaultKey && useVaultKey ? (
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                border: "1px solid var(--etched-border)",
                background: "var(--bg-elevated)",
                padding: "10px 14px",
                gap: 12,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Key size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
                  <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: 12, opacity: 0.7 }}>
                    Vault session loaded
                    {matchedVaultKey.key_preview && (
                      <span style={{ opacity: 0.45, marginLeft: 6 }}>({matchedVaultKey.key_preview})</span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setUseVaultKey(false)}
                  style={{
                    ...TEXT_ACTION_TARGET,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    fontWeight: 700,
                    opacity: 0.45,
                    flexShrink: 0,
                  }}
                >
                  Use different session
                </button>
              </div>
            ) : (
              <div
                style={{
                  border: "1px solid var(--etched-border)",
                  background: "var(--bg-elevated)",
                  padding: "12px 14px",
                  fontSize: 12,
                  lineHeight: 1.5,
                  opacity: 0.78,
                }}
              >
                {selectedProvider.id === "nous"
                  ? "Nous Portal uses Hermes device auth. Deploy first, then connect your portal session once and Hermes will save the reusable session in Vault."
                  : "Codex uses ChatGPT OAuth. Hermes starts the ChatGPT device login automatically on first launch and saves the reusable session in Vault."}
              </div>
            )}
          </div>
        )}

        <div style={STYLES.fieldGroup}>
          <label className="mono" style={STYLES.fieldLabel}>
            Honcho API Key
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "var(--gold-leaf)", textTransform: "uppercase", letterSpacing: "0.1em", background: "rgba(255, 44, 45,0.1)", padding: "2px 6px", border: "1px solid rgba(255, 44, 45,0.3)" }}>
              Recommended
            </span>
          </label>

          {matchedHonchoVaultKey && useHonchoVaultKey ? (
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              border: "1px solid var(--etched-border)",
              background: "var(--bg-elevated)",
              padding: "10px 14px",
              gap: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Key size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
                <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: 12, opacity: 0.7 }}>
                  Vault key loaded
                  {matchedHonchoVaultKey.key_preview && (
                    <span style={{ opacity: 0.45, marginLeft: 6 }}>({matchedHonchoVaultKey.key_preview})</span>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setUseHonchoVaultKey(false)}
                style={{
                  ...TEXT_ACTION_TARGET,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 700,
                  opacity: 0.45,
                  flexShrink: 0,
                }}
              >
                Use different key
              </button>
            </div>
          ) : (
            <>
              <input
                type="password"
                value={honchoApiKey}
                onChange={(e) => setHonchoApiKey(e.target.value)}
                placeholder="honcho_..."
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                style={STYLES.textInput}
                onFocus={(e) => (e.target.style.borderColor = "var(--ink-black)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--etched-border)")}
              />
              {matchedHonchoVaultKey && !useHonchoVaultKey && (
                <button
                  type="button"
                  onClick={() => { setUseHonchoVaultKey(true); setHonchoApiKey(""); }}
                  style={{
                    ...TEXT_ACTION_TARGET,
                    marginTop: 2,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    fontWeight: 700,
                    opacity: 0.45,
                  }}
                >
                  ← Use saved vault key instead
                </button>
              )}
              <p style={{ margin: "6px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--text-secondary)" }}>
                Gives your agent long-term memory across sessions.{" "}
                <a
                  href="https://app.honcho.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--ink-black)", fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 2 }}
                >
                  Sign up at app.honcho.dev
                </a>{" "}
                for $100 in free credits.
                <br />
                <span style={{ opacity: 0.7 }}>
                  Other memory providers, including local-only options, are available in dashboard settings after deployment.
                </span>
              </p>
            </>
          )}
        </div>
        </>
        )}

        {/* Deploy CTA — the primary action is ALWAYS "Deploy Agent". We never
            swap it for a funding CTA: a zero-credit managed-Venice deploy can
            still go through (a flag-gated starter credit may cover it, and the
            instance page has its own boot/funding UI). Funding is offered as a
            SECONDARY link below for users who want to top up first. */}
        {deployAlert}

        <button
          type="button"
          data-testid="deploy-primary-cta"
          className="premium-btn"
          onClick={handleDeployAttempt}
          disabled={deploying || retryBlocked}
          aria-busy={deploying}
          style={{
            ...STYLES.primaryButton,
            opacity: deploying || retryBlocked ? 0.5 : 1,
            cursor: deploying ? "wait" : retryBlocked ? "not-allowed" : "pointer",
            marginTop: "0.5rem",
          }}
        >
          {deploying ? (
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
          ) : (
            <Rocket size={14} />
          )}
          {deploying
            ? `Deploying ${selectedAgentLabel}...`
            : retryBlocked
              ? `Try again in ${retrySecondsLeft}s`
              : deployCtaLabel}
          {!deploying && !retryBlocked && <ArrowRight size={14} />}
        </button>

        {/* Secondary funding link — only for a managed-Venice deploy with no
            credit yet. It opens the existing top-up step instead of blocking
            the deploy. */}
        {isManagedVenice && !hasManagedVeniceCredits && !deploying && !retryBlocked && (
          <button
            type="button"
            onClick={() => setShowManagedVeniceFundingStep(true)}
            style={{
              alignSelf: "center",
              marginTop: 12,
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--text-secondary)",
              textDecoration: "underline",
              textUnderlineOffset: 3,
              ...TEXT_ACTION_TARGET,
              gap: 6,
            }}
          >
            <Wallet size={12} />
            Add credit first
          </button>
        )}
      </div>

      {/* What happens next */}
      <div className="sub-glass-card" style={STYLES.nextStepsCard}>
        <span className="mono" style={STYLES.nextStepsLabel}>What happens next</span>
        <div style={STYLES.nextStepsGrid}>
          {[
            { icon: <Zap size={14} />, text: `${displayName} gets a private computer of its own` },
            { icon: <Key size={14} />, text: cleanSlate ? "Starts with a clean slate — connect the AI you want from inside the agent" : isManagedVenice ? "AI is included — usage comes out of your prepaid credit" : providerUsesManagedAuth ? "You sign in once after launch; the session is saved securely" : "Your key is encrypted and stored securely" },
            { icon: <Rocket size={14} />, text: "Ready to browse the web, work on tasks, and remember what matters" },
          ].map(({ icon, text }) => (
            <div key={text} style={STYLES.nextStepItem}>
              <span style={{ color: "var(--gold-leaf)" }}>{icon}</span>
              <span style={{ fontSize: 12, opacity: 0.7 }}>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </AnimateIn>
  );
}


function SpecializedDeployCard({
  card,
}: {
  card: DeploySpecializationCard;
}) {
  return (
    <div
      style={{
        marginBottom: "1.75rem",
        border: "1px solid var(--etched-border)",
        background: "color-mix(in srgb, var(--bg-elevated) 82%, transparent)",
        padding: "18px 20px",
        display: "grid",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 800, opacity: 0.5 }}>
            {card.eyebrow}
          </span>
          <h3 className="serif" style={{ margin: "6px 0 6px", fontSize: 24, lineHeight: 1.1, fontWeight: 650 }}>
            {card.title}
          </h3>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.58, color: "var(--text-secondary)" }}>
            {card.summary}
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <SpecializedDeployList title="Included" items={card.included} tone="gold" />
        <SpecializedDeployList title="Starter work" items={card.starterTasks} tone="ink" />
        <SpecializedDeployList title="Guardrails" items={card.guardrails} tone="green" />
      </div>
    </div>
  );
}

function SpecializedDeployList({
  title,
  items,
  tone,
}: {
  title: string;
  items: readonly string[];
  tone: "gold" | "green" | "ink";
}) {
  const color = tone === "gold" ? "var(--gold-leaf)" : tone === "green" ? "#16a34a" : "var(--ink-black)";
  return (
    <div style={{ border: "1px solid var(--etched-border)", background: "var(--bg-surface)", padding: "12px 13px" }}>
      <span className="mono" style={{ display: "block", marginBottom: 8, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800, color }}>
        {title}
      </span>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 7 }}>
        {items.map((item) => (
          <li key={item} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, lineHeight: 1.45, color: "var(--text-secondary)" }}>
            <CheckCircle size={12} style={{ color, flexShrink: 0, marginTop: 2 }} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
