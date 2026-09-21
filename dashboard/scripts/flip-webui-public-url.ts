import path from "path";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { decryptApiKey } from "../src/lib/crypto";
import { sshExec } from "../src/lib/hetzner/ssh";
import { resolveInstanceIpv4, type InstanceRowForOrchestration } from "../src/lib/services/instance-orchestrator";
import { buildHostCaddyReloadScript } from "../src/lib/services/hetzner-instance-service";
import { buildWebUICaddyfile } from "../src/lib/services/webui-instance-builder";
import { WebUIClient } from "../src/lib/webui/client";
import { redactSensitiveCommandOutput } from "../src/lib/command-output-redaction";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

type Backend = "gateway" | "webui";

type InstanceRow = InstanceRowForOrchestration & {
  name: string;
  status: string;
  backend?: Backend | null;
};

type Args = {
  target: string;
  apply: boolean;
  force: boolean;
  publicUrl: string;
  skipHealthProbe: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("--")) || process.env.INSTANCE_ID || process.env.INSTANCE_IP || "";

  if (!target) {
    throw new Error(
      "Usage: npm run ops:webui:public-url -- <instance-id-or-ip> --public-url https://<host> --apply\n" +
      "Flags: --apply, --force, --skip-health"
    );
  }

  const publicUrl = readFlagValue(args, "--public-url");
  if (!publicUrl) {
    throw new Error("Missing required flag: --public-url");
  }

  return {
    target,
    apply: args.includes("--apply"),
    force: args.includes("--force"),
    publicUrl,
    skipHealthProbe: args.includes("--skip-health"),
  };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    const value = inline.slice(flag.length + 1).trim();
    return value || undefined;
  }

  const index = args.indexOf(flag);
  if (index >= 0) {
    const value = args[index + 1]?.trim();
    return value && !value.startsWith("--") ? value : undefined;
  }

  return undefined;
}

function isIpAddress(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.trim());
}

function dashedIp(value: string): string {
  return value.replace(/\./g, "-");
}

function normalizePublicUrl(value: string): URL {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("--public-url must start with http:// or https://");
  }
  return new URL(trimmed);
}

function publicBaseUrl(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function buildCaddySiteLabel(url: URL): string {
  if (url.protocol === "http:") {
    return `http://${url.host}`;
  }
  // For HTTPS, omit the scheme so Caddy can still handle redirects and ACME challenges on :80.
  return url.host;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function formatRemoteError(result: { stderr?: string; error?: string }): string {
  return redactSensitiveCommandOutput(
    result.stderr?.trim() || result.error?.trim() || "Remote command failed",
    1_000
  );
}

async function runRemote(hostIp: string, script: string, label: string, timeoutMs = 10 * 60_000): Promise<string> {
  const result = await sshExec(hostIp, script, { timeoutMs });
  if (!result.ok) {
    throw new Error(`${label}: ${formatRemoteError(result)}`);
  }
  return result.stdout;
}

async function resolveInstance(target: string): Promise<InstanceRow> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .select("id, name, user_id, status, backend, provider, subdomain, gateway_url, api_key_encrypted, api_server_key_encrypted, host_id, hetzner_server_id, ipv4_address")
    .neq("status", "deleted");

  if (error) {
    throw new Error(`Failed to load instances: ${error.message}`);
  }

  const instances = (data || []) as InstanceRow[];

  if (!isIpAddress(target)) {
    const instance = instances.find((row) => row.id === target);
    if (!instance) {
      throw new Error(`No instance found for id ${target}`);
    }
    return instance;
  }

  const matches = instances.filter((row) =>
    row.ipv4_address === target ||
    row.gateway_url?.includes(target) ||
    row.gateway_url?.includes(dashedIp(target))
  );

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    throw new Error(`No instance found for IP ${target}`);
  }

  throw new Error(`Multiple instances matched IP ${target}. Pass an instance id instead.`);
}

async function getHostIp(instance: InstanceRow): Promise<string> {
  const ip = await resolveInstanceIpv4(instance, supabase);
  if (!ip) {
    throw new Error(`Could not resolve IPv4 for ${instance.id}`);
  }
  return ip;
}

function buildCaddyUpdateScript(instanceId: string, caddyfile: string): string {
  const escaped = caddyfile.replace(/'/g, "'\\''");
  const backupName = `Caddyfile.bak.${nowStamp()}`;
  return [
    `set -euo pipefail`,
    `INSTANCE_DIR=${JSON.stringify(`/opt/hermes/instances/${instanceId}`)}`,
    `cd "$INSTANCE_DIR"`,
    `if [ -f Caddyfile ]; then cp -a Caddyfile ${JSON.stringify(backupName)}; fi`,
    `cat > Caddyfile << 'CADDYEOF'`,
    `${escaped}`,
    `CADDYEOF`,
    buildHostCaddyReloadScript(),
    `echo "caddyfile_backup=${backupName}"`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const normalized = normalizePublicUrl(args.publicUrl);
  const desiredGatewayUrl = publicBaseUrl(normalized);
  const caddySiteLabel = buildCaddySiteLabel(normalized);

  const instance = await resolveInstance(args.target);
  const hostIp = await getHostIp(instance);
  const containerName = `agent-${instance.id}`;
  const bearerToken = instance.api_server_key_encrypted
    ? decryptApiKey(instance.api_server_key_encrypted)
    : "";
  if (!bearerToken) {
    throw new Error(`Instance ${instance.id} has no api_server_key — cannot bake bearer token into Caddyfile.`);
  }
  const caddyfile = buildWebUICaddyfile(caddySiteLabel, containerName, bearerToken);

  console.log(`Target: ${instance.name} (${instance.id})`);
  console.log(`Host: ${hostIp}`);
  console.log(`Backend: ${instance.backend ?? "unknown"}`);
  console.log(`Current gateway_url: ${instance.gateway_url ?? "null"}`);
  console.log(`Desired gateway_url: ${desiredGatewayUrl}`);
  console.log(`Caddy site label: ${caddySiteLabel}`);

  if (instance.backend !== "webui" && !args.force) {
    throw new Error(
      `Instance backend is ${instance.backend ?? "null"} (expected webui). ` +
      `Re-run with --force if you really want to overwrite the WebUI Caddyfile + gateway_url.`
    );
  }

  if (!args.apply) {
    console.log("Dry run only. Re-run with --apply to update Caddy + gateway_url.");
    return;
  }

  console.log("Updating remote Caddyfile + reloading Caddy...");
  await runRemote(hostIp, buildCaddyUpdateScript(instance.id, caddyfile), "Update Caddyfile");

  console.log("Updating gateway_url in Supabase...");
  const { error } = await supabase
    .from("hermes_instances")
    .update({
      gateway_url: desiredGatewayUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", instance.id);
  if (error) {
    throw new Error(`Failed to update gateway_url: ${error.message}`);
  }

  if (args.skipHealthProbe) {
    console.log("Skipped WebUI health probe because --skip-health was set.");
    return;
  }

  console.log("Probing WebUI /api/status...");
  const client = new WebUIClient({
    baseUrl: desiredGatewayUrl,
    bearer: bearerToken,
    password: bearerToken,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  // /api/status is the real agent route; /health returns the SPA HTML shell on
  // the fleet image (see WebUIClient.status()).
  const status = await client.status();
  console.log(`WebUI status: ${JSON.stringify(status)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
