// Fleet migration: move WebUI auth from Python (HERMES_WEBUI_PASSWORD) to
// Caddy edge enforcement (Authorization: Bearer <api_server_key>).
//
// Why: WebUI's Python ThreadingHTTPServer runs auth checks under the GIL,
// so each authenticated call costs ~1.3s under contention. Caddy is Go +
// async; a header check is sub-millisecond. Live measurement on one
// instance: /health 5.81s → 5ms, /api/sessions 4.75s → 34ms.
//
// What this script does, per WebUI-backed instance:
//   1. Generate a tightened Caddyfile (uses buildWebUICaddyfile) baked
//      with the per-instance API key as the expected bearer token.
//   2. Drop HERMES_WEBUI_PASSWORD from both compose .env and persisted
//      webui-state .env so future live updates cannot resurrect Python auth.
//   3. caddy reload + recreate the WebUI container.
//   4. Probe /health to confirm.
//
// Usage:
//   npm run ops:webui:migrate-caddy-auth -- --apply
//   npm run ops:webui:migrate-caddy-auth -- --instance <id> --apply
//   npm run ops:webui:migrate-caddy-auth -- --dry-run        # list only
//
// Idempotent: instances are skipped only when Caddy already contains the
// bearer matcher AND the retired WebUI password env is absent.

// SCRIPTURE_ANCHOR: migrate-pillar | Exodus 13:21 | Verse: Yahweh went before them by day in a pillar of cloud, to lead them on their way.
import path from "path";
import * as dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptApiKey } from "../src/lib/crypto";
import { sshExec } from "../src/lib/hetzner/ssh";
import { resolveInstanceIpv4, type InstanceRowForOrchestration } from "../src/lib/services/instance-orchestrator";
import { buildWebUICaddyfile } from "../src/lib/services/webui-instance-builder";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

type InstanceRow = InstanceRowForOrchestration & {
  name: string;
  status: string;
  backend?: "gateway" | "webui" | null;
  subdomain?: string | null;
};

let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (supabase) return supabase;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in dashboard/.env.local");
  }

  supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  return supabase;
}

interface Args {
  apply: boolean;
  dryRun: boolean;
  instanceId: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const idx = argv.indexOf("--instance");
  const instanceId = idx >= 0 ? argv[idx + 1] || null : null;
  if (!apply && !dryRun) {
    throw new Error("Pass --apply to migrate or --dry-run to preview. (No-op without either flag.)");
  }
  return { apply, dryRun, instanceId };
}

