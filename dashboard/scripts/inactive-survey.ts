// Inactivity survey: identify VMs that are likely safe to delete.
//
// READ-ONLY. Does not stop, destroy, or modify anything. Outputs a TSV +
// markdown report to /tmp/. You eyeball the report and decide what to delete.
//
// What it does, per non-deleted instance:
//   1. Resolves IP via the orchestrator helper (handles Hetzner direct +
//      Proxmox jump-host routing transparently).
//   2. SSH ground truth — probes the host for:
//        - whether the agent container is up
//        - container last-restart timestamp
//        - newest file mtime under ~/.hermes (channel-agnostic: catches
//          web UI, Telegram, Discord, API — any source that wrote state)
//        - last agent log line timestamp
//      If the host is unreachable or the container is missing, the instance
//      is marked "off" and we fall back to the latest
//      instance_metering_events.sampled_at row to estimate "off since".
//   3. Joins each row with its hermes_subscriptions state and counts
//      llm_usage_events for the user in the last 30 days.
//   4. Computes a verdict (HARD_DELETE / SOFT_DELETE / WARN / KEEP) using
//      the rules below.
//
// Verdict rules (defaults; override via CLI):
//   HARD_DELETE — subscription canceled, AND (off >= 7d OR no activity 30d+)
//   SOFT_DELETE — past_due past grace_period_ends_at, similar inactivity
//   WARN        — active sub but zero activity 30d+ (do NOT auto-delete)
//   KEEP        — recent activity OR healthy sub
//
// Usage:
//   npm run ops:inactive-survey -- --dry-run
//   npm run ops:inactive-survey -- --apply --concurrency 3
//   npm run ops:inactive-survey -- --apply --instance <uuid>
//   npm run ops:inactive-survey -- --apply --inactivity-days 30 --off-days 7

import path from "path";
import { writeFileSync } from "fs";
import * as dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { sshExec } from "../src/lib/hetzner/ssh";
import {
  resolveInstanceIpv4,
  type InstanceRowForOrchestration,
} from "../src/lib/services/instance-orchestrator";

// Try the checkout-local file plus an operator-supplied override. Public
// tooling must never depend on one developer's workstation layout.
for (const envPath of [
  path.join(__dirname, "../.env.local"),
  process.env.HIVRA_DASHBOARD_ENV_FILE,
].filter((value): value is string => Boolean(value))) {
  dotenv.config({ path: envPath, quiet: true });
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (looked in the checkout and HIVRA_DASHBOARD_ENV_FILE)"
  );
}
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

interface Args {
  apply: boolean;
  dryRun: boolean;
  instanceId: string | null;
  concurrency: number;
  inactivityDays: number;
  offDays: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const instIdx = argv.indexOf("--instance");
  const instanceId = instIdx >= 0 ? argv[instIdx + 1] || null : null;
  const concIdx = argv.indexOf("--concurrency");
  const concurrency =
    concIdx >= 0 ? Math.max(1, Math.min(10, Number(argv[concIdx + 1]) || 1)) : 3;
  const inactIdx = argv.indexOf("--inactivity-days");
  const inactivityDays = inactIdx >= 0 ? Number(argv[inactIdx + 1]) || 30 : 30;
  const offIdx = argv.indexOf("--off-days");
  const offDays = offIdx >= 0 ? Number(argv[offIdx + 1]) || 7 : 7;
  if (!apply && !dryRun) {
    throw new Error("Pass --apply to run the survey or --dry-run to preview the candidate list (no SSH).");
  }
  return { apply, dryRun, instanceId, concurrency, inactivityDays, offDays };
}

interface InstanceRow extends InstanceRowForOrchestration {
  name: string;
  status: string;
  lifecycle_state: string | null;
  infrastructure_provider: string | null;
  proxmox_vmid: number | null;
  hetzner_server_id: number | null;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  user_id: string;
  status: string;
  plan: string | null;
  current_period_end: string | null;
  grace_period_ends_at: string | null;
  stripe_subscription_id: string | null;
  updated_at: string;
}

interface ProbeResult {
  containerUp: boolean;
  containerStartedAt: string | null;     // ISO
  newestMtime: string | null;            // ISO, of any file under ~/.hermes
  newestMtimePath: string | null;        // for debugging
  lastLogLineAt: string | null;          // ISO, last docker log line timestamp
  diskUsageBytes: number | null;         // ~/.hermes du, rough
  raw: string;                            // full probe stdout for debugging
}

