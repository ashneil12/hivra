// The browser's calls for maker claims and the catalog's order. Each answers
// null (or nothing) when the request fails, so a page can carry on without it.

import type { CatalogClaimView } from "@/lib/hivra/catalog-claim-types";
import type { LaunchProfileId } from "@/lib/launch/contracts";

interface Reply<T> { success?: boolean; data?: T }

async function read<T>(request: Promise<Response>): Promise<T | null> {
  try {
    const response = await request;
    if (!response.ok) return null;
    const reply = await response.json() as Reply<T> | null;
    return reply?.success && reply.data ? reply.data : null;
  } catch {
    return null;
  }
}

export async function fetchCatalogClaim(profileId: LaunchProfileId, signal?: AbortSignal): Promise<CatalogClaimView | null> {
  const data = await read<{ claim?: CatalogClaimView }>(
    fetch(`/api/hivra/catalog/claims?profile=${encodeURIComponent(profileId)}`, { cache: "no-store", signal }),
  );
  return data?.claim ?? null;
}

export async function sendCatalogClaim(profileId: LaunchProfileId, action: "start" | "check"): Promise<CatalogClaimView | null> {
  const data = await read<{ claim?: CatalogClaimView }>(
    fetch("/api/hivra/catalog/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: profileId, action }),
    }),
  );
  return data?.claim ?? null;
}

/** Agent types by use, most used first; empty when nothing is known. */
export async function fetchCatalogOrder(signal?: AbortSignal): Promise<string[]> {
  const data = await read<{ order?: unknown }>(fetch("/api/hivra/catalog/order", { signal }));
  return Array.isArray(data?.order) ? data.order.filter((type): type is string => typeof type === "string") : [];
}
