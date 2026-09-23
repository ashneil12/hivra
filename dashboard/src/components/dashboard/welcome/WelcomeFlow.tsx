'use client';

/**
 * /dashboard/welcome — multi-step welcome flow.
 *
 * State machine: loading → agent-type → (plan | deploy) → deploying.
 *
 *   loading       Initial entitlement probe (3 s hard timeout to avoid
 *                 freezing the welcome page on a stalled API).
 *   agent-type    Catalog picker for deployable starters such as Hermes Agent
 *                 or Claude Code. Selection sets starter name/provider,
 *                 then routes to plan if not entitled or deploy if entitled.
 *   plan          Payment-path picker (Free / Card / $HermesOS) for users
 *                 who still need entitlement before the deploy card.
 *   deploy        DeployForm — single-card "name + provider + key" deploy.
 *   deploying     DeployingState — provisioning loader; instance API
 *                 returns and we router.push to the new instance.
 *   sync-pending  Recovery state for the post-Stripe ?subscription=success
 *                 race where the webhook hasn't activated the user yet.
 *
 * Routing inputs:
 *   ?step=deploy            Skip plan, jump straight to deploy. Used by
 *                           the wallet page after an eligibility detection.
 *   ?subscription=success   Post-Stripe checkout return. Polls usage
 *                           until subscribed=true (5 retries, 1.5 s apart),
 *                           then jumps to deploy. If still not active,
 *                           shows sync-pending recovery.
 *
 * Already-set-up users (subscribed AND have ≥ 1 agent) bounce to
 * /dashboard. Subscribed-no-agents see the picker so stale stored choices
 * cannot skip Hermes Agent vs Claude Code. Everyone else sees the picker
 * or plan path.
 */

import { isCryptoBillingUiEnabled } from '@/lib/billing/format';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import posthog from 'posthog-js';
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  CheckCircle,
  CheckCircle2,
  Code2,
  Coins,
  Compass,
  Cpu,
  CreditCard,
  Globe,
  Loader2,
  Infinity as InfinityIcon,
  Megaphone,
  MemoryStick,
  MessagesSquare,
  Orbit,
  PenTool,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';

import {
  DEFAULT_WELCOME_AGENT_TYPE_KEY,
  WELCOME_AGENT_TYPES,
  WELCOME_AGENT_TYPE_STORAGE_KEY,
  getWelcomeAgentTypeDefinition,
  resolveWelcomeAgentTypeKey,
  type WelcomeAgentTypeDefinition,
  type WelcomeAgentTypeKey,
} from '@/lib/welcome-agent-catalog';
import { getFeaturedProvider, PROVIDERS, type Provider } from '@/lib/models';
import {
  WELCOME_PERSONAS,
  WELCOME_PERSONA_STORAGE_KEY,
  getWelcomePersonaById,
  type WelcomePersonaDefinition,
  type WelcomePersonaIconKey,
} from '@/lib/welcome-persona-catalog';
import { GOALS as IDENTITY_GOALS } from '@/lib/hivra/agent-identity';

const DEFAULT_PROVIDER: Provider = getFeaturedProvider(PROVIDERS) ?? PROVIDERS[0];
import { clientLog } from '@/lib/client/logger';
import { usePreferredProviderModels } from '@/lib/hooks/usePreferredProviderModels';
import {
  redirectToCheckoutUrl,
  requestManagedVeniceCardTopUpCheckout,
  requestSubscriptionCheckout,
} from '@/lib/billing/client';
import { BILLING_SUBSCRIBE_REASON } from '@/lib/billing/subscribe-errors';
import type { PlanKey } from '@/lib/subscription';
import { FreeTierCardVerification } from '@/components/billing/FreeTierCardVerification';
import { UpgradePaywallModal } from '@/components/billing/UpgradePaywallModal';
import { isSecondAgentUpgradeEnabled } from '@/lib/flags/upgrade-prompts';
import { ManagedVeniceDepositModal } from '@/components/billing/ManagedVeniceDepositModal';
import { formatMicroUsd } from '@/components/billing/ManagedVeniceSubsidyBanner';
import { AnimateIn } from '@/components/ui/animate-in';
import { STYLES } from '@/components/dashboard/welcome/styles';
import {
  DeploymentDestinationControl,
  measuredTargetCapacity,
  useLaunchDestination,
} from '@/components/dashboard/welcome/DeploymentDestinationControl';
import { DeployForm, focusOnFinePointer, type DashboardVaultKey } from '@/components/dashboard/welcome/DeployForm';
import { parseLaunchTargetHandoff, type LaunchTargetHandoff } from '@/components/dashboard/welcome/launch-target-handoff';
import { DeployingState } from '@/components/dashboard/welcome/DeployingState';
import { DeployedCelebration } from '@/components/dashboard/welcome/DeployedCelebration';
import {
  buildPostDeployDestination,
  buildWelcomeAgentSettings,
} from '@/lib/welcome-deploy';
import {
  buildHermesWelcomeSystemPrompt,
  buildWelcomePersonalizationContext,
  hasWelcomePersonalization,
  type WelcomePersonalizationDraft,
} from '@/lib/welcome-personalization';
import {
  AGENTS as HIVRA_AGENTS,
  BASE_FLOOR,
  BROWSER_ADD,
  hostingDisclaimer,
  resizeFloor,
  type AgentDef as HivraAgentDef,
} from '@/lib/hivra/agent-catalog';
import {
  createAgent,
  fetchPlanStrict,
  type CreateAgentInput,
  type PlanInfo,
} from '@/lib/hivra/agent-api';
import {
  clearNativeLaunchRequestId,
  nativeLaunchRequestId,
} from '@/lib/hivra/native-launch-receipt';
import { PoolMeter } from '@/components/hivra/PoolMeter';
import { LaunchModelControl, type LaunchModelDraft } from './LaunchModelControl';
import { useModelLaunch } from './useModelLaunch';
import { ModelKeySelectionSchema, VENICE_DEFAULT_MODEL } from '@/lib/hivra/model-key-selection';
import { targetSupportsLaunchModelSettings } from '@/lib/hivra/agent-placement';
import {
  buildInfrastructureSetupHref,
  isPortableAgentLaunchId,
} from '@/lib/hivra/launch-navigation';
import type { ModelLaunchIntent } from '@/lib/hivra/agent-launch-api';
import { isLocalAuthMode } from '@/lib/self-host/config';
import { supportsHermesAuthProvider } from '@/lib/provider-auth';
import {
  PROVIDER_KEY_REQUIRED_MESSAGE,
  validateProviderKeyShape,
} from '@/lib/provider-key-shape';
import {
  buildWelcomeErrorInsight,
  sanitizeWelcomeErrorMessage,
  shouldRenderWelcomeErrorDetail,
  welcomeValidationInsight,
  type WelcomeErrorInsight,
} from '@/components/dashboard/welcome/welcome-error-insights';
import {
  getApiErrorMessage,
  getCardRequiredMessage,
  isCardRequiredResponse,
} from '@/lib/billing/card-required';
import { getFingerprintRequestId } from '@/lib/abuse/client-fingerprint';
import { getManagedVeniceProxyBaseUrl } from '@/lib/venice/managed-endpoints';
import type { ManagedVeniceWalletType } from '@/lib/venice/managed-credit-topup';
import {
  requestManagedVeniceSummary,
  type ManagedVeniceWalletSummaryPayload,
} from '@/lib/billing/managed-venice-client';

const WELCOME_ROUTE = '/dashboard/welcome';
const WELCOME_PERSONALIZATION_BEST_EFFORT_MS = 750;

type WelcomeBestEffortOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: unknown }
  | { status: 'timed-out' };

async function waitForWelcomeBestEffort(
  operation: Promise<void>,
  timeoutMs = WELCOME_PERSONALIZATION_BEST_EFFORT_MS,
): Promise<WelcomeBestEffortOutcome> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const operationResult = operation.then<WelcomeBestEffortOutcome, WelcomeBestEffortOutcome>(
    () => ({ status: 'completed' }),
    (error: unknown) => ({ status: 'failed', error }),
  );
  const timeoutResult = new Promise<WelcomeBestEffortOutcome>((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs);
  });

  try {
    return await Promise.race([operationResult, timeoutResult]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function buildHivraPostLaunchDestination(agent: HivraAgentDef, agentId: string): string {
  // The accepted launch is usually still provisioning. Land on the agent page
  // immediately, but select the runtime's primary native surface for the moment
  // it becomes ready: official CLI terminal for CLI agents, shipped dashboard
  // for dashboard agents. Messaging-channel setup remains an optional nudge.
  const primaryTab = agent.surface === 'dashboard' ? 'aeon' : 'terminal';
  return `/dashboard/agent/${agentId}?welcome=1&tab=${primaryTab}`;
}

function captureWelcomeEvent(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, {
      source: 'welcome-flow',
      route: WELCOME_ROUTE,
      ...properties,
    });
  } catch {
    // Product instrumentation must never make onboarding controls fail closed.
  }
}

