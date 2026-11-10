/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentDesktopEntry } from "../AgentDesktopEntry";
import { addLink, fetchLinks, type LinksViewData } from "@/lib/agent-links/client";

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));
jest.mock("@/lib/agent-links/client", () => ({ fetchLinks: jest.fn(), addLink: jest.fn() }));

const view = (over: Partial<LinksViewData> = {}): LinksViewData => ({
  subject: { id: "agent_1", kind: "agent", available: true },
  links: [],
  candidates: [],
  ...over,
});
const studio = { id: "desk_1", name: "Studio", kind: "Ubuntu desktop", status: "running", linked: false, available: true };

function renderEntry() {
  const handlers = { onLaunch: jest.fn(), onOpenComputer: jest.fn(), onManage: jest.fn() };
  render(<AgentDesktopEntry agentId="agent_1" agentName="Codex 1" {...handlers} />);
  return handlers;
}

beforeEach(() => {
  (fetchLinks as jest.Mock).mockReset();
  (addLink as jest.Mock).mockReset().mockResolvedValue({ ok: true });
});

it("explains the desktop in one sentence and connects the one eligible desktop", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "ready", view: view({ candidates: [studio] }) });
  renderEntry();
  expect(screen.getByRole("status")).toHaveTextContent("Checking your desktop computers…");
  expect(screen.getByRole("heading", { name: "Give Codex 1 a desktop" })).toBeInTheDocument();
  expect(screen.getByText(/lets Codex 1 use apps on a real screen that you can watch/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Connect Studio" }));
  await waitFor(() => expect(addLink).toHaveBeenCalledWith({ agentId: "agent_1", computerId: "desk_1", from: "agent" }));
  expect(await screen.findByText(/Connected to Studio/)).toBeInTheDocument();
});

it("offers only desktop computers, not sandboxes, and lets the owner pick among several", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "ready", view: view({ candidates: [
    studio,
    { ...studio, id: "desk_2", name: "Den", kind: "Omarchy desktop" },
    { id: "box_1", name: "Sandbox", kind: "Linux sandbox", linked: false, available: true },
  ] }) });
  renderEntry();
  const select = await screen.findByRole("combobox", { name: "Desktop to connect" });
  expect(Array.from(select.querySelectorAll("option")).map((option) => option.textContent)).toEqual(["Studio (Ubuntu desktop)", "Den (Omarchy desktop)"]);
  fireEvent.change(select, { target: { value: "desk_2" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect desktop" }));
  await waitFor(() => expect(addLink).toHaveBeenCalledWith({ agentId: "agent_1", computerId: "desk_2", from: "agent" }));
});

it("lists a connected desktop with a way to open it, and still offers another launch", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "ready", view: view({
    links: [{ id: "l1", agentId: "agent_1", agentName: "Codex 1", computerId: "desk_9", computerName: "Studio", computerKind: "Ubuntu desktop", createdAt: "2026-11-01", lastUsedAt: null }],
  }) });
  const { onOpenComputer, onLaunch } = renderEntry();
  fireEvent.click(await screen.findByRole("button", { name: "Open Studio" }));
  expect(onOpenComputer).toHaveBeenCalledWith("desk_9");
  fireEvent.click(screen.getByRole("button", { name: "Launch another Ubuntu Desktop" }));
  expect(onLaunch).toHaveBeenCalled();
});

it("sends an owner with no desktop to launch a new Ubuntu Desktop", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "ready", view: view() });
  const { onLaunch } = renderEntry();
  expect(await screen.findByText("You don’t have a desktop computer to connect yet.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Launch a new Ubuntu Desktop" }));
  expect(onLaunch).toHaveBeenCalledTimes(1);
});

it("says why a desktop can't be connected yet", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "ready", view: view({ candidates: [
    { ...studio, available: false, reason: "This computer was made before agents could use computers. Make a new one to link it." },
  ] }) });
  renderEntry();
  expect(await screen.findByRole("listitem")).toHaveTextContent("Studio can’t be connected yet: This computer was made before agents could use computers");
  expect(screen.getByRole("button", { name: "Launch a new Ubuntu Desktop" })).toBeInTheDocument();
});

it("says so plainly when this agent can't be linked, and offers the launch", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "ready", view: view({ subject: { id: "agent_1", kind: "agent", available: false, reason: "This agent can't use your other computers yet." } }) });
  const { onLaunch } = renderEntry();
  expect(await screen.findByText(/This agent can't use your other computers yet\. You can still launch an Ubuntu Desktop of your own\./)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Connect/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Launch a new Ubuntu Desktop" }));
  expect(onLaunch).toHaveBeenCalled();
});

it("says so when linking isn't offered here, and offers the launch", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "not_offered" });
  renderEntry();
  expect(await screen.findByText(/isn’t available here yet/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Launch a new Ubuntu Desktop" })).toBeInTheDocument();
});

it("shows what went wrong when connecting fails, and keeps the choice", async () => {
  (fetchLinks as jest.Mock).mockResolvedValue({ state: "ready", view: view({ candidates: [studio] }) });
  (addLink as jest.Mock).mockResolvedValue({ ok: false, message: "Couldn't link them right now. Nothing was changed." });
  renderEntry();
  fireEvent.click(await screen.findByRole("button", { name: "Connect Studio" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was changed");
  expect(screen.getByRole("button", { name: "Connect Studio" })).toBeEnabled();
});

it("offers Try again when the links can't be read", async () => {
  (fetchLinks as jest.Mock).mockResolvedValueOnce({ state: "unavailable", message: "Couldn't load linked computers and agents." })
    .mockResolvedValue({ state: "ready", view: view({ candidates: [studio] }) });
  renderEntry();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: "Connect Studio" })).toBeInTheDocument();
});
