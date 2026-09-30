/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ComputerContractStatus } from "@/lib/agent-computers/computer-contract-status";

const mockFetch = jest.fn();
const mockAction = jest.fn();
jest.mock("@/lib/hivra/computer-contract-client", () => ({
  fetchComputerContract: (...args: unknown[]) => mockFetch(...args),
  runComputerContractAction: (...args: unknown[]) => mockAction(...args),
}));

import {
  CONTRACT_PENDING_POLL_LIMIT,
  CONTRACT_PENDING_POLL_MS,
  ComputerAgentSlot,
  ComputerContractPanel,
  formatContractTime,
} from "../ComputerContractPanel";

const AGENT = { id: "agent-1", name: "Codex 1", status: "running", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", cpu: 1.5, ram: 3 };
const NOW = new Date().toISOString();
const BLOCK = "<!-- HIVRA:COMPUTER:START v1 rev=3 -->\n## Your computer (from Hivra, revision 3)\n<!-- HIVRA:COMPUTER:END -->";

function tracked(overrides: Partial<Extract<ComputerContractStatus, { kind: "tracked" }>> = {}): ComputerContractStatus {
  return { kind: "tracked", channel: "proxmox-seed", revision: 3, content: BLOCK, state: "delivered", deliveredAt: NOW, checkedAt: NOW,
    lastAttemptAt: NOW, lastError: null, lastDelivered: null, appliesTo: "new-chats", ...overrides };
}

async function renderWith(status: ComputerContractStatus, agent = AGENT) {
  mockFetch.mockResolvedValueOnce(status);
  render(<ComputerContractPanel agent={agent} runtimeName="Codex" />);
  await waitFor(() => expect(screen.queryByText("Checking…")).not.toBeInTheDocument());
}

beforeEach(() => {
  mockFetch.mockReset();
  mockAction.mockReset();
});

it("names the linked pair from the stored binding", async () => {
  await renderWith(tracked());
  expect(screen.getByText(/runs on its own computer \(Hivra Cloud · 1\.5 CPU \/ 3 GB\)/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "What Codex 1 knows about its computer" })).toBeInTheDocument();
});

it("shows Delivered only with a receipt, says who confirmed it, and never claims Hivra checked it (T34)", async () => {
  await renderWith(tracked());
  expect(screen.getByText("rev 3")).toBeInTheDocument();
  expect(screen.getByText(`Delivered ${formatContractTime(NOW)}`)).toBeInTheDocument();
  expect(screen.getByText(/It applies to new chats\./)).toBeInTheDocument();
  expect(screen.getByText(/Reported by software on this computer\. Codex 1 runs there with administrator access, so Hivra can't check it independently\./)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/checked by Hivra/i);
  fireEvent.click(screen.getByRole("button", { name: "Show text" }));
  expect(screen.getByLabelText("Text Hivra gives Codex 1")).toHaveTextContent("## Your computer (from Hivra, revision 3)");
});

it("says Update pending before the computer acknowledges, and offers Try again after a failure", async () => {
  await renderWith(tracked({ state: "pending", deliveredAt: null, checkedAt: null, lastError: "unreachable",
    lastDelivered: { revision: 2, deliveredAt: NOW } }));
  expect(screen.getByText("Update pending")).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/Delivered \d/);
  expect(screen.getByText(/Hivra couldn't reach the computer\. Last try/)).toBeInTheDocument();
  expect(screen.getByText(`Last delivered: rev 2 at ${formatContractTime(NOW)}.`)).toBeInTheDocument();
  mockAction.mockResolvedValueOnce(tracked());
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(mockAction).toHaveBeenCalledWith("agent-1", "deliver"));
  expect(await screen.findByText(`Delivered ${formatContractTime(NOW)}`)).toBeInTheDocument();
});

it("says when it last looked at a delivered copy, and when a later look failed", async () => {
  const earlier = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  await renderWith(tracked({ deliveredAt: earlier, checkedAt: earlier, lastAttemptAt: NOW, lastError: "unreachable" }));
  expect(screen.getByText(`Delivered ${formatContractTime(earlier)}`)).toBeInTheDocument();
  expect(screen.getByText(`Last checked ${formatContractTime(earlier)}. Hivra looks again about once an hour when you open Codex 1.`)).toBeInTheDocument();
  expect(screen.getByText(`Hivra couldn't reach the computer. Last try ${formatContractTime(NOW)}.`)).toBeInTheDocument();
});

it("offers Send now for a running computer whose note hasn't gone out, and looks again until it lands", async () => {
  jest.useFakeTimers();
  try {
    const pending = tracked({ state: "pending", deliveredAt: null, checkedAt: null, lastAttemptAt: null, lastError: null });
    mockFetch.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(tracked());
    const onStatus = jest.fn();
    render(<ComputerContractPanel agent={AGENT} runtimeName="Codex" onStatus={onStatus} />);
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Update pending")).toBeInTheDocument();
    expect(screen.getByText("Hivra sends revision 3 the next time it reaches the computer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send now" })).toBeInTheDocument();
    await act(async () => { await jest.advanceTimersByTimeAsync(CONTRACT_PENDING_POLL_MS); });
    await act(async () => { await jest.advanceTimersByTimeAsync(CONTRACT_PENDING_POLL_MS); });
    expect(screen.getByText(`Delivered ${formatContractTime(NOW)}`)).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: "delivered" }), "load");
    // Delivered: no more looking.
    await act(async () => { await jest.advanceTimersByTimeAsync(CONTRACT_PENDING_POLL_MS * 3); });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  } finally {
    jest.useRealTimers();
  }
});

