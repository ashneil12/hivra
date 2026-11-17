import net from "node:net";

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveProxmoxHostEnv } from "@/lib/services/proxmox-instance-service";
import { trustedClientAddress } from "@/lib/infrastructure/trusted-client-address";

/**
 * Binds each Hivra AI key to the computer it was made for.
 *
 * A key minted for a Hivra computer (metadata.agentId) is accepted only from
 * the public address of the host that computer runs on, so a key copied off
 * the computer does not work anywhere else. Keys an owner made for their own
 * use (no agentId) and keys of computers on servers Hivra does not run are not
 * bound.
 *
 * HIVRA_MANAGED_KEY_BINDING: unset/`off` checks nothing; `observe` checks and
 * records mismatches but lets every request through; `enforce` refuses a bound
 * key used from anywhere else. Run `observe` first: a host with a second
 * outbound address shows up there before it can break anyone.
 * HIVRA_MANAGED_KEY_BINDING_EXTRA_ADDRESSES: more allowed addresses, comma
 * separated, for every bound key (a host's second outbound address).
 */

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here
type Db = any;

export type KeyBindingMode = "off" | "observe" | "enforce";

export function keyBindingMode(env: EnvLike = process.env): KeyBindingMode {
  const value = env.HIVRA_MANAGED_KEY_BINDING?.trim().toLowerCase();
  return value === "observe" || value === "enforce" ? value : "off";
}

/** Where the caller's address came from. `worker` = forwarded by the inference Worker. */
export type KeyBindingCaller = { address: string | null; via: "direct" | "worker" };

export type KeyBindingDecision = {
  allowed: boolean;
  outcome: "off" | "unbound" | "match" | "mismatch" | "unknown_address" | "unknown_host";
};

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  let address = value.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) address = mapped[1];
  return net.isIP(address) ? address : null;
}

const CACHE_MS = 5 * 60_000;
const allowedCache = new Map<string, { at: number; addresses: string[] | null }>();

/** The addresses one computer's key may be used from, or null when its key is not bound. */
export async function allowedAddressesForAgent(agentId: string, deps: { db?: Db; env?: EnvLike; now?: () => number } = {}): Promise<string[] | null | "unknown_host"> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const cached = allowedCache.get(agentId);
  if (cached && now() - cached.at < CACHE_MS) return cached.addresses;
  const db = deps.db ?? supabaseAdmin;
  if (!db) return "unknown_host";
  const { data, error } = await db
    .from("hivra_agents")
    .select("id, proxmox_host, deployment_mode, deployment_target_id, computer_substrate, status")
    .eq("id", agentId)
    .maybeSingle();
  if (error) return "unknown_host";
  let addresses: string[] | null = null;
  if (data && data.deployment_mode === "hivra-managed" && !data.deployment_target_id && data.computer_substrate === "proxmox-kvm") {
    const host = typeof data.proxmox_host === "string" ? data.proxmox_host : "";
    let hostAddress: string | null = null;
    try {
      const hostEnv = resolveProxmoxHostEnv({ hostId: host, hostSlug: host, failClosed: true }, env);
      hostAddress = normalizeAddress(hostEnv.PROXMOX_PUBLIC_IP);
    } catch {
      hostAddress = null;
    }
    if (!hostAddress) return "unknown_host";
    const extra = (env.HIVRA_MANAGED_KEY_BINDING_EXTRA_ADDRESSES ?? "").split(",").map((a) => normalizeAddress(a)).filter((a): a is string => Boolean(a));
    addresses = [...new Set([hostAddress, ...extra])];
  }
  allowedCache.set(agentId, { at: now(), addresses });
  return addresses;
}

/** Test hook. */
export function resetKeyBindingCache(): void {
  allowedCache.clear();
  reported.clear();
}

/** The caller of the current route, read from the one header the platform sets. */
export async function currentDirectCaller(env: EnvLike = process.env): Promise<KeyBindingCaller> {
  try {
    const { headers } = await import("next/headers");
    const list = await headers();
    const request = new Request("http://local/", { headers: list });
    return { address: trustedClientAddress(request, env).address, via: "direct" };
  } catch {
    return { address: null, via: "direct" };
  }
}

const reported = new Map<string, number>();
const REPORT_EVERY_MS = 60 * 60_000;

/**
 * Decides whether a verified key may be used by this caller. In `observe`
 * mode the answer is always allowed; a mismatch is logged and recorded once
 * an hour per key, with no addresses in the record.
 */
export async function checkKeyBinding(input: {
  keyId: string;
  userId: string | null;
  metadata: Record<string, unknown> | null | undefined;
  caller: KeyBindingCaller | null;
}, deps: { db?: Db; env?: EnvLike; now?: () => number } = {}): Promise<KeyBindingDecision> {
  const env = deps.env ?? process.env;
  const mode = keyBindingMode(env);
  if (mode === "off") return { allowed: true, outcome: "off" };
  const agentId = typeof input.metadata?.agentId === "string" ? input.metadata.agentId : null;
  if (!agentId) return { allowed: true, outcome: "unbound" };
  const allowed = await allowedAddressesForAgent(agentId, deps);
  if (allowed === null) return { allowed: true, outcome: "unbound" };
  let outcome: KeyBindingDecision["outcome"];
  if (allowed === "unknown_host") outcome = "unknown_host";
  else {
    const address = normalizeAddress(input.caller?.address ?? null);
    outcome = !address ? "unknown_address" : allowed.includes(address) ? "match" : "mismatch";
  }
  if (outcome === "match") return { allowed: true, outcome };
  // A host whose address Hivra cannot read is never refused for it: that is Hivra's gap, not the caller's.
  const refuse = mode === "enforce" && (outcome === "mismatch" || outcome === "unknown_address");
  const now = (deps.now ?? Date.now)();
  const reportKey = `${input.keyId}:${outcome}`;
  if (now - (reported.get(reportKey) ?? 0) > REPORT_EVERY_MS) {
    reported.set(reportKey, now);
    log.warn("managed AI key used away from its computer", {
      source: "managed-venice-key-binding", failureType: `managed_key_binding_${outcome}`, instanceId: agentId,
    });
    void reportOpsEvent({
      source: "managed-venice-key-binding",
      severity: refuse ? "error" : "warn",
      title: `Managed AI key binding: ${outcome}${refuse ? " (refused)" : ""}`,
      message: `mode=${mode} via=${input.caller?.via ?? "none"} key=${input.keyId}`,
      userId: input.userId ?? undefined,
      instanceId: agentId,
    }).catch(() => undefined);
  }
  return { allowed: !refuse, outcome };
}
