/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HivraManage } from "../HivraManage";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";

const mockProviderRead = jest.fn();
const mockModelRead = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  getProviderResizeState: (...args: unknown[]) => mockProviderRead(...args),
  getBoxModel: async () => ({ model: null }),
  getBoxRestrict: async () => ({ restrict: "" }),
  listBoxMcp: async () => ({ servers: [] }),
}));
jest.mock("@/lib/hivra/agent-model-settings-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-model-settings-api"),
  getAgentModelSettings: (...args: unknown[]) => mockModelRead(...args),
}));
const agent: HivraAgent = { id: "computer-a", name: "Computer A", type: "codex", status: "running", cpu: 2, ram: 4, deployment_mode: "self-managed" };
const props = { onChanged: jest.fn(), onDestroyed: jest.fn(), browserOn: false };
const originalFetch = global.fetch;
const mockFetch = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState(null, "", "?tab=manage");
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { supported: true, pending: false, connection: null } }) });
  mockModelRead.mockResolvedValue({ llm: null, pending: null });
  global.fetch = mockFetch;
});
afterAll(() => { global.fetch = originalFetch; });

it("keeps a real private-access mutation error visible after changing sections without duplicating its alert", async () => {
  let finish!: (value: unknown) => void;
  render(<HivraManage agent={agent} {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "Access" }));
  await waitFor(() => expect(screen.queryByLabelText("Loading private access")).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("One-time enrollment key"), { target: { value: "synthetic-fixture" } });
  mockFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Connect private network" }));
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  expect(screen.getByRole("status")).toHaveTextContent("Updating private access");
  await act(async () => finish({ ok: false, json: async () => ({ success: false, error: "Private connection could not be verified" }) }));
  expect(screen.getByRole("alert")).toHaveTextContent("Private connection could not be verified");
  fireEvent.click(screen.getByRole("button", { name: "Open Access" }));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Open Access" })).not.toBeInTheDocument();
});

it("keeps persisted provider polling visible outside Resources", async () => {
  mockProviderRead.mockResolvedValue({ catalog: null, operation: {
    operationId: "operation", stage: "provider_pending", message: "Waiting for the provider to verify the saved resize.",
    quote: { source: { serverType: "cpx22" }, target: { serverType: "cpx32" }, existingDiskGb: 80 },
  } });
  render(<HivraManage agent={{ ...agent, computer_substrate: "provider-vm" }} {...props} />);
  expect(await screen.findByRole("status")).toHaveTextContent("Waiting for the provider");
  fireEvent.click(screen.getByRole("button", { name: "Open Resources" }));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Open Resources" })).not.toBeInTheDocument();
});

it("reports pending model connections outside Agent settings", async () => {
  mockModelRead.mockResolvedValue({ llm: null, pending: { operationId: "operation", requested: { provider: "venice", mode: "byok", model: "fixture-model" }, applying: false } });
  render(<HivraManage agent={agent} def={getAgent("codex")} {...props} />);
  expect(await screen.findByRole("status")).toHaveTextContent("A model connection is pending");
  fireEvent.click(screen.getByRole("button", { name: "Open Agent settings" }));
  expect(screen.getByText("Pending change")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Open Agent settings" })).not.toBeInTheDocument();
});

it.each(["model-settings", "private-access"])("reveals and scrolls to the legacy #%s child on load and history changes", async fragment => {
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  const scrolled: string[] = [];
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  try {
    window.history.replaceState(null, "", `?tab=manage#${fragment}`);
    render(<HivraManage agent={agent} def={getAgent("codex")} {...props} />);
    const section = fragment === "model-settings" ? "Agent settings" : "Access";
    expect(screen.getByRole("tabpanel", { name: section })).toBeVisible();
    await waitFor(() => expect(scrolled).toContain(fragment));
    expect(window.location.hash).toBe(`#${fragment}`);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    scrolled.length = 0;
    act(() => { window.history.replaceState(null, "", `?tab=manage#${fragment}`); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(screen.getByRole("tabpanel", { name: section })).toBeVisible();
    await waitFor(() => expect(scrolled).toContain(fragment));
  } finally { HTMLElement.prototype.scrollIntoView = originalScroll; }
});

it("resets credentials and deletion confirmation when the selected computer changes", async () => {
  const view = render(<HivraManage agent={agent} {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "Access" }));
  await waitFor(() => expect(screen.queryByLabelText("Loading private access")).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("One-time enrollment key"), { target: { value: "synthetic-secret-for-a" } });
  fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  fireEvent.change(screen.getByPlaceholderText("Computer A"), { target: { value: "Computer A" } });
  view.rerender(<HivraManage agent={{ ...agent, id: "computer-b", name: "Computer B" }} {...props} />);
  expect(screen.getByRole("button", { name: "Destroy" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Permanently destroy" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Access" }));
  expect(screen.getByLabelText("One-time enrollment key")).toHaveValue("");
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/hivra/agents/computer-b/private-access/tailscale", expect.any(Object)));
});
