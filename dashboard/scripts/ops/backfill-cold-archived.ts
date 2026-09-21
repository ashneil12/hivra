import fs from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  parseColdStorageManifest,
  planColdArchivedBackfill,
  type ColdArchivedBackfillPlanItem,
  type ParsedColdStorageManifest,
} from "./backfill-cold-archived-plan";

loadEnvConfig(process.cwd());

type Args = {
  apply: boolean;
  confirmSourceVmsDestroyed: boolean;
  manifestFiles: string[];
  manifestDirs: string[];
  nowIso: string;
};

type HermesDatabase = SupabaseClient;

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: ts-node scripts/ops/backfill-cold-archived.ts [options]",
      "",
      "Backfills hermes_instances cold-storage fields from immutable Storage Box manifest JSON files.",
      "Dry-run is the default. Apply mode requires --confirm-source-vms-destroyed because it clears Proxmox routing fields.",
      "",
      "Options:",
      "  --manifest <file>                  Read one manifest JSON file; repeatable",
      "  --manifest-dir <dir>               Recursively read *.json files below a local directory; repeatable",
      "  --apply                            Write updates to Supabase",
      "  --confirm-source-vms-destroyed     Required with --apply",
      "  --now <iso>                        Override transition timestamp for deterministic runs",
      "  --help, -h                         Show this help",
      "",
    ].join("\n")
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    confirmSourceVmsDestroyed: false,
    manifestFiles: [],
    manifestDirs: [],
    nowIso: new Date().toISOString(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--confirm-source-vms-destroyed") {
      args.confirmSourceVmsDestroyed = true;
      continue;
    }
    if (arg === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manifest requires a file path");
      args.manifestFiles.push(value);
      index += 1;
      continue;
    }
    if (arg === "--manifest-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manifest-dir requires a directory path");
      args.manifestDirs.push(value);
      index += 1;
      continue;
    }
    if (arg === "--now") {
      const value = argv[index + 1];
      if (!value || !Number.isFinite(Date.parse(value))) {
        throw new Error("--now requires an ISO timestamp");
      }
      args.nowIso = new Date(value).toISOString();
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.manifestFiles.length === 0 && args.manifestDirs.length === 0) {
    throw new Error("Provide at least one --manifest or --manifest-dir");
  }

  return args;
}

function collectJsonFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files;
}

function readManifests(args: Args): ParsedColdStorageManifest[] {
  const files = Array.from(
    new Set([
      ...args.manifestFiles,
      ...args.manifestDirs.flatMap((dir) => collectJsonFiles(dir)),
    ])
  ).sort();

  return files.map((filePath) =>
    parseColdStorageManifest(fs.readFileSync(filePath, "utf8"), filePath)
  );
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}; export it before running the cold-storage backfill.`);
  }
  return value;
}

function createSupabaseAdmin(): HermesDatabase {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL.");
  }

  return createClient(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

async function applyBackfillItem(
  supabase: HermesDatabase,
  item: ColdArchivedBackfillPlanItem
): Promise<boolean> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .update(item.patch)
    .eq("id", item.manifest.instanceId)
    .is("deleted_at", null)
    .in("lifecycle_state", ["paused", "cold_archived"])
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to backfill ${item.manifest.instanceId} from ${item.manifest.manifestPath}: ${error.message}`
    );
  }

  return Boolean(data);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifests = readManifests(args);
  const plan = planColdArchivedBackfill({
    manifests,
    apply: args.apply,
    confirmSourceVmsDestroyed: args.confirmSourceVmsDestroyed,
    nowIso: args.nowIso,
  });

  process.stdout.write(
    `[backfill-cold-archived] ${args.apply ? "APPLY" : "DRY-RUN"} manifests=${manifests.length} instances=${plan.items.length} older_generations=${plan.skippedOlderGenerations}\n`
  );

  for (const item of plan.items) {
    process.stdout.write(
      [
        `[backfill-cold-archived] PLAN instance=${item.manifest.instanceId}`,
        `manifest=${item.manifest.manifestPath}`,
        `archive=${item.manifest.archiveUri}`,
        `sha256=${item.manifest.archiveSha256.slice(0, 12)}...`,
        `source=${item.manifest.sourceProxmoxNode}/${item.manifest.sourceProxmoxVmid}`,
      ].join(" ") + "\n"
    );
  }

  if (!args.apply) return;

  const supabase = createSupabaseAdmin();
  let updated = 0;
  let skipped = 0;

  for (const item of plan.items) {
    if (await applyBackfillItem(supabase, item)) {
      updated += 1;
      process.stdout.write(`[backfill-cold-archived] UPDATED instance=${item.manifest.instanceId}\n`);
    } else {
      skipped += 1;
      process.stdout.write(
        `[backfill-cold-archived] SKIPPED instance=${item.manifest.instanceId} reason=row_missing_deleted_or_not_paused\n`
      );
    }
  }

  process.stdout.write(`[backfill-cold-archived] done updated=${updated} skipped=${skipped}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `[backfill-cold-archived] ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
