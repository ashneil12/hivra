import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  RATE_LIMIT_PRESETS,
  enforceAuthenticatedRouteRateLimit,
} from "@/lib/authenticated-rate-limit";
import {
  AgentModelKeyInUseError,
  createManagedVeniceProxyKey,
  listManagedVeniceProxyKeys,
  revokeManagedVeniceProxyKey,
} from "@/lib/venice/proxy-keys";

const CreateKeySchema = z.object({
  name: z.string().trim().max(80).optional(),
  // Which wallet the key bills by default ("hermesos" when omitted — the
  // historical behavior). The chat proxy reads this off the verified key at
  // request time, so card-funded users need card-typed keys or every
  // reservation lands on an empty hermesos wallet.
  walletType: z.enum(["card", "hermesos"]).optional(),
});

export async function GET() {
  let userIdForLog: string | null = null;
  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const keys = await listManagedVeniceProxyKeys(userId);
    return apiSuccess({ keys });
  } catch (error) {
    return apiError(
      "Failed to list managed Venice proxy keys.",
      500,
      {
        failureType: "managed_venice_keys_list_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "managed-venice/keys",
        route: "/api/managed-venice/keys",
        method: "GET",
        userId: userIdForLog,
        failureType: "managed_venice_keys_list_failed",
        cause: error,
      }
    );
  }
}

export async function POST(request: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "managed_venice_keys_post",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return rateLimitError;

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const parsed = CreateKeySchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid managed Venice key request.", 400, {
        failureType: "managed_venice_keys_invalid_create_request",
      });
    }

    const key = await createManagedVeniceProxyKey({
      userId,
      name: parsed.data.name,
      defaultWalletType: parsed.data.walletType,
    });
    // The plaintext key is intentionally returned exactly once at creation
    // (it's stored only as a hash — there is no way to re-fetch it later).
    // Mark the response no-store so the one-time secret is never cached by
    // the browser or any intermediate proxy/CDN.
    const response = apiSuccess(key);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return apiError(
      "Failed to create managed Venice proxy key.",
      500,
      {
        failureType: "managed_venice_keys_create_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "managed-venice/keys",
        route: "/api/managed-venice/keys",
        method: "POST",
        userId: userIdForLog,
        failureType: "managed_venice_keys_create_failed",
        cause: error,
      }
    );
  }
}

export async function DELETE(request: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "managed_venice_keys_delete",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimitError) return rateLimitError;

    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return apiError("Key ID is required.", 400, {
        failureType: "managed_venice_keys_missing_delete_id",
      });
    }

    const result = await revokeManagedVeniceProxyKey({ userId, keyId: id });
    return apiSuccess(result);
  } catch (error) {
    if (error instanceof AgentModelKeyInUseError) {
      const response = apiError(error.message, 409, { failureType: "agent_model_key_in_use" }, { code: "agent_model_key_in_use" });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    return apiError(
      "Failed to revoke managed Venice proxy key.",
      500,
      {
        failureType: "managed_venice_keys_revoke_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "managed-venice/keys",
        route: "/api/managed-venice/keys",
        method: "DELETE",
        userId: userIdForLog,
        failureType: "managed_venice_keys_revoke_failed",
        cause: error,
      }
    );
  }
}
