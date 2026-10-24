import type { ReactNode } from "react";

// A type import is erased, so this file stays free of the server-only modules
// (next/headers) that lib/compliance/token-surface-view.ts reaches.
import type { TokenSurfaceView } from "@/lib/compliance/token-surface-view";

export interface TokenSurfaceGateProps {
  /** Resolved once at the top of the page with `await getTokenSurfaceView()`. */
  view: TokenSurfaceView;
  /** Shown when the token surfaces are hidden for this viewer. Nothing by default. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Renders its children only when the token surfaces are on and the viewer is not
 * geo-blocked. Wrap every sentence, list item, link or block that names a token,
 * the migration, the snapshot, an airdrop, the litepaper or tokenomics.
 *
 * It takes the resolved `view` instead of reading the request itself, so it works
 * inside nested lists and in tests, and a page resolves the geo policy exactly once
 * (the same view also gates metadata, JSON-LD and llms.txt lines through
 * `tokenSurfacesVisible`). The rule matches `tokenSurfacesVisible`.
 */
export function TokenSurfaceGate({ view, fallback = null, children }: TokenSurfaceGateProps) {
  return <>{view.tokenSurfaces && !view.geoBlocked ? children : fallback}</>;
}

export default TokenSurfaceGate;