// Compact CTA pair rendered inside plan-limit error notices (page banner +
// the per-form launch alerts) so users get a way out instead of a dead end.
const WELCOME_ERROR_ACTION_PRIMARY_STYLE: React.CSSProperties = {
  border: '1px solid var(--ink-black)',
  background: 'var(--ink-black)',
  color: 'var(--bg-surface)',
  cursor: 'pointer',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontWeight: 800,
  padding: '7px 11px',
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const WELCOME_ERROR_ACTION_SECONDARY_STYLE: React.CSSProperties = {
  border: '1px solid var(--etched-border)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontWeight: 800,
  padding: '7px 11px',
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

// Bordered mono "Back to agent choices" control shared by the launch forms.
const WELCOME_BACK_BUTTON_STYLE: React.CSSProperties = {
  border: '1px solid var(--etched-border)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  fontWeight: 800,
  minHeight: 44,
  padding: '8px 11px',
  marginBottom: 18,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

// Phones, plus touch tablets up to the compact rail width.
const WELCOME_TOUCH_COMPACT_QUERY = '(max-width: 767px), (max-width: 1023px) and (pointer: coarse)';

type FlowState = 'loading' | 'agent-type' | 'plan' | 'deploy' | 'deploying' | 'sync-pending';
type UrlFlowStep = 'agent-type' | 'plan' | 'deploy';

// Only these steps live in ?step=; transient states would dead-end a bookmark.
function isUrlFlowStep(value: unknown): value is UrlFlowStep {
  return value === 'agent-type' || value === 'plan' || value === 'deploy';
}

const URL_FLOW_STEP_ORDER: Record<UrlFlowStep, number> = { 'agent-type': 0, plan: 1, deploy: 2 };
const HISTORY_STEP_KEY = 'hivraWelcomeStep';
const HISTORY_FROM_KEY = 'hivraWelcomeFrom';

// Writes ?step= through the native History API, which Next keeps in sync with
// useSearchParams without a server round trip. A move forward pushes an entry
// that remembers the step it came from, so the system back gesture steps back.
// A move back to that step pops the entry instead of stacking another one;
// every other change rewrites the current entry. Returns true when it started
// a pop, which completes on the next popstate.
function writeWelcomeStepHistory(step: UrlFlowStep, userMove: boolean): boolean {
  const url = new URL(window.location.href);
  const urlStep = url.searchParams.get('step');
  if (urlStep === step) return false;
  const state = window.history.state as Record<string, unknown> | null;
  const entryStep = state?.[HISTORY_STEP_KEY];
  const rawEntryFrom = state?.[HISTORY_FROM_KEY];
  const entryFrom = isUrlFlowStep(rawEntryFrom) ? rawEntryFrom : null;
  url.searchParams.set('step', step);
  const href = `${url.pathname}${url.search}${url.hash}`;
  if (userMove && isUrlFlowStep(urlStep)) {
    if (URL_FLOW_STEP_ORDER[step] > URL_FLOW_STEP_ORDER[urlStep]) {
      window.history.pushState({ [HISTORY_STEP_KEY]: step, [HISTORY_FROM_KEY]: urlStep }, '', href);
      return false;
    }
    if (entryStep === urlStep && entryFrom === step) {
      window.history.back();
      return true;
    }
  }
  window.history.replaceState({ [HISTORY_STEP_KEY]: step, [HISTORY_FROM_KEY]: entryFrom }, '', href);
  return false;
}

// Portable identity of a saved template, read from the owner list or the
// shared-link endpoint. The launch route re-resolves it by id server-side.
type WelcomeLaunchTemplate = {
  id: string;
  name: string | null;
  type: string;
  emoji: string | null;
};

// The agents route forks templateId server-side; CreateAgentInput does not
// declare the field yet, so it is added here without widening every caller.
function withLaunchTemplate(input: CreateAgentInput, templateId: string | null | undefined): CreateAgentInput {
  if (!templateId) return input;
  const request: CreateAgentInput & { templateId: string } = { ...input, templateId };
  return request;
}

// Carries the HTTP status + the server's machine-readable failureType (e.g.
// 'provision_host_failure' from the placement-failover work) from the deploy
// POST into the catch block, where welcome-error-insights does the
// user-facing classification.
class DeployRequestError extends Error {
  readonly status?: number;
  readonly serverFailureType?: string;
  /** Machine-readable rejection code from the response body (e.g. FREE_INSTANCE_LIMIT_REACHED). */
  readonly errorCode?: string;
  /** For the one-base-agent 403: the user's existing instance the CTA should route to. */
  readonly existingInstanceId?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      serverFailureType?: string;
      errorCode?: string;
      existingInstanceId?: string;
    } = {},
  ) {
    super(message);
    this.name = 'DeployRequestError';
    this.status = options.status;
    this.serverFailureType = options.serverFailureType;
    this.errorCode = options.errorCode;
    this.existingInstanceId = options.existingInstanceId;
  }
}

const DEPLOY_RETRY_COOLDOWN_MS = 60_000;

type TierKey = 'free' | 'pro' | 'power';
type AgentTypeKey = WelcomeAgentTypeKey;
type AgentTypeDefinition = WelcomeAgentTypeDefinition;

const DEFAULT_AGENT_TYPE_KEY = DEFAULT_WELCOME_AGENT_TYPE_KEY;
const getAgentTypeDefinition = getWelcomeAgentTypeDefinition;
// The welcome-type keys that map 1:1 onto a Hivra box agent (BYO-login coding
// boxes). These reuse the command-center launch form rather than the general
// provider-config DeployForm. Their keys equal the catalog agent ids.
const HIVRA_BOX_AGENT_TYPE_KEYS: ReadonlySet<string> = new Set(['claude-code', 'codex']);
function isHivraBoxAgentType(key: string | null | undefined): boolean {
  return key != null && HIVRA_BOX_AGENT_TYPE_KEYS.has(key);
}
function hivraAgentForWelcomeType(key: string | null | undefined): HivraAgentDef | undefined {
  return key ? HIVRA_AGENTS.find((agent) => agent.id === key) : undefined;
}
const WELCOME_CPU_OPTIONS = [0.5, 1, 2, 4, 8];
const WELCOME_RAM_OPTIONS = [1, 2, 4, 8, 16];

function getProviderById(providerId: string | null | undefined): Provider | null {
  if (!providerId) return null;
  return PROVIDERS.find((provider) => provider.id === providerId) ?? null;
}

function getDefaultProviderForAgentType(agentType: AgentTypeDefinition | null): Provider {
  return getProviderById(agentType?.defaultProviderId) ?? DEFAULT_PROVIDER;
}

function readStoredAgentTypeKey(): AgentTypeKey | null {
  if (typeof window === 'undefined') return null;
  try {
    return resolveWelcomeAgentTypeKey(window.localStorage.getItem(WELCOME_AGENT_TYPE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistAgentTypeKey(key: AgentTypeKey) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WELCOME_AGENT_TYPE_STORAGE_KEY, key);
  } catch {
    // localStorage is best-effort only. The user can still continue in-session.
  }
}

function formatPoolValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function renderPersonaIcon(icon: WelcomePersonaIconKey) {
  if (icon === 'code') return <Code2 size={22} />;
  if (icon === 'megaphone') return <Megaphone size={22} />;
  if (icon === 'search') return <Search size={22} />;
  if (icon === 'pen-tool') return <PenTool size={22} />;
  if (icon === 'plus') return <Plus size={22} />;
  return <Compass size={22} />;
}

// Icon for the Advanced agent-type cards (the technical picker, demoted under
// the persona grid). Mirrors the catalog's iconKey.
function renderAdvancedAgentIcon(icon: WelcomeAgentTypeDefinition['icon']) {
  if (icon === 'code') return <Code2 size={18} />;
  if (icon === 'terminal') return <Terminal size={18} />;
  if (icon === 'infinity') return <InfinityIcon size={18} />;
  if (icon === 'messages') return <MessagesSquare size={18} />;
  if (icon === 'orbit') return <Orbit size={18} />;
  return <Compass size={18} />;
}

// Where each engine reads its post-launch customization — the REAL config files
// (verified against the agent-config audit, NOT guessed names). Shown as a
// one-line hint on the Advanced cards so users know what to edit on the box.
const ADVANCED_AGENT_CONFIG_HINT: Record<WelcomeAgentTypeKey, string> = {
  general: 'Tune it on the box via SOUL.md (identity) + USER.md (your context).',
  'claude-code': 'Tune it on the box via ~/.claude/CLAUDE.md instructions.',
  codex: 'Tune it on the box via AGENTS.md (project or ~/.agents/AGENTS.md).',
  aeon: 'Tune it in your GitHub repo via aeon.yml + STRATEGY.md.',
  openclaw: 'Tune it in the Control UI, or on the box via ~/.openclaw/openclaw.json.',
  'agent-zero': 'Tune it in Agent Zero’s own Settings, or on the box via /a0/.env + /a0/usr.',
};

// "Who are you?" single-select chips for the personalization step. Stored as a
// plain label string on personalizationDraft.who.
const WELCOME_WHO_OPTIONS: readonly string[] = [
  'Founder',
  'Developer',
  'Marketer',
  'Sales',
  'Trader',
  'Creator',
  'Other',
] as const;

function managedVeniceTopUpUsdToMicroUsd(amountUsd: number) {
  return Math.round(amountUsd * 1_000_000);
}

function resolveVeniceAccessModeForProvider(
  providerId: string,
  matchedVaultKey: DashboardVaultKey | null,
): 'managed' | 'byok' {
  if (providerId !== 'venice') return 'byok';
  return matchedVaultKey ? 'byok' : 'managed';
}

interface TierDefinition {
  key: TierKey;
  name: string;
  spec: string;
  pitch: string;
  badge: string;
  badgeIcon: React.ReactNode;
  badgeTone: 'gold' | 'green' | 'muted';
  features: string[];
  launchUsd: number | null;
  standardUsd: number | null;
  cardPriceLabel: string | null;
  // 2026-05-01: separate per-cadence labels surface alongside the
  // payment-method toggle so users can see what they'll be charged
  // before they pick monthly vs yearly.
  cardMonthlyPriceLabel?: string;
  cardYearlyPriceLabel?: string;
  /** USD-target for the yearly $HermesOS payment ($49 Pro, $99 Power). */
  cryptoYearlyUsd?: number;
}

const TIERS: TierDefinition[] = [
  {
    key: 'free',
    name: 'Free',
    spec: '0.5 vCPU · 1 GB RAM',
    pitch: 'Run a real agent today. Most users start without a card; anti-abuse checks may apply.',
    badge: 'Safeguarded free tier',
    badgeIcon: <CheckCircle2 size={11} />,
    badgeTone: 'green',
    features: [
      'One starter agent — sleeps after 4 idle days',
      'Hermes Agent pre-configured',
      'BYO AI key — zero markup',
    ],
    launchUsd: null,
    standardUsd: null,
    cardPriceLabel: null,
  },
  {
    key: 'pro',
    name: 'Pro',
    spec: '2 vCPU · 4 GB RAM',
    pitch: 'Multi-agent stacks with persistent memory, scheduling, and autonomous tools.',
    badge: 'Best for builders',
    badgeIcon: <Sparkles size={11} />,
    badgeTone: 'gold',
    features: [
      'Always-on — never paused for inactivity',
      'Autonomous browsing & tool use',
      'Persistent memory across sessions',
      'Scheduled tasks & cron jobs',
      'BYO AI key — zero markup',
    ],
    launchUsd: 99,
    standardUsd: 149,
    cardPriceLabel: '$9.99/mo · $79/yr',
    cardYearlyPriceLabel: '$79/yr',
    cardMonthlyPriceLabel: '$9.99/mo',
    cryptoYearlyUsd: 49,
  },
  {
    key: 'power',
    name: 'Power',
    spec: '4 vCPU · 8 GB RAM',
    pitch: 'Headroom for parallel agents. Burst CPU when capacity allows, priority support, future marketplace access.',
    badge: 'For power users',
    badgeIcon: <Zap size={11} />,
    badgeTone: 'muted',
    features: [
      'Everything in Pro',
      'Burst CPU when capacity allows',
      'Priority over free tier',
      'Future marketplace access',
      'Email support (48 hr)',
    ],
    launchUsd: 199,
    standardUsd: 299,
    cardPriceLabel: '$19.99/mo · $149/yr',
    cardYearlyPriceLabel: '$149/yr',
    cardMonthlyPriceLabel: '$19.99/mo',
    cryptoYearlyUsd: 99,
  },
];

interface UsageResponse {
  success?: boolean;
  data?: {
    subscribed?: boolean;
    usage?: { agentCount?: number };
    plan?: { totalCpu?: number; totalRam?: number };
  };
}

interface EligibilityResponse {
  success?: boolean;
  data?: {
    tiers?: {
      pro?: { currentlyEligible?: boolean };
      power?: { currentlyEligible?: boolean };
    };
  };
}

// Provisioning is synchronous on the server (POST /api/instances runs Phase 1
// inline, up to maxDuration=300s). On a fresh/cold host the work can run long
// enough that the client fetch returns an error — OR a non-fatal post-provision
// step returns failure — even though the VM was actually created and is booting.
// In that window the row exists in `provisioning` and the agent comes healthy a
// few minutes later. Showing "Deployment failed" there is a lie that scares users
// into thinking nothing worked. Before surfacing the error, look for the row this
// deploy just created and route to its boot screen instead.
//
// Only recovers into IN-PROGRESS / HEALTHY states (never failed/error/deleted) and
// only rows created in the last few minutes, so a genuine failure (no row) still
// shows the error, and we never route to a pre-existing unrelated agent.
async function findJustCreatedInstance(
  agentName: string,
): Promise<{ id: string; provider?: string } | null> {
  try {
    const res = await fetch('/api/instances');
    const body = (await res.json().catch(() => null)) as
      | { data?: Array<Record<string, unknown>> }
      | null;
    const list = Array.isArray(body?.data) ? body!.data! : [];
    const cutoffMs = Date.now() - 5 * 60 * 1000;
    const inProgress = list
      .filter((i) => {
        const status = String(i.status ?? '');
        const lifecycle = String(i.lifecycle_state ?? '');
        const healthy =
          status === 'provisioning' ||
          status === 'running' ||
          lifecycle === 'provisioning' ||
          lifecycle === 'active';
        if (!healthy) return false;
        const created = i.created_at ? Date.parse(String(i.created_at)) : NaN;
        return Number.isFinite(created) && created >= cutoffMs;
      })
      .sort(
        (a, b) =>
          Date.parse(String(b.created_at ?? 0)) - Date.parse(String(a.created_at ?? 0)),
      );
    const wanted = agentName.trim();
    // Exact name match or nothing. Falling back to "any recent instance"
    // hijacked parallel deploys: we'd route to (and PATCH the systemPrompt
    // of) somebody's OTHER in-flight agent that just happened to be <5 min
    // old, corrupting it with this deploy's personalization.
    const named = inProgress.find((i) => String(i.name ?? '').trim() === wanted);
    if (!named || typeof named.id !== 'string') return null;
    return { id: named.id, provider: typeof named.provider === 'string' ? named.provider : undefined };
  } catch {
    return null;
  }
}

// For the one-base-agent 403: is the user's EXISTING instance sitting in cold
// storage (needs "Restore your agent") or live (plain "Open your agent")?
// Mirrors the instance page's isColdStorageRestorableInstance check. summary
// mode skips the per-VM SSH probes, so this is a cheap DB read. On any
// failure default to the non-restorable label — the CTA routes to the same
// instance page either way, where the real restore banner lives.
async function readExistingInstanceRestorable(instanceId: string): Promise<boolean> {
  try {
    const res = await fetch('/api/instances?summary=true');
    const body = (await res.json().catch(() => null)) as
      | { data?: Array<Record<string, unknown>> }
      | null;
    const list = Array.isArray(body?.data) ? body!.data! : [];
    const row = list.find((i) => i.id === instanceId);
    if (!row) return false;
    const lifecycle = String(row.lifecycle_state ?? '');
    const pausedReason = String(row.paused_reason ?? '');
    return (
      lifecycle === 'cold_archived' ||
      lifecycle === 'pending_deletion' ||
      pausedReason === 'cold_archived'
    );
  } catch {
    return false;
  }
}

export function WelcomeFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selfHosted = isLocalAuthMode();
  const targetHandoff = parseLaunchTargetHandoff(searchParams?.getAll('targetId') ?? []);
  const [managedHandoffOverride, setManagedHandoffOverride] = useState<string | null>(null);
  const blocksLegacyHandoff = targetHandoff !== null && managedHandoffOverride !== targetHandoff.key;

  const stepParam = searchParams?.get('step');
  const forceAgentTypeStep = stepParam === 'agent-type';
  const subscriptionSuccess = searchParams?.get('subscription') === 'success';
  const agentTypeParam = searchParams?.get('agentType');
  const hasExplicitAgentTypeParam = resolveWelcomeAgentTypeKey(agentTypeParam) !== null;
  // "Browse every agent" on /dashboard/launch opens this catalog; keep a way
  // back to the Launch journey that sent the user here.
  const fromLaunch = searchParams?.get('from') === 'launch';
  const templateIdParam = searchParams?.get('templateId') ?? null;
  const templateTokenParam = searchParams?.get('templateToken') ?? null;

  // ── Flow state ───────────────────────────────────────────────────────────
  const [flowState, setFlowStateInternal] = useState<FlowState>('loading');
  // Async work from the mount-time probe (and its timeout race) must observe
  // the LIVE flow state, not its mount closure. Every transition goes through
  // this tracked setter so flowStateRef can never lag behind.
  const flowStateRef = useRef<FlowState>('loading');
  const setFlowState = useCallback((next: FlowState) => {
    flowStateRef.current = next;
    setFlowStateInternal(next);
  }, []);
  const [canDeploy, setCanDeploy] = useState(false);
  const [selectedAgentTypeKey, setSelectedAgentTypeKey] = useState<AgentTypeKey | null>(() =>
    resolveWelcomeAgentTypeKey(agentTypeParam) ?? readStoredAgentTypeKey()
  );
  const selectedAgentType = useMemo(
    () => getAgentTypeDefinition(selectedAgentTypeKey),
    [selectedAgentTypeKey],
  );
  // ── Persona-first onboarding (paioclaw-riplist wave) ───────────────────────
  // The agent-type step is re-skinned as named PERSONA cards (Atlas, Dev, ...),
  // each mapping under the hood to a real agent-type key + a personality/emoji
  // preset. Selecting a persona reveals an inline personalization panel; the
  // "Continue" CTA then runs the SAME handleSelectAgentType that the technical
  // cards always used, so plan/deploy routing is unchanged.
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const selectedPersona = useMemo(
    () => getWelcomePersonaById(selectedPersonaId),
    [selectedPersonaId],
  );
  // Custom "Build your own" inputs (only used when the custom persona is chosen).
  const [customPersonaName, setCustomPersonaName] = useState('');
  const [customPersonaExpertise, setCustomPersonaExpertise] = useState('');
  const [customPersonaEmoji, setCustomPersonaEmoji] = useState('🤖');
  // Set on a clean deploy success so we can show a brief "your agent is live"
  // celebration before routing to the agent (instead of an instant redirect).
  const [deployedInfo, setDeployedInfo] = useState<{
    name: string;
    emoji?: string | null;
    instanceId: string;
    destination: string;
    cpu?: number;
    ramMb?: number;
    engineName?: string | null;
  } | null>(null);
  const [error, setErrorMessage] = useState<string | null>(null);
  // Structured context for deploy failures (category, raw detail, plan CTAs).
  // Always set/cleared alongside `error` so the banner can't show stale CTAs.
  const [errorInsight, setErrorInsight] = useState<WelcomeErrorInsight | null>(null);
  // Bumped on every surfaced error, including a repeat of the same message, so
  // each blocked tap brings the notice back into view.
  const [errorRevision, setErrorRevision] = useState(0);
  const errorNoticeRef = useRef<HTMLDivElement>(null);
  const setError = useCallback((message: string | null) => {
    setErrorMessage(message);
    setErrorInsight(null);
    if (message) setErrorRevision((revision) => revision + 1);
  }, []);
  const setDeployError = useCallback((insight: WelcomeErrorInsight) => {
    setErrorMessage(insight.headline);
    setErrorInsight(insight);
    setErrorRevision((revision) => revision + 1);
  }, []);
  useEffect(() => {
    if (errorRevision === 0) return;
    errorNoticeRef.current?.scrollIntoView?.({ block: 'center' });
  }, [errorRevision]);
  const [launchTemplate, setLaunchTemplate] = useState<WelcomeLaunchTemplate | null>(null);
  const [launchTemplateError, setLaunchTemplateError] = useState<string | null>(null);
  const [cardGateMessage, setCardGateMessage] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // Moment #4: the second-agent upgrade paywall. Opened from the one-base-agent
  // limit banner's "Upgrade plan" CTA when isSecondAgentUpgradeEnabled() is on.
  // Default OFF → the CTA keeps its plain billing redirect (no regression).
  const [secondAgentPaywallOpen, setSecondAgentPaywallOpen] = useState(false);
  // paywall_viewed fires once per mount when the plan step first shows —
  // the ref guards against re-fires when the user navigates back to 'plan'.
  const paywallViewedRef = useRef(false);
  useEffect(() => {
    if (flowState !== 'plan' || paywallViewedRef.current) return;
    paywallViewedRef.current = true;
    captureWelcomeEvent('paywall_viewed', { surface: 'welcome-flow' });
  }, [flowState]);
  // Users blind-retried failed provisions 5-8×. After two consecutive
  // infra-class failures the Deploy button cools down for 60 s.
  const [deployRetryBlockedUntilMs, setDeployRetryBlockedUntilMs] = useState<number | null>(null);
  const deployFailureStreakRef = useRef(0);

  // ── Plan selection ───────────────────────────────────────────────────────
  // Two-step paid-tier flow.
  //   paidPathChoice === null     → explicitly opened optional payment choices
  //   paidPathChoice === 'card'   → step 2: cadence toggle + Pro/Power grid
  //   paidPathChoice === 'crypto' → step 2: mode toggle + Pro/Power grid
  const [paidPathChoice, setPaidPathChoice] = useState<'card' | 'crypto' | null>('card');
  // Set while a card-checkout POST is in flight so we can show a
  // "Opening secure checkout…" state on the clicked CTA and disable
  // the sibling CTA. Cleared on error; on success the browser is
  // already navigating to Stripe so the unmount handles it.
  const [cardCheckoutLoadingTier, setCardCheckoutLoadingTier] = useState<'pro' | 'power' | null>(null);
  const [freeActivationLoading, setFreeActivationLoading] = useState(false);
  const [cardCadence, setCardCadence] = useState<'monthly' | 'yearly'>('yearly');
  // 'permanent' is the user-facing label for hold-to-qualify (catchy +
  // conveys 'tier stays as long as you hold'); withdraw any time still applies.
  const [cryptoMode, setCryptoMode] = useState<'yearly' | 'permanent'>('yearly');

  // ── Deploy form state ────────────────────────────────────────────────────
  const initialDeployProvider = getDefaultProviderForAgentType(selectedAgentType);
  const [agentName, setAgentName] = useState(selectedAgentType?.defaultName ?? 'MY_FIRST_AGENT');
  const [selectedProvider, setSelectedProvider] = useState<Provider>(initialDeployProvider);
  const [model, setModel] = useState(initialDeployProvider.models[0]?.value ?? '');
  const [apiKey, setApiKey] = useState('');
  // Gates the inline key error so a pristine field isn't flagged before the
  // user has interacted with it (set on key-input blur and on deploy attempt).
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  // Deploy-card redesign: a single top-level "Managed (Venice)?" toggle.
  //   managed = true  → managed-Venice path (unchanged billing/funding flow).
  //   managed = false → BYOK "clean-slate": deploy with NO provider/model/key
  //     so the agent's native onboarding overlay fires and the user connects a
  //     provider after the box is up (kills the keyless-provider init brick).
  // Defaults ON so the happy path stays the working Venice managed flow.
  const [managed, setManaged] = useState(true);
  // Box-size picker (CPU cores / RAM GB). Lifted from the Hivra-box form so
  // the Hermes-lane deploy card sizes the VM explicitly instead of silently
  // inheriting the plan total.
  const [deployCpu, setDeployCpu] = useState(2);
  const [deployRamGb, setDeployRamGb] = useState(4);
  // Track W (web dejargonization): the size pickers now live behind the deploy
  // card's "Advanced setup" disclosure, so the default footprint must come from
  // the plan the user activated instead of the 2/4 hardcode. Mirrors the
  // Hivra-box lane's snap-to-largest-fitting-option rule. A manual pick in
  // Advanced always wins (touched ref); when the plan probe fails
  // (fetchPlanStrict → null) we keep the existing defaults rather than
  // downgrading a paid user to the free floor on a transient billing error.
  const deploySizeTouchedRef = useRef(false);
  const deploySizeDefaultsAppliedRef = useRef(false);
  const setDeployCpuTouched = useCallback((value: number) => {
    deploySizeTouchedRef.current = true;
    setDeployCpu(value);
  }, []);
  const setDeployRamGbTouched = useCallback((value: number) => {
    deploySizeTouchedRef.current = true;
    setDeployRamGb(value);
  }, []);
  const [veniceAccessMode, setVeniceAccessMode] = useState<'managed' | 'byok'>('managed');
  const [managedVeniceWalletType, setManagedVeniceWalletType] = useState<ManagedVeniceWalletType>('card');
  const initialFundingWalletResolved = useRef(false);
  const [managedVeniceCardCheckoutLoading, setManagedVeniceCardCheckoutLoading] = useState(false);
  const [managedVeniceSummary, setManagedVeniceSummary] =
    useState<ManagedVeniceWalletSummaryPayload | null>(null);
  const [managedVeniceSummaryLoading, setManagedVeniceSummaryLoading] = useState(false);
  // Unknown balance ≠ zero balance: when the summary fetch fails we must not
  // funnel users with real credits into the funding wall.
  const [managedVeniceSummaryFailed, setManagedVeniceSummaryFailed] = useState(false);
  const [honchoApiKey, setHonchoApiKey] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [personalizationDraft, setPersonalizationDraft] = useState<WelcomePersonalizationDraft>({
    goal: isHivraBoxAgentType(selectedAgentType?.key) ? 'build' : 'assist',
    context: '',
    firstTask: '',
  });
  const personalizationDraftRef = useRef(personalizationDraft);
  // The persona identity in the draft is OWNED by selectedPersonaId. Only a live
  // persona selection ever writes these fields (handleSelectPersona, the Continue
  // fold-in, and the personalization panel — which renders only under a selected
  // persona), so the inverse has to hold too: no persona selected → no persona
  // identity in the draft.
  //
  // The picker preselects Bea for zero-reading first-runners, which seeds her
  // authored soul. handleSelectAdvancedAgent clears the selection but NOT the
  // draft, so EVERY advanced card (Claude Code, Codex, Aeon, OpenClaw, Agent
  // Zero and the plain Hermes Agent) shipped Bea's soul as the BASE of the
  // deployed systemPrompt / SOUL.md.
  //
  // User-entered goal/context/firstTask/audience answers are kept — only the
  // persona identity is dropped.
  const personaIdentityOwned = selectedPersonaId !== null;
  useEffect(() => {
    if (personaIdentityOwned) return;
    setPersonalizationDraft((draft) => {
      // Nothing to strip — keep the same reference so the common no-persona
      // case (every mount, every advanced-lane step) costs no extra render.
      if (
        draft.personality == null &&
        draft.emoji == null &&
        draft.agentName == null &&
        draft.soulPromptId == null
      ) {
        return draft;
      }
      return {
        ...draft,
        personality: null,
        emoji: null,
        agentName: null,
        soulPromptId: null,
      };
    });
  }, [personaIdentityOwned]);

  // ── Vault ────────────────────────────────────────────────────────────────
  const [vaultKeys, setVaultKeys] = useState<DashboardVaultKey[]>([]);
  const [matchedVaultKey, setMatchedVaultKey] = useState<DashboardVaultKey | null>(null);
  const [useVaultKey, setUseVaultKey] = useState(false);
  const [matchedHonchoVaultKey, setMatchedHonchoVaultKey] = useState<DashboardVaultKey | null>(null);
  const [useHonchoVaultKey, setUseHonchoVaultKey] = useState(false);
  const initialVaultProviderIdRef = useRef(selectedProvider.id);

  const {
    modelOptions,
    hasLiveModels,
    isLoading: isLoadingLiveModels,
    error: liveModelsError,
  } = usePreferredProviderModels({
    provider: selectedProvider.id,
    staticModels: selectedProvider.models,
    apiKey: useVaultKey ? '' : apiKey,
    vaultKeyId: useVaultKey ? matchedVaultKey?.id : undefined,
  });
  const isManagedVeniceDeploySelection =
    selectedProvider.id === 'venice' && veniceAccessMode === 'managed';
  // ── Inline provider-key validation ──────────────────────────────────────
  // Mirrors the createInstance gate in instance-service.ts exactly: a key is
  // required unless the deploy is managed Venice, a Vault key id will be
  // sent, or the provider authenticates via a Hermes-managed OAuth session
  // (codex / nous / xai-oauth). Shape rules come from the same shared
  // validator the server runs, so deploy-blocking key mistakes surface at
  // the input instead of after the whole onboarding flow.
  const providerKeyInlineError = useMemo(() => {
    if (isManagedVeniceDeploySelection || (useVaultKey && matchedVaultKey?.id)) return null;
    if (!apiKey.trim()) {
      return supportsHermesAuthProvider(selectedProvider.id)
        ? null
        : PROVIDER_KEY_REQUIRED_MESSAGE;
    }
    return validateProviderKeyShape(selectedProvider.id, apiKey)?.message ?? null;
  }, [apiKey, isManagedVeniceDeploySelection, matchedVaultKey?.id, selectedProvider.id, useVaultKey]);
  const managedVeniceAvailableMicroUsd =
    managedVeniceWalletType === 'hermesos'
      ? managedVeniceSummary?.wallets.hermesos.availableMicroUsd ?? 0
      : managedVeniceSummary?.wallets.card.availableMicroUsd ?? 0;

  useEffect(() => {
    personalizationDraftRef.current = personalizationDraft;
  }, [personalizationDraft]);

  // Keep ?step= in sync with the flow so refresh/back land where the user
  // actually was instead of replaying the probe from scratch. Transient
  // states (loading/deploying/sync-pending) stay off the URL — re-entering
  // them from a bookmark would dead-end. Moves between visible steps go
  // through the history stack (writeWelcomeStepHistory); probe-driven
  // arrivals rewrite the current entry. Browser back/forward is applied by
  // the popstate listener below.
  const pageTopRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const previousFlowStateRef = useRef<FlowState>('loading');
  const stepPopPendingRef = useRef(false);
  useEffect(() => {
    const previous = previousFlowStateRef.current;
    previousFlowStateRef.current = flowState;
    if (previous === flowState || !isUrlFlowStep(flowState)) return;
    const userStepChange = isUrlFlowStep(previous);
    // Each step opens at its heading, not at the scroll offset of the last.
    // The page top also keeps the "← Launch" link above the heading in view.
    const header = headerRef.current;
    if (userStepChange && header) {
      const viewportTop = header.closest('main')?.getBoundingClientRect().top ?? 0;
      if (header.getBoundingClientRect().top < viewportTop) {
        (pageTopRef.current ?? header).scrollIntoView?.({ block: 'start' });
      }
    }
    // A pop this flow started is still landing; its popstate syncs the URL.
    if (stepPopPendingRef.current) return;
    stepPopPendingRef.current = writeWelcomeStepHistory(flowState, userStepChange);
  }, [flowState]);

  useEffect(() => {
    const onPopState = () => {
      const current = flowStateRef.current;
      if (stepPopPendingRef.current) {
        stepPopPendingRef.current = false;
        // The flow may have moved again while its own pop was landing.
        if (isUrlFlowStep(current)) stepPopPendingRef.current = writeWelcomeStepHistory(current, true);
        return;
      }
      const urlStep = new URLSearchParams(window.location.search).get('step');
      if (!isUrlFlowStep(urlStep) || !isUrlFlowStep(current) || urlStep === current) return;
      if (urlStep !== 'agent-type' && !selectedAgentType) return;
      setFlowState(urlStep);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [selectedAgentType, setFlowState]);

  useEffect(() => {
    setPersonalizationDraft((draft) => ({
      ...draft,
      goal: isHivraBoxAgentType(selectedAgentType?.key) ? 'build' : (draft.goal || 'assist'),
    }));
  }, [selectedAgentType?.key]);

  const applyHermesWelcomePersonalization = useCallback(
    async (instanceId: string) => {
      const draft = personalizationDraftRef.current;
      if (!hasWelcomePersonalization(draft)) return;
      const systemPrompt = buildHermesWelcomeSystemPrompt({
        agentName: agentName.trim(),
        basePrompt: selectedAgentType?.systemPrompt,
        draft,
      });
      const res = await fetch(`/api/instances/${instanceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apply: true,
          agentSettings: { systemPrompt },
          // Wave 1.2: also persist the raw captured fields to the dedicated
          // hermes_instances columns (the systemPrompt above stays the runtime
          // source of truth). The lifecycle-email sweep reads goal/first_task to
          // personalize re-engagement copy. Send the user's raw context, not the
          // composed markdown doc, so the columns hold the original answers.
          goal: draft.goal ?? undefined,
          firstTask: draft.firstTask ?? undefined,
          context: draft.context ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(getApiErrorMessage(body, 'Failed to save launch personalization'));
      }
    },
    [agentName, selectedAgentType?.systemPrompt],
  );

  const applyHivraWelcomePersonalization = useCallback(
    async (agentId: string) => {
      const draft = personalizationDraftRef.current;
      if (!hasWelcomePersonalization(draft)) return;
      const res = await fetch(`/api/hivra/agents/${agentId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'onboarding',
          goal: draft.goal,
          context: buildWelcomePersonalizationContext(draft),
          firstTask: draft.firstTask,
          // Persona-first onboarding: the route already persists personality +
          // emoji (and nulls bootstrapped_at to re-seed SOUL.md/USER.md); the UI
          // now actually sends them from the chosen persona preset.
          personality: draft.personality ?? undefined,
          emoji: draft.emoji ?? undefined,
          // Persona-souls upgrade: when a persona with an authored soul was chosen,
          // its id rides along so the route persists soul_prompt_id and the box
          // seeds SOUL.md with the FULL prompt. Absent for custom personas.
          soulPromptId: draft.soulPromptId ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(getApiErrorMessage(body, 'Failed to save Claude Code personalization'));
      }
    },
    [],
  );

  const refreshManagedVeniceSummary = useCallback(async () => {
    setManagedVeniceSummaryLoading(true);
    const result = await requestManagedVeniceSummary();
    setManagedVeniceSummaryLoading(false);
    if (result.ok) {
      setManagedVeniceSummary(result.summary);
      setManagedVeniceSummaryFailed(false);
      return result.summary;
    }

    setManagedVeniceSummaryFailed(true);
    clientLog.warn('Welcome managed Venice summary fetch failed', {
      source: 'welcome-flow',
      route: '/api/billing/managed-venice/summary',
      failureType: 'managed_venice_summary_fetch_failed',
      reason: result.reason ?? null,
      message: result.message,
    });
    return null;
  }, []);

  useEffect(() => {
    if (!isManagedVeniceDeploySelection) {
      setManagedVeniceSummary(null);
      return;
    }
    void refreshManagedVeniceSummary();
  }, [isManagedVeniceDeploySelection, refreshManagedVeniceSummary]);

  useEffect(() => {
    if (!isManagedVeniceDeploySelection || !managedVeniceSummary || initialFundingWalletResolved.current) return;
    initialFundingWalletResolved.current = true;
    const hermesosAvailable = managedVeniceSummary.wallets.hermesos.availableMicroUsd;
    const cardAvailable = managedVeniceSummary.wallets.card.availableMicroUsd;
    if (
      managedVeniceWalletType === 'hermesos' &&
      hermesosAvailable <= 0 &&
      cardAvailable > 0
    ) {
      setManagedVeniceWalletType('card');
    } else if (managedVeniceWalletType === 'card' && cardAvailable <= 0 && hermesosAvailable > 0) {
      setManagedVeniceWalletType('hermesos');
    }
  }, [isManagedVeniceDeploySelection, managedVeniceSummary, managedVeniceWalletType]);

  const enterDeploySetup = useCallback(
    (message?: string) => {
      setCanDeploy(true);
      if (selectedAgentType) {
        setSuccessMsg(message ?? null);
        setFlowState('deploy');
        return;
      }
      setSuccessMsg(null);
      setFlowState('agent-type');
    },
    [selectedAgentType, setFlowState],
  );

  const enterPlanSetup = useCallback(() => {
    setCanDeploy(false);
    if (selectedAgentType) {
      setFlowState('plan');
      return;
    }
    setFlowState('agent-type');
  }, [selectedAgentType, setFlowState]);

  // Set by the user's own agent or specialist pick. A saved template that
  // finishes loading after that must not switch their choice.
  const userPickedAgentRef = useRef(false);

  // Configure all deploy-form state for an agent type WITHOUT advancing the
  // flow. Extracted so the persona step can pre-select an agent type, let the
  // user fill the personalization panel, and only then advance on Continue.
  const configureAgentType = useCallback(
    (agentType: AgentTypeDefinition, opts?: { keepAgentName?: boolean }) => {
      const defaultProvider = getDefaultProviderForAgentType(agentType);
      const matchedDefaultVaultKey =
        vaultKeys.find((key) => key.provider === defaultProvider.id) ?? null;
      setSelectedAgentTypeKey(agentType.key);
      persistAgentTypeKey(agentType.key);
      if (!opts?.keepAgentName) setAgentName(agentType.defaultName);
      setSelectedProvider(defaultProvider);
      setModel(defaultProvider.models[0]?.value ?? '');
      setMatchedVaultKey(matchedDefaultVaultKey);
      setUseVaultKey(Boolean(matchedDefaultVaultKey));
      if (matchedDefaultVaultKey) setApiKey('');
      setVeniceAccessMode(
        resolveVeniceAccessModeForProvider(defaultProvider.id, matchedDefaultVaultKey),
      );
      setError(null);
      setCardGateMessage(null);
      setPaidPathChoice('card');
    },
    [setError, vaultKeys],
  );

  // Portable runtimes must reach destination selection before hosted billing
  // is relevant: user-owned capacity is valid without a Hivra Cloud plan.
  // Legacy Hermes launches still use their existing managed-plan gate.
  const advanceFromAgentType = useCallback(
    (agentType: AgentTypeDefinition) => {
      captureWelcomeEvent('welcome_agent_type_selected', {
        agentType: agentType.key,
        recommendedTier: agentType.recommendedTier,
        canDeploy,
      });
      setSuccessMsg(null);
      setFlowState(
        canDeploy || targetHandoff || isPortableAgentLaunchId(agentType.key)
          ? 'deploy'
          : 'plan',
      );
    },
    [canDeploy, setFlowState, targetHandoff],
  );

  // Persona-first: choosing a persona maps to its real agent type and seeds the
  // personalization draft (goal/personality/emoji) WITHOUT advancing — the
  // inline personalization panel appears next, then Continue advances.
  const handleSelectPersona = useCallback(
    (persona: WelcomePersonaDefinition, opts?: { preselected?: boolean }) => {
      const agentType = getAgentTypeDefinition(persona.agentTypeKey);
      if (!agentType) return;
      setSelectedPersonaId(persona.id);
      // A preselected default is not a user choice — never persist it (a real
      // click must stay the only thing that makes a persona sticky).
      if (!opts?.preselected) {
        userPickedAgentRef.current = true;
        try {
          window.localStorage.setItem(WELCOME_PERSONA_STORAGE_KEY, persona.id);
        } catch {
          // best-effort only
        }
      }
      configureAgentType(agentType, { keepAgentName: !persona.isCustom ? false : true });
      // Seed the (previously dead) personalization draft from the persona preset.
      // The user can still override every field in the panel below.
      if (!persona.isCustom) {
        setAgentName(persona.name);
      }
      setPersonalizationDraft((draft) => ({
        ...draft,
        goal: persona.goal,
        personality: persona.personality,
        emoji: persona.isCustom ? (customPersonaEmoji || persona.emoji) : persona.emoji,
        agentName: persona.isCustom ? customPersonaName : persona.name,
        // Persona-souls upgrade: carry the chosen persona's authored-soul id so it
        // seeds SOUL.md (Hivra lane) + the Hermes system prompt. Custom persona has
        // no soulPromptId → both lanes keep the generic path.
        soulPromptId: persona.soulPromptId ?? null,
      }));
      captureWelcomeEvent('welcome_persona_selected', {
        persona: persona.id,
        agentType: persona.agentTypeKey,
        custom: Boolean(persona.isCustom),
        // Funnel hygiene: the Bea default fires this on mount — exclude
        // preselected:true from pick-rate analyses; only human clicks count.
        preselected: Boolean(opts?.preselected),
      });
    },
    [configureAgentType, customPersonaEmoji, customPersonaName],
  );

  // Continue from the persona/personalization panel → advance like the
  // technical card path did. Custom persona folds its name/expertise/emoji into
  // the draft before advancing.
  const handleContinueFromPersona = useCallback(() => {
    if (!selectedPersona) return;
    const agentType = getAgentTypeDefinition(selectedPersona.agentTypeKey);
    if (!agentType) return;
    if (selectedPersona.isCustom) {
      const name = customPersonaName.trim();
      if (name) setAgentName(name);
      setPersonalizationDraft((draft) => ({
        ...draft,
        agentName: name || draft.agentName,
        emoji: (customPersonaEmoji || draft.emoji || '🤖'),
        // Fold the expertise line into context so the seeded prompt knows it.
        context: customPersonaExpertise.trim()
          ? [customPersonaExpertise.trim(), draft.context || ''].filter(Boolean).join('\n\n').slice(0, 2000)
          : draft.context,
      }));
    }
    advanceFromAgentType(agentType);
  }, [
    selectedPersona,
    customPersonaName,
    customPersonaEmoji,
    customPersonaExpertise,
    advanceFromAgentType,
  ]);

  // ── Launch from a saved template (/dashboard/templates, shared links) ──
  // Load the template's portable identity, preselect its agent type and name,
  // and send templateId with the launch so the agents route forks it.
  useEffect(() => {
    if (!templateIdParam && !templateTokenParam) return;
    let cancelled = false;
    const load = async (): Promise<WelcomeLaunchTemplate | null> => {
      if (templateTokenParam) {
        const res = await fetch(`/api/hivra/templates/shared/${encodeURIComponent(templateTokenParam)}`);
        const body = await res.json().catch(() => null);
        return body?.success ? (body.data.template as WelcomeLaunchTemplate) : null;
      }
      const res = await fetch('/api/hivra/templates');
      const body = await res.json().catch(() => null);
      const templates = body?.success ? (body.data.templates as WelcomeLaunchTemplate[]) : [];
      return templates.find((template) => template.id === templateIdParam) ?? null;
    };
    load()
      .then((template) => {
        if (cancelled) return;
        if (template) setLaunchTemplate(template);
        else setLaunchTemplateError('This template is no longer available. Choose an agent to launch instead.');
      })
      .catch((templateError: unknown) => {
        if (cancelled) return;
        setLaunchTemplateError("Couldn't load that template. Choose an agent to launch instead.");
        clientLog.warn('Welcome launch template load failed', {
          source: 'welcome-flow',
          failureType: 'welcome_launch_template_load_failed',
          message: templateError instanceof Error ? templateError.message : String(templateError),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [templateIdParam, templateTokenParam]);

  const launchTemplateAgentType = useMemo(() => {
    const key = resolveWelcomeAgentTypeKey(launchTemplate?.type);
    // Templates are saved from Hivra agents; the plain Hermes lane cannot fork one.
    return key && key !== DEFAULT_AGENT_TYPE_KEY ? getAgentTypeDefinition(key) : null;
  }, [launchTemplate?.type]);
  const launchTemplateActive = Boolean(
    launchTemplate && launchTemplateAgentType && selectedAgentType?.key === launchTemplateAgentType.key,
  );
  const launchTemplateName = launchTemplate?.name?.trim() || launchTemplateAgentType?.defaultName || 'Untitled template';

  // Preselect the template only while the user is still choosing. Once they
  // have picked for themselves, the banner's "Use this template" is the way in.
  const launchTemplateAppliedRef = useRef(false);
  useEffect(() => {
    if (!launchTemplate || !launchTemplateAgentType || launchTemplateAppliedRef.current) return;
    launchTemplateAppliedRef.current = true;
    const stillChoosing = flowStateRef.current === 'loading' || flowStateRef.current === 'agent-type';
    if (!stillChoosing || userPickedAgentRef.current) return;
    setSelectedPersonaId(null);
    configureAgentType(launchTemplateAgentType, { keepAgentName: true });
    setAgentName(launchTemplateName);
  }, [configureAgentType, launchTemplate, launchTemplateAgentType, launchTemplateName]);

  // Advanced path: the user opened the "pick a specific agent" disclosure and
  // chose a technical agent type directly (general / claude-code / codex / aeon).
  // This bypasses the persona presets and routes straight into the SAME deploy
  // flow the technical cards always used — preserving both deploy lanes.
  const handleSelectAdvancedAgent = useCallback(
    (agentType: AgentTypeDefinition) => {
      userPickedAgentRef.current = true;
      // Clear any persona selection so the persona personalization panel hides
      // and we behave like the original technical-card pick.
      setSelectedPersonaId(null);
      try {
        window.localStorage.removeItem(WELCOME_PERSONA_STORAGE_KEY);
      } catch {
        // best-effort only
      }
      // Picking the template's own agent keeps the template's name.
      const keepTemplateName = Boolean(launchTemplate && launchTemplateAgentType?.key === agentType.key);
      configureAgentType(agentType, { keepAgentName: keepTemplateName });
      captureWelcomeEvent('welcome_advanced_agent_selected', {
        agentType: agentType.key,
        recommendedTier: agentType.recommendedTier,
      });
      advanceFromAgentType(agentType);
    },
    [configureAgentType, advanceFromAgentType, launchTemplate, launchTemplateAgentType],
  );

  // The banner's explicit opt-in: the template's agent under the template's name.
  const handleUseLaunchTemplate = useCallback(() => {
    if (!launchTemplateAgentType) return;
    handleSelectAdvancedAgent(launchTemplateAgentType);
    setAgentName(launchTemplateName);
  }, [handleSelectAdvancedAgent, launchTemplateAgentType, launchTemplateName]);

  // ── Initial entitlement probe ────────────────────────────────────────────
  // If the URL says ?step=deploy (came back from /dashboard/wallet after
  // depositing), skip the plan picker and jump to deploy when an agent was
  // already selected. If it says ?step=agent-type, force the first-agent picker
  // even when localStorage has an old selection.
  // Otherwise: race a usage+eligibility check against a 3 s hard timeout
  // so a stalled API never freezes the welcome page on a spinner.
  const initialProbeRanRef = useRef(false);
  useEffect(() => {
    if (initialProbeRanRef.current) return;
    initialProbeRanRef.current = true;

    // ?step=deploy (back from /dashboard/wallet) used to skip the probe and
    // grant the deploy card unconditionally — unentitled deep-links then hit
    // the server 403 with no route back. Let the probe decide; the timeout
    // fallback below preserves the old instant-deploy behavior when the
    // billing API is slow (the server gate still backstops it).
    const wantsDeployStep = stepParam === 'deploy';

    // A local operator owns the computer and pays the infrastructure/model
    // providers directly. Hosted subscriptions and token eligibility are not
    // launch authority in this mode, so never route a self-hosted deployment
    // through Stripe or $HermesOS. Keep the agent picker unless the URL already
    // names the deploy step and a concrete agent is selected.
    if (selfHosted) {
      setCanDeploy(true);
      setSuccessMsg(null);
      setFlowState(wantsDeployStep && selectedAgentType ? 'deploy' : 'agent-type');
      return;
    }

    let cancelled = false;
    const ENTITLEMENT_TIMEOUT_MS = 3000;
    const SUBSCRIPTION_RETRY_MAX = subscriptionSuccess ? 5 : 0;
    const SUBSCRIPTION_RETRY_MS = 1500;

    const fetchUsage = (): Promise<UsageResponse | null> =>
      fetch('/api/billing/usage')
        .then((r) => r.json().catch(() => null) as Promise<UsageResponse | null>)
        .catch(() => null);

    const fetchEligibility = (): Promise<EligibilityResponse | null> =>
      fetch('/api/billing/wallet/eligibility')
        .then((r) => (r.ok ? r.json().catch(() => null) : null))
        .catch(() => null);

    const interpret = (usage: UsageResponse | null, elig: EligibilityResponse | null) => {
      const subscribed = Boolean(usage?.success && usage?.data?.subscribed);
      const agentCount = usage?.data?.usage?.agentCount ?? 0;
      const proOk = Boolean(elig?.data?.tiers?.pro?.currentlyEligible);
      const powerOk = Boolean(elig?.data?.tiers?.power?.currentlyEligible);
      const entitled = subscribed || proOk || powerOk;
      return { subscribed, entitled, agentCount };
    };

    const apply = (decision: { entitled: boolean; agentCount: number; subscribed: boolean }) => {
      if (cancelled) return;
      // The probe (and its timeout race) can resolve after the user has
      // already advanced — never yank state from under them.
      if (flowStateRef.current !== 'loading') return;
      if (targetHandoff) {
        // A prepared-computer handoff is not a managed subscription purchase.
        // Fresh target admission in the launch form remains authoritative.
        setCanDeploy(decision.entitled);
        setSuccessMsg(null);
        setFlowState(wantsDeployStep && selectedAgentType ? 'deploy' : 'agent-type');
        return;
      }
      if (wantsDeployStep) {
        if (selectedAgentType && isPortableAgentLaunchId(selectedAgentType.key)) {
          // Enter the real launch form even without managed entitlement so the
          // owner can select a ready self-managed target. The form separately
          // gates Hivra Cloud until a plan is activated.
          setCanDeploy(decision.entitled);
          setSuccessMsg(null);
          setFlowState('deploy');
        } else if (decision.entitled) {
          enterDeploySetup();
        } else {
          enterPlanSetup();
        }
        return;
      }
      if (forceAgentTypeStep) {
        setCanDeploy(decision.entitled);
        setSuccessMsg(null);
        setFlowState('agent-type');
        return;
      }
      if (decision.entitled && decision.agentCount > 0) {
        router.replace('/dashboard');
        return;
      }
      if (decision.entitled) {
        if (hasExplicitAgentTypeParam) {
          enterDeploySetup(
            subscriptionSuccess ? 'Subscription activated. Continue into your deploy setup.' : undefined,
          );
          return;
        }
        setCanDeploy(true);
        setSuccessMsg(null);
        setFlowState('agent-type');
        return;
      }
      enterPlanSetup();
    };

    const probe = async (retriesLeft: number): Promise<void> => {
      const [usage, elig] = await Promise.all([fetchUsage(), fetchEligibility()]);
      if (cancelled) return;

      const decision = interpret(usage, elig);

      // Post-Stripe race: webhook hasn't fired yet, retry briefly.
      if (subscriptionSuccess && !decision.subscribed && retriesLeft > 0) {
        await new Promise((res) => setTimeout(res, SUBSCRIPTION_RETRY_MS));
        if (!cancelled) await probe(retriesLeft - 1);
        return;
      }

      // Retries exhausted after Stripe — show recovery, not the picker.
      if (subscriptionSuccess && !decision.subscribed && retriesLeft === 0) {
        if (flowStateRef.current === 'loading') setFlowState('sync-pending');
        return;
      }

      apply(decision);
    };

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), ENTITLEMENT_TIMEOUT_MS),
    );

    Promise.race([probe(SUBSCRIPTION_RETRY_MAX), timeout]).then((result) => {
      if (cancelled) return;
      // flowStateRef, not the mount closure: the old `flowState === 'loading'`
      // check always read 'loading' and the timeout fired regardless.
      if (result !== 'timeout' || flowStateRef.current !== 'loading') return;
      // A user back from SUCCESSFUL checkout must never see the payment
      // picker again — the retry loop owns that path and lands on
      // sync-pending if the webhook stays slow (3 s timeout < 5×1.5 s
      // retries, so the race always lost before this guard existed).
      if (subscriptionSuccess) return;
      if (targetHandoff) {
        setSuccessMsg(null);
        setFlowState(wantsDeployStep && selectedAgentType ? 'deploy' : 'agent-type');
        return;
      }
      if (wantsDeployStep) {
        if (selectedAgentType && isPortableAgentLaunchId(selectedAgentType.key)) {
          // A timed-out entitlement probe is not proof of a managed plan.
          // Keep the portable self-managed path usable, but leave Hivra Cloud
          // gated until billing evidence actually confirms entitlement.
          setCanDeploy(false);
          setSuccessMsg(null);
          setFlowState('deploy');
        } else {
          enterDeploySetup();
        }
        return;
      }
      enterPlanSetup();
    });

    return () => {
      cancelled = true;
    };
    // We intentionally only run this once on mount — it owns flowState
    // until the user advances. Re-running on flowState changes would
    // overwrite their progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Vault keys: load + auto-match initial provider ───────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch('/api/vault')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.success && Array.isArray(d.data)) {
          setVaultKeys(d.data);
          const initialProviderId = initialVaultProviderIdRef.current;
          const match = d.data.find((k: DashboardVaultKey) => k.provider === initialProviderId);
          if (match) {
            setMatchedVaultKey(match);
            setUseVaultKey(true);
            const nextVeniceAccessMode = resolveVeniceAccessModeForProvider(
              initialProviderId,
              match,
            );
            setVeniceAccessMode(nextVeniceAccessMode);
            if (initialProviderId === 'venice' && nextVeniceAccessMode === 'byok') {
              clientLog.warn('Welcome Venice saved vault key selected BYOK mode', {
                source: 'welcome-flow',
                failureType: 'welcome_venice_saved_key_masked_by_managed_mode',
                provider: initialProviderId,
                hasMatchedVaultKey: true,
              });
            }
          }
          const honchoMatch = d.data.find(
            (k: DashboardVaultKey) => k.provider.toLowerCase() === 'honcho',
          );
          if (honchoMatch) {
            setMatchedHonchoVaultKey(honchoMatch);
            setUseHonchoVaultKey(true);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Plan-derived deploy size (Hermes lane) ───────────────────────────────
  // On first arrival at the deploy card, snap the hidden size defaults to the
  // largest picker option the activated plan allows (per-agent cap AND pool),
  // e.g. Free → 0.5/1, Pro → 2/4, Power → 4/8. Runs once; never overrides a
  // manual Advanced-setup pick; skipped for the box/Aeon lanes which fetch and
  // clamp their own plan limits.
  useEffect(() => {
    if (selfHosted) return;
    if (flowState !== 'deploy') return;
    if (deploySizeDefaultsAppliedRef.current) return;
    const agentTypeKey = selectedAgentType?.key;
    const isGeneralDeployLane =
      agentTypeKey !== 'aeon' &&
      agentTypeKey !== 'openclaw' &&
      agentTypeKey !== 'agent-zero' &&
      !isHivraBoxAgentType(agentTypeKey);
    if (!isGeneralDeployLane) return;
    deploySizeDefaultsAppliedRef.current = true;
    let cancelled = false;
    void fetchPlanStrict().then((plan) => {
      if (cancelled || !plan) return;
      if (deploySizeTouchedRef.current) return;
      // Deploy already in flight (or finished) — the payload is sealed.
      if (flowStateRef.current !== 'deploy') return;
      const cpuCap = Math.min(plan.maxCpuPerAgent, plan.poolCpu);
      const ramCapGb = Math.min(plan.maxRamPerAgent, plan.poolRam);
      const cpuChoices = WELCOME_CPU_OPTIONS.filter((option) => option <= cpuCap);
      const ramChoices = WELCOME_RAM_OPTIONS.filter((option) => option <= ramCapGb);
      setDeployCpu(cpuChoices.length ? cpuChoices[cpuChoices.length - 1] : WELCOME_CPU_OPTIONS[0]);
      setDeployRamGb(ramChoices.length ? ramChoices[ramChoices.length - 1] : WELCOME_RAM_OPTIONS[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [flowState, selectedAgentType?.key, selfHosted]);

  // ── Bea pre-selected only after Specialists is deliberately opened ───────
  // The default surface is the real agent catalog. Do not mutate its selected
  // card, provider state, analytics, or localStorage with a hidden specialist.
  // Once the user explicitly opens Specialists, retain the zero-reading Bea
  // default without treating it as a human persona pick.
  const personaPreselectRanRef = useRef(false);
  const handleOpenSpecialists = useCallback(() => {
    if (personaPreselectRanRef.current) return;
    personaPreselectRanRef.current = true;
    if (selectedPersonaId) return;
    if (hasExplicitAgentTypeParam) return;
    // Fresh visits initialize the key to null (no param, nothing stored) — that
    // IS the no-prior-signal case. Only a stored NON-default engine choice
    // (e.g. claude-code picked via the engines disclosure) blocks the default.
    if (selectedAgentTypeKey !== null && selectedAgentTypeKey !== DEFAULT_AGENT_TYPE_KEY) return;
    let storedPersona: string | null = null;
    try {
      storedPersona = window.localStorage.getItem(WELCOME_PERSONA_STORAGE_KEY);
    } catch {
      // best-effort only
    }
    if (storedPersona) return;
    const defaultPersona = WELCOME_PERSONAS.find((persona) => !persona.isCustom);
    if (defaultPersona) handleSelectPersona(defaultPersona, { preselected: true });
  }, [
    handleSelectPersona,
    hasExplicitAgentTypeParam,
    selectedAgentTypeKey,
    selectedPersonaId,
  ]);

  useEffect(() => {
    const match = vaultKeys.find((key) => key.provider === selectedProvider.id) ?? null;
    if (!match || matchedVaultKey?.id === match.id) return;

    setMatchedVaultKey(match);
    setUseVaultKey(true);
    setApiKey('');

    const nextVeniceAccessMode = resolveVeniceAccessModeForProvider(selectedProvider.id, match);
    setVeniceAccessMode(nextVeniceAccessMode);
    if (selectedProvider.id === 'venice' && nextVeniceAccessMode === 'byok') {
      clientLog.warn('Welcome Venice saved vault key selected BYOK mode', {
        source: 'welcome-flow',
        failureType: 'welcome_venice_saved_key_masked_by_managed_mode',
        provider: selectedProvider.id,
        hasMatchedVaultKey: true,
      });
    }
  }, [matchedVaultKey?.id, selectedProvider.id, vaultKeys]);

  // Re-match vault key when the user switches provider in DeployForm.
  const handleProviderSelect = useCallback(
    (p: Provider) => {
      setSelectedProvider(p);
      setModel(p.models[0]?.value ?? '');
      // New provider = new key rules; don't flag the field until the user
      // interacts with it again.
      setApiKeyTouched(false);
      const match = vaultKeys.find((k) => k.provider === p.id) ?? null;
      const nextVeniceAccessMode = resolveVeniceAccessModeForProvider(p.id, match);
      setVeniceAccessMode(nextVeniceAccessMode);
      setMatchedVaultKey(match);
      setUseVaultKey(Boolean(match));
      if (match) setApiKey('');
      if (p.id === 'venice' && nextVeniceAccessMode === 'byok') {
        clientLog.warn('Welcome Venice provider selected BYOK because a vault key exists', {
          source: 'welcome-flow',
          failureType: 'welcome_venice_saved_key_masked_by_managed_mode',
          provider: p.id,
          hasMatchedVaultKey: true,
        });
      }
    },
    [vaultKeys],
  );

  // Snap to the live-discovery default model once it lands.
  useEffect(() => {
    const staticDefault = selectedProvider.models[0]?.value ?? '';
    const liveDefault = modelOptions[0]?.value ?? '';
    if (!liveDefault) return;
    if (!model || model === staticDefault) {
      setModel(liveDefault);
    }
  }, [model, modelOptions, selectedProvider.models]);

  // ── Tier card actions ────────────────────────────────────────────────────
  const handleSelectFree = useCallback(async () => {
    setError(null);
    setCardGateMessage(null);
    setFreeActivationLoading(true);
    try {
      const result = await requestSubscriptionCheckout('free');
      if (result.ok) {
        enterDeploySetup('Free plan activated. Finish setting up your agent below.');
        return;
      }
      if (result.reason === BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION) {
        enterDeploySetup();
        return;
      }
      setError(result.message);
    } catch {
      setError("Couldn't activate the Free plan. Please try again.");
    } finally {
      setFreeActivationLoading(false);
    }
  }, [enterDeploySetup, setError]);

  /**
   * Crypto-holding path - deposit and keep tokens in the user's
   * hermesos_lock wallet. Tier remains active as long as balance ≥
   * threshold. Existing flow, unchanged: routes to the wallet page
   * which shows the deposit address and quote-locking UI.
   */
  const handleSelectDeposit = useCallback(
    (tier: 'pro' | 'power') => {
      captureWelcomeEvent('upgrade_clicked', {
        surface: 'welcome-flow',
        to_plan: tier,
        via: 'token_wallet',
      });
      router.push(`/dashboard/wallet?from=welcome&plan=${tier}`);
    },
    [router],
  );

  /**
   * Card path — fire Stripe Checkout directly for the chosen tier and
   * cadence, no /dashboard/billing detour. The previous version of
   * this handler routed to billing with deep-link params, but billing
   * only pre-selected the cadence toggle and the user still had to
   * click Subscribe again — one wasted click. Now we POST to
   * /api/billing/subscribe inline and `window.location.assign` to the
   * returned Stripe URL.
   *
   * If the user already has an active subscription (server returns
   * ACTIVE_SUBSCRIPTION) we drop them on /dashboard. Other failures
   * surface in the page error banner.
   */
  const handleSelectCard = useCallback(
    async (tier: 'pro' | 'power', cadence: 'monthly' | 'yearly') => {
      setError(null);
      setCardGateMessage(null);
      setCardCheckoutLoadingTier(tier);
      const planKey: PlanKey = tier === 'pro' ? 'operator' : 'fleet';
      captureWelcomeEvent('upgrade_clicked', {
        surface: 'welcome-flow',
        to_plan: planKey,
        via: 'card',
        cadence,
      });
      try {
        const result = await requestSubscriptionCheckout(planKey, cadence);
        if (result.ok) {
          if (result.activated) {
            enterDeploySetup('Plan active. Finish setting up your agent below.');
            setCardCheckoutLoadingTier(null);
            return;
          }

          const navigation = redirectToCheckoutUrl(result.url);
          if (!navigation.ok) {
            setError(navigation.message);
            setCardCheckoutLoadingTier(null);
          }
          return;
        }
        if (result.reason === BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION) {
          router.replace('/dashboard');
          return;
        }
        setError(result.message);
        setCardCheckoutLoadingTier(null);
      } catch {
        setError("Couldn't open secure checkout. Please try again.");
        setCardCheckoutLoadingTier(null);
      }
    },
    [enterDeploySetup, router, setError],
  );

  const handleManagedVeniceDeposit = useCallback(
    async ({ walletType, amountUsd }: { walletType: ManagedVeniceWalletType; amountUsd: number }) => {
      setError(null);
      if (walletType === 'hermesos') {
        setError('Create the $HermesOS quote from the managed Venice credit step.');
        return;
      }

      setManagedVeniceCardCheckoutLoading(true);
      try {
        const result = await requestManagedVeniceCardTopUpCheckout(
          managedVeniceTopUpUsdToMicroUsd(amountUsd)
        );
        if (!result.ok) {
          setError(result.message);
          return;
        }
        if (!('url' in result)) {
          setError('Managed Venice card checkout was already completed. Refresh your wallet to continue.');
          return;
        }

        const navigation = redirectToCheckoutUrl(result.url);
        if (!navigation.ok) {
          setError(navigation.message);
        }
      } catch (cardTopUpError) {
        setError("Couldn't open managed Venice card checkout. Please try again.");
        clientLog.error('Welcome managed Venice card checkout failed', cardTopUpError, {
          source: 'welcome-flow',
          route: '/api/billing/managed-venice/card/top-up',
          failureType: 'managed_venice_card_checkout_failed',
        });
      } finally {
        setManagedVeniceCardCheckoutLoading(false);
      }
    },
    [setError],
  );

  /**
   * Crypto-yearly path — one-time $HermesOS payment grants 365 days
   * of the chosen tier. Routes to /dashboard/billing which opens the
   * yearly-token modal pre-targeted at the right tier.
   */
  const handleSelectCryptoYearly = useCallback(
    (tier: 'pro' | 'power') => {
      captureWelcomeEvent('upgrade_clicked', {
        surface: 'welcome-flow',
        to_plan: tier,
        via: 'token_wallet',
        cadence: 'yearly',
      });
      router.push(
        `/dashboard/billing?plan=${tier}&yearly_token=1&from=welcome`
      );
    },
    [router],
  );

  // ── Deploy ───────────────────────────────────────────────────────────────
  const handleDeploy = useCallback(async () => {
    if (blocksLegacyHandoff) {
      setError('This agent does not support launching on the selected computer yet. Choose another agent or explicitly switch to Hivra Cloud.');
      return;
    }
    if (!agentName.trim()) {
      const repairCopy = 'Name your agent, then try again.';
      setError(repairCopy);
      captureWelcomeEvent('welcome_dead_click_candidate', {
        control: 'deploy_agent',
        reason: 'missing_agent_name',
        provider: selectedProvider.id,
        repairCopy,
      });
      clientLog.warn('Welcome deploy validation blocked', {
        source: 'welcome-flow',
        failureType: 'welcome_deploy_validation_failed',
        reason: 'missing_agent_name',
        provider: selectedProvider.id,
        model,
        managedVenice: selectedProvider.id === 'venice' && veniceAccessMode === 'managed',
        veniceAccessMode,
        useVaultKey,
        hasApiKey: Boolean(apiKey.trim()),
        hasAgentName: false,
        hasMatchedVaultKey: Boolean(matchedVaultKey?.id),
      });
      return;
    }
    // Deploy-card redesign: the top-level "Managed (Venice)?" toggle is the
    // single source of truth. managed → managed-Venice path (unchanged);
    // !managed → BYOK "clean-slate" (no provider/model/key seeded, native
    // onboarding fires on the box). The clean-slate path never collects a key
    // here, so it skips every provider/key validation below.
    const cleanSlateDeploy = !managed;
    const willSendVaultKey = useVaultKey && Boolean(matchedVaultKey?.id);
    // Managed-Venice is the existing flow, gated by the toggle. Keep the
    // provider===venice guard so a managed deploy on a non-Venice provider
    // still follows the unchanged BYOK-with-key path rather than minting a
    // Venice proxy key for the wrong provider. A user with a saved Venice
    // Vault key keeps using it (BYOK-vault) instead of being defaulted into
    // managed credits — so a sent Vault key suppresses the managed path.
    const managedVeniceDeploy =
      managed && selectedProvider.id === 'venice' && !willSendVaultKey;
    // Mirror the createInstance key gate (instance-service.ts) exactly: only
    // a managed-Venice deploy, a sent Vault key, or a Hermes-auth (OAuth)
    // provider may deploy without a key. The previous
    // allowsProviderDeployWithoutApiKey() check also exempted
    // custom_llm/opengateway, which the create path does NOT — those users
    // finished onboarding only to hit the server's 400 at the final step.
    if (!cleanSlateDeploy && !managedVeniceDeploy && !willSendVaultKey && !apiKey.trim()
        && !supportsHermesAuthProvider(selectedProvider.id)) {
      setApiKeyTouched(true);
      setError(PROVIDER_KEY_REQUIRED_MESSAGE);
      captureWelcomeEvent('welcome_dead_click_candidate', {
        control: 'deploy_agent',
        reason: 'missing_provider_api_key',
        provider: selectedProvider.id,
        repairCopy: PROVIDER_KEY_REQUIRED_MESSAGE,
      });
      clientLog.warn('Welcome deploy validation blocked', {
        source: 'welcome-flow',
        failureType: 'welcome_deploy_validation_failed',
        reason: 'missing_provider_api_key',
        provider: selectedProvider.id,
        model,
        managedVenice: managedVeniceDeploy,
        veniceAccessMode,
        useVaultKey,
        hasApiKey: false,
        hasAgentName: true,
        hasMatchedVaultKey: Boolean(matchedVaultKey?.id),
      });
      return;
    }
    // Same shared shape validator the server runs on the submitted key
    // (eg "OpenRouter API keys must start with sk-or-.").
    const keyShapeFailure =
      !cleanSlateDeploy && !managedVeniceDeploy && !willSendVaultKey && apiKey.trim()
        ? validateProviderKeyShape(selectedProvider.id, apiKey)
        : null;
    if (keyShapeFailure) {
      setApiKeyTouched(true);
      setError(keyShapeFailure.message);
      captureWelcomeEvent('welcome_dead_click_candidate', {
        control: 'deploy_agent',
        reason: keyShapeFailure.failureType,
        provider: selectedProvider.id,
        repairCopy: keyShapeFailure.message,
      });
      clientLog.warn('Welcome deploy validation blocked', {
        source: 'welcome-flow',
        failureType: 'welcome_deploy_validation_failed',
        reason: keyShapeFailure.failureType,
        provider: selectedProvider.id,
        model,
        managedVenice: managedVeniceDeploy,
        veniceAccessMode,
        useVaultKey,
        hasApiKey: true,
        hasAgentName: true,
        hasMatchedVaultKey: Boolean(matchedVaultKey?.id),
      });
      return;
    }

    // Key-shape preflight (e.g. OpenRouter keys must start with sk-or-).
    // Previously this only surfaced server-side after a full deploy attempt.
    if (!cleanSlateDeploy && !managedVeniceDeploy && !willSendVaultKey && apiKey.trim()) {
      const keyShapeFailure = validateProviderKeyShape(selectedProvider.id, apiKey);
      if (keyShapeFailure) {
        const repairCopy = `${keyShapeFailure.message} Double-check the key you pasted, then try again.`;
        setError(repairCopy);
        captureWelcomeEvent('welcome_dead_click_candidate', {
          control: 'deploy_agent',
          reason: 'provider_key_invalid_shape',
          provider: selectedProvider.id,
          repairCopy,
        });
        clientLog.warn('Welcome deploy validation blocked', {
          source: 'welcome-flow',
          failureType: 'welcome_deploy_validation_failed',
          reason: 'provider_key_invalid_shape',
          provider: selectedProvider.id,
          model,
          managedVenice: managedVeniceDeploy,
          veniceAccessMode,
          useVaultKey,
          hasApiKey: true,
          hasAgentName: true,
          hasMatchedVaultKey: Boolean(matchedVaultKey?.id),
        });
        return;
      }
    }

    setDeploying(true);
    setFlowState('deploying');
    setError(null);
    setCardGateMessage(null);

    try {
      // Deploy-card redesign: the box-size picker is the source of truth for
      // the new agent's footprint. cpuLimit is in cores; ramLimit in MB.
      const cpuLimit = deployCpu;
      const ramLimit = deployRamGb * 1024;

      // Best-effort vault save for any manually entered key, so subsequent
      // deploys auto-match. Failure is non-critical — fall back to raw key.
      let resolvedVaultKeyId: string | undefined = useVaultKey ? matchedVaultKey?.id : undefined;
      if (!cleanSlateDeploy && !managedVeniceDeploy && !useVaultKey && apiKey.trim()) {
        try {
          const saveRes = await fetch('/api/vault', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: selectedProvider.name,
              provider: selectedProvider.id,
              key: apiKey.trim(),
            }),
          });
          const saveData = await saveRes.json().catch(() => null);
          if (saveData?.success && saveData?.data?.id) {
            resolvedVaultKeyId = saveData.data.id;
          }
        } catch {
          // non-critical
        }
      }

      let resolvedHonchoVaultKeyId: string | undefined = useHonchoVaultKey
        ? matchedHonchoVaultKey?.id
        : undefined;
      if (!useHonchoVaultKey && honchoApiKey.trim()) {
        try {
          const hSaveRes = await fetch('/api/vault', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'Honcho',
              provider: 'honcho',
              key: honchoApiKey.trim(),
            }),
          });
          const hSaveData = await hSaveRes.json().catch(() => null);
          if (hSaveData?.success && hSaveData?.data?.id) {
            resolvedHonchoVaultKeyId = hSaveData.data.id;
          }
        } catch {
          // non-critical
        }
      }

      const agentSettings = buildWelcomeAgentSettings({
        // Clean-slate leaves the agent unconfigured: no provider/model/baseUrl
        // is seeded so the box boots with nothing and its native onboarding
        // overlay fires. (The server also skips seeding when unconfigured.)
        providerId: cleanSlateDeploy ? '' : selectedProvider.id,
        model: cleanSlateDeploy ? '' : model,
        customBaseUrl: cleanSlateDeploy
          ? ''
          : managedVeniceDeploy
            ? getManagedVeniceProxyBaseUrl()
            : customBaseUrl,
        systemPrompt: hasWelcomePersonalization(personalizationDraftRef.current)
          ? buildHermesWelcomeSystemPrompt({
              agentName: agentName.trim(),
              basePrompt: selectedAgentType?.systemPrompt,
              draft: personalizationDraftRef.current,
            })
          : selectedAgentType?.systemPrompt,
        runtimeMode: 'managed',
        // Privileged VM/Docker control is an explicit opt-in in Advanced Cloud
        // Access. New agents start in the managed, non-root posture.
        enableRootAccess: false,
        webUseGateway: false,
        imageGenUseGateway: false,
        ttsUseGateway: false,
        browserUseGateway: false,
      });

      const aiPeer = agentName
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .toLowerCase();
      const fingerprintRequestId = await getFingerprintRequestId();

      captureWelcomeEvent('activation_instance_requested', {
        provider: selectedProvider.id,
        model,
        agentType: selectedAgentType?.key ?? DEFAULT_AGENT_TYPE_KEY,
        persona: selectedPersonaId ?? null,
        soulPromptId: personalizationDraftRef.current.soulPromptId ?? null,
        managedVenice: managedVeniceDeploy,
        managedVeniceWalletType: managedVeniceDeploy ? managedVeniceWalletType : undefined,
        veniceAccessMode: resolveVeniceAccessModeForProvider(selectedProvider.id, matchedVaultKey),
        useVaultKey: Boolean(resolvedVaultKeyId),
        hasHonchoKey: Boolean(resolvedHonchoVaultKeyId || honchoApiKey.trim()),
      });

      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: agentName.trim(),
          // Clean-slate (Managed=OFF) deploys with NO inference provider, model,
          // or key. We omit provider/model/apiKey entirely and flag
          // `unconfigured: true`; the server leaves instance.provider at its
          // benign default ("openrouter") so redeploy/PROVIDER_ID_MAP lookups
          // never throw, but seeds nothing — the box's native onboarding fires.
          ...(cleanSlateDeploy
            ? { unconfigured: true }
            : {
                provider: selectedProvider.id,
                model,
                ...(managedVeniceDeploy
                  ? { apiKey: '' }
                  : resolvedVaultKeyId
                    ? { vaultKeyId: resolvedVaultKeyId }
                    : apiKey.trim()
                      ? { apiKey: apiKey.trim() }
                      : {}),
                ...(managedVeniceDeploy
                  ? {
                      managedVenice: {
                        enabled: true,
                        walletType: managedVeniceWalletType,
                      },
                    }
                  : {}),
              }),
          honcho: {
            enabled: true,
            peerName: 'user',
            aiPeer,
            memoryMode: 'hybrid',
            recallMode: 'hybrid',
            ...(!resolvedHonchoVaultKeyId && honchoApiKey.trim()
              ? { apiKey: honchoApiKey.trim() }
              : {}),
          },
          ...(resolvedHonchoVaultKeyId ? { honchoVaultKeyId: resolvedHonchoVaultKeyId } : {}),
          ...(fingerprintRequestId ? { fingerprintRequestId } : {}),
          agentSettings,
          cpuLimit,
          ramLimit,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.success) {
        if (isCardRequiredResponse(data)) {
          captureWelcomeEvent('activation_card_required', {
            provider: selectedProvider.id,
            agentType: selectedAgentType?.key ?? DEFAULT_AGENT_TYPE_KEY,
          });
          // The card-required gate is a paywall moment of its own — the
          // FreeTierCardVerification modal opens right below via
          // setCardGateMessage.
          captureWelcomeEvent('paywall_viewed', {
            surface: 'welcome-flow',
            paywall: 'card_required',
          });
          deployFailureStreakRef.current = 0;
          setCardGateMessage(getCardRequiredMessage(data));
          setDeploying(false);
          setFlowState('deploy');
          return;
        }
        // The synchronous provision can report failure to the client while the
        // VM was actually created and is booting (cold-host edge timeout, or a
        // non-fatal post-provision step). Route to the boot screen if the row
        // exists before surfacing a misleading "Deployment failed".
        const recovered = await findJustCreatedInstance(agentName);
        if (recovered) {
          try {
            await applyHermesWelcomePersonalization(recovered.id);
          } catch (personalizationError) {
            clientLog.warn('Welcome personalization save failed for recovered instance', {
              source: 'welcome-flow',
              failureType: 'welcome_personalization_save_failed',
              instanceId: recovered.id,
              provider: selectedProvider.id,
            }, personalizationError);
          }
          captureWelcomeEvent('activation_instance_ready', {
            provider: selectedProvider.id,
            hasInstanceId: Boolean(recovered.id),
            outcome: 'recovered_existing_instance',
            persona: selectedPersonaId ?? null,
            soulPromptId: personalizationDraftRef.current.soulPromptId ?? null,
          });
          router.push(
            buildPostDeployDestination({
              instanceId: recovered.id,
              providerId: selectedProvider.id,
              webUseGateway: false,
              imageGenUseGateway: false,
              ttsUseGateway: false,
              browserUseGateway: false,
              welcome: true,
            }),
          );
          return;
        }
        throw new DeployRequestError(getApiErrorMessage(data, 'Deployment failed'), {
          status: res.status,
          serverFailureType: typeof data?.failureType === 'string' ? data.failureType : undefined,
          errorCode: typeof data?.code === 'string' ? data.code : undefined,
          existingInstanceId:
            typeof data?.existingInstanceId === 'string' ? data.existingInstanceId : undefined,
        });
      }
      deployFailureStreakRef.current = 0;
      // Clean success — land a brief "your agent is live" celebration on the
      // same provisioning surface, then route (auto or via the button). The
      // 2-4 min wait finally pays off instead of a silent redirect.
      try {
        await applyHermesWelcomePersonalization(data.data.id);
      } catch (personalizationError) {
        clientLog.warn('Welcome personalization save failed for created instance', {
          source: 'welcome-flow',
          failureType: 'welcome_personalization_save_failed',
          instanceId: data.data.id,
          provider: selectedProvider.id,
        }, personalizationError);
      }
      setDeployedInfo({
        name: agentName.trim(),
        emoji: personalizationDraftRef.current.emoji ?? null,
        instanceId: data.data.id,
        destination: buildPostDeployDestination({
          instanceId: data.data.id,
          providerId: selectedProvider.id,
          webUseGateway: false,
          imageGenUseGateway: false,
          ttsUseGateway: false,
          browserUseGateway: false,
          welcome: true,
        }),
        cpu: cpuLimit,
        ramMb: ramLimit,
        engineName: selectedAgentType?.name ?? null,
      });
      captureWelcomeEvent('activation_instance_ready', {
        provider: selectedProvider.id,
        hasInstanceId: Boolean(data.data.id),
        outcome: 'created_instance',
        persona: selectedPersonaId ?? null,
        soulPromptId: personalizationDraftRef.current.soulPromptId ?? null,
      });
    } catch (e: unknown) {
      clientLog.error('Welcome deploy failed', e, {
        source: 'welcome-flow',
        provider: selectedProvider.id,
        managedVenice: selectedProvider.id === 'venice' && veniceAccessMode === 'managed',
        managedVeniceWalletType,
        useVaultKey,
        hasApiKey: Boolean(apiKey.trim()),
        hasHonchoKey: Boolean(honchoApiKey.trim()),
      });
      // A thrown error here is often a client/edge timeout on the synchronous
      // provision while the server actually created the VM. Check for the row
      // before showing failure — route to the boot screen if it's really there.
      const recovered = await findJustCreatedInstance(agentName);
      if (recovered) {
        try {
          await applyHermesWelcomePersonalization(recovered.id);
        } catch (personalizationError) {
          clientLog.warn('Welcome personalization save failed for fallback instance', {
            source: 'welcome-flow',
            failureType: 'welcome_personalization_save_failed',
            instanceId: recovered.id,
            provider: selectedProvider.id,
          }, personalizationError);
        }
        captureWelcomeEvent('activation_instance_ready', {
          provider: selectedProvider.id,
          hasInstanceId: Boolean(recovered.id),
          outcome: 'recovered_existing_instance',
          persona: selectedPersonaId ?? null,
          soulPromptId: personalizationDraftRef.current.soulPromptId ?? null,
        });
        router.push(
          buildPostDeployDestination({
            instanceId: recovered.id,
            providerId: selectedProvider.id,
            webUseGateway: false,
            imageGenUseGateway: false,
            ttsUseGateway: false,
            browserUseGateway: false,
            welcome: true,
          }),
        );
        return;
      }
      let failureInsight = buildWelcomeErrorInsight(e, 'Deployment failed. Please try again.');
      // One-base-agent limit: ~40% of the users hitting this 403 already HAD
      // a usable (live or restorable) agent — the upgrade wall was a dead end.
      // Attach the existing instance so the banner leads with Open/Restore.
      if (
        e instanceof DeployRequestError &&
        e.errorCode === 'FREE_INSTANCE_LIMIT_REACHED' &&
        e.existingInstanceId
      ) {
        failureInsight = {
          ...failureInsight,
          // Pin the category/CTA flags off the machine-readable code, not the
          // message text, so a copy tweak server-side can't hide the actions.
          category: 'plan_limit',
          showPlanActions: true,
          existingInstance: {
            id: e.existingInstanceId,
            restorable: await readExistingInstanceRestorable(e.existingInstanceId),
          },
        };
        // Moment #4: the free 1-agent cap was hit trying to launch a 2nd agent.
        // Fire the funnel's paywall-reach event unconditionally (measurement,
        // independent of the copy flag) — the RAM-cap / inactivity paths on the
        // instance page fire the same free_limit_hit event.
        captureWelcomeEvent('free_limit_hit', {
          surface: 'second_agent',
          limit_type: 'agents',
          existing_instance_id: e.existingInstanceId,
          from_plan: 'free',
          to_plan: 'operator',
        });
      }
      const requestStatus = e instanceof DeployRequestError ? e.status ?? null : null;
      const serverFailureType =
        e instanceof DeployRequestError ? e.serverFailureType ?? null : null;
      captureWelcomeEvent('activation_failed', {
        provider: selectedProvider.id,
        agentType: selectedAgentType?.key ?? DEFAULT_AGENT_TYPE_KEY,
        stage: 'create_instance',
        managedVenice: selectedProvider.id === 'venice' && veniceAccessMode === 'managed',
        managedVeniceWalletType,
        useVaultKey,
        failureType: 'deploy_failed_no_recoverable_instance',
        errorCategory: failureInsight.category,
        errorMessage: sanitizeWelcomeErrorMessage(e) || 'Deployment failed',
        // Server-provided machine context (fix/placement-resilience adds
        // failureType to the 500 body) — lets PostHog split infra failovers
        // from user-input rejections without parsing messages.
        status: requestStatus,
        serverFailureType,
        recoverable: failureInsight.retryable,
      });
      // Users blind-retried failed provisions 5-8x, each a full ~100s
      // provision+rollback. After two straight capacity-class failures the
      // Deploy button cools down for 60s.
      deployFailureStreakRef.current += 1;
      if (failureInsight.category === 'capacity' && deployFailureStreakRef.current >= 2) {
        setDeployRetryBlockedUntilMs(Date.now() + DEPLOY_RETRY_COOLDOWN_MS);
      }
      setDeployError(failureInsight);
      setDeploying(false);
      setFlowState('deploy');
    }
  }, [
    agentName,
    blocksLegacyHandoff,
    apiKey,
    customBaseUrl,
    honchoApiKey,
    matchedHonchoVaultKey,
    matchedVaultKey,
    model,
    applyHermesWelcomePersonalization,
    router,
    selectedAgentType,
    selectedProvider,
    setDeployError,
    setError,
    veniceAccessMode,
    managedVeniceWalletType,
    useHonchoVaultKey,
    useVaultKey,
    setFlowState,
    // Deploy-card redesign: box size + the Managed (Venice)? toggle.
    managed,
    deployCpu,
    deployRamGb,
    selectedPersonaId,
  ]);

  // ── Render: terminal states ──────────────────────────────────────────────
  if (flowState === 'loading') {
    return (
      <div style={STYLES.loadingContainer}>
        <Loader2 size={24} style={{ opacity: 0.3, animation: 'spin 1s linear infinite' }} />
        <p
          className="mono"
          style={{
            marginTop: 16,
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.2em',
            opacity: 0.4,
          }}
        >
          {subscriptionSuccess ? 'Activating your plan…' : 'Loading…'}
        </p>
      </div>
    );
  }

  if (flowState === 'sync-pending') {
    return (
      <div
        style={{
          ...STYLES.loadingContainer,
          flexDirection: 'column',
          gap: 16,
          textAlign: 'center',
          padding: '2rem',
        }}
      >
        <CheckCircle size={32} style={{ opacity: 0.4 }} />
        <p
          className="mono"
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
            opacity: 0.7,
            maxWidth: 320,
          }}
        >
          Payment confirmed — still syncing your subscription
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 360, lineHeight: 1.6 }}>
          This can take a few seconds. Click below to check again.
        </p>
        <button
          onClick={() => {
            setFlowState('loading');
            window.location.reload();
          }}
          className="action-button"
          style={{ padding: '12px 28px', fontSize: 11, letterSpacing: '0.12em', cursor: 'pointer' }}
        >
          Refresh &amp; Continue
        </button>
      </div>
    );
  }

  if (flowState === 'deploying') {
    if (deployedInfo) {
      return (
        <DeployedCelebration
          agentName={deployedInfo.name}
          emoji={deployedInfo.emoji}
          instanceId={deployedInfo.instanceId}
          cpu={deployedInfo.cpu}
          ramMb={deployedInfo.ramMb}
          engineName={deployedInfo.engineName}
          onContinue={() => router.push(deployedInfo.destination)}
          onConnectTelegram={() =>
            router.push(
              `${deployedInfo.destination}${deployedInfo.destination.includes("?") ? "&" : "?"}connect=telegram`,
            )
          }
        />
      );
    }
    return <DeployingState agentName={agentName} />;
  }

  // ── Render: plan + deploy share the wrapped page chrome ──────────────────
  // The general deploy card shows notices directly above its Deploy button;
  // the other lanes render their own launch errors inline.
  const deployFormActive =
    flowState === 'deploy' &&
    selectedAgentType?.key !== 'aeon' &&
    selectedAgentType?.key !== 'openclaw' &&
    selectedAgentType?.key !== 'agent-zero' &&
    !isHivraBoxAgentType(selectedAgentType?.key) &&
    !blocksLegacyHandoff;
  const errorNotice = error ? (
    <div ref={errorNoticeRef} role="alert" style={STYLES.errorBanner}>
      <AlertTriangle size={16} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-black)' }}>{error}</span>
        {errorInsight && shouldRenderWelcomeErrorDetail(errorInsight, 'managed') && (
          <span className="mono" style={{ fontSize: 10.5, lineHeight: 1.5, opacity: 0.55 }}>
            {errorInsight.detail}
          </span>
        )}
        {errorInsight?.showPlanActions && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {/* One-base-agent limit: the user already HAS an agent —
                lead with opening (or restoring) it. The instance page
                owns the actual restore control; we just route there.
                Upgrade drops to the secondary slot. */}
            {errorInsight.existingInstance ? (
              <>
                <button
                  type="button"
                  data-testid="welcome-open-existing-agent"
                  onClick={() =>
                    router.push(`/dashboard/instances/${errorInsight.existingInstance!.id}`)
                  }
                  className="mono"
                  style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}
                >
                  {errorInsight.existingInstance.restorable
                    ? 'Restore your agent'
                    : 'Open your agent'}
                </button>
                <button
                  type="button"
                  data-testid="welcome-second-agent-upgrade"
                  onClick={() => {
                    // Moment #4: when the flag is ON, open the shared
                    // upgrade paywall (second-agent pitch) instead of a bare
                    // billing redirect. Flag OFF keeps the existing route so
                    // the #520 Open/Restore primary CTA is never regressed.
                    if (isSecondAgentUpgradeEnabled()) {
                      setSecondAgentPaywallOpen(true);
                      return;
                    }
                    router.push('/dashboard/billing?from=welcome');
                  }}
                  className="mono"
                  style={WELCOME_ERROR_ACTION_SECONDARY_STYLE}
                >
                  Upgrade plan
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => router.push('/dashboard/billing?from=welcome')}
                  className="mono"
                  style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}
                >
                  Upgrade plan
                </button>
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="mono"
                  style={WELCOME_ERROR_ACTION_SECONDARY_STYLE}
                >
                  Manage agents
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <div ref={pageTopRef} style={STYLES.pageContainer}>
        <style>{`
          .glass-card {
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border-radius: 0;
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease;
          }
          .premium-btn {
            transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;
            border-radius: 0;
          }
          @media (hover: hover) and (pointer: fine) {
            .premium-btn:not(:disabled):hover {
              transform: translateY(-2px);
              box-shadow: 0 10px 20px rgba(0,0,0,0.1);
              background: color-mix(in srgb, var(--ink-black) 85%, transparent);
            }
          }
          .premium-btn:not(:disabled):active {
            transform: translateY(0);
          }
          @keyframes subtlePulse {
            0% { box-shadow: 0 0 0 0 rgba(255, 44, 45, 0.4); }
            70% { box-shadow: 0 0 0 10px rgba(255, 44, 45, 0); }
            100% { box-shadow: 0 0 0 0 rgba(255, 44, 45, 0); }
          }
          .premium-btn-primary:not(:disabled) {
            animation: subtlePulse 2.5s infinite cubic-bezier(0.66, 0, 0, 1);
          }
          @keyframes shimmerText {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          @keyframes blurReveal {
            0% { filter: blur(8px); opacity: 0; transform: translateY(6px); }
            100% { filter: blur(0px); opacity: 1; transform: translateY(0px); }
          }
          .text-gradient {
            background: linear-gradient(135deg, var(--ink-black) 20%, var(--gold-leaf) 50%, var(--ink-black) 80%);
            background-size: 200% auto;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            animation: blurReveal 1.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards, shimmerText 6s ease-in-out infinite;
            padding-bottom: 0.1em;
            line-height: 1.1;
          }
          .heavy-glass-card {
            border: 1px solid color-mix(in srgb, var(--ink-black) 10%, transparent);
            background: color-mix(in srgb, var(--bg-surface) 75%, transparent);
            border-radius: 0;
            box-shadow: 0 16px 40px rgba(0,0,0,0.04);
            backdrop-filter: blur(30px);
            -webkit-backdrop-filter: blur(30px);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease, border-color 0.3s ease;
          }
          @media (hover: hover) and (pointer: fine) {
            .heavy-glass-card:hover {
              transform: translateY(-2px);
              box-shadow: 0 24px 48px rgba(0,0,0,0.08);
              border-color: color-mix(in srgb, var(--ink-black) 18%, transparent);
            }
          }
          .sub-glass-card {
            border: 1px solid color-mix(in srgb, var(--ink-black) 6%, transparent);
            background: color-mix(in srgb, var(--bg-surface) 40%, transparent);
            border-radius: 0;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease, border-color 0.3s ease;
            box-shadow: 0 8px 24px rgba(0,0,0,0.02);
            cursor: pointer;
          }
          @media (hover: hover) and (pointer: fine) {
            .sub-glass-card:hover {
              transform: translateY(-4px);
              box-shadow: 0 16px 32px rgba(0,0,0,0.06);
              border-color: color-mix(in srgb, var(--ink-black) 14%, transparent);
            }
          }
          .provider-button {
            border-radius: 0;
          }
          @media (hover: hover) and (pointer: fine) {
            .provider-button:hover {
              background: color-mix(in srgb, var(--ink-black) 4%, transparent) !important;
            }
          }
          /* CPU/RAM pickers: below 768px the options share the row beside
             their label (40px floor) so five fit at 360px; under 360px the
             label takes its own line. */
          .welcome-size-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
          .welcome-size-label { width: 54px; display: inline-flex; align-items: center; gap: 5px; }
          .welcome-size-option { min-width: 44px; padding: 8px 12px; }
          @media (max-width: 767px) {
            .welcome-size-row { flex-wrap: nowrap; gap: 4px; }
            .welcome-size-label { flex: 0 0 54px; }
            .welcome-size-option { flex: 1 1 0; min-width: 40px; max-width: 64px; padding: 8px 0; }
          }
          @media (max-width: 359px) {
            .welcome-size-row { flex-wrap: wrap; }
            .welcome-size-label { flex-basis: 100%; }
          }
          /* Specialists: the only Continue sits below every card, so phones
             and touch tablets get a sticky copy of it at the bottom of the step. */
          .welcome-persona-sticky { display: none; }
          @media ${WELCOME_TOUCH_COMPACT_QUERY} {
            .welcome-persona-sticky {
              display: block;
              position: sticky;
              bottom: 0;
              z-index: 5;
              padding: 8px 0;
              background: var(--vellum-bg);
            }
          }
          /* From 768px there is no bottom bar reserving the home-indicator inset. */
          @media (min-width: 768px) and (max-width: 1023px) and (pointer: coarse) {
            .welcome-persona-sticky { padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
          }
        `}</style>

        {fromLaunch && (
          <Link
            href="/dashboard/launch"
            className="mono"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minHeight: 44,
              padding: '0 12px',
              marginBottom: '1rem',
              border: '1px solid var(--etched-border)',
              color: 'var(--text-secondary)',
              textDecoration: 'none',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            <ArrowLeft size={13} aria-hidden="true" /> Launch
          </Link>
        )}

        <AnimateIn>
          <header ref={headerRef} style={STYLES.header}>
            <div style={STYLES.headerBadge}>
              <span style={STYLES.headerBadgeDot} />
              <span className="mono" style={STYLES.headerBadgeText}>
                {flowState === 'agent-type'
                ? 'Agent Type'
                : flowState === 'plan'
                  ? 'Plan Path'
                  : 'Launch'}
              </span>
            </div>
            <h1 className="serif text-gradient" style={STYLES.headerTitle}>
              {/* Each branch is a single keyed <span> (not a bare fragment) so a
                  step change swaps ONE element node. Third-party DOM mutators
                  (Google Translate, some extensions) replace loose text nodes
                  with <font> wrappers; when React then removes/inserts loose
                  text siblings it throws NotFoundError (removeChild/insertBefore)
                  and trips the dashboard error boundary. */}
              {flowState === 'agent-type' ? (
                <span key="agent-type">
                  Choose Your <em>Agent</em>.
                </span>
              ) : flowState === 'plan' ? (
                <span key="plan">
                  Choose the <em>path</em> for {selectedAgentType?.name ?? 'your agent'}.
                </span>
              ) : (
                <span key="deploy">
                  Deploy <em style={{ fontStyle: 'normal' }}>{selectedAgentType?.name ?? 'Your Agent'}</em>.
                </span>
              )}
            </h1>
            <p style={STYLES.headerSubtitle}>
              {flowState === 'agent-type'
                ? 'Pick the agent software to run — Claude Code, Codex, OpenClaw, Agent Zero or a plain Hermes agent — or a specialist that starts pre-shaped and can still be renamed and retuned.'
                : flowState === 'plan'
                  ? 'Choose Card or $HermesOS, then finish the deploy.'
                  : `${selectedAgentType?.tagline ?? "Name your agent, connect your AI provider, and you're live."}`}
            </p>
          </header>
        </AnimateIn>

        {successMsg && (
          <div style={STYLES.successBanner}>
            <CheckCircle size={16} style={{ color: '#16a34a', flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-black)' }}>
              {successMsg}
            </span>
          </div>
        )}

        {!deployFormActive && errorNotice}

        {(launchTemplate || launchTemplateError) && (flowState === 'agent-type' || launchTemplateActive) && (
          <div
            data-testid="welcome-launch-template"
            role={launchTemplateError ? 'alert' : 'status'}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              border: '1px solid var(--etched-border)',
              background: 'var(--bg-surface)',
              padding: '12px 14px',
              marginBottom: '1.5rem',
            }}
          >
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800, opacity: 0.6 }}>
                {launchTemplateError ? 'Template unavailable' : 'Launching from template'}
              </span>
              <span style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--ink-black)', overflowWrap: 'anywhere' }}>
                {launchTemplateError ?? (
                  <>
                    {launchTemplate?.emoji ? `${launchTemplate.emoji} ` : ''}<strong>{launchTemplateName}</strong>
                    {launchTemplateAgentType
                      ? ` · ${launchTemplateAgentType.name}`
                      : '. This template’s agent can’t be launched from this flow yet.'}
                  </>
                )}
              </span>
            </div>
            {flowState === 'agent-type' && launchTemplateAgentType && (
              <button
                type="button"
                onClick={handleUseLaunchTemplate}
                className="mono"
                style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}
              >
                Use this template
              </button>
            )}
          </div>
        )}

        <FreeTierCardVerification
          open={Boolean(cardGateMessage)}
          message={cardGateMessage}
          onClose={() => setCardGateMessage(null)}
          onVerified={handleDeploy}
        />

        {/* Moment #4: second-agent upgrade paywall. Its Upgrade CTA fires
            upgrade_clicked with surface:'second_agent' and deep-links to billing. */}
        {secondAgentPaywallOpen && (
          <UpgradePaywallModal
            feature="agents"
            surface="second_agent"
            currentPlan="free"
            onClose={() => setSecondAgentPaywallOpen(false)}
          />
        )}

        {flowState === 'agent-type' && (
          <PersonaPicker
            personas={WELCOME_PERSONAS}
            selectedPersonaId={selectedPersonaId}
            canDeploy={canDeploy || Boolean(targetHandoff)}
            onSelectPersona={handleSelectPersona}
            onContinue={handleContinueFromPersona}
            advancedAgentTypes={WELCOME_AGENT_TYPES}
            selectedAgentTypeKey={selectedAgentTypeKey}
            onSelectAdvancedAgent={handleSelectAdvancedAgent}
            onOpenSpecialists={handleOpenSpecialists}
            personalizationDraft={personalizationDraft}
            setPersonalizationDraft={setPersonalizationDraft}
            agentName={agentName}
            setAgentName={setAgentName}
            customPersonaName={customPersonaName}
            setCustomPersonaName={setCustomPersonaName}
            customPersonaExpertise={customPersonaExpertise}
            setCustomPersonaExpertise={setCustomPersonaExpertise}
            customPersonaEmoji={customPersonaEmoji}
            setCustomPersonaEmoji={setCustomPersonaEmoji}
          />
        )}

        {flowState === 'plan' && (
          <TierPickerCards
            tiers={TIERS}
            onSelectFree={handleSelectFree}
            onDeposit={handleSelectDeposit}
            onSelectCard={handleSelectCard}
            onSelectCryptoYearly={handleSelectCryptoYearly}
            paidPathChoice={paidPathChoice}
            setPaidPathChoice={setPaidPathChoice}
            cardCadence={cardCadence}
            setCardCadence={setCardCadence}
            cryptoMode={cryptoMode}
            setCryptoMode={setCryptoMode}
            cardCheckoutLoadingTier={cardCheckoutLoadingTier}
            freeActivationLoading={freeActivationLoading}
          />
        )}

        {flowState === 'deploy' && (
          (selectedAgentType?.key === 'aeon' || selectedAgentType?.key === 'openclaw' || selectedAgentType?.key === 'agent-zero') ? (
            <DashboardAgentLaunchForm
              targetHandoff={targetHandoff}
              welcomeType={selectedAgentType}
              agentName={agentName}
              setAgentName={setAgentName}
              managedLaunchEntitled={canDeploy}
              onChooseManagedPlan={() => setFlowState('plan')}
              onBackToAgentChoices={() => {
                setSuccessMsg(null);
                setFlowState('agent-type');
              }}
              templateId={launchTemplateActive ? launchTemplate?.id ?? null : null}
            />
          ) : isHivraBoxAgentType(selectedAgentType?.key) ? (
            <HivraBoxWelcomeLaunchForm
              targetHandoff={targetHandoff}
              welcomeType={selectedAgentType!}
              agentName={agentName}
              setAgentName={setAgentName}
              onAgentCreated={applyHivraWelcomePersonalization}
              managedLaunchEntitled={canDeploy}
              onChooseManagedPlan={() => setFlowState('plan')}
              onBackToAgentChoices={() => {
                setSuccessMsg(null);
                setFlowState('agent-type');
              }}
              personaId={selectedPersonaId}
              soulPromptId={personalizationDraft.soulPromptId ?? null}
              templateId={launchTemplateActive ? launchTemplate?.id ?? null : null}
            />
          ) : blocksLegacyHandoff ? (
            <section style={STYLES.deployCard} aria-label="Selected computer compatibility">
              <div role="alert">
                <h2>This agent needs a different launch path</h2>
                <p>The selected computer is preserved. {selectedAgentType?.name ?? 'This agent'} does not support this portable launch flow yet.</p>
                <p>Choose a compatible agent, or explicitly switch this launch to your Hivra Cloud plan.</p>
              </div>
              <button type="button" style={STYLES.primaryButton} onClick={() => setFlowState('agent-type')}>Choose another agent</button>
              <button type="button" style={{ ...STYLES.primaryButton, marginTop: 12, background: 'transparent', color: 'var(--ink-black)' }} onClick={() => {
                setManagedHandoffOverride(targetHandoff!.key);
                if (!canDeploy) setFlowState('plan');
              }}>Use Hivra Cloud for this agent</button>
            </section>
          ) : (
            <DeployForm
              agentName={agentName}
              setAgentName={setAgentName}
              // Deploy-card redesign: top-level "Managed (Venice)?" toggle +
              // box-size picker. Managed=OFF hides the provider/model/key UI and
              // deploys a clean-slate (unconfigured) box.
              managed={managed}
              setManaged={setManaged}
              cpuOptions={WELCOME_CPU_OPTIONS}
              ramOptions={WELCOME_RAM_OPTIONS}
              cpu={deployCpu}
              setCpu={setDeployCpuTouched}
              ramGb={deployRamGb}
              setRamGb={setDeployRamGbTouched}
              selectedProvider={selectedProvider}
              handleProviderSelect={handleProviderSelect}
              // Codex on the Hermes lane requires a reusable Vault OAuth
              // session — a typed key is rejected server-side, and the welcome
              // flow has no inline OAuth connect step. Hide it here unless a
              // Codex session already exists; users can connect ChatGPT from
              // the agent page after deploy.
              PROVIDERS={PROVIDERS.filter(
                (p) => p.id !== 'codex' || vaultKeys.some((k) => k.provider === 'codex'),
              )}
              model={model}
              setModel={setModel}
              modelOptions={modelOptions}
              hasLiveModels={hasLiveModels}
              isLoadingLiveModels={isLoadingLiveModels}
              liveModelsError={liveModelsError ?? ''}
              apiKey={apiKey}
              setApiKey={setApiKey}
              apiKeyError={apiKeyTouched ? providerKeyInlineError : null}
              onApiKeyBlur={() => setApiKeyTouched(true)}
              customBaseUrl={customBaseUrl}
              setCustomBaseUrl={setCustomBaseUrl}
              useVaultKey={useVaultKey}
              setUseVaultKey={setUseVaultKey}
              matchedVaultKey={matchedVaultKey}
              honchoApiKey={honchoApiKey}
              setHonchoApiKey={setHonchoApiKey}
              useHonchoVaultKey={useHonchoVaultKey}
              setUseHonchoVaultKey={setUseHonchoVaultKey}
              matchedHonchoVaultKey={matchedHonchoVaultKey}
              deploying={deploying || managedVeniceCardCheckoutLoading}
              handleDeploy={handleDeploy}
              managedVeniceWalletType={managedVeniceWalletType}
              setManagedVeniceWalletType={setManagedVeniceWalletType}
              managedVeniceAvailableMicroUsd={managedVeniceAvailableMicroUsd}
              managedVeniceBalanceLoading={managedVeniceSummaryLoading}
              managedVeniceBalanceUnknown={managedVeniceSummaryFailed}
              retryBlockedUntilMs={deployRetryBlockedUntilMs}
              onManagedVeniceSummaryRefresh={refreshManagedVeniceSummary}
              onManagedVeniceDeposit={handleManagedVeniceDeposit}
              agentSpecialization={selectedAgentType ? {
                name: selectedAgentType.name,
                recommendedTier: selectedAgentType.recommendedTier,
                ...selectedAgentType.deployCard,
              } : null}
              onChangeAgentType={() => {
                setSuccessMsg(null);
                setFlowState('agent-type');
              }}
              deployAlert={errorNotice}
            />
          )
        )}
      </div>
    </>
  );
}

