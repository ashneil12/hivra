/**
 * Orphan Caddy-site cleanup for Proxmox hosts.
 *
 * Each tenant VM has a sibling /etc/caddy/hermes.d/<gateway>.caddy file that
 * the dashboard writes during provision and removes during
 * deleteProxmoxInstance / cold-archive. When a teardown path forgets to remove
 * it (the cold-archive path did until 2026-06; manual ops actions; VMs
 * destroyed outside the dashboard) the file is left behind still pointing at
 * `reverse_proxy <private_ip>:80`. If that VMID / private IP is later recycled
 * to a DIFFERENT tenant on the same host, the archived tenant's
 * `<sub>.hermesos.cloud` hostname routes to the NEW tenant's VM — a
 * cross-tenant routing leak — and the dead files bloat the host cert footprint.
 *
 * Ownership is decided by HOSTNAME, not by whether the upstream IP is alive.
 * A file is removed iff NO live (non-deleted, non-archived) instance owns its
 * hostname. Concretely, per host (fixturenodea / fixturenodea / ...):
 *   1. SSH in; list /etc/caddy/hermes.d/*.caddy + each file's reverse_proxy IP.
 *   2. List running VMs + their IPs (for leak classification + the dead-route
 *      fallback).
 *   3. Classify each site file against hermes_instances:
 *        - A LIVE instance owns the hostname            -> KEEP.
 *        - A DEAD instance owns it (cold_archived /
 *          pending_deletion / deleted / soft-deleted)   -> REMOVE
 *          (and flag "active cross-tenant leak" when its IP now hosts a
 *           different live VM — the fixture customer/fixturenodea class of bug).
 *        - No instance owns it AND the IP points at no
 *          live VM (classic dead route)                 -> REMOVE.
 *        - No instance owns it BUT the IP points at a
 *          live VM (no DB evidence either way)          -> KEEP + warn
 *          (conservative: don't risk nuking a live tenant the query missed).
 *   4. With --apply, rm -f the orphans + validate-then-reload host Caddy via
 *      buildProxmoxCaddySiteCleanupScript (same helper the dashboard uses).
 *
 * Usage (run from dashboard/; NEXT_PUBLIC_SUPABASE_URL is masked in .env.local
 * so pass the prod URL explicitly, exactly like the cold-storage e2e tool):
 *   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *     npm run ops:proxmox:cleanup-caddy-orphans                 # dry-run
 *   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *     npm run ops:proxmox:cleanup-caddy-orphans -- --apply      # remove
 *   ... -- --host fixturenodea                                         # one host
 *
 * Required env: PROXMOX_<SLUG>_* routing for each target host (SSH host/key)
 * AND NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */

