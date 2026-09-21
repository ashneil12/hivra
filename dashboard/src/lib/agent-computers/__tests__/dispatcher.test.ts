import {
  AGENT_COMPUTER_ACTIONS,
  AGENT_COMPUTER_COMMAND_ACTIONS,
  AGENT_COMPUTER_CONTRACT_VERSION,
  type AgentComputer,
  type AgentComputerAction,
  type AgentComputerCommandResult,
} from "../contracts";
import {
  createAgentComputerAdapter,
  dispatchAgentComputerCommand,
  type AgentComputerAuthority,
} from "../dispatcher";

const SECRET_SENTINEL = "DO_NOT_SERIALIZE_DISPATCHER_SECRET";

function accepted(requestId = "request-1"): AgentComputerCommandResult {
  return {
    ok: true,
    status: "accepted",
    requestId,
    operationId: "operation-1",
  };
}

function computer(actions: AgentComputerAction[] = [...AGENT_COMPUTER_ACTIONS]): AgentComputer {
  return {
    contractVersion: AGENT_COMPUTER_CONTRACT_VERSION,
    id: "h-instance-1",
    name: "Codex workspace",
    source: { kind: "hermes", id: "instance-1" },
    capabilities: { surfaces: ["workspace", "terminal"], actions },
    state: {
      desired: "running",
      observed: "running",
      health: "healthy",
      operation: null,
    },
    compatibility: { mode: "projected", sourceStatus: "running" },
  };
}

function authority(
  result?: AgentComputerCommandResult
): jest.Mocked<AgentComputerAuthority> {
  const implementation = (input: { requestId: string }) =>
    Promise.resolve(result ?? accepted(input.requestId));
  return {
    provision: jest.fn().mockImplementation(implementation),
    start: jest.fn().mockImplementation(implementation),
    stop: jest.fn().mockImplementation(implementation),
    reboot: jest.fn().mockImplementation(implementation),
    delete: jest.fn().mockImplementation(implementation),
  };
}

function expectNoAuthorityCalls(port: jest.Mocked<AgentComputerAuthority>): void {
  for (const action of AGENT_COMPUTER_COMMAND_ACTIONS) {
    expect(port[action]).not.toHaveBeenCalled();
  }
}

