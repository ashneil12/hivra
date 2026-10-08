/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HivraManage } from "../HivraManage";
import type { HivraAgent, PlanInfo } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { manageCapabilitiesFor, type ManageCapabilitiesContext } from "@/lib/hivra/manage-capabilities";

// Manage in sections: the server's map decides the sections, drafts survive
// switching between them, deep links open the right one, and what a computer
// can't do is said plainly instead of offered and refused.

const mockListAgentSnapshots = jest.fn();
const mockResizeAgent = jest.fn();
const mockRenameAgent = jest.fn();
const mockGetAgentEvents = jest.fn();
const mockStartAgent = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  listAgentSnapshots: (...args: unknown[]) => mockListAgentSnapshots(...args),
  resizeAgent: (...args: unknown[]) => mockResizeAgent(...args),
  renameAgent: (...args: unknown[]) => mockRenameAgent(...args),
  getAgentEvents: (...args: unknown[]) => mockGetAgentEvents(...args),
  startAgent: (...args: unknown[]) => mockStartAgent(...args),
  getProviderResizeState: () => new Promise(() => undefined),
  // Overview reads live usage; these tests are about sections, so it stays pending.
  getComputerUsage: () => new Promise(() => undefined),
  getBoxModel: async () => ({ model: null }),
  getBoxRestrict: async () => ({ restrict: "" }),
  listBoxMcp: async () => ({ servers: [] }),
  listBoxChatRuns: async () => null,
}));
jest.mock("@/lib/hivra/agent-model-settings-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-model-settings-api"),
  getAgentModelSettings: async () => ({ llm: null, pending: null }),
}));
jest.mock("@/lib/hivra/computer-contract-client", () => ({
  fetchComputerContract: async () => ({ kind: "not_started", channel: "proxmox-seed" }),
  runComputerContractAction: jest.fn(),
}));
jest.mock("@/components/instances/CookieImportModal", () => ({ CookieImportModal: () => null }));
jest.mock("../ToolInstallPicker", () => ({ ToolInstallPicker: () => <div>Tool picker</div> }));
jest.mock("../HivraPrivateAccessPanel", () => ({
  HivraPrivateAccessPanel: ({ onFeedbackChange }: { onFeedbackChange?: (feedback: { kind: "alert"; message: string } | null) => void }) => (
    <section id="private-access">
      Private access panel
      <button type="button" onClick={() => onFeedbackChange?.({ kind: "alert", message: "Private connection could not be verified" })}>Fail private access</button>
    </section>
  ),
}));
jest.mock("@/components/billing/UpgradePaywallModal", () => ({ UpgradePaywallModal: () => null }));

const plan: PlanInfo = { key: "command", name: "Command", subscribed: true, maxAgents: 8, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128, usage: { agentCount: 3, usedCpu: 10, usedRam: 20 } };
const codexRow = {
  id: "agent-a", name: "Builder", type: "codex", status: "running", cpu: 2, ram: 4,
  deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", desired_state: "running",
  infrastructure_binding_token_enforced: true, chat_url: "https://box.example.test", api_token: "fixture-token",
  vmid: 1130, ip: "10.250.20.31", proxmox_host: "fixturenode11", created_at: "2026-09-01T10:00:00.000Z",
};
const ubuntuRow = {
  ...codexRow, id: "computer-a", name: "Desk", type: "linux-desktop", computer_profile: "ubuntu-desktop",
};

/** What GET /api/hivra/agents/[id] sends: the public fields and the map. */
function served(row: Record<string, unknown>, ctx: Partial<ManageCapabilitiesContext> = {}): HivraAgent {
  const manage = manageCapabilitiesFor(row, { preparedMatch: true, ...ctx });
  const { infrastructure_binding_token_enforced: _binding, desired_state: _desired, ...visible } = row;
  void _binding; void _desired;
  return { ...(visible as unknown as HivraAgent), manage };
}

function renderManage(row: Record<string, unknown>, options: { ctx?: Partial<ManageCapabilitiesContext>; def?: string } = {}) {
  const props = { plan, browserOn: false, onChanged: jest.fn(), onDestroyed: jest.fn() };
  const def = getAgent(options.def ?? String(row.type));
  const view = render(<HivraManage agent={served(row, options.ctx)} def={def} {...props} />);
  return { ...view, props, rerenderRow: (next: Record<string, unknown>) => view.rerender(<HivraManage agent={served(next, options.ctx)} def={getAgent(String(next.type))} {...props} />) };
}

