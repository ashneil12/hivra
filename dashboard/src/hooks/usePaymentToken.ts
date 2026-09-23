"use client";

import { useEffect, useState } from "react";

import {
  isHivraActive,
  isPlatformTokenKey,
  platformTokenByKey,
  primaryPlatformToken,
  type PlatformToken,
} from "@/lib/billing/token-registry";

/**
 * The token this user pays and holds in. Before $HIVRA is live that is
 * $HermesOS for everyone, with no request. Once it is live the server decides
 * (a grandfathered user keeps $HermesOS, everyone else pays in $HIVRA), so the
 * hook asks /api/billing/token-access once per page load and shares the
 * answer. Until it answers, or if it cannot, the label is the token new users
 * pay in; the quote itself always names its own token and contract.
 */
let pending: Promise<PlatformToken | null> | null = null;

function fetchPaymentToken(): Promise<PlatformToken | null> {
  pending ??= fetch("/api/billing/token-access", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { data?: { paymentToken?: unknown } } | null) => {
      const key = body?.data?.paymentToken;
      return isPlatformTokenKey(key) ? platformTokenByKey(key) : null;
    })
    .catch(() => null);
  return pending;
}

/** Test seam. */
export function _resetPaymentTokenForTests() {
  pending = null;
}

export function usePaymentToken(): PlatformToken {
  const [token, setToken] = useState<PlatformToken>(() => primaryPlatformToken());
  useEffect(() => {
    if (!isHivraActive()) return;
    let cancelled = false;
    void fetchPaymentToken().then((resolved) => {
      if (!cancelled && resolved) setToken(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return token;
}

/** The display unit ("$HermesOS", "$HIVRA") of usePaymentToken. */
export function usePaymentTokenUnit(): string {
  return usePaymentToken().displayUnit;
}
