/**
 * Clerk Backend API helpers for live Canary QA.
 *
 * Every run needs a VIRGIN disposable account — reusing QA_USER_ID would
 * measure "can a user with history do it again", not "does a new signup work".
 * Canary Clerk is in restricted-signup mode, so account creation starts with a
 * unique Backend API invitation (`notify: false`) and the browser accepts that
 * invitation through the real public sign-up UI. Creating the user directly
 * would bypass the surface under test and is deliberately absent here.
 *
 * Sign-in tickets are deliberately not used either: Clerk sent mail after
 * ticket redemption. Existing disposable users sign in through Clerk test-mode
 * email OTP only when a reaper has to clean up their resources.
 */

import {
  assertCanaryClerkSecretKey,
  assertClerkTestAuditEmail,
  assertLiveManagedHostingAuditAllowed,
  assertTicketSignInDisabled,
} from './config';

const CLERK_API = 'https://api.clerk.com/v1';

export interface ClerkUser {
  id: string;
  email: string | null;
  createdAtMs: number;
}

interface ClerkEmailAddress {
  email_address?: string;
}

interface ClerkUserPayload {
  id?: string;
  email_addresses?: ClerkEmailAddress[];
  created_at?: number;
  errors?: unknown;
}

export interface ClerkInvitation {
  id: string;
  email: string;
  url: string;
  createdAtMs: number;
}

interface ClerkInvitationPayload {
  id?: string;
  email_address?: string;
  url?: string;
  created_at?: number;
  errors?: unknown;
}

export interface ClerkTestingToken {
  token: string;
  expiresAtMs: number | null;
}

interface ClerkTestingTokenPayload {
  token?: string;
  expires_at?: number;
  errors?: unknown;
}

