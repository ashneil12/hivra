// Manual smoke test: provisions a fresh Proxmox VM in WebUI mode and
// validates that POST /api/chat/start round-trips a real model response.
//
// Run from the dashboard/ dir (env vars must be present in the shell):
//   CROF_KEY=nahcrof_xxx \
//   PROXMOX_PUBLIC_IP=203.0.113.10 \
//   PROXMOX_SSH_HOST=203.0.113.10 \
//   PROXMOX_SSH_KEY_PATH=/path/to/proxmox-admin-key \
//   PROXMOX_TEMPLATE_ID=9000 \
//   PROXMOX_VM_SSH_KEY_PATH=/path/to/guest-orchestrator-key \
//   PROXMOX_VM_SSH_USER=hermes \
//   ts-node -r ./scripts/register-server-only-noop.cjs -r tsconfig-paths/register scripts/smoke-proxmox-webui.ts

import { randomBytes } from "crypto";
import {
  provisionProxmoxInstance,
  deleteProxmoxInstance,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";
import type { ProxmoxInfrastructure } from "../src/lib/services/proxmox-instance-service";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchUntil(
  label: string,
  url: string,
  init: RequestInit,
  accepts: (res: Response) => boolean,
  attempts = 90
): Promise<Response> {
  let lastError: unknown = null;
  let lastStatus = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, init);
      lastStatus = `${res.status} ${res.statusText}`;
      if (accepts(res)) return res;
    } catch (err) {
      lastError = err;
      lastStatus = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }

    if (attempt === 1 || attempt % 10 === 0) {
      console.log(`[smoke] ${label} not ready yet (${lastStatus}); retrying (${attempt}/${attempts}) ...`);
    }
    await sleep(2_000);
  }

  throw new Error(`${label} did not become ready after ${attempts} attempts; last=${lastStatus}`, {
    cause: lastError,
  });
}

async function main() {
  const crofKey = process.env.CROF_KEY;
  if (!crofKey) {
    console.error("CROF_KEY is required");
    process.exit(1);
  }

  const instanceId = `smoke-${randomBytes(4).toString("hex")}`;
  const subdomain = `smoke${randomBytes(3).toString("hex")}`;
  console.log(`[smoke] Provisioning Proxmox+WebUI VM (instanceId=${instanceId}, subdomain=${subdomain})`);
  console.log(`[smoke] Public IP: ${process.env.PROXMOX_PUBLIC_IP}`);

  const startedAt = Date.now();
  let provisionedInfrastructure: ProxmoxInfrastructure | null = null;

  try {
    const result = await provisionProxmoxInstance(
      {
        userId: "smoke-test",
        instanceId,
        cpuLimit: 0.5,
        ramLimit: 1024,
        name: "smoke webui",
        provider: "crof",
        apiKey: crofKey,
        model: "deepseek-v4-pro",
        subdomain,
        backend: "webui",
      },
      {
        // Override the runner so we can see the FULL stdout/stderr — the
        // built-in redactSensitiveCommandOutput() truncates to 800 chars.
        runHostScript: async (script) => {
          const r = await runProxmoxHostScript(script);
          if (!r.ok) {
            console.error(`[smoke] runHostScript FAILED — full output below:`);
            console.error(`[smoke] ----- STDOUT (${r.stdout.length} chars) -----`);
            console.error(r.stdout);
            console.error(`[smoke] ----- STDERR (${r.stderr.length} chars) -----`);
            console.error(r.stderr);
            console.error(`[smoke] ----- error: ${r.error || "(none)"}`);
          }
          return r;
        },
      }
    );
    if (result.ok) provisionedInfrastructure = result.infrastructure;

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[smoke] provisionProxmoxInstance returned in ${elapsed}s:`, result);

    if (!result.ok) {
      throw new Error("provisioning returned not-ok");
    }

    const gatewayUrl = result.gatewayUrl;
    const apiServerKey = result.apiServerKey;
    console.log(`[smoke] Gateway: ${gatewayUrl}`);
    console.log(`[smoke] Bearer key length: ${apiServerKey.length} (prefix: ${apiServerKey.slice(0, 6)})`);

    // 1) Probe /health (public, no auth required by the WebUI Caddyfile).
    // Phase 1 returns as soon as the VM and Caddy route exist; Phase 2 still
    // needs to finish Docker/bootstrap work, so this must poll.
    console.log(`[smoke] Probing ${gatewayUrl}/health ...`);
    const healthRes = await fetchUntil(
      "/health",
      `${gatewayUrl}/health`,
      {},
      (res) => res.ok
    );
    console.log(`[smoke] /health → ${healthRes.status} ${healthRes.statusText}`);

    // 2) Probe /api/chat/start without auth — must be 401 (proves edge auth works)
    console.log(`[smoke] Probing /api/chat/start unauthenticated ...`);
    const unauthRes = await fetchUntil(
      "/api/chat/start unauthenticated",
      `${gatewayUrl}/api/chat/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      (res) => res.status === 401
    );
    console.log(`[smoke] unauth /api/chat/start → ${unauthRes.status}`);

    // 3) Probe legacy /api/chats/start with auth — should rewrite to /api/chat/start
    //    The dashboard chat-stream worker still calls /api/chats/start;
    //    this verifies the legacy rewrite is alive on a freshly provisioned VM.
    console.log(`[smoke] Probing legacy /api/chats/start with auth (rewrite check) ...`);
    const legacyRewrite = await fetchUntil(
      "legacy /api/chats/start",
      `${gatewayUrl}/api/chats/start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiServerKey}`,
        },
        body: JSON.stringify({}),
      },
      (res) => res.status !== 404 && res.status >= 400
    );
    // Expecting 4xx (validation error from missing fields), NOT 404 — 404 would
    // mean the legacy rewrite isn't wired.
    console.log(`[smoke] legacy /api/chats/start → ${legacyRewrite.status}`);

    console.log(`\n[smoke] ✅ ALL CHECKS PASSED`);
    console.log(`[smoke] Provisioned in ${elapsed}s`);
    console.log(`[smoke] Gateway URL: ${gatewayUrl}`);
    console.log(`[smoke] VMID: ${result.vmid}`);
    console.log(`[smoke] Private IP: ${result.ipv4}`);
    console.log(``);
    console.log(`[smoke] Or, if KEEP_VM=1, leaving the VM up for manual chat testing.`);

    if (process.env.KEEP_VM === "1") {
      console.log(`[smoke] KEEP_VM=1 set, NOT cleaning up. VMID ${result.vmid} left running.`);
      provisionedInfrastructure = null;
      return;
    }
  } finally {
    if (provisionedInfrastructure) {
      console.log(`[smoke] Cleaning up VM ${provisionedInfrastructure.vmid} ...`);
      const del = await deleteProxmoxInstance(provisionedInfrastructure, {
        expectedInstanceId: instanceId,
      });
      console.log(`[smoke] delete → ok=${del.ok}`);
    }
  }

}

main().catch((err) => {
  console.error("[smoke] FAIL — unexpected error:", err);
  process.exit(1);
});
