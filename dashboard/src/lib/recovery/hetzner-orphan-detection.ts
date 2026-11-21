/**
 * Detect hermes-deploy Hetzner servers that no live row points at (F090).
 *
 * Every server the provisioning path creates carries the label app=hermes-deploy.
 * A server leaks when the process dies after createServer but before a row
 * records it, or when the rollback delete fails and the row is then removed. Such
 * a server bills with no row and no reconciler reads its label, so nothing finds it.
 *
 * This sweep is DETECT-ONLY. It lists servers and reads rows, and it never deletes
 * or shuts anything down. A billable server is removed by a person after they
 * check it in the Hetzner console, the same rule the Proxmox orphan sweep follows.
 *
 * A server counts as known when a live instance row or a host row points at it.
 * A creation receipt (a provisioning row with a server id and no gateway_url, see
 * isHetznerCreationReceipt) does not count: when its provision died, nothing else
 * finishes it, so its server is reported.
 */

import { createHetznerCloudProjectClient, type HetznerServer } from "@/lib/hetzner/client";
import { isHetznerCreationReceipt } from "@/lib/hetzner/creation-receipt";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Servers younger than this are never reported. The provision path (create,
 * action wait, fingerprint capture, DNS verify) finishes inside the 300 s route
 * budget, so a server older than this with no live row is a leak, not an
 * in-flight provision. Two hours leaves a wide margin over that budget.
 */
export const HETZNER_ORPHAN_MIN_AGE_MS = 2 * 60 * 60 * 1000;

const DEPLOY_LABEL_KEY = "app";
const DEPLOY_LABEL_VALUE = "hermes-deploy";
const REFERENCE_PAGE_SIZE = 1000;

export interface HetznerDeployServer {
  id: number;
  name: string;
  created: string;
  labels?: Record<string, string>;
}

export interface HetznerReferenceSnapshot {
  /** Server ids that a live instance row or a host row points at. */
  liveServerIds: Set<number>;
  /** Server ids that only an unprovisioned instance row points at, mapped to that row's id. */
  unprovisionedServers: Map<number, string | null>;
}

export type HetznerOrphanReason = "no_live_row" | "row_not_provisioned";

export interface HetznerOrphanServer {
  serverId: number;
  name: string;
  createdAt: string;
  ageHours: number;
  reason: HetznerOrphanReason;
  /** The unprovisioned instance row that still names this server, when there is one. */
  instanceId: string | null;
}

export interface HetznerOrphanSweepSummary {
  skipped: string | null;
  serversScanned: number;
  liveServers: number;
  youngServers: number;
  orphans: HetznerOrphanServer[];
}

export function isHermesDeployServer(server: HetznerDeployServer): boolean {
  return server.labels?.[DEPLOY_LABEL_KEY] === DEPLOY_LABEL_VALUE;
}

/** Pure classification. Callers pass the already label-filtered server list. */
export function findHetznerDeployOrphans(input: {
  servers: HetznerDeployServer[];
  references: HetznerReferenceSnapshot;
  nowMs: number;
  minAgeMs?: number;
}): Pick<HetznerOrphanSweepSummary, "liveServers" | "youngServers" | "orphans"> {
  const minAgeMs = input.minAgeMs ?? HETZNER_ORPHAN_MIN_AGE_MS;
  let liveServers = 0;
  let youngServers = 0;
  const orphans: HetznerOrphanServer[] = [];

  for (const server of input.servers) {
    if (input.references.liveServerIds.has(server.id)) {
      liveServers += 1;
      continue;
    }
    const createdMs = Date.parse(server.created);
    const ageMs = input.nowMs - createdMs;
    if (!Number.isFinite(createdMs) || ageMs < minAgeMs) {
      youngServers += 1;
      continue;
    }

    const unprovisioned = input.references.unprovisionedServers.has(server.id);
    orphans.push({
      serverId: server.id,
      name: server.name,
      createdAt: server.created,
      ageHours: Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10,
      reason: unprovisioned ? "row_not_provisioned" : "no_live_row",
      instanceId: unprovisioned ? input.references.unprovisionedServers.get(server.id) ?? null : null,
    });
  }

  return { liveServers, youngServers, orphans };
}

