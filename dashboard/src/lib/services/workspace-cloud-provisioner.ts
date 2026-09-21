import crypto from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { encryptApiKey, formatKeyPreview } from "@/lib/crypto";
import {
  runProxmoxHostScript,
  resolveProxmoxTargetConfiguration,
} from "@/lib/services/proxmox-instance-service";
import { createDnsRecord, type CloudflareDnsConfig } from "@/lib/services/cloudflare-dns";
import { log } from "@/lib/logger";

/**
 * Hermes Workspace Cloud — lean provisioner.
 *
 * Deliberately NOT the Hivra provisionProxmoxInstance path. A Workspace Cloud
 * box is just a fresh UPSTREAM Hermes agent (NousResearch/hermes-agent) with its
 * OpenAI-compatible API server exposed on :8642 behind an API key — no webui, no
 * dashboard sidecar, no forks. This module only reuses generic infra helpers:
 * the host-script runner (SSH to wrk1), Cloudflare DNS, and wrk1's host Caddy
 * (which already holds the shared *.hermesos.cloud DNS-01 wildcard cert).
 *
 * Flow: clone the upstream-agent template → assign a private IP → boot → inject a
 * unique API_SERVER_KEY over host→guest SSH → add a Caddy site + Cloudflare A
 * record → poll health → persist a hermes_instances row (product_surface=
 * 'workspace_cloud', backend='gateway') so the existing handoff/billing/client
 * keep working unchanged.
 */

const LANE_HOST_SLUG = "wrk1";
const LANE_SUBNET_PREFIX = "10.250.30";
const LANE_GATEWAY = "10.250.30.1";
const LANE_DOMAIN = "hermesos.cloud"; // agents live at wsc-<id>.hermesos.cloud
const VMID_MIN = 2000;
const VMID_MAX = 2099;
const GUEST_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";
// The clone/boot host-script timeout MUST sit below the route's Vercel
// maxDuration (300s on instances/route.ts) or Vercel SIGTERMs the function at
// 300s BEFORE runProxmoxHostScript returns non-ok — so rollback (teardown +
// row delete) never fires and a half-built VM + allocated VMID/LV is orphaned
// (the documented orphan-LV doom-loop). Cap at 240s, leaving ~60s of headroom
// for DNS setup + the synchronous rollback path to complete inside the budget.
const PROVISION_TIMEOUT_MS = 240_000;

function laneEnv(): NodeJS.ProcessEnv {
  return resolveProxmoxTargetConfiguration(process.env, LANE_HOST_SLUG).env as NodeJS.ProcessEnv;
}

function templateVmid(): number {
  const v = Number(process.env.WORKSPACE_CLOUD_TEMPLATE_ID);
  return Number.isFinite(v) && v > 0 ? v : 9100;
}

function cloudflareConfig(): CloudflareDnsConfig | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
  if (!apiToken || !zoneId) return null;
  return { apiToken, zoneId, domain: LANE_DOMAIN, proxied: false };
}

/** Next free VMID in the lane range + its derived private IP. */
async function allocateVmid(): Promise<{ vmid: number; ip: string }> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data } = await supabaseAdmin
    .from("hermes_instances")
    .select("proxmox_vmid")
    .eq("product_surface", "workspace_cloud")
    .eq("proxmox_node", LANE_HOST_SLUG)
    .neq("status", "deleted");
  const used = new Set(
    (data ?? [])
      .map((r) => (r as { proxmox_vmid?: number | null }).proxmox_vmid)
      .filter((v): v is number => typeof v === "number")
  );
  for (let vmid = VMID_MIN; vmid <= VMID_MAX; vmid += 1) {
    if (!used.has(vmid)) {
      return { vmid, ip: `${LANE_SUBNET_PREFIX}.${50 + (vmid - VMID_MIN)}` };
    }
  }
  throw new Error("No free Workspace Cloud VMID in range");
}

