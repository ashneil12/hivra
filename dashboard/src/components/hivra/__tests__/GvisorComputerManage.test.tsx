/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GvisorComputerManage } from "../GvisorComputerManage";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";

const row = {
  id: "11111111-1111-4111-8111-111111111111", name: "SANDBOX", type: "linux-desktop", status: "running", cpu: 1, ram: 2,
  computer_substrate: "gvisor", computer_profile: "linux-terminal", deployment_mode: "self-managed",
} as const;
const agent: HivraAgent = { ...row, manage: manageCapabilitiesFor(row, { preparedMatch: false }) };
const mockFetch = jest.fn();
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard/agent/sandbox?tab=manage");
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => String(url).endsWith("/gvisor")
    ? jsonResponse({ success: true, data: { observation: { state: "running" } } })
    : String(url).endsWith("/events")
      ? jsonResponse({ success: true, data: { events: [] } })
      : jsonResponse({ success: true, data: {} }));
  global.fetch = mockFetch;
});
afterEach(() => jest.restoreAllMocks());

const actionCalls = (action: string) => mockFetch.mock.calls.filter(([, init]) => init?.body && JSON.parse(init.body).action === action);
const openSection = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

function armDestroy() {
  openSection("Advanced");
  fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand this is irreversible/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Type SANDBOX to confirm" }), { target: { value: "SANDBOX" } });
}

it("uses the shared Manage sections for a Linux Sandbox", async () => {
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Overview", "Resources", "Run a command", "Advanced"]);
  expect(screen.getByText("Linux Sandbox · My server")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled());
});

it("puts Cancel in the Destroy position and ignores a confirm tap that arrives with the reveal", async () => {
  let now = 10_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const onDestroyed = jest.fn();
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={onDestroyed} />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());

  armDestroy();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  const confirm = screen.getByRole("button", { name: "Permanently destroy" });
  expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  now += 150;
  fireEvent.click(confirm);
  expect(actionCalls("delete")).toHaveLength(0);

  now += 600;
  fireEvent.click(confirm);
  await waitFor(() => expect(onDestroyed).toHaveBeenCalledTimes(1));
  expect(actionCalls("delete")).toHaveLength(1);
});

it("needs the typed name before it deletes a sandbox", async () => {
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  openSection("Advanced");
  fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand this is irreversible/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Type SANDBOX to confirm" }), { target: { value: "sandbox" } });
  expect(screen.getByRole("button", { name: "Permanently destroy" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Destroy" })).toBeInTheDocument();
  expect(actionCalls("delete")).toHaveLength(0);
});

it("renames a sandbox in place with action=rename", async () => {
  const onChanged = jest.fn();
  render(<GvisorComputerManage agent={agent} onChanged={onChanged} onDestroyed={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
  const name = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Scratchpad" } });
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => expect(actionCalls("rename")).toHaveLength(1));
  expect(JSON.parse(actionCalls("rename")[0][1].body)).toEqual({ action: "rename", name: "Scratchpad" });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

it("shows a failed Apply under the Apply button and scrolls it into view without covering the fields", async () => {
  const scrollIntoView = jest.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  mockFetch.mockImplementation(async (url: string) => String(url).endsWith("/gvisor")
    ? jsonResponse({ success: true, data: { observation: { state: "running" } } })
    : String(url).endsWith("/events")
      ? jsonResponse({ success: true, data: { events: [] } })
      : jsonResponse({ success: false, error: "The host refused the new limits." }, 409));
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  openSection("Resources");
  fireEvent.change(await screen.findByLabelText("CPU limit"), { target: { value: "2" } });
  const apply = screen.getByRole("button", { name: "Apply limits" });
  fireEvent.click(apply);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("The host refused the new limits.");
  expect(alert.closest("section")).toBe(apply.closest("section"));
  expect(apply.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(alert).not.toHaveStyle({ position: "sticky" });
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("shows a failed command under Run, not in the Resources section", async () => {
  mockFetch.mockImplementation(async (url: string) => String(url).endsWith("/gvisor")
    ? jsonResponse({ success: true, data: { observation: { state: "running" } } })
    : jsonResponse({ success: false, error: "Command timed out." }, 504));
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  openSection("Run a command");
  const run = screen.getByRole("button", { name: "Run in /workspace" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Command timed out.");
  expect(alert.closest("section")).toBe(run.closest("section"));
  expect(alert.closest("section")).not.toBe(screen.getByText("Apply limits").closest("section"));
});

it("gives a Linux Sandbox an honest Agent slot in Overview until an agent can be added to it", async () => {
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  const overview = screen.getByRole("tabpanel", { name: "Overview" });
  expect(within(overview).getByRole("heading", { name: "Agent" })).toBeInTheDocument();
  expect(within(overview).getByText(/Adding an agent to a computer you already have isn't available yet/)).toBeInTheDocument();
  expect(within(overview).getByRole("link", { name: "Launch an agent" })).toHaveAttribute("href", "/dashboard/launch?kind=agent&start=1");
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
});

// Regression: progress showed only in Overview ("Confirming exec…"), so from
// Resources or Run a command the owner saw a disabled button and nothing else.
describe("progress where the owner is", () => {
  function holdAction(path: string) {
    let finish: (body: unknown) => void = () => undefined;
    mockFetch.mockImplementation((url: string) => {
      if (String(url).endsWith(path)) return new Promise((resolve) => { finish = (body) => resolve(jsonResponse(body)); });
      return Promise.resolve(String(url).endsWith("/gvisor")
        ? jsonResponse({ success: true, data: { observation: { state: "running" } } })
        : jsonResponse({ success: true, data: { events: [] } }));
    });
    return (body: unknown) => finish(body);
  }

  it("says a command is running in Run a command, in plain words, and in a banner from another section", async () => {
    const finish = holdAction("/gvisor/exec");
    render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    openSection("Run a command");
    const run = screen.getByRole("button", { name: "Run in /workspace" });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    const panel = screen.getByRole("tabpanel", { name: "Run a command" });
    expect(await within(panel).findByRole("status")).toHaveTextContent("Running the command…");
    expect(document.body.textContent).not.toMatch(/Confirming/);

    openSection("Overview");
    const banner = screen.getAllByRole("status").find((node) => node.textContent?.includes("Running the command…") && !panel.contains(node));
    expect(banner).toBeDefined();
    fireEvent.click(within(banner as HTMLElement).getByRole("button", { name: "Open Run a command" }));
    expect(screen.getByRole("tabpanel", { name: "Run a command" })).toBeVisible();

    finish({ success: true, data: { result: { exitCode: 0, stdout: "ok", stderr: "" } } });
    expect(await screen.findByText("Exit 0")).toBeInTheDocument();
    expect(screen.queryByText("Running the command…")).not.toBeInTheDocument();
  });

  it("says new limits are being applied in Resources", async () => {
    const finish = holdAction("/action");
    render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
    openSection("Resources");
    fireEvent.change(await screen.findByLabelText("CPU limit"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply limits" }));
    const panel = screen.getByRole("tabpanel", { name: "Resources" });
    expect(await within(panel).findByRole("status")).toHaveTextContent("Applying the new limits…");
    finish({ success: true, data: {} });
    await waitFor(() => expect(within(panel).queryByRole("status")).not.toBeInTheDocument());
  });
});
