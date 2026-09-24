/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";

import { listAgentsResult } from "@/lib/hivra/agent-api";
import { clientLog } from "@/lib/client/logger";
import { useWorkspaceAgents } from "../useWorkspaceAgents";

jest.mock("@/lib/hivra/agent-api", () => ({
  listAgentsResult: jest.fn(),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    warn: jest.fn(),
  },
}));

const mockedListAgentsResult = jest.mocked(listAgentsResult);
const mockedWarn = jest.mocked(clientLog.warn);

function hermesEnvelope(data: unknown[]) {
  return { success: true, data };
}

function hivraResult(agents: unknown[], error: string | null = null) {
  return { agents, error };
}

function hermesRow(id: string, name = "Hermes") {
  return {
    id,
    name,
    status: "running",
    provider: "proxmox",
    model: "claude",
  };
}

function hivraRow(id: string, name = "Codex") {
  return {
    id,
    name,
    type: "codex",
    status: "running",
    cpu: 2,
    ram: 4,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useWorkspaceAgents", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps where each agent's computer runs, and drops placement values it does not know (ATT-11)", async () => {
    const { result } = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: async () => hermesEnvelope([]),
        fetchHivra: async () => hivraResult([
          { ...hivraRow("cloud"), computer_substrate: "provider-vm", deployment_mode: "self-managed" },
          { ...hivraRow("managed"), computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed" },
          { ...hivraRow("odd"), computer_substrate: "mainframe", deployment_mode: 7 },
        ]),
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const pairs = Object.fromEntries(result.current.agents.map((agent) => [agent.id, agent.computerPair?.placement]));
    // An unknown placement is not guessed as Hivra Cloud.
    expect(pairs).toEqual({ cloud: "My cloud", managed: "Hivra Cloud", odd: null });
    expect(result.current.hivraError).toBeNull();
  });

  describe("an agent added to one of the owner's computers (design 5.8)", () => {
    const COMPUTER = "11111111-1111-4111-8111-111111111111";
    const ATTACHMENT = "44444444-4444-4444-8444-444444444444";
    const attachedRow = (overrides: Record<string, unknown> = {}) => ({ id: ATTACHMENT, phase: "attached", agentName: "Codex",
      computerId: COMPUTER, computerName: "MY_UBUNTU_DESKTOP", computerStatus: "running", ...overrides });
    const withAttached = (attached: unknown) => async () => ({
      ...hivraResult([{ ...hivraRow(COMPUTER, "MY_UBUNTU_DESKTOP"), type: "linux-desktop" }, hivraRow("other", "Aardvark")]), attached });

    it("follows its computer in the shared list as a-<attachment id>, opening the computer's Chat tab", async () => {
      const { result } = renderHook(() => useWorkspaceAgents({ fetchHermes: async () => hermesEnvelope([]),
        fetchHivra: withAttached({ enabled: true, agents: [attachedRow()] }) }));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const uids = result.current.agents.map(({ uid }) => uid);
      expect(uids).toEqual(["x-other", `x-${COMPUTER}`, `a-${ATTACHMENT}`]);
      expect(result.current.agents[2]).toMatchObject({ kind: "hivra", id: COMPUTER, name: "Codex on MY_UBUNTU_DESKTOP",
        resourceKind: "agent", surfaceKind: "chat", agentType: "codex", typeLabel: "Codex", state: "running", statusRaw: "running",
        computerPair: null, href: `/dashboard/agent/${COMPUTER}?tab=chat`,
        attachment: { id: ATTACHMENT, computerId: COMPUTER, computerName: "MY_UBUNTU_DESKTOP", phase: "attached" } });
      expect(result.current.hivraError).toBeNull();
    });

    it("reads as starting while it is being added, and as its computer's state once added", async () => {
      const { result } = renderHook(() => useWorkspaceAgents({ fetchHermes: async () => hermesEnvelope([]),
        fetchHivra: withAttached({ enabled: true, agents: [attachedRow({ phase: "dispatched", computerStatus: "running" }),
          attachedRow({ id: "55555555-5555-4555-8555-555555555555", computerId: "66666666-6666-4666-8666-666666666666",
            computerName: "lab", computerStatus: "stopped" })] }) }));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const rows = result.current.agents.filter((agent) => agent.attachment);
      expect(rows.map((agent) => [agent.name, agent.state, agent.href])).toEqual([
        ["Codex on MY_UBUNTU_DESKTOP", "provisioning", `/dashboard/agent/${COMPUTER}?tab=manage`],
        ["Codex on lab", "stopped", "/dashboard/agent/66666666-6666-4666-8666-666666666666?tab=chat"],
      ]);
    });

    it("lists none where attach is not offered", async () => {
      const { result } = renderHook(() => useWorkspaceAgents({ fetchHermes: async () => hermesEnvelope([]),
        fetchHivra: withAttached({ enabled: false, agents: [] }) }));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.agents.some((agent) => agent.attachment)).toBe(false);
      expect(result.current.hivraError).toBeNull();
    });

    it.each([["unreadable", null], ["malformed", { enabled: true, agents: [{ ...attachedRow(), id: "not-a-uuid" }] }]])(
      "keeps the agents and computers and says the Hivra family couldn't all load when that list is %s", async (_label, attached) => {
        const { result } = renderHook(() => useWorkspaceAgents({ fetchHermes: async () => hermesEnvelope([]),
          fetchHivra: withAttached(attached) }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.agents.map(({ uid }) => uid)).toEqual(["x-other", `x-${COMPUTER}`]);
        expect(result.current.hivraError).toBe("Some agents and computers couldn't be loaded. Retry to check again.");
      });
  });

  it("combines successful families with stable source-qualified identities", async () => {
    const { result } = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: async () => hermesEnvelope([hermesRow("shared")]),
        fetchHivra: async () => hivraResult([hivraRow("shared")]),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents.map(({ uid }) => uid).sort()).toEqual([
      "h-shared",
      "x-shared",
    ]);
    expect(result.current.hermesError).toBeNull();
    expect(result.current.hivraError).toBeNull();
    expect(result.current.lastRefreshedAt).toEqual(expect.any(String));
  });

  it("preserves pending approval through the fetched workspace projection", async () => {
    const { result } = renderHook(() => useWorkspaceAgents({
      fetchHermes: async () => hermesEnvelope([{ ...hermesRow("waiting"), pendingPrompt: { promptId: "p1", kind: "approval", summary: "PRIVATE COMMAND" } }]),
      fetchHivra: async () => hivraResult([]),
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.agents[0].attention).toBe("approval");
    expect(JSON.stringify(result.current.agents)).not.toContain("PRIVATE COMMAND");
  });

  it("keeps Hivra agents usable when Hermes fails", async () => {
    const rawFailure = new Error("DO_NOT_RETURN_HERMES_PROVIDER_PAYLOAD");
    const { result } = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: async () => {
          throw rawFailure;
        },
        fetchHivra: async () => hivraResult([hivraRow("x-1")]),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents.map(({ uid }) => uid)).toEqual(["x-x-1"]);
    expect(result.current.hermesError).toBe("Some agents couldn't be loaded. Retry to check again.");
    expect(result.current.hivraError).toBeNull();
    expect(JSON.stringify(result.current)).not.toContain(rawFailure.message);
    expect(mockedWarn).toHaveBeenCalledWith(
      "Workspace agent source unavailable",
      expect.objectContaining({
        source: "workspace-agents",
        agentSource: "hermes",
        failureType: "workspace_hermes_source_failed",
      }),
    );
  });

  it("keeps Hermes agents usable when Hivra fails", async () => {
    const { result } = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: async () => hermesEnvelope([hermesRow("h-1")]),
        fetchHivra: async () => hivraResult([], "DO_NOT_RETURN_HIVRA_ERROR_BODY"),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents.map(({ uid }) => uid)).toEqual(["h-h-1"]);
    expect(result.current.hermesError).toBeNull();
    expect(result.current.hivraError).toBe("Some agents and computers couldn't be loaded. Retry to check again.");
    expect(JSON.stringify(result.current)).not.toContain("DO_NOT_RETURN_HIVRA_ERROR_BODY");
  });

  it("distinguishes both-empty from both-failed", async () => {
    const empty = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: async () => hermesEnvelope([]),
        fetchHivra: async () => hivraResult([]),
      }),
    );
    await waitFor(() => expect(empty.result.current.loading).toBe(false));

    expect(empty.result.current.agents).toEqual([]);
    expect(empty.result.current.hermesError).toBeNull();
    expect(empty.result.current.hivraError).toBeNull();
    empty.unmount();

    const failed = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: async () => {
          throw new Error("Hermes provider details");
        },
        fetchHivra: async () => {
          throw new Error("Hivra provider details");
        },
      }),
    );
    await waitFor(() => expect(failed.result.current.loading).toBe(false));

    expect(failed.result.current.agents).toEqual([]);
    expect(failed.result.current.hermesError).not.toBeNull();
    expect(failed.result.current.hivraError).not.toBeNull();
    failed.unmount();
  });

  it("keeps loading distinct from an empty account until both sources settle", async () => {
    const hermes = deferred<unknown>();
    const hivra = deferred<unknown>();
    const { result } = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: () => hermes.promise,
        fetchHivra: () => hivra.promise,
      }),
    );

    expect(result.current).toMatchObject({
      agents: [],
      loading: true,
      hermesError: null,
      hivraError: null,
      lastRefreshedAt: null,
    });

    await act(async () => {
      hermes.resolve(hermesEnvelope([]));
      hivra.resolve(hivraResult([]));
      await Promise.all([hermes.promise, hivra.promise]);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("retries only Hermes while preserving Hivra and replacing source rows", async () => {
    const hermesFetcher = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new Error("private provider failure"))
      .mockResolvedValueOnce(hermesEnvelope([hermesRow("same", "Recovered Hermes")]))
      .mockResolvedValueOnce(hermesEnvelope([hermesRow("same", "Refreshed Hermes")]));
    const hivraFetcher = jest.fn(async () => hivraResult([hivraRow("same")]));
    const timestamps = [
      new Date("2026-08-24T19:00:00.000Z"),
      new Date("2026-08-24T19:01:00.000Z"),
      new Date("2026-08-24T19:02:00.000Z"),
    ];
    const getNow = jest.fn(() => timestamps.shift() ?? new Date("2026-08-24T19:03:00.000Z"));
    const { result } = renderHook(() =>
      useWorkspaceAgents({ fetchHermes: hermesFetcher, fetchHivra: hivraFetcher, getNow }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents.map(({ uid }) => uid)).toEqual(["x-same"]);
    const firstRefresh = result.current.lastRefreshedAt;

    await act(async () => {
      await result.current.retryHermes();
    });

    expect(result.current.agents.map(({ uid }) => uid).sort()).toEqual(["h-same", "x-same"]);
    expect(result.current.hermesError).toBeNull();
    expect(result.current.lastRefreshedAt).not.toBe(firstRefresh);
    expect(hivraFetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.retryHermes();
    });

    expect(result.current.agents).toHaveLength(2);
    expect(result.current.agents.find(({ uid }) => uid === "h-same")?.name).toBe(
      "Refreshed Hermes",
    );
    expect(result.current.agents.filter(({ uid }) => uid === "x-same")).toHaveLength(1);
  });

  it("retries only Hivra without duplicating preserved Hermes rows", async () => {
    const hermesFetcher = jest.fn(async () => hermesEnvelope([hermesRow("same")]));
    const hivraFetcher = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new Error("private Hivra failure"))
      .mockResolvedValueOnce(hivraResult([hivraRow("same", "Recovered Codex")]));
    const { result } = renderHook(() =>
      useWorkspaceAgents({ fetchHermes: hermesFetcher, fetchHivra: hivraFetcher }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.retryHivra();
    });

    expect(result.current.agents.map(({ uid }) => uid).sort()).toEqual(["h-same", "x-same"]);
    expect(result.current.agents).toHaveLength(2);
    expect(hermesFetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the default authenticated source fetchers", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => hermesEnvelope([hermesRow("default-h")]),
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;
    global.fetch = fetchMock;
    mockedListAgentsResult.mockResolvedValue({
      agents: [hivraRow("default-x") as Awaited<ReturnType<typeof listAgentsResult>>["agents"][number]],
      error: null,
    });

    const { result } = renderHook(() => useWorkspaceAgents());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith("/api/instances?summary=true", {
      cache: "no-store",
    });
    expect(mockedListAgentsResult).toHaveBeenCalledTimes(1);
    expect(result.current.agents.map(({ uid }) => uid).sort()).toEqual([
      "h-default-h",
      "x-default-x",
    ]);
    global.fetch = originalFetch;
  });

  it("returns only public agent state when source rows contain secrets", async () => {
    const { result } = renderHook(() =>
      useWorkspaceAgents({
        fetchHermes: async () =>
          hermesEnvelope([
            {
              ...hermesRow("secret-h"),
              config: { token: "DO_NOT_SERIALIZE_SOURCE_TOKEN" },
              error: { provider: "DO_NOT_SERIALIZE_RAW_ERROR" },
            },
          ]),
        fetchHivra: async () =>
          hivraResult([
            {
              ...hivraRow("secret-x"),
              api_token: "DO_NOT_SERIALIZE_SOURCE_TOKEN",
              chat_url: "https://example.invalid/?token=DO_NOT_SERIALIZE_SOURCE_TOKEN",
              error: { provider: "DO_NOT_SERIALIZE_RAW_ERROR" },
            },
          ]),
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const serialized = JSON.stringify(result.current);
    expect(serialized).not.toContain("DO_NOT_SERIALIZE_SOURCE_TOKEN");
    expect(serialized).not.toContain("DO_NOT_SERIALIZE_RAW_ERROR");
    expect(serialized).not.toContain("api_token");
    expect(serialized).not.toContain("chat_url");
    expect(serialized).not.toContain("config");
  });
});
