"use client";

import { useAuth } from "@clerk/nextjs";
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
 * hook asks /api/billing/token-access and shares the answer per signed-in
 * user for ANSWER_TTL_MS. Failures are not kept, so the next mount retries.
 * Until it answers, or if it cannot, the label is the token new users pay in;
 * the quote itself always names its own token and contract.
 */
const ANSWER_TTL_MS = 60_000;
const answers = new Map<string, { at: number; token: Promise<PlatformToken | null> }>();

function fetchPaymentToken(userId: string): Promise<PlatformToken | null> {
  const cached = answers.get(userId);
  if (cached && Date.now() - cached.at < ANSWER_TTL_MS) return cached.token;
  const token = fetch("/api/billing/token-access", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { data?: { paymentToken?: unknown } } | null) => {
      const key = body?.data?.paymentToken;
      return isPlatformTokenKey(key) ? platformTokenByKey(key) : null;
    })
    .catch(() => null)
    .then((resolved) => {
      if (!resolved) answers.delete(userId);
      return resolved;
    });
  answers.set(userId, { at: Date.now(), token });
  return token;
}

/** Test seam. */
export function _resetPaymentTokenForTests() {
  answers.clear();
}

export function usePaymentToken(): PlatformToken {
  const { userId } = useAuth();
  const [answer, setAnswer] = useState<{ userId: string; token: PlatformToken } | null>(null);
  useEffect(() => {
    if (!userId || !isHivraActive()) return;
    let cancelled = false;
    void fetchPaymentToken(userId).then((resolved) => {
      if (!cancelled && resolved) setAnswer({ userId, token: resolved });
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  // Read at render: the fallback follows the activation instant, and an
  // answer only ever applies to the user it was fetched for.
  return answer && answer.userId === userId ? answer.token : primaryPlatformToken();
}

/** The display unit ("$HermesOS", "$HIVRA") of usePaymentToken. */
export function usePaymentTokenUnit(): string {
  return usePaymentToken().displayUnit;
}