const openSection = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const selectedSection = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState(null, "", "/dashboard/agent/agent-a?tab=manage");
  mockListAgentSnapshots.mockResolvedValue({ snapshots: [], supported: true, maximum: 5 });
  mockResizeAgent.mockResolvedValue(undefined);
  mockRenameAgent.mockResolvedValue(undefined);
  mockStartAgent.mockResolvedValue(undefined);
  mockGetAgentEvents.mockResolvedValue([]);
});

describe("stage-1 truthfulness", () => {
  // Text anywhere in Manage, open section or not: none of these may appear.
  it("never shows a made-up EU region on a My server computer", () => {
    renderManage({ ...ubuntuRow, deployment_mode: "self-managed" });
    expect(screen.queryByText("EU")).not.toBeInTheDocument();
    expect(screen.queryByText("Region")).not.toBeInTheDocument();
  });

  it.each([
    ["a Hivra Cloud computer's private address", ubuntuRow, /10\.250\.20\.31/],
    ["a Windows computer on My server called a preview", { ...ubuntuRow, computer_profile: "windows", deployment_mode: "self-managed" }, /preview/i],
    ["the balloon floor", codexRow, /balloon/i],
  ])("never shows %s", (_case, row, text) => {
    renderManage(row, { ctx: { preparedMatch: false } });
    expect(document.body.textContent).not.toMatch(text);
  });

  it.each([
    ["a computer in the owner's own cloud", { ...ubuntuRow, computer_substrate: "provider-vm", deployment_mode: "self-managed" }],
    ["an agent", codexRow],
  ])("never shows private network enrollment for %s, which the server refuses", (_case, row) => {
    renderManage(row);
    expect(screen.queryByText("Private access panel")).not.toBeInTheDocument();
  });

  it("never offers restore points on an older unbound computer, where the server refuses them", async () => {
    renderManage({ ...codexRow, infrastructure_binding_token_enforced: false });
    await act(async () => undefined);
    expect(screen.queryByText("Create restore point")).not.toBeInTheDocument();
    expect(screen.queryByText("Same-host recovery")).not.toBeInTheDocument();
  });

  it("never offers Start, Stop or Restart for a Windows computer on My server, which the server refuses", () => {
    renderManage({ ...ubuntuRow, computer_profile: "windows", deployment_mode: "self-managed", status: "stopped" }, { ctx: { preparedMatch: false } });
    for (const name of ["Start", "Stop", "Restart"]) expect(screen.queryByRole("button", { name, hidden: true })).not.toBeInTheDocument();
  });

  it.each([
    ["Hivra Cloud", { deployment_mode: "hivra-managed" }],
    ["My server", { deployment_mode: "self-managed" }],
  ])("says the computer runs on %s, never a made-up EU region", (label, placement) => {
    renderManage({ ...ubuntuRow, ...placement });
    const overview = screen.getByRole("tabpanel", { name: "Overview" });
    expect(within(overview).getByText(label)).toBeVisible();
    expect(screen.queryByText("EU")).not.toBeInTheDocument();
    expect(screen.queryByText("Region")).not.toBeInTheDocument();
  });

  it("never shows a Hivra Cloud computer's private host-network address", () => {
    renderManage(ubuntuRow);
    openSection("Advanced");
    expect(document.body).not.toHaveTextContent("10.250.20.31");
    expect(document.body).not.toHaveTextContent("fixturenode11");
    expect(screen.getByText("VM ID (for support)")).toBeVisible();
  });

  it.each([
    ["My server", { deployment_mode: "self-managed" }, "Address on your host network"],
    ["My cloud", { deployment_mode: "self-managed", computer_substrate: "provider-vm", vmid: null }, "Server IP"],
  ])("shows the address on %s, where it is the owner's own network", (_where, placement, label) => {
    renderManage({ ...ubuntuRow, ...placement, ip: "192.0.2.10" });
    openSection("Advanced");
    const row = screen.getByText(label).closest("div")!;
    expect(row).toHaveTextContent("192.0.2.10");
  });

  it("tells an older unbound computer why it has no restore points instead of offering them", async () => {
    renderManage({ ...codexRow, infrastructure_binding_token_enforced: false });
    openSection("Advanced");
    expect(screen.getByText("Restore points aren't available for this computer. It was created before Hivra recorded ownership checks.")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Recovery" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create restore point" })).not.toBeInTheDocument();
    await act(async () => undefined);
    expect(mockListAgentSnapshots).not.toHaveBeenCalled();
  });

  it("does not call a Windows computer on My server a prepared preview, and says why its power controls are off", () => {
    renderManage({ ...ubuntuRow, computer_profile: "windows", deployment_mode: "self-managed", cpu: 4, ram: 8 }, { ctx: { preparedMatch: false } });
    expect(document.body).not.toHaveTextContent(/preview/i);
    const overview = screen.getByRole("tabpanel", { name: "Overview" });
    expect(within(overview).getByText(/Hivra can't start, stop or restart a Windows computer on your own server yet/)).toBeVisible();
    for (const name of ["Start", "Stop", "Restart"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    // Nor does it explain buttons that aren't there.
    expect(overview).not.toHaveTextContent(/Stop shuts down the computer/);
    openSection("Resources");
    expect(screen.getByTestId("manage-fixed-size")).toHaveTextContent("Hivra can't resize Windows computers yet.");
  });

  it("says a prepared Windows computer has a fixed size, with its real size", () => {
    renderManage({ ...ubuntuRow, computer_profile: "windows", cpu: 4, ram: 8, managed_provisioner_channel: "canary" });
    openSection("Resources");
    expect(screen.getByTestId("manage-fixed-size")).toHaveTextContent("This Windows preview has a fixed size of 4 CPU / 8 GB.");
  });

  it("describes reserved memory as guaranteed, in plain words", () => {
    renderManage(codexRow);
    openSection("Resources");
    expect(screen.getByText(/Reserved memory is guaranteed to this computer/)).toBeVisible();
    expect(document.body).not.toHaveTextContent(/balloon/i);
  });

  it("keeps Manage and Delete reachable while a computer is still being set up", () => {
    renderManage({ ...ubuntuRow, status: "provisioning", operation_id: "op-1", operation_kind: "provision", activity: "provision", provisioned_at: null });
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    openSection("Advanced");
    expect(screen.getByRole("button", { name: "Destroy" })).toBeEnabled();
  });
});

describe("sections", () => {
  it("keeps a resize selection, an MCP name and a rename draft while switching sections", async () => {
    renderManage(codexRow);
    openSection("Resources");
    fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    // Unsaved: a dot on the tab and a spoken description.
    expect(screen.getByRole("tab", { name: "Resources" })).toHaveAccessibleDescription("Resources has unsaved changes");

    openSection("Model & tools");
    fireEvent.change(await screen.findByRole("textbox", { name: "MCP server name" }), { target: { value: "github" } });
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed draft" } });

    openSection("Overview");
    openSection("Resources");
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" })).toHaveAttribute("aria-pressed", "true");
    openSection("Model & tools");
    expect(screen.getByRole("textbox", { name: "MCP server name" })).toHaveValue("github");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Renamed draft");
  });

  it("starts another computer from its own drafts and an unarmed danger zone", () => {
    const view = renderManage(codexRow);
    openSection("Resources");
    fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    openSection("Advanced");
    fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));

    view.rerenderRow({ ...codexRow, id: "agent-b", name: "Other" });
    openSection("Advanced");
    expect(screen.getByRole("button", { name: "Destroy" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Permanently destroy" })).not.toBeInTheDocument();
    openSection("Resources");
    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "2 CPU" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an error from a section that isn't open, with a way to open it", async () => {
    mockResizeAgent.mockRejectedValue(new Error("The host has no spare capacity."));
    renderManage(codexRow);
    openSection("Resources");
    fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    fireEvent.click(screen.getByRole("button", { name: /Apply · 4 CPU/ }));
    await screen.findByRole("alert");
    openSection("Overview");
    expect(screen.getByRole("alert")).toHaveTextContent("The host has no spare capacity.");
    fireEvent.click(screen.getByRole("button", { name: "Open Resources" }));
    expect(selectedSection()).toBe("Resources");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open Resources" })).not.toBeInTheDocument();
  });

  it("shows a private network failure while another section is open, and opens it", () => {
    renderManage(ubuntuRow);
    openSection("Private network");
    fireEvent.click(screen.getByRole("button", { name: "Fail private access" }));
    expect(screen.queryByRole("button", { name: "Open Private network" })).not.toBeInTheDocument();
    openSection("Overview");
    expect(screen.getByRole("alert")).toHaveTextContent("Private connection could not be verified");
    fireEvent.click(screen.getByRole("button", { name: "Open Private network" }));
    expect(selectedSection()).toBe("Private network");
    expect(screen.queryByRole("button", { name: "Open Private network" })).not.toBeInTheDocument();
  });

  // Regression: opening a section from a link, a banner or a chip left focus
  // on a control that was now hidden (or gone), and nothing was announced.
  it("moves focus into Resources when See resources opens it", () => {
    renderManage(codexRow);
    const seeResources = screen.getByRole("button", { name: "See resources" });
    seeResources.focus();
    fireEvent.click(seeResources);
    expect(selectedSection()).toBe("Resources");
    const panel = screen.getByRole("tabpanel", { name: "Resources" });
    expect(panel).toBeVisible();
    expect(panel).toHaveFocus();
  });

  it("moves focus into the section a banner opens", () => {
    renderManage(ubuntuRow);
    openSection("Private network");
    fireEvent.click(screen.getByRole("button", { name: "Fail private access" }));
    openSection("Overview");
    const open = screen.getByRole("button", { name: "Open Private network" });
    open.focus();
    fireEvent.click(open);
    const panel = screen.getByRole("tabpanel", { name: "Private network" });
    expect(panel).toBeVisible();
    expect(panel).toHaveFocus();
    expect(document.activeElement?.closest("[hidden]")).toBeNull();
  });

  it("keeps focus on the section tab when the tabs are used", () => {
    renderManage(codexRow);
    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    expect(screen.getByRole("tab", { name: "Resources" })).toHaveFocus();
  });

  it("moves between sections with the arrow keys, Home and End", () => {
    renderManage(codexRow);
    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(selectedSection()).toBe("Model & tools");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Model & tools" }), { key: "End" });
    expect(selectedSection()).toBe("Advanced");
    expect(screen.getByRole("tab", { name: "Advanced" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Advanced" }), { key: "Home" });
    expect(selectedSection()).toBe("Overview");
  });

  it("renames from the header: Enter saves, Escape cancels", async () => {
    renderManage(ubuntuRow);
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Ignored" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(mockRenameAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "  Studio  " } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" });
    await waitFor(() => expect(mockRenameAgent).toHaveBeenCalledWith("computer-a", "Studio"));
  });

  it("lists the computer's history under Advanced, loading it only once Advanced opens", async () => {
    mockGetAgentEvents.mockResolvedValue([
      { event: "runtime_updated", createdAt: "2026-09-24T10:00:00.000Z", label: "Connection service updated" },
      { event: "restarted", createdAt: "2026-09-23T10:00:00.000Z", label: "Restarted" },
    ]);
    renderManage(ubuntuRow);
    await act(async () => undefined);
    expect(mockGetAgentEvents).not.toHaveBeenCalled();
    openSection("Advanced");
    expect(await screen.findByText("Connection service updated")).toBeVisible();
    expect(screen.getByText("Restarted")).toBeVisible();
    expect(mockGetAgentEvents).toHaveBeenCalledWith("computer-a", expect.any(AbortSignal));
  });
});

describe("deep links", () => {
  const cases: Array<[string, string, string]> = [
    ["?tab=manage&section=resources", "Resources", ""],
    ["?tab=manage#resources", "Resources", "resources"],
    ["?tab=manage#model-settings", "Model & tools", "model-settings"],
    ["?tab=manage&tools=1", "Model & tools", ""],
    ["?tab=manage&section=advanced#danger", "Advanced", "danger"],
  ];
  it.each(cases)("%s opens %s", async (query, section, anchor) => {
    window.history.replaceState(null, "", `/dashboard/agent/agent-a${query}`);
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
    try {
      renderManage(codexRow);
      expect(selectedSection()).toBe(section);
      if (anchor) await waitFor(() => expect(scrolled).toContain(anchor));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("opens Private network from the older #private-access link on a computer that has one", () => {
    window.history.replaceState(null, "", "/dashboard/agent/computer-a?tab=manage#private-access");
    renderManage(ubuntuRow);
    expect(selectedSection()).toBe("Private network");
  });

  it.each([
    ["an unknown section", "?tab=manage&section=bogus"],
    ["a section this computer doesn't have", "?tab=manage&section=network"],
  ])("falls back to Overview for %s and removes it from the address", (_case, query) => {
    window.history.replaceState(null, "", `/dashboard/agent/agent-a${query}`);
    renderManage(codexRow);
    expect(selectedSection()).toBe("Overview");
    expect(new URLSearchParams(window.location.search).get("section")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("manage");
  });

  it("records the open section in the address without adding a Back entry, and follows Back and Forward", () => {
    renderManage(codexRow);
    const entries = window.history.length;
    openSection("Resources");
    expect(new URLSearchParams(window.location.search).get("section")).toBe("resources");
    expect(window.history.length).toBe(entries);
    act(() => {
      window.history.replaceState(null, "", "/dashboard/agent/agent-a?tab=manage&section=recovery");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(selectedSection()).toBe("Recovery");
  });
});
