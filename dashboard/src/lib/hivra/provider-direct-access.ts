import "server-only";

import { isIP } from "node:net";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { reservedAddressReason } from "@/lib/url-safety";

const Operation = z.object({
  userId: z.string().min(1).max(256),
  agentId: z.string().uuid(),
  operationId: z.string().uuid(),
  address: z.string().max(64),
}).strict();

export type ProviderDirectAccess = {
  mode: "direct-https";
  hostname: string;
  origin: string;
  tunnelId: null;
  tunnelToken: null;
};

class ProviderDirectAccessError extends Error {
  constructor() {
    super("Direct provider access could not be bound to the original agent operation.");
    this.name = "ProviderDirectAccessError";
  }
}

/**
 * Standalone provider computers expose the already-authenticated Hivra surface
 * through Caddy on the computer's exact public IPv4. sslip.io supplies only
 * DNS; the operator-owned computer terminates TLS and retains all credentials.
 */
export function providerDirectAccessForAddress(rawAddress: string): ProviderDirectAccess {
  const address = rawAddress;
  if (isIP(address) !== 4 || reservedAddressReason(address) !== null) {
    throw new ProviderDirectAccessError();
  }
  const hostname = `${address.replace(/\./g, "-")}.sslip.io`;
  return { mode: "direct-https", hostname, origin: `https://${hostname}`, tunnelId: null, tunnelToken: null };
}

export function readStoredProviderDirectAccess(rawChatUrl: unknown, rawAddress: unknown): ProviderDirectAccess | null {
  if (typeof rawChatUrl !== "string" || typeof rawAddress !== "string") return null;
  try {
    const expected = providerDirectAccessForAddress(rawAddress);
    return rawChatUrl === expected.origin ? expected : null;
  } catch {
    return null;
  }
}

/** Keep recipient admission identical to the database helper: direct access
 * belongs only to provider VMs and cannot be mixed with named-tunnel state. */
export function readAgentProviderDirectAccess(agent: {
  computer_substrate: unknown; cf_hostname: unknown; cf_tunnel_id: unknown;
  chat_url: unknown; ip: unknown;
}): ProviderDirectAccess | null {
  if (agent.computer_substrate !== "provider-vm" || agent.cf_hostname !== null || agent.cf_tunnel_id !== null) return null;
  return readStoredProviderDirectAccess(agent.chat_url, agent.ip);
}

/**
 * Journals direct access before the guest is changed. The write is idempotent:
 * a lost acknowledgement is recovered only by reading the exact origin and IP
 * back from the same owner/agent/operation row. No provider request occurs.
 */
export async function bindProviderDirectAccess(raw: {
  userId: string;
  agentId: string;
  operationId: string;
  address: string;
}): Promise<ProviderDirectAccess> {
  const input = Operation.parse(structuredClone(raw));
  const access = providerDirectAccessForAddress(input.address);
  if (!supabaseAdmin) throw new ProviderDirectAccessError();

  const base = () => supabaseAdmin!.from("hivra_agents")
    .select("id,user_id,operation_id,chat_url,ip,cf_tunnel_id,cf_hostname")
    .eq("id", input.agentId)
    .eq("user_id", input.userId)
    .eq("operation_id", input.operationId)
    .eq("operation_kind", "provision")
    .eq("status", "provisioning")
    .eq("desired_state", "running")
    .eq("computer_substrate", "provider-vm")
    .is("cf_tunnel_id", null)
    .is("cf_hostname", null);

  const bound = await supabaseAdmin.rpc("bind_hivra_provider_direct_access", {
    p_user_id: input.userId, p_agent_id: input.agentId,
    p_operation_id: input.operationId, p_address: input.address,
  });
  if (bound.error || bound.data !== true) throw new ProviderDirectAccessError();
  const readback = await base().maybeSingle();
  if (readback.error) throw new ProviderDirectAccessError();
  const recovered = readback.data;
  if (
    !recovered
    || recovered.id !== input.agentId
    || recovered.user_id !== input.userId
    || recovered.operation_id !== input.operationId
    || recovered.chat_url !== access.origin
    || recovered.ip !== input.address
    || recovered.cf_tunnel_id !== null
    || recovered.cf_hostname !== null
  ) {
    throw new ProviderDirectAccessError();
  }
  return access;
}