function buildProvisionScript(p: {
  templateVmid: number;
  vmid: number;
  ip: string;
  subdomain: string;
  fqdn: string;
  apiKey: string;
}): string {
  // All interpolated values are machine-generated (ints / hex / our own
  // subdomain), so no untrusted shell content.
  return `set -euo pipefail
TEMPLATE=${p.templateVmid}
VMID=${p.vmid}
IP=${p.ip}
FQDN=${p.fqdn}
SUB=${p.subdomain}
KEY=${p.apiKey}
GUEST_SSH="ssh -n -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6 -o BatchMode=yes -i ${GUEST_KEY_PATH} hermes@\${IP}"

echo "[wc] cloning \${TEMPLATE} -> \${VMID}"
qm clone "\${TEMPLATE}" "\${VMID}" --name "wc-\${SUB}" --full >/dev/null
qm set "\${VMID}" --ipconfig0 "ip=\${IP}/24,gw=${LANE_GATEWAY}" >/dev/null
qm start "\${VMID}" >/dev/null

echo "[wc] waiting for guest ssh on \${IP}"
ssh-keygen -R "\${IP}" >/dev/null 2>&1 || true
ready=0
for i in $(seq 1 50); do
  if \${GUEST_SSH} true >/dev/null 2>&1; then ready=1; echo "[wc] guest ssh ready (iter \${i})"; break; fi
  echo "[wc] guest ssh not ready yet (iter \${i})"
  sleep 5
done
[ "\${ready}" = "1" ] || { echo "[wc] FAIL guest ssh never came up"; exit 21; }

echo "[wc] injecting API key + clearing baked provider key + restarting gateway"
# Set the per-agent API_SERVER_KEY and BLANK the baked model-provider KEY so a
# fresh agent boots credential-less — the user's own key is pushed later, at
# connect time (per-user BYO). This is what stops every agent sharing one baked
# provider key. We deliberately leave API_SERVER_MODEL_NAME (the model id, not a
# secret) so the gateway still starts and /health stays green; the provider key
# being blank just means requests fail until the user connects.
if ! \${GUEST_SSH} "sed -i 's|^API_SERVER_KEY=.*|API_SERVER_KEY=\${KEY}|; s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=|' /home/hermes/.hermes/.env && sudo systemctl restart hermes-gateway && echo INJECT_OK" 2>&1; then
  echo "[wc] FAIL key injection/restart returned non-zero"; exit 23
fi

echo "[wc] writing caddy site + reload"
mkdir -p /etc/caddy/hermes.d
cat > "/etc/caddy/hermes.d/\${SUB}.caddy" <<CADDY
\${FQDN} {
  tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key
  reverse_proxy \${IP}:8642
}
CADDY
systemctl restart caddy

echo "[wc] waiting for local agent health"
healthy=0
for i in $(seq 1 40); do
  if curl -fsS -m 5 -o /dev/null "http://\${IP}:8642/health"; then healthy=1; echo "[wc] agent healthy (iter \${i})"; break; fi
  echo "[wc] agent not healthy yet (iter \${i})"
  sleep 4
done
[ "\${healthy}" = "1" ] || { echo "[wc] FAIL agent health never green"; exit 22; }
echo "[wc] PROVISION_OK vmid=\${VMID} ip=\${IP} fqdn=\${FQDN}"
`;
}

function buildTeardownScript(vmid: number, subdomain: string): string {
  return `set -uo pipefail
VMID=${vmid}
rm -f "/etc/caddy/hermes.d/${subdomain}.caddy" || true
systemctl restart caddy || true
qm stop "\${VMID}" >/dev/null 2>&1 || true
sleep 3
qm destroy "\${VMID}" --purge >/dev/null 2>&1 || true
echo "[wc] TEARDOWN_OK vmid=\${VMID}"
`;
}

// These values get interpolated into a remote shell command and are
// user-supplied (the model key + name come from the Workspace), so they are
// validated against a strict allowlist to prevent command injection on the
// guest. OpenRouter keys are "sk-or-v1-…" (alnum + dashes); model ids look like
// "vendor/name:tag".
const MODEL_API_KEY_RE = /^[A-Za-z0-9._-]{8,256}$/;
const MODEL_NAME_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{1,40}$/i;
// Key-based providers store their key in this .env var. OAuth providers
// (openai-codex, nous, …) are intentionally absent — they authenticate with a
// refreshable token the agent stored itself via `hermes auth add`, so no key
// is written for them; we only flip the provider + model.
const PROVIDER_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  zai: "GLM_API_KEY",
};

