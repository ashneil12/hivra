/** @jest-environment jsdom */
// Agents → "Codex on MY_UBUNTU_DESKTOP" opens that computer's Chat tab once it
// is ready, and its Manage progress while it is being added (design 5.8).
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

import { AttachedAgentsList, attachedAgentHref } from "../AttachedAgentsList";
import { AttachEntryLink, ATTACH_ENTRY_HREF } from "@/components/launch/AttachEntryLink";

const row = { id: "44444444-4444-4444-8444-444444444444", phase: "attached", agentName: "Codex",
  computerId: "11111111-1111-4111-8111-111111111111", computerName: "MY_UBUNTU_DESKTOP", computerStatus: "running" };
function serve(status: number, data?: unknown) {
  global.fetch = jest.fn(async () => ({ status, ok: status < 300, json: async () => ({ success: status < 300, data }) }) as Response) as typeof fetch;
}

it("links each agent to its computer's Chat tab, or its progress while being added", async () => {
  serve(200, { enabled: true, agents: [row, { ...row, id: "55555555-5555-4555-8555-555555555555", phase: "dispatched", computerName: "lab" }] });
  render(<AttachedAgentsList />);
  expect(await screen.findByRole("link", { name: /Codex on MY_UBUNTU_DESKTOP/ }))
    .toHaveAttribute("href", `/dashboard/agent/${row.computerId}?tab=chat`);
  expect(screen.getByRole("link", { name: /Codex on lab/ })).toHaveAttribute("href", `/dashboard/agent/${row.computerId}?tab=manage`);
  expect(attachedAgentHref({ computerId: "a/b", phase: "attached" })).toBe("/dashboard/agent/a%2Fb?tab=chat");
  // The Agents list is also where another agent is put on a computer.
  expect(screen.getByRole("link", { name: /Put an agent on a computer I already have/ })).toHaveAttribute("href", ATTACH_ENTRY_HREF);
});

it("offers the entry on the Agents list before any agent is added, where attach is offered", async () => {
  serve(200, { enabled: true, agents: [] });
  render(<AttachedAgentsList />);
  expect(await screen.findByRole("link", { name: /Put an agent on a computer I already have/ })).toHaveAttribute("href", ATTACH_ENTRY_HREF);
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("shows nothing where attach is not offered, and says so when the list can't load", async () => {
  serve(200, { enabled: false, agents: [] });
  const { container, unmount } = render(<AttachedAgentsList />);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container).toBeEmptyDOMElement();
  unmount();
  serve(503);
  render(<AttachedAgentsList />);
  expect(await screen.findByRole("status")).toHaveTextContent("Agents added to your computers couldn't be loaded.");
});

it("offers Launch's entry only where attach is offered", async () => {
  serve(200, { enabled: true, agents: [] });
  const { unmount } = render(<AttachEntryLink />);
  expect(await screen.findByRole("link", { name: /Put an agent on a computer I already have/ })).toHaveAttribute("href", ATTACH_ENTRY_HREF);
  unmount();
  serve(404);
  const { container } = render(<AttachEntryLink />);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container).toBeEmptyDOMElement();
});
