import { captureHivraAgentComputerReady } from "../agent-ready-telemetry";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";

jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("captureHivraAgentComputerReady", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(posthogClient.flush).mockResolvedValue(undefined);
  });

  it("accepts exact remote-desktop capability proof as first-ready evidence", async () => {
    await captureHivraAgentComputerReady({
      userId: "user-1",
      agentId: "computer-1",
      agentType: "linux-desktop",
      deploymentMode: "hivra-managed",
      operationId: "operation-1",
      vmid: 1090,
      evidence: "remote_desktop_capability_receipt",
    });

    expect(posthogClient.capture).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({
        readiness_evidence: "remote_desktop_capability_receipt",
      }),
    }));
  });

  it("uses one stable server-side readiness event id for the agent computer", async () => {
    await captureHivraAgentComputerReady({
      userId: "user_42",
      agentId: "agent-1",
      agentType: "codex",
      deploymentMode: "self-managed",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vmid: 1090,
      evidence: "host_ready_result",
    });

    expect(posthogClient.capture).toHaveBeenCalledWith({
      distinctId: "user_42",
      event: "activation_instance_ready",
      properties: {
        lane: "hivra",
        outcome: "hivra_verified_running",
        hasInstanceId: true,
        agent_id: "agent-1",
        agent_type: "codex",
        deployment_mode: "self-managed",
        operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vmid: 1090,
        readiness_evidence: "host_ready_result",
        $insert_id: "activation_instance_ready_agent-1",
        $set_once: { hermes_user_id: "user_42" },
      },
    });
    expect(posthogClient.flush).toHaveBeenCalledTimes(1);
  });

  it("never turns a persisted ready transition into an API failure when telemetry fails", async () => {
    jest.mocked(posthogClient.capture).mockImplementationOnce(() => {
      throw new Error("telemetry offline");
    });

    await expect(captureHivraAgentComputerReady({
      userId: "user_42",
      agentId: "agent-1",
      agentType: "codex",
      deploymentMode: "hivra-managed",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vmid: 1090,
      evidence: "recovery_tunnel_healthz",
    })).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "failed to capture hivra activation_instance_ready",
      expect.objectContaining({
        failureType: "hivra_agent_ready_capture_failed",
        agentId: "agent-1",
      }),
      expect.any(Error),
    );
  });
});
