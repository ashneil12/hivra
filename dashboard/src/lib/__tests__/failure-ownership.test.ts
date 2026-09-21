import {
  buildInstanceFailureAlertFromOpsEvent,
  getFailureOwnerLabel,
  getFailurePhaseLabel,
  getRecoveryActionLabel,
} from "../failure-ownership";

describe("failure ownership contract", () => {
  it("turns explicit failure metadata into a user-facing alert contract", () => {
    const alert = buildInstanceFailureAlertFromOpsEvent({
      source: "provider-runtime",
      severity: "error",
      title: "Provider authentication failed",
      message: "OpenRouter rejected the saved key.",
      lastSeenAt: "2026-05-05T08:00:00.000Z",
      metadata: {
        failureOwner: "user",
        failurePhase: "auth",
        failureType: "provider_key_rejected",
        recoveryAction: "update_provider_key",
        requestId: "req_123",
      },
    });

    expect(alert).toEqual({
      title: "Provider authentication failed",
      message: "OpenRouter rejected the saved key.",
      lastSeenAt: "2026-05-05T08:00:00.000Z",
      owner: "user",
      ownerLabel: "Your action needed",
      phase: "auth",
      phaseLabel: "Authentication",
      severity: "error",
      recoveryAction: "update_provider_key",
      recoveryLabel: "Update provider key",
      failureType: "provider_key_rejected",
      requestId: "req_123",
      source: "provider-runtime",
      runType: undefined,
      reason: undefined,
    });
  });

  it("maps failed update status events into Hermes-owned update failures", () => {
    const alert = buildInstanceFailureAlertFromOpsEvent({
      source: "instance-update-status",
      severity: "error",
      title: "Auto-update failed",
      message: "Auto-update reported a host-side failure.",
      lastSeenAt: "2026-05-05T08:00:00.000Z",
      metadata: {
        status: "failed",
        runType: "scheduled",
        reason: "exit_status_1",
      },
    });

    expect(alert).toMatchObject({
      owner: "hermes",
      phase: "update",
      recoveryAction: "open_console",
      runType: "scheduled",
      reason: "exit_status_1",
    });
  });

  it("does not surface successful update events as active failures", () => {
    expect(
      buildInstanceFailureAlertFromOpsEvent({
        source: "instance-update-status",
        severity: "info",
        title: "Manual update succeeded",
        message: "Manual update completed.",
        lastSeenAt: "2026-05-05T08:00:00.000Z",
        metadata: {
          status: "succeeded",
          runType: "manual",
        },
      })
    ).toBeNull();
  });

  it("has readable labels for owners, phases, and recovery actions", () => {
    expect(getFailureOwnerLabel("hypervisor")).toBe("Infrastructure issue");
    expect(getFailurePhaseLabel("egress")).toBe("Network egress");
    expect(getRecoveryActionLabel("repair_runtime")).toBe("Repair runtime");
  });
});
