import {
  AGENT_START_FAILURE_DEDUPE_MS,
  describeAgentStartFailure,
  getAgentStartFailureTelemetryKey,
  shouldCaptureAgentStartFailure,
} from "../agent-start-failure";

describe("agent start failure guidance", () => {
  it("turns runtime connectivity failures into actionable user guidance", () => {
    const failure = describeAgentStartFailure({
      status: 502,
      error: "connect ECONNREFUSED 127.0.0.1:8787",
    });

    expect(failure.code).toBe("runtime_unreachable");
    expect(failure.recoveryAction).toBe("open_console_logs");
    expect(failure.userMessage).toContain("runtime is not accepting chat yet");
    expect(failure.userMessage).toContain("Console");
  });

  it("routes entitlement failures to billing instead of runtime repairs", () => {
    const failure = describeAgentStartFailure({
      status: 402,
      failureType: "instance_entitlement_suspended",
      error: "Compute is suspended until billing or token eligibility is restored.",
    });

    expect(failure.code).toBe("instance_entitlement_suspended");
    expect(failure.recoveryAction).toBe("open_billing");
    expect(failure.retryable).toBe(false);
  });

  it("never turns a bare routing error into destructive recreate advice", () => {
    const failure = describeAgentStartFailure({
      status: 400,
      error: "No server attached",
    });

    expect(failure.recoveryAction).not.toBe("recreate_instance");
    expect(failure.userMessage.toLowerCase()).not.toContain("delete and re-create");
    expect(failure.code).toBe("agent_start_failed");
  });

  it.each([
    ["instance_host_recovery_pending", true, "wait_and_retry"],
    ["instance_host_routing_recovered", true, "wait_and_retry"],
    ["instance_host_missing_across_fleet", false, "contact_support"],
    ["instance_runtime_target_unresolved", false, "contact_support"],
  ] as const)(
    "gives non-destructive guidance for %s",
    (failureType, retryable, recoveryAction) => {
      const failure = describeAgentStartFailure({
        status: retryable ? 503 : 409,
        failureType,
        error: "runtime routing failure",
      });

      expect(failure.code).toBe(failureType);
      expect(failure.retryable).toBe(retryable);
      expect(failure.recoveryAction).toBe(recoveryAction);
      expect(failure.userMessage.toLowerCase()).not.toContain("delete and re-create");
    }
  );

  it("dedupes repeated identical telemetry within the loop window", () => {
    const seen = new Map<string, number>();
    const failure = describeAgentStartFailure({
      status: 502,
      error: "connect ECONNREFUSED 127.0.0.1:8787",
    });
    const key = getAgentStartFailureTelemetryKey("inst_123", failure);

    expect(shouldCaptureAgentStartFailure(seen, key, 1_000)).toBe(true);
    expect(shouldCaptureAgentStartFailure(seen, key, 2_000)).toBe(false);
    expect(shouldCaptureAgentStartFailure(seen, key, 1_000 + AGENT_START_FAILURE_DEDUPE_MS + 1)).toBe(true);
  });
});
