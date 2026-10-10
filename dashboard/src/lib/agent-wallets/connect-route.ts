// Request handling shared by the two "connect your own Bankr account" routes:
//
//   POST/DELETE /api/instances/[id]/bankr-wallet/connect     Hermes lane
//   POST/DELETE /api/hivra/agents/[id]/bankr-wallet/connect  Hivra lane
//
// The key is a user-supplied credential, handled like the vault's: parsed,
// rate limited with the secret-write preset, stored encrypted, and never
// logged or returned (only its preview is).

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { AgentWalletConnectError } from "@/lib/billing/bankr-instance-wallets";

export const connectBankrWalletBodySchema = z.object({
  apiKey: z.string().trim().min(1, "Paste your Bankr API key.").max(512),
  // Explicit, per-agent consent. The dialog shows the wording versioned by
  // AGENT_WALLET_CONNECT_CONSENT_VERSION; the server records that version.
  consent: z.literal(true, {
    errorMap: () => ({ message: "Confirm that this agent may use your Bankr API key." }),
  }),
  replaceProvisionedWallet: z.boolean().optional(),
});

export type ConnectBankrWalletBody = z.infer<typeof connectBankrWalletBodySchema>;

export function enforceConnectRateLimit(req: NextRequest, userId: string, routeKey: string): Response | null {
  return enforceAuthenticatedRouteRateLimit(req, {
    routeKey,
    userId,
    ...RATE_LIMIT_PRESETS.secretWrite,
  });
}

export async function parseConnectBody(
  req: NextRequest
): Promise<{ ok: true; body: ConnectBankrWalletBody } | { ok: false; response: Response }> {
  const json = await req.json().catch(() => null);
  const parsed = connectBankrWalletBodySchema.safeParse(json);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message || "Invalid request";
    return {
      ok: false,
      response: apiError(message, 400, { failureType: "agent_wallet_connect_invalid_body" }),
    };
  }
  return { ok: true, body: parsed.data };
}

/** Map a connect/disconnect refusal to its response; null for anything else. */
export function connectErrorResponse(err: unknown, failureTypePrefix: string): Response | null {
  if (!(err instanceof AgentWalletConnectError)) return null;
  return apiError(
    err.message,
    err.httpStatus,
    { failureType: `${failureTypePrefix}_${err.code}` },
    { code: err.code }
  );
}