type InstanceReferenceRow = {
  id: string;
  hetzner_server_id: number | null;
  status: string | null;
  gateway_url: string | null;
};

type HostReferenceRow = {
  id: string;
  hetzner_server_id: number | null;
};

async function loadHetznerReferences(): Promise<HetznerReferenceSnapshot> {
  const db = supabaseAdmin;
  if (!db) throw new Error("Supabase admin client not configured");

  const liveServerIds = new Set<number>();
  const unprovisionedServers = new Map<number, string | null>();

  let cursor: string | null = null;
  for (;;) {
    let query = db
      .from("hermes_instances")
      .select("id, hetzner_server_id, status, gateway_url")
      .not("hetzner_server_id", "is", null)
      .neq("status", "deleted")
      .order("id", { ascending: true })
      .limit(REFERENCE_PAGE_SIZE);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(`hermes_instances reference read failed: ${error.message}`);

    const rows = (data ?? []) as InstanceReferenceRow[];
    for (const row of rows) {
      if (!row.hetzner_server_id) continue;
      // A creation receipt that never got its metadata is not a live row. Nothing
      // else will finish its provision, so its server is reported.
      if (isHetznerCreationReceipt(row)) {
        unprovisionedServers.set(row.hetzner_server_id, row.id);
      } else {
        liveServerIds.add(row.hetzner_server_id);
      }
    }
    if (rows.length < REFERENCE_PAGE_SIZE) break;
    cursor = rows[rows.length - 1].id;
  }

  cursor = null;
  for (;;) {
    let query = db
      .from("hermes_hosts")
      .select("id, hetzner_server_id")
      .not("hetzner_server_id", "is", null)
      .neq("status", "deleted")
      .order("id", { ascending: true })
      .limit(REFERENCE_PAGE_SIZE);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(`hermes_hosts reference read failed: ${error.message}`);

    const rows = (data ?? []) as HostReferenceRow[];
    for (const row of rows) {
      if (row.hetzner_server_id) liveServerIds.add(row.hetzner_server_id);
    }
    if (rows.length < REFERENCE_PAGE_SIZE) break;
    cursor = rows[rows.length - 1].id;
  }

  return { liveServerIds, unprovisionedServers };
}

async function listPlatformServers(): Promise<HetznerServer[]> {
  const token = process.env.HETZNER_API_TOKEN?.trim() ?? "";
  return createHetznerCloudProjectClient(token).listServers();
}

/**
 * Run the detect-only sweep. Injected readers exist for tests; production uses the
 * platform token and the admin database. Nothing here mutates a server or a row.
 */
export async function runHetznerOrphanSweep(deps: {
  listServers?: () => Promise<HetznerDeployServer[]>;
  loadReferences?: () => Promise<HetznerReferenceSnapshot>;
  nowMs?: () => number;
} = {}): Promise<HetznerOrphanSweepSummary> {
  if (!deps.listServers && !process.env.HETZNER_API_TOKEN?.trim()) {
    return {
      skipped: "hetzner_token_not_configured",
      serversScanned: 0,
      liveServers: 0,
      youngServers: 0,
      orphans: [],
    };
  }

  const listServers = deps.listServers ?? listPlatformServers;
  const loadReferences = deps.loadReferences ?? loadHetznerReferences;
  const nowMs = deps.nowMs ?? Date.now;

  const servers = (await listServers()).filter(isHermesDeployServer);
  const references = await loadReferences();
  const classified = findHetznerDeployOrphans({
    servers,
    references,
    nowMs: nowMs(),
  });

  return {
    skipped: null,
    serversScanned: servers.length,
    ...classified,
  };
}
