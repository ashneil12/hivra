import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";

import {
  requireLocalAuthMode,
  requireLocalJwtSecret,
  SELF_HOST_SESSION_COOKIE,
  SELF_HOST_USER_ID,
} from "./config";
import { createLocalOperatorUser } from "./local-user";
import { loadLocalOperatorState, saveLocalOperatorMetadata } from "./operator-store";
import {
  readBearerToken,
  readCookieValue,
  verifyLocalSessionToken,
  type LocalSessionClaims,
} from "./session-token";

async function claimsFromCurrentRequest(): Promise<LocalSessionClaims | null> {
  requireLocalAuthMode();
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const token =
    readBearerToken(headerStore.get("authorization")) ??
    cookieStore.get(SELF_HOST_SESSION_COOKIE)?.value ??
    null;
  return verifyLocalSessionToken({ token, secret: requireLocalJwtSecret() });
}

/**
 * Clerk's `has`. Reverification ("confirm it's you", which withdrawal
 * destination changes need) has no local counterpart: the operator signs in
 * with the installation's own password and there is no second factor, so a
 * signed-in operator satisfies it. Roles, permissions, plans and features are
 * not modelled locally, so those checks fail closed.
 */
function localHas(claims: LocalSessionClaims | null) {
  return (params: Record<string, unknown> | null | undefined): boolean => {
    if (!claims || !params || typeof params !== "object") return false;
    const keys = Object.keys(params);
    return keys.length === 1 && keys[0] === "reverification" && Boolean(params.reverification);
  };
}

function authResult(claims: LocalSessionClaims | null) {
  return {
    userId: claims?.sub ?? null,
    sessionId: claims ? `local-${claims.iat}` : null,
    sessionClaims: claims,
    getToken: async () => claims ? null : null,
    has: localHas(claims),
  };
}

/** Clerk's reverificationErrorResponse: the same 403 body its client reads. */
export function reverificationErrorResponse(missingConfig?: unknown): Response {
  return new Response(
    JSON.stringify({
      clerk_error: {
        type: "forbidden",
        reason: "reverification-error",
        metadata: { reverification: missingConfig },
      },
    }),
    { status: 403 },
  );
}

async function resolveAuth() {
  return authResult(await claimsFromCurrentRequest());
}

export const auth = Object.assign(resolveAuth, {
  protect: async () => {
    const result = await resolveAuth();
    if (!result.userId) redirect("/sign-in");
    return result;
  },
});

export async function currentUser() {
  const claims = await claimsFromCurrentRequest();
  if (!claims) return null;
  const state = await loadLocalOperatorState();
  return createLocalOperatorUser(state.publicMetadata);
}

function ensureLocalUserId(userId: string): void {
  if (userId !== SELF_HOST_USER_ID) {
    throw new Error(`Unknown local operator identity: ${userId}`);
  }
}

export async function clerkClient() {
  requireLocalAuthMode();
  return {
    authenticateRequest: async (request: Request) => {
      const token =
        readBearerToken(request.headers.get("authorization")) ??
        readCookieValue(request.headers.get("cookie"), SELF_HOST_SESSION_COOKIE);
      const claims = await verifyLocalSessionToken({ token, secret: requireLocalJwtSecret() });
      return {
        isAuthenticated: Boolean(claims),
        toAuth: () => authResult(claims),
      };
    },
    users: {
      getUser: async (userId: string) => {
        ensureLocalUserId(userId);
        const state = await loadLocalOperatorState();
        return createLocalOperatorUser(state.publicMetadata);
      },
      getUserList: async (params?: { userId?: string[]; limit?: number }) => {
        const include = !params?.userId || params.userId.includes(SELF_HOST_USER_ID);
        const state = await loadLocalOperatorState();
        const data = include && (params?.limit ?? 1) > 0
          ? [createLocalOperatorUser(state.publicMetadata)]
          : [];
        return { data, totalCount: data.length };
      },
      updateUser: async (
        userId: string,
        update: { publicMetadata?: Record<string, unknown> },
      ) => {
        ensureLocalUserId(userId);
        const previous = await loadLocalOperatorState();
        const nextMetadata = update.publicMetadata ?? previous.publicMetadata;
        await saveLocalOperatorMetadata(nextMetadata);
        return createLocalOperatorUser(nextMetadata);
      },
      deleteUser: async () => {
        throw new Error(
          "The local operator account is installation-owned. Rotate its credentials instead of deleting it.",
        );
      },
    },
  };
}

export function createRouteMatcher(patterns: string[]) {
  const prefixes = patterns.map((pattern) => pattern.replace(/\(\.\*\)$/, ""));
  return (request: NextRequest): boolean =>
    prefixes.some((prefix) =>
      prefix.endsWith("/")
        ? request.nextUrl.pathname.startsWith(prefix)
        : request.nextUrl.pathname === prefix || request.nextUrl.pathname.startsWith(`${prefix}/`),
    );
}

type MiddlewareAuth = (() => Promise<{ userId: string | null }>) & {
  protect: () => Promise<void>;
};

type MiddlewareHandler = (
  auth: MiddlewareAuth,
  request: NextRequest,
) => Promise<Response | undefined | void> | Response | undefined | void;

export function clerkMiddleware(handler: MiddlewareHandler) {
  return async function localOperatorMiddleware(request: NextRequest): Promise<Response> {
    let rejection: Response | null = null;
    let checkedUserId: string | null | undefined;

    const resolveUserId = async (): Promise<string | null> => {
      if (checkedUserId !== undefined) return checkedUserId;
      const token = readCookieValue(request.headers.get("cookie"), SELF_HOST_SESSION_COOKIE);
      const claims = await verifyLocalSessionToken({ token, secret: requireLocalJwtSecret() });
      checkedUserId = claims?.sub ?? null;
      return checkedUserId;
    };
    const middlewareAuth = Object.assign(
      async () => ({ userId: await resolveUserId() }),
      {
        protect: async () => {
          if (await resolveUserId()) return;
          rejection = request.nextUrl.pathname.startsWith("/api/")
            ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
            : NextResponse.redirect(new URL(`/sign-in?redirect_url=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`, request.url));
        },
      },
    ) as MiddlewareAuth;
    const response = await handler(middlewareAuth, request);
    return rejection ?? response ?? NextResponse.next();
  };
}