async function clerkFetch(
  secretKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  assertCanaryClerkSecretKey(secretKey);
  return fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function primaryEmail(payload: ClerkUserPayload): string | null {
  return payload.email_addresses?.[0]?.email_address ?? null;
}

/** The exact Backend API payload for one unique, no-mail restricted-mode invitation. */
export function auditInvitationPayload(email: string, redirectUrl: string): Record<string, unknown> {
  assertClerkTestAuditEmail(email);
  return {
    email_address: email,
    // The whole point is that Clerk must not send mail. Opening the returned
    // acceptance URL in the browser is part of the test, not an email bypass.
    notify: false,
    // A collision means the run id was not unique or an old account/invite is
    // still present. Never silently attach this run to somebody else's invite.
    ignore_existing: false,
    expires_in_days: 1,
    redirect_url: redirectUrl,
    public_metadata: {
      hivra_qa: 'clerk-invitation-signup',
    },
  };
}

/**
 * Create the unique invitation for this run's disposable account. This does
 * not create a user; the public sign-up UI does that when the browser accepts
 * the invitation.
 */
export async function createAuditInvitation(
  secretKey: string,
  email: string,
  redirectUrl: string,
): Promise<ClerkInvitation> {
  assertLiveManagedHostingAuditAllowed();
  const res = await clerkFetch(secretKey, '/invitations', {
    method: 'POST',
    body: JSON.stringify(auditInvitationPayload(email, redirectUrl)),
  });

  const body = (await res.json().catch(() => null)) as ClerkInvitationPayload | null;
  if (!res.ok || !body?.id || !body.url) {
    throw new Error(
      `[clerk] create invitation failed: HTTP ${res.status} ${JSON.stringify(body ?? {}).slice(0, 400)}`,
    );
  }

  return {
    id: body.id,
    email: body.email_address ?? email,
    url: body.url,
    createdAtMs: typeof body.created_at === 'number' ? body.created_at : Date.now(),
  };
}

/**
 * Mint the short-lived token Clerk documents for end-to-end tests. It is not
 * an auth credential and does not create or sign in a user; it only prevents
 * Clerk's bot challenge from replacing the public sign-up form under test.
 */
export async function createClerkTestingToken(secretKey: string): Promise<ClerkTestingToken> {
  assertLiveManagedHostingAuditAllowed();
  const res = await clerkFetch(secretKey, '/testing_tokens', { method: 'POST', body: '{}' });
  const body = (await res.json().catch(() => null)) as ClerkTestingTokenPayload | null;
  if (!res.ok || typeof body?.token !== 'string' || !body.token) {
    throw new Error(`[clerk] create testing token failed: HTTP ${res.status}`);
  }
  const expiresAtMs = typeof body.expires_at === 'number' ? body.expires_at * 1000 : null;
  if (expiresAtMs !== null && expiresAtMs <= Date.now() + 60_000) {
    throw new Error('[clerk] testing token expires too soon to start a signup audit');
  }
  return { token: body.token, expiresAtMs };
}

/** Best-effort invitation hygiene when sign-up fails before a user exists. */
export async function revokeAuditInvitation(secretKey: string, invitationId: string): Promise<boolean> {
  const res = await clerkFetch(secretKey, `/invitations/${encodeURIComponent(invitationId)}/revoke`, {
    method: 'POST',
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`[clerk] revoke invitation ${invitationId} failed: HTTP ${res.status}`);
  return true;
}

/** Exact-email lookup used when a failed signup may have created the user before the browser told us its id. */
export async function findAuditUserByEmail(secretKey: string, email: string): Promise<ClerkUser | null> {
  assertClerkTestAuditEmail(email);
  const params = new URLSearchParams({ email_address: email, limit: '10' });
  const res = await clerkFetch(secretKey, `/users?${params.toString()}`, { method: 'GET' });
  if (!res.ok) throw new Error(`[clerk] find user by email failed: HTTP ${res.status}`);
  const rows = (await res.json()) as ClerkUserPayload[];
  if (!Array.isArray(rows)) {
    throw new Error('[clerk] exact email lookup returned an invalid user list');
  }
  if (rows.length === 0) return null;

  // A disposable signup starts with a single address. A returned row that
  // cannot be tied to that exact identity is not proof of an empty lookup.
  const [row] = rows;
  const addresses = row?.email_addresses;
  const address = Array.isArray(addresses) && addresses.length === 1
    ? addresses[0]?.email_address : undefined;
  if (rows.length !== 1 || typeof row?.id !== 'string' || !row.id.trim() ||
      typeof address !== 'string' || address.toLowerCase() !== email.toLowerCase()) {
    throw new Error('[clerk] exact email lookup returned an unresolved user identity');
  }
  return {
    id: row.id,
    email: address,
    createdAtMs: typeof row.created_at === 'number' ? row.created_at : Date.now(),
  };
}

/** Sign-in tickets are retained only as a hard-disabled legacy symbol; never mint one. */
export async function mintSignInTicket(
  _secretKey: string,
  _userId: string,
  _expiresInSeconds = 1800,
): Promise<string> {
  assertTicketSignInDisabled();
}

/**
 * Delete the account. Returns false rather than throwing on a 404 — a user that
 * is already gone is the state we wanted, and teardown must be idempotent.
 */
export async function deleteAuditUser(
  secretKey: string,
  userId: string,
  { verifyDeletion = false } = {},
): Promise<boolean> {
  const res = await clerkFetch(secretKey, `/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    ...(verifyDeletion ? { redirect: 'error', signal: AbortSignal.timeout(20_000) } : {}),
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`[clerk] delete user ${userId} failed: HTTP ${res.status}`);
  }
  if (verifyDeletion) {
    const body = await res.json().catch(() => null);
    if (body?.id !== userId || body.deleted !== true) throw new Error('Clerk user deletion not confirmed');
  }
  return true;
}

/**
 * Every audit account currently in the Clerk instance, oldest first.
 *
 * Clerk's `query` is a fuzzy search, so we re-filter locally on the exact
 * local-part prefix. Never trust the server-side match to scope a destructive
 * reaper.
 */
export async function listAuditUsers(
  secretKey: string,
  isAuditEmail: (email: string | null) => boolean,
): Promise<ClerkUser[]> {
  const found: ClerkUser[] = [];
  const limit = 100;

  for (let offset = 0; offset < 1000; offset += limit) {
    const res = await clerkFetch(
      secretKey,
      `/users?limit=${limit}&offset=${offset}&order_by=%2Bcreated_at`,
      { method: 'GET' },
    );
    if (!res.ok) {
      throw new Error(`[clerk] list users failed: HTTP ${res.status}`);
    }
    const page = (await res.json()) as ClerkUserPayload[];
    if (!Array.isArray(page) || page.length === 0) break;

    for (const raw of page) {
      const email = primaryEmail(raw);
      if (!raw.id || !isAuditEmail(email)) continue;
      found.push({
        id: raw.id,
        email,
        createdAtMs: typeof raw.created_at === 'number' ? raw.created_at : 0,
      });
    }

    if (page.length < limit) break;
  }

  return found;
}
