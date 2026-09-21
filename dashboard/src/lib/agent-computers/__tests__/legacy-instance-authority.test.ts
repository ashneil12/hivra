import type { InstanceService } from "@/lib/services/instance-service";
import type { AgentComputerCommandResult } from "../contracts";
import type { AgentComputerAuthorityInput } from "../dispatcher";
import {
  createLegacyInstanceAuthority,
  type LegacyCreateInstance,
} from "../legacy-instance-authority";

const SECRET_SENTINEL = "DO_NOT_SERIALIZE_LEGACY_AUTHORITY_SECRET";

type ExistingCreateInstance = typeof InstanceService.createInstance;
type ExistingCreateParams = Parameters<ExistingCreateInstance>[1];
type ExistingCreateResult = Awaited<ReturnType<ExistingCreateInstance>>;
type ExistingShapeIsAssignable = ExistingCreateInstance extends LegacyCreateInstance<
  ExistingCreateParams,
  ExistingCreateResult
>
  ? true
  : false;

// Compile-time tripwire only: no real InstanceService method is executed here.
const existingCreateInstanceShapeIsAssignable: ExistingShapeIsAssignable = true;
void existingCreateInstanceShapeIsAssignable;

type TestParams = { name: string; provider: string };
type TestServiceResult =
  | { success: true; data: { id: string }; providerSecret: string }
  | { success: false; status: number; message: string; providerSecret: string };

function input(
  action: AgentComputerAuthorityInput["action"] = "provision"
): AgentComputerAuthorityInput {
  return {
    source: { kind: "hermes", id: "instance-source-1" },
    computerId: "h-instance-source-1",
    requestId: `request-${action}`,
    action,
  };
}

function unsupported(
  authorityInput: AgentComputerAuthorityInput
): AgentComputerCommandResult {
  return {
    ok: false,
    status: "rejected",
    requestId: authorityInput.requestId,
    code: "UNSUPPORTED_ACTION",
  };
}

describe("createLegacyInstanceAuthority", () => {
  it("resolves the server-owned request once and delegates to createInstance exactly once", async () => {
    const createInstance: jest.MockedFunction<
      LegacyCreateInstance<TestParams, TestServiceResult>
    > = jest.fn().mockResolvedValue({
      success: true,
      data: { id: "instance-created-1" },
      providerSecret: SECRET_SENTINEL,
    });
    const resolveProvisionRequest = jest.fn().mockResolvedValue({
      userId: "user-server-resolved",
      params: { name: "Codex", provider: "openrouter" },
    });
    const translateProvisionResult = jest.fn(
      (_result: TestServiceResult, authorityInput: AgentComputerAuthorityInput) => ({
        ok: true,
        status: "accepted",
        requestId: authorityInput.requestId,
        operationId: "instance-created-1",
      })
    );
    const authority = createLegacyInstanceAuthority({
      createInstance,
      resolveProvisionRequest,
      translateProvisionResult,
      unsupportedLifecycleResult: unsupported,
    });

    const result = await authority.provision(input());

    expect(resolveProvisionRequest).toHaveBeenCalledTimes(1);
    expect(resolveProvisionRequest).toHaveBeenCalledWith(input());
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(createInstance).toHaveBeenCalledWith("user-server-resolved", {
      name: "Codex",
      provider: "openrouter",
    });
    expect(translateProvisionResult).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      requestId: "request-provision",
      operationId: "instance-created-1",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it("translates a secret-bearing service failure into a safe public rejection", async () => {
    const createInstance: LegacyCreateInstance<TestParams, TestServiceResult> = jest
      .fn()
      .mockResolvedValue({
        success: false,
        status: 503,
        message: `provider failed: ${SECRET_SENTINEL}`,
        providerSecret: SECRET_SENTINEL,
      });
    const authority = createLegacyInstanceAuthority({
      createInstance,
      resolveProvisionRequest: () => ({
        userId: "user-1",
        params: { name: "Codex", provider: "openrouter" },
      }),
      translateProvisionResult: (
        result: TestServiceResult,
        authorityInput: AgentComputerAuthorityInput
      ) =>
        result.success
          ? {
              ok: true,
              status: "accepted",
              requestId: authorityInput.requestId,
            }
          : {
              ok: false,
              status: "rejected",
              requestId: authorityInput.requestId,
              code: "AUTHORITY_ERROR",
            },
      unsupportedLifecycleResult: unsupported,
    });

    const result = await authority.provision(input());

    expect(result).toEqual({
      ok: false,
      status: "rejected",
      requestId: "request-provision",
      code: "AUTHORITY_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it("rejects translator output that attempts to expose raw service fields", async () => {
    const createInstance: LegacyCreateInstance<TestParams, TestServiceResult> = jest
      .fn()
      .mockResolvedValue({
        success: true,
        data: { id: "instance-created-2" },
        providerSecret: SECRET_SENTINEL,
      });
    const authority = createLegacyInstanceAuthority({
      createInstance,
      resolveProvisionRequest: () => ({
        userId: "user-2",
        params: { name: "Codex", provider: "openrouter" },
      }),
      translateProvisionResult: (_result, authorityInput) => ({
        ok: true,
        status: "accepted",
        requestId: authorityInput.requestId,
        providerSecret: SECRET_SENTINEL,
      }),
      unsupportedLifecycleResult: unsupported,
    });

    await expect(authority.provision(input())).rejects.toThrow();
    expect(createInstance).toHaveBeenCalledTimes(1);
  });

  it.each(["start", "stop", "reboot", "delete"] as const)(
    "returns the injected safe unsupported result for %s without creating an instance",
    async (action) => {
      const createInstance: jest.MockedFunction<
        LegacyCreateInstance<TestParams, TestServiceResult>
      > = jest.fn();
      const unsupportedLifecycleResult = jest.fn(unsupported);
      const authority = createLegacyInstanceAuthority({
        createInstance,
        resolveProvisionRequest: () => ({
          userId: "user-unused",
          params: { name: "Unused", provider: "unused" },
        }),
        translateProvisionResult: () => {
          throw new Error("translation must not run");
        },
        unsupportedLifecycleResult,
      });

      const result = await authority[action](input(action));

      expect(result).toEqual(unsupported(input(action)));
      expect(unsupportedLifecycleResult).toHaveBeenCalledTimes(1);
      expect(createInstance).not.toHaveBeenCalled();
    }
  );
});