it("stops looking after a few tries and leaves Send now to the owner", async () => {
  jest.useFakeTimers();
  try {
    mockFetch.mockResolvedValue(tracked({ state: "pending", deliveredAt: null, checkedAt: null, lastAttemptAt: null, lastError: null }));
    render(<ComputerContractPanel agent={AGENT} runtimeName="Codex" />);
    for (let tick = 0; tick < CONTRACT_PENDING_POLL_LIMIT + 3; tick += 1) {
      await act(async () => { await jest.advanceTimersByTimeAsync(CONTRACT_PENDING_POLL_MS); });
    }
    expect(mockFetch).toHaveBeenCalledTimes(1 + CONTRACT_PENDING_POLL_LIMIT);
    mockAction.mockResolvedValueOnce(tracked());
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(mockAction).toHaveBeenCalledWith("agent-1", "deliver");
  } finally {
    jest.useRealTimers();
  }
});

it("says a running computer's first note is on its way, never that it waits for the computer to start", async () => {
  await renderWith({ kind: "not_started", channel: "proxmox-seed" });
  expect(screen.getByText("Hivra hasn't sent it yet. It sends it the next time it reaches the computer.")).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/once the computer is running/);
  expect(screen.getByRole("button", { name: "Send now" })).toBeInTheDocument();
});

it("tells whoever hosts the panel what it shows and what an action changed", async () => {
  const onStatus = jest.fn();
  mockFetch.mockResolvedValueOnce(tracked({ channel: "do-setup-message", state: "pending", deliveredAt: null }));
  render(<ComputerContractPanel agent={{ ...AGENT, computer_substrate: "do-managed-session" }} runtimeName="Codex" onStatus={onStatus} />);
  await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "pending" }), "load"));
  mockAction.mockResolvedValueOnce(tracked({ channel: "do-setup-message", state: "sent" }));
  fireEvent.click(screen.getByRole("button", { name: "Send setup note" }));
  await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "sent" }), "send"));
});

