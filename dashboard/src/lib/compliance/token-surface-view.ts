import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";

/**
 * What one request may be shown about the $HIVRA and $HermesOS token surfaces.
 *
 * A public page that mentions a token (a sentence, a link, a metadata field, a
 * JSON-LD block, a line of llms.txt) shows it only when BOTH hold:
 *
 *  - the switch is on (HIVRA_NEW_TOKEN_SURFACES, lib/token-surfaces.ts), and
 *  - the viewer is not blocked by the token geo-policy (lib/compliance).
 *
 * Server side only: it reads the environment and may read the request.
 */
export interface TokenSurfaceView {
  /** The switch is on. Off is the production default: nothing token related renders. */
  tokenSurfaces: boolean;
  /** The switch is on and this viewer is in a listed country (or stored as one). */
  geoBlocked: boolean;
}

/**
 * Resolve the view once per page render (the same pattern as app/roadmap/page.tsx).
 *
 * - Switch off: nothing is read, not even the request country.
 * - Switch on, no country listed: the dormant policy answers "not blocked" without
 *   reading headers or the session, so the page stays static.
 * - Switch on, a country listed: the page is rendered per request and a blocked
 *   viewer gets `geoBlocked: true`.
 *
 * Pass `userId` only when the page already has it.
 */
export async function getTokenSurfaceView(userId?: string | null): Promise<TokenSurfaceView> {
  if (!newTokenSurfacesEnabled()) return { tokenSurfaces: false, geoBlocked: false };
  const decision = await resolveTokenGeoBlockForPage(userId);
  return { tokenSurfaces: true, geoBlocked: decision.blocked };
}

/**
 * Whether token copy may render for this view. Use it for everything that is not
 * JSX: page metadata, structured data, llms.txt lines and filtered link lists.
 */
export function tokenSurfacesVisible(view: TokenSurfaceView): boolean {
  return view.tokenSurfaces && !view.geoBlocked;
}
