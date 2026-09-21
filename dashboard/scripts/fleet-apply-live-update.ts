// Fleet sweep: run the full Hermes live-update path for running WebUI
// instances. This is stronger than ops:webui:fleet-pull because it rebuilds
// the per-instance config/artifacts and re-seeds the vanilla agent source
// volume, which is required for runtime-only changes like Bankr wallet envs.
//
// Usage:
//   npm run ops:webui:fleet-live-update -- --dry-run
//   npm run ops:webui:fleet-live-update -- --apply --concurrency 3
//   npm run ops:webui:fleet-live-update -- --apply --instance <id>

import path from "path";
import * as dotenv from "dotenv";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { clerkClient } from "@clerk/nextjs/server";
import type { InstanceRowForOrchestration } from "../src/lib/services/instance-orchestrator";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import { extractGlobalHermesSettings } from "../src/lib/instance-settings";
import {
  captureFleetUpdateFailure,
  classifyFleetUpdateReport,
  FLEET_LIVE_UPDATE_BACKENDS,
  filterStaleInstances,
  parseFleetLiveUpdateArgs,
  type FleetLiveUpdateArgs as Args,
  type FleetUpdateResult,
} from "../src/lib/ops/fleet-live-update-helpers";

const UPDATE_REPORT_TIMEOUT_MS = 12 * 60 * 1000;
const UPDATE_REPORT_POLL_MS = 10_000;

type InstanceRow = InstanceRowForOrchestration & {
  name: string;
  status: string;
  infrastructure_provider?: string | null;
  proxmox_vmid?: number | null;
  last_synced_at?: string | null;
};

function parseArgs(): Args {
  return parseFleetLiveUpdateArgs(process.argv.slice(2));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in dashboard/.env.local`);
  return value;
}

function readSupabaseProjectRef(): string | null {
  try {
    return readFileSync(path.join(__dirname, "../supabase/.temp/project-ref"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function resolveSupabaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (configured) return configured;

  const projectRef = readSupabaseProjectRef();
  if (projectRef) return `https://${projectRef}.supabase.co`;

  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL and no Supabase CLI project-ref was found.");
}

