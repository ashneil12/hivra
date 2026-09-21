import {
  AGENT_COMPUTER_CONTRACT_VERSION,
  AgentComputerCommandResultSchema,
  AgentComputerSchema,
  type AgentComputer,
  type AgentComputerAdapter,
  type AgentComputerAuthority,
  type AgentComputerAuthorityInput,
  createAgentComputerAdapter,
} from "../index";

const MANAGED_CREDENTIAL_SENTINEL = "DO_NOT_SERIALIZE_MANAGED_CREDENTIAL";
const SELF_HOSTED_CREDENTIAL_SENTINEL =
  "DO_NOT_SERIALIZE_SELF_HOSTED_CREDENTIAL";
const FORBIDDEN_KEYS = new Set([
  "token",
  "secret",
  "password",
  "apiKey",
  "privateKey",
  "honcho_api_key_encrypted",
  "config",
]);

type ConformanceFixture = {
  adapter: AgentComputerAdapter;
  authority: jest.Mocked<AgentComputerAuthority>;
  credentialSentinel: string;
  credentialResolver: jest.Mock;
};

function describedComputer(): AgentComputer {
  return {
    contractVersion: AGENT_COMPUTER_CONTRACT_VERSION,
    id: "h-conformance-1",
    name: "Conformance computer",
    source: { kind: "hermes", id: "conformance-1" },
    capabilities: {
      surfaces: ["workspace", "terminal"],
      actions: ["provision", "start"],
    },
    state: {
      desired: "running",
      observed: "stopped",
      health: "unknown",
      operation: null,
    },
    compatibility: { mode: "projected", sourceStatus: "stopped" },
  };
}

function assertPublicValueIsSecretSafe(
  value: unknown,
  credentialSentinel: string
): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(credentialSentinel);
  expect(serialized).not.toContain(MANAGED_CREDENTIAL_SENTINEL);
  expect(serialized).not.toContain(SELF_HOSTED_CREDENTIAL_SENTINEL);

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, nested] of Object.entries(node)) {
      expect(FORBIDDEN_KEYS).not.toContain(key);
      walk(nested);
    }
  }

  walk(value);
}

function makeManagedFixture(): ConformanceFixture {
  const resolveManagedCredential = jest.fn(async () => ({
    controlPlane: "managed" as const,
    apiToken: MANAGED_CREDENTIAL_SENTINEL,
  }));
  const accepted = async (
    input: AgentComputerAuthorityInput
  ): Promise<ReturnType<typeof AgentComputerCommandResultSchema.parse>> => {
    const credential = await resolveManagedCredential();
    if (credential.apiToken !== MANAGED_CREDENTIAL_SENTINEL) {
      throw new Error("missing managed credential fixture");
    }
    return AgentComputerCommandResultSchema.parse({
      ok: true,
      status: "accepted",
      requestId: input.requestId,
      operationId: `operation-${input.action}`,
    });
  };
  const unsupported = async (
    input: AgentComputerAuthorityInput
  ): Promise<ReturnType<typeof AgentComputerCommandResultSchema.parse>> =>
    AgentComputerCommandResultSchema.parse({
      ok: false,
      status: "rejected",
      requestId: input.requestId,
      code: "UNSUPPORTED_ACTION",
    });
  const authority: jest.Mocked<AgentComputerAuthority> = {
    provision: jest.fn(accepted),
    start: jest.fn(accepted),
    stop: jest.fn(unsupported),
    reboot: jest.fn(unsupported),
    delete: jest.fn(unsupported),
  };
  return {
    adapter: createAgentComputerAdapter({
      describe: describedComputer,
      authority,
    }),
    authority,
    credentialSentinel: MANAGED_CREDENTIAL_SENTINEL,
    credentialResolver: resolveManagedCredential,
  };
}

function makeSelfHostedFixture(): ConformanceFixture {
  const resolveSelfHostedCredential = jest.fn(async () => ({
    controlPlane: "self-hosted" as const,
    proxmoxApiToken: SELF_HOSTED_CREDENTIAL_SENTINEL,
  }));
  const accepted = async (
    input: AgentComputerAuthorityInput
  ): Promise<ReturnType<typeof AgentComputerCommandResultSchema.parse>> => {
    const credential = await resolveSelfHostedCredential();
    if (credential.proxmoxApiToken !== SELF_HOSTED_CREDENTIAL_SENTINEL) {
      throw new Error("missing self-hosted credential fixture");
    }
    return AgentComputerCommandResultSchema.parse({
      ok: true,
      status: "accepted",
      requestId: input.requestId,
      operationId: `operation-${input.action}`,
    });
  };
  const unsupported = async (
    input: AgentComputerAuthorityInput
  ): Promise<ReturnType<typeof AgentComputerCommandResultSchema.parse>> =>
    AgentComputerCommandResultSchema.parse({
      ok: false,
      status: "rejected",
      requestId: input.requestId,
      code: "UNSUPPORTED_ACTION",
    });
  const authority: jest.Mocked<AgentComputerAuthority> = {
    provision: jest.fn(accepted),
    start: jest.fn(accepted),
    stop: jest.fn(unsupported),
    reboot: jest.fn(unsupported),
    delete: jest.fn(unsupported),
  };
  return {
    adapter: createAgentComputerAdapter({
      describe: describedComputer,
      authority,
    }),
    authority,
    credentialSentinel: SELF_HOSTED_CREDENTIAL_SENTINEL,
    credentialResolver: resolveSelfHostedCredential,
  };
}

