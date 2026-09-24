/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GvisorComputerManage } from "../GvisorComputerManage";
import type { HivraAgent } from "@/lib/hivra/agent-api";

const agent: HivraAgent = { id: "sandbox-1", name: "SANDBOX", type: "linux-desktop", status: "running", cpu: 1, ram: 2, computer_substrate: "gvisor" };
const mockFetch = jest.fn();
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => String(url).endsWith("/gvisor")
    ? jsonResponse({ success: true, data: { observation: { state: "running" } } })
    : jsonResponse({ success: true, data: {} }));
  global.fetch = mockFetch;
});
afterEach(() => jest.restoreAllMocks());

const deleteCalls = () => mockFetch.mock.calls.filter(([, init]) => init?.body && JSON.parse(init.body).action === "delete");

it("puts Cancel in the Delete position and ignores a confirm tap that arrives with the reveal", async () => {
  let now = 10_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const onDestroyed = jest.fn();
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={onDestroyed} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete sandbox" })).toBeEnabled());

  fireEvent.click(screen.getByRole("button", { name: "Delete sandbox" }));
  const cancel = screen.getByRole("button", { name: "Cancel" });
  const confirm = screen.getByRole("button", { name: "Confirm permanent deletion" });
  expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  now += 150;
  fireEvent.click(confirm);
  expect(deleteCalls()).toHaveLength(0);

  now += 600;
  fireEvent.click(confirm);
  await waitFor(() => expect(onDestroyed).toHaveBeenCalledTimes(1));
  expect(deleteCalls()).toHaveLength(1);
});

it("keeps the delete controls intact after Cancel", async () => {
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete sandbox" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Delete sandbox" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Delete sandbox" })).toBeInTheDocument();
  expect(deleteCalls()).toHaveLength(0);
});

it("shows a failed Apply under the Apply button and scrolls it into view without covering the fields", async () => {
  const scrollIntoView = jest.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  mockFetch.mockImplementation(async (url: string) => String(url).endsWith("/gvisor")
    ? jsonResponse({ success: true, data: { observation: { state: "running" } } })
    : jsonResponse({ success: false, error: "The host refused the new limits." }, 409));
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
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
  const run = screen.getByRole("button", { name: "Run in /workspace" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Command timed out.");
  expect(alert.closest("section")).toBe(run.closest("section"));
  expect(alert.closest("section")).not.toBe(screen.getByRole("button", { name: "Apply limits" }).closest("section"));
});

it("gives a Linux Sandbox an honest Agent slot until an agent can be added to it", async () => {
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete sandbox" })).toBeEnabled());
  expect(screen.getByRole("heading", { name: "Agent" })).toBeInTheDocument();
  expect(screen.getByText(/Adding an agent to a computer you already have isn't available yet/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Launch an agent" })).toHaveAttribute("href", "/dashboard/launch?kind=agent&start=1");
});
