/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";

import { clientLog } from "@/lib/client/logger";
import type { ReactNode } from "react";

import { resetResourceInventory, resourceInventory } from "@/lib/workspace/resource-inventory";
import { useWorkspaceAgents, WorkspaceOwnerContext } from "../useWorkspaceAgents";

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    warn: jest.fn(),
  },
}));

const mockedWarn = jest.mocked(clientLog.warn);

function hermesEnvelope(data: unknown[]) {
  return { success: true, data };
}

/** The /api/hivra/agents body: the agents, or the route's error envelope. */
function hivraResult(agents: unknown[], error: string | null = null) {
  return error === null ? { success: true, data: { agents } } : { success: false, error };
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
    resetResourceInventory();
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
    const fetchMock = jest.fn(async (url: string) => ({
      ok: true,
      json: async () => url === "/api/instances?summary=true"
        ? hermesEnvelope([hermesRow("default-h")])
        : hivraResult([hivraRow("default-x")]),
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;
    global.fetch = fetchMock;

    try {
      const { result } = renderHook(() => useWorkspaceAgents());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(fetchMock).toHaveBeenCalledWith("/api/instances?summary=true", expect.objectContaining({ cache: "no-store" }));
      expect(fetchMock).toHaveBeenCalledWith("/api/hivra/agents", expect.objectContaining({ cache: "no-store" }));
      expect(result.current.agents.map(({ uid }) => uid).sort()).toEqual([
        "h-default-h",
        "x-default-x",
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Home and the switcher under an agent's name read the same two lists. They
  // used to fetch them separately, so opening Home read each list twice.
  it("shares one read of each list between everything that shows it", async () => {
    const fetchMock = jest.fn(async (url: string) => ({
      ok: true,
      json: async () => url === "/api/instances?summary=true"
        ? hermesEnvelope([hermesRow("shared-h")])
        : hivraResult([hivraRow("shared-x")]),
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;
    global.fetch = fetchMock;

    try {
      const home = renderHook(() => useWorkspaceAgents());
      const switcher = renderHook(() => useWorkspaceAgents({ reuseHeldList: true }));
      await waitFor(() => expect(home.result.current.loading).toBe(false));
      await waitFor(() => expect(switcher.result.current.loading).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(switcher.result.current.agents.map(({ uid }) => uid).sort()).toEqual(["h-shared-h", "x-shared-x"]);

      // A menu opened inside the freshness window shows the held read at once.
      const menu = renderHook(() => useWorkspaceAgents({ reuseHeldList: true }));
      expect(menu.result.current.loading).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // An explicit retry reads again, and every reader sees the result.
      await act(async () => { await menu.result.current.retryHivra(); });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenLastCalledWith("/api/hivra/agents", expect.objectContaining({ cache: "no-store" }));
      expect(home.result.current.lastRefreshedAt).toBe(menu.result.current.lastRefreshedAt);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Home offers to continue in an agent. A list held from a moment ago can
  // still name one deleted since, so Home waits for a read made after it
  // opened, and two views opening together still share one.
  it("waits for a read made since it opened unless it may show the held list", async () => {
    let listed = [hivraRow("kept"), hivraRow("deleted")];
    const fetchMock = jest.fn(async (url: string) => ({
      ok: true,
      json: async () => url === "/api/instances?summary=true" ? hermesEnvelope([]) : hivraResult(listed),
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;
    global.fetch = fetchMock;

    try {
      const first = renderHook(() => useWorkspaceAgents());
      await waitFor(() => expect(first.result.current.loading).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(2);

      listed = [hivraRow("kept")];
      const home = renderHook(() => useWorkspaceAgents());
      expect(home.result.current.loading).toBe(true);
      await waitFor(() => expect(home.result.current.loading).toBe(false));
      expect(home.result.current.agents.map(({ uid }) => uid)).toEqual(["x-kept"]);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const together = [renderHook(() => useWorkspaceAgents()), renderHook(() => useWorkspaceAgents())];
      for (const view of together) await waitFor(() => expect(view.result.current.loading).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("reports only a current read's failure, not a held one's", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/hivra/agents") throw new Error("offline");
      return { ok: true, json: async () => hermesEnvelope([]) };
    }) as unknown as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;
    global.fetch = fetchMock;
    try {
      const first = renderHook(() => useWorkspaceAgents());
      await waitFor(() => expect(first.result.current.hivraError).not.toBeNull());

      fetchMock.mockImplementation(async (url) => ({
        ok: true,
        json: async () => url === "/api/instances?summary=true" ? hermesEnvelope([]) : hivraResult([hivraRow("back")]),
      }) as Response);
      const next = renderHook(() => useWorkspaceAgents());
      expect(next.result.current.hivraError).toBeNull();
      await waitFor(() => expect(next.result.current.loading).toBe(false));
      expect(next.result.current.hivraError).toBeNull();
      expect(next.result.current.agents.map(({ uid }) => uid)).toEqual(["x-back"]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Signing out and into another account need not reload the page, and the
  // lists are held between pages.
  it("never shows a list held for another account", async () => {
    const accountList = (name: string) => jest.fn(async (url: string) => ({
      ok: true,
      json: async () => url === "/api/instances?summary=true" ? hermesEnvelope([]) : hivraResult([hivraRow(name.toLowerCase(), name)]),
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;
    try {
      global.fetch = accountList("ACCOUNT_A_PROJECT");
      resourceInventory.setOwner("account-a");
      await act(async () => {
        await Promise.all([resourceInventory.load("hermes"), resourceInventory.load("hivra")]);
      });

      global.fetch = accountList("ACCOUNT_B_PROJECT");
      const seen: string[] = [];
      const wrapper = ({ children }: { children: ReactNode }) => (
        <WorkspaceOwnerContext.Provider value="account-b">{children}</WorkspaceOwnerContext.Provider>
      );
      const { result } = renderHook(() => {
        const value = useWorkspaceAgents({ reuseHeldList: true });
        seen.push(...value.agents.map((agent) => agent.name));
        return value;
      }, { wrapper });
      await waitFor(() => expect(result.current.agents.map((agent) => agent.name)).toEqual(["ACCOUNT_B_PROJECT"]));
      expect(seen).not.toContain("ACCOUNT_A_PROJECT");
      expect(resourceInventory.getSnapshot().owner).toBe("account-b");
    } finally {
      global.fetch = originalFetch;
    }
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
