// Fleet sweep: pull the latest ghcr.io/ashneil12/hermes-webui:stable image
// on every running WebUI instance and force-recreate the container so it
// runs the new code. Use after re-publishing :stable from a master rebase
// or hot-fix push.
//
// Why this exists: instances pin to :stable in their compose files, but
// docker doesn't auto-poll. After CI republishes the tag, every box still
// runs whatever sha they pulled at provision/last-recreate. This sweep
// brings the fleet to current.
//
// What it does, per running WebUI instance:
//   1. docker compose pull   (fetches new :stable, no-op if unchanged)
//   2. docker compose up -d --force-recreate (only if image actually moved)
//   3. wait for /health      (max 60s)
//   4. capture old vs new image digest for the report
//
// Skips:
//   - status != "running"   (stopped/provisioning/error/deleted) — they'll
//     get the new image whenever they next start
//   - backend != "webui"    (gateway-backed instances aren't on this image)
//
// Usage:
//   npm run ops:webui:fleet-pull -- --dry-run                 # preview
//   npm run ops:webui:fleet-pull -- --apply                   # the sweep
//   npm run ops:webui:fleet-pull -- --instance <id> --apply   # one box
//   npm run ops:webui:fleet-pull -- --apply --concurrency 5   # parallel
//
// Idempotent: if compose pull reports the image is already current, we
// skip the recreate entirely (no needless container churn / chat drops).

import path from "path";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { sshExec } from "../src/lib/hetzner/ssh";
import { resolveInstanceIpv4, type InstanceRowForOrchestration } from "../src/lib/services/instance-orchestrator";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