function ManagedCloudPlanGate({
  visible,
  onChoosePlan,
}: {
  visible: boolean;
  onChoosePlan: () => void;
}) {
  if (!visible) return null;
  return (
    <div
      role="status"
      style={{
        border: '1px solid var(--etched-border)',
        background: 'rgba(255,255,255,0.025)',
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55 }}>
        Hivra Cloud needs an active managed plan. You can use a ready host you
        control without buying Hivra Cloud capacity.
      </span>
      <button
        type="button"
        className="mono"
        onClick={onChoosePlan}
        style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}
      >
        Choose Hivra Cloud plan
      </button>
    </div>
  );
}

type HivraBoxLaunchProps = {
  targetHandoff: LaunchTargetHandoff | null;
  welcomeType: AgentTypeDefinition;
  agentName: string;
  setAgentName: (value: string) => void;
  onAgentCreated: (agentId: string) => Promise<void>;
  managedLaunchEntitled: boolean;
  onChooseManagedPlan: () => void;
  onBackToAgentChoices: () => void;
  // Telemetry context only — which welcome persona (if any) led to this launch.
  personaId?: string | null;
  soulPromptId?: string | null;
  /** Saved template to fork; the agents route applies its identity. */
  templateId?: string | null;
};

function HivraBoxWelcomeLaunchForm(props: HivraBoxLaunchProps) {
  const { userId, isLoaded } = useAuth();
  const ownerId = isLoaded ? userId ?? null : null;
  return <HivraBoxLaunchForOwner key={ownerId ?? 'signed-out'} {...props} ownerId={ownerId} />;
}

