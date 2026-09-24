import { supabaseAdmin } from "@/lib/supabase";

/**
 * Hivra agent lifecycle telemetry (Phase 0 observability foundation).
 *
 * Append-only. Lets later phases of the Hivra V1 rebuild prove behaviour from
 * data, not vibes (launch success rate, provision latency, failure reasons,
 * resize activity). Backed by public.hivra_agent_events.
 *
 * CONTRACT: this NEVER throws. Telemetry must not break provisioning — every
 * sink is wrapped and failures are swallowed.
 */

type HivraAgentEvent =
  | "launch_requested"
  | "provisioned"
  | "provision_failed"
  | "bootstrapped"
  | "bankr_skills_seeded"
  | "skills_installed"
  | "tools_installed"
  | "tools_uninstalled"
  | "template_skills_seeded"
  | "bankr_wallet_provisioned"
  | "failed"
  | "resized"
  | "stopped"
  | "started"
  | "restarted"
  | "runtime_updated"
  | "snapshot_created"
  | "snapshot_restored"
  | "deleted";

interface LogHivraAgentEventArgs {
  userId: string;
  event: HivraAgentEvent;
  agentId?: string | null;
  agentType?: string | null;
  detail?: Record<string, unknown>;
}

export async function logHivraAgentEvent({
  userId,
  event,
  agentId = null,
  agentType = null,
  detail = {},
}: LogHivraAgentEventArgs): Promise<void> {
  // 1) Structured log — always works, zero infra dependency.
  try {
    // eslint-disable-next-line no-console -- Phase-0 telemetry must emit unconditionally with zero infra dependency; the structured logger suppresses info-level in prod and would couple this to ops_events.
    console.log(
      JSON.stringify({ tag: "hivra.agent_event", event, userId, agentId, agentType, ...detail })
    );
  } catch {
    /* ignore */
  }

  // 2) Durable insert — best effort; swallow all errors.
  try {
    if (!supabaseAdmin) return;
    await supabaseAdmin.from("hivra_agent_events").insert({
      agent_id: agentId,
      user_id: userId,
      event,
      agent_type: agentType,
      detail,
    });
  } catch {
    /* telemetry must never break the caller */
  }
}