describe("dispatchAgentComputerCommand", () => {
  it("rejects a malformed command before any authority method is called", async () => {
    const port = authority();

    const result = await dispatchAgentComputerCommand({
      computer: computer(),
      command: {
        computerId: "h-instance-1",
        requestId: "request-1",
        action: "snapshot",
        apiKey: SECRET_SENTINEL,
      },
      authority: port,
    });

    expect(result).toEqual({
      ok: false,
      status: "rejected",
      requestId: "request-1",
      code: "INVALID_COMMAND",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expectNoAuthorityCalls(port);
  });

  it("rejects a command for another computer before delegation", async () => {
    const port = authority();

    const result = await dispatchAgentComputerCommand({
      computer: computer(),
      command: {
        computerId: "h-instance-2",
        requestId: "request-2",
        action: "start",
      },
      authority: port,
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    expectNoAuthorityCalls(port);
  });

  it("denies an unadvertised action before delegation", async () => {
    const port = authority();

    const result = await dispatchAgentComputerCommand({
      computer: computer(["start"]),
      command: {
        computerId: "h-instance-1",
        requestId: "request-3",
        action: "delete",
      },
      authority: port,
    });

    expect(result).toEqual({
      ok: false,
      status: "rejected",
      requestId: "request-3",
      code: "UNSUPPORTED_ACTION",
    });
    expectNoAuthorityCalls(port);
  });

  it.each(AGENT_COMPUTER_COMMAND_ACTIONS)(
    "delegates advertised %s exactly once to only its matching authority method",
    async (action) => {
      const port = authority();

      const result = await dispatchAgentComputerCommand({
        computer: computer(),
        command: {
          computerId: "h-instance-1",
          requestId: `request-${action}`,
          action,
        },
        authority: port,
      });

      expect(result).toEqual(accepted(`request-${action}`));
      expect(port[action]).toHaveBeenCalledTimes(1);
      expect(port[action]).toHaveBeenCalledWith({
        source: { kind: "hermes", id: "instance-1" },
        computerId: "h-instance-1",
        requestId: `request-${action}`,
        action,
      });
      for (const otherAction of AGENT_COMPUTER_COMMAND_ACTIONS) {
        if (otherAction !== action) expect(port[otherAction]).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    {
      description: "accepted",
      authorityResult: accepted("stale-request"),
    },
    {
      description: "rejected",
      authorityResult: {
        ok: false,
        status: "rejected",
        requestId: "stale-request",
        code: "UNSUPPORTED_ACTION",
      } satisfies AgentComputerCommandResult,
    },
  ])(
    "fails closed when an authority returns a mismatched request ID in an $description result",
    async ({ authorityResult }) => {
      const port = authority(authorityResult);

      const result = await dispatchAgentComputerCommand({
        computer: computer(),
        command: {
          computerId: "h-instance-1",
          requestId: "current-request",
          action: "start",
        },
        authority: port,
      });

      expect(result).toEqual({
        ok: false,
        status: "rejected",
        requestId: "current-request",
        code: "AUTHORITY_ERROR",
      });
      expect(port.start).toHaveBeenCalledTimes(1);
    }
  );

  it("turns invalid secret-bearing authority output into a safe failure", async () => {
    const port = authority();
    port.start.mockResolvedValue({
      ok: true,
      status: "accepted",
      requestId: "request-4",
      secret: SECRET_SENTINEL,
    } as unknown as AgentComputerCommandResult);

    const result = await dispatchAgentComputerCommand({
      computer: computer(),
      command: {
        computerId: "h-instance-1",
        requestId: "request-4",
        action: "start",
      },
      authority: port,
    });

    expect(result).toEqual({
      ok: false,
      status: "rejected",
      requestId: "request-4",
      code: "AUTHORITY_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expect(port.start).toHaveBeenCalledTimes(1);
  });

  it("turns a thrown raw authority failure into a safe failure without retry", async () => {
    const port = authority();
    port.stop.mockRejectedValue(new Error(SECRET_SENTINEL));

    const result = await dispatchAgentComputerCommand({
      computer: computer(),
      command: {
        computerId: "h-instance-1",
        requestId: "request-5",
        action: "stop",
      },
      authority: port,
    });

    expect(result).toMatchObject({ ok: false, code: "AUTHORITY_ERROR" });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expect(port.stop).toHaveBeenCalledTimes(1);
  });
});

describe("createAgentComputerAdapter", () => {
  it("parses describe output and reuses guarded dispatch", async () => {
    const port = authority();
    const describe = jest.fn().mockResolvedValue(computer(["reboot"]));
    const adapter = createAgentComputerAdapter({ describe, authority: port });

    await expect(adapter.describe()).resolves.toEqual(computer(["reboot"]));
    await expect(
      adapter.dispatch({
        computerId: "h-instance-1",
        requestId: "request-adapter",
        action: "delete",
      })
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_ACTION" });

    expect(describe).toHaveBeenCalledTimes(2);
    expectNoAuthorityCalls(port);
  });

  it("contains a rejected description as a secret-safe authority failure", async () => {
    const port = authority();
    const describe = jest.fn().mockRejectedValue(new Error(SECRET_SENTINEL));
    const adapter = createAgentComputerAdapter({ describe, authority: port });

    const result = await adapter.dispatch({
      computerId: "h-instance-1",
      requestId: "request-describe-failure",
      action: "start",
    });

    expect(result).toEqual({
      ok: false,
      status: "rejected",
      requestId: "request-describe-failure",
      code: "AUTHORITY_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expect(describe).toHaveBeenCalledTimes(1);
    expectNoAuthorityCalls(port);
  });
});
