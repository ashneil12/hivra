"use client";

import { useCallback, useEffect, useState } from "react";

import { getDigitalOceanBalance, type DigitalOceanBalance } from "@/lib/hivra/managed-session-client";

export const DIGITALOCEAN_BILLING_URL = "https://cloud.digitalocean.com/account/billing";

type Result = { attempt: number; balance: DigitalOceanBalance | null; error: string | null };

/** The team's prepaid Harness Runtime balance, read from DigitalOcean when shown. */
export function useDigitalOceanBalance(connectionId: string, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getDigitalOceanBalance(connectionId, controller.signal)
      .then((balance) => setResult({ attempt, balance, error: null }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ attempt, balance: null, error: cause instanceof Error ? cause.message : "DigitalOcean's balance could not be read." });
      });
    return () => controller.abort();
  }, [attempt, connectionId, enabled]);

  const recheck = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    // The last observed balance stays visible while a re-check runs.
    balance: result?.balance ?? null,
    error: result?.attempt === attempt ? result.error : null,
    checking: enabled && result?.attempt !== attempt,
    recheck,
  };
}
