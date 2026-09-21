import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

import {
  HostDiscoverySnapshotSchema,
  type HostDiscoverySnapshot,
} from "./host-discovery-contracts";

export type HostDiscoveryStoreErrorCode =
  | "database_unavailable"
  | "database_conflict"
  | "database_error"
  | "invalid_snapshot";

/** Secret-free error suitable for classification at the API boundary. */
export class HostDiscoveryStoreError extends Error {
  constructor(readonly code: HostDiscoveryStoreErrorCode) {
    super(`Host discovery store failed: ${code}`);
    this.name = "HostDiscoveryStoreError";
  }
}

function database() {
  if (!supabaseAdmin) throw new HostDiscoveryStoreError("database_unavailable");
  return supabaseAdmin;
}

function isDatabaseCode(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      codes.includes(String((error as { code?: unknown }).code)),
  );
}

function databaseError(error: unknown): HostDiscoveryStoreError {
  if (isDatabaseCode(error, ["23503", "23505", "23514", "55000", "55006"])) {
    return new HostDiscoveryStoreError("database_conflict");
  }
  return new HostDiscoveryStoreError("database_error");
}

export async function beginInfrastructureHostDiscovery(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  runId: string;
}): Promise<boolean> {
  const { data, error } = await database().rpc("begin_infrastructure_host_discovery", {
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_revision: input.expectedRevision,
    p_run_id: input.runId,
  });
  if (error) throw databaseError(error);
  return data === true;
}

export async function completeInfrastructureHostDiscovery(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  runId: string;
  snapshot: HostDiscoverySnapshot;
}): Promise<boolean> {
  const parsed = HostDiscoverySnapshotSchema.safeParse(input.snapshot);
  if (
    !parsed.success ||
    parsed.data.discoveryId !== input.runId ||
    parsed.data.connectionId !== input.connectionId ||
    parsed.data.connectionRevision !== input.expectedRevision
  ) {
    throw new HostDiscoveryStoreError("invalid_snapshot");
  }

  const snapshot = parsed.data;
  const { data, error } = await database().rpc("complete_infrastructure_host_discovery", {
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_revision: input.expectedRevision,
    p_run_id: input.runId,
    p_observed_at: snapshot.observedAt,
    p_expires_at: snapshot.expiresAt,
    p_host_identity_digest: snapshot.hostIdentityDigest,
    p_snapshot: snapshot,
  });
  if (error) throw databaseError(error);
  return data === true;
}

export async function releaseInfrastructureHostDiscovery(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  runId: string;
}): Promise<boolean> {
  const { data, error } = await database().rpc("release_infrastructure_host_discovery", {
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_revision: input.expectedRevision,
    p_run_id: input.runId,
  });
  if (error) throw databaseError(error);
  return data === true;
}
