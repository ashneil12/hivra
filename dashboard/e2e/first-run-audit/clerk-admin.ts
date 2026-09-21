/**
 * Clerk Backend API helpers for the first-run audit.
 *
 * The audit needs a VIRGIN account per run — reusing QA_USER_ID would measure
 * "can a user with history deploy again", not "does a new signup work". So each
 * run mints its own throwaway Clerk user and deletes it in teardown.
 *
 * The sign-in-token → `strategy: 'ticket'` redemption is the same mechanism
 * e2e/global-setup.ts already uses in production CI; it is proven.
 */

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

async function clerkFetch(
  secretKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
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

/**
 * Create the throwaway account. `skip_password_requirement` lets us create an
 * account with no credentials — we authenticate via a sign-in ticket, never a
 * password, so no secret is ever stored for these users.
 */
export async function createAuditUser(
  secretKey: string,
  email: string,
): Promise<ClerkUser> {
  const res = await clerkFetch(secretKey, '/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [email],
      skip_password_requirement: true,
      first_name: 'FirstRun',
      last_name: 'Audit',
    }),
  });

  const body = (await res.json().catch(() => null)) as ClerkUserPayload | null;
  if (!res.ok || !body?.id) {
    throw new Error(
      `[clerk] create user failed: HTTP ${res.status} ${JSON.stringify(body ?? {}).slice(0, 400)}`,
    );
  }

  return {
    id: body.id,
    email: primaryEmail(body) ?? email,
    createdAtMs: typeof body.created_at === 'number' ? body.created_at : Date.now(),
  };
}

/** Short-lived ticket the browser redeems to become this user. */
export async function mintSignInTicket(
  secretKey: string,
  userId: string,
  expiresInSeconds = 1800,
): Promise<string> {
  const res = await clerkFetch(secretKey, '/sign_in_tokens', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, expires_in_seconds: expiresInSeconds }),
  });

  const body = (await res.json().catch(() => null)) as { token?: string } | null;
  if (!res.ok || !body?.token) {
    throw new Error(
      `[clerk] ticket mint failed: HTTP ${res.status} ${JSON.stringify(body ?? {}).slice(0, 300)}`,
    );
  }
  return body.token;
}

/**
 * Delete the account. Returns false rather than throwing on a 404 — a user that
 * is already gone is the state we wanted, and teardown must be idempotent.
 */
export async function deleteAuditUser(secretKey: string, userId: string): Promise<boolean> {
  const res = await clerkFetch(secretKey, `/users/${userId}`, { method: 'DELETE' });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`[clerk] delete user ${userId} failed: HTTP ${res.status}`);
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