interface SurveyRow {
  instanceId: string;
  shortInstanceId: string;
  userId: string;
  shortUserId: string;
  name: string;
  provider: string;                       // hetzner / proxmox / unknown
  hetznerServerId: number | null;
  proxmoxVmid: number | null;
  ip: string;
  reachable: boolean;
  reachError: string | null;
  containerUp: boolean | null;
  ssh: ProbeResult | null;
  daysSinceSshActivity: number | null;
  daysSinceLogActivity: number | null;
  daysSinceDashboardActivity: number | null;
  daysSinceLastMeteringSample: number | null;
  llmCalls30d: number;
  subStatus: string | null;
  subPlan: string | null;
  subCurrentPeriodEnd: string | null;
  subGraceEndsAt: string | null;
  pastGrace: boolean;
  instanceCreatedAt: string;
  verdict: "HARD_DELETE" | "SOFT_DELETE" | "WARN" | "KEEP";
  reasonNotes: string[];
}

const SHORT = (s: string | null | undefined, n = 8) => (s || "").slice(0, n);

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / DAY_MS);
}

async function listInstances(filter: { instanceId: string | null }): Promise<InstanceRow[]> {
  let query = supabase
    .from("hermes_instances")
    .select(
      "id, user_id, name, status, lifecycle_state, infrastructure_provider, provider, hetzner_server_id, proxmox_vmid, gateway_url, host_id, ipv4_address, api_key_encrypted, api_server_key_encrypted, config, created_at, updated_at, backend"
    )
    .neq("lifecycle_state", "deleted")
    .neq("status", "deleted");
  if (filter.instanceId) query = query.eq("id", filter.instanceId);
  const { data, error } = await query;
  if (error) throw new Error(`Supabase list instances failed: ${error.message}`);
  return (data || []) as InstanceRow[];
}

async function loadSubscriptions(userIds: string[]): Promise<Map<string, SubscriptionRow>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("hermes_subscriptions")
    .select(
      "user_id, status, plan, current_period_end, grace_period_ends_at, stripe_subscription_id, updated_at"
    )
    .in("user_id", userIds);
  if (error) throw new Error(`Supabase load subscriptions failed: ${error.message}`);
  const m = new Map<string, SubscriptionRow>();
  for (const r of (data || []) as SubscriptionRow[]) m.set(r.user_id, r);
  return m;
}

async function loadLlmCallCounts(userIds: string[], sinceIso: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (userIds.length === 0) return m;
  // Per-user count via head+exact would require N round trips; instead pull
  // ids in one shot then bucket. Acceptable at our fleet size (<200 users).
  const { data, error } = await supabase
    .from("llm_usage_events")
    .select("user_id")
    .gte("created_at", sinceIso)
    .in("user_id", userIds);
  if (error) throw new Error(`Supabase load llm_usage_events failed: ${error.message}`);
  for (const row of (data || []) as { user_id: string }[]) {
    m.set(row.user_id, (m.get(row.user_id) || 0) + 1);
  }
  return m;
}

async function loadLatestMeteringSample(instanceIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (instanceIds.length === 0) return m;
  // We want max(sampled_at) per instance. Cheap-ish: pull most recent N sorted
  // and reduce. instance_metering_events has an index on (instance_id, sampled_at desc)
  // so we can fetch one row per instance with .limit(1) per id, but a single
  // .in() + dedupe is acceptable for our fleet size.
  const { data, error } = await supabase
    .from("instance_metering_events")
    .select("instance_id, sampled_at")
    .in("instance_id", instanceIds)
    .order("sampled_at", { ascending: false })
    .limit(instanceIds.length * 5); // a few rows per instance, we just need newest
  if (error) throw new Error(`Supabase load metering failed: ${error.message}`);
  for (const row of (data || []) as { instance_id: string; sampled_at: string }[]) {
    if (!m.has(row.instance_id)) m.set(row.instance_id, row.sampled_at);
  }
  return m;
}