function resolveSupabaseServiceRoleKey(): string {
  const configured = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (configured) return configured;

  const projectRef = readSupabaseProjectRef();
  if (projectRef) {
    try {
      const raw = execFileSync(
        "supabase",
        ["projects", "api-keys", "--project-ref", projectRef, "--output", "json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const keys = JSON.parse(raw) as Array<{ name?: string; type?: string; api_key?: string }>;
      const projectSecret =
        keys.find((entry) => entry.type === "secret")?.api_key ||
        keys.find((entry) => entry.name === "service_role")?.api_key;
      if (projectSecret) return projectSecret;
    } catch {
      // Fall through to the normal missing-env error.
    }
  }

  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

const resolvedSupabaseUrl = resolveSupabaseUrl();
const resolvedSupabaseServiceRoleKey = resolveSupabaseServiceRoleKey();

// Shared server modules create their admin client from process.env at import
// time. Populate the linked-project fallback before lazy-loading them so
// managed host fingerprints and other DB-backed safety checks stay available
// in local ops runs where NEXT_PUBLIC_SUPABASE_URL is intentionally unset.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= resolvedSupabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY ||= resolvedSupabaseServiceRoleKey;

const supabase = createClient(
  resolvedSupabaseUrl,
  resolvedSupabaseServiceRoleKey,
  { auth: { persistSession: false } }
);

let orchestratorImport: Promise<typeof import("../src/lib/services/instance-orchestrator")> | null = null;

function getOrchestrator() {
  orchestratorImport ??= import("../src/lib/services/instance-orchestrator");
  return orchestratorImport;
}

async function listInstances(args: Args): Promise<InstanceRow[]> {
  let query = supabase
    .from("hermes_instances")
    .select([
      "id",
      "name",
      "status",
      "backend",
      "provider",
      "subdomain",
      "hetzner_server_id",
      "gateway_url",
      "api_key_encrypted",
      "api_server_key_encrypted",
      "honcho_api_key_encrypted",
      "config",
      "host_id",
      "ipv4_address",
      "cpu_limit",
      "ram_limit",
      "user_id",
      "infrastructure_provider",
      "proxmox_vmid",
      "last_synced_at",
    ].join(", "))
    .in("backend", [...FLEET_LIVE_UPDATE_BACKENDS])
    .eq("status", "running");

  if (args.instanceId) {
    query = query.eq("id", args.instanceId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not list instances: ${error.message}`);
  return filterStaleInstances((data || []) as unknown as InstanceRow[], args.staleSince);
}

const globalSettingsCache = new Map<string, Promise<Record<string, unknown>>>();

function getGlobalSettings(userId: string): Promise<Record<string, unknown>> {
  if (!globalSettingsCache.has(userId)) {
    globalSettingsCache.set(userId, (async () => {
      try {
        const clerk = await clerkClient();
        const user = await clerk.users.getUser(userId);
        return extractGlobalHermesSettings(user.publicMetadata);
      } catch (err) {
        console.warn(
          `[fleet-live-update] user ${userId}: Clerk metadata unavailable, using defaults (${(err as Error).message})`
        );
        return {};
      }
    })());
  }
  return globalSettingsCache.get(userId)!;
}

async function updateOne(instance: InstanceRow, args: Args): Promise<FleetUpdateResult> {
  return captureFleetUpdateFailure(instance, async () => {
    const { applyLiveUpdate, resolveInstanceIpv4 } = await getOrchestrator();
    const name = instance.name || instance.id;

    let ipv4 = "";
    try {
      ipv4 = await resolveInstanceIpv4(instance, supabase);
    } catch (err) {
      return {
        instanceId: instance.id,
        name,
        status: "skipped",
        detail: `could not resolve IP: ${(err as Error).message}`,
      };
    }

    if (!ipv4) {
      return {
        instanceId: instance.id,
        name,
        status: "skipped",
        detail: "no reachable IP recorded",
      };
    }

    if (args.dryRun) {
      return {
        instanceId: instance.id,
        name,
        status: "skipped",
        detail: `dry run: would apply live update at ${ipv4}`,
      };
    }

    const globalSettings = await getGlobalSettings(instance.user_id);
    // The guest update is launched with nohup, so applyLiveUpdate returning is
    // only dispatch acknowledgement. Capture the boundary before dispatch and
    // hold this concurrency slot until the guest's signed callback says the
    // update really finished. Otherwise --concurrency 3 can launch the entire
    // fleet in minutes and provide false "updated" results.
    const launchedAt = new Date().toISOString();
    const result = await applyLiveUpdate(instance, ipv4, globalSettings, supabase);
    if (!result.applied) {
      return {
        instanceId: instance.id,
        name,
        status: "failed",
        detail: result.error || "applyLiveUpdate returned not applied",
      };
    }

    const deadline = Date.now() + UPDATE_REPORT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { data: events, error: eventsError } = await supabase
        .from("ops_events")
        .select("title, last_seen_at, metadata")
        .eq("instance_id", instance.id)
        .eq("source", "instance-update-status")
        .in("title", ["Manual update succeeded", "Manual update failed"])
        .gte("last_seen_at", launchedAt)
        .order("last_seen_at", { ascending: false });
      if (eventsError) {
        console.warn(
          `[fleet-live-update] instance ${instance.id}: callback query failed (${eventsError.message})`,
        );
      } else {
        const report = classifyFleetUpdateReport(events || [], launchedAt);
        if (report?.status === "succeeded") {
          return {
            instanceId: instance.id,
            name,
            status: "updated",
            detail: "live update completed",
          };
        }
        if (report?.status === "failed") {
          return {
            instanceId: instance.id,
            name,
            status: "failed",
            detail: report.detail,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, UPDATE_REPORT_POLL_MS));
    }

    return {
      instanceId: instance.id,
      name,
      status: "failed",
      detail: "timed out waiting for the signed guest update callback",
    };
  }, (detail) => {
    console.error(`[fleet-live-update] instance ${instance.id} failed without aborting sweep: ${detail}`);
  });
}

async function runConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const instances = await listInstances(args);

  console.log(`Discovered ${instances.length} running WebUI instance(s).`);
  if (args.staleSince) {
    console.log(`Filter: last_synced_at before ${args.staleSince}`);
  }
  console.log(args.dryRun ? "Mode: dry run" : `Mode: apply, concurrency ${args.concurrency}`);

  const startedAt = Date.now();
  const results = await runConcurrent(instances, args.concurrency, async (instance) => {
    const result = await updateOne(instance, args);
    const tag =
      result.status === "updated"
        ? "UPDATED"
        : result.status === "failed"
          ? "FAILED "
          : "SKIPPED";
    console.log(
      `${tag} ${result.instanceId.slice(0, 8)} ${(result.name || "").slice(0, 32).padEnd(32)} ${result.detail}`
    );
    return result;
  });

  const counts = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});

  console.log("\n=== summary ===");
  console.log(`elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  for (const [status, count] of Object.entries(counts)) {
    console.log(`${status}: ${count}`);
  }

  if (results.some((result) => result.status === "failed")) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[fleet-live-update] fatal:", err);
  process.exit(1);
});
