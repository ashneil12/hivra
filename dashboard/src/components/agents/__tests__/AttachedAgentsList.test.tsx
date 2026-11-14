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

const desk = { id: "11111111-1111-4111-8111-111111111111", type: "linux-desktop", computer_profile: "ubuntu-desktop", name: "MY_UBUNTU_DESKTOP", status: "running" };
const hermes = { id: "99999999-9999-4999-8999-999999999999", type: "hermes", name: "Hermes 1", status: "running" };
/** Attach's own read and the owner's agent list, each answered on its own. */
function serveAttachEntry(attach: { status: number; data?: unknown }, agents: unknown[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/hivra/attached-agents")) {
      return { status: attach.status, ok: attach.status < 300, json: async () => ({ success: attach.status < 300, data: attach.data }) } as Response;
    }
    return { status: 200, ok: true, json: async () => ({ success: true, data: { agents } }) } as Response;
  }) as typeof fetch;
}

it("offers Launch's entry only where attach is offered and the owner has a computer", async () => {
  serveAttachEntry({ status: 200, data: { enabled: true, agents: [] } }, [desk]);
  const { unmount } = render(<AttachEntryLink />);
  expect(await screen.findByRole("link", { name: /Put an agent on a computer I already have/ })).toHaveAttribute("href", ATTACH_ENTRY_HREF);
  unmount();
  serveAttachEntry({ status: 404 }, [desk]);
  const { container } = render(<AttachEntryLink />);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container).toBeEmptyDOMElement();
});

it("hides Launch's entry when the owner has no computers, so it never leads to an empty list", async () => {
  // An agent alone is not a computer to put another agent on.
  serveAttachEntry({ status: 200, data: { enabled: true, agents: [] } }, [hermes, { ...desk, status: "deleted" }]);
  const { container } = render(<AttachEntryLink />);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container).toBeEmptyDOMElement();
});

it("keeps Launch's entry when the computer list can't be read, rather than hiding the way in", async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).includes("/api/hivra/attached-agents")
    ? { status: 200, ok: true, json: async () => ({ success: true, data: { enabled: true, agents: [] } }) } as Response
    : { status: 500, ok: false, json: async () => ({ success: false, error: "Down" }) } as Response) as typeof fetch;
  render(<AttachEntryLink />);
  expect(await screen.findByRole("link", { name: /Put an agent on a computer I already have/ })).toHaveAttribute("href", ATTACH_ENTRY_HREF);
});