type InstanceRow = InstanceRowForOrchestration & {
  name: string;
  status: string;
  backend?: "gateway" | "webui" | null;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in dashboard/.env.local");
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

interface Args {
  apply: boolean;
  dryRun: boolean;
  instanceId: string | null;
  concurrency: number;
}

interface SweepResult {
  instanceId: string;
  name: string;
  status: "updated" | "already-current" | "skipped" | "failed";
  detail?: string;
  oldDigest?: string;
  newDigest?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const instIdx = argv.indexOf("--instance");
  const instanceId = instIdx >= 0 ? argv[instIdx + 1] || null : null;
  const concIdx = argv.indexOf("--concurrency");
  const concurrency = concIdx >= 0 ? Math.max(1, Math.min(10, Number(argv[concIdx + 1]) || 1)) : 1;
  if (!apply && !dryRun) {
    throw new Error("Pass --apply to update or --dry-run to preview.");
  }
  return { apply, dryRun, instanceId, concurrency };
}

async function listInstances(filter: { instanceId: string | null }): Promise<InstanceRow[]> {
  let query = supabase
    .from("hermes_instances")
    .select("id, name, status, backend, gateway_url, host_id, hetzner_server_id, ipv4_address, provider, user_id")
    .eq("backend", "webui")
    .eq("status", "running");
  if (filter.instanceId) {
    query = query.eq("id", filter.instanceId);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Supabase list failed: ${error.message}`);
  return (data || []) as InstanceRow[];
}

async function sweepOne(instance: InstanceRow, args: Args): Promise<SweepResult> {
  const { id: instanceId, name } = instance;
  let ip: string;
  try {
    ip = await resolveInstanceIpv4(instance, supabase);
  } catch (err) {
    return { instanceId, name, status: "skipped", detail: `ipv4 resolve: ${(err as Error).message}` };
  }
  if (!ip) {
    return { instanceId, name, status: "skipped", detail: "no ipv4 resolved" };
  }

  if (args.dryRun) {
    return { instanceId, name, status: "skipped", detail: `(dry run) would sweep at ${ip}` };
  }

  const containerName = `agent-${instanceId}`;
  // The remote script:
  //   - capture current image digest
  //   - docker compose pull
  //   - capture new digest
  //   - if changed → force-recreate + wait for health
  //   - if unchanged → skip
  const remoteScript = `set -e
DIR=/opt/hermes/instances/${instanceId}
cd "$DIR"
# OLD_DIGEST = SHA the container is currently running (from docker inspect on
# the container itself). NEW_DIGEST = SHA the local docker daemon has cached
# for the :stable tag (queried via docker image inspect on the tag, NOT
# docker compose images — that returns the compose-record SHA which equals
# OLD_DIGEST regardless of what 'docker compose pull' just fetched).
OLD_DIGEST=$(docker inspect ${containerName} --format '{{.Image}}' 2>/dev/null || echo "none")
docker compose pull 2>&1 | tail -3
NEW_DIGEST=$(docker image inspect ghcr.io/ashneil12/hermes-webui:stable --format '{{.Id}}' 2>/dev/null || echo "unknown")
echo "OLD_DIGEST=$OLD_DIGEST"
echo "NEW_DIGEST=$NEW_DIGEST"
if [ "$OLD_DIGEST" = "$NEW_DIGEST" ] && [ "$OLD_DIGEST" != "none" ]; then
  echo "ALREADY_CURRENT"
  exit 0
fi
docker compose up -d --force-recreate 2>&1 | tail -2
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1/health >/dev/null 2>&1; then
    echo "UPDATED_OK"
    exit 0
  fi
  sleep 2
done
echo "HEALTH_TIMEOUT" >&2
exit 1
`;

  const result = await sshExec(ip, remoteScript, { timeoutMs: 180_000 });
  if (!result.ok) {
    return {
      instanceId,
      name,
      status: "failed",
      detail: `ssh err=${result.error || ""} stderr=${result.stderr.slice(0, 200)}`,
    };
  }

  const oldMatch = result.stdout.match(/OLD_DIGEST=(\S+)/);
  const newMatch = result.stdout.match(/NEW_DIGEST=(\S+)/);
  const oldDigest = oldMatch?.[1]?.slice(0, 19);
  const newDigest = newMatch?.[1]?.slice(0, 19);

  if (result.stdout.includes("ALREADY_CURRENT")) {
    return { instanceId, name, status: "already-current", oldDigest, newDigest };
  }
  if (result.stdout.includes("UPDATED_OK")) {
    return { instanceId, name, status: "updated", oldDigest, newDigest };
  }
  return {
    instanceId,
    name,
    status: "failed",
    detail: `unexpected: ${result.stdout.slice(-200)}`,
    oldDigest,
    newDigest,
  };
}

async function runConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push((async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await worker(items[idx]);
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const instances = await listInstances({ instanceId: args.instanceId });
  console.log(`Discovered ${instances.length} running WebUI instance(s).`);
  if (args.dryRun) console.log("(dry run — no changes will be made)");
  if (!args.dryRun) console.log(`Concurrency: ${args.concurrency}`);

  const startTs = Date.now();
  const results = await runConcurrent(instances, args.concurrency, async (instance) => {
    const r = await sweepOne(instance, args);
    const tag = r.status === "updated" ? "✓ UPDATED"
              : r.status === "already-current" ? "≡ already-current"
              : r.status === "skipped" ? "·  skipped"
              : "✗ FAILED";
    const detail = r.detail ? ` (${r.detail})` : "";
    const digests = r.oldDigest && r.newDigest && r.oldDigest !== r.newDigest
      ? ` ${r.oldDigest}…→${r.newDigest}…`
      : "";
    console.log(`${tag}  ${instance.id.slice(0, 8)}  ${(instance.name || "").slice(0, 28).padEnd(28)}${digests}${detail}`);
    return r;
  });

  const elapsed = Math.round((Date.now() - startTs) / 1000);
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log("\n=== summary ===");
  console.log(`  elapsed: ${elapsed}s`);
  for (const [status, count] of Object.entries(counts)) {
    console.log(`  ${status}: ${count}`);
  }

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    console.log("\n=== failures ===");
    for (const f of failed) console.log(`  ${f.instanceId} (${f.name}): ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fleet sweep failed:", err);
  process.exit(1);
});
