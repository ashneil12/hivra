// Find Hermes instances whose Clerk owner has been deleted.
//
// Why this exists: a Hermes instance row can outlive its Clerk owner
// (account self-deletion, abuse purge, manual cleanup) while the VM is
// still up and consuming Hetzner / Proxmox capacity. Until we surface
// these proactively, fleet sweeps that read `instance.user_id` and look
// up Clerk just throw on the orphaned row and quietly skip it — the
// 2026-05-01 incident that left one tenant pinned to vanilla-hermes-
// agent while the other 38 moved to hermes-webui:stable.
//
// Identical logic runs weekly in /api/cron/check-orphaned-instances; this
// CLI just gives a manual / dry-run-able way to inspect or trigger the
// same sweep.
//
// What `--apply` does, per orphan row not already flagged:
//   1. Shut down the Hetzner VM (best effort)
//   2. status = 'scheduled_for_deletion', scheduled_deletion_at = now+3d
//   3. config.owner_orphaned = true, owner_orphaned_at = now
//   4. Emit an ops_events entry
// Then the existing /api/cron/purge-expired sweeper handles teardown
// when the deadline passes.
//
// Usage:
//   npm run ops:flag-orphaned -- --dry-run
//   npm run ops:flag-orphaned -- --apply
//   npm run ops:flag-orphaned -- --dry-run --instance <id>

import path from "path";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { clerkClient } from "@clerk/nextjs/server";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import { shutdownServer } from "../src/lib/hetzner/client";
import {
  alreadyFlagged,
  classifyByClerkOwnership,
  listLiveInstances,
  ORPHAN_GRACE_HOURS,
  runOrphanSweep,
  type InstanceShutdownFn,
  type InstanceShutdownResult,
  type OrphanedInstanceRow,
} from "../src/lib/recovery/orphaned-instances";
import {
  getProxmoxInfrastructure,
  shutdownProxmoxInstance,
} from "../src/lib/services/proxmox-instance-service";

interface Args {
  apply: boolean;
  instanceId: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const idx = argv.indexOf("--instance");
  const instanceId = idx >= 0 ? argv[idx + 1] || null : null;
  if (!apply && !dryRun) {
    throw new Error("Pass either --apply or --dry-run.");
  }
  if (apply && dryRun) {
    throw new Error("Pass either --apply or --dry-run, not both.");
  }
  return { apply, instanceId };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in dashboard/.env.local",
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
  const clerk = await clerkClient();

  // Always print the per-row table for visibility, even on --apply.
  const rows = await listLiveInstances(supabase, { instanceId: args.instanceId });
  console.log(`Discovered ${rows.length} non-deleted hermes_instances row(s).`);
  if (!args.apply) {
    console.log(
      "(read-only — pass --apply to disable + schedule deletion in " +
        `${ORPHAN_GRACE_HOURS}h)`,
    );
  }
  const checks = await classifyByClerkOwnership(rows, clerk.users);
  for (const check of checks) {
    if (check.status === "alive") continue;
    const { row } = check;
    const flagSuffix = alreadyFlagged(row) ? " (already flagged)" : "";
    const tag = check.status === "orphan" ? "✗ ORPHAN   " : "?  lookup-fail";
    console.log(
      `${tag}  ${row.id}  user=${row.user_id}  status=${row.status}  backend=${row.backend ?? "(null)"}  name=${row.name ?? "(null)"}  created=${row.created_at}${flagSuffix}`,
    );
  }

  // Mirror the cron's row-aware shutdown so prod + CLI behave identically.
  const shutdownInstance: InstanceShutdownFn = async (
    row: OrphanedInstanceRow,
  ): Promise<InstanceShutdownResult> => {
    const proxmox = getProxmoxInfrastructure(row.config);
    if (proxmox) {
      const result = await shutdownProxmoxInstance(proxmox);
      if (result.ok) return { ok: true };
      return {
        ok: false,
        detail: (result.error || result.stderr || "proxmox shutdown failed").slice(0, 240),
      };
    }
    if (row.host_id) {
      const { count } = await supabase
        .from("hermes_instances")
        .select("id", { count: "exact", head: true })
        .eq("host_id", row.host_id)
        .neq("status", "deleted")
        .neq("id", row.id);
      if ((count ?? 0) > 0) {
        return {
          ok: false,
          skipped: true,
          detail: `shared host has ${count} other live instance(s)`,
        };
      }
      const { data: host } = await supabase
        .from("hermes_hosts")
        .select("hetzner_server_id")
        .eq("id", row.host_id)
        .single<{ hetzner_server_id: number | null }>();
      if (!host?.hetzner_server_id) {
        return { ok: false, detail: "no hetzner_server_id on host" };
      }
      try {
        await shutdownServer(host.hetzner_server_id);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (row.hetzner_server_id != null) {
      try {
        await shutdownServer(row.hetzner_server_id);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { ok: false, detail: "no infrastructure reference on row" };
  };

  const summary = await runOrphanSweep({
    supabase,
    clerk: clerk.users,
    apply: args.apply,
    filter: { instanceId: args.instanceId },
    shutdownInstance: args.apply ? shutdownInstance : undefined,
  });

  console.log("\n=== summary ===");
  console.log(`  total checked:    ${summary.totalChecked}`);
  console.log(`  alive:            ${summary.alive}`);
  console.log(`  orphans:          ${summary.orphans}`);
  if (args.apply) {
    console.log(`  newly disabled:   ${summary.newlyDisabled}`);
    console.log(`  shutdown errors:  ${summary.shutdownFailures}`);
  }
  if (summary.lookupFailures > 0) {
    console.log(
      `  lookup failures:  ${summary.lookupFailures}  (re-run after Clerk recovers)`,
    );
  }
}

main().catch((err) => {
  console.error("flag-orphaned-instances failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
