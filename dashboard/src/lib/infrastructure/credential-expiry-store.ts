import "server-only";

// Owner-declared provider token expiry. DigitalOcean does not report when a
// personal access token expires, so Hivra keeps the date the owner declared
// at connect or token replacement and uses it only to warn ahead of time.
// Reads are best-effort: a missing record, or a store that cannot be read,
// leaves the connection usable and simply shows no reminder.

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

import {
  CredentialExpiryDtoSchema,
  type CredentialExpiryDto,
  type ProviderTokenExpiryInput,
} from "./contracts";
import { InfrastructureConnectionStoreError } from "./connection-store";

const LOG_SOURCE = "credential-expiry-store";
const MAX_DECLARED_YEARS = 5;

type ExpiryRow = {
  connection_id: string;
  no_expiry: boolean;
  expires_on: string | null;
  declared_at: string;
};

function toDto(row: ExpiryRow): CredentialExpiryDto | null {
  const parsed = CredentialExpiryDtoSchema.safeParse({
    source: "owner-declared",
    noExpiry: row.no_expiry,
    expiresOn: row.expires_on,
    declaredAt: new Date(row.declared_at).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * A declared date must be today or later (UTC, with a day of slack for the
 * owner's time zone) and within a few years; anything else is a typo.
 */
export function validateDeclaredExpiry(expiry: ProviderTokenExpiryInput, now: Date): string | null {
  if (expiry.mode === "none") return null;
  const date = Date.parse(`${expiry.date}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date < today - 24 * 60 * 60_000) return "That date has already passed. A token past its expiry date no longer works.";
  if (date > today + MAX_DECLARED_YEARS * 366 * 24 * 60 * 60_000) return `Choose a date within ${MAX_DECLARED_YEARS} years, or No expiry.`;
  return null;
}

export async function recordCredentialExpiry(input: {
  userId: string;
  connectionId: string;
  expiry: ProviderTokenExpiryInput;
  now: Date;
}): Promise<CredentialExpiryDto> {
  if (!supabaseAdmin) throw new InfrastructureConnectionStoreError("database_unavailable");
  const { data, error } = await supabaseAdmin
    .from("infrastructure_credential_expiry")
    .upsert({
      connection_id: input.connectionId,
      user_id: input.userId,
      no_expiry: input.expiry.mode === "none",
      expires_on: input.expiry.mode === "date" ? input.expiry.date : null,
      declared_at: input.now.toISOString(),
    }, { onConflict: "connection_id" })
    .select("connection_id,no_expiry,expires_on,declared_at")
    .maybeSingle();
  const dto = data ? toDto(data as ExpiryRow) : null;
  if (error || !dto) {
    log.warn("Provider token expiry was not recorded", {
      source: LOG_SOURCE,
      failureType: "credential_expiry_write_failed",
      connectionId: input.connectionId,
      code: (error as { code?: string } | null)?.code ?? null,
    });
    throw new InfrastructureConnectionStoreError("database_error");
  }
  return dto;
}

/** Forget a declared date, for example after the token it described was replaced. */
export async function clearCredentialExpiry(userId: string, connectionId: string): Promise<void> {
  if (!supabaseAdmin) throw new InfrastructureConnectionStoreError("database_unavailable");
  const { error } = await supabaseAdmin
    .from("infrastructure_credential_expiry")
    .delete()
    .eq("connection_id", connectionId)
    .eq("user_id", userId);
  if (error) throw new InfrastructureConnectionStoreError("database_error");
}

export async function loadCredentialExpiries(userId: string, connectionIds: string[]): Promise<Map<string, CredentialExpiryDto>> {
  const result = new Map<string, CredentialExpiryDto>();
  if (!connectionIds.length || !supabaseAdmin) return result;
  const { data, error } = await supabaseAdmin
    .from("infrastructure_credential_expiry")
    .select("connection_id,no_expiry,expires_on,declared_at")
    .eq("user_id", userId)
    .in("connection_id", connectionIds);
  if (error) {
    log.warn("Provider token expiry could not be read", {
      source: LOG_SOURCE,
      failureType: "credential_expiry_read_failed",
      code: (error as { code?: string }).code ?? null,
    });
    return result;
  }
  for (const raw of data ?? []) {
    const row = raw as ExpiryRow;
    const dto = toDto(row);
    if (dto) result.set(String(row.connection_id), dto);
  }
  return result;
}

/** Attach declared expiry to the DigitalOcean connections in a list. */
export async function withCredentialExpiry<T extends { id: string; provider: string }>(
  userId: string,
  connections: T[],
): Promise<T[]> {
  const ids = connections.filter((connection) => connection.provider === "digitalocean").map((connection) => connection.id);
  if (!ids.length) return connections;
  const expiries = await loadCredentialExpiries(userId, ids);
  return connections.map((connection) => connection.provider === "digitalocean"
    ? { ...connection, credentialExpiry: expiries.get(connection.id) ?? null }
    : connection);
}
