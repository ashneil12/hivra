import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";

export type HivraAgentReadyEvidence =
  | "host_ready_result"
  | "remote_desktop_capability_receipt"
  | "recovery_log_marker"
  | "recovery_tunnel_healthz";

/**
 * Emit the canonical activation-readiness event only after the caller has won the atomic
 * provisioning-to-running completion. The stable insert id gives PostHog a
 * second dedupe boundary if a delivery retry ever crosses processes.
 *
 * This is deliberately server-side: accepting POST /api/hivra/agents creates
 * durable launch intent, but it does not prove that the runtime is reachable.
 */
export async function captureHivraAgentComputerReady(input: {
  userId: string;
  agentId: string;
  agentType: string | null;
  deploymentMode: string | null;
  operationId: string;
  vmid: number | null;
  evidence: HivraAgentReadyEvidence;
}): Promise<void> {
  try {
    posthogClient.capture({
      distinctId: input.userId,
      event: "activation_instance_ready",
      properties: {
        lane: "hivra",
        outcome: "hivra_verified_running",
        hasInstanceId: true,
        agent_id: input.agentId,
        agent_type: input.agentType,
        deployment_mode: input.deploymentMode,
        operation_id: input.operationId,
        vmid: input.vmid,
        readiness_evidence: input.evidence,
        $insert_id: `activation_instance_ready_${input.agentId}`,
        $set_once: { hermes_user_id: input.userId },
      },
    });
    await posthogClient.flush();
  } catch (error) {
    log.warn(
      "failed to capture hivra activation_instance_ready",
      {
        source: "hivra/agent-ready-telemetry",
        failureType: "hivra_agent_ready_capture_failed",
        userId: input.userId,
        agentId: input.agentId,
        agentType: input.agentType,
        deploymentMode: input.deploymentMode,
      },
      error,
    );
  }
}