it("waits for a stopped computer instead of offering a delivery it cannot make", async () => {
  await renderWith(tracked({ state: "pending", deliveredAt: null, lastError: null }), { ...AGENT, status: "stopped" });
  expect(screen.getByText(/once the computer is running/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
});

it("reports an edited copy as changed and restores it only on the owner's click", async () => {
  await renderWith(tracked({ state: "conflict", lastError: "edited_on_computer" }));
  expect(screen.getByText("Changed on the computer")).toBeInTheDocument();
  expect(mockAction).not.toHaveBeenCalled();
  mockAction.mockResolvedValueOnce(tracked());
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(mockAction).toHaveBeenCalledWith("agent-1", "restore"));
});

it("says a DigitalOcean note was sent in chat, never delivered", async () => {
  await renderWith(tracked({ channel: "do-setup-message", state: "sent" }), { ...AGENT, computer_substrate: "do-managed-session", deployment_mode: "self-managed", cpu: 2, ram: 4 });
  expect(screen.getByText(`Sent in chat ${formatContractTime(NOW)}`)).toBeInTheDocument();
  expect(screen.getByText(/doesn't prove Codex 1 read it/)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/Delivered/);
  expect(screen.getByText(/My cloud · DigitalOcean · 2 CPU \/ 4 GB/)).toBeInTheDocument();
});

it("asks before sending a DigitalOcean setup note and says it costs a little usage", async () => {
  await renderWith({ kind: "not_started", channel: "do-setup-message" }, { ...AGENT, computer_substrate: "do-managed-session" });
  expect(screen.getByText(/uses a little of your DigitalOcean and model usage/)).toBeInTheDocument();
  expect(mockAction).not.toHaveBeenCalled();
  mockAction.mockResolvedValueOnce(tracked({ channel: "do-setup-message", state: "sent" }));
  fireEvent.click(screen.getByRole("button", { name: "Send setup note" }));
  await waitFor(() => expect(mockAction).toHaveBeenCalledWith("agent-1", "send"));
});

it("offers a DigitalOcean update as one more visible message after a rename", async () => {
  await renderWith(tracked({ channel: "do-setup-message", state: "pending", deliveredAt: null, lastDelivered: { revision: 2, deliveredAt: NOW } }),
    { ...AGENT, computer_substrate: "do-managed-session" });
  expect(screen.getByText("Update not sent")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send update to Codex 1" })).toBeInTheDocument();
});

it("doesn't offer a DigitalOcean update the session can't take yet", async () => {
  await renderWith(tracked({ channel: "do-setup-message", state: "pending", deliveredAt: null, lastDelivered: { revision: 2, deliveredAt: NOW } }),
    { ...AGENT, status: "starting", computer_substrate: "do-managed-session" });
  expect(screen.getByText("Update not sent")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Send update to|Send setup note/ })).not.toBeInTheDocument();
  expect(screen.getByText("You can send it once Codex 1 is running.")).toBeInTheDocument();
});

it("reports delivery to a computer in the owner's own cloud the same way, from its read-back (ATT-05)", async () => {
  await renderWith(tracked({ channel: "provider-seed" }), { ...AGENT, computer_substrate: "provider-vm", deployment_mode: "self-managed", cpu: 2, ram: 4 });
  expect(screen.getByText(/runs on its own computer \(My cloud · 2 CPU \/ 4 GB\)/)).toBeInTheDocument();
  expect(screen.getByText(`Delivered ${formatContractTime(NOW)}`)).toBeInTheDocument();
  expect(screen.getByText(/Reported by software on this computer/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
});

it("says a dashboard runtime keeps its own instructions", async () => {
  await renderWith({ kind: "not_applicable", reason: "own_instructions" });
  expect(screen.getByText(/Codex uses its own instructions\. Hivra doesn't add notes about its computer to them yet\./)).toBeInTheDocument();
});

it("claims nothing when the status cannot be loaded", async () => {
  mockFetch.mockRejectedValueOnce(new Error("Couldn't reach Hivra. Nothing changed."));
  render(<ComputerContractPanel agent={AGENT} runtimeName="Codex" />);
  expect(await screen.findByText("Couldn't check")).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/Delivered/);
  mockFetch.mockResolvedValueOnce(tracked());
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText(`Delivered ${formatContractTime(NOW)}`)).toBeInTheDocument();
});

it("gives a computer without an agent an honest Agent slot", () => {
  render(<ComputerAgentSlot />);
  expect(screen.getByText("No agent works on this computer.")).toBeInTheDocument();
  expect(screen.getByText(/Adding an agent to a computer you already have isn't available yet\. Launch an agent and it gets its own computer\./)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Launch an agent" })).toHaveAttribute("href", "/dashboard/launch?kind=agent&start=1");
});

it("formats today's times as a clock and older ones with a date", () => {
  const now = new Date("2026-09-24T12:30:00");
  expect(formatContractTime("2026-09-24T12:04:00", now)).not.toMatch(/Sep/);
  expect(formatContractTime("2026-09-23T12:04:00", now)).toMatch(/Sep 23|23 Sep/);
  expect(formatContractTime("not a date", now)).toBe("unknown time");
});
