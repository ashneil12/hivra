/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

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

const fixture = { id: "ram-fixture", name: "Fixture", status: "stopped", lifecycle_state: "paused", paused_reason: "ram_cap_hit" as string | null, ram_limit: 2048, backend: "gateway", gateway_url: "https://fixture.invalid", provider: "hermes", api_key_preview: null, config: {}, created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z" };
let current = { ...fixture };

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  current = { ...fixture };
  global.fetch = jest.fn(async (_url, options) => ({ ok: true, json: async () => options?.method === "POST" ? { success: true } : { success: true, data: { ...current } } })) as jest.Mock;
});
afterEach(() => jest.useRealTimers());

it("renders the recorded cap, links to this instance's resources and starts only on request", async () => {
  await act(async () => { render(<InstancePage />); });
  expect(screen.getByTestId("instance-ram-cap-banner")).toHaveTextContent("2 GB memory allocation");
  expect(screen.getByText("Native interface")).toBeInTheDocument();
  expect((fetch as jest.Mock).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Review resources" }));
  expect(mockRouter.push).toHaveBeenCalledWith("/dashboard/instances/ram-fixture/console?tab=resources");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart anyway" })); });
  expect(fetch).toHaveBeenCalledWith("/api/instances/ram-fixture", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "start" }) }));
});

it("accepts refreshed allocation and pause reason even if updated_at is unchanged", async () => {
  current.ram_limit = 1024;
  await act(async () => { render(<InstancePage />); });
  expect(screen.getByTestId("instance-ram-cap-banner")).toHaveTextContent("1 GB memory allocation");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart anyway" })); });
  current.ram_limit = 2048;
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(screen.getByTestId("instance-ram-cap-banner")).toHaveTextContent("2 GB memory allocation");
  current.paused_reason = null;
  await act(async () => { jest.advanceTimersByTime(1700); });
  expect(screen.queryByTestId("instance-ram-cap-banner")).not.toBeInTheDocument();
});