function HivraBoxLaunchForOwner({ welcomeType, agentName, setAgentName, onAgentCreated,
  managedLaunchEntitled, onChooseManagedPlan, onBackToAgentChoices,
  personaId = null, soulPromptId = null, ownerId, targetHandoff, templateId = null,
}: HivraBoxLaunchProps & { ownerId: string | null }) {
  const router = useRouter();
  const selfHosted = isLocalAuthMode();
  const formActiveRef = useRef(true);
  useLayoutEffect(() => { formActiveRef.current = true; return () => { formActiveRef.current = false; }; }, []);
  const agent = hivraAgentForWelcomeType(welcomeType.key);
  const modelLaunch = useModelLaunch(agent?.id === 'codex' ? ownerId : null);
  const [modelDraft, setModelDraft] = useState<LaunchModelDraft>({ mode: 'native', apiKey: '', model: VENICE_DEFAULT_MODEL, walletType: 'card' });
  const [nativeLaunching, setLaunching] = useState(false);
  const [revisionConfirmation, setRevisionConfirmation] = useState('');
  const frozenLaunch = modelLaunch.editing ? null : modelLaunch.saved;
  const modelMode = frozenLaunch?.intent.llm.mode ?? modelDraft.mode;
  const modelSelected = agent?.id === 'codex' && modelMode !== 'native';
  const modelSelection = ModelKeySelectionSchema.safeParse(modelMode === 'native' ? null
    : modelMode === 'byok' ? { ...(frozenLaunch?.intent.llm ?? { provider: 'venice', mode: 'byok', model: modelDraft.model }), apiKey: modelDraft.apiKey }
      : frozenLaunch?.intent.llm ?? { provider: 'venice', mode: 'managed', model: modelDraft.model, walletType: modelDraft.walletType });
  const launchDestination = useLaunchDestination(agent?.id ?? null, {
    handoff: targetHandoff,
    preferSelfManaged: !managedLaunchEntitled,
  });
  const providerComputer = launchDestination.mode === 'self-managed'
    && launchDestination.selectedTarget?.capabilities && 'kind' in launchDestination.selectedTarget.capabilities;
  // Native authentication remains the default. Alternative model setup is
  // delivered later on the same computer, never via installer arguments.
  const productName = agent?.name ?? welcomeType.name;
  const signInLabel = welcomeType.key === 'codex' ? 'ChatGPT or API key' : 'Anthropic account';
  const launchIcon = welcomeType.key === 'codex' ? <Terminal size={14} /> : <Code2 size={14} />;
  const stepIcon = welcomeType.key === 'codex' ? <Terminal size={14} /> : <Code2 size={14} />;
  const hasBrowser = Boolean(agent?.browser);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [browser, setBrowser] = useState(false);
  const [cpu, setCpu] = useState(BASE_FLOOR.cpu);
  const [ram, setRam] = useState(BASE_FLOOR.ram);
  const [selfManagedCpu, setSelfManagedCpu] = useState(BASE_FLOOR.cpu);
  const [selfManagedRam, setSelfManagedRam] = useState(BASE_FLOOR.ram);
  const launching = nativeLaunching || modelLaunch.busy;
  const [launchError, setLaunchError] = useState<WelcomeErrorInsight | null>(null);
  // When the plan/agents probe fails the form used to silently dead-end with
  // a disabled CTA and misleading "0 CPU free, upgrade" copy — a rageclick
  // factory. Track the failure and offer a retry instead.
  const [resourceLoadError, setResourceLoadError] = useState<string | null>(null);
  const [resourceLoadAttempt, setResourceLoadAttempt] = useState(0);
  const resourceDefaultsAppliedRef = useRef(false);

  useEffect(() => {
    if (selfHosted) return;
    let cancelled = false;
    fetchPlanStrict()
      .then((nextPlan) => {
        if (cancelled) return;
        if (!nextPlan?.usage) throw new Error('Plan limits or current capacity are temporarily unavailable.');
        const { usedCpu, usedRam } = nextPlan.usage;
        const remainingCpu = Math.max(0, nextPlan.poolCpu - usedCpu);
        const remainingRam = Math.max(0, nextPlan.poolRam - usedRam);
        const paid = Boolean(nextPlan.subscribed && nextPlan.key !== 'free');
        const cpuCap = Math.min(8, nextPlan.maxCpuPerAgent, remainingCpu);
        const ramCap = Math.min(16, nextPlan.maxRamPerAgent, remainingRam);
        const browserFloor = resizeFloor(agent?.id ?? 'claude-code', true);
        const hasBrowserCpuChoice = WELCOME_CPU_OPTIONS.some(
          (option) => option >= browserFloor.cpu && option <= cpuCap,
        );
        const hasBrowserRamChoice = WELCOME_RAM_OPTIONS.some(
          (option) => option >= browserFloor.ram && option <= ramCap,
        );
        const defaultBrowser =
          paid && hasBrowser && hasBrowserCpuChoice && hasBrowserRamChoice;
        const defaultFloor = resizeFloor(agent?.id ?? 'claude-code', defaultBrowser);
        const cpuChoices = WELCOME_CPU_OPTIONS.filter(
          (option) => option >= defaultFloor.cpu && option <= cpuCap,
        );
        const ramChoices = WELCOME_RAM_OPTIONS.filter(
          (option) => option >= defaultFloor.ram && option <= ramCap,
        );
        // Managed boxes start at the conservative 2 CPU / 4 GB recommendation,
        // even when a large plan could give one box the whole pool. When that
        // pair cannot fit, use the smallest real selector choices that satisfy
        // the selected runtime/browser floor. This runs once, so later plan
        // refreshes never overwrite a user's explicit size choice.
        const canUseRecommended = cpuChoices.includes(2) && ramChoices.includes(4);
        const defaultCpu = canUseRecommended ? 2 : (cpuChoices[0] ?? defaultFloor.cpu);
        const defaultRam = canUseRecommended ? 4 : (ramChoices[0] ?? defaultFloor.ram);

        setPlan(nextPlan);
        setResourceLoadError(null);
        if (!resourceDefaultsAppliedRef.current) {
          setBrowser(defaultBrowser);
          setCpu(defaultCpu);
          setRam(defaultRam);
          resourceDefaultsAppliedRef.current = true;
        }
      })
      .catch((planError) => {
        if (!cancelled) {
          setResourceLoadError(sanitizeWelcomeErrorMessage(planError) || 'Plan check failed');
        }
        clientLog.warn('Welcome Claude Code resource load failed', {
          source: 'welcome-flow',
          failureType: 'welcome_claude_code_resource_load_failed',
          message: planError instanceof Error ? planError.message : String(planError),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [agent?.id, hasBrowser, resourceLoadAttempt, selfHosted]);

  const used = { cpu: plan?.usage?.usedCpu ?? 0, ram: plan?.usage?.usedRam ?? 0 };
  const planLoaded = plan !== null;
  const paidPool = Boolean(plan?.subscribed && plan.key !== 'free');
  const poolCpu = plan?.poolCpu ?? 0;
  const poolRam = plan?.poolRam ?? 0;
  const remCpu = Math.max(0, poolCpu - used.cpu);
  const remRam = Math.max(0, poolRam - used.ram);
  const capCpu = Math.min(8, plan?.maxCpuPerAgent ?? 0, remCpu);
  const capRam = Math.min(16, plan?.maxRamPerAgent ?? 0, remRam);
  const selfManaged = launchDestination.mode === 'self-managed';
  const targetCapacity = measuredTargetCapacity(launchDestination.selectedTarget);
  const managedBrowserAllowed = Boolean(
    paidPool &&
      agent?.browser &&
      capCpu >= BASE_FLOOR.cpu + BROWSER_ADD.cpu &&
      capRam >= BASE_FLOOR.ram + BROWSER_ADD.ram
  );
  const browserFloor = resizeFloor(agent?.id ?? 'claude-code', true);
  const selfManagedBrowserAllowed = Boolean(
    agent?.browser &&
      launchDestination.selectedTarget &&
      targetCapacity.cpu >= browserFloor.cpu &&
      targetCapacity.ramGb >= browserFloor.ram
  );
  const browserAllowed = selfManaged ? selfManagedBrowserAllowed : managedBrowserAllowed;
  const effectiveBrowser = browser && browserAllowed;
  const floor = resizeFloor(agent?.id ?? 'claude-code', effectiveBrowser);
  const selectedCpuCap = selfManaged ? targetCapacity.cpu : capCpu;
  const selectedRamCap = selfManaged ? targetCapacity.ramGb : capRam;
  const requestedCpu = selfManaged ? selfManagedCpu : cpu;
  const requestedRam = selfManaged ? selfManagedRam : ram;
  const resolvedCpu = Math.max(floor.cpu, Math.min(requestedCpu, selectedCpuCap || floor.cpu));
  const resolvedRam = Math.max(floor.ram, Math.min(requestedRam, selectedRamCap || floor.ram));
  // Slot-limit preflight: surface "Your Free plan allows 1 active agent."
  // BEFORE launch instead of letting the server reject the deploy.
  const slotLimit = plan?.maxAgents ?? 1;
  const agentCount = plan?.usage?.agentCount ?? 0;
  const atSlotLimit = planLoaded && agentCount >= slotLimit;
  const destinationReady = selfManaged
    ? Boolean(
        launchDestination.selectedTarget &&
        launchDestination.deployment?.mode === 'self-managed',
      )
    : managedLaunchEntitled && planLoaded;
  const capacityReady = selectedCpuCap >= floor.cpu && selectedRamCap >= floor.ram;
  const modelSupported = !selfManaged || targetSupportsLaunchModelSettings(launchDestination.selectedTarget, agent?.id);
  const revisionChoices = JSON.stringify({ name: agentName.trim(), cpu: resolvedCpu, ram: resolvedRam, browser: effectiveBrowser,
    deployment: launchDestination.deployment, mode: modelDraft.mode, model: modelDraft.model, walletType: modelDraft.walletType });
  const modelCanLaunch = !modelSelected || (modelSelection.success && Boolean(modelSelection.data) && (Boolean(frozenLaunch) || modelSupported));
  const canLaunch = Boolean(
    (frozenLaunch || destinationReady) &&
    agent &&
    (frozenLaunch || agentName.trim()) &&
    !launching &&
    !modelLaunch.agent &&
    (!modelSelected || modelLaunch.ready) &&
    (!modelLaunch.saved || modelSelected) &&
    (!modelLaunch.editing || revisionConfirmation === revisionChoices) &&
    modelCanLaunch &&
    (frozenLaunch || ((selfManaged || !atSlotLimit) && capacityReady)),
  );

  async function launchBox() {
    if (!agent || launching || !canLaunch) return;
    if (modelSelected) {
      if (!modelSelection.success || !modelSelection.data) return;
      const llm = modelSelection.data;
      const intent: ModelLaunchIntent | null = frozenLaunch?.intent ?? (launchDestination.deployment ? {
        type: 'codex', name: agentName.trim(), cpu: resolvedCpu, ram: resolvedRam, browser: effectiveBrowser,
        deployment: launchDestination.deployment,
        llm: llm.mode === 'byok' ? { provider: llm.provider, mode: llm.mode, model: llm.model }
          : { provider: llm.provider, mode: llm.mode, model: llm.model, walletType: llm.walletType },
      } : null);
      if (!intent) return;
      setLaunching(true);
      setLaunchError(null);
      const apiKey = modelDraft.apiKey;
      setModelDraft(draft => ({ ...draft, apiKey: '' }));
      const created = await modelLaunch.submit(intent, apiKey);
      if (!formActiveRef.current) return;
      setLaunching(false);
      if (created && created.status !== 'deleted') {
        if (!modelLaunch.saved) void waitForWelcomeBestEffort(Promise.resolve().then(() => onAgentCreated(created.id)));
        router.push(`/dashboard/agent/${created.id}?welcome=1&tab=manage#model-settings`);
      }
      return;
    }
    if (!agentName.trim()) {
      setLaunchError(welcomeValidationInsight(`${productName} name is required.`));
      clientLog.warn('Welcome Claude Code launch validation blocked', {
        source: 'welcome-flow',
        failureType: 'welcome_claude_code_validation_failed',
        reason: 'missing_agent_name',
      });
      return;
    }
    const deployment = launchDestination.deployment;
    if (!deployment || (selfManaged && deployment.mode !== 'self-managed')) {
      setLaunchError(welcomeValidationInsight('Choose a ready self-managed host before launching.'));
      return;
    }

    setLaunching(true);
    setLaunchError(null);
    captureWelcomeEvent('welcome_claude_code_launch_requested', {
      agentType: agent.id,
      cpu: resolvedCpu,
      ram: resolvedRam,
      browser: effectiveBrowser,
      deploymentMode: deployment.mode,
    });

    try {
      // Native Codex has no model-key precursor, so retain one owner-generated
      // receipt ID for retries of the exact same effective launch intent. A
      // material edit deliberately starts a new request namespace.
      const nativeIntentKey = JSON.stringify({
        type: agent.id,
        name: agentName.trim(),
        cpu: resolvedCpu,
        ram: resolvedRam,
        browser: effectiveBrowser,
        deployment,
        ...(templateId ? { templateId } : {}),
      });
      const nativeOwnerScope = ownerId ?? 'local-operator';
      const nativeRequestId = agent.id === 'codex'
        ? nativeLaunchRequestId(nativeOwnerScope, nativeIntentKey)
        : null;
      const created = await createAgent(withLaunchTemplate({
        type: agent.id,
        name: agentName.trim(),
        cpu: resolvedCpu,
        ram: resolvedRam,
        browser: effectiveBrowser,
        deployment,
        ...(nativeRequestId ? { launchRequestId: nativeRequestId } : {}),
      }, templateId));
      if (nativeRequestId) clearNativeLaunchRequestId(nativeOwnerScope, nativeRequestId);
      // The create response is the acceptance boundary. Record it immediately;
      // optional personalization must never make a successfully-created box
      // look like launch is still pending forever.
      captureWelcomeEvent('launch_request_accepted', {
        agentType: agent.id,
        agentId: created.id,
        persona: personaId,
        soulPromptId,
        deploymentMode: deployment.mode,
        acceptedStatus: created.status,
      });
      // A forked template already carries its goal, context and personality;
      // the onboarding save would overwrite them with this draft's defaults.
      const personalizationOutcome = templateId
        ? ({ status: 'completed' } as const)
        : await waitForWelcomeBestEffort(
          Promise.resolve().then(() => onAgentCreated(created.id)),
        );
      if (personalizationOutcome.status === 'failed') {
        clientLog.warn('Welcome Claude Code personalization save failed', {
          source: 'welcome-flow',
          route: '/api/hivra/agents/[id]/action',
          failureType: 'welcome_claude_code_personalization_save_failed',
          agentId: created.id,
        }, personalizationOutcome.error);
      } else if (personalizationOutcome.status === 'timed-out') {
        clientLog.warn('Welcome Claude Code personalization save timed out; continuing to agent', {
          source: 'welcome-flow',
          route: '/api/hivra/agents/[id]/action',
          failureType: 'welcome_claude_code_personalization_save_timed_out',
          agentId: created.id,
          timeoutMs: WELCOME_PERSONALIZATION_BEST_EFFORT_MS,
        });
      }
      router.push(buildHivraPostLaunchDestination(agent, created.id));
    } catch (launchFailure) {
      const rawMessage = sanitizeWelcomeErrorMessage(launchFailure) || 'Launch failed';
      const insight = buildWelcomeErrorInsight(rawMessage, 'Launch failed');
      captureWelcomeEvent('welcome_box_launch_failed', {
        agentType: agent.id,
        reason: rawMessage.slice(0, 300),
      });
      setLaunchError(
        /provision kickoff failed/i.test(rawMessage)
          ? {
              ...insight,
              headline: `Provision kickoff failed. The platform could not reach the ${productName} provisioner. Try again in a moment; if it repeats, support can trace the logged kickoff failure.`,
              detail: null,
            }
          : insight,
      );
      setLaunching(false);
      captureWelcomeEvent('activation_failed', {
        stage: 'hivra_box_launch',
        agentType: agent.id,
        failureType: 'welcome_claude_code_launch_failed',
        errorCategory: insight.category,
        errorMessage: rawMessage,
        cpu: resolvedCpu,
        ram: resolvedRam,
        browser: effectiveBrowser,
        deploymentMode: deployment.mode,
        recoverable: insight.retryable,
      });
      clientLog.error('Welcome Claude Code launch failed', launchFailure, {
        source: 'welcome-flow',
        route: '/api/hivra/agents',
        failureType: 'welcome_claude_code_launch_failed',
        errorCategory: insight.category,
        cpu: resolvedCpu,
        ram: resolvedRam,
        browser: effectiveBrowser,
        deploymentMode: deployment.mode,
      });
    }
  }

  if (!agent) {
    return (
      <div role="alert" style={{ border: '1px solid #c0392b', background: 'rgba(192,57,43,0.08)', color: '#e06c5a', fontSize: 13, padding: '10px 14px' }}>
        {productName} launch is not configured.
      </div>
    );
  }

  const sizeButtonStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    border: active ? '1px solid var(--ink-black)' : '1px solid var(--etched-border)',
    background: active ? 'var(--ink-black)' : 'transparent',
    color: active ? 'var(--bg-surface)' : disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
    opacity: disabled ? 0.35 : 1,
    fontSize: 12,
    minHeight: 44,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'var(--font-mono), monospace',
  });

  return (
    <AnimateIn>
      <div
        className="heavy-glass-card"
        data-testid="welcome-deploy-form"
        data-agent-type={agent.id}
        style={STYLES.deployCard}
      >
        <div style={STYLES.deployCardGoldBar} />

        <button
          type="button"
          onClick={onBackToAgentChoices}
          disabled={launching}
          className="mono"
          style={WELCOME_BACK_BUTTON_STYLE}
        >
          <ArrowLeft size={13} /> Back to agent choices
        </button>

        <div style={STYLES.deployStepIndicator}>
          <div style={STYLES.deployStepDone}>
            <CheckCircle size={14} />
            <span>{selfManaged
              ? 'Your infrastructure'
              : managedLaunchEntitled
                ? 'Plan active'
                : 'Managed plan needed'}</span>
          </div>
          <div style={STYLES.deployStepDivider} />
          <div style={STYLES.deployStepCurrent}>
            {stepIcon}
            <span>Launch {productName}</span>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
          <div>
            <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800, opacity: 0.5 }}>
              {modelSelected ? 'Your model, your computer' : `${signInLabel} after launch`}
            </span>
            <h3 className="serif" style={{ margin: '6px 0 7px', fontSize: 24, lineHeight: 1.1, fontWeight: 650 }}>
              Launch {productName}.
            </h3>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.58, color: 'var(--text-secondary)' }}>
              {modelSelected ? 'Choose your model connection and where to run. Setup continues in Settings on the same computer after it is ready.' : welcomeType.key === 'codex'
                ? 'Name the box and choose resources. When Codex opens, choose ChatGPT sign-in or provide your own OpenAI API key in its terminal.'
                : `Name the box and choose resources. After provisioning, ${productName} opens the normal Anthropic sign-in flow inside the command center.`}
            </p>
          </div>

          {agent.id === 'codex' && <LaunchModelControl draft={modelDraft} onChange={setModelDraft} launch={modelLaunch}
            disabled={launching} supported={modelSupported} allowManaged={!selfHosted}
            onReview={() => {
              const saved = modelLaunch.saved?.intent;
              if (!saved) return;
              setAgentName(saved.name); setCpu(saved.cpu); setRam(saved.ram);
              setSelfManagedCpu(saved.cpu); setSelfManagedRam(saved.ram); setBrowser(saved.browser);
              setModelDraft({ mode: saved.llm.mode, model: saved.llm.model, apiKey: '', walletType: saved.llm.mode === 'managed' ? saved.llm.walletType : 'card' });
              launchDestination.setMode(saved.deployment.mode);
              if (saved.deployment.mode === 'self-managed') launchDestination.setSelectedTargetId(saved.deployment.targetId);
              setRevisionConfirmation(''); modelLaunch.reviewChoices();
            }}
            onOpen={id => router.push(`/dashboard/agent/${id}?tab=manage#model-settings`)} />}

          {!frozenLaunch && <><div style={STYLES.fieldGroup}>
            <label htmlFor="welcome-box-agent-name" className="mono" style={STYLES.fieldLabel}>
              {productName} Name
            </label>
            <input
              id="welcome-box-agent-name"
              ref={focusOnFinePointer}
              autoComplete="off"
              enterKeyHint="done"
              disabled={launching}
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder={welcomeType.defaultName}
              style={STYLES.textInput}
              onFocus={(event) => (event.target.style.borderColor = 'var(--ink-black)')}
              onBlur={(event) => (event.target.style.borderColor = 'var(--etched-border)')}
            />
          </div>

          <DeploymentDestinationControl
            state={launchDestination}
            disabled={launching}
            runtimeName={productName}
            capacitySetupHref={isPortableAgentLaunchId(agent?.id)
              ? buildInfrastructureSetupHref(agent.id)
              : '/dashboard/infrastructure'}
          />

          <ManagedCloudPlanGate
            visible={!selfManaged && !managedLaunchEntitled}
            onChoosePlan={onChooseManagedPlan}
          />

          {(!selfManaged || launchDestination.selectedTarget) ? <div style={{ border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', padding: '14px 16px', display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800, opacity: 0.62 }}>
                Resources
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.5 }}>
                {selfManaged
                  ? `${formatPoolValue(targetCapacity.cpu)} CPU / ${formatPoolValue(targetCapacity.ramGb)} GB measured`
                  : !planLoaded
                    ? resourceLoadError ? 'Capacity unavailable' : 'Checking capacity…'
                    : `${formatPoolValue(remCpu)} CPU / ${formatPoolValue(remRam)} GB free`}
              </span>
            </div>

            {hasBrowser ? (
              <label style={{ border: '1px solid var(--etched-border)', padding: 14, display: 'flex', alignItems: 'center', gap: 12, cursor: launching || !browserAllowed ? 'not-allowed' : 'pointer' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13.5, color: 'var(--ink-black)' }}>Browser automation</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 2 }}>
                    {browserAllowed
                      ? `Optional live browser support. Reserves +${BROWSER_ADD.cpu} CPU / +${BROWSER_ADD.ram} GB.`
                      : selfManaged
                        ? 'This host does not have enough measured capacity for browser automation.'
                        : 'Upgrade to add browser automation.'}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-label="Browser automation"
                  aria-checked={effectiveBrowser}
                  disabled={launching || !browserAllowed}
                  onClick={() => {
                    if (launching || !browserAllowed) return;
                    setBrowser((enabled) => !enabled);
                  }}
                  style={{
                    width: 52,
                    height: 44,
                    border: 'none',
                    background: 'transparent',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: browserAllowed ? 'pointer' : 'not-allowed',
                    opacity: browserAllowed ? 1 : 0.55,
                    flexShrink: 0,
                    padding: 0,
                  }}
                >
                  <span aria-hidden="true" style={{ position: 'relative', width: 46, height: 26, border: '1px solid var(--etched-border)', background: effectiveBrowser ? 'var(--gold-leaf)' : 'rgba(255,255,255,0.05)' }}>
                    <span style={{ position: 'absolute', top: 3, left: effectiveBrowser ? 23 : 3, width: 18, height: 18, background: effectiveBrowser ? 'var(--ink-black)' : 'var(--text-muted)', transition: 'left .15s ease' }} />
                  </span>
                </button>
              </label>
            ) : null}

            {!providerComputer && <div style={{ display: 'grid', gap: 9 }}>
              <div className="welcome-size-row">
                <span className="mono welcome-size-label" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.62 }}>
                  <Cpu size={12} /> CPU
                </span>
                {WELCOME_CPU_OPTIONS.map((option) => {
                  const disabled = launching || option < floor.cpu || option > selectedCpuCap;
                  return (
                    <button
                      key={`welcome-claude-cpu-${option}`}
                      type="button"
                      className="welcome-size-option"
                      disabled={disabled}
                      onClick={() => selfManaged ? setSelfManagedCpu(option) : setCpu(option)}
                      aria-label={`Use ${option} CPU`}
                      style={sizeButtonStyle(resolvedCpu === option, disabled)}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              <div className="welcome-size-row">
                <span className="mono welcome-size-label" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.62 }}>
                  <MemoryStick size={12} /> RAM
                </span>
                {WELCOME_RAM_OPTIONS.map((option) => {
                  const disabled = launching || option < floor.ram || option > selectedRamCap;
                  return (
                    <button
                      key={`welcome-claude-ram-${option}`}
                      type="button"
                      className="welcome-size-option"
                      disabled={disabled}
                      onClick={() => selfManaged ? setSelfManagedRam(option) : setRam(option)}
                      aria-label={`Use ${option} GB RAM`}
                      style={sizeButtonStyle(resolvedRam === option, disabled)}
                    >
                      {option}<span style={{ fontSize: 11, opacity: 0.6 }}>G</span>
                    </button>
                  );
                })}
              </div>
            </div>}

            {!selfManaged && paidPool ? (
              <PoolMeter
                planName={plan?.name}
                cpu={{ othersUsed: used.cpu, selected: resolvedCpu, total: poolCpu }}
                ram={{ othersUsed: used.ram, selected: resolvedRam, total: poolRam }}
              />
            ) : null}

            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {selfManaged
                ? !launchDestination.selectedTarget
                  ? 'Choose a ready host to continue.'
                  : !capacityReady
                    ? `This host does not have the measured ${formatPoolValue(floor.cpu)} CPU / ${formatPoolValue(floor.ram)} GB required for ${productName}.`
                    : !agentName.trim()
                      ? `Name your ${productName} box to launch.`
                      : providerComputer
                        ? `Uses the whole ${launchDestination.selectedTarget.displayName} computer. Its identity and available resources are checked again before installation.`
                        : `Launching at ${formatPoolValue(resolvedCpu)} CPU / ${formatPoolValue(resolvedRam)} GB on ${launchDestination.selectedTarget.displayName}. Capacity is revalidated when you launch.`
                : !planLoaded
                  ? resourceLoadError
                    ? `Couldn't load your plan limits. Retry below to continue.`
                    : 'Checking your plan limits…'
                  : atSlotLimit
                    ? `Your ${plan?.name ?? 'plan'} plan's agent slots are full.`
                    : capCpu < floor.cpu || capRam < floor.ram
                      ? `Your ${plan?.name ?? 'plan'} pool has ${formatPoolValue(remCpu)} CPU / ${formatPoolValue(remRam)} GB free. Resize an existing computer or increase your plan to make room for ${productName}.`
                      : !agentName.trim()
                        ? `Name your ${productName} box to launch.`
                        : resolvedCpu >= capCpu && resolvedRam >= capRam
                          ? `This box takes your full ${plan?.name ?? 'plan'} allocation — ${formatPoolValue(resolvedCpu)} CPU / ${formatPoolValue(resolvedRam)} GB.${(plan?.maxAgents ?? 1) > 1 ? ' Tap a smaller size to leave room for more agents.' : ''}`
                          : `Launching at ${formatPoolValue(resolvedCpu)} CPU / ${formatPoolValue(resolvedRam)} GB · ${formatPoolValue(Math.max(0, remCpu - resolvedCpu))} CPU / ${formatPoolValue(Math.max(0, remRam - resolvedRam))} GB left for more agents.`}
            </div>
          </div> : null}

          <div style={{ border: '1px solid var(--etched-border)', background: 'rgba(255,255,255,0.02)', padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <ShieldCheck size={15} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, minWidth: 0 }}>
              {selfManaged
                ? launchDestination.selectedTarget
                  ? 'Hivra sends this launch to the verified host you selected. Its credentials, capacity and operating costs remain under your control.'
                  : 'Connect and prepare a host first. Hivra will verify its identity and measured capacity before enabling launch.'
                : hostingDisclaimer(agent as HivraAgentDef)}
            </div>
          </div>

          </>}

          {!frozenLaunch && !selfManaged && resourceLoadError && !planLoaded && (
            <div role="alert" style={{ border: '1px solid #c0392b', background: 'rgba(192,57,43,0.08)', color: '#e06c5a', fontSize: 12.5, padding: '9px 12px', display: 'grid', gap: 8 }}>
              <span>We couldn&apos;t load your plan limits, so launch is paused. This is usually temporary.</span>
              <span className="mono" style={{ fontSize: 10, opacity: 0.6 }}>{resourceLoadError}</span>
              <button
                type="button"
                onClick={() => setResourceLoadAttempt((attempt) => attempt + 1)}
                className="mono"
                style={{ ...WELCOME_ERROR_ACTION_SECONDARY_STYLE, justifySelf: 'start' }}
              >
                Retry plan check
              </button>
            </div>
          )}

          {!frozenLaunch && !selfManaged && atSlotLimit && (
            <div role="alert" style={{ border: '1px solid var(--etched-border)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55, padding: '12px 14px', display: 'grid', gap: 10 }}>
              <span>
                Your {plan?.name ?? 'current'} plan allows {slotLimit} active agent{slotLimit === 1 ? '' : 's'} and you already have {agentCount}. Upgrade for more slots, or remove an agent first.
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => router.push('/dashboard/billing?from=welcome')} className="mono" style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}>
                  Upgrade plan
                </button>
                <button type="button" onClick={() => router.push('/dashboard')} className="mono" style={WELCOME_ERROR_ACTION_SECONDARY_STYLE}>
                  Manage agents
                </button>
              </div>
            </div>
          )}

          {launchError && (
            <div role="alert" style={{ border: '1px solid #c0392b', background: 'rgba(192,57,43,0.08)', color: '#e06c5a', fontSize: 12.5, lineHeight: 1.55, padding: '9px 12px', display: 'grid', gap: 8 }}>
              <span>{launchError.headline}</span>
              {shouldRenderWelcomeErrorDetail(launchError, selfManaged ? 'self-managed' : 'managed') && (
                <span className="mono" style={{ fontSize: 10, opacity: 0.6 }}>
                  {launchError.detail}
                </span>
              )}
              {launchError.showPlanActions && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => router.push('/dashboard/billing?from=welcome')} className="mono" style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}>
                    Upgrade plan
                  </button>
                  <button type="button" onClick={() => router.push('/dashboard')} className="mono" style={WELCOME_ERROR_ACTION_SECONDARY_STYLE}>
                    Manage agents
                  </button>
                </div>
              )}
            </div>
          )}

          {modelLaunch.editing && <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 16, border: '1px solid var(--etched-border)', fontSize: 12, lineHeight: 1.6 }}>
            <input type="checkbox" disabled={launching} checked={revisionConfirmation === revisionChoices}
              onChange={event => setRevisionConfirmation(event.target.checked ? revisionChoices : '')} style={{ marginTop: 3, flexShrink: 0 }} />
            Use the hosting, resources and model shown above for this saved request. If an earlier attempt was already accepted, its original computer wins instead.
          </label>}

          {nativeLaunching && !modelLaunch.agent && (
            <p
              id="box-agent-launch-status"
              role="status"
              aria-label="Launch confirmation"
              aria-live="polite"
              aria-atomic="true"
              style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: '12px 0' }}
            >
              <strong style={{ color: 'var(--text-primary)' }}>Waiting for launch confirmation.</strong>
              <br />
              Keep this page open. Once the server confirms your launch, we’ll open the setup page automatically.
              This is a pending request, not installation progress.
            </p>
          )}
          {!modelLaunch.agent && <button
            type="button"
            data-testid="deploy-primary-cta"
            className="premium-btn"
            aria-describedby={nativeLaunching ? 'box-agent-launch-status' : undefined}
            onClick={() => void launchBox()}
            disabled={!canLaunch}
            style={{
              ...STYLES.primaryButton,
              opacity: canLaunch ? 1 : 0.55,
              cursor: launching ? 'wait' : canLaunch ? 'pointer' : 'not-allowed',
              marginTop: '0.5rem',
            }}
          >
            {launching ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : launchIcon}
            {launching ? (modelLaunch.saved ? 'Checking original launch...' : `Launching ${productName}...`) : modelLaunch.saved ? 'Retry saved launch' : providerComputer ? 'Launch on this computer' : `Launch · ${resolvedCpu} CPU / ${resolvedRam} GB`}
            {!launching && <ArrowRight size={14} />}
          </button>}
        </div>
      </div>
    </AnimateIn>
  );
}

