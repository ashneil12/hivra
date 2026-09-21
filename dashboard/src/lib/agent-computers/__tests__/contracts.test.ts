import {
  AGENT_COMPUTER_ACTIONS,
  AGENT_COMPUTER_COMMAND_ACTIONS,
  AGENT_COMPUTER_CONTRACT_VERSION,
  AGENT_COMPUTER_DESIRED_STATES,
  AGENT_COMPUTER_HEALTH_STATES,
  AGENT_COMPUTER_OBSERVED_STATES,
  AGENT_COMPUTER_OPERATION_STATES,
  AGENT_COMPUTER_SURFACES,
  AgentComputerCommandResultSchema,
  AgentComputerCommandSchema,
  AgentComputerSchema,
} from "../contracts";

const FORBIDDEN_KEYS = new Set([
  "token",
  "secret",
  "password",
  "apiKey",
  "privateKey",
  "honcho_api_key_encrypted",
  "config",
]);

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenKeys);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value)) {
    expect(FORBIDDEN_KEYS).not.toContain(key);
    assertNoForbiddenKeys(nested);
  }
}

function validComputer() {
  return {
    contractVersion: AGENT_COMPUTER_CONTRACT_VERSION,
    id: "h-instance-1",
    name: "Codex workspace",
    source: { kind: "hermes" as const, id: "instance-1" },
    capabilities: {
      surfaces: [...AGENT_COMPUTER_SURFACES],
      actions: [...AGENT_COMPUTER_ACTIONS],
    },
    state: {
      desired: "running" as const,
      observed: "stopped" as const,
      health: "unreachable" as const,
      operation: {
        state: "starting" as const,
        id: "operation-1",
        idempotencyKey: "request-1",
        observedAt: "2026-08-24T16:00:00.000Z",
      },
    },
    compatibility: { mode: "projected" as const, sourceStatus: "stopped" },
  };
}

describe("agent-computer public contract", () => {
  it("preserves contradictory desired, observed, health, and operation evidence", () => {
    const parsed = AgentComputerSchema.parse(validComputer());

    expect(parsed.state).toEqual({
      desired: "running",
      observed: "stopped",
      health: "unreachable",
      operation: {
        state: "starting",
        id: "operation-1",
        idempotencyKey: "request-1",
        observedAt: "2026-08-24T16:00:00.000Z",
      },
    });
  });

  it("round-trips as JSON without forbidden keys", () => {
    const parsed = AgentComputerSchema.parse(validComputer());
    const roundTripped = JSON.parse(JSON.stringify(parsed));

    expect(roundTripped).toEqual(parsed);
    assertNoForbiddenKeys(roundTripped);
  });

  it.each(AGENT_COMPUTER_DESIRED_STATES)("accepts desired state %s", (desired) => {
    expect(
      AgentComputerSchema.safeParse({
        ...validComputer(),
        state: { ...validComputer().state, desired },
      }).success
    ).toBe(true);
  });

  it.each(AGENT_COMPUTER_OBSERVED_STATES)("accepts observed state %s", (observed) => {
    expect(
      AgentComputerSchema.safeParse({
        ...validComputer(),
        state: { ...validComputer().state, observed },
      }).success
    ).toBe(true);
  });

  it.each(AGENT_COMPUTER_HEALTH_STATES)("accepts health state %s", (health) => {
    expect(
      AgentComputerSchema.safeParse({
        ...validComputer(),
        state: { ...validComputer().state, health },
      }).success
    ).toBe(true);
  });

  it.each(AGENT_COMPUTER_OPERATION_STATES)(
    "accepts operation state %s",
    (operationState) => {
      expect(
        AgentComputerSchema.safeParse({
          ...validComputer(),
          state: {
            ...validComputer().state,
            operation: { state: operationState },
          },
        }).success
      ).toBe(true);
    }
  );

  it.each(AGENT_COMPUTER_COMMAND_ACTIONS)("accepts command action %s", (action) => {
    expect(
      AgentComputerCommandSchema.safeParse({
        computerId: "h-instance-1",
        requestId: "request-1",
        action,
      }).success
    ).toBe(true);
  });

  it.each([
    ["empty computer id", { ...validComputer(), id: "" }],
    ["unsafe source id", { ...validComputer(), source: { kind: "hermes", id: "a/b" } }],
    [
      "invalid timestamp",
      {
        ...validComputer(),
        state: {
          ...validComputer().state,
          operation: { state: "starting", observedAt: "yesterday" },
        },
      },
    ],
    ["unknown surface", { ...validComputer(), capabilities: { surfaces: ["shell"], actions: [] } }],
    ["secret-shaped extra key", { ...validComputer(), config: { token: "inert" } }],
  ])("rejects %s", (_label, input) => {
    expect(AgentComputerSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an invalid command action", () => {
    expect(
      AgentComputerCommandSchema.safeParse({
        computerId: "h-instance-1",
        requestId: "request-1",
        action: "snapshot",
      }).success
    ).toBe(false);
  });

  it("keeps command results acknowledgement-only and strict", () => {
    const accepted = AgentComputerCommandResultSchema.parse({
      ok: true,
      status: "accepted",
      requestId: "request-1",
      operationId: "operation-1",
      observedAt: "2026-08-24T16:00:00.000Z",
    });

    expect(accepted.status).toBe("accepted");
    expect(
      AgentComputerCommandResultSchema.safeParse({
        ok: false,
        status: "rejected",
        requestId: "request-1",
        code: "AUTHORITY_ERROR",
        error: new Error("raw provider failure"),
      }).success
    ).toBe(false);
    assertNoForbiddenKeys(accepted);
  });
});