function buildApplyModelScript(p: {
  ip: string;
  provider: string;
  model: string;
  apiKey: string;
  keyEnvVar: string;
}): string {
  // The agent reads model.provider / model.default from config.yaml (NOT from
  // the .env — API_SERVER_MODEL_NAME there is no longer honoured), so we set
  // them with `hermes config set`. Without an explicit provider the gateway
  // stays on "auto", which fails to pick up an OAuth credential and chats hang
  // with "No inference provider configured". Key-based providers additionally
  // need their key written to .env. Values are strict-allowlist validated, so
  // single-quoting them in the guest script is injection-safe. The guest body
  // is base64'd to avoid nested-quote breakage through the SSH layer.
  const ENV = "/home/hermes/.hermes/.env";
  const setModel = p.model
    ? `PYTHONUNBUFFERED=1 "$H" config set model.default '${p.model}'\n`
    : "";
  const writeKey =
    p.apiKey && p.keyEnvVar
      ? `sed -i '/^${p.keyEnvVar}=/d' "${ENV}" && printf '%s\\n' '${p.keyEnvVar}=${p.apiKey}' >> "${ENV}"\n`
      : "";
  const guest = `set -e
H=${HERMES_BIN}
PYTHONUNBUFFERED=1 "$H" config set model.provider '${p.provider}'
${setModel}${writeKey}sudo systemctl restart hermes-gateway
echo APPLY_OK`;
  return `set -euo pipefail
IP=${p.ip}
GUEST_SSH="ssh -n -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o BatchMode=yes -i ${GUEST_KEY_PATH} hermes@\${IP}"
\${GUEST_SSH} "echo '${b64(guest)}' | base64 -d | bash"
`;
}

/**
 * Point a running lane agent at the user's chosen provider + model.
 *   - Key-based (openrouter/openai/anthropic/…): writes the key to the matching
 *     .env var and selects the provider + model.
 *   - OAuth (openai-codex/nous/…): the agent already holds a refreshable token
 *     (added via `hermes auth add` during the OAuth connect), so we only select
 *     the provider + model — no key.
 * Either way the selection goes through `hermes config set` (config.yaml) and
 * the gateway is restarted. Nothing is persisted server-side.
 */
