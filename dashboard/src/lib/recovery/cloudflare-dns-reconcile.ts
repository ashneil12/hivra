/**
 * Reconcile Cloudflare A records against `hermes_instances` and prune
 * orphans. Backstop for the existing best-effort DELETE-instance flow,
 * which logs-and-continues when Cloudflare is down, leaving stale
 * records, AND for cross-host migrations that don't repoint A records
 * (the vzdump+qmrestore recipe leaves the old `<sub>.agents.hermesos.cloud`
 * pointing at the drained host's IP while a fresh row gets minted on
 * the new host — see `reference_proxmox_vm_migration.md`).
 *
 * The Free-plan zone has a 200-record cap; on 2026-05-17 we hit it and
 * blocked new deploys until 20 stale records were hand-cleaned. This
 * sweep is the structural fix.
 *
 * Reaping policy:
 *  - Only A records whose name is EXACTLY `<sub>.<CLOUDFLARE_DNS_DOMAIN>`
 *    are eligible. Deeper subdomains (legacy `<inst>.fixturenodea.agents...`)
 *    are skipped — operator-owned, hand-prune if needed.
 *  - The subdomain must NOT match any `hermes_instances` row with
 *    `lifecycle_state <> 'deleted'`. Match is over the full subdomains
 *    table snapshot (one query) — no per-record DB roundtrip.
 *  - Records younger than RECONCILE_GRACE_MS are skipped to avoid
 *    racing fresh provisions that haven't finished writing the DB row.
 *  - Per-run deletions are capped at MAX_DELETES_PER_RUN. A misconfig
 *    that shows the live-subdomain set as empty can only delete that
 *    many records before stopping.
 *  - Destruction is gated by CLOUDFLARE_DNS_RECONCILE_ENABLED so the
 *    first deploy ships in observe-only mode. With the flag off the
 *    sweep still emits ops_events for every reap-eligible record and
 *    returns the would-delete list so the operator can audit before
 *    flipping the switch.
 */

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  deleteDnsRecordById,
  getCloudflareDnsConfig,
  listAllDnsRecords,
  type CloudflareDnsConfig,
  type CloudflareDnsRecord,
} from "@/lib/services/cloudflare-dns";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "reconcile-cloudflare-dns";

const RECONCILE_GRACE_MS = 60 * 60 * 1000;
const MAX_DELETES_PER_RUN = 50;

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function isReconcileEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return envFlag(env.CLOUDFLARE_DNS_RECONCILE_ENABLED);
}

type ReconcileSkipReason =
  | "not_under_configured_domain"
  | "deeper_subdomain"
  | "live_instance_exists"
  | "within_grace_period"
  | "delete_cap_reached";

export interface ReconcileCandidate {
  recordId: string;
  fqdn: string;
  subdomain: string;
  ip: string;
  createdAt: string | null;
}

export interface ReconcileSkip extends ReconcileCandidate {
  reason: ReconcileSkipReason;
}

interface ReconcileDeletionOutcome extends ReconcileCandidate {
  outcome: "deleted" | "delete_failed" | "would_delete";
  detail?: string;
}

export interface ReconcileSummary {
  enabled: boolean;
  zoneRecordsScanned: number;
  liveSubdomainCount: number;
  candidates: ReconcileCandidate[];
  skipped: ReconcileSkip[];
  results: ReconcileDeletionOutcome[];
  deletedCount: number;
  wouldDeleteCount: number;
  deleteFailedCount: number;
}

type SupabaseAdmin = NonNullable<typeof supabaseAdmin>;

export async function loadLiveSubdomains(supabase: SupabaseAdmin): Promise<Set<string>> {
  // Page through in batches — Supabase's PostgREST defaults cap rows.
  const pageSize = 1000;
  const set = new Set<string>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("hermes_instances")
      .select("subdomain")
      .neq("lifecycle_state", "deleted")
      .not("subdomain", "is", null)
      // Stable sort key so the paged windows are deterministic. Without it,
      // PostgREST's default ordering is unstable and a concurrent write
      // between page fetches can shift the window so a LIVE instance's
      // subdomain falls through the gap, is omitted from this set, and its
      // DNS record then becomes a (wrong) deletion candidate. Matches the
      // `.order("id")` pattern used by every other paginator in this repo.
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`hermes_instances subdomain query: ${error.message}`);
    }
    const rows = data ?? [];
    for (const row of rows) {
      if (row.subdomain) set.add(String(row.subdomain).toLowerCase());
    }
    if (rows.length < pageSize) return set;
  }
}

/**
 * Pure planner: given a record set, the live-subdomain snapshot, and
 * the current time, decide which records are reap candidates and which
 * are skipped (with reason). Exported for tests; the orchestrator below
 * calls it without intermediate fetches.
 */