// Dashboard-host launch form (Aeon/OpenClaw/Agent Zero). Managed launches keep
// their existing catalog floor and plan behavior. Self-managed launches expose
// only sizes proven by the selected target's latest measured capacity.
function DashboardAgentLaunchForm({
  targetHandoff,
  welcomeType,
  agentName,
  setAgentName,
  managedLaunchEntitled,
  onChooseManagedPlan,
  onBackToAgentChoices,
  templateId = null,
}: {
  targetHandoff: LaunchTargetHandoff | null;
  welcomeType: AgentTypeDefinition;
  agentName: string;
  setAgentName: (value: string) => void;
  managedLaunchEntitled: boolean;
  onChooseManagedPlan: () => void;
  onBackToAgentChoices: () => void;
  /** Saved template to fork; the agents route applies its identity. */
  templateId?: string | null;
}) {
  const router = useRouter();
  const selfHosted = isLocalAuthMode();
  const agent = hivraAgentForWelcomeType(welcomeType.key);
  const launchDestination = useLaunchDestination(agent?.id ?? null, {
    handoff: targetHandoff,
    preferSelfManaged: !managedLaunchEntitled,
  });
  const providerComputer = launchDestination.mode === 'self-managed'
    && launchDestination.selectedTarget?.capabilities && 'kind' in launchDestination.selectedTarget.capabilities;
  // Opt-in browser for browser-capable dashboard agents (OpenClaw drives the box's
  // CDP Chrome via the live VNC view). Toggling it on bumps the resource floor.
  const browserCapable = Boolean(agent?.browser);
  const [wantBrowser, setWantBrowser] = useState(false);
  const [useRecommendedAgentZeroSize, setUseRecommendedAgentZeroSize] = useState(true);
  const [selfManagedCpu, setSelfManagedCpu] = useState(BASE_FLOOR.cpu);
  const [selfManagedRam, setSelfManagedRam] = useState(BASE_FLOOR.ram);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<WelcomeErrorInsight | null>(null);
  const [resourceLoadError, setResourceLoadError] = useState<string | null>(null);
  const [resourceLoadAttempt, setResourceLoadAttempt] = useState(0);
  // Deploy-card opt-in to power the agent with managed Venice credits. OFF by
  // default; only offered for catalog types whose box wiring exists. The choice
  // rides the launch request: Aeon seeds its connect-step toggle; dashboard
  // agents without a connect step receive their model configuration at launch.
  const supportsManagedVenice = !selfHosted && Boolean(agent?.managedVenice) && !providerComputer;
  const [useManagedCredits, setUseManagedCredits] = useState(false);
  // Credit gate, mirroring the managed-Venice deploy card: opt in + have a
  // funded wallet → launch; opt in + empty wallet → prompt to top up first.
  // "Checking" is derived from the summary not yet being resolved (no separate
  // loading flag) so the load effect never sets state synchronously.
  const [veniceSummary, setVeniceSummary] = useState<ManagedVeniceWalletSummaryPayload | null>(null);
  const [veniceSummaryFailed, setVeniceSummaryFailed] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);

  // The wallet balance loads from the opt-in moment (the checkbox handler) and
  // after a top-up, never from an effect — keeping the setState in event
  // handlers where cascading-render lint rules don't apply. "Checking" is then
  // simply "opted in but the summary hasn't resolved yet."
  const loadVeniceSummary = useCallback(async () => {
    const result = await requestManagedVeniceSummary();
    if (result.ok) {
      setVeniceSummary(result.summary);
      setVeniceSummaryFailed(false);
      return result.summary;
    }
    setVeniceSummaryFailed(true);
    return null;
  }, []);

  const handleToggleManagedCredits = useCallback(
    (checked: boolean) => {
      setUseManagedCredits(checked);
      if (checked && !veniceSummary && !veniceSummaryFailed) void loadVeniceSummary();
    },
    [veniceSummary, veniceSummaryFailed, loadVeniceSummary],
  );

  // The agent can bill either wallet (the connect mint picks the funded one,
  // card-first), so any funded wallet clears the gate. Unknown ≠ zero: a failed
  // summary fetch must not wall off a user who actually has credits.
  const veniceAvailableMicroUsd = Math.max(
    veniceSummary?.wallets.card.availableMicroUsd ?? 0,
    veniceSummary?.wallets.hermesos.availableMicroUsd ?? 0,
  );
  const hasManagedVeniceCredits = veniceAvailableMicroUsd > 0 || veniceSummaryFailed;
  const managedCreditsActive = supportsManagedVenice && useManagedCredits;
  const managedCreditsChecking = managedCreditsActive && !veniceSummary && !veniceSummaryFailed;
  const needsManagedCredits = managedCreditsActive && !managedCreditsChecking && !hasManagedVeniceCredits;

  useEffect(() => {
    if (selfHosted) return;
    let cancelled = false;
    fetchPlanStrict()
      .then((nextPlan) => {
        if (cancelled) return;
        if (!nextPlan?.usage) throw new Error('Plan limits or current capacity are temporarily unavailable.');
        setPlan(nextPlan);
        setResourceLoadError(null);
      })
      .catch((planError) => {
        if (!cancelled) {
          setResourceLoadError(sanitizeWelcomeErrorMessage(planError) || 'Plan check failed');
        }
        clientLog.warn('Welcome Aeon resource load failed', {
          source: 'welcome-flow',
          failureType: 'welcome_aeon_resource_load_failed',
          message: planError instanceof Error ? planError.message : String(planError),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [resourceLoadAttempt, selfHosted]);

  const selfManaged = launchDestination.mode === 'self-managed';
  const targetCapacity = measuredTargetCapacity(launchDestination.selectedTarget);
  const browserFloor = resizeFloor(agent?.id ?? 'aeon', true);
  const selfManagedBrowserAllowed = Boolean(
    launchDestination.selectedTarget &&
    targetCapacity.cpu >= browserFloor.cpu &&
    targetCapacity.ramGb >= browserFloor.ram,
  );
  const browserAllowed = !selfManaged || selfManagedBrowserAllowed;
  const effectiveBrowser = browserCapable && wantBrowser && browserAllowed;
  const floor = resizeFloor(agent?.id ?? 'aeon', effectiveBrowser);
  // Recommendation is a launch choice, not a new admission/resize minimum.
  // Keep the smaller supported size explicit; never silently downsize when
  // the plan or remaining pool cannot fit the selected recommendation.
  const managedAgentZero = !selfManaged && agent?.id === 'agent-zero';
  const managedSize = managedAgentZero && useRecommendedAgentZeroSize ? { cpu: 2, ram: 4 } : floor;
  const resolvedCpu = selfManaged
    ? Math.max(floor.cpu, Math.min(selfManagedCpu, targetCapacity.cpu || floor.cpu))
    : managedSize.cpu;
  const resolvedRam = selfManaged
    ? Math.max(floor.ram, Math.min(selfManagedRam, targetCapacity.ramGb || floor.ram))
    : managedSize.ram;
  const managedSizeFits = (cpu: number, ram: number) => Boolean(plan?.usage
    && cpu <= plan.maxCpuPerAgent && ram <= plan.maxRamPerAgent
    && cpu <= plan.poolCpu - plan.usage.usedCpu
    && ram <= plan.poolRam - plan.usage.usedRam);
  const planLoaded = plan !== null;
  const slotLimit = plan?.maxAgents ?? 1;
  const atSlotLimit = planLoaded && (plan.usage?.agentCount ?? 0) >= slotLimit;
  const managedCapacityReady = Boolean(plan?.usage && (agent?.poolExempt || (
    plan.poolCpu - plan.usage.usedCpu >= managedSize.cpu &&
    plan.poolRam - plan.usage.usedRam >= managedSize.ram &&
    (!managedAgentZero || managedSizeFits(managedSize.cpu, managedSize.ram))
  )));
  // The primary button is only disabled by the hard blockers (plan/name/slot).
  // The managed-credits gate doesn't disable it — it redirects the click to the
  // top-up modal (matching the managed-Venice deploy card), so the button stays
  // actionable and tells the user what it'll do.
  const destinationReady = selfManaged
    ? Boolean(
        launchDestination.selectedTarget &&
        launchDestination.deployment?.mode === 'self-managed' &&
        targetCapacity.cpu >= floor.cpu &&
        targetCapacity.ramGb >= floor.ram,
      )
    : managedLaunchEntitled && planLoaded && managedCapacityReady;
  const canLaunch = Boolean(
    destinationReady &&
    agentName.trim() &&
    !launching &&
    (selfManaged || !atSlotLimit) &&
    !managedCreditsChecking,
  );

  async function launch() {
    if (!agent || launching) return;
    if (!agentName.trim()) {
      setLaunchError(welcomeValidationInsight(`${welcomeType.name} name is required.`));
      return;
    }
    const deployment = launchDestination.deployment;
    if (!deployment || (selfManaged && deployment.mode !== 'self-managed')) {
      setLaunchError(welcomeValidationInsight('Choose a ready self-managed host before launching.'));
      return;
    }
    setLaunching(true);
    setLaunchError(null);
    captureWelcomeEvent('welcome_aeon_launch_requested', {
      agentType: agent.id,
      deploymentMode: deployment.mode,
    });
    try {
      const wantManaged = supportsManagedVenice && useManagedCredits;
      // OpenClaw and Agent Zero have no connect step, so their managed-Venice key
      // is minted at LAUNCH (the route mints + the provisioner writes it into the
      // box's model config). Pick the wallet the same way the connect step does:
      // card unless only hermesos is funded.
      const cardMicro = veniceSummary?.wallets.card.availableMicroUsd ?? 0;
      const hermesosMicro = veniceSummary?.wallets.hermesos.availableMicroUsd ?? 0;
      const launchWalletType: 'card' | 'hermesos' = cardMicro <= 0 && hermesosMicro > 0 ? 'hermesos' : 'card';
      const llmForLaunch = (agent.id === 'openclaw' || agent.id === 'agent-zero') && wantManaged
        ? { provider: 'venice' as const, mode: 'managed' as const, walletType: launchWalletType }
        : undefined;
      // Agent Zero's managed launch uses the visibly selected size. Other
      // dashboard agents keep their catalog floor. Self-managed launches use
      // measured target capacity; all requests are validated again server-side.
      const created = await createAgent(withLaunchTemplate({
        type: agent.id,
        name: agentName.trim(),
        cpu: resolvedCpu,
        ram: resolvedRam,
        browser: effectiveBrowser,
        managedVenice: wantManaged,
        llm: llmForLaunch,
        deployment,
      }, templateId));
      captureWelcomeEvent('launch_request_accepted', {
        agentType: agent.id,
        agentId: created.id,
        managedVenice: supportsManagedVenice && useManagedCredits,
        deploymentMode: deployment.mode,
        acceptedStatus: created.status,
      });
      router.push(buildHivraPostLaunchDestination(agent, created.id));
    } catch (launchFailure) {
      const rawMessage = sanitizeWelcomeErrorMessage(launchFailure) || 'Launch failed';
      const insight = buildWelcomeErrorInsight(rawMessage, 'Launch failed');
      captureWelcomeEvent('welcome_box_launch_failed', {
        agentType: agent.id,
        reason: rawMessage.slice(0, 300),
      });
      setLaunchError(
        /provision kickoff failed/i.test(rawMessage)
          ? {
              ...insight,
              headline: 'Provision kickoff failed. The platform could not reach the provisioner. Try again in a moment.',
              detail: null,
            }
          : insight,
      );
      setLaunching(false);
      captureWelcomeEvent('activation_failed', {
        stage: 'aeon_launch',
        agentType: agent.id,
        failureType: 'welcome_aeon_launch_failed',
        errorCategory: insight.category,
        errorMessage: rawMessage,
        deploymentMode: deployment.mode,
        recoverable: insight.retryable,
      });
      clientLog.error('Welcome Aeon launch failed', launchFailure, {
        source: 'welcome-flow',
        route: '/api/hivra/agents',
        failureType: 'welcome_aeon_launch_failed',
        errorCategory: insight.category,
        deploymentMode: deployment.mode,
      });
    }
  }

  if (!agent) {
    return (
      <div role="alert" style={{ border: '1px solid #c0392b', background: 'rgba(192,57,43,0.08)', color: '#e06c5a', fontSize: 13, padding: '10px 14px' }}>
        {welcomeType.name} launch is not configured.
      </div>
    );
  }

  return (
    <AnimateIn>
      <div className="heavy-glass-card" style={STYLES.deployCard}>
        <div style={STYLES.deployCardGoldBar} />

        <button
          type="button"
          onClick={onBackToAgentChoices}
          className="mono"
          style={WELCOME_BACK_BUTTON_STYLE}
        >
          <ArrowLeft size={13} /> Back to agent choices
        </button>

        <div style={STYLES.deployStepIndicator}>
          <div style={STYLES.deployStepDone}>
            <CheckCircle size={14} />
            <span>{selfManaged
              ? 'Your infrastructure'
              : managedLaunchEntitled
                ? 'Plan active'
                : 'Managed plan needed'}</span>
          </div>
          <div style={STYLES.deployStepDivider} />
          <div style={STYLES.deployStepCurrent}>
            {welcomeType.icon === 'messages' ? <MessagesSquare size={14} /> : welcomeType.icon === 'orbit' ? <Orbit size={14} /> : <InfinityIcon size={14} />}
            <span>Launch {welcomeType.name}</span>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
          <div>
            <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800, opacity: 0.5 }}>
              {agent.connect === 'github' ? 'GitHub connect after launch' : 'Configure inside the dashboard'}
            </span>
            <h3 className="serif" style={{ margin: '6px 0 7px', fontSize: 24, lineHeight: 1.1, fontWeight: 650 }}>
              {welcomeType.deployCard.title}
            </h3>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.58, color: 'var(--text-secondary)' }}>
              {selfManaged
                ? `Launch ${welcomeType.name} on your selected computer, then connect your model provider and customize it in the agent’s own interface.`
                : welcomeType.deployCard.summary}
            </p>
          </div>

          <div style={STYLES.fieldGroup}>
            <label htmlFor="welcome-dashboard-agent-name" className="mono" style={STYLES.fieldLabel}>
              {welcomeType.name} Name
            </label>
            <input
              id="welcome-dashboard-agent-name"
              ref={focusOnFinePointer}
              autoComplete="off"
              enterKeyHint="done"
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder={welcomeType.defaultName}
              style={STYLES.textInput}
              onFocus={(event) => (event.target.style.borderColor = 'var(--ink-black)')}
              onBlur={(event) => (event.target.style.borderColor = 'var(--etched-border)')}
            />
          </div>

          <DeploymentDestinationControl
            state={launchDestination}
            disabled={launching}
            runtimeName={welcomeType.name}
            capacitySetupHref={isPortableAgentLaunchId(agent?.id)
              ? buildInfrastructureSetupHref(agent.id)
              : '/dashboard/infrastructure'}
          />

          <ManagedCloudPlanGate
            visible={!selfManaged && !managedLaunchEntitled}
            onChoosePlan={onChooseManagedPlan}
          />

          <div style={{ border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', padding: '12px 14px', fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            {selfManaged
              ? !launchDestination.selectedTarget
                ? 'Connect and prepare a compatible host above. Resource controls appear after Hivra has measured it.'
                : providerComputer
                ? 'Uses the whole prepared cloud computer. No additional server is purchased, and no Hivra managed-plan compute is consumed. Add your model account or API key inside the native agent interface.'
                : `Runs at ${formatPoolValue(resolvedCpu)} CPU / ${formatPoolValue(resolvedRam)} GB on your selected host. This does not consume Hivra managed-plan compute.`
              : agent.poolExempt
                ? `Reserves just ${formatPoolValue(floor.cpu)} CPU / ${formatPoolValue(floor.ram)} GB to host the dashboard — it doesn't count against your compute pool, only your agent count.`
                : `Runs on ${formatPoolValue(managedSize.cpu)} CPU / ${formatPoolValue(managedSize.ram)} GB from your plan's compute pool, plus one agent slot.`}
          </div>

          {managedAgentZero && (
            <fieldset style={{ border: '1px solid var(--etched-border)', padding: '12px 14px', margin: 0, minWidth: 0 }}>
              <legend className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Agent Zero size</legend>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[{ recommended: true, cpu: 2, ram: 4 }, { recommended: false, cpu: floor.cpu, ram: floor.ram }].map((size) => {
                  const selected = useRecommendedAgentZeroSize === size.recommended;
                  const disabled = launching || !managedSizeFits(size.cpu, size.ram);
                  return (
                  <button
                    key={String(size.recommended)}
                    type="button"
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => setUseRecommendedAgentZeroSize(size.recommended)}
                    className="mono"
                    style={{ ...WELCOME_ERROR_ACTION_SECONDARY_STYLE, minHeight: 44,
                      borderColor: selected ? 'var(--ink-black)' : 'var(--etched-border)',
                      background: selected ? 'var(--ink-black)' : 'transparent',
                      color: selected ? 'var(--bg-surface)' : 'var(--text-secondary)',
                      opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
                  >
                    {size.recommended ? 'Recommended' : 'Minimum'}: {size.cpu} CPU / {size.ram} GB
                  </button>
                  );
                })}
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55, margin: '10px 0 0' }}>
                The recommended size gives Agent Zero&apos;s tools and built-in browser more room.
                The minimum uses less of your pool but can be slower under load.
                Both use your existing plan; neither purchases a server or adds model credits.
              </p>
            </fieldset>
          )}

          {selfManaged && launchDestination.selectedTarget && !providerComputer ? (
            <div style={{ border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', padding: '14px 16px', display: 'grid', gap: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800, opacity: 0.62 }}>
                  Resources on this host
                </span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.5 }}>
                  {formatPoolValue(targetCapacity.cpu)} CPU / {formatPoolValue(targetCapacity.ramGb)} GB measured
                </span>
              </div>
              <div className="welcome-size-row">
                <span className="mono welcome-size-label" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.62 }}>
                  <Cpu size={12} /> CPU
                </span>
                {WELCOME_CPU_OPTIONS.map((option) => {
                  const unavailable = option < floor.cpu || option > targetCapacity.cpu;
                  return (
                    <button
                      key={`welcome-dashboard-cpu-${option}`}
                      type="button"
                      className="welcome-size-option"
                      disabled={unavailable}
                      onClick={() => setSelfManagedCpu(option)}
                      aria-label={`Use ${option} CPU`}
                      style={{
                        border: resolvedCpu === option ? '1px solid var(--ink-black)' : '1px solid var(--etched-border)',
                        background: resolvedCpu === option ? 'var(--ink-black)' : 'transparent',
                        color: resolvedCpu === option ? 'var(--bg-surface)' : unavailable ? 'var(--text-muted)' : 'var(--text-secondary)',
                        opacity: unavailable ? 0.35 : 1,
                        fontSize: 12,
                        minHeight: 44,
                        cursor: unavailable ? 'not-allowed' : 'pointer',
                        fontFamily: 'var(--font-mono), monospace',
                      }}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              <div className="welcome-size-row">
                <span className="mono welcome-size-label" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.62 }}>
                  <MemoryStick size={12} /> RAM
                </span>
                {WELCOME_RAM_OPTIONS.map((option) => {
                  const unavailable = option < floor.ram || option > targetCapacity.ramGb;
                  return (
                    <button
                      key={`welcome-dashboard-ram-${option}`}
                      type="button"
                      className="welcome-size-option"
                      disabled={unavailable}
                      onClick={() => setSelfManagedRam(option)}
                      aria-label={`Use ${option} GB RAM`}
                      style={{
                        border: resolvedRam === option ? '1px solid var(--ink-black)' : '1px solid var(--etched-border)',
                        background: resolvedRam === option ? 'var(--ink-black)' : 'transparent',
                        color: resolvedRam === option ? 'var(--bg-surface)' : unavailable ? 'var(--text-muted)' : 'var(--text-secondary)',
                        opacity: unavailable ? 0.35 : 1,
                        fontSize: 12,
                        minHeight: 44,
                        cursor: unavailable ? 'not-allowed' : 'pointer',
                        fontFamily: 'var(--font-mono), monospace',
                      }}
                    >
                      {option}<span style={{ fontSize: 11, opacity: 0.6 }}>G</span>
                    </button>
                  );
                })}
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 11.5, lineHeight: 1.5 }}>
                Capacity comes from the target&apos;s latest successful check and is revalidated when you launch.
              </span>
            </div>
          ) : null}

          {browserCapable && (!selfManaged || launchDestination.selectedTarget) && (
            <label
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: `1px solid ${effectiveBrowser ? 'var(--ink-black)' : 'var(--etched-border)'}`, background: effectiveBrowser ? 'var(--bg-elevated)' : 'rgba(255,255,255,0.02)', padding: '12px 14px', cursor: browserAllowed ? 'pointer' : 'not-allowed', opacity: browserAllowed ? 1 : 0.62 }}
            >
              <input
                type="checkbox"
                checked={effectiveBrowser}
                onChange={(event) => setWantBrowser(event.target.checked)}
                disabled={!browserAllowed}
                style={{ marginTop: 2, accentColor: 'var(--gold-leaf)' }}
              />
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, minWidth: 0 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-black)', fontWeight: 700 }}>
                  <Globe size={13} /> Add a live browser it can act in
                </span>
                <br />
                {browserAllowed
                  ? <>Provisions a real Chrome with a live view you can watch and log into — {welcomeType.name} drives that logged-in session. Uses more resources.</>
                  : <>This host does not have enough measured capacity for the browser-enabled size.</>}
              </span>
            </label>
          )}

          <div style={{ border: '1px solid var(--etched-border)', background: 'rgba(255,255,255,0.02)', padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <ShieldCheck size={15} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, minWidth: 0 }}>
              {selfManaged
                ? launchDestination.selectedTarget
                  ? 'Hivra sends this launch to the verified host you selected. Its credentials, capacity and operating costs remain under your control.'
                  : 'Connect and prepare a host first. Hivra will verify its identity and measured capacity before enabling launch.'
                : hostingDisclaimer(agent as HivraAgentDef)}
            </div>
          </div>

          {supportsManagedVenice && (
            <label
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: `1px solid ${useManagedCredits ? 'var(--ink-black)' : 'var(--etched-border)'}`, background: useManagedCredits ? 'var(--bg-elevated)' : 'rgba(255,255,255,0.02)', padding: '12px 14px', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={useManagedCredits}
                onChange={(event) => handleToggleManagedCredits(event.target.checked)}
                style={{ marginTop: 2, accentColor: 'var(--gold-leaf)' }}
              />
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, minWidth: 0 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-black)', fontWeight: 700 }}>
                  <Coins size={13} /> Power it with my managed Venice credits
                </span>
                <br />
                {agent.connect === 'github'
                  ? <>When you connect GitHub, you can add a billing key to your fork so {agent.name} uses managed Venice credits. You can change this choice during connection.</>
                  : <>At launch, Hivra configures {agent.name} with a billing key for managed Venice. Leave this unchecked to configure your own model provider in the native dashboard before running a task.</>}
                {' '}Model usage is charged to your Hivra credit wallet at provider rates when using managed Venice.
                {managedCreditsActive && (
                  <span className="mono" style={{ display: 'block', marginTop: 8, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, color: managedCreditsChecking ? 'var(--text-muted)' : needsManagedCredits ? '#d97706' : '#16a34a' }}>
                    {managedCreditsChecking
                      ? 'Checking your credit balance…'
                      : needsManagedCredits
                        ? 'No managed credits yet — you’ll add some before launch.'
                        : veniceSummaryFailed
                          ? 'Balance unavailable — you can still launch.'
                          : `${formatMicroUsd(veniceAvailableMicroUsd, 2)} in managed credits ready.`}
                  </span>
                )}
              </span>
            </label>
          )}

          {!selfManaged && atSlotLimit && (
            <div role="alert" style={{ border: '1px solid var(--etched-border)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.55, padding: '12px 14px', display: 'grid', gap: 10 }}>
              <span>You&apos;re at your plan&apos;s agent limit ({slotLimit}). Remove an agent or upgrade to launch {welcomeType.name}.</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => router.push('/dashboard/billing?from=welcome')} className="mono" style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}>
                  Upgrade plan
                </button>
                <button type="button" onClick={() => router.push('/dashboard')} className="mono" style={WELCOME_ERROR_ACTION_SECONDARY_STYLE}>
                  Manage agents
                </button>
              </div>
            </div>
          )}

          {!selfManaged && planLoaded && !atSlotLimit && !managedCapacityReady && (
            <div role="alert" style={{ border: '1px solid var(--etched-border)', padding: '12px 14px', fontSize: 12.5, lineHeight: 1.55 }}>
              {managedAgentZero
                ? <>Your plan limits or remaining pool cannot fit the selected {formatPoolValue(managedSize.cpu)} CPU / {formatPoolValue(managedSize.ram)} GB. Choose the minimum size if available, or resize an existing computer or increase your plan to make room.</>
                : <>Your managed pool does not have the {formatPoolValue(floor.cpu)} CPU / {formatPoolValue(floor.ram)} GB needed for {welcomeType.name}. Resize an existing computer or increase your plan to make room.</>}
            </div>
          )}

          {!selfManaged && resourceLoadError && !planLoaded && (
            <div role="alert" style={{ border: '1px solid #c0392b', background: 'rgba(192,57,43,0.08)', color: '#e06c5a', fontSize: 12.5, padding: '9px 12px', display: 'grid', gap: 8 }}>
              <span>We couldn&apos;t load your plan limits, so launch is paused. This is usually temporary.</span>
              <span className="mono" style={{ fontSize: 10, opacity: 0.6 }}>{resourceLoadError}</span>
              <button
                type="button"
                onClick={() => setResourceLoadAttempt((attempt) => attempt + 1)}
                className="mono"
                style={{ ...WELCOME_ERROR_ACTION_SECONDARY_STYLE, justifySelf: 'start' }}
              >
                Retry plan check
              </button>
            </div>
          )}

          {launchError && (
            <div role="alert" style={{ border: '1px solid #c0392b', background: 'rgba(192,57,43,0.08)', color: '#e06c5a', fontSize: 12.5, lineHeight: 1.55, padding: '9px 12px', display: 'grid', gap: 8 }}>
              <span>{launchError.headline}</span>
              {shouldRenderWelcomeErrorDetail(launchError, selfManaged ? 'self-managed' : 'managed') && (
                <span className="mono" style={{ fontSize: 10, opacity: 0.6 }}>
                  {launchError.detail}
                </span>
              )}
              {launchError.showPlanActions && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => router.push('/dashboard/billing?from=welcome')} className="mono" style={WELCOME_ERROR_ACTION_PRIMARY_STYLE}>
                    Upgrade plan
                  </button>
                  <button type="button" onClick={() => router.push('/dashboard')} className="mono" style={WELCOME_ERROR_ACTION_SECONDARY_STYLE}>
                    Manage agents
                  </button>
                </div>
              )}
            </div>
          )}

          {launching && (
            <p
              id="dashboard-agent-launch-status"
              role="status"
              aria-label="Launch confirmation"
              aria-live="polite"
              aria-atomic="true"
              style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: '12px 0' }}
            >
              <strong style={{ color: 'var(--text-primary)' }}>Waiting for launch confirmation.</strong>
              <br />
              Keep this page open. Once the server accepts your launch, we’ll open the setup page automatically.
              This is a pending request, not installation progress.
            </p>
          )}
          <button
            type="button"
            className="premium-btn"
            onClick={() => (needsManagedCredits ? setShowDepositModal(true) : void launch())}
            disabled={!canLaunch}
            aria-describedby={launching ? 'dashboard-agent-launch-status' : undefined}
            style={{ ...STYLES.primaryButton, opacity: canLaunch ? 1 : 0.55, cursor: launching ? 'wait' : canLaunch ? 'pointer' : 'not-allowed', marginTop: '0.5rem' }}
          >
            {launching || managedCreditsChecking ? (
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            ) : needsManagedCredits ? (
              <Coins size={14} />
            ) : welcomeType.icon === 'messages' ? (
              <MessagesSquare size={14} />
            ) : welcomeType.icon === 'orbit' ? (
              <Orbit size={14} />
            ) : (
              <InfinityIcon size={14} />
            )}
            {launching
              ? `Launching ${welcomeType.name}...`
              : managedCreditsChecking
                ? 'Checking credits...'
                : needsManagedCredits
                  ? 'Add credits to launch'
                  : providerComputer
                    ? 'Launch on this computer'
                    : selfManaged
                      ? `Launch ${welcomeType.name} · ${formatPoolValue(resolvedCpu)} CPU / ${formatPoolValue(resolvedRam)} GB`
                      : `Launch ${welcomeType.name}`}
            {!launching && !managedCreditsChecking && <ArrowRight size={14} />}
          </button>
        </div>
      </div>

      {supportsManagedVenice && (
        <ManagedVeniceDepositModal
          isOpen={showDepositModal}
          initialWalletType="card"
          onClose={() => setShowDepositModal(false)}
          onRefreshSummary={() => {
            void loadVeniceSummary();
          }}
        />
      )}
    </AnimateIn>
  );
}

