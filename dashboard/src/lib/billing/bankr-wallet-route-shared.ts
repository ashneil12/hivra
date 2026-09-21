// Shared scaffolding for the two Bankr agent-wallet wallet routes:
//
//   GET/POST /api/instances/[id]/bankr-wallet     (Hermes instance lane)
//   GET/POST /api/hivra/agents/[id]/bankr-wallet  (Hivra-catalog lane)
//
// Only the SCAFFOLDING consolidates here. Credential delivery genuinely
// differs per lane (the instance route rewrites the agent YAML via the
// running-agent config API; the Hivra route seeds ~/.hivra/bankr.env over
// SSH), and so do the ownership table, the type gate, and the response
// envelope — none of that lives here.

import { auth } from "@clerk/nextjs/server";

import { apiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";

export type WalletRouteIdentity =
  | { ok: true; id: string; userId: string }
  | { ok: false; response: Response };

/**
 * Resolve `{ id, userId }` for a Bankr wallet route, short-circuiting the
 * standard 401/500 responses. Behaviourally identical to the inline
 * prologue both routes previously carried in GET and POST.
 */
export async function resolveWalletRouteIdentity(
  ctx: { params: Promise<{ id: string }> }
): Promise<WalletRouteIdentity> {
  const { id } = await ctx.params;
  const { userId } = await auth();
  if (!userId) return { ok: false, response: apiError("Unauthorized", 401) };
  if (!supabaseAdmin) return { ok: false, response: apiError("Database not configured", 500) };
  return { ok: true, id, userId };
}
