/**
 * Cold-storage restore: host-side routing setup.
 *
 * After `restoreInstance()` brings the VM back on a NEW PVE host, three
 * pieces of public routing still point at the OLD host and would 502 the
 * user's URL:
 *
 *   1. The outer host Caddy on the new PVE host has no site file for the
 *      tenant's gateway hostname → TLS handshake fails or 404s.
 *   2. Cloudflare's wildcard A record routes the tenant subdomain to the
 *      original host's public IP, NOT the new one — so even if (1) were
 *      fixed, traffic never reaches the new host.
 *   3. The old PVE host still has a Caddy site file proxying to the dead
 *      private IP — harmless once (2) is fixed, but wastes a slot, holds a
 *      stale cert, and is a footgun if the wildcard ever falls back.
 *
 * This module applies all three: writes a fresh Caddy site on the new host
 * (mirroring what `buildProxmoxProvisionScript` emits during initial
 * provisioning), upserts a specific Cloudflare A record overriding the
 * wildcard, and removes the stale site file on the old host.
 *
 * Everything is best-effort with structured logging — restore data is
 * already on disk, the user is unblocked the moment DNS propagates, and a
 * partial failure here is recoverable by an admin rerun.
 */

import {
  runProxmoxHostScript,
  resolveProxmoxHostEnv,
  type ProxmoxHostRoutingConfig,
} from "./proxmox-instance-service";
import {
  assertSupportedProxmoxGatewayHost,
  buildProxmoxGatewayCaddySite,
} from "./proxmox-gateway-caddy-site";
import { getCloudflareDnsConfig } from "./cloudflare-dns";
import { log } from "@/lib/logger";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";

const LOG_SOURCE = "cold-storage-restore-routing";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

function shQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hostRouting(slug: string): ProxmoxHostRoutingConfig {
  return { hostSlug: slug, failClosed: true };
}

export interface ApplyRestoreRoutingInput {
  instanceId: string;
  /** Public FQDN the user hits (e.g. `<id>.agents.hermesos.cloud`). */
  gatewayHost: string;
  /** Private IP of the restored VM on its host's vmbr1. */
  newPrivateIp: string;
  /** Slug of the PVE host the VM now lives on. */
  newHostSlug: string;
  /** Slug of the PVE host the VM lived on before archive (for cleanup). */
  oldHostSlug?: string | null;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export type ApplyRestoreRoutingResult = {
  hostCaddy: { ok: boolean; reason?: string };
  oldHostCaddyCleanup: { ok: boolean; skipped?: boolean; reason?: string };
  cloudflareDns: {
    ok: boolean;
    /** "created" | "updated" | "unchanged" | error reason */
    outcome: string;
    publicIp?: string;
    recordId?: string;
  };
};

function resolveDashboardOrigin(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const explicit = env.NEXT_PUBLIC_DASHBOARD_ORIGIN?.trim();
  if (explicit) return explicit;
  const vercelProd = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) return `https://${vercelProd}`;
  return "";
}

function resolveCaddySitesDir(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  return env.PROXMOX_CADDY_SITES_DIR?.trim() || "/etc/caddy/hermes.d";
}

/**
 * Write the Caddy site file to the destination PVE host and reload Caddy.
 * Wrapped with the same direct-reload + auto-recovery dance that
 * provisioning uses, so a single panicked reload doesn't leave the daemon
 * dead.
 */