// ─── Persona picker (agent-type state) ───────────────────────────────────────
//
// Persona-first onboarding (paioclaw-riplist wave). Re-skins the agent-type
// step as named specialist cards over the REAL agent catalog. Each persona maps
// to an existing agent-type key + a personality/emoji preset; selecting one
// reveals an inline personalization panel (name / who-are-you / business /
// goals) bound to personalizationDraft. The "Continue" CTA advances exactly
// like the old technical cards did, so plan/deploy routing is unchanged.
//
// Names are locked (Bea/Sloane/Pike/Marlo/Sable/Lane). Edit only
// WELCOME_PERSONAS in lib/welcome-persona-catalog.ts to re-pitch/re-order.
function PersonaPicker({
  personas,
  selectedPersonaId,
  canDeploy,
  onSelectPersona,
  onContinue,
  advancedAgentTypes,
  selectedAgentTypeKey,
  onSelectAdvancedAgent,
  onOpenSpecialists,
  personalizationDraft,
  setPersonalizationDraft,
  agentName,
  setAgentName,
  customPersonaName,
  setCustomPersonaName,
  customPersonaExpertise,
  setCustomPersonaExpertise,
  customPersonaEmoji,
  setCustomPersonaEmoji,
}: {
  personas: WelcomePersonaDefinition[];
  selectedPersonaId: string | null;
  canDeploy: boolean;
  onSelectPersona: (persona: WelcomePersonaDefinition) => void;
  onContinue: () => void;
  advancedAgentTypes: WelcomeAgentTypeDefinition[];
  selectedAgentTypeKey: WelcomeAgentTypeKey | null;
  onSelectAdvancedAgent: (agentType: WelcomeAgentTypeDefinition) => void;
  onOpenSpecialists: () => void;
  personalizationDraft: WelcomePersonalizationDraft;
  setPersonalizationDraft: React.Dispatch<React.SetStateAction<WelcomePersonalizationDraft>>;
  agentName: string;
  setAgentName: (value: string) => void;
  customPersonaName: string;
  setCustomPersonaName: (value: string) => void;
  customPersonaExpertise: string;
  setCustomPersonaExpertise: (value: string) => void;
  customPersonaEmoji: string;
  setCustomPersonaEmoji: (value: string) => void;
}) {
  const selectedPersona = personas.find((p) => p.id === selectedPersonaId) ?? null;
  const isCustom = Boolean(selectedPersona?.isCustom);
  const draftGoals = Array.isArray(personalizationDraft.goals) ? personalizationDraft.goals : [];

  // ── Onboarding mode toggle (Ash feedback, 2026-07-09) ────────────────────
  // A billing-style segmented control at the TOP of the step splits the two
  // ways to start, instead of burying the agent-type catalog under a collapsed
  // "browse all engines" disclosure:
  //   • "Agents" (DEFAULT + primary) — the real multi-agent catalog (Claude
  //                                  Code / Codex / Aeon / OpenClaw /
  //                                  Agent Zero / plain Hermes).
  //   • "Specialists"               — premade personalities over those agents.
  // Opening Specialists initializes its visible zero-reading default; the
  // default Agents view does not mutate selection. Each lane keeps its existing
  // deploy handler (onSelectPersona / onSelectAdvancedAgent).
  const [mode, setMode] = useState<'specialists' | 'agents'>('agents');
  // A card tap on a phone or touch tablet brings the personalization panel
  // (and its Continue) into view; it renders below every card, so otherwise
  // the tap only seems to flip the card's label.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelScrollRequest, setPanelScrollRequest] = useState(0);
  useEffect(() => {
    if (panelScrollRequest === 0) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panelRef.current?.scrollIntoView?.({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [panelScrollRequest]);
  const handlePersonaTap = (persona: WelcomePersonaDefinition) => {
    onSelectPersona(persona);
    if (window.matchMedia?.(WELCOME_TOUCH_COMPACT_QUERY).matches) setPanelScrollRequest((request) => request + 1);
  };
  const continueBlocked = isCustom && !customPersonaName.trim();

  const handleModeChange = (value: string) => {
    const nextMode = value as 'specialists' | 'agents';
    if (nextMode === mode) return;
    setMode(nextMode);
    if (nextMode === 'specialists') onOpenSpecialists();
  };

  const toggleGoal = (label: string) => {
    setPersonalizationDraft((draft) => {
      const current = Array.isArray(draft.goals) ? draft.goals : [];
      const next = current.includes(label)
        ? current.filter((g) => g !== label)
        : [...current, label];
      return { ...draft, goals: next };
    });
  };

  const chipBase: React.CSSProperties = {
    cursor: 'pointer',
    border: '1px solid var(--etched-border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 600,
    minHeight: 40,
    padding: '9px 13px',
    borderRadius: 0,
    lineHeight: 1.2,
  };
  const chipActive: React.CSSProperties = {
    ...chipBase,
    border: '1px solid var(--ink-black)',
    background: 'var(--ink-black)',
    color: 'var(--bg-surface)',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%',
    border: '1px solid var(--etched-border)',
    background: 'var(--bg-surface)',
    color: 'var(--ink-black)',
    fontSize: 14,
    padding: '10px 12px',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    fontWeight: 800,
    opacity: 0.6,
    marginBottom: 7,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <AnimateIn delay={0.05}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <SubOptionToggle
            left={{ value: 'agents', label: 'Agents' }}
            right={{ value: 'specialists', label: 'Specialists' }}
            active={mode}
            onChange={handleModeChange}
          />
        </div>
      </AnimateIn>

      {mode === 'specialists' && (
      <AnimateIn delay={0.1}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}
        >
          {personas.map((persona) => {
            const selected = persona.id === selectedPersonaId;
            return (
              <button
                key={persona.id}
                type="button"
                data-testid="welcome-persona-card"
                data-persona-id={persona.id}
                aria-label={`${persona.name} — ${persona.role}: ${persona.pitch}`}
                aria-pressed={selected}
                onClick={() => handlePersonaTap(persona)}
                className="sub-glass-card"
                style={{
                  textAlign: 'left',
                  padding: '20px 22px',
                  border: selected ? '2px solid var(--ink-black)' : '1px solid color-mix(in srgb, var(--ink-black) 10%, transparent)',
                  background: selected ? 'color-mix(in srgb, var(--bg-surface) 92%, var(--gold-leaf) 8%)' : 'color-mix(in srgb, var(--bg-surface) 74%, transparent)',
                  minHeight: 196,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      display: 'grid',
                      placeItems: 'center',
                      border: '1px solid var(--etched-border)',
                      background: 'var(--bg-surface)',
                      color: selected ? 'var(--gold-leaf)' : 'var(--ink-black)',
                      fontSize: 20,
                    }}
                  >
                    {persona.isCustom ? renderPersonaIcon(persona.icon) : <span aria-hidden>{persona.emoji}</span>}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <h3 className="serif" style={{ margin: 0, fontSize: 22, fontWeight: 650, letterSpacing: '-0.02em' }}>
                      {persona.name}
                    </h3>
                    <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.16em', opacity: 0.5, fontWeight: 800 }}>
                      {persona.role}
                    </span>
                  </div>
                </div>

                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                  {persona.pitch}
                </p>

                {/* Engine attribution — breadth as displayed credibility. Each
                    specialist states the runtime it runs on; the full catalog
                    lives one tab over in "Agents". */}
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.14em',
                    fontWeight: 800,
                    opacity: 0.5,
                  }}
                >
                  {persona.isCustom
                    ? 'Runs on the engine you pick'
                    : `Runs on ${advancedAgentTypes.find((t) => t.key === persona.agentTypeKey)?.name ?? 'Hermes Agent'}`}
                </span>

                <span
                  className="mono"
                  style={{
                    marginTop: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    fontWeight: 900,
                    color: 'var(--ink-black)',
                  }}
                >
                  {selected ? 'Selected' : 'Choose'} {selected ? <CheckCircle2 size={12} style={{ color: 'var(--gold-leaf)' }} /> : <ArrowRight size={12} />}
                </span>
              </button>
            );
          })}
        </div>
      </AnimateIn>
      )}

      {/* Agents tab — the multi-agent catalog, promoted from a collapsed
          "browse all engines" disclosure into the default toggle mode. SAME
          cards, SAME deploy lanes (general / claude-code / codex / aeon /
          openclaw / agent-zero). Each routes via onSelectAdvancedAgent, which
          clears any persona selection and advances straight into that agent's
          existing deploy flow — so the agent-type deploy payload is unchanged. */}
      {mode === 'agents' && (
        <AnimateIn delay={0.1}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
              }}
            >
              {advancedAgentTypes.map((agentType) => {
                const selected = selectedAgentTypeKey === agentType.key;
                return (
                <button
                  key={agentType.key}
                  type="button"
                  data-testid="welcome-agent-card"
                  data-agent-type={agentType.key}
                  aria-pressed={selected}
                  aria-label={`${agentType.name} — ${agentType.eyebrow}`}
                  onClick={() => onSelectAdvancedAgent(agentType)}
                  className="sub-glass-card"
                  style={{
                    textAlign: 'left',
                    padding: '16px 18px',
                    border: selected
                      ? '2px solid var(--ink-black)'
                      : '1px solid color-mix(in srgb, var(--ink-black) 10%, transparent)',
                    background: selected
                      ? 'color-mix(in srgb, var(--bg-surface) 92%, var(--gold-leaf) 8%)'
                      : 'color-mix(in srgb, var(--bg-surface) 74%, transparent)',
                    minHeight: 168,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div
                      style={{
                        width: 38,
                        height: 38,
                        display: 'grid',
                        placeItems: 'center',
                        border: '1px solid var(--etched-border)',
                        background: 'var(--bg-surface)',
                        color: selected ? 'var(--gold-leaf)' : 'var(--ink-black)',
                        flexShrink: 0,
                      }}
                    >
                      {renderAdvancedAgentIcon(agentType.icon)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <h3 className="serif" style={{ margin: 0, fontSize: 16, fontWeight: 650, letterSpacing: '-0.01em' }}>
                        {agentType.name}
                      </h3>
                      <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', opacity: 0.5, fontWeight: 800 }}>
                        {agentType.eyebrow}
                      </span>
                    </div>
                  </div>
                  <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                    {agentType.tagline}
                  </p>
                  <span style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-muted)', opacity: 0.85 }}>
                    {ADVANCED_AGENT_CONFIG_HINT[agentType.key]}
                  </span>
                  <span
                    className="mono"
                    style={{
                      marginTop: 'auto',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.12em',
                      fontWeight: 900,
                      color: 'var(--ink-black)',
                    }}
                  >
                    {selected ? 'Selected' : 'Choose'}{' '}
                    {selected ? <CheckCircle2 size={11} style={{ color: 'var(--gold-leaf)' }} /> : <ArrowRight size={11} />}
                  </span>
                  </button>
                );
              })}
            </div>

          </div>
        </AnimateIn>
      )}

      {mode === 'specialists' && selectedPersona && (
        <AnimateIn delay={0.05}>
          <div
            ref={panelRef}
            className="sub-glass-card"
            style={{
              scrollMarginTop: 16,
              padding: 'clamp(16px, 5vw, 24px) clamp(16px, 5vw, 26px)',
              border: '1px solid color-mix(in srgb, var(--ink-black) 12%, transparent)',
              background: 'color-mix(in srgb, var(--bg-surface) 80%, transparent)',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            <div>
              <h3 className="serif" style={{ margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: '-0.01em' }}>
                Tell {isCustom ? 'your agent' : selectedPersona.name} a little about you
              </h3>
              <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                Optional, but it makes the first conversation land. Skip any field you like.
              </p>
            </div>

            {isCustom ? (
              <div style={{ display: 'grid', gap: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px', gap: 12 }}>
                  <div>
                    <label htmlFor="welcome-persona-name" style={labelStyle}>Agent name</label>
                    <input
                      id="welcome-persona-name"
                      type="text"
                      autoComplete="off"
                      enterKeyHint="next"
                      value={customPersonaName}
                      onChange={(e) => {
                        setCustomPersonaName(e.target.value);
                        setAgentName(e.target.value);
                        setPersonalizationDraft((d) => ({ ...d, agentName: e.target.value }));
                      }}
                      placeholder="e.g. Nova"
                      maxLength={60}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label htmlFor="welcome-persona-face" style={labelStyle}>Face</label>
                    <input
                      id="welcome-persona-face"
                      type="text"
                      autoComplete="off"
                      value={customPersonaEmoji}
                      onChange={(e) => {
                        setCustomPersonaEmoji(e.target.value);
                        setPersonalizationDraft((d) => ({ ...d, emoji: e.target.value }));
                      }}
                      placeholder="🤖"
                      maxLength={8}
                      style={{ ...inputStyle, textAlign: 'center' }}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="welcome-persona-expertise" style={labelStyle}>Expertise</label>
                  <input
                    id="welcome-persona-expertise"
                    type="text"
                    autoComplete="off"
                    enterKeyHint="next"
                    value={customPersonaExpertise}
                    onChange={(e) => setCustomPersonaExpertise(e.target.value)}
                    placeholder="What is this agent an expert at?"
                    maxLength={200}
                    style={inputStyle}
                  />
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="welcome-persona-agent-name" style={labelStyle}>Agent name</label>
                <input
                  id="welcome-persona-agent-name"
                  type="text"
                  autoComplete="off"
                  enterKeyHint="next"
                  value={agentName}
                  onChange={(e) => {
                    setAgentName(e.target.value);
                    setPersonalizationDraft((d) => ({ ...d, agentName: e.target.value }));
                  }}
                  placeholder={selectedPersona.name}
                  maxLength={60}
                  style={inputStyle}
                />
              </div>
            )}

            <div role="group" aria-labelledby="welcome-persona-who">
              <span id="welcome-persona-who" style={labelStyle}>Who are you?</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {WELCOME_WHO_OPTIONS.map((who) => {
                  const active = (personalizationDraft.who || '') === who;
                  return (
                    <button
                      key={who}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        setPersonalizationDraft((d) => ({ ...d, who: active ? null : who }))
                      }
                      style={active ? chipActive : chipBase}
                    >
                      {who}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor="welcome-persona-business" style={labelStyle}>What are you working on?</label>
              <input
                id="welcome-persona-business"
                type="text"
                autoComplete="off"
                enterKeyHint="done"
                value={personalizationDraft.business || ''}
                onChange={(e) =>
                  setPersonalizationDraft((d) => ({ ...d, business: e.target.value }))
                }
                placeholder="One line about your business or project"
                maxLength={200}
                style={inputStyle}
              />
            </div>

            <div role="group" aria-labelledby="welcome-persona-goals">
              <span id="welcome-persona-goals" style={labelStyle}>What do you want help with?</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {IDENTITY_GOALS.map((goal) => {
                  const active = draftGoals.includes(goal.label);
                  return (
                    <button
                      key={goal.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleGoal(goal.label)}
                      style={active ? chipActive : chipBase}
                    >
                      {goal.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={onContinue}
              disabled={continueBlocked}
              className="mono"
              style={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                border: '1px solid var(--ink-black)',
                background: 'var(--ink-black)',
                color: 'var(--bg-surface)',
                cursor: continueBlocked ? 'not-allowed' : 'pointer',
                opacity: continueBlocked ? 0.5 : 1,
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                fontWeight: 800,
                minHeight: 44,
                padding: '11px 18px',
              }}
            >
              {canDeploy ? 'Continue to deploy' : 'Continue to plan'} <ArrowRight size={14} />
            </button>
          </div>
        </AnimateIn>
      )}

      {mode === 'specialists' && selectedPersona && (
        <div className="welcome-persona-sticky" data-testid="welcome-persona-sticky-continue">
          <button
            type="button"
            onClick={onContinue}
            disabled={continueBlocked}
            className="mono"
            style={{
              width: '100%',
              minHeight: 48,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              border: '1px solid var(--ink-black)',
              background: 'var(--ink-black)',
              color: 'var(--bg-surface)',
              cursor: continueBlocked ? 'not-allowed' : 'pointer',
              opacity: continueBlocked ? 0.5 : 1,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              fontWeight: 800,
              padding: '0 16px',
            }}
          >
            Continue with {isCustom ? customPersonaName.trim() || 'your agent' : selectedPersona.name} <ArrowRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Tier picker (plan state) ────────────────────────────────────────────────
//
// Two-step flow inspired by the /dashboard/billing layout:
//
//   Step 1 (paidPathChoice === null) — "How do you want to pay?"
//     Two big cards: Card vs $HermesOS. Plus a small Free entry below.
//
//   Step 2 (paidPathChoice === 'card' | 'crypto') — Plan grid
//     Sub-toggle on top (Monthly/Yearly for card, Yearly/Permanent for
//     crypto), then Pro and Power side-by-side as compact cards.
//     "← Change payment method" link returns to step 1.

export function TierPickerCards({
  tiers,
  onSelectFree,
  onDeposit,
  onSelectCard,
  onSelectCryptoYearly,
  paidPathChoice,
  setPaidPathChoice,
  cardCadence,
  setCardCadence,
  cryptoMode,
  setCryptoMode,
  cardCheckoutLoadingTier,
  freeActivationLoading,
}: {
  tiers: TierDefinition[];
  onSelectFree: () => void;
  onDeposit: (tier: 'pro' | 'power') => void;
  onSelectCard: (tier: 'pro' | 'power', cadence: 'monthly' | 'yearly') => void;
  onSelectCryptoYearly: (tier: 'pro' | 'power') => void;
  paidPathChoice: 'card' | 'crypto' | null;
  setPaidPathChoice: (c: 'card' | 'crypto' | null) => void;
  cardCadence: 'monthly' | 'yearly';
  setCardCadence: (c: 'monthly' | 'yearly') => void;
  cryptoMode: 'yearly' | 'permanent';
  setCryptoMode: (m: 'yearly' | 'permanent') => void;
  cardCheckoutLoadingTier: 'pro' | 'power' | null;
  freeActivationLoading: boolean;
}) {
  const paidTiers = useMemo(
    () => tiers.filter((t): t is TierDefinition & { key: 'pro' | 'power' } => t.key !== 'free'),
    [tiers],
  );

  if (isCryptoBillingUiEnabled() && paidPathChoice === null) {
    return (
      <PaymentMethodIntro
        onSelectFree={onSelectFree}
        onPickCard={() => setPaidPathChoice('card')}
        onPickCrypto={() => setPaidPathChoice('crypto')}
        freeActivationLoading={freeActivationLoading}
      />
    );
  }

  return (
    <>
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: '8px 8px 8px 14px',
        marginBottom: 20,
      }}
    >
      <span className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, color: 'var(--text-secondary)' }}>
        Free · 0.5 vCPU / 1 GB
      </span>
      <button
        type="button"
        onClick={onSelectFree}
        disabled={freeActivationLoading}
        className="mono"
        style={{ ...WELCOME_ERROR_ACTION_SECONDARY_STYLE, color: 'var(--ink-black)', gap: 8, cursor: freeActivationLoading ? 'wait' : 'pointer', opacity: freeActivationLoading ? 0.7 : 1 }}
      >
        {freeActivationLoading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
        Start with Free
      </button>
    </div>
    <PlanGrid
      tiers={paidTiers}
      paidPathChoice={isCryptoBillingUiEnabled() && paidPathChoice === 'crypto' ? 'crypto' : 'card'}
      onBack={() => setPaidPathChoice(null)}
      cardCadence={cardCadence}
      setCardCadence={setCardCadence}
      cryptoMode={cryptoMode}
      setCryptoMode={setCryptoMode}
      onSelectCard={onSelectCard}
      onSelectCryptoYearly={onSelectCryptoYearly}
      onDeposit={onDeposit}
      cardCheckoutLoadingTier={cardCheckoutLoadingTier}
    />
    </>
  );
}

/**
 * Step 1 — payment method intro.
 *
 * Two big side-by-side cards ask the only question that matters
 * before we show prices: card or token? Each card has an icon, a
 * label, a one-line "what this means", and a savings hint where
 * relevant. Free tier sits below as a quiet alternative — present
 * but not competing for attention.
 */
function PaymentMethodIntro({
  onSelectFree,
  onPickCard,
  onPickCrypto,
  freeActivationLoading,
}: {
  onSelectFree: () => void;
  onPickCard: () => void;
  onPickCrypto: () => void;
  freeActivationLoading: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
      <AnimateIn>
        <div style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
          <span
            className="mono"
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 700,
              opacity: 0.55,
            }}
          >
            How do you want to pay?
          </span>
          <h2
            className="serif"
            style={{
              marginTop: 8,
              fontSize: 'clamp(1.5rem, 3vw, 2rem)',
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            Pick your <em>path</em>.
          </h2>
        </div>
      </AnimateIn>

      <AnimateIn delay={0.1}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '1.25rem',
          }}
        >
          <PaymentMethodOptionCard
            icon={<CreditCard size={20} />}
            label="Card"
            tagline="Monthly or yearly subscription"
            description="Stripe checkout. Cancel any time. Yearly saves up to ~34%."
            onClick={onPickCard}
          />
          <PaymentMethodOptionCard
            icon={<Coins size={20} />}
            label="$HermesOS"
            tagline="Pay with the token · save up to ~59%"
            description="Pay one year up front, or hold tokens to keep your tier as long as you hold."
            onClick={onPickCrypto}
            accent="gold"
          />
        </div>
      </AnimateIn>

      <AnimateIn delay={0.2}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            paddingTop: 8,
          }}
        >
          <button
            type="button"
            onClick={onSelectFree}
            disabled={freeActivationLoading}
            style={{
              minHeight: 44,
              padding: '10px 18px',
              border: '1px solid rgba(22,163,106,0.24)',
              background: 'rgba(22,163,106,0.06)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--ink-black)',
              opacity: freeActivationLoading ? 0.7 : 1,
              cursor: freeActivationLoading ? 'wait' : 'pointer',
            }}
          >
            {freeActivationLoading ? (
              <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <CheckCircle2 size={12} />
            )}
            {freeActivationLoading ? 'Activating free tier...' : 'Start free tier'}
          </button>
        </div>
      </AnimateIn>
    </div>
  );
}

function PaymentMethodOptionCard({
  icon,
  label,
  tagline,
  description,
  onClick,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  tagline: string;
  description: string;
  onClick: () => void;
  accent?: 'gold';
}) {
  const isGold = accent === 'gold';
  return (
    <button
      type="button"
      onClick={onClick}
      className="heavy-glass-card"
      style={{
        padding: '1.5rem 1.5rem 1.75rem',
        cursor: 'pointer',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        position: 'relative',
        background: 'transparent',
        border: `1px solid ${isGold ? 'var(--gold-leaf)' : 'var(--etched-border)'}`,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${isGold ? 'var(--gold-leaf)' : 'var(--ink-black)'}`,
          background: isGold ? 'rgba(255, 44, 45,0.08)' : 'transparent',
          color: isGold ? 'var(--gold-leaf)' : 'var(--ink-black)',
        }}
      >
        {icon}
      </div>

      <h3
        className="serif"
        style={{
          fontSize: '1.4rem',
          fontWeight: 700,
          letterSpacing: '-0.01em',
          margin: 0,
        }}
      >
        {label}
      </h3>

      <span
        className="mono"
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontWeight: 700,
          color: isGold ? 'var(--gold-leaf)' : 'var(--text-secondary)',
        }}
      >
        {tagline}
      </span>

      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.55,
          color: 'var(--text-secondary)',
        }}
      >
        {description}
      </p>

      <span
        style={{
          marginTop: 6,
          alignSelf: 'flex-start',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: isGold ? 'var(--gold-leaf)' : 'var(--ink-black)',
        }}
      >
        Choose <ArrowRight size={12} />
      </span>
    </button>
  );
}

/**
 * Step 2 — plan grid for either path.
 *
 * Top row: a sub-toggle. Card path shows Monthly/Yearly; Crypto path
 * shows Yearly/Permanent. Below the toggle, Pro and Power render side
 * by side with the price + CTA reactive to the current sub-selection.
 *
 * "Permanent" is the user-facing label for crypto-holding because it
 * conveys "as long as you hold the tokens, your tier stays" without
 * sounding like a deposit. Withdraw-anytime is still surfaced via the
 * card subline and the bottom guarantee row.
 */
function PlanGrid({
  tiers,
  paidPathChoice,
  onBack,
  cardCadence,
  setCardCadence,
  cryptoMode,
  setCryptoMode,
  onSelectCard,
  onSelectCryptoYearly,
  onDeposit,
  cardCheckoutLoadingTier,
}: {
  tiers: Array<TierDefinition & { key: 'pro' | 'power' }>;
  paidPathChoice: 'card' | 'crypto';
  onBack: () => void;
  cardCadence: 'monthly' | 'yearly';
  setCardCadence: (c: 'monthly' | 'yearly') => void;
  cryptoMode: 'yearly' | 'permanent';
  setCryptoMode: (m: 'yearly' | 'permanent') => void;
  onSelectCard: (tier: 'pro' | 'power', cadence: 'monthly' | 'yearly') => void;
  onSelectCryptoYearly: (tier: 'pro' | 'power') => void;
  onDeposit: (tier: 'pro' | 'power') => void;
  cardCheckoutLoadingTier: 'pro' | 'power' | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
      <AnimateIn>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          {isCryptoBillingUiEnabled() && <button
            type="button"
            onClick={onBack}
            style={{
              minHeight: 44,
              padding: '6px 12px',
              border: '1px solid var(--etched-border)',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: 'var(--ink-black)',
              opacity: 0.7,
            }}
          >
            Other payment options
          </button>}
          <span
            className="mono"
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
              fontWeight: 700,
              opacity: 0.55,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {paidPathChoice === 'card' ? <CreditCard size={11} /> : <Coins size={11} style={{ color: 'var(--gold-leaf)' }} />}
            Paying with {paidPathChoice === 'card' ? 'Card' : '$HermesOS'}
          </span>
        </div>
      </AnimateIn>

      <AnimateIn delay={0.05}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {paidPathChoice === 'card' ? (
            <SubOptionToggle
              left={{ value: 'monthly', label: 'Monthly' }}
              right={{ value: 'yearly', label: 'Yearly', highlight: 'Save ~34%' }}
              active={cardCadence}
              onChange={(v) => setCardCadence(v as 'monthly' | 'yearly')}
            />
          ) : (
            <SubOptionToggle
              left={{ value: 'yearly', label: 'Yearly · 365 days', highlight: 'Pay once' }}
              right={{ value: 'permanent', label: 'Permanent', highlight: 'Hold to qualify' }}
              active={cryptoMode}
              onChange={(v) => setCryptoMode(v as 'yearly' | 'permanent')}
            />
          )}
        </div>
      </AnimateIn>

      {paidPathChoice === 'crypto' && <CryptoHoldingExplainer mode={cryptoMode} />}

      <AnimateIn delay={0.1}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '1.25rem',
          }}
        >
          {tiers.map((tier) => (
            <PlanGridCard
              key={tier.key}
              tier={tier}
              paidPathChoice={paidPathChoice}
              cardCadence={cardCadence}
              cryptoMode={cryptoMode}
              onSelectCard={onSelectCard}
              onSelectCryptoYearly={onSelectCryptoYearly}
              onDeposit={onDeposit}
              cardCheckoutLoadingTier={cardCheckoutLoadingTier}
            />
          ))}
        </div>
      </AnimateIn>

      <AnimateIn delay={0.2}>
        <div style={STYLES.guarantee}>
          <Shield size={14} style={{ opacity: 0.5 }} />
          <span className="mono" style={STYLES.guaranteeText}>
            {paidPathChoice === 'card'
              ? '48-hour refund on card payments · cancel any time'
              : 'Withdraw anytime · your tokens, your custody · launch rate locked for life'}
          </span>
        </div>
      </AnimateIn>
    </div>
  );
}

function SubOptionToggle({
  left,
  right,
  active,
  onChange,
}: {
  left: { value: string; label: string; highlight?: string };
  right: { value: string; label: string; highlight?: string };
  active: string;
  onChange: (v: string) => void;
}) {
  const segment = (
    opt: { value: string; label: string; highlight?: string },
    isActive: boolean,
  ) => (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => onChange(opt.value)}
      style={{
        padding: '12px 22px',
        border: 'none',
        background: isActive ? 'var(--ink-black)' : 'transparent',
        color: isActive ? 'var(--bg-surface)' : 'var(--ink-black)',
        opacity: isActive ? 1 : 0.65,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono), monospace',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        transition: 'background 150ms ease, color 150ms ease, opacity 150ms ease',
      }}
    >
      {opt.label}
      {opt.highlight && (
        <span
          style={{
            fontSize: 11,
            padding: '2px 6px',
            background: isActive ? 'var(--gold-leaf)' : 'transparent',
            color: isActive ? 'var(--ink-black)' : 'var(--gold-leaf)',
            border: isActive ? 'none' : '1px solid var(--gold-leaf)',
            letterSpacing: '0.08em',
          }}
        >
          {opt.highlight}
        </span>
      )}
    </button>
  );
  return (
    <div role="tablist" style={{ display: 'inline-flex', flexWrap: 'wrap', maxWidth: '100%', border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', padding: 4 }}>
      {segment(left, active === left.value)}
      {segment(right, active === right.value)}
    </div>
  );
}

/**
 * Inline "how this works" block shown above the tier cards on the crypto
 * payment path. Heads off the most common pre-click confusion ("How do I
 * connect my wallet?") by stating up front that no external wallet connect
 * is required — we provision a Hivra deposit wallet server-side and
 * the next screen shows the address + exact $HERMESOS amount to send.
 */
function CryptoHoldingExplainer({ mode }: { mode: 'yearly' | 'permanent' }) {
  const steps =
    mode === 'permanent'
      ? [
          'Click a tier — we show your deposit address and the exact $HERMESOS to send.',
          'Buy $HERMESOS on Uniswap (Base) or send from any wallet you already use.',
          'Send to the address. Tier activates within minutes. Withdraw any time.',
        ]
      : [
          'Click a tier — we show your deposit address and the exact $HERMESOS to send.',
          'Buy $HERMESOS on Uniswap (Base) or send from any wallet you already use.',
          'Send the quoted amount once. Tier stays active for 365 days.',
        ];

  return (
    <AnimateIn delay={0.075}>
      <div
        style={{
          border: '1px solid var(--etched-border)',
          background: 'color-mix(in srgb, var(--gold-leaf) 4%, transparent)',
          padding: '14px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Coins size={12} style={{ color: 'var(--gold-leaf)' }} />
          <span
            className="mono"
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 800,
              color: 'var(--gold-leaf)',
            }}
          >
            How paying in $HermesOS works
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-black)' }}>
          <strong>No external wallet to connect.</strong> We provision a Hivra deposit
          wallet for you automatically — you just send tokens to it.
        </p>
        <ol
          style={{
            margin: 0,
            paddingLeft: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {steps.map((step, idx) => (
            <li
              key={`${mode}:${step}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'var(--text-secondary)',
              }}
            >
              <span
                className="mono"
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 18,
                  height: 18,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid color-mix(in srgb, var(--gold-leaf) 50%, transparent)',
                  fontSize: 11,
                  fontWeight: 800,
                  color: 'var(--gold-leaf)',
                  marginTop: 1,
                }}
              >
                {idx + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </AnimateIn>
  );
}

function PlanGridCard({
  tier,
  paidPathChoice,
  cardCadence,
  cryptoMode,
  onSelectCard,
  onSelectCryptoYearly,
  onDeposit,
  cardCheckoutLoadingTier,
}: {
  tier: TierDefinition & { key: 'pro' | 'power' };
  paidPathChoice: 'card' | 'crypto';
  cardCadence: 'monthly' | 'yearly';
  cryptoMode: 'yearly' | 'permanent';
  onSelectCard: (tier: 'pro' | 'power', cadence: 'monthly' | 'yearly') => void;
  onSelectCryptoYearly: (tier: 'pro' | 'power') => void;
  onDeposit: (tier: 'pro' | 'power') => void;
  cardCheckoutLoadingTier: 'pro' | 'power' | null;
}) {
  const isPower = tier.key === 'power';
  const isThisTierLoading =
    paidPathChoice === 'card' && cardCheckoutLoadingTier === tier.key;
  const isAnyCardLoading =
    paidPathChoice === 'card' && cardCheckoutLoadingTier !== null;

  // Resolve price + period + CTA from the current selection.
  let priceDisplay: string;
  let periodLabel: string;
  let subline: string | null;
  let ctaLabel: string;
  let onCta: () => void;

  if (paidPathChoice === 'card') {
    // The subline must describe the SELECTED cadence; the alternative is
    // labeled as such. The old copy put the other cadence's price next to
    // "save ~34%", reading like the wrong plan carried the discount.
    if (cardCadence === 'yearly') {
      priceDisplay = tier.cardYearlyPriceLabel?.split('/')[0] ?? '$79';
      periodLabel = '/yr';
      const monthly = tier.cardMonthlyPriceLabel ?? '$9.99/mo';
      subline = `Billed yearly · save ~34% — or ${monthly} billed monthly`;
      ctaLabel = `Subscribe · ${tier.cardYearlyPriceLabel ?? '$79/yr'}`;
      onCta = () => onSelectCard(tier.key, 'yearly');
    } else {
      priceDisplay = tier.cardMonthlyPriceLabel?.split('/')[0] ?? '$9.99';
      periodLabel = '/mo';
      const yearly = tier.cardYearlyPriceLabel ?? '$79/yr';
      subline = `Billed monthly — or ${yearly} billed yearly (save ~34%)`;
      ctaLabel = `Subscribe · ${tier.cardMonthlyPriceLabel ?? '$9.99/mo'}`;
      onCta = () => onSelectCard(tier.key, 'monthly');
    }
  } else if (cryptoMode === 'yearly') {
    priceDisplay = `$${tier.cryptoYearlyUsd ?? 49}`;
    periodLabel = 'in $HERMESOS';
    subline = `Pay once · 365 days of ${tier.name} · non-refundable`;
    ctaLabel = `Pay 1 year · $${tier.cryptoYearlyUsd ?? 49}`;
    onCta = () => onSelectCryptoYearly(tier.key);
  } else {
    priceDisplay = `$${tier.launchUsd}`;
    periodLabel = 'in $HERMESOS';
    subline = `Hold tokens · keep ${tier.name} as long as your balance ≥ threshold · withdraw any time`;
    ctaLabel = `Lock 33% Off · Hold $${tier.launchUsd}`;
    onCta = () => onDeposit(tier.key);
  }

  return (
    <div
      className="heavy-glass-card"
      style={{
        padding: '1.75rem 1.5rem',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        border: isPower ? '1px solid var(--gold-leaf)' : '1px solid var(--etched-border)',
      }}
    >
      {isPower && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: 'var(--gold-leaf)',
          }}
        />
      )}

      <span
        className="mono"
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          opacity: 0.55,
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        {isPower ? 'Recommended' : 'Starter'}
      </span>

      <h3
        className="serif"
        style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.01em', margin: '0 0 12px 0' }}
      >
        {tier.name}
      </h3>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span className="serif" style={{ fontSize: '2.4rem', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' }}>
          {priceDisplay}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            opacity: 0.5,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          {periodLabel}
        </span>
      </div>
      {subline && (
        <span
          className="mono"
          style={{
            fontSize: 10,
            opacity: 0.6,
            letterSpacing: '0.04em',
            marginBottom: 18,
            lineHeight: 1.5,
          }}
        >
          {subline}
        </span>
      )}

      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          paddingBottom: 14,
          marginBottom: 14,
          borderBottom: '1px solid var(--etched-border)',
        }}
      >
        <span className="mono" style={{ fontSize: 10, opacity: 0.65 }}>
          {tier.spec}
        </span>
      </div>

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: '0 0 1.25rem 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          flex: 1,
        }}
      >
        {tier.features.slice(0, 4).map((feat) => (
          <li
            key={feat}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 12,
              lineHeight: 1.5,
              opacity: 0.85,
            }}
          >
            <CheckCircle size={11} style={{ color: 'var(--gold-leaf)', flexShrink: 0, marginTop: 3 }} />
            <span>{feat}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onCta}
        disabled={isAnyCardLoading}
        className="premium-btn premium-btn-primary"
        style={{
          ...STYLES.primaryButton,
          opacity: isAnyCardLoading && !isThisTierLoading ? 0.4 : 1,
          cursor: isAnyCardLoading ? 'wait' : 'pointer',
        }}
      >
        {isThisTierLoading ? (
          <>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            Opening secure checkout…
          </>
        ) : (
          <>
            {ctaLabel}
            <ArrowRight size={14} />
          </>
        )}
      </button>
    </div>
  );
}
