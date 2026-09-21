/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GvisorComputerManage } from "../GvisorComputerManage";
import type { HivraAgent } from "@/lib/hivra/agent-api";

const agent: HivraAgent = { id: "sandbox", name: "Sandbox", type: "linux-desktop", computer_substrate: "gvisor", computer_profile: "linux-terminal", status: "running", cpu: 1, ram: 2, deployment_mode: "self-managed" };
const originalFetch = global.fetch;
const mockFetch = jest.fn();
beforeEach(() => {
  window.history.replaceState(null, "", "?tab=manage");
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { observation: { state: "running" } } }) });
  global.fetch = mockFetch;
});
afterAll(() => { global.fetch = originalFetch; });

it("keeps unobserved status unknown and withholds VM-only controls", async () => {
  mockFetch.mockRejectedValue(new Error("Host could not be reached"));
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  expect(screen.getByText("Status unknown")).toBeVisible();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(screen.queryByRole("tab", { name: "Recovery" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Access" }));
  expect(screen.getByText(/no desktop or public port access/)).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent("Host could not be reached");
});

it("retains limits and terminal drafts between panels and submits equal reservations and maxima", async () => {
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={jest.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Terminal command" }), { target: { value: "pwd" } });
  fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
  fireEvent.change(screen.getByLabelText("CPU limit"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  expect(screen.getByRole("textbox", { name: "Terminal command" })).toHaveValue("pwd");
  fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
  expect(screen.getByLabelText("CPU limit")).toHaveValue("2");
  fireEvent.click(screen.getByRole("button", { name: "Apply limits" }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/hivra/agents/sandbox/action", expect.objectContaining({ body: JSON.stringify({ action: "resize", cpu: 2, ram: 2, maximumCpu: 2, maximumRam: 2 }) })));
});

it("requires the sandbox name before permanent deletion and preserves the confirmation while navigating", async () => {
  const onDestroyed = jest.fn();
  render(<GvisorComputerManage agent={agent} onChanged={jest.fn()} onDestroyed={onDestroyed} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled());
  fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete sandbox" }));
  expect(screen.getByRole("button", { name: "Confirm permanent deletion" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Sandbox name confirmation"), { target: { value: "Sandbox" } });
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm permanent deletion" }));
  await waitFor(() => expect(onDestroyed).toHaveBeenCalledTimes(1));
});
