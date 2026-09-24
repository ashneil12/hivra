import { type TopUpPackageCredits } from "@/lib/billing/credits";
import { readJsonWithDiagnostics } from "@/lib/client/json-response-diagnostics";
import { safeReturnPath } from "@/lib/safe-return-path";
import { type PlanKey } from "@/lib/subscription";

import {
  isBillingSubscribeReason,
  type BillingSubscribeReason,
} from "./subscribe-errors";

type CheckoutSuccessPayload = {
  success: true;
  data?: {
    url?: string;
    resumed?: boolean;
    activated?: boolean;
  };
};

type CheckoutErrorPayload = {
  success: false;
  error?: string;
  reason?: unknown;
};

export type CheckoutRequestResult =
  | {
      ok: true;
      url: string;
      resumed: boolean;
      activated?: false;
    }
  | {
      ok: true;
      activated: true;
    }
  | {
      ok: false;
      message: string;
      reason: BillingSubscribeReason | null;
      status: number;
    };

export type CheckoutRedirectResult =
  | { ok: true }
  | { ok: false; message: string };

function isCheckoutSuccessPayload(value: unknown): value is CheckoutSuccessPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      "success" in value &&
      (value as CheckoutSuccessPayload).success === true &&
      (
        typeof (value as CheckoutSuccessPayload).data?.url === "string" ||
        (value as CheckoutSuccessPayload).data?.activated === true
      )
  );
}

function isCheckoutErrorPayload(value: unknown): value is CheckoutErrorPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      "success" in value &&
      (value as CheckoutErrorPayload).success === false
  );
}

async function readJsonSafely(response: Response): Promise<unknown | null> {
  return readJsonWithDiagnostics(response, {
    source: "billing-client",
    route: typeof window !== "undefined" ? window.location.pathname : undefined,
  });
}

export function redirectToCheckoutUrl(url: string): CheckoutRedirectResult {
  try {
    const parsedUrl = new URL(url);

    if (!/^https?:$/i.test(parsedUrl.protocol)) {
      return {
        ok: false,
        message: "Couldn't open secure checkout. Please try again.",
      };
    }

    window.location.assign(parsedUrl.toString());
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Couldn't open secure checkout. Please try again.",
    };
  }
}

// First-touch UTM/referrer stash written by PostHogProvider on the landing
// pageview. Forwarded to /api/billing/subscribe so signup attribution lands on
// the subscription row (the server persists it write-once).
function readSignupAttribution(): Record<string, unknown> | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem("hermes:signup_attribution");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // localStorage unavailable (Safari Private, etc.) or corrupt stash —
    // attribution is best-effort only.
    return null;
  }
}

export async function requestSubscriptionCheckout(
  plan: PlanKey,
  cadence: "monthly" | "yearly" = "monthly",
  // Where Stripe's success and cancel pages lead back to, e.g. the launch
  // draft an upgrade started from. The server validates it again.
  { returnTo = null }: { returnTo?: string | null } = {}
): Promise<CheckoutRequestResult> {
  try {
    const attribution = readSignupAttribution();
    const safeReturnTo = safeReturnPath(returnTo);
    const response = await fetch("/api/billing/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan,
        cadence,
        ...(attribution ? { attribution } : {}),
        ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
      }),
    });
    const payload = await readJsonSafely(response);

    if (isCheckoutSuccessPayload(payload) && payload.data?.url) {
      // Stash plan + cadence so PostHogProvider's frontend-redirect capture
      // of `checkout_payment_completed` can include them. Without this, the
      // success-page event has null plan/payment_status (the authoritative
      // server-side webhook capture has them but arrives later).
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            "hermes:checkout_plan",
            JSON.stringify({ plan, cadence, started_at: Date.now() })
          );
        }
      } catch {
        // localStorage unavailable (Safari Private, etc.) — proceed; the
        // redirect capture will fall back to via_checkout_flow=false.
      }
      return {
        ok: true,
        url: payload.data.url,
        resumed: payload.data.resumed === true,
      };
    }

    if (isCheckoutSuccessPayload(payload) && payload.data?.activated === true) {
      return {
        ok: true,
        activated: true,
      };
    }

    if (isCheckoutErrorPayload(payload)) {
      return {
        ok: false,
        message: payload.error || "Failed to start checkout. Please try again.",
        reason: isBillingSubscribeReason(payload.reason) ? payload.reason : null,
        status: response.status,
      };
    }

    return {
      ok: false,
      message: "Failed to start checkout. Please try again.",
      reason: null,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      message: "Failed to start checkout. Please try again.",
      reason: null,
      status: 0,
    };
  }
}

export async function requestCreditTopUpCheckout(
  packageCredits: TopUpPackageCredits
): Promise<CheckoutRequestResult> {
  try {
    const response = await fetch("/api/billing/top-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageCredits }),
    });
    const payload = await readJsonSafely(response);

    if (isCheckoutSuccessPayload(payload) && payload.data?.url) {
      return {
        ok: true,
        url: payload.data.url,
        resumed: payload.data.resumed === true,
      };
    }

    if (isCheckoutErrorPayload(payload)) {
      return {
        ok: false,
        message: payload.error || "Failed to start credit top-up. Please try again.",
        reason: null,
        status: response.status,
      };
    }

    return {
      ok: false,
      message: "Failed to start credit top-up. Please try again.",
      reason: null,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      message: "Failed to start credit top-up. Please try again.",
      reason: null,
      status: 0,
    };
  }
}

export async function requestManagedVeniceCardTopUpCheckout(
  amountMicroUsd: number
): Promise<CheckoutRequestResult> {
  try {
    const response = await fetch("/api/billing/managed-venice/card/top-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountMicroUsd }),
    });
    const payload = await readJsonSafely(response);

    if (isCheckoutSuccessPayload(payload) && payload.data?.url) {
      return {
        ok: true,
        url: payload.data.url,
        resumed: payload.data.resumed === true,
      };
    }

    if (isCheckoutErrorPayload(payload)) {
      return {
        ok: false,
        message: payload.error || "Failed to start managed Venice card top-up. Please try again.",
        reason: null,
        status: response.status,
      };
    }

    return {
      ok: false,
      message: "Failed to start managed Venice card top-up. Please try again.",
      reason: null,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      message: "Failed to start managed Venice card top-up. Please try again.",
      reason: null,
      status: 0,
    };
  }
}