async function loadLatestVmResponse(instanceIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (instanceIds.length === 0) return m;
  const { data, error } = await supabase
    .from("vm_response_seconds_daily")
    .select("instance_id, last_request_at")
    .in("instance_id", instanceIds)
    .order("last_request_at", { ascending: false })
    .limit(instanceIds.length * 5);
  // vm_response_seconds_daily may not exist in every env — soft fail
  if (error) {
    console.warn(`[warn] vm_response_seconds_daily lookup skipped: ${error.message}`);
    return m;
  }
  for (const row of (data || []) as { instance_id: string; last_request_at: string }[]) {
    if (!m.has(row.instance_id) && row.last_request_at) {
      m.set(row.instance_id, row.last_request_at);
    }
  }
  return m;
}

function buildProbeScript(instanceId: string, lookbackDays: number): string {
  // Try the new 2-container layout (agent-<id>) first; fall back to the old
  // 3-container layout (agent-<id>-web) if needed.
  return `set -e
INST=${instanceId}
LBD=${lookbackDays}

# Find the agent container regardless of layout. Prefer the non-sidecar one.
C=$(sudo docker ps --format '{{.Names}}' | grep "^agent-\${INST}" | grep -v sidecar | head -1)
if [ -z "$C" ]; then
  echo "CONTAINER_UP=false"
  echo "PROBE_DONE"
  exit 0
fi
echo "CONTAINER_UP=true"
echo "CONTAINER_NAME=$C"

# When did the container last (re)start?
STARTED=$(sudo docker inspect -f '{{.State.StartedAt}}' "$C" 2>/dev/null || echo "")
echo "CONTAINER_STARTED_AT=$STARTED"

# Newest file mtime under ~/.hermes — channel-agnostic ground truth.
# This is where every backend (web, telegram, discord, api) writes session
# state, chat DBs, and per-profile config. If nothing has been written in
# weeks, no human is using this instance.
NEWEST_MTIME_EPOCH=$(sudo docker exec "$C" sh -c 'find /home/hermes/.hermes -type f -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -1' 2>/dev/null | awk '{print $1}')
NEWEST_PATH=$(sudo docker exec "$C" sh -c 'find /home/hermes/.hermes -type f -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -1' 2>/dev/null | awk '{ $1=""; sub(/^ /,""); print }')
if [ -n "$NEWEST_MTIME_EPOCH" ]; then
  NEWEST_ISO=$(date -u -d "@\${NEWEST_MTIME_EPOCH%.*}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")
  echo "NEWEST_MTIME=$NEWEST_ISO"
  echo "NEWEST_PATH=$NEWEST_PATH"
else
  echo "NEWEST_MTIME="
  echo "NEWEST_PATH="
fi

# Last log line timestamp (--timestamps prefixes RFC3339).
LAST_LOG=$(sudo docker logs --tail 1 --timestamps "$C" 2>&1 | head -1 | awk '{print $1}')
echo "LAST_LOG_AT=$LAST_LOG"

# Disk usage of ~/.hermes (rough proxy for "did anything ever happen here?").
DU=$(sudo docker exec "$C" sh -c 'du -sb /home/hermes/.hermes 2>/dev/null | awk "{print \\$1}"' 2>/dev/null || echo "")
echo "HERMES_DU_BYTES=$DU"

echo "PROBE_DONE"
`;
}

