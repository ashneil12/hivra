import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

import {
  HostDiscoverySnapshotSchema,
  snapshotPrivilegeVia,
  type HostDiscoverySnapshot,
} from "./host-discovery-contracts";

/** The connection fields the authority rules read. */
type AuthorityConnection = {
  provider: string;
  revision: number;
  endpoint: { sshUser: string; sshPrivilege?: "login" | "sudo" };
};

export const LINUX_SANDBOX_PRIVILEGE_COPY = "Linux Sandbox needs root or passwordless sudo on this server.";

/**
 * Runtime authority for every operation on an existing gVisor computer
 * (section 9.5): a generic host connection that signs in as root, or one
 * that reaches root through the sudo transport. No discovery snapshot is read
 * here, so an existing computer keeps working however long ago its host was
 * last inspected. The revision-bound target evidence checks still apply, and
 * because the privilege is revision-bound, changing it stops normal
 * operations until preflight runs again.
 */
export function hasRuntimeHostAuthority(connection: AuthorityConnection): boolean {
  if (connection.provider !== "host") return false;
  const privilege = connection.endpoint.sshPrivilege ?? "login";
  return privilege === "sudo" || connection.endpoint.sshUser === "root";
}

/**
 * Preflight and Prepare also need a current inspection of this connection
 * revision that reached root the same way the connection does (a version 1
 * snapshot counts as "login"). Checking this before Prepare moves an existing
 * failure to before anything is installed; no flow that succeeds today fails.
 */
export function hasHostAdministratorAuthority(
  connection: AuthorityConnection,
  snapshot: HostDiscoverySnapshot | null,
  now = Date.now(),
): boolean {
  if (!hasRuntimeHostAuthority(connection) || !snapshot) return false;
  return snapshot.connectionRevision === connection.revision
    && Date.parse(snapshot.expiresAt) > now
    && snapshotPrivilegeVia(snapshot) === (connection.endpoint.sshPrivilege ?? "login")
    && snapshot.host.environment.effectivePrivilege === "root";
}

export class HostAuthorityStoreError extends Error {
  constructor() {
    super("Host discovery evidence could not be read");
    this.name = "HostAuthorityStoreError";
  }
}

/** The newest unexpired snapshot for this connection revision, or null. */
export async function loadCurrentHostDiscoverySnapshot(
  userId: string,
  connectionId: string,
  revision: number,
  now = Date.now(),
): Promise<HostDiscoverySnapshot | null> {
  if (!supabaseAdmin) throw new HostAuthorityStoreError();
  const { data, error } = await supabaseAdmin.from("infrastructure_host_discovery_snapshots")
    .select("snapshot,expires_at").eq("user_id", userId).eq("connection_id", connectionId)
    .eq("connection_revision", revision).order("observed_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new HostAuthorityStoreError();
  const row = data as { snapshot?: unknown; expires_at?: string } | null;
  if (!row || typeof row.expires_at !== "string" || Date.parse(row.expires_at) <= now) return null;
  const parsed = HostDiscoverySnapshotSchema.safeParse(row.snapshot);
  return parsed.success ? parsed.data : null;
}
