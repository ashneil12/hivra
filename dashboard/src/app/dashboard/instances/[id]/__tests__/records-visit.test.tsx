/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";

const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockSearch = { get: () => null };
jest.mock("next/navigation", () => ({ useParams: () => ({ id: "ram-fixture" }), useRouter: () => mockRouter, useSearchParams: () => mockSearch }));
jest.mock("posthog-js", () => ({ capture: jest.fn() }));
jest.mock("@/lib/telemetry/posthog-client", () => ({ captureClient: jest.fn() }));
jest.mock("@/lib/client/logger", () => ({ clientLog: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/components/ShellTerminalWorkspace", () => ({ ShellTerminalWorkspace: () => null }));
jest.mock("@/components/TerminalPanel", () => ({ TerminalPanel: () => null }));
jest.mock("@/components/console/CodexOAuthModal", () => ({ CodexOAuthModal: () => null }));
jest.mock("@/components/explorer/FileExplorer", () => ({ FileExplorer: () => null }));
jest.mock("@/components/instances/AgentSwitcher", () => ({ AgentSwitcher: () => null }));
jest.mock("@/components/ui/SafePortal", () => ({ SafePortal: () => null }));
jest.mock("@/components/support/ReportProblemLink", () => ({ ReportProblemLink: () => null }));
jest.mock("@/components/webui/WebuiIframe", () => ({ WebuiIframe: () => <div>Native interface</div> }));
jest.mock("@/components/instances/InstanceTelegramConnect", () => ({ InstanceTelegramConnect: () => null }));
jest.mock("@/components/instances/InstanceChannelsPanel", () => ({ InstanceChannelsPanel: () => null }));
jest.mock("@/components/instances/CommandPanel", () => ({ CommandPanel: () => null }));
jest.mock("@/components/storage/StorageUsageBanner", () => ({ StorageUsageBanner: () => null }));
jest.mock("@/components/billing/SleepWakeUpgradePrompt", () => ({ SleepWakeUpgradePrompt: () => null }));
jest.mock("@/components/billing/ArchiveUpgradeWall", () => ({ ArchiveUpgradeWall: () => null }));
jest.mock("@/lib/hivra/agent-api", () => ({ fetchPlanStrict: jest.fn().mockResolvedValue(null), isFreePlanInfo: () => false }));

import InstancePage from "../page";
import { listRecents } from "@/lib/workspace/recents";
import { resetResourceInventory, resourceInventory } from "@/lib/workspace/resource-inventory";

const fixture = { id: "ram-fixture", name: "Fixture", status: "running", lifecycle_state: "active", paused_reason: null, ram_limit: 2048, backend: "gateway", gateway_url: "https://fixture.invalid", provider: "hermes", api_key_preview: null, config: {}, created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z" };

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

// Hermes agents are resources you work in too, so opening one has to be
// something Home can offer back and the switchers can list under Recent.
it("remembers a Hermes agent once it has opened, on its chat", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { ...fixture } }) })) as jest.Mock;
  await act(async () => { render(<InstancePage />); });
  expect(screen.getByText("Native interface")).toBeInTheDocument();
  expect(listRecents()).toEqual([{ uid: "h-ram-fixture", tab: "chat", usedAt: expect.any(Number) }]);
});

it("remembers nothing for an agent that did not load", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: false, error: "Something went wrong" }) })) as jest.Mock;
  await act(async () => { render(<InstancePage />); });
  expect(listRecents()).toEqual([]);
});

// The sidebar, ⌘K and Home reuse a list of agents read in the last few
// seconds. A start, stop or redeploy made here changes it, so it is read again.
it("reads the agents list again after a lifecycle action on the agent", async () => {
  let listReads = 0;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/instances?summary=true") {
      listReads += 1;
      return { ok: true, json: async () => ({ success: true, data: [{ id: "ram-fixture", name: "Fixture", status: listReads > 1 ? "redeploying" : "running" }] }) };
    }
    if (init?.method === "POST") return { ok: true, json: async () => ({ success: true }) };
    return { ok: true, json: async () => ({ success: true, data: { ...fixture } }) };
  }) as jest.Mock;
  resetResourceInventory();
  await act(async () => { await resourceInventory.load("hermes"); });
  // The sidebar is showing the list.
  const stopShowing = resourceInventory.subscribe(() => undefined);
  try {
    await act(async () => { render(<InstancePage />); });
    expect(listReads).toBe(1);
    await act(async () => { window.dispatchEvent(new Event("hermes-redeploy-trigger")); });
    await waitFor(() => expect(listReads).toBe(2));
    expect(resourceInventory.getSnapshot().hermes.body).toEqual({ success: true, data: [expect.objectContaining({ status: "redeploying" })] });
  } finally {
    stopShowing();
    resetResourceInventory();
  }
});
