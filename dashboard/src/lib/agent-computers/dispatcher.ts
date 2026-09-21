import {
  AgentComputerCommandResultSchema,
  AgentComputerCommandSchema,
  AgentComputerSchema,
  type AgentComputer,
  type AgentComputerCommandAction,
  type AgentComputerCommand,
  type AgentComputerCommandResult,
  type AgentComputerSourceIdentity,
} from "./contracts";

export interface AgentComputerAuthorityInput {
  source: AgentComputerSourceIdentity;
  computerId: string;
  requestId: string;
  action: AgentComputerCommandAction;
}

export interface AgentComputerAuthority {
  provision(input: AgentComputerAuthorityInput): Promise<AgentComputerCommandResult>;
  start(input: AgentComputerAuthorityInput): Promise<AgentComputerCommandResult>;
  stop(input: AgentComputerAuthorityInput): Promise<AgentComputerCommandResult>;
  reboot(input: AgentComputerAuthorityInput): Promise<AgentComputerCommandResult>;
  delete(input: AgentComputerAuthorityInput): Promise<AgentComputerCommandResult>;
}

export interface AgentComputerAdapter {
  describe(): Promise<AgentComputer>;
  dispatch(command: AgentComputerCommand): Promise<AgentComputerCommandResult>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FALLBACK_REQUEST_ID = "invalid-request";

function safeRequestId(value: unknown): string {
  if (value === null || typeof value !== "object") return FALLBACK_REQUEST_ID;
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && SAFE_ID.test(requestId.trim())
    ? requestId.trim()
    : FALLBACK_REQUEST_ID;
}

function rejected(
  requestId: string,
  code: "INVALID_COMMAND" | "UNSUPPORTED_ACTION" | "AUTHORITY_ERROR"
): AgentComputerCommandResult {
  return AgentComputerCommandResultSchema.parse({
    ok: false,
    status: "rejected",
    requestId,
    code,
  });
}

async function invokeAuthority(
  authority: AgentComputerAuthority,
  input: AgentComputerAuthorityInput
): Promise<AgentComputerCommandResult> {
  try {
    let result: AgentComputerCommandResult;
    switch (input.action) {
      case "provision":
        result = await authority.provision(input);
        break;
      case "start":
        result = await authority.start(input);
        break;
      case "stop":
        result = await authority.stop(input);
        break;
      case "reboot":
        result = await authority.reboot(input);
        break;
      case "delete":
        result = await authority.delete(input);
        break;
      default:
        return rejected(input.requestId, "UNSUPPORTED_ACTION");
    }

    const parsedResult = AgentComputerCommandResultSchema.parse(result);
    if (parsedResult.requestId !== input.requestId) {
      return rejected(input.requestId, "AUTHORITY_ERROR");
    }

    return parsedResult;
  } catch {
    return rejected(input.requestId, "AUTHORITY_ERROR");
  }
}

export async function dispatchAgentComputerCommand({
  computer,
  command,
  authority,
}: {
  computer: unknown;
  command: unknown;
  authority: AgentComputerAuthority;
}): Promise<AgentComputerCommandResult> {
  let parsedComputer: AgentComputer;
  let parsedCommand: AgentComputerCommand;

  try {
    parsedComputer = AgentComputerSchema.parse(computer);
    parsedCommand = AgentComputerCommandSchema.parse(command);
  } catch {
    return rejected(safeRequestId(command), "INVALID_COMMAND");
  }

  if (parsedCommand.computerId !== parsedComputer.id) {
    return rejected(parsedCommand.requestId, "INVALID_COMMAND");
  }

  if (!parsedComputer.capabilities.actions.includes(parsedCommand.action)) {
    return rejected(parsedCommand.requestId, "UNSUPPORTED_ACTION");
  }

  return invokeAuthority(authority, {
    source: parsedComputer.source,
    computerId: parsedComputer.id,
    requestId: parsedCommand.requestId,
    action: parsedCommand.action,
  });
}

export function createAgentComputerAdapter({
  describe,
  authority,
}: {
  describe: () => AgentComputer | Promise<AgentComputer>;
  authority: AgentComputerAuthority;
}): AgentComputerAdapter {
  return {
    async describe() {
      return AgentComputerSchema.parse(await describe());
    },
    async dispatch(command) {
      let computer: AgentComputer;
      try {
        computer = await describe();
      } catch {
        return rejected(safeRequestId(command), "AUTHORITY_ERROR");
      }

      return dispatchAgentComputerCommand({
        computer,
        command,
        authority,
      });
    },
  };
}