async function writeHostCaddySite(input: {
  hostSlug: string;
  gatewayHost: string;
  privateIp: string;
  instanceId: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<{ ok: boolean; reason?: string }> {
  const hostEnv = (() => {
    try {
      return resolveProxmoxHostEnv(hostRouting(input.hostSlug), input.env);
    } catch {
      return null as null | NodeJS.ProcessEnv;
    }
  })();
  if (!hostEnv) {
    return { ok: false, reason: "env_resolution_failed" };
  }
  const sitesDir = resolveCaddySitesDir(hostEnv);
  const dashboardOrigin = resolveDashboardOrigin(hostEnv);
  let siteContent: string;
  try {
    siteContent = buildProxmoxGatewayCaddySite({
      gatewayHost: input.gatewayHost,
      privateIp: input.privateIp,
      instanceId: input.instanceId,
      dashboardOrigin,
    });
  } catch (error) {
    return {
      ok: false,
      reason: redactSensitiveCommandOutput(
        error instanceof Error ? error.message : "unsupported gateway host",
        300,
      ),
    };
  }
  const script = buildRestoreHostCaddySiteApplyScript({
    sitesDir,
    gatewayHost: input.gatewayHost,
    siteContent,
  });

  const result = await runProxmoxHostScript(script, hostEnv, 90_000);
  if (!result.ok) {
    return {
      ok: false,
      reason: redactSensitiveCommandOutput(
        result.stderr || result.error || "host script failed",
        300,
      ),
    };
  }
  return { ok: true };
}

export function buildRestoreHostCaddySiteApplyScript(input: {
  sitesDir: string;
  gatewayHost: string;
  siteContent: string;
}): string {
  const siteB64 = Buffer.from(input.siteContent, "utf8").toString("base64");
  const verifyUrl = `https://${input.gatewayHost}/`;

  return `#!/usr/bin/env bash
set -euo pipefail
SITES_DIR=${shQuote(input.sitesDir)}
SITE_FILE="$SITES_DIR/${input.gatewayHost.replace(/'/g, "")}.caddy"
SITE_CANDIDATE="\${SITE_FILE}.candidate.$$"
SITE_BACKUP="\${SITE_FILE}.backup.$$"
SITE_HAD_PRIOR=0
SITE_INSTALLED=0
SITE_COMMITTED=0
mkdir -p "$SITES_DIR"

cleanup_site_artifacts() {
  rm -f "$SITE_CANDIDATE" "$SITE_BACKUP"
}
rollback_site() {
  rm -f "$SITE_CANDIDATE"
  if [ "$SITE_HAD_PRIOR" = "1" ] && [ -f "$SITE_BACKUP" ]; then
    mv -f "$SITE_BACKUP" "$SITE_FILE"
  else
    rm -f "$SITE_FILE"
  fi
  SITE_INSTALLED=0
}
finish_site_transaction() {
  rc=$?
  if [ "$SITE_INSTALLED" = "1" ] && [ "$SITE_COMMITTED" = "0" ]; then
    rollback_site
  fi
  cleanup_site_artifacts
  exit "$rc"
}
trap finish_site_transaction EXIT
trap 'exit 130' HUP INT TERM

printf '%s' '${siteB64}' | base64 -d > "$SITE_CANDIDATE"
chmod 644 "$SITE_CANDIDATE"
if [ -f "$SITE_FILE" ]; then
  cp -p "$SITE_FILE" "$SITE_BACKUP"
  SITE_HAD_PRIOR=1
fi
mv -f "$SITE_CANDIDATE" "$SITE_FILE"
SITE_INSTALLED=1

# Carry Caddy's systemd-managed env (CLOUDFLARE_API_TOKEN etc) into the
# validate call — caddy validate is a one-shot CLI without systemd's env,
# so any {env.X} reference resolves to "" and validation fails even
# though the running daemon has the secret.
if command -v systemctl >/dev/null 2>&1; then
  for kv in $(systemctl show caddy -p Environment --value 2>/dev/null); do
    [ -n "$kv" ] && export "$kv"
  done
fi
if ! VALIDATE_ERR=$(timeout 10s caddy validate --config /etc/caddy/Caddyfile 2>&1); then
  echo "caddy validate failed, refusing to reload" >&2
  printf '%s\\n' "$VALIDATE_ERR" | tail -n 10 >&2
  rollback_site
  exit 1
fi

verify_caddy() {
  curl -ksS --max-time 5 --resolve ${shQuote(`${input.gatewayHost}:443:127.0.0.1`)} \
    -o /dev/null ${shQuote(verifyUrl)}
}

reload_or_recover_caddy() {
  if systemctl is-active caddy >/dev/null 2>&1; then
    for _ in 1 2; do
      if timeout 15s caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1; then
        if verify_caddy; then return 0; fi
        echo "caddy reload completed but local TLS verification failed" >&2
        break
      fi
      if ! systemctl is-active caddy >/dev/null 2>&1; then break; fi
      sleep 1
    done
  fi
  systemctl reset-failed caddy >/dev/null 2>&1 || true
  if ! timeout 15s systemctl restart caddy; then
    echo "caddy restart failed after bounded reload attempts" >&2
    return 1
  fi
  if ! verify_caddy; then
    echo "caddy recovery verification failed" >&2
    return 1
  }
}

if ! reload_or_recover_caddy; then
  rollback_site
  if timeout 10s caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    timeout 15s systemctl restart caddy >/dev/null 2>&1 || true
  fi
  exit 1
fi
SITE_COMMITTED=1
rm -f "$SITE_BACKUP"
`;
}

/**
 * Remove the stale Caddy site file from the previous PVE host and reload.
 * Best-effort: if the host is unreachable the restore still succeeds, the
 * specific Cloudflare A record points elsewhere, and a periodic cleanup
 * cron can pick up the orphan.
 */
async function removeHostCaddySite(input: {
  hostSlug: string;
  gatewayHost: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  const hostEnv = (() => {
    try {
      return resolveProxmoxHostEnv(hostRouting(input.hostSlug), input.env);
    } catch {
      return null as null | NodeJS.ProcessEnv;
    }
  })();
  if (!hostEnv) {
    return { ok: false, reason: "env_resolution_failed" };
  }
  const sitesDir = resolveCaddySitesDir(hostEnv);
  const script = `#!/usr/bin/env bash
set -euo pipefail
SITE_FILE=${shQuote(`${sitesDir}/${input.gatewayHost}.caddy`)}
if [ -f "$SITE_FILE" ]; then
  rm -f "$SITE_FILE"
  if command -v systemctl >/dev/null 2>&1; then
    for kv in $(systemctl show caddy -p Environment --value 2>/dev/null); do
      [ -n "$kv" ] && export "$kv"
    done
  fi
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || exit 1
  systemctl reload caddy || true
fi
`;
  const result = await runProxmoxHostScript(script, hostEnv, 30_000);
  if (!result.ok) {
    return {
      ok: false,
      reason: redactSensitiveCommandOutput(
        result.stderr || result.error || "host cleanup script failed",
        300,
      ),
    };
  }
  return { ok: true };
}

interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

async function cfFetch<T>(
  apiToken: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: { success?: boolean; errors?: Array<{ code: number; message: string }>; result?: T } }> {
  const res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body: { success?: boolean; errors?: Array<{ code: number; message: string }>; result?: T };
  try {
    body = await res.json() as typeof body;
  } catch {
    return { ok: false, status: res.status, body: { errors: [{ code: -1, message: "non-JSON response" }] } };
  }
  return { ok: res.ok && body.success === true, status: res.status, body };
}

/**
 * Upsert an A record `gatewayHost → publicIp`. Wildcard A records on the
 * zone (e.g. `*.agents.hermesos.cloud → fixturenodea`) get overridden by a
 * specific record — the orchestrator MUST create one for tenants whose new
 * PVE host doesn't match the wildcard target.
 *
 * Idempotent: if a record already exists with the right content, no-op.
 * If it exists with a different content, PATCH. If absent, POST.
 */
async function upsertSpecificARecord(input: {
  gatewayHost: string;
  publicIp: string;
  instanceId: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<{ ok: boolean; outcome: string; recordId?: string; publicIp: string }> {
  const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId = input.env.CLOUDFLARE_ZONE_ID?.trim();
  if (!apiToken || !zoneId) {
    return { ok: false, outcome: "cloudflare_not_configured", publicIp: input.publicIp };
  }

  // Match provisioning's proxy default (CLOUDFLARE_DNS_PROXIED). Provision mints
  // edge-proxied (orange-cloud) records; a restore that creates a grey-cloud
  // (proxied:false) record points the tenant subdomain straight at a host that
  // doesn't maintain a per-tenant edge cert → intermittent TLS failures (the
  // 2026-06-23 grey-cloud incident). Converge every create/patch to the same
  // proxy state the provisioner uses.
  const desiredProxied = getCloudflareDnsConfig(input.env)?.proxied === true;

  const list = await cfFetch<CloudflareDnsRecord[]>(
    apiToken,
    `/zones/${zoneId}/dns_records?${new URLSearchParams({ type: "A", name: input.gatewayHost }).toString()}`,
  );
  if (!list.ok) {
    return {
      ok: false,
      outcome: list.body.errors?.[0]?.message ?? `list_failed_http_${list.status}`,
      publicIp: input.publicIp,
    };
  }
  const existing = (list.body.result ?? []).find((r) => r.type === "A" && r.name.toLowerCase() === input.gatewayHost.toLowerCase());
  if (existing) {
    // Converge BOTH content and proxy state. A record that already points at
    // the right host but is grey-cloud (proxied:false) must still be flipped —
    // returning "unchanged" on a content-only match is exactly how stale grey
    // records survived (and reappeared in) the 2026-06-23 incident.
    if (existing.content === input.publicIp && (existing.proxied ?? false) === desiredProxied) {
      return { ok: true, outcome: "unchanged", recordId: existing.id, publicIp: input.publicIp };
    }
    const patch = await cfFetch<CloudflareDnsRecord>(
      apiToken,
      `/zones/${zoneId}/dns_records/${existing.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content: input.publicIp, ttl: 60, proxied: desiredProxied }),
      },
    );
    if (!patch.ok) {
      return {
        ok: false,
        outcome: patch.body.errors?.[0]?.message ?? `patch_failed_http_${patch.status}`,
        recordId: existing.id,
        publicIp: input.publicIp,
      };
    }
    return { ok: true, outcome: "updated", recordId: existing.id, publicIp: input.publicIp };
  }
  const create = await cfFetch<CloudflareDnsRecord>(
    apiToken,
    `/zones/${zoneId}/dns_records`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "A",
        name: input.gatewayHost,
        content: input.publicIp,
        ttl: 60,
        proxied: desiredProxied,
        comment: `cold-restore ${input.instanceId}`,
      }),
    },
  );
  if (!create.ok) {
    return {
      ok: false,
      outcome: create.body.errors?.[0]?.message ?? `create_failed_http_${create.status}`,
      publicIp: input.publicIp,
    };
  }
  return {
    ok: true,
    outcome: "created",
    recordId: create.body.result?.id,
    publicIp: input.publicIp,
  };
}

export async function applyRestoreRouting(
  input: ApplyRestoreRoutingInput,
): Promise<ApplyRestoreRoutingResult> {
  try {
    assertSupportedProxmoxGatewayHost(input.gatewayHost);
  } catch (error) {
    const reason = redactSensitiveCommandOutput(
      error instanceof Error ? error.message : "unsupported gateway host",
      300,
    );
    log.warn("post-restore routing rejected unsupported gateway hostname", {
      source: LOG_SOURCE,
      instanceId: input.instanceId,
      gatewayHost: input.gatewayHost,
      failureType: "post_restore_gateway_tls_policy_rejected",
      reason,
    });
    return {
      hostCaddy: { ok: false, reason },
      cloudflareDns: { ok: false, outcome: "skipped_unsupported_gateway_host" },
      oldHostCaddyCleanup: {
        ok: true,
        skipped: true,
        reason: "skipped_unsupported_gateway_host",
      },
    };
  }
  const env = input.env ?? process.env;
  const newHostPublicIp = (env[`PROXMOX_${input.newHostSlug.toUpperCase()}_PUBLIC_IP`] ??
    env[`PROXMOX_${input.newHostSlug.toUpperCase()}_SSH_HOST`])?.trim();

  // 1. New host: write site file + reload Caddy.
  const hostCaddy = await writeHostCaddySite({
    hostSlug: input.newHostSlug,
    gatewayHost: input.gatewayHost,
    privateIp: input.newPrivateIp,
    instanceId: input.instanceId,
    env,
  });
  if (!hostCaddy.ok) {
    log.warn("post-restore host caddy write failed", {
      source: LOG_SOURCE,
      instanceId: input.instanceId,
      failureType: "post_restore_host_caddy_failed",
      newHostSlug: input.newHostSlug,
      reason: hostCaddy.reason,
    });
    // Do not move DNS or remove the old working route when the destination
    // route could not be installed. This is especially important for legacy
    // nested Hermes hostnames rejected by the static-certificate policy.
    return {
      hostCaddy,
      cloudflareDns: { ok: false, outcome: "skipped_host_caddy_failed" },
      oldHostCaddyCleanup: {
        ok: true,
        skipped: true,
        reason: "skipped_host_caddy_failed",
      },
    };
  }

  // 2. Cloudflare: upsert the specific A record so it overrides the wildcard.
  let cloudflareDns: ApplyRestoreRoutingResult["cloudflareDns"] = {
    ok: false,
    outcome: "skipped_no_public_ip",
  };
  if (newHostPublicIp) {
    const dns = await upsertSpecificARecord({
      gatewayHost: input.gatewayHost,
      publicIp: newHostPublicIp,
      instanceId: input.instanceId,
      env,
    });
    cloudflareDns = dns;
    if (!dns.ok) {
      log.warn("post-restore cloudflare upsert failed", {
        source: LOG_SOURCE,
        instanceId: input.instanceId,
        failureType: "post_restore_cloudflare_upsert_failed",
        gatewayHost: input.gatewayHost,
        outcome: dns.outcome,
      });
    }
  } else {
    log.warn("post-restore cloudflare skipped: no public IP for host", {
      source: LOG_SOURCE,
      instanceId: input.instanceId,
      failureType: "post_restore_cloudflare_skipped_no_public_ip",
      newHostSlug: input.newHostSlug,
    });
  }

  // 3. Old host: best-effort caddy cleanup.
  let oldHostCaddyCleanup: ApplyRestoreRoutingResult["oldHostCaddyCleanup"] = {
    ok: true,
    skipped: true,
    reason: "no_old_host_slug",
  };
  if (input.oldHostSlug && input.oldHostSlug !== input.newHostSlug) {
    const cleanup = await removeHostCaddySite({
      hostSlug: input.oldHostSlug,
      gatewayHost: input.gatewayHost,
      env,
    });
    oldHostCaddyCleanup = cleanup;
    if (!cleanup.ok) {
      log.warn("post-restore old host caddy cleanup failed", {
        source: LOG_SOURCE,
        instanceId: input.instanceId,
        failureType: "post_restore_old_host_caddy_cleanup_failed",
        oldHostSlug: input.oldHostSlug,
        reason: cleanup.reason,
      });
    }
  }

  return { hostCaddy, oldHostCaddyCleanup, cloudflareDns };
}
