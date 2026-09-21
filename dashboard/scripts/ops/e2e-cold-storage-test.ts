/**
 * End-to-end smoke test of the cold-storage service against the real fleet.
 *
 * Drives the actual `archiveInstance` and `restoreInstance` functions from
 * cold-storage-service.ts using the live Supabase service role and the real
 * SSH transport to PVE hosts. Validates that:
 *
 *   1. archiveInstance flips a `paused` row to `cold_archived`, records the
 *      manifest fields, and destroys the source VM.
 *   2. restoreInstance flips the now-cold row to `active`, provisions a new
 *      VM on the chosen destination host, and points the row at it.
 *
 * This is the same code path Phase 3's Start handler will call. Running it
 * by hand validates the integration before the dashboard wraps it.
 *
 * Usage (from dashboard/):
 *   pnpm ts-node scripts/ops/e2e-cold-storage-test.ts --instance <uuid> \
 *     --destination-host fixturenodea --destination-vmid 998 \
 *     --destination-ip 10.250.20.199 --destination-gateway 10.250.20.1 \
 *     --template 9004 [--apply]
 *
 * Dry-run is the default — it loads the row and prints the plan without
 * touching anything. --apply runs both archive and restore in sequence.
 */

import { createClient } from "@supabase/supabase-js";

import {
  archiveInstance,
  restoreInstance,
} from "../../src/lib/services/cold-storage-service";

// Caller is expected to set env via shell or `node -r dotenv/config` because
// .env.local / .env.production.local locally have NEXT_PUBLIC_SUPABASE_URL
// masked as "" (the --sensitive footgun). Loading them here would clobber a
// good shell-provided URL with that empty string.

type Args = {
  apply: boolean;
  instanceId: string;
  destinationHostSlug: string;
  destinationVmid: number;
  destinationIp: string;
  destinationGateway: string;
  templateVmid: number;
  /** Skip the archive step (assume the row is already cold_archived). */
  skipArchive: boolean;
  /** Skip the restore step (only archive). */
  skipRestore: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    apply: false,
    skipArchive: false,
    skipRestore: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${arg}`);
      i++;
      return v;
    };
    switch (arg) {
      case "--apply": args.apply = true; break;
      case "--instance": args.instanceId = next(); break;
      case "--destination-host": args.destinationHostSlug = next(); break;
      case "--destination-vmid": args.destinationVmid = Number.parseInt(next(), 10); break;
      case "--destination-ip": args.destinationIp = next(); break;
      case "--destination-gateway": args.destinationGateway = next(); break;
      case "--template": args.templateVmid = Number.parseInt(next(), 10); break;
      case "--skip-archive": args.skipArchive = true; break;
      case "--skip-restore": args.skipRestore = true; break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown arg ${arg}`);
    }
  }
  const required: Array<keyof Args> = [
    "instanceId",
    "destinationHostSlug",
    "destinationVmid",
    "destinationIp",
    "destinationGateway",
    "templateVmid",
  ];
  for (const k of required) {
    if (args[k] === undefined || args[k] === "" || (typeof args[k] === "number" && Number.isNaN(args[k]))) {
      throw new Error(`Missing required arg --${k}`);
    }
  }
  return args as Args;
}

function printUsage(): void {
  process.stdout.write(`
Usage: ts-node scripts/ops/e2e-cold-storage-test.ts [flags]

Required:
  --instance <uuid>             Instance id of a paused free-tier tenant
  --destination-host <slug>     e.g. fixturenodea
  --destination-vmid <int>      Free VMID on destination host
  --destination-ip <ip>         IP in destination host's subnet
  --destination-gateway <ip>    Destination host's vmbr1 gateway
  --template <vmid>             Template VMID on destination host

Optional:
  --apply                       Actually run archive + restore (default: dry-run)
  --skip-archive                Skip archive step (row must already be cold_archived)
  --skip-restore                Only archive, do not restore
  --help                        Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }
  process.stdout.write(`[e2e-cold] supabase url=${supabaseUrl} keylen=${serviceKey.length}\n`);
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Snapshot the row up-front for reporting
  const beforeQuery = await supabase
    .from("hermes_instances")
    .select(
      "id,name,proxmox_node,proxmox_vmid,ipv4_address,resource_tier,lifecycle_state,status,paused_reason,archive_uri,archived_at,archive_size_bytes,archive_sha256"
    )
    .eq("id", args.instanceId)
    .maybeSingle();

  process.stdout.write(`[e2e-cold] ${args.apply ? "APPLY" : "DRY-RUN"} instance=${args.instanceId}\n`);
  process.stdout.write(`[e2e-cold] BEFORE query: status=${beforeQuery.status} error=${JSON.stringify(beforeQuery.error)}\n`);
  process.stdout.write(`[e2e-cold] BEFORE: ${JSON.stringify(beforeQuery.data, null, 2)}\n`);

  if (!args.apply) {
    process.stdout.write(
      `[e2e-cold] dry-run: would run archive (if state=paused) then restore to ${args.destinationHostSlug}/${args.destinationVmid}\n`
    );
    return;
  }

  // ── archive ─────────────────────────────────────────────────────────────────
  if (!args.skipArchive) {
    process.stdout.write(`[e2e-cold] calling archiveInstance...\n`);
    const t0 = Date.now();
    const result = await archiveInstance(supabase, args.instanceId);
    const dt = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`[e2e-cold] archiveInstance returned in ${dt}s:\n${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(`[e2e-cold] archive failed; aborting\n`);
      process.exit(1);
    }
  }

  // ── restore ─────────────────────────────────────────────────────────────────
  if (!args.skipRestore) {
    process.stdout.write(`[e2e-cold] calling restoreInstance to ${args.destinationHostSlug}/${args.destinationVmid}...\n`);
    const t0 = Date.now();
    const result = await restoreInstance(supabase, args.instanceId, {
      destinationHostSlug: args.destinationHostSlug,
      destinationVmid: args.destinationVmid,
      destinationIp: args.destinationIp,
      destinationGateway: args.destinationGateway,
      templateVmid: args.templateVmid,
      targetDiskGb: 30,
    });
    const dt = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`[e2e-cold] restoreInstance returned in ${dt}s:\n${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(`[e2e-cold] restore failed\n`);
      process.exit(2);
    }
  }

  // ── snapshot after ──────────────────────────────────────────────────────────
  const { data: after } = await supabase
    .from("hermes_instances")
    .select(
      "id,name,proxmox_node,proxmox_vmid,ipv4_address,resource_tier,lifecycle_state,status,paused_reason,archive_uri,archived_at,archive_size_bytes,archive_sha256"
    )
    .eq("id", args.instanceId)
    .maybeSingle();
  process.stdout.write(`[e2e-cold] AFTER: ${JSON.stringify(after, null, 2)}\n`);
  process.stdout.write(`[e2e-cold] OK\n`);
}

main().catch((err) => {
  process.stderr.write(`[e2e-cold] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