// SCRIPTURE_ANCHOR: orphan-care | James 1:27 | Verse: Pure religion and undefiled before our God and Father is this: to visit the fatherless and widows.
import path from "path";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import {
  buildProxmoxCaddySiteCleanupScript,
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

const CADDY_SITES_DIR = "/etc/caddy/hermes.d";

// Lifecycle states where the VM has been destroyed (data, if any, lives on the
// Storage Box). A site file owned by an instance in one of these states is
// stale and must be removed. `paused` is deliberately NOT here: an
// inactivity-paused VM still exists (qm shutdown) and its route must survive.
const DEAD_LIFECYCLE_STATES = new Set([
  "cold_archived",
  "pending_deletion",
  "deleted",
]);

type Reason = "stale-tenant" | "active-cross-tenant-leak" | "dead-route";

interface Args {
  apply: boolean;
  host: string | null;
}

interface SiteCandidate {
  filename: string;
  gatewayHost: string;
  upstreamIp: string | null;
  reason: Reason;
  detail: string;
}

interface HostSweepResult {
  host: string;
  totalSites: number;
  orphanCandidates: SiteCandidate[];
  ambiguous: SiteCandidate[];
  removed: number;
  reloadOk: boolean;
  error?: string;
}

interface InstanceClassification {
  /** Hostnames owned by a live (non-dead, non-soft-deleted) instance. */
  liveHosts: Set<string>;
  /** Hostname -> dead-instance summary (archived / pending_deletion / deleted). */
  deadHosts: Map<string, { id: string; state: string }>;
}

// Enumerate the WHOLE fleet from per-host routing env keys. We can't use
// resolveProxmoxTargetCandidateIds(): registry placement reads the DB, and
// HERMES_PROXMOX_TARGETS is only a single-host legacy fallback (e.g. "fixturenodea"),
// so relying on it would silently sweep one host and miss every other. The
// real fleet is whatever has SSH routing configured: PROXMOX_<SLUG>_SSH_HOST
// (plus the PROXMOX_HOST_<SLUG>_ / <SLUG>_PROXMOX_ variants resolveProxmoxHostEnv
// understands), merged with any explicit HERMES_PROXMOX_TARGETS.
function discoverHostSlugs(env: NodeJS.ProcessEnv): string[] {
  const slugs = new Set<string>();
  const patterns = [
    /^PROXMOX_([A-Z0-9]+)_SSH_HOST$/,
    /^PROXMOX_HOST_([A-Z0-9]+)_SSH_HOST$/,
    /^([A-Z0-9]+)_PROXMOX_SSH_HOST$/,
  ];
  for (const [key, val] of Object.entries(env)) {
    if (!val || !val.trim()) continue;
    for (const re of patterns) {
      const m = key.match(re);
      // Exclude non-host shared keys (PROXMOX_VM_SSH_*, generic SSH key).
      if (m && m[1] && m[1] !== "VM") slugs.add(m[1].toLowerCase());
    }
  }
  for (const t of (env.HERMES_PROXMOX_TARGETS || env.PROXMOX_TARGETS || "").split(/[,\s]+/)) {
    const id = t.trim().toLowerCase();
    if (id) slugs.add(id);
  }
  return Array.from(slugs).sort((a, b) => {
    const na = Number(a.replace(/\D+/g, "")) || 0;
    const nb = Number(b.replace(/\D+/g, "")) || 0;
    return na - nb || a.localeCompare(b);
  });
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const hostFlag = args.find((a) => a.startsWith("--host="));
  const hostArg = args.includes("--host") ? args[args.indexOf("--host") + 1] : null;
  return {
    apply: args.includes("--apply"),
    host: hostFlag ? hostFlag.slice("--host=".length) : hostArg,
  };
}

function buildSiteListScript(): string {
  // Emit one line per .caddy file: filename|gatewayHost|upstreamIp
  // gatewayHost = filename without .caddy suffix.
  // upstreamIp = first private 10.x IP from a `reverse_proxy <ip>:<port>`.
  return `#!/usr/bin/env bash
set -uo pipefail
shopt -s nullglob
for f in ${CADDY_SITES_DIR}/*.caddy; do
  base="$(basename "$f" .caddy)"
  ip="$(grep -oE 'reverse_proxy[[:space:]]+10\\.[0-9]+\\.[0-9]+\\.[0-9]+' "$f" | head -n1 | awk '{print $2}' || true)"
  echo "$(basename "$f")|$base|$ip"
done
`;
}

function buildLiveVmScript(): string {
  // Emit one line per running VM: vmid|ip (from ipconfig0: ip=10.x.x.x/nn).
  return `#!/usr/bin/env bash
set -uo pipefail
for v in $(qm list | awk 'NR>1 && $3 == "running" {print $1}'); do
  ip="$(qm config "$v" 2>/dev/null | grep -oE 'ip=10\\.[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1 | cut -d= -f2 || true)"
  echo "$v|$ip"
done
`;
}

function parseSiteList(stdout: string): Array<Pick<SiteCandidate, "filename" | "gatewayHost" | "upstreamIp">> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [filename, gatewayHost, ip] = line.split("|");
      return {
        filename,
        gatewayHost,
        upstreamIp: ip && ip.length > 0 ? ip : null,
      };
    });
}

function parseLiveVms(stdout: string): Map<string, string> {
  const ipsByVmid = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [vmid, ip] = trimmed.split("|");
    if (vmid && ip) ipsByVmid.set(vmid, ip);
  }
  return ipsByVmid;
}