export async function applyWorkspaceCloudModelConfig(params: {
  ip: string;
  provider?: string;
  apiKey?: string;
  model: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const provider = (params.provider || "openrouter").trim().toLowerCase();
  const apiKey = (params.apiKey || "").trim();
  const model = (params.model || "").trim();
  if (!PROVIDER_RE.test(provider)) return { ok: false, error: "Invalid provider" };
  if (apiKey && !MODEL_API_KEY_RE.test(apiKey)) return { ok: false, error: "Invalid model API key format" };
  // Model is optional — when absent we keep the agent's current default model.
  if (model && !MODEL_NAME_RE.test(model)) return { ok: false, error: "Invalid model name format" };
  const keyEnvVar = apiKey ? (PROVIDER_KEY_ENV[provider] ?? "OPENROUTER_API_KEY") : "";
  const res = await runProxmoxHostScript(
    buildApplyModelScript({ ip: params.ip, provider, model, apiKey, keyEnvVar }),
    laneEnv(),
    { timeoutMs: 60_000 },
  );
  if (!res.ok || !res.stdout.includes("APPLY_OK")) {
    return { ok: false, error: res.error || res.stderr || "Model config apply failed" };
  }
  return { ok: true };
}

export interface WorkspaceCloudInstanceResult {
  id: string;
  name: string;
  gatewayUrl: string;
  status: string;
}

export async function provisionWorkspaceCloudAgent(params: {
  userId: string;
  name: string;
}): Promise<
  | { ok: true; instance: WorkspaceCloudInstanceResult }
  | { ok: false; status: number; error: string }
> {
  if (!supabaseAdmin) return { ok: false, status: 500, error: "Database not configured" };
  const env = laneEnv();
  const publicIp = env.PROXMOX_PUBLIC_IP?.trim();
  if (!publicIp) return { ok: false, status: 503, error: "Workspace Cloud host (wrk1) is not configured" };
  const cf = cloudflareConfig();
  if (!cf) return { ok: false, status: 503, error: "Cloudflare DNS is not configured" };

  const { vmid, ip } = await allocateVmid();
  const subdomain = `wsc-${crypto.randomBytes(8).toString("hex")}`;
  const fqdn = `${subdomain}.${LANE_DOMAIN}`;
  const gatewayUrl = `https://${fqdn}`;
  const apiKey = crypto.randomBytes(32).toString("hex");

  // 1. Persist a provisioning row up-front (so a crash leaves a traceable row).
  const { data: row, error: insertError } = await supabaseAdmin
    .from("hermes_instances")
    .insert({
      user_id: params.userId,
      name: params.name,
      subdomain,
      status: "provisioning",
      lifecycle_state: "provisioning",
      provider: "openrouter",
      product_surface: "workspace_cloud",
      backend: "gateway",
      infrastructure_provider: "proxmox",
      proxmox_node: LANE_HOST_SLUG,
      proxmox_vmid: vmid,
      ipv4_address: ip,
      gateway_url: gatewayUrl,
      api_server_key_encrypted: encryptApiKey(apiKey),
      api_key_preview: formatKeyPreview(apiKey),
    })
    .select("id")
    .single<{ id: string }>();
  if (insertError || !row) {
    return { ok: false, status: 500, error: "Failed to create instance record" };
  }

  const rollback = async (reason: string) => {
    log.warn("workspace_cloud provision failed; rolling back", {
      source: "workspace-cloud-provisioner",
      failureType: "workspace_cloud_provision_rollback",
      instanceId: row.id,
      vmid,
      reason,
    });
    await runProxmoxHostScript(buildTeardownScript(vmid, subdomain), env).catch(() => undefined);
    await supabaseAdmin!.from("hermes_instances").delete().eq("id", row.id);
  };

  // 2. DNS A record → wrk1 public IP.
  try {
    await createDnsRecord(cf, { fqdn, ip: publicIp, comment: "workspace-cloud agent" });
  } catch (err) {
    await rollback(`dns: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 502, error: "Failed to create DNS record" };
  }

  // 3. Clone + boot + key + caddy + health, on wrk1.
  const res = await runProxmoxHostScript(
    buildProvisionScript({ templateVmid: templateVmid(), vmid, ip, subdomain, fqdn, apiKey }),
    env,
    { timeoutMs: PROVISION_TIMEOUT_MS }
  );
  if (!res.ok || !res.stdout.includes("PROVISION_OK")) {
    log.error("workspace_cloud host script failed", new Error("provision_script_failed"), {
      source: "workspace-cloud-provisioner",
      failureType: "workspace_cloud_provision_script_failed",
      instanceId: row.id,
      vmid,
      ok: res.ok,
      stdoutTail: res.stdout.slice(-1500),
      stderrTail: res.stderr.slice(-1500),
      scriptError: res.error,
    });
    await rollback(res.error || res.stderr || "provision script failed");
    return { ok: false, status: 500, error: "Provisioning failed on host" };
  }

  // 4. Mark running. (lifecycle_state uses 'active' — the schema's running state.)
  const { error: updateError } = await supabaseAdmin
    .from("hermes_instances")
    .update({ status: "running", lifecycle_state: "active", updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (updateError) {
    log.error("workspace_cloud failed to mark instance running", new Error(updateError.message), {
      source: "workspace-cloud-provisioner",
      failureType: "workspace_cloud_mark_running_failed",
      instanceId: row.id,
    });
  }

  return {
    ok: true,
    instance: { id: row.id, name: params.name, gatewayUrl, status: "running" },
  };
}

type PowerAction = "start" | "stop" | "reboot";

/** Basic VM power ops for the simple dashboard (pause/restart). Owner-scoped. */
export async function powerWorkspaceCloudAgent(params: {
  instanceId: string;
  userId: string;
  action: PowerAction;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!supabaseAdmin) return { ok: false, status: 500, error: "Database not configured" };
  const { data: inst } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, proxmox_vmid, status")
    .eq("id", params.instanceId)
    .eq("user_id", params.userId)
    .eq("product_surface", "workspace_cloud")
    .neq("status", "deleted")
    .maybeSingle<{ id: string; proxmox_vmid: number | null; status: string }>();
  if (!inst?.proxmox_vmid) return { ok: false, status: 404, error: "Instance not found" };

  // For the "Pause" (stop) action, attempt a GRACEFUL guest shutdown first so
  // the agent flushes state cleanly; only hard-stop if the guest doesn't power
  // down within the timeout (e.g. no qemu-guest-agent / hung guest). `qm
  // shutdown --timeout` blocks until the guest is off or the timeout elapses
  // and exits non-zero on timeout, at which point we fall back to `qm stop`.
  const vmid = inst.proxmox_vmid;
  let cmd: string;
  if (params.action === "stop") {
    cmd =
      `qm shutdown ${vmid} --timeout 60 2>&1 | tail -1 ` +
      `|| qm stop ${vmid} 2>&1 | tail -1`;
  } else if (params.action === "start") {
    cmd = `qm start ${vmid} 2>&1 | tail -1`;
  } else {
    cmd = `qm reboot ${vmid} 2>&1 | tail -1`;
  }
  const res = await runProxmoxHostScript(cmd, laneEnv());
  if (!res.ok) return { ok: false, status: 500, error: `Failed to ${params.action} instance` };

  const nextStatus = params.action === "stop" ? "stopped" : "running";
  await supabaseAdmin
    .from("hermes_instances")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", inst.id);
  return { ok: true };
}

/** Destroy a lane agent (VM + caddy site + row). DNS record is left for the reconcile sweep. */
export async function destroyWorkspaceCloudAgent(params: {
  instanceId: string;
  userId: string;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!supabaseAdmin) return { ok: false, status: 500, error: "Database not configured" };
  const { data: inst } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, proxmox_vmid, subdomain")
    .eq("id", params.instanceId)
    .eq("user_id", params.userId)
    .eq("product_surface", "workspace_cloud")
    .neq("status", "deleted")
    .maybeSingle<{ id: string; proxmox_vmid: number | null; subdomain: string | null }>();
  if (!inst?.proxmox_vmid || !inst.subdomain) return { ok: false, status: 404, error: "Instance not found" };

  await runProxmoxHostScript(buildTeardownScript(inst.proxmox_vmid, inst.subdomain), laneEnv()).catch(
    () => undefined
  );
  await supabaseAdmin
    .from("hermes_instances")
    .update({ status: "deleted", lifecycle_state: "deleted", updated_at: new Date().toISOString() })
    .eq("id", inst.id);
  return { ok: true };
}

// ── OAuth (managed device-code login via the agent's own CLI) ──────────────
// The hermes-agent CLI runs each provider's device-code flow itself: it prints
// a verification URL + user code, polls until the user authorizes, and stores
// the refreshable token ON THE AGENT. So managed OAuth is just: launch that CLI
// over SSH (detached, so it keeps polling after we return), relay the URL+code,
// then poll `hermes auth status` for completion. No token ever touches us.
const OAUTH_PROVIDER_RE = /^[a-z0-9][a-z0-9-]{1,40}$/i;
const HERMES_BIN = "/home/hermes/.hermes/hermes-agent/venv/bin/hermes";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function buildOAuthStartScript(p: { ip: string; provider: string }): string {
  const out = `/tmp/wc-oauth-${p.provider}.out`;
  const guest = `set -e
H=${HERMES_BIN}
OUT=${out}
pkill -f "auth add ${p.provider} " 2>/dev/null || true
rm -f "$OUT"
setsid env PYTHONUNBUFFERED=1 "$H" auth add ${p.provider} --type oauth --no-browser --timeout 900 > "$OUT" 2>&1 < /dev/null &
for i in $(seq 1 25); do grep -q "Enter this code" "$OUT" 2>/dev/null && break; sleep 1; done
cat "$OUT"
`;
  return `set -euo pipefail
IP=${p.ip}
GUEST_SSH="ssh -n -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o BatchMode=yes -i ${GUEST_KEY_PATH} hermes@\${IP}"
\${GUEST_SSH} "echo '${b64(guest)}' | base64 -d | bash"
`;
}

function buildOAuthStatusScript(p: { ip: string; provider: string }): string {
  // While the device-login is still running it is PENDING — the surest signal
  // is the live `auth add` process, NOT log text (the CLI prints "press Ctrl+C
  // to cancel", which must not be read as a failure). Once the process exits we
  // ask `auth status`: still logged out => the flow ended without authing.
  const guest = `H=${HERMES_BIN}
if pgrep -f "auth add ${p.provider} " >/dev/null 2>&1; then
  echo "WC_OAUTH_STATUS:PENDING"
else
  S="$(PYTHONUNBUFFERED=1 "$H" auth status ${p.provider} 2>&1 || true)"
  if echo "$S" | grep -qiE "logged out|no .*credential|not authenticated|run .?hermes auth|error|denied|expired|timed out"; then echo "WC_OAUTH_STATUS:FAILED";
  else echo "WC_OAUTH_STATUS:AUTHED"; fi
fi
`;
  return `set -euo pipefail
IP=${p.ip}
GUEST_SSH="ssh -n -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o BatchMode=yes -i ${GUEST_KEY_PATH} hermes@\${IP}"
\${GUEST_SSH} "echo '${b64(guest)}' | base64 -d | bash"
`;
}

/** Start a provider OAuth device login on the agent; returns the URL + code. */
export async function startWorkspaceCloudOAuth(params: {
  ip: string;
  provider: string;
}): Promise<
  { ok: true; url: string; code: string } | { ok: false; error: string }
> {
  const provider = (params.provider || "").trim().toLowerCase();
  if (!OAUTH_PROVIDER_RE.test(provider)) return { ok: false, error: "Invalid provider" };
  const res = await runProxmoxHostScript(
    buildOAuthStartScript({ ip: params.ip, provider }),
    laneEnv(),
    { timeoutMs: 60_000 },
  );
  // Strip ANSI colour codes the CLI emits, then pull the URL + device code.
  const clean = `${res.stdout}\n${res.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const url = clean.match(/https?:\/\/\S+/)?.[0] ?? "";
  const code = clean.match(/Enter this code:\s*([A-Z0-9][A-Z0-9-]{3,15})/i)?.[1] ?? "";
  if (!url || !code) {
    return { ok: false, error: res.error || res.stderr || "Could not start the device login" };
  }
  return { ok: true, url, code };
}

/** Poll whether the agent has completed the provider OAuth login. */
export async function pollWorkspaceCloudOAuth(params: {
  ip: string;
  provider: string;
}): Promise<
  | { ok: true; status: "pending" | "authed" | "failed" }
  | { ok: false; error: string }
> {
  const provider = (params.provider || "").trim().toLowerCase();
  if (!OAUTH_PROVIDER_RE.test(provider)) return { ok: false, error: "Invalid provider" };
  const res = await runProxmoxHostScript(
    buildOAuthStatusScript({ ip: params.ip, provider }),
    laneEnv(),
    { timeoutMs: 30_000 },
  );
  const text = `${res.stdout}\n${res.stderr}`;
  if (text.includes("WC_OAUTH_STATUS:AUTHED")) return { ok: true, status: "authed" };
  if (text.includes("WC_OAUTH_STATUS:FAILED")) return { ok: true, status: "failed" };
  if (text.includes("WC_OAUTH_STATUS:PENDING")) return { ok: true, status: "pending" };
  return { ok: false, error: res.error || "Could not read OAuth status" };
}

export { buildOAuthStartScript, buildOAuthStatusScript };
