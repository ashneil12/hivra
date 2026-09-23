/**
 * Which billing tab is showing, as pure functions so the deep-link mapping
 * and the URL mirroring are unit-testable without rendering the page.
 */

export const BILLING_TAB_IDS = ["overview", "plans", "payments", "credits", "history"] as const;
export type BillingTabId = (typeof BILLING_TAB_IDS)[number];

export const BILLING_TAB_LABELS: Record<BillingTabId, string> = {
  overview: "Overview",
  plans: "Plans",
  payments: "Payment methods",
  credits: "Credits",
  history: "History",
};

/** DOM id prefix shared by the tablist and its panels. */
export const BILLING_TABS_ID_PREFIX = "billing";

export function isBillingTabId(value: unknown): value is BillingTabId {
  return typeof value === "string" && (BILLING_TAB_IDS as readonly string[]).includes(value);
}

/**
 * Tabs the current build can show. Credits holds card credits (billing v2)
 * and USDC top-ups (crypto); History is the billing v2 activity feed.
 */
export function visibleBillingTabs(flags: {
  billingV2Enabled: boolean;
  cryptoBillingEnabled: boolean;
}): BillingTabId[] {
  return BILLING_TAB_IDS.filter((id) => {
    if (id === "credits") return flags.billingV2Enabled || flags.cryptoBillingEnabled;
    if (id === "history") return flags.billingV2Enabled;
    return true;
  });
}

type ParamReader = { get(key: string): string | null } | null | undefined;

// `?from=` values that mean "the user came here to pick a plan".
const PLAN_PICKING_SOURCES = new Set(["paywall", "welcome", "launch", "warm_pool", "cancel_save"]);

/**
 * The tab an inbound link asks for, or null when it asks for none. Read once
 * when the page mounts: the page strips some of these params from the URL as
 * soon as it has acted on them.
 *
 * Precedence: an explicit `?tab=`; then links about the current plan
 * (backups, checkout return, storage); then plan-picking links (`?plan=`,
 * `?cadence=`, `?yearly_token=1`, `?from=paywall|welcome|…`); then credits
 * links (`?managedVenice=…`, `?credits=…`, `#managed-venice`).
 */
export function deepLinkBillingTab(params: ParamReader, hash: string | null | undefined): BillingTabId | null {
  const read = (key: string) => {
    const value = params?.get(key);
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  const tab = read("tab");
  if (isBillingTabId(tab)) return tab;

  if (read("intent") === "backups" || read("subscription") === "success" || read("storage_expanded")) {
    return "overview";
  }

  const from = read("from");
  if (read("plan") || read("cadence") || read("yearly_token") === "1" || (from && PLAN_PICKING_SOURCES.has(from))) {
    return "plans";
  }

  if (read("managedVenice") || read("credits")) return "credits";

  if ((hash ?? "").replace(/^#/, "") === "managed-venice") return "credits";

  return null;
}

/**
 * The tab to show: the requested one when this build shows it, otherwise
 * Overview for anyone with a plan and Plans for everyone else.
 */
export function resolveBillingTab(params: {
  requested: BillingTabId | null;
  visible: readonly BillingTabId[];
  subscribed: boolean;
}): BillingTabId {
  if (params.requested && params.visible.includes(params.requested)) return params.requested;
  return params.subscribed ? "overview" : "plans";
}

/**
 * The same URL with `?tab=` set, every other param and the hash kept.
 * Returned as a path (no origin) for window.history.replaceState.
 */
export function billingTabUrl(currentHref: string, tab: BillingTabId): string {
  const url = new URL(currentHref, "http://localhost");
  url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}${url.hash}`;
}