// Every hostname form a site file could plausibly carry for a given row, so a
// gateway_url-less row (or one under the legacy `.agents.` sub-zone) still
// matches the on-disk <gateway>.caddy filename.
function hostnamesForRow(row: {
  subdomain: string | null;
  gateway_url: string | null;
}): string[] {
  const hosts: string[] = [];
  if (row.gateway_url) {
    try {
      hosts.push(new URL(row.gateway_url).host);
    } catch {
      // bad URL doesn't help us classify — ignore
    }
  }
  if (row.subdomain) {
    hosts.push(`${row.subdomain}.hermesos.cloud`);
    hosts.push(`${row.subdomain}.agents.hermesos.cloud`);
  }
  return hosts;
}

// Use `any` for the supabase client param: the generic type emitted by
// `ReturnType<typeof createClient>` differs from the call-site shape, and
// scripts/* aren't type-critical (one-shot ops tools).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function classifyInstances(supabase: any): Promise<InstanceClassification> {
  const liveHosts = new Set<string>();
  const deadHosts = new Map<string, { id: string; state: string }>();

  // Paginate: the fleet has churned thousands of (soft-)deleted rows over its
  // life, which would blow past Supabase's default 1000-row cap.
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("hermes_instances")
      .select("id, subdomain, gateway_url, lifecycle_state, deleted_at")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`hermes_instances query failed: ${error.message}`);
    const rows = (data ?? []) as Array<{
      id: string;
      subdomain: string | null;
      gateway_url: string | null;
      lifecycle_state: string | null;
      deleted_at: string | null;
    }>;
    for (const row of rows) {
      const dead =
        row.deleted_at != null ||
        (row.lifecycle_state != null && DEAD_LIFECYCLE_STATES.has(row.lifecycle_state));
      for (const host of hostnamesForRow(row)) {
        if (dead) {
          // Only record as dead if no live instance also claims it (a recycled
          // subdomain is theoretically possible). Live always wins below.
          if (!deadHosts.has(host)) {
            deadHosts.set(host, { id: row.id, state: row.lifecycle_state ?? (row.deleted_at ? "deleted" : "unknown") });
          }
        } else {
          liveHosts.add(host);
        }
      }
    }
    if (rows.length < PAGE) break;
  }

  // A hostname owned by ANY live instance must never be classified dead.
  for (const host of liveHosts) deadHosts.delete(host);
  return { liveHosts, deadHosts };
}

async function sweepHost(
  hostSlug: string,
  cls: InstanceClassification,
  args: Args,
): Promise<HostSweepResult> {
  const env = resolveProxmoxHostEnv({ hostSlug, failClosed: true }, process.env);

  const siteList = await runProxmoxHostScript(buildSiteListScript(), env);
  if (!siteList.ok) {
    return {
      host: hostSlug,
      totalSites: 0,
      orphanCandidates: [],
      ambiguous: [],
      removed: 0,
      reloadOk: false,
      error: `site-list script failed: ${siteList.error || siteList.stderr}`,
    };
  }
  const sites = parseSiteList(siteList.stdout);

  const liveVms = await runProxmoxHostScript(buildLiveVmScript(), env);
  if (!liveVms.ok) {
    return {
      host: hostSlug,
      totalSites: sites.length,
      orphanCandidates: [],
      ambiguous: [],
      removed: 0,
      reloadOk: false,
      error: `live-vm script failed: ${liveVms.error || liveVms.stderr}`,
    };
  }
  const liveIps = new Set<string>(parseLiveVms(liveVms.stdout).values());

  const orphanCandidates: SiteCandidate[] = [];
  const ambiguous: SiteCandidate[] = [];

  for (const site of sites) {
    const liveOwns = cls.liveHosts.has(site.gatewayHost);
    if (liveOwns) continue; // a live tenant owns this hostname — keep it.

    const dead = cls.deadHosts.get(site.gatewayHost);
    const ipPointsAtLiveVm = site.upstreamIp ? liveIps.has(site.upstreamIp) : false;

    if (dead) {
      orphanCandidates.push({
        ...site,
        reason: ipPointsAtLiveVm ? "active-cross-tenant-leak" : "stale-tenant",
        detail: ipPointsAtLiveVm
          ? `hostname owned by ${dead.state} instance ${dead.id}; upstream ${site.upstreamIp} now hosts a DIFFERENT live VM`
          : `hostname owned by ${dead.state} instance ${dead.id}; upstream ${site.upstreamIp ?? "(none)"} not a live VM`,
      });
    } else if (!ipPointsAtLiveVm) {
      orphanCandidates.push({
        ...site,
        reason: "dead-route",
        detail: `no instance owns this hostname; upstream ${site.upstreamIp ?? "(none)"} not a live VM`,
      });
    } else {
      // No DB owner at all but the IP points at a live VM. Could be a live row
      // the query somehow missed — too risky to remove without DB evidence.
      ambiguous.push({
        ...site,
        reason: "active-cross-tenant-leak",
        detail: `no DB instance owns this hostname but upstream ${site.upstreamIp} hosts a live VM — review manually`,
      });
    }
  }

  if (!args.apply || orphanCandidates.length === 0) {
    return {
      host: hostSlug,
      totalSites: sites.length,
      orphanCandidates,
      ambiguous,
      removed: 0,
      reloadOk: true,
    };
  }

  const removeResult = await runProxmoxHostScript(
    buildProxmoxCaddySiteCleanupScript({
      gatewayHosts: orphanCandidates.map((s) => s.gatewayHost),
      caddySitesDir: CADDY_SITES_DIR,
    }),
    env,
  );

  return {
    host: hostSlug,
    totalSites: sites.length,
    orphanCandidates,
    ambiguous,
    removed: removeResult.ok ? orphanCandidates.length : 0,
    reloadOk: removeResult.ok && removeResult.stdout.includes("HERMES_CADDY_CLEANUP_RELOADED"),
    error: removeResult.ok
      ? undefined
      : `remove-and-reload script failed: ${removeResult.error || removeResult.stderr}`,
  };
}