export function planReconcile(input: {
  records: CloudflareDnsRecord[];
  liveSubdomains: Set<string>;
  config: CloudflareDnsConfig;
  now: number;
  maxDeletes?: number;
  graceMs?: number;
}): { candidates: ReconcileCandidate[]; skipped: ReconcileSkip[] } {
  const maxDeletes = input.maxDeletes ?? MAX_DELETES_PER_RUN;
  const graceMs = input.graceMs ?? RECONCILE_GRACE_MS;
  const domain = input.config.domain.toLowerCase();
  const candidates: ReconcileCandidate[] = [];
  const skipped: ReconcileSkip[] = [];

  for (const record of input.records) {
    const fqdn = record.name.toLowerCase();
    const suffix = `.${domain}`;
    if (fqdn === domain || !fqdn.endsWith(suffix)) {
      // Apex of the configured domain OR a record in a different zone scope.
      // Either way: not ours to touch.
      skipped.push({
        recordId: record.id,
        fqdn,
        subdomain: "",
        ip: record.content,
        createdAt: record.created_on ?? null,
        reason: "not_under_configured_domain",
      });
      continue;
    }
    const labelPart = fqdn.slice(0, -suffix.length);
    if (labelPart.length === 0 || labelPart.includes(".")) {
      skipped.push({
        recordId: record.id,
        fqdn,
        subdomain: labelPart,
        ip: record.content,
        createdAt: record.created_on ?? null,
        reason: "deeper_subdomain",
      });
      continue;
    }
    const candidate: ReconcileCandidate = {
      recordId: record.id,
      fqdn,
      subdomain: labelPart,
      ip: record.content,
      createdAt: record.created_on ?? null,
    };
    if (input.liveSubdomains.has(labelPart)) {
      skipped.push({ ...candidate, reason: "live_instance_exists" });
      continue;
    }
    if (record.created_on) {
      const ageMs = input.now - Date.parse(record.created_on);
      if (Number.isFinite(ageMs) && ageMs < graceMs) {
        skipped.push({ ...candidate, reason: "within_grace_period" });
        continue;
      }
    }
    if (candidates.length >= maxDeletes) {
      skipped.push({ ...candidate, reason: "delete_cap_reached" });
      continue;
    }
    candidates.push(candidate);
  }

  return { candidates, skipped };
}

async function reportCandidate(
  candidate: ReconcileCandidate,
  outcome: ReconcileDeletionOutcome["outcome"],
  detail?: string,
): Promise<void> {
  await reportOpsEvent({
    source: SOURCE,
    title: `cloudflare dns reconcile: ${outcome}`,
    message: `${outcome}: ${candidate.fqdn} → ${candidate.ip}`,
    severity: outcome === "delete_failed" ? "error" : "info",
    route: "/api/cron/reconcile-cloudflare-dns",
    metadata: {
      recordId: candidate.recordId,
      fqdn: candidate.fqdn,
      subdomain: candidate.subdomain,
      ip: candidate.ip,
      createdAt: candidate.createdAt,
      outcome,
      detail,
    },
  });
}

export async function runCloudflareDnsReconcile(): Promise<ReconcileSummary> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }
  const supabase = supabaseAdmin;
  const config = getCloudflareDnsConfig();
  if (!config) {
    throw new Error("Cloudflare DNS not configured");
  }
  const enabled = isReconcileEnabled();

  const records = await listAllDnsRecords(config, {
    nameSuffix: `.${config.domain}`,
  });
  const liveSubdomains = await loadLiveSubdomains(supabase);
  const { candidates, skipped } = planReconcile({
    records,
    liveSubdomains,
    config,
    now: Date.now(),
  });

  const results: ReconcileDeletionOutcome[] = [];
  let deletedCount = 0;
  let wouldDeleteCount = 0;
  let deleteFailedCount = 0;

  for (const candidate of candidates) {
    if (!enabled) {
      results.push({ ...candidate, outcome: "would_delete" });
      wouldDeleteCount += 1;
      await reportCandidate(candidate, "would_delete");
      continue;
    }
    try {
      await deleteDnsRecordById(config, candidate.recordId);
      results.push({ ...candidate, outcome: "deleted" });
      deletedCount += 1;
      await reportCandidate(candidate, "deleted");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ ...candidate, outcome: "delete_failed", detail });
      deleteFailedCount += 1;
      await reportCandidate(candidate, "delete_failed", detail);
      log.error("cloudflare dns reconcile: delete failed", err, {
        source: SOURCE,
        failureType: "cloudflare_dns_reconcile_delete_failed",
        recordId: candidate.recordId,
        fqdn: candidate.fqdn,
      });
    }
  }

  log.info("cloudflare dns reconcile sweep complete", {
    source: SOURCE,
    enabled,
    zoneRecordsScanned: records.length,
    liveSubdomainCount: liveSubdomains.size,
    candidateCount: candidates.length,
    skippedCount: skipped.length,
    deletedCount,
    wouldDeleteCount,
    deleteFailedCount,
  });

  return {
    enabled,
    zoneRecordsScanned: records.length,
    liveSubdomainCount: liveSubdomains.size,
    candidates,
    skipped,
    results,
    deletedCount,
    wouldDeleteCount,
    deleteFailedCount,
  };
}
