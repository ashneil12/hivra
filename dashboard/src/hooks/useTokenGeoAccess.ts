"use client";

import { useEffect, useState } from "react";

import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";

/**
 * Whether this viewer may see token features (lib/compliance/token-geo-policy.ts).
 *
 * - Dormant policy (no country listed): "allowed" at once, with no request.
 * - Otherwise the server decides (GET /api/token-geo). Until it answers, or if
 *   it cannot, token promotions stay hidden ("checking" / "unavailable"): the
 *   card path is always there, and the server refuses a blocked token action
 *   whatever the UI shows. Only "blocked" carries the notice.
 *
 * The answer is shared for ANSWER_TTL_MS so several components on one page ask
 * once. Failures are not kept.
 */
export type TokenGeoAccess =
  | { status: "allowed"; notice: null }
  | { status: "checking"; notice: null }
  | { status: "blocked"; notice: string }
  | { status: "unavailable"; notice: null };

const ALLOWED: TokenGeoAccess = { status: "allowed", notice: null };
const CHECKING: TokenGeoAccess = { status: "checking", notice: null };
const UNAVAILABLE: TokenGeoAccess = { status: "unavailable", notice: null };
const ANSWER_TTL_MS = 60_000;

let cached: { at: number; answer: Promise<TokenGeoAccess> } | null = null;

function fetchTokenGeoAccess(): Promise<TokenGeoAccess> {
  if (cached && Date.now() - cached.at < ANSWER_TTL_MS) return cached.answer;
  const answer: Promise<TokenGeoAccess> = fetch("/api/token-geo", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { blocked?: unknown; notice?: unknown } | null): TokenGeoAccess => {
      if (!body || typeof body.blocked !== "boolean") return UNAVAILABLE;
      if (!body.blocked) return ALLOWED;
      return typeof body.notice === "string" && body.notice
        ? { status: "blocked", notice: body.notice }
        : UNAVAILABLE;
    })
    .catch((): TokenGeoAccess => UNAVAILABLE)
    .then((resolved) => {
      if (resolved.status === "unavailable" && cached?.answer === answer) cached = null;
      return resolved;
    });
  cached = { at: Date.now(), answer };
  return answer;
}

/** Test seam. */
export function _resetTokenGeoAccessForTests() {
  cached = null;
}

export function useTokenGeoAccess(): TokenGeoAccess {
  const active = isTokenGeoPolicyActive();
  const [state, setState] = useState<TokenGeoAccess>(active ? CHECKING : ALLOWED);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchTokenGeoAccess().then((answer) => {
      if (!cancelled) setState(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return active ? state : ALLOWED;
}

/** True only when the server confirmed this viewer is not blocked (or the policy is dormant). */
export function tokenFeaturesShown(access: TokenGeoAccess): boolean {
  return access.status === "allowed";
}
