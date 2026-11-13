import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

export type HomeConnectorRow = {
  id: string;
  user_id: string;
  generation: number;
  enrolment_expires_at: string;
  enrolment_consumed_at: string | null;
  revoked_at: string | null;
};

const COLUMNS = "id, user_id, generation, enrolment_expires_at, enrolment_consumed_at, revoked_at";

export class HomeConnectorStoreError extends Error {
  constructor(readonly code: "database_unavailable" | "database_error") {
    super(`Home connector store: ${code}`);
    this.name = "HomeConnectorStoreError";
  }
}

function database() {
  if (!supabaseAdmin) throw new HomeConnectorStoreError("database_unavailable");
  return supabaseAdmin;
}

export async function insertHomeConnector(input: {
  userId: string;
  tokenHash: string;
  expiresAt: string;
}): Promise<HomeConnectorRow> {
  const { data, error } = await database()
    .from("infrastructure_home_connectors")
    .insert({
      user_id: input.userId,
      enrolment_token_hash: input.tokenHash,
      enrolment_expires_at: input.expiresAt,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new HomeConnectorStoreError("database_error");
  return data as HomeConnectorRow;
}

/** Marks the token used, only when it is unused, unexpired and not revoked. One writer wins. */
export async function consumeEnrolmentToken(tokenHash: string, nowIso: string): Promise<HomeConnectorRow | null> {
  const { data, error } = await database()
    .from("infrastructure_home_connectors")
    .update({ enrolment_consumed_at: nowIso, updated_at: nowIso })
    .eq("enrolment_token_hash", tokenHash)
    .is("enrolment_consumed_at", null)
    .is("revoked_at", null)
    .gt("enrolment_expires_at", nowIso)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new HomeConnectorStoreError("database_error");
  return (data as HomeConnectorRow | null) ?? null;
}

/** Unexpired, unredeemed, unrevoked enrolments this user already has. */
export async function countPendingEnrolments(userId: string, nowIso: string): Promise<number> {
  const { count, error } = await database()
    .from("infrastructure_home_connectors")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("enrolment_consumed_at", null)
    .is("revoked_at", null)
    .gt("enrolment_expires_at", nowIso);
  if (error) throw new HomeConnectorStoreError("database_error");
  return count ?? 0;
}

export async function getHomeConnector(userId: string, id: string): Promise<HomeConnectorRow | null> {
  const { data, error } = await database()
    .from("infrastructure_home_connectors")
    .select(COLUMNS)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HomeConnectorStoreError("database_error");
  return (data as HomeConnectorRow | null) ?? null;
}

/** Raises the generation and marks the row revoked. Returns the row as it now stands. */
export async function markHomeConnectorRevoked(userId: string, row: HomeConnectorRow, nowIso: string): Promise<HomeConnectorRow | null> {
  if (row.revoked_at) return row;
  const { data, error } = await database()
    .from("infrastructure_home_connectors")
    .update({ generation: row.generation + 1, revoked_at: nowIso, updated_at: nowIso })
    .eq("id", row.id)
    .eq("user_id", userId)
    .eq("generation", row.generation)
    .is("revoked_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new HomeConnectorStoreError("database_error");
  return (data as HomeConnectorRow | null) ?? null;
}