function parseProbe(stdout: string): ProbeResult {
  const get = (key: string) => {
    const m = stdout.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const containerUp = get("CONTAINER_UP") === "true";
  const startedAt = get("CONTAINER_STARTED_AT") || null;
  const newestMtime = get("NEWEST_MTIME") || null;
  const newestPath = get("NEWEST_PATH") || null;
  const lastLog = get("LAST_LOG_AT") || null;
  const duStr = get("HERMES_DU_BYTES");
  const du = duStr && /^\d+$/.test(duStr) ? Number(duStr) : null;
  return {
    containerUp,
    containerStartedAt: startedAt,
    newestMtime,
    newestMtimePath: newestPath,
    lastLogLineAt: lastLog,
    diskUsageBytes: du,
    raw: stdout,
  };
}

function computeVerdict(row: SurveyRow, args: Args): { verdict: SurveyRow["verdict"]; notes: string[] } {
  const notes: string[] = [];
  const sub = row.subStatus;
  const offDays = row.daysSinceLastMeteringSample;
  const sshDays = row.daysSinceSshActivity;
  const dashDays = row.daysSinceDashboardActivity;

  const isOff = !row.reachable || row.containerUp === false;
  if (isOff) notes.push(`off (no SSH or no agent container); last metering sample ${offDays ?? "?"}d ago`);
  if (sshDays !== null) notes.push(`ssh-mtime ${sshDays}d ago`);
  if (dashDays !== null) notes.push(`dashboard llm activity ${dashDays}d ago`);
  if (row.llmCalls30d === 0) notes.push(`0 LLM calls in 30d`);

  const trulyInactive =
    (isOff && offDays !== null && offDays >= args.offDays) ||
    (sshDays !== null && sshDays >= args.inactivityDays && row.llmCalls30d === 0);

  // Pre-cancelled: status=canceled (Stripe webhook fired) but VM still around.
  if (sub === "canceled" && trulyInactive) {
    return { verdict: "HARD_DELETE", notes: [...notes, "subscription canceled + inactive"] };
  }
  // Past-due past grace: equivalent to canceled in practice.
  if (sub === "past_due" && row.pastGrace && trulyInactive) {
    return { verdict: "HARD_DELETE", notes: [...notes, "past_due past grace + inactive"] };
  }
  // Pending and never used: probably a card abandonment.
  if ((sub === "pending" || sub === null) && trulyInactive) {
    const ageDays = daysAgo(row.instanceCreatedAt) || 0;
    if (ageDays >= args.inactivityDays) {
      return { verdict: "SOFT_DELETE", notes: [...notes, `pending/no sub, instance age ${ageDays}d`] };
    }
  }
  // Active but silent — flag for human review, do not auto-anything.
  if (sub === "active" && trulyInactive) {
    return { verdict: "WARN", notes: [...notes, "active sub but silent — confirm with user before delete"] };
  }
  // Off but recent — keep, the user just powered down
  if (isOff && offDays !== null && offDays < args.offDays) {
    return { verdict: "KEEP", notes: [...notes, `off but only ${offDays}d`] };
  }
  return { verdict: "KEEP", notes };
}

async function surveyOne(
  instance: InstanceRow,
  context: {
    args: Args;
    sub: SubscriptionRow | undefined;
    llmCount: number;
    latestMetering: string | undefined;
    latestVmResponse: string | undefined;
  }
): Promise<SurveyRow> {
  const { args, sub, llmCount, latestMetering, latestVmResponse } = context;

  let ip = "";
  let reachError: string | null = null;
  try {
    ip = await resolveInstanceIpv4(instance, supabase);
  } catch (err) {
    reachError = `ipv4 resolve: ${(err as Error).message}`;
  }

  let probe: ProbeResult | null = null;
  let reachable = false;

  if (ip && !args.dryRun) {
    const r = await sshExec(ip, buildProbeScript(instance.id, args.inactivityDays), {
      timeoutMs: 45_000,
    });
    if (r.ok) {
      reachable = true;
      probe = parseProbe(r.stdout);
    } else {
      reachError = (r.error || r.stderr || "ssh failed").slice(0, 200);
    }
  } else if (!ip) {
    reachError = reachError || "no ipv4 resolved";
  }

  const provider =
    instance.infrastructure_provider ||
    (instance.proxmox_vmid ? "proxmox" : instance.hetzner_server_id ? "hetzner" : "unknown");

  // Best dashboard-side activity signal: the most recent llm_usage_events
  // for this user. We approximate "days since dashboard activity" by
  // bucketing — the actual newest timestamp would need another query. The
  // 30d count is good enough for verdict.
  const dashActivityIso = latestVmResponse || null;

  const row: SurveyRow = {
    instanceId: instance.id,
    shortInstanceId: SHORT(instance.id),
    userId: instance.user_id,
    shortUserId: SHORT(instance.user_id, 12),
    name: instance.name,
    provider,
    hetznerServerId: instance.hetzner_server_id,
    proxmoxVmid: instance.proxmox_vmid,
    ip: ip || "",
    reachable,
    reachError,
    containerUp: probe ? probe.containerUp : null,
    ssh: probe,
    daysSinceSshActivity: probe?.newestMtime ? daysAgo(probe.newestMtime) : null,
    daysSinceLogActivity: probe?.lastLogLineAt ? daysAgo(probe.lastLogLineAt) : null,
    daysSinceDashboardActivity: dashActivityIso ? daysAgo(dashActivityIso) : null,
    daysSinceLastMeteringSample: latestMetering ? daysAgo(latestMetering) : null,
    llmCalls30d: llmCount,
    subStatus: sub?.status ?? null,
    subPlan: sub?.plan ?? null,
    subCurrentPeriodEnd: sub?.current_period_end ?? null,
    subGraceEndsAt: sub?.grace_period_ends_at ?? null,
    pastGrace: Boolean(sub?.grace_period_ends_at && Date.parse(sub.grace_period_ends_at) < Date.now()),
    instanceCreatedAt: instance.created_at,
    verdict: "KEEP",
    reasonNotes: [],
  };

  const { verdict, notes } = computeVerdict(row, args);
  row.verdict = verdict;
  row.reasonNotes = notes;
  return row;
}

async function runConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          const item = items[idx];
          try {
            results[idx] = await worker(item);
          } catch (err) {
            // Surface but don't kill the whole sweep.
            console.error(`[err] worker failed:`, err);
          }
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

function renderTsv(rows: SurveyRow[]): string {
  const headers = [
    "verdict",
    "instance_id",
    "user_id",
    "name",
    "provider",
    "hetzner_id",
    "vmid",
    "ip",
    "reachable",
    "container_up",
    "ssh_days",
    "log_days",
    "metering_days",
    "dash_days",
    "llm_30d",
    "sub_status",
    "sub_plan",
    "past_grace",
    "current_period_end",
    "grace_ends_at",
    "instance_age_days",
    "notes",
  ];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    lines.push(
      [
        r.verdict,
        r.instanceId,
        r.userId,
        r.name,
        r.provider,
        r.hetznerServerId ?? "",
        r.proxmoxVmid ?? "",
        r.ip,
        r.reachable,
        r.containerUp ?? "",
        r.daysSinceSshActivity ?? "",
        r.daysSinceLogActivity ?? "",
        r.daysSinceLastMeteringSample ?? "",
        r.daysSinceDashboardActivity ?? "",
        r.llmCalls30d,
        r.subStatus ?? "",
        r.subPlan ?? "",
        r.pastGrace,
        r.subCurrentPeriodEnd ?? "",
        r.subGraceEndsAt ?? "",
        daysAgo(r.instanceCreatedAt) ?? "",
        r.reasonNotes.join("; "),
      ].join("\t")
    );
  }
  return lines.join("\n");
}