async function listInstances(filter: { instanceId: string | null }): Promise<InstanceRow[]> {
  let query = getSupabaseClient()
    .from("hermes_instances")
    .select("id, name, status, backend, subdomain, gateway_url, api_server_key_encrypted, host_id, hetzner_server_id, ipv4_address, provider, user_id")
    .eq("backend", "webui")
    .neq("status", "deleted");

  if (filter.instanceId) {
    query = query.eq("id", filter.instanceId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Supabase list failed: ${error.message}`);
  return (data || []) as unknown as InstanceRow[];
}

export function buildWebUICaddyAuthMigrationProbeCommand(params: {
  instanceId: string;
  containerName: string;
}): string {
  return `set -e
DIR=/opt/hermes/instances/${params.instanceId}
CADDY=$DIR/Caddyfile
ENVF=$DIR/.env
STATE_ENV_DIR="$(docker volume inspect ${params.containerName}_webui-state --format '{{ .Mountpoint }}' 2>/dev/null || true)"
STATE_ENVF="$STATE_ENV_DIR/.env"
if grep -F '@authBearer header Authorization' "$CADDY" >/dev/null 2>&1; then
  echo CADDY_MIGRATED
else
  echo CADDY_NOT_MIGRATED
fi
if { [ -f "$ENVF" ] && grep -q '^HERMES_WEBUI_PASSWORD=' "$ENVF"; } || \\
   { [ -n "$STATE_ENV_DIR" ] && [ -f "$STATE_ENVF" ] && grep -q '^HERMES_WEBUI_PASSWORD=' "$STATE_ENVF"; }; then
  echo WEBUI_PASSWORD_PRESENT
else
  echo WEBUI_PASSWORD_ABSENT
fi
`;
}

export function isWebUICaddyAuthFullyMigrated(probeOutput: string): boolean {
  return probeOutput.includes("CADDY_MIGRATED") && probeOutput.includes("WEBUI_PASSWORD_ABSENT");
}

export function buildWebUICaddyAuthMigrationRemoteScript(params: {
  instanceId: string;
  containerName: string;
  caddyfileBase64: string;
}): string {
  return `set -e
DIR=/opt/hermes/instances/${params.instanceId}
CADDY=$DIR/Caddyfile
ENVF=$DIR/.env
STATE_ENV_DIR="$(docker volume inspect ${params.containerName}_webui-state --format '{{ .Mountpoint }}' 2>/dev/null || true)"
STATE_ENVF="$STATE_ENV_DIR/.env"
TS=$(date +%s)
cp "$CADDY" "$CADDY.bak.$TS" 2>/dev/null || true
cp "$ENVF" "$ENVF.bak.$TS" 2>/dev/null || true
if [ -n "$STATE_ENV_DIR" ] && [ -f "$STATE_ENVF" ]; then
  cp "$STATE_ENVF" "$STATE_ENVF.bak.$TS" 2>/dev/null || true
fi
echo ${params.caddyfileBase64} | base64 -d > "$CADDY"
if [ -f "$ENVF" ]; then
  sed -i '/^HERMES_WEBUI_PASSWORD=/d' "$ENVF"
fi
if [ -n "$STATE_ENV_DIR" ] && [ -f "$STATE_ENVF" ]; then
  sed -i '/^HERMES_WEBUI_PASSWORD=/d' "$STATE_ENVF"
fi
docker exec hermes-caddy-1 caddy reload --config /etc/caddy/Caddyfile 2>&1 | tail -2
docker rm -f ${params.containerName} >/dev/null 2>&1 || true
cd "$DIR" && docker compose up -d 2>&1 | tail -2
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1 || \\
     docker exec ${params.containerName} curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1; then
    echo MIGRATED_OK
    exit 0
  fi
  sleep 2
done
echo HEALTH_TIMEOUT >&2
exit 1
`;
}

interface MigrationResult {
  instanceId: string;
  name: string;
  status: "skipped-already-migrated" | "skipped-no-key" | "skipped-no-ip" | "migrated" | "failed";
  detail?: string;
}

function buildCaddySiteLabel(instance: InstanceRow): string {
  // Match what flip-webui-public-url did. Prefer subdomain → ipv4 → fallback.
  if (instance.subdomain && instance.subdomain.trim()) return instance.subdomain.trim();
  if (instance.ipv4_address && instance.ipv4_address.trim()) {
    return `${instance.ipv4_address.replace(/\./g, "-")}.sslip.io`;
  }
  return "localhost";
}

async function migrateOne(instance: InstanceRow, args: Args): Promise<MigrationResult> {
  const { id: instanceId, name } = instance;
  const skip = (status: MigrationResult["status"], detail?: string): MigrationResult => ({ instanceId, name, status, detail });

  if (!instance.api_server_key_encrypted) {
    return skip("skipped-no-key", "no api_server_key_encrypted on row");
  }

  const supabaseClient = getSupabaseClient();
  const ip = await resolveInstanceIpv4(instance, supabaseClient).catch(() => "");
  if (!ip) {
    return skip("skipped-no-ip", "could not resolve host IPv4");
  }

  const containerName = `agent-${instanceId}`;

  // Idempotency check: skip only when both layers are migrated. Caddy bearer
  // auth alone is not enough: a stale HERMES_WEBUI_PASSWORD in the persisted
  // webui-state volume makes WebUI show its own password prompt again.
  const probe = await sshExec(
    ip,
    buildWebUICaddyAuthMigrationProbeCommand({ instanceId, containerName }),
    { timeoutMs: 15_000 },
  );
  if (probe.ok && isWebUICaddyAuthFullyMigrated(probe.stdout)) {
    return skip("skipped-already-migrated");
  }

  // Decrypt the per-instance API key (used both as Caddy bearer + dashboard auth).
  let bearerToken: string;
  try {
    bearerToken = decryptApiKey(instance.api_server_key_encrypted);
  } catch (err) {
    return { instanceId, name, status: "failed", detail: `decryptApiKey: ${(err as Error).message}` };
  }
  if (!bearerToken) {
    return skip("skipped-no-key", "decrypted api key is empty");
  }

  const caddySite = buildCaddySiteLabel(instance);
  const caddyfile = buildWebUICaddyfile(caddySite, containerName, bearerToken);
  const caddyfileB64 = Buffer.from(caddyfile, "utf-8").toString("base64");

  if (args.dryRun) {
    console.log(`[DRY RUN] would migrate ${instanceId} (${name}) at ${ip}`);
    return { instanceId, name, status: "migrated", detail: "(dry run)" };
  }

  // Atomic-ish migration:
  //  1. Backup current Caddyfile + .env
  //  2. Write new Caddyfile (bearer-enforced)
  //  3. Strip HERMES_WEBUI_PASSWORD from compose .env + persisted state .env
  //  4. caddy reload (hot, no downtime)
  //  5. force-recreate WebUI container so it picks up the dropped env var
  //  6. wait for /health
  const remoteScript = buildWebUICaddyAuthMigrationRemoteScript({
    instanceId,
    containerName,
    caddyfileBase64: caddyfileB64,
  });

  const result = await sshExec(ip, remoteScript, { timeoutMs: 240_000 });
  if (!result.ok || !result.stdout.includes("MIGRATED_OK")) {
    return {
      instanceId,
      name,
      status: "failed",
      detail: `ssh: ok=${result.ok} stderr=${result.stderr.slice(0, 200)} stdout=${result.stdout.slice(-200)}`,
    };
  }

  return { instanceId, name, status: "migrated" };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const instances = await listInstances({ instanceId: args.instanceId });
  console.log(`Discovered ${instances.length} WebUI instance(s).`);
  if (args.dryRun) console.log("(dry run — no changes will be made)");

  const results: MigrationResult[] = [];
  for (const instance of instances) {
    process.stdout.write(`-> ${instance.id} (${instance.name}) … `);
    try {
      const r = await migrateOne(instance, args);
      results.push(r);
      console.log(r.status + (r.detail ? ` (${r.detail})` : ""));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ instanceId: instance.id, name: instance.name, status: "failed", detail });
      console.log(`failed: ${detail}`);
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log("\n=== summary ===");
  for (const [status, count] of Object.entries(counts)) {
    console.log(`  ${status}: ${count}`);
  }

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    console.log("\nfailures:");
    for (const f of failed) {
      console.log(`  ${f.instanceId} (${f.name}): ${f.detail}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  });
}
