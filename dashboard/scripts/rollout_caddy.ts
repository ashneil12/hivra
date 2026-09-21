/**
 * Rollout the latest Caddy routing template across the running fleet.
 *
 * Calls ProfileService.updateAgentCaddyRouting(instanceId, userId) for
 * each target instance. That helper writes the Caddyfile, validates it,
 * reloads Caddy, runs the rollback health probe, and reports an
 * ops_events entry under source `profile-service.update-agent-caddy-routing`
 * — so the audit trail lives there, not in stdout.
 *
 * Flags:
 *   --instance <id>       Only act on this one instance (canary).
 *   --limit N             Cap the number of instances processed.
 *   --dry-run             Print targets and exit; do not SSH.
 *   --concurrency N       Parallel SSH operations (default 5).
 *   --include-proxmox     Include Proxmox instances (default: Hetzner only).
 *
 * Default behavior: Hetzner only (host_id IS NOT NULL). Proxmox
 * instances share a host and are normally patched separately to avoid
 * thundering-herd reloads on the shared Caddy.
 */

import { supabaseAdmin } from "../src/lib/supabase";
import { ProfileService } from "../src/lib/services/profile-service";

type Args = {
  instance?: string;
  limit?: number;
  dryRun: boolean;
  concurrency: number;
  includeProxmox: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, concurrency: 5, includeProxmox: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--include-proxmox") out.includeProxmox = true;
    else if (a === "--instance") out.instance = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: rollout_caddy [--instance <id>] [--limit N] [--dry-run] [--concurrency N] [--include-proxmox]",
      );
      process.exit(0);
    }
  }
  if (out.limit !== undefined && (!Number.isFinite(out.limit) || out.limit < 1)) {
    throw new Error(`--limit must be a positive integer, got: ${out.limit}`);
  }
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got: ${out.concurrency}`);
  }
  return out;
}

type Target = { id: string; user_id: string };

async function loadTargets(args: Args): Promise<Target[]> {
  if (args.instance) {
    const { data, error } = await supabaseAdmin!
      .from("hermes_instances")
      .select("id, user_id, host_id, proxmox_vmid")
      .eq("id", args.instance)
      .neq("status", "deleted")
      .maybeSingle();
    if (error) throw new Error(`fetch instance ${args.instance}: ${error.message}`);
    if (!data) throw new Error(`instance ${args.instance} not found or deleted`);
    return [{ id: data.id, user_id: data.user_id }];
  }

  let query = supabaseAdmin!
    .from("hermes_instances")
    .select("id, user_id, host_id, proxmox_vmid")
    .neq("status", "deleted")
    .not("host_id", "is", null);
  if (!args.includeProxmox) query = query.is("proxmox_vmid", null);

  const { data, error } = await query;
  if (error) throw new Error(`fetch instances: ${error.message}`);
  let rows = (data ?? []) as Array<{ id: string; user_id: string }>;
  if (args.limit !== undefined) rows = rows.slice(0, args.limit);
  return rows.map((r) => ({ id: r.id, user_id: r.user_id }));
}

async function refreshOne(target: Target): Promise<{ ok: true; ms: number } | { ok: false; ms: number; error: string }> {
  const t0 = Date.now();
  try {
    await ProfileService.updateAgentCaddyRouting(target.id, target.user_id);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function runWithConcurrency(targets: Target[], concurrency: number) {
  let cursor = 0;
  let success = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const target = targets[idx];
      const result = await refreshOne(target);
      if (result.ok) {
        success++;
        console.log(`  [${idx + 1}/${targets.length}] ok  ${target.id} (${result.ms}ms)`);
      } else {
        failed++;
        console.error(`  [${idx + 1}/${targets.length}] FAIL ${target.id} (${result.ms}ms): ${result.error}`);
      }
    }
  });
  await Promise.all(workers);
  return { success, failed };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const targets = await loadTargets(args);
  console.log(
    `Targets: ${targets.length} (instance=${args.instance ?? "fleet"}, limit=${args.limit ?? "none"}, includeProxmox=${args.includeProxmox}, concurrency=${args.concurrency}, dryRun=${args.dryRun})`,
  );

  if (args.dryRun) {
    for (const t of targets) console.log(`  would update ${t.id} (user ${t.user_id})`);
    console.log("Dry run; no changes made.");
    process.exit(0);
  }

  if (targets.length === 0) {
    console.log("No targets to update.");
    process.exit(0);
  }

  const { success, failed } = await runWithConcurrency(targets, args.concurrency);
  console.log(`Done. success=${success}/${targets.length} failed=${failed}`);
  console.log(`Audit trail: ops_events source='profile-service.update-agent-caddy-routing'`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Rollout aborted:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