async function main() {
  const args = parseArgs();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const allHosts = discoverHostSlugs(process.env);
  const targets = args.host ? allHosts.filter((h) => h === args.host) : allHosts;
  if (targets.length === 0) {
    throw new Error(
      args.host
        ? `Host ${args.host} not found in PROXMOX_<SLUG>_SSH_HOST env (${allHosts.join(", ") || "none"})`
        : "No Proxmox hosts configured (expected PROXMOX_<SLUG>_SSH_HOST env keys)",
    );
  }

  console.log(`[cleanup-orphan-caddy] mode=${args.apply ? "apply" : "dry-run"} hosts=${targets.join(",")}`);
  const cls = await classifyInstances(supabase);
  console.log(
    `[cleanup-orphan-caddy] live gateway hostnames: ${cls.liveHosts.size}; dead (archived/deleted) hostnames: ${cls.deadHosts.size}`,
  );

  const results: HostSweepResult[] = [];
  for (const host of targets) {
    console.log(`\n=== ${host} ===`);
    const result = await sweepHost(host, cls, args);
    results.push(result);
    if (result.error) {
      console.error(`  ERROR: ${result.error}`);
      continue;
    }
    console.log(`  total caddy sites: ${result.totalSites}`);
    console.log(`  orphan candidates: ${result.orphanCandidates.length}`);
    for (const o of result.orphanCandidates) {
      console.log(`    - [${o.reason}] ${o.filename}  upstream=${o.upstreamIp ?? "(none)"}  (${o.detail})`);
    }
    if (result.ambiguous.length > 0) {
      console.log(`  ambiguous (kept, review): ${result.ambiguous.length}`);
      for (const a of result.ambiguous) {
        console.log(`    ? ${a.filename}  upstream=${a.upstreamIp ?? "(none)"}  (${a.detail})`);
      }
    }
    if (args.apply) {
      console.log(`  removed: ${result.removed}, caddy reload: ${result.reloadOk ? "ok" : "FAILED"}`);
    }
  }

  const totalOrphans = results.reduce((acc, r) => acc + r.orphanCandidates.length, 0);
  const totalLeaks = results.reduce(
    (acc, r) => acc + r.orphanCandidates.filter((o) => o.reason === "active-cross-tenant-leak").length,
    0,
  );
  const totalRemoved = results.reduce((acc, r) => acc + r.removed, 0);
  const totalAmbiguous = results.reduce((acc, r) => acc + r.ambiguous.length, 0);
  console.log(
    `\n[cleanup-orphan-caddy] done. orphan candidates: ${totalOrphans} (active cross-tenant leaks: ${totalLeaks}; ambiguous kept: ${totalAmbiguous}). ${
      args.apply ? `removed: ${totalRemoved}.` : "Re-run with --apply to remove."
    }`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