function renderMarkdown(rows: SurveyRow[], args: Args): string {
  const buckets = {
    HARD_DELETE: rows.filter((r) => r.verdict === "HARD_DELETE"),
    SOFT_DELETE: rows.filter((r) => r.verdict === "SOFT_DELETE"),
    WARN: rows.filter((r) => r.verdict === "WARN"),
    KEEP: rows.filter((r) => r.verdict === "KEEP"),
  };
  const out: string[] = [];
  out.push(`# Inactivity survey — ${new Date().toISOString()}`);
  out.push(``);
  out.push(`Thresholds: inactivity-days=${args.inactivityDays}, off-days=${args.offDays}`);
  out.push(``);
  out.push(`| Verdict | Count |`);
  out.push(`|---|---|`);
  out.push(`| HARD_DELETE (canceled + inactive) | ${buckets.HARD_DELETE.length} |`);
  out.push(`| SOFT_DELETE (pending/no sub + old) | ${buckets.SOFT_DELETE.length} |`);
  out.push(`| WARN (active but silent) | ${buckets.WARN.length} |`);
  out.push(`| KEEP | ${buckets.KEEP.length} |`);
  out.push(``);

  const renderBucket = (title: string, rs: SurveyRow[]) => {
    if (!rs.length) return;
    out.push(`## ${title} (${rs.length})`);
    out.push(``);
    out.push(`| inst | user | provider | sub | sshΔd | logΔd | metΔd | llm30d | notes |`);
    out.push(`|---|---|---|---|---|---|---|---|---|`);
    for (const r of rs) {
      out.push(
        `| \`${r.shortInstanceId}\` | \`${r.shortUserId}\` | ${r.provider}${r.proxmoxVmid ? `:${r.proxmoxVmid}` : ""}${r.hetznerServerId ? `:${r.hetznerServerId}` : ""} | ${r.subStatus ?? "(none)"}${r.pastGrace ? " (past grace)" : ""} | ${r.daysSinceSshActivity ?? "—"} | ${r.daysSinceLogActivity ?? "—"} | ${r.daysSinceLastMeteringSample ?? "—"} | ${r.llmCalls30d} | ${r.reasonNotes.join("; ")} |`
      );
    }
    out.push(``);
  };

  renderBucket("HARD_DELETE — pre-cancelled + inactive", buckets.HARD_DELETE);
  renderBucket("SOFT_DELETE — never paid + old", buckets.SOFT_DELETE);
  renderBucket("WARN — active sub but silent", buckets.WARN);

  return out.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `[survey] starting; inactivity=${args.inactivityDays}d, off=${args.offDays}d, concurrency=${args.concurrency}, dryRun=${args.dryRun}`
  );

  const instances = await listInstances({ instanceId: args.instanceId });
  console.log(`[survey] ${instances.length} non-deleted instances to inspect`);

  const userIds = Array.from(new Set(instances.map((i) => i.user_id))).filter(Boolean);
  const instanceIds = instances.map((i) => i.id);

  const sinceIso = new Date(Date.now() - 30 * DAY_MS).toISOString();

  const [subs, llmCounts, latestMetering, latestVmResponses] = await Promise.all([
    loadSubscriptions(userIds),
    loadLlmCallCounts(userIds, sinceIso),
    loadLatestMeteringSample(instanceIds),
    loadLatestVmResponse(instanceIds),
  ]);

  console.log(
    `[survey] joined ${subs.size} subs, ${llmCounts.size} users w/ recent llm activity, ${latestMetering.size} metering samples, ${latestVmResponses.size} vm-response samples`
  );

  const rows = await runConcurrent(instances, args.concurrency, (inst) =>
    surveyOne(inst, {
      args,
      sub: subs.get(inst.user_id),
      llmCount: llmCounts.get(inst.user_id) || 0,
      latestMetering: latestMetering.get(inst.id),
      latestVmResponse: latestVmResponses.get(inst.id),
    })
  );

  // Sort: HARD_DELETE first, then SOFT_DELETE, then WARN, then KEEP. Within each, oldest activity first.
  const order = { HARD_DELETE: 0, SOFT_DELETE: 1, WARN: 2, KEEP: 3 };
  rows.sort((a, b) => {
    const ord = order[a.verdict] - order[b.verdict];
    if (ord !== 0) return ord;
    const ad = a.daysSinceSshActivity ?? a.daysSinceLastMeteringSample ?? -1;
    const bd = b.daysSinceSshActivity ?? b.daysSinceLastMeteringSample ?? -1;
    return bd - ad;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tsvPath = `/tmp/hermes-inactive-survey-${stamp}.tsv`;
  const mdPath = `/tmp/hermes-inactive-survey-${stamp}.md`;
  writeFileSync(tsvPath, renderTsv(rows));
  writeFileSync(mdPath, renderMarkdown(rows, args));

  // Console summary.
  const counts = rows.reduce<Record<string, number>>((m, r) => {
    m[r.verdict] = (m[r.verdict] || 0) + 1;
    return m;
  }, {});
  console.log(`\n[survey] verdict counts:`, counts);
  console.log(`[survey] TSV: ${tsvPath}`);
  console.log(`[survey] MD : ${mdPath}`);

  // Print the deletable ones inline so they're easy to skim.
  const deletable = rows.filter((r) => r.verdict === "HARD_DELETE" || r.verdict === "SOFT_DELETE");
  if (deletable.length) {
    console.log(`\n[survey] deletable candidates (${deletable.length}):\n`);
    for (const r of deletable) {
      console.log(
        `  ${r.verdict.padEnd(12)} ${r.shortInstanceId} ${r.provider}${r.proxmoxVmid ? `:${r.proxmoxVmid}` : ""}${r.hetznerServerId ? `:${r.hetznerServerId}` : ""} sub=${r.subStatus ?? "(none)"} sshΔ=${r.daysSinceSshActivity ?? "?"}d metΔ=${r.daysSinceLastMeteringSample ?? "?"}d llm30d=${r.llmCalls30d}  — ${r.reasonNotes.join("; ")}`
      );
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