export function runAgentComputerAdapterConformance(
  name: string,
  makeAdapter: () => ConformanceFixture
): void {
  describe(`${name} agent-computer adapter interface parity`, () => {
    it("describes the same parsed, JSON-safe public computer", async () => {
      const { adapter, credentialSentinel } = makeAdapter();

      const described = await adapter.describe();
      const serialized = JSON.parse(JSON.stringify(described));

      expect(AgentComputerSchema.parse(serialized)).toEqual(describedComputer());
      assertPublicValueIsSecretSafe(serialized, credentialSentinel);
    });

    it("denies an unsupported action before any authority mutation", async () => {
      const { adapter, authority, credentialSentinel, credentialResolver } =
        makeAdapter();

      const result = await adapter.dispatch({
        computerId: "h-conformance-1",
        requestId: "request-delete",
        action: "delete",
      });

      expect(result).toEqual({
        ok: false,
        status: "rejected",
        requestId: "request-delete",
        code: "UNSUPPORTED_ACTION",
      });
      for (const method of Object.values(authority)) {
        expect(method).not.toHaveBeenCalled();
      }
      expect(credentialResolver).not.toHaveBeenCalled();
      assertPublicValueIsSecretSafe(result, credentialSentinel);
    });

    it.each(["provision", "start"] as const)(
      "delegates advertised %s exactly once with equivalent safe semantics",
      async (action) => {
        const { adapter, authority, credentialSentinel, credentialResolver } =
          makeAdapter();

        const result = await adapter.dispatch({
          computerId: "h-conformance-1",
          requestId: `request-${action}`,
          action,
        });

        expect(result).toEqual({
          ok: true,
          status: "accepted",
          requestId: `request-${action}`,
          operationId: `operation-${action}`,
        });
        expect(authority[action]).toHaveBeenCalledTimes(1);
        expect(authority[action]).toHaveBeenCalledWith({
          source: { kind: "hermes", id: "conformance-1" },
          computerId: "h-conformance-1",
          requestId: `request-${action}`,
          action,
        });
        for (const [otherAction, method] of Object.entries(authority)) {
          if (otherAction !== action) expect(method).not.toHaveBeenCalled();
        }
        expect(credentialResolver).toHaveBeenCalledTimes(1);
        assertPublicValueIsSecretSafe(result, credentialSentinel);
      }
    );
  });
}

// These fakes prove one public interface for both credential-ownership modes.
// They do not claim that a production self-hosted provider has been deployed.
runAgentComputerAdapterConformance("managed-style", makeManagedFixture);
runAgentComputerAdapterConformance("self-hosted-style", makeSelfHostedFixture);

describe("credential ownership fixture parity", () => {
  it("uses distinct private resolvers while emitting identical public values", async () => {
    const managed = makeManagedFixture();
    const selfHosted = makeSelfHostedFixture();

    const [managedDescription, selfHostedDescription] = await Promise.all([
      managed.adapter.describe(),
      selfHosted.adapter.describe(),
    ]);
    const [managedResult, selfHostedResult] = await Promise.all([
      managed.adapter.dispatch({
        computerId: "h-conformance-1",
        requestId: "request-parity",
        action: "start",
      }),
      selfHosted.adapter.dispatch({
        computerId: "h-conformance-1",
        requestId: "request-parity",
        action: "start",
      }),
    ]);

    expect(managed.credentialResolver).not.toBe(selfHosted.credentialResolver);
    expect(managed.credentialResolver).toHaveBeenCalledTimes(1);
    expect(selfHosted.credentialResolver).toHaveBeenCalledTimes(1);
    expect(managedDescription).toEqual(selfHostedDescription);
    expect(managedResult).toEqual(selfHostedResult);
    assertPublicValueIsSecretSafe(
      managedDescription,
      managed.credentialSentinel
    );
    assertPublicValueIsSecretSafe(
      selfHostedDescription,
      selfHosted.credentialSentinel
    );
    assertPublicValueIsSecretSafe(managedResult, managed.credentialSentinel);
    assertPublicValueIsSecretSafe(selfHostedResult, selfHosted.credentialSentinel);
  });
});
