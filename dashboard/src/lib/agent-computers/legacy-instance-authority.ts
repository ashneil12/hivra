import {
  AgentComputerCommandResultSchema,
  type AgentComputerCommandResult,
} from "./contracts";
import type {
  AgentComputerAuthority,
  AgentComputerAuthorityInput,
} from "./dispatcher";

export type LegacyCreateInstance<TParams, TResult> = (
  userId: string,
  params: TParams
) => Promise<TResult>;

type ProvisionRequest<TParams> = {
  userId: string;
  params: TParams;
};

export function createLegacyInstanceAuthority<TParams, TResult>({
  createInstance,
  resolveProvisionRequest,
  translateProvisionResult,
  unsupportedLifecycleResult,
}: {
  createInstance: LegacyCreateInstance<TParams, TResult>;
  resolveProvisionRequest: (
    input: AgentComputerAuthorityInput
  ) => ProvisionRequest<TParams> | Promise<ProvisionRequest<TParams>>;
  translateProvisionResult: (
    result: TResult,
    input: AgentComputerAuthorityInput
  ) => unknown | Promise<unknown>;
  unsupportedLifecycleResult: (
    input: AgentComputerAuthorityInput
  ) => unknown | Promise<unknown>;
}): AgentComputerAuthority {
  const lifecycleUnsupported = async (
    input: AgentComputerAuthorityInput
  ): Promise<AgentComputerCommandResult> =>
    AgentComputerCommandResultSchema.parse(
      await unsupportedLifecycleResult(input)
    );

  return {
    async provision(input) {
      const request = await resolveProvisionRequest(input);
      const result = await createInstance(request.userId, request.params);
      return AgentComputerCommandResultSchema.parse(
        await translateProvisionResult(result, input)
      );
    },
    start: lifecycleUnsupported,
    stop: lifecycleUnsupported,
    reboot: lifecycleUnsupported,
    delete: lifecycleUnsupported,
  };
}
